package db

import (
	"testing"
)

func newTestDB(t *testing.T) *DB {
	t.Helper()
	d, err := NewMemory()
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	if err := d.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestInitCreatesTable(t *testing.T) {
	d := newTestDB(t)
	// Calling Init again should be idempotent
	if err := d.Init(); err != nil {
		t.Fatalf("second Init: %v", err)
	}
}

func TestCreateAndGetAdmin(t *testing.T) {
	d := newTestDB(t)

	if err := d.CreateAdmin("alice", "hash123"); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}

	id, hash, err := d.GetAdmin("alice")
	if err != nil {
		t.Fatalf("GetAdmin: %v", err)
	}
	if id != 1 {
		t.Errorf("expected id 1, got %d", id)
	}
	if hash != "hash123" {
		t.Errorf("expected hash 'hash123', got %q", hash)
	}
}

func TestGetAdminNotFound(t *testing.T) {
	d := newTestDB(t)
	_, _, err := d.GetAdmin("nobody")
	if err == nil {
		t.Fatal("expected error for missing admin")
	}
}

func TestCreateDuplicateAdmin(t *testing.T) {
	d := newTestDB(t)
	if err := d.CreateAdmin("bob", "h1"); err != nil {
		t.Fatalf("first CreateAdmin: %v", err)
	}
	err := d.CreateAdmin("bob", "h2")
	if err == nil {
		t.Fatal("expected error for duplicate admin")
	}
}

func TestCountAdmins(t *testing.T) {
	d := newTestDB(t)

	count, err := d.CountAdmins()
	if err != nil {
		t.Fatalf("CountAdmins: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 admins, got %d", count)
	}

	d.CreateAdmin("a", "h")
	d.CreateAdmin("b", "h")

	count, err = d.CountAdmins()
	if err != nil {
		t.Fatalf("CountAdmins: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 admins, got %d", count)
	}
}

func TestFileBacked(t *testing.T) {
	path := t.TempDir() + "/test.db"

	// Create and populate
	d1, err := New(path)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := d1.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if err := d1.CreateAdmin("persist", "hash"); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	d1.Close()

	// Reopen and verify data persisted
	d2, err := New(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer d2.Close()

	_, hash, err := d2.GetAdmin("persist")
	if err != nil {
		t.Fatalf("GetAdmin after reopen: %v", err)
	}
	if hash != "hash" {
		t.Errorf("expected 'hash', got %q", hash)
	}
}
