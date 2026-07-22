package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAllowBurst(t *testing.T) {
	l := &Limiter{
		buckets: make(map[string]*bucket),
		rate:    1,
		burst:   3,
	}

	// Should allow up to burst count
	for i := 0; i < 3; i++ {
		if !l.Allow("key") {
			t.Errorf("request %d should be allowed", i+1)
		}
	}

	// Next request should be denied (no time passed to refill)
	if l.Allow("key") {
		t.Error("request after burst should be denied")
	}
}

func TestAllowDifferentKeys(t *testing.T) {
	l := &Limiter{
		buckets: make(map[string]*bucket),
		rate:    1,
		burst:   1,
	}

	if !l.Allow("a") {
		t.Error("first request for 'a' should be allowed")
	}
	if !l.Allow("b") {
		t.Error("first request for 'b' should be allowed")
	}
	// Both exhausted
	if l.Allow("a") {
		t.Error("second request for 'a' should be denied")
	}
	if l.Allow("b") {
		t.Error("second request for 'b' should be denied")
	}
}

func TestHTTPMiddleware(t *testing.T) {
	l := &Limiter{
		buckets: make(map[string]*bucket),
		rate:    0,
		burst:   1,
	}

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := l.HTTPMiddleware(inner)

	// First request allowed
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Second request denied (rate=0, no refill)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rec.Code)
	}
}

func TestExtractIPFromXFF(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-For", "10.0.0.1, 192.168.1.1")
	ip := extractIP(req)
	if ip != "10.0.0.1" {
		t.Errorf("expected '10.0.0.1', got %q", ip)
	}
}

func TestExtractIPFromRemoteAddr(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "192.168.1.5:9999"
	ip := extractIP(req)
	if ip != "192.168.1.5" {
		t.Errorf("expected '192.168.1.5', got %q", ip)
	}
}
