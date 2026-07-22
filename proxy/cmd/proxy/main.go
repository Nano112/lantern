package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"time"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/user/minecraft-web/proxy/internal/auth"
	"github.com/user/minecraft-web/proxy/internal/db"
	"github.com/user/minecraft-web/proxy/internal/metrics"
	"github.com/user/minecraft-web/proxy/internal/ratelimit"
	proxyRouter "github.com/user/minecraft-web/proxy/internal/router"
	"github.com/user/minecraft-web/proxy/internal/tcp"
	"github.com/user/minecraft-web/proxy/internal/transport"
)

func main() {
	port := flag.Int("port", 25565, "TCP listen port for Minecraft clients")
	wtPort := flag.Int("wt-port", 4433, "WebTransport listen port")
	apiPort := flag.Int("api-port", 9090, "HTTP API port for metrics")
	webPort := flag.Int("web-port", 80, "HTTP port for web UI")
	domain := flag.String("domain", "localhost", "Base domain for subdomain routing")
	cert := flag.String("cert", "certs/cert.pem", "TLS certificate file")
	key := flag.String("key", "certs/key.pem", "TLS private key file")
	webDir := flag.String("web-dir", "", "Directory to serve static web files from (disables web server if empty)")
	flag.Parse()

	log.Printf("proxy starting... tcp=%d wt=%d domain=%s", *port, *wtPort, *domain)

	// --- Auth setup ---
	dbPath := os.Getenv("DB_PATH")
	jwtSecret := os.Getenv("JWT_SECRET")
	adminUser := os.Getenv("ADMIN_USER")
	adminPass := os.Getenv("ADMIN_PASS")

	var database *db.DB
	if dbPath != "" && jwtSecret != "" {
		var err error
		database, err = db.New(dbPath)
		if err != nil {
			log.Fatalf("db: failed to open %s: %v", dbPath, err)
		}
		if err := database.Init(); err != nil {
			log.Fatalf("db: failed to init: %v", err)
		}
		log.Printf("db: using %s", dbPath)
	} else if adminUser != "" && adminPass != "" && jwtSecret != "" {
		var err error
		database, err = db.NewMemory()
		if err != nil {
			log.Fatalf("db: failed to create in-memory db: %v", err)
		}
		if err := database.Init(); err != nil {
			log.Fatalf("db: failed to init in-memory db: %v", err)
		}
		log.Println("auth: using in-memory admin store (no DB_PATH configured)")
	} else {
		log.Println("auth: no auth configured — stats are public")
	}

	// Seed admin user if configured and no admins exist yet
	if database != nil && adminUser != "" && adminPass != "" {
		if jwtSecret == "" {
			log.Fatalf("JWT_SECRET is required when ADMIN_USER/ADMIN_PASS are set")
		}
		count, err := database.CountAdmins()
		if err != nil {
			log.Printf("db: failed to count admins: %v", err)
		} else if count == 0 {
			hash, err := auth.HashPassword(adminPass)
			if err != nil {
				log.Fatalf("failed to hash admin password: %v", err)
			}
			if err := database.CreateAdmin(adminUser, hash); err != nil {
				log.Fatalf("failed to seed admin: %v", err)
			}
			log.Printf("seeded admin user: %s", adminUser)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Shared router for subdomain → session mapping
	r := proxyRouter.New()
	activeRooms := &atomic.Int64{}

	// WebTransport server (required — fatal if it fails)
	wts := &transport.Server{
		Addr:        fmt.Sprintf(":%d", *wtPort),
		TLSCert:     *cert,
		TLSKey:      *key,
		Router:      r,
		ActiveRooms: activeRooms,
	}

	// WebSocket handler (fallback for browsers without WebTransport, e.g. iOS Safari)
	wsHandler := transport.NewWSHandler(r, activeRooms)

	// TCP listener for Minecraft clients (non-fatal — log and continue)
	tcpListener := &tcp.Listener{
		Addr:   fmt.Sprintf(":%d", *port),
		Domain: *domain,
		Router: r,
	}

	// Rate limiters
	apiLimiter := ratelimit.New(5, 10)      // 5 req/s per IP, burst 10 (general API)
	loginLimiter := ratelimit.New(0.5, 3)   // 1 req/2s per IP, burst 3 (login brute-force protection)

	// Metrics HTTP API server (proxy dashboard)
	apiMux := http.NewServeMux()
	statsHandler := metrics.StatsHandler()

	kickHandler := kickRoomHandler(r)
	kickIPHandler := kickIPHandler(r)
	kickAllHandler := kickAllHandler(r)

	if database != nil && jwtSecret != "" {
		// Auth-protected stats + kick
		apiMux.Handle("/api/proxy/stats", auth.RequireAuth(jwtSecret, apiLimiter.HTTPMiddleware(statsHandler)))
		apiMux.Handle("/api/proxy/kick", auth.RequireAuth(jwtSecret, apiLimiter.HTTPMiddleware(kickHandler)))
		apiMux.Handle("/api/proxy/kick-ip", auth.RequireAuth(jwtSecret, apiLimiter.HTTPMiddleware(kickIPHandler)))
		apiMux.Handle("/api/proxy/kick-all", auth.RequireAuth(jwtSecret, apiLimiter.HTTPMiddleware(kickAllHandler)))
		apiMux.HandleFunc("/api/auth/login", loginLimiter.HTTPMiddlewareFunc(auth.LoginHandler(database, jwtSecret)))
		apiMux.HandleFunc("/api/auth/me", apiLimiter.HTTPMiddlewareFunc(auth.MeHandler(jwtSecret)))
	} else {
		// No auth — public stats + kick
		apiMux.Handle("/api/proxy/stats", apiLimiter.HTTPMiddleware(statsHandler))
		apiMux.Handle("/api/proxy/kick", apiLimiter.HTTPMiddleware(kickHandler))
		apiMux.Handle("/api/proxy/kick-ip", apiLimiter.HTTPMiddleware(kickIPHandler))
		apiMux.Handle("/api/proxy/kick-all", apiLimiter.HTTPMiddleware(kickAllHandler))
	}

	// Compute cert hash for WebTransport (browsers need this for self-signed certs)
	certHashB64 := computeCertHash(*cert)
	if certHashB64 != "" {
		log.Printf("web: cert hash (base64): %s", certHashB64)
	}

	serversHandler := apiLimiter.HTTPMiddlewareFunc(publicServersHandler(*domain, *port))
	apiMux.HandleFunc("/api/servers", serversHandler)

	// Cert hash + WebTransport config (also served on API port for dev mode)
	apiMux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"certHash": certHashB64,
			"wtPort":   *wtPort,
			"domain":   *domain,
			"tcpPort":  *port,
		})
	})

	// WebSocket endpoint for browsers without WebTransport
	apiMux.Handle("/ws", wsHandler)

	apiMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "Aero Proxy — API server")
	})

	apiServer := &http.Server{
		Addr:         fmt.Sprintf(":%d", *apiPort),
		Handler:      apiMux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	go func() {
		log.Printf("api: listening on %s", apiServer.Addr)
		if err := apiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("api: %v", err)
		}
	}()

	// Web UI server (static files + Mojang API proxy)
	var webServer *http.Server
	if *webDir != "" {
		webServer = &http.Server{
			Addr:         fmt.Sprintf(":%d", *webPort),
			Handler:      webHandler(*webDir, database, jwtSecret, *domain, *port, certHashB64, *wtPort, wsHandler, r),
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 30 * time.Second,
			IdleTimeout:  120 * time.Second,
		}
		go func() {
			log.Printf("web: serving %s on :%d", *webDir, *webPort)
			if err := webServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Printf("web: %v", err)
			}
		}()
	}

	var wg sync.WaitGroup

	// WebTransport is the critical service
	wtErrCh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		wtErrCh <- wts.ListenAndServe(ctx)
	}()

	// TCP listener is best-effort — port may be in use
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := tcpListener.ListenAndServe(ctx); err != nil && ctx.Err() == nil {
			log.Printf("tcp: %v (Minecraft clients won't be able to connect on this port)", err)
		}
	}()

	// Wait for interrupt or WT fatal error
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	select {
	case s := <-sig:
		log.Printf("received %v, shutting down", s)
	case err := <-wtErrCh:
		log.Printf("fatal: WebTransport server failed: %v", err)
	}

	cancel()
	apiServer.Close()
	if webServer != nil {
		webServer.Close()
	}
	wg.Wait()
	log.Println("proxy stopped")
}

// webHandler builds an HTTP handler that serves static files with SPA fallback,
// proxies /api/mojang/ to Mojang's session server, and adds gzip-friendly headers.
func webHandler(dir string, database *db.DB, jwtSecret string, domain string, tcpPort int, certHash string, wtPort int, wsHandler http.Handler, rtr *proxyRouter.Router) http.Handler {
	absDir, err := filepath.Abs(dir)
	if err != nil {
		log.Fatalf("web: invalid directory %q: %v", dir, err)
	}

	// Rate limiters for web-served API routes
	webAPILimiter := ratelimit.New(5, 10)
	webLoginLimiter := ratelimit.New(0.5, 3)

	mux := http.NewServeMux()

	// Mojang session server reverse proxy
	mojangTarget, _ := url.Parse("https://sessionserver.mojang.com")
	mojangProxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = mojangTarget.Scheme
			req.URL.Host = mojangTarget.Host
			req.Host = mojangTarget.Host
			req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/mojang")
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
			req.Header.Set("Accept", "application/json")
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{},
		},
	}
	mux.Handle("/api/mojang/", webAPILimiter.HTTPMiddleware(mojangProxy))

	// Auth + proxy stats endpoints
	statsHandler := metrics.StatsHandler()
	kickHandler := kickRoomHandler(rtr)
	kickIPHandler := kickIPHandler(rtr)
	kickAllHandler := kickAllHandler(rtr)
	if database != nil && jwtSecret != "" {
		mux.Handle("/api/proxy/stats", auth.RequireAuth(jwtSecret, webAPILimiter.HTTPMiddleware(statsHandler)))
		mux.Handle("/api/proxy/kick", auth.RequireAuth(jwtSecret, webAPILimiter.HTTPMiddleware(kickHandler)))
		mux.Handle("/api/proxy/kick-ip", auth.RequireAuth(jwtSecret, webAPILimiter.HTTPMiddleware(kickIPHandler)))
		mux.Handle("/api/proxy/kick-all", auth.RequireAuth(jwtSecret, webAPILimiter.HTTPMiddleware(kickAllHandler)))
		mux.HandleFunc("/api/auth/login", webLoginLimiter.HTTPMiddlewareFunc(auth.LoginHandler(database, jwtSecret)))
		mux.HandleFunc("/api/auth/me", webAPILimiter.HTTPMiddlewareFunc(auth.MeHandler(jwtSecret)))
	} else {
		mux.Handle("/api/proxy/stats", webAPILimiter.HTTPMiddleware(statsHandler))
		mux.Handle("/api/proxy/kick", webAPILimiter.HTTPMiddleware(kickHandler))
		mux.Handle("/api/proxy/kick-ip", webAPILimiter.HTTPMiddleware(kickIPHandler))
		mux.Handle("/api/proxy/kick-all", webAPILimiter.HTTPMiddleware(kickAllHandler))
	}

	// Public server list (no auth)
	mux.HandleFunc("/api/servers", webAPILimiter.HTTPMiddlewareFunc(publicServersHandler(domain, tcpPort)))

	// Cert hash + WebTransport config for browser clients
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"certHash": certHash,
			"wtPort":   wtPort,
			"domain":   domain,
			"tcpPort":  tcpPort,
		})
	})

	// WebSocket endpoint for browsers without WebTransport
	mux.Handle("/ws", wsHandler)

	// Static files with SPA fallback
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Try to serve the exact file
		path := filepath.Join(absDir, filepath.Clean(r.URL.Path))

		// Prevent directory traversal
		if !strings.HasPrefix(path, absDir) {
			http.NotFound(w, r)
			return
		}

		info, err := os.Stat(path)
		if err == nil && !info.IsDir() {
			setCacheHeaders(w, r.URL.Path)
			http.ServeFile(w, r, path)
			return
		}

		// SPA fallback: serve index.html for non-file routes
		indexPath := filepath.Join(absDir, "index.html")
		f, err := os.Open(indexPath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.Copy(w, f)
	})

	return mux
}

// publicServersHandler returns an HTTP handler that serves the public server list.
func publicServersHandler(domain string, tcpPort int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		servers := metrics.Get().PublicServers(domain, tcpPort)
		if servers == nil {
			servers = []metrics.PublicServer{}
		}
		json.NewEncoder(w).Encode(servers)
	}
}

// computeCertHash returns the base64-encoded SHA-256 hash of the DER-encoded certificate.
// This is needed for WebTransport serverCertificateHashes with self-signed certs.
func computeCertHash(certFile string) string {
	data, err := os.ReadFile(certFile)
	if err != nil {
		log.Printf("web: cannot read cert for hash: %v", err)
		return ""
	}
	block, _ := pem.Decode(data)
	if block == nil {
		log.Printf("web: cannot decode PEM cert")
		return ""
	}
	hash := sha256.Sum256(block.Bytes)
	return base64.StdEncoding.EncodeToString(hash[:])
}

// kickRoomHandler returns an HTTP handler that kicks a specific room.
func kickRoomHandler(rtr *proxyRouter.Router) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Room string `json:"room"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Room == "" {
			http.Error(w, `{"error":"room is required"}`, http.StatusBadRequest)
			return
		}
		if rtr.CloseSession(req.Room) {
			log.Printf("admin: kicked room %q", req.Room)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"status": "ok", "room": req.Room})
		} else {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"error": "room not found"})
		}
	})
}

// kickIPHandler returns an HTTP handler that kicks all rooms from a specific IP.
func kickIPHandler(rtr *proxyRouter.Router) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			IP string `json:"ip"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.IP == "" {
			http.Error(w, `{"error":"ip is required"}`, http.StatusBadRequest)
			return
		}
		rooms := metrics.Get().RoomsByHostIP(req.IP)
		for _, room := range rooms {
			rtr.CloseSession(room)
		}
		log.Printf("admin: kicked %d rooms from IP %s", len(rooms), req.IP)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "ok", "ip": req.IP, "kicked": len(rooms), "rooms": rooms})
	})
}

// kickAllHandler returns an HTTP handler that kicks all rooms.
func kickAllHandler(rtr *proxyRouter.Router) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		count := rtr.CloseAll()
		log.Printf("admin: kicked all rooms (%d)", count)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "ok", "kicked": count})
	})
}

// setCacheHeaders sets Cache-Control for static assets.
func setCacheHeaders(w http.ResponseWriter, path string) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".js", ".css", ".wasm", ".png", ".jpg", ".ico", ".svg":
		w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	}
}
