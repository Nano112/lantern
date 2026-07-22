package transport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"regexp"
	"sync/atomic"
	"unicode/utf8"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"github.com/user/minecraft-web/proxy/internal/metrics"
	"github.com/user/minecraft-web/proxy/internal/router"
)

const (
	maxRooms    = 200  // max concurrent WebTransport rooms
	maxMOTDLen  = 256  // max MOTD length in characters
	maxRoomLen  = 32   // max room name length
)

// validRoomName allows lowercase alphanumeric + hyphens, no leading/trailing hyphen.
var validRoomName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`)

var adjectives = []string{
	"brave", "calm", "dark", "eager", "fast",
	"grand", "happy", "keen", "lucky", "neat",
	"proud", "quick", "red", "sharp", "tall", "warm",
}

var nouns = []string{
	"fox", "bear", "wolf", "hawk", "lynx",
	"pine", "oak", "reef", "peak", "vale",
	"star", "moon", "bolt", "gale", "dusk", "fern",
}

func generateName() string {
	return adjectives[rand.Intn(len(adjectives))] + "-" + nouns[rand.Intn(len(nouns))]
}

func randomSuffix() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 4)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}

func sanitizeRoomName(name string) string {
	if len(name) > maxRoomLen {
		name = name[:maxRoomLen]
	}
	if !validRoomName.MatchString(name) {
		return ""
	}
	return name
}

func truncateMOTD(motd string) string {
	if utf8.RuneCountInString(motd) > maxMOTDLen {
		runes := []rune(motd)
		return string(runes[:maxMOTDLen])
	}
	return motd
}

// wtSession wraps a WebTransport session to implement router.Session.
type wtSession struct {
	session *webtransport.Session
	done    chan struct{}
}

func (s *wtSession) OpenStream() (router.Stream, error) {
	stream, err := s.session.OpenStreamSync(s.session.Context())
	if err != nil {
		return nil, err
	}
	return stream, nil
}

func (s *wtSession) Close() {
	s.session.CloseWithError(0, "closed")
}

func (s *wtSession) Done() <-chan struct{} {
	return s.done
}

// Server handles incoming WebTransport connections from browser hosts.
type Server struct {
	Addr        string
	TLSCert     string
	TLSKey      string
	Router      *router.Router
	ActiveRooms *atomic.Int64
	wtServer    *webtransport.Server
}

// registration is the JSON sent by the browser on the control stream.
type registration struct {
	Room    string `json:"room"`
	Public  bool   `json:"public,omitempty"`
	MOTD    string `json:"motd,omitempty"`
	Favicon string `json:"favicon,omitempty"`
}

// roomUpdate is a JSON message sent on the control stream to update room settings.
type roomUpdate struct {
	Public  *bool   `json:"public,omitempty"`
	MOTD    *string `json:"motd,omitempty"`
	Favicon *string `json:"favicon,omitempty"`
}

// ListenAndServe starts the WebTransport server.
func (s *Server) ListenAndServe(ctx context.Context) error {
	cert, err := tls.LoadX509KeyPair(s.TLSCert, s.TLSKey)
	if err != nil {
		return fmt.Errorf("load TLS cert: %w", err)
	}

	mux := http.NewServeMux()

	h3 := &http3.Server{
		Addr:      s.Addr,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			NextProtos:   []string{"h3"},
		},
		Handler:   mux,
	}

	// Required: advertise WebTransport support and enable datagrams in HTTP/3 settings
	webtransport.ConfigureHTTP3Server(h3)

	s.wtServer = &webtransport.Server{
		H3:          h3,
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	mux.HandleFunc("/connect", func(w http.ResponseWriter, r *http.Request) {
		session, err := s.wtServer.Upgrade(w, r)
		if err != nil {
			log.Printf("wt: upgrade failed: %v", err)
			return
		}
		go s.handleSession(ctx, session, r.RemoteAddr)
	})

	log.Printf("wt: listening on %s", s.Addr)

	errCh := make(chan error, 1)
	go func() {
		errCh <- s.wtServer.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		s.wtServer.Close()
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

func (s *Server) handleSession(ctx context.Context, session *webtransport.Session, remoteAddr string) {
	defer session.CloseWithError(0, "session ended")

	// Enforce max rooms
	if s.ActiveRooms.Load() >= maxRooms {
		log.Printf("wt: rejecting session (at room capacity %d)", maxRooms)
		return
	}

	// Read registration from the first bidirectional stream (control stream)
	stream, err := session.AcceptStream(ctx)
	if err != nil {
		log.Printf("wt: accept control stream failed: %v", err)
		return
	}

	// Limit registration message size (16KB max)
	limitedReader := &io.LimitedReader{R: stream, N: 16384}
	var reg registration
	decoder := json.NewDecoder(limitedReader)
	if err := decoder.Decode(&reg); err != nil {
		log.Printf("wt: read registration failed: %v", err)
		stream.Close()
		return
	}

	// Sanitize inputs
	preferred := sanitizeRoomName(reg.Room)
	if preferred == "" {
		preferred = generateName()
	}
	reg.MOTD = truncateMOTD(reg.MOTD)

	// Try to register with the preferred name, then with suffixes (TryRegister only)
	sess := &wtSession{session: session, done: make(chan struct{})}
	go func() {
		<-session.Context().Done()
		close(sess.done)
	}()
	assigned := preferred
	if !s.Router.TryRegister(assigned, sess) {
		registered := false
		for i := 0; i < 10; i++ {
			assigned = preferred + "-" + randomSuffix()
			if s.Router.TryRegister(assigned, sess) {
				registered = true
				break
			}
		}
		if !registered {
			// Generate fully random name — still use TryRegister to never overwrite
			for i := 0; i < 10; i++ {
				assigned = generateName() + "-" + randomSuffix()
				if s.Router.TryRegister(assigned, sess) {
					registered = true
					break
				}
			}
			if !registered {
				log.Printf("wt: failed to find available room name after retries")
				json.NewEncoder(stream).Encode(map[string]string{"status": "error", "error": "no room name available"})
				stream.Close()
				return
			}
		}
	}

	s.ActiveRooms.Add(1)
	hostIP, _, _ := net.SplitHostPort(remoteAddr)
	log.Printf("wt: session registered for room %q (requested %q) from %s [%d active]", assigned, preferred, hostIP, s.ActiveRooms.Load())
	metrics.Get().RoomRegistered(assigned, hostIP)
	if reg.Public {
		metrics.Get().SetRoomPublic(assigned, true)
	}
	if reg.MOTD != "" {
		metrics.Get().SetRoomMOTD(assigned, reg.MOTD)
	}
	if reg.Favicon != "" {
		metrics.Get().SetRoomFavicon(assigned, reg.Favicon)
	}
	defer func() {
		s.Router.Remove(assigned)
		metrics.Get().RoomRemoved(assigned)
		s.ActiveRooms.Add(-1)
	}()

	// Send confirmation back on control stream with the actually assigned name
	json.NewEncoder(stream).Encode(map[string]string{"status": "ok", "room": assigned})

	// Listen for update messages on the control stream
	// Use a fresh limited-reader decoder for updates
	updateDecoder := json.NewDecoder(&io.LimitedReader{R: stream, N: 1 << 20}) // 1MB total for all updates
	go func() {
		for {
			var update roomUpdate
			if err := updateDecoder.Decode(&update); err != nil {
				return
			}
			if update.Public != nil {
				metrics.Get().SetRoomPublic(assigned, *update.Public)
				log.Printf("wt: room %q public=%v", assigned, *update.Public)
			}
			if update.MOTD != nil {
				motd := truncateMOTD(*update.MOTD)
				metrics.Get().SetRoomMOTD(assigned, motd)
				log.Printf("wt: room %q motd=%q", assigned, motd)
			}
			if update.Favicon != nil {
				metrics.Get().SetRoomFavicon(assigned, *update.Favicon)
			}
		}
	}()

	// Keep session alive until context cancels or session closes
	select {
	case <-ctx.Done():
	case <-session.Context().Done():
	}

	log.Printf("wt: session %q disconnected", assigned)
}
