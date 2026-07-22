package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/user/minecraft-web/proxy/internal/db"
)

// HashPassword returns a bcrypt hash of the password.
func HashPassword(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(h), err
}

// CheckPassword compares a password against a bcrypt hash.
func CheckPassword(password, hash string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
}

// JWT payload.
type jwtPayload struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
	Iat int64  `json:"iat"`
}

// GenerateJWT creates a signed HS256 JWT with a 7-day TTL.
func GenerateJWT(username, secret string) (string, error) {
	header := base64url([]byte(`{"alg":"HS256","typ":"JWT"}`))

	payload := jwtPayload{
		Sub: username,
		Exp: time.Now().Add(7 * 24 * time.Hour).Unix(),
		Iat: time.Now().Unix(),
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	payloadB64 := base64url(payloadJSON)

	unsigned := header + "." + payloadB64
	sig := sign(unsigned, secret)

	return unsigned + "." + sig, nil
}

// ValidateJWT validates an HS256 JWT and returns the subject (username).
func ValidateJWT(token, secret string) (string, error) {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return "", fmt.Errorf("invalid token format")
	}

	// Verify signature
	unsigned := parts[0] + "." + parts[1]
	expectedSig := sign(unsigned, secret)
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
		return "", fmt.Errorf("invalid signature")
	}

	// Decode payload
	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("invalid payload encoding")
	}

	var payload jwtPayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return "", fmt.Errorf("invalid payload")
	}

	if time.Now().Unix() > payload.Exp {
		return "", fmt.Errorf("token expired")
	}

	return payload.Sub, nil
}

// RequireAuth returns middleware that validates JWT from the Authorization header.
func RequireAuth(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Handle CORS preflight
		if r.Method == "OPTIONS" {
			setCORS(w)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			setCORS(w)
			jsonError(w, "missing authorization", http.StatusUnauthorized)
			return
		}

		token := strings.TrimPrefix(auth, "Bearer ")
		_, err := ValidateJWT(token, secret)
		if err != nil {
			setCORS(w)
			jsonError(w, "invalid token", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// LoginHandler handles POST /api/auth/login.
func LoginHandler(database *db.DB, secret string) http.HandlerFunc {
	type loginReq struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	type loginResp struct {
		Token    string `json:"token"`
		Username string `json:"username"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.Method != "POST" {
			jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req loginReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonError(w, "invalid request body", http.StatusBadRequest)
			return
		}

		if req.Username == "" || req.Password == "" {
			jsonError(w, "username and password required", http.StatusBadRequest)
			return
		}

		_, hash, err := database.GetAdmin(req.Username)
		if err != nil {
			jsonError(w, "invalid credentials", http.StatusUnauthorized)
			return
		}

		if err := CheckPassword(req.Password, hash); err != nil {
			jsonError(w, "invalid credentials", http.StatusUnauthorized)
			return
		}

		token, err := GenerateJWT(req.Username, secret)
		if err != nil {
			jsonError(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(loginResp{Token: token, Username: req.Username})
	}
}

// MeHandler handles GET /api/auth/me — validates the JWT and returns the username.
func MeHandler(secret string) http.HandlerFunc {
	type meResp struct {
		Username string `json:"username"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			jsonError(w, "missing authorization", http.StatusUnauthorized)
			return
		}

		username, err := ValidateJWT(strings.TrimPrefix(auth, "Bearer "), secret)
		if err != nil {
			jsonError(w, "invalid token", http.StatusUnauthorized)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(meResp{Username: username})
	}
}

func base64url(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

func sign(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return base64url(mac.Sum(nil))
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`, msg)
}
