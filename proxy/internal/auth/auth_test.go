package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/user/minecraft-web/proxy/internal/db"
)

const testSecret = "test-secret-key"

func TestHashAndCheckPassword(t *testing.T) {
	hash, err := HashPassword("mypassword")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if err := CheckPassword("mypassword", hash); err != nil {
		t.Error("CheckPassword should accept correct password")
	}
	if err := CheckPassword("wrong", hash); err == nil {
		t.Error("CheckPassword should reject wrong password")
	}
}

func TestJWTRoundTrip(t *testing.T) {
	token, err := GenerateJWT("admin", testSecret)
	if err != nil {
		t.Fatalf("GenerateJWT: %v", err)
	}

	username, err := ValidateJWT(token, testSecret)
	if err != nil {
		t.Fatalf("ValidateJWT: %v", err)
	}
	if username != "admin" {
		t.Errorf("expected 'admin', got %q", username)
	}
}

func TestJWTWrongSecret(t *testing.T) {
	token, _ := GenerateJWT("admin", testSecret)
	_, err := ValidateJWT(token, "wrong-secret")
	if err == nil {
		t.Error("expected error for wrong secret")
	}
}

func TestJWTInvalidFormat(t *testing.T) {
	_, err := ValidateJWT("not.a.valid.token", testSecret)
	if err == nil {
		t.Error("expected error for invalid format")
	}
	_, err = ValidateJWT("garbage", testSecret)
	if err == nil {
		t.Error("expected error for no dots")
	}
}

func TestRequireAuthMiddleware(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := RequireAuth(testSecret, inner)

	// No auth header
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}

	// Valid token
	token, _ := GenerateJWT("admin", testSecret)
	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid token
	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer bad-token")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}

	// CORS preflight
	req = httptest.NewRequest("OPTIONS", "/", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204 for OPTIONS, got %d", rec.Code)
	}
}

func newTestDB(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.NewMemory()
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	if err := d.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestLoginHandler(t *testing.T) {
	database := newTestDB(t)
	hash, _ := HashPassword("pass123")
	database.CreateAdmin("admin", hash)
	handler := LoginHandler(database, testSecret)

	// Successful login
	body := `{"username":"admin","password":"pass123"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Token    string `json:"token"`
		Username string `json:"username"`
	}
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Username != "admin" {
		t.Errorf("expected username 'admin', got %q", resp.Username)
	}
	if resp.Token == "" {
		t.Error("expected non-empty token")
	}

	// Wrong password
	body = `{"username":"admin","password":"wrong"}`
	req = httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for wrong password, got %d", rec.Code)
	}

	// Unknown user
	body = `{"username":"nobody","password":"pass"}`
	req = httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for unknown user, got %d", rec.Code)
	}

	// GET not allowed
	req = httptest.NewRequest("GET", "/api/auth/login", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 for GET, got %d", rec.Code)
	}
}

func TestMeHandler(t *testing.T) {
	handler := MeHandler(testSecret)
	token, _ := GenerateJWT("testuser", testSecret)

	// Valid token
	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp struct{ Username string }
	json.NewDecoder(rec.Body).Decode(&resp)
	if resp.Username != "testuser" {
		t.Errorf("expected 'testuser', got %q", resp.Username)
	}

	// No auth
	req = httptest.NewRequest("GET", "/api/auth/me", nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}
