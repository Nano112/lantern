package db

import (
	"database/sql"
	"fmt"

	_ "turso.tech/database/tursogo"
)

// DB provides admin user storage backed by SQLite.
type DB struct {
	conn *sql.DB
}

// New creates a DB backed by a SQLite file at the given path.
func New(path string) (*DB, error) {
	conn, err := sql.Open("turso", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	// WAL mode for better concurrency
	if _, err := conn.Exec("PRAGMA journal_mode=WAL"); err != nil {
		conn.Close()
		return nil, fmt.Errorf("set WAL mode: %w", err)
	}
	return &DB{conn: conn}, nil
}

// NewMemory creates an in-memory DB for local development.
func NewMemory() (*DB, error) {
	return New(":memory:")
}

// Close closes the database connection.
func (d *DB) Close() error {
	return d.conn.Close()
}

// Init creates the admins table if it doesn't exist.
func (d *DB) Init() error {
	_, err := d.conn.Exec(`
		CREATE TABLE IF NOT EXISTS admins (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			created_at TEXT DEFAULT (datetime('now'))
		)
	`)
	return err
}

// CreateAdmin inserts a new admin user.
func (d *DB) CreateAdmin(username, passwordHash string) error {
	_, err := d.conn.Exec(
		"INSERT INTO admins (username, password_hash) VALUES (?, ?)",
		username, passwordHash,
	)
	return err
}

// GetAdmin returns the id and password hash for a username.
func (d *DB) GetAdmin(username string) (id int64, hash string, err error) {
	err = d.conn.QueryRow(
		"SELECT id, password_hash FROM admins WHERE username = ?",
		username,
	).Scan(&id, &hash)
	if err == sql.ErrNoRows {
		return 0, "", fmt.Errorf("admin not found: %s", username)
	}
	return
}

// CountAdmins returns the number of admin users.
func (d *DB) CountAdmins() (int64, error) {
	var count int64
	err := d.conn.QueryRow("SELECT COUNT(*) FROM admins").Scan(&count)
	return count, err
}
