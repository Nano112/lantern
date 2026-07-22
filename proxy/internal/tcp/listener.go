package tcp

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync/atomic"
	"time"

	"github.com/user/minecraft-web/proxy/internal/bridge"
	"github.com/user/minecraft-web/proxy/internal/metrics"
	"github.com/user/minecraft-web/proxy/internal/ratelimit"
	"github.com/user/minecraft-web/proxy/internal/router"
)

const (
	maxConcurrentConns = 1000
	connReadTimeout    = 10 * time.Second  // timeout for handshake reads
	connIdleTimeout    = 30 * time.Second  // timeout for idle pre-bridge connections
)

// Listener accepts incoming Minecraft client TCP connections.
type Listener struct {
	Addr    string
	Domain  string
	Router  *router.Router
	limiter *ratelimit.Limiter
	active  atomic.Int64
}

// ListenAndServe starts accepting TCP connections.
func (l *Listener) ListenAndServe(ctx context.Context) error {
	// 10 new connections per second per IP, burst of 20
	l.limiter = ratelimit.New(10, 20)

	ln, err := net.Listen("tcp", l.Addr)
	if err != nil {
		return fmt.Errorf("tcp listen: %w", err)
	}
	defer ln.Close()

	log.Printf("tcp: listening on %s (max %d concurrent)", l.Addr, maxConcurrentConns)

	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
				log.Printf("tcp: accept error: %v", err)
				continue
			}
		}

		// Extract IP for rate limiting
		ip := ""
		if host, _, err := net.SplitHostPort(conn.RemoteAddr().String()); err == nil {
			ip = host
		}

		// Enforce per-IP rate limit
		if !l.limiter.Allow(ip) {
			conn.Close()
			continue
		}

		// Enforce global connection limit
		if l.active.Load() >= maxConcurrentConns {
			log.Printf("tcp: rejecting connection from %s (at capacity)", ip)
			conn.Close()
			continue
		}

		l.active.Add(1)
		go func() {
			defer l.active.Add(-1)
			l.handleConn(ctx, conn)
		}()
	}
}

func (l *Listener) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()

	// Set deadline for the handshake phase
	conn.SetDeadline(time.Now().Add(connReadTimeout))

	// Extract client IP
	clientIP := ""
	if host, _, err := net.SplitHostPort(conn.RemoteAddr().String()); err == nil {
		clientIP = host
	}

	// Read the full handshake packet to extract the server address and next state
	raw, serverAddr, nextState, err := readHandshake(conn)
	if err != nil {
		log.Printf("tcp: handshake read failed: %v", err)
		return
	}

	// Extract subdomain from server address (e.g., "myroom.localhost" → "myroom")
	subdomain := extractSubdomain(serverAddr, l.Domain)
	log.Printf("tcp: client %s connecting to room %q (address: %s)", clientIP, subdomain, serverAddr)

	m := metrics.Get()

	// If this is a login (nextState==2), try to read the Login Start packet for username
	var loginRaw []byte
	var username string
	if nextState == 2 {
		loginRaw, username, err = readLoginStart(conn)
		if err != nil {
			log.Printf("tcp: login start read failed (non-fatal): %v", err)
			// loginRaw may still have partial data to replay
		}
		if username != "" {
			log.Printf("tcp: player %q from %s joining room %q", username, clientIP, subdomain)
		}
	}

	// Look up the browser session
	session := l.Router.Lookup(subdomain)
	if session == nil {
		log.Printf("tcp: no session for room %q", subdomain)
		m.BridgeFailed()
		return
	}

	// Open a new stream to the browser for this TCP client
	stream, err := session.OpenStream()
	if err != nil {
		log.Printf("tcp: open WT stream failed: %v", err)
		m.BridgeFailed()
		return
	}

	// Replay the handshake bytes so the browser WASM sees them
	if _, err := stream.Write(raw); err != nil {
		log.Printf("tcp: replay handshake failed: %v", err)
		stream.Close()
		m.BridgeFailed()
		return
	}

	// Replay login start bytes if we captured them
	if len(loginRaw) > 0 {
		if _, err := stream.Write(loginRaw); err != nil {
			log.Printf("tcp: replay login start failed: %v", err)
			stream.Close()
			m.BridgeFailed()
			return
		}
	}

	// Clear deadline — bridge handles its own I/O
	conn.SetDeadline(time.Time{})

	// Register client and get byte counters
	clientID := m.BridgeStarted(subdomain, username, clientIP)
	bytesIn, bytesOut := m.ClientBytesCounters(clientID)

	// Bridge the TCP connection and WebTransport stream using external counters
	b := bridge.NewWithCounters(conn, stream, bytesIn, bytesOut)
	log.Printf("tcp: bridge active for room %q (player=%q, ip=%s)", subdomain, username, clientIP)

	select {
	case <-b.Done():
	case <-ctx.Done():
		b.Close()
	}

	m.BridgeStopped(clientID)
	log.Printf("tcp: bridge closed for room %q (player=%q)", subdomain, username)
}

// readHandshake reads a Minecraft handshake packet and returns the raw bytes,
// the server address field, and the next state (1=status, 2=login).
func readHandshake(r io.Reader) (raw []byte, serverAddr string, nextState int, err error) {
	// Read packet length (varint)
	packetLen, lenBytes, err := readVarInt(r)
	if err != nil {
		return nil, "", 0, fmt.Errorf("read packet length: %w", err)
	}
	if packetLen < 1 || packetLen > 1024 {
		return nil, "", 0, fmt.Errorf("invalid packet length: %d", packetLen)
	}

	// Read the full packet body
	body := make([]byte, packetLen)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, "", 0, fmt.Errorf("read packet body: %w", err)
	}

	// Combine length prefix + body as the raw bytes to replay
	raw = append(lenBytes, body...)

	// Parse packet ID (should be 0x00 for handshake)
	offset := 0
	packetID, n := binary.Uvarint(body)
	if n <= 0 || packetID != 0 {
		return raw, "", 0, fmt.Errorf("not a handshake packet (id=%d)", packetID)
	}
	offset += n

	// Skip protocol version (varint)
	_, n = binary.Uvarint(body[offset:])
	if n <= 0 {
		return raw, "", 0, fmt.Errorf("bad protocol version varint")
	}
	offset += n

	// Read server address (varint-prefixed string)
	addrLen, n := binary.Uvarint(body[offset:])
	if n <= 0 {
		return raw, "", 0, fmt.Errorf("bad address length varint")
	}
	offset += n

	if offset+int(addrLen) > len(body) {
		return raw, "", 0, fmt.Errorf("address length exceeds packet")
	}
	serverAddr = string(body[offset : offset+int(addrLen)])
	offset += int(addrLen)

	// Read server port (unsigned short, 2 bytes)
	if offset+2 > len(body) {
		return raw, serverAddr, 0, fmt.Errorf("missing server port")
	}
	offset += 2

	// Read next state (varint): 1=status, 2=login
	ns, n := binary.Uvarint(body[offset:])
	if n <= 0 {
		return raw, serverAddr, 0, fmt.Errorf("bad next state varint")
	}
	nextState = int(ns)

	return raw, serverAddr, nextState, nil
}

// readLoginStart reads the Login Start packet (ID 0x00 in login state) and
// extracts the player username. Returns the raw packet bytes for replay.
func readLoginStart(r io.Reader) (raw []byte, username string, err error) {
	// Read packet length (varint)
	packetLen, lenBytes, err := readVarInt(r)
	if err != nil {
		return nil, "", fmt.Errorf("read login packet length: %w", err)
	}
	if packetLen < 1 || packetLen > 1024 {
		return nil, "", fmt.Errorf("invalid login packet length: %d", packetLen)
	}

	// Read the full packet body
	body := make([]byte, packetLen)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, "", fmt.Errorf("read login packet body: %w", err)
	}

	raw = append(lenBytes, body...)

	// Parse packet ID (should be 0x00 for Login Start)
	packetID, n := binary.Uvarint(body)
	if n <= 0 {
		return raw, "", fmt.Errorf("bad login packet id varint")
	}
	if packetID != 0 {
		// Not Login Start, just return the raw bytes for replay
		return raw, "", nil
	}
	offset := n

	// Read username (varint-prefixed string)
	nameLen, n := binary.Uvarint(body[offset:])
	if n <= 0 {
		return raw, "", fmt.Errorf("bad username length varint")
	}
	offset += n

	if offset+int(nameLen) > len(body) {
		return raw, "", fmt.Errorf("username length exceeds packet")
	}
	username = string(body[offset : offset+int(nameLen)])

	return raw, username, nil
}

// readVarInt reads a Minecraft-style varint from the reader.
func readVarInt(r io.Reader) (int, []byte, error) {
	var result int
	var shift uint
	var buf []byte
	b := make([]byte, 1)

	for {
		if _, err := io.ReadFull(r, b); err != nil {
			return 0, nil, err
		}
		buf = append(buf, b[0])
		result |= int(b[0]&0x7F) << shift
		if b[0]&0x80 == 0 {
			return result, buf, nil
		}
		shift += 7
		if shift >= 35 {
			return 0, nil, fmt.Errorf("varint too long")
		}
	}
}

// extractSubdomain extracts the subdomain from a Minecraft server address.
// e.g., "myroom.localhost" with domain "localhost" → "myroom"
// If no subdomain, returns "default".
func extractSubdomain(addr, domain string) string {
	// Strip any FML markers or trailing dots
	addr = strings.Split(addr, "\x00")[0]
	addr = strings.TrimSuffix(addr, ".")

	if !strings.HasSuffix(addr, "."+domain) {
		return "default"
	}

	sub := strings.TrimSuffix(addr, "."+domain)
	if sub == "" || strings.Contains(sub, ".") {
		return "default"
	}
	return sub
}
