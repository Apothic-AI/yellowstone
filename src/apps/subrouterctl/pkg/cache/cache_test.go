package cache

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestDB opens a cache database in a temporary directory.
func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestStoreWritesThroughWithoutATTL(t *testing.T) {
	db := newTestDB(t)
	s := New(db, 0)
	if !s.Enabled() {
		t.Error("a store with a database must be enabled")
	}
	if s.Fresh() {
		t.Error("a store with a zero TTL must not serve entries on its own merits")
	}
	if err := s.Put("k", []byte(`{"x":1}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if db.Path() == "" {
		t.Error("the database must report its path")
	}
	if _, err := os.Stat(db.Path()); err != nil {
		t.Errorf("the database file must exist: %v", err)
	}
}

func TestStoreReadsOnlyWithATTL(t *testing.T) {
	s := New(newTestDB(t), 0)
	if err := s.Put("k", []byte(`{}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, ok := s.Get("k"); ok {
		t.Error("a store with no TTL must not serve entries")
	}
	if _, ok := s.GetAny("k"); !ok {
		t.Error("GetAny must serve an entry regardless of age")
	}
}

func TestStoreServesFreshEntries(t *testing.T) {
	s := New(newTestDB(t), time.Minute)
	if err := s.Put("k", []byte(`{"a":1}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, ok := s.Get("k")
	if !ok {
		t.Fatal("Get missed a fresh entry")
	}
	if string(got) != `{"a":1}` {
		t.Errorf("Get = %s", got)
	}
}

func TestStoreExpires(t *testing.T) {
	s := New(newTestDB(t), time.Nanosecond)
	if err := s.Put("k", []byte(`{}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, ok := s.Get("k"); ok {
		t.Error("an expired entry must not be served")
	}
	if _, ok := s.GetAny("k"); !ok {
		t.Error("an expired entry must still be available as an offline fallback")
	}
}

func TestStoreOverwritesAnEntry(t *testing.T) {
	s := New(newTestDB(t), time.Minute)
	if err := s.Put("k", []byte(`{"a":1}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Put("k", []byte(`{"a":2}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, ok := s.Get("k")
	if !ok {
		t.Fatal("Get missed the entry")
	}
	if string(got) != `{"a":2}` {
		t.Errorf("Get = %s, want the newer body", got)
	}
}

func TestStoreClear(t *testing.T) {
	s := New(newTestDB(t), time.Minute)
	if err := s.Put("a", []byte(`{}`)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, ok := s.GetAny("a"); ok {
		t.Error("Clear left an entry behind")
	}
}

func TestStoreClearRemovesRangeRows(t *testing.T) {
	db := newTestDB(t)
	s := New(db, time.Minute)
	r := NewRangeStore(db)
	row := Row{CreatedAt: 5, Data: []byte(`{"id":"a"}`)}
	if err := r.Put("sig", Window{Span: Span{From: 0, To: 10}, Rows: []Row{row}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if rows := r.Rows("sig", 0, 10); len(rows) != 0 {
		t.Errorf("Clear left %d range rows behind", len(rows))
	}
	if covered := r.Covered("sig"); len(covered) != 0 {
		t.Errorf("Clear left %d windows behind", len(covered))
	}
}

func TestOpenCreatesTheDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "cache")
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("Open must create the cache directory: %v", err)
	}
}

func TestOpenRemovesTheLegacyTextCache(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "0123456789abcdef0123456789abcdef.json")
	if err := os.WriteFile(legacy, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write legacy file: %v", err)
	}
	oldRanges := filepath.Join(dir, "ranges")
	if err := os.MkdirAll(oldRanges, 0o700); err != nil {
		t.Fatalf("create legacy ranges: %v", err)
	}
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Error("the legacy cache files must be removed")
	}
	if _, err := os.Stat(oldRanges); !os.IsNotExist(err) {
		t.Error("the legacy ranges directory must be removed")
	}
}

func TestOpenKeepsFilesItDoesNotOwn(t *testing.T) {
	dir := t.TempDir()
	other := filepath.Join(dir, "notes.json")
	if err := os.WriteFile(other, []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if _, err := os.Stat(other); err != nil {
		t.Errorf("a file the cache does not own must be left alone: %v", err)
	}
}

func TestClearOnAMissingDirectory(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if err := New(db, time.Minute).Clear(); err != nil {
		t.Errorf("Clear on a missing directory: %v", err)
	}
}

func TestStoreCompressesEntries(t *testing.T) {
	db := newTestDB(t)
	s := New(db, time.Minute)
	body := []byte(strings.Repeat(`{"model":"gpt-4","tokens":1234},`, 200))
	if err := s.Put("k", body); err != nil {
		t.Fatalf("Put: %v", err)
	}
	var stored []byte
	if err := db.db.QueryRow(`SELECT body FROM entries WHERE key = ?`, "k").Scan(&stored); err != nil {
		t.Fatalf("read stored body: %v", err)
	}
	if len(stored) >= len(body) {
		t.Errorf("the stored body is %d bytes, want less than %d", len(stored), len(body))
	}
	got, ok := s.Get("k")
	if !ok {
		t.Fatal("Get missed the entry")
	}
	if !bytes.Equal(got, body) {
		t.Error("the entry did not survive the round trip")
	}
}

func TestStoreReadsUncompressedEntries(t *testing.T) {
	db := newTestDB(t)
	s := New(db, time.Minute)
	// An entry written before compression existed is still readable.
	if _, err := db.db.Exec(`INSERT INTO entries (key, stored_at, body) VALUES (?, ?, ?)`,
		"old", time.Now().UnixMilli(), []byte(`{"plain":true}`)); err != nil {
		t.Fatalf("insert: %v", err)
	}
	got, ok := s.Get("old")
	if !ok {
		t.Fatal("Get missed the entry")
	}
	if string(got) != `{"plain":true}` {
		t.Errorf("Get = %s", got)
	}
}

func TestKeyIsStableAndDistinct(t *testing.T) {
	a := Key("scope", "GET", "/api/marketplace/models", "page=1")
	b := Key("scope", "GET", "/api/marketplace/models", "page=1")
	c := Key("scope", "GET", "/api/marketplace/models", "page=2")
	d := Key("scope", "GET", "/api/marketplace/providers", "page=1")
	e := Key("other", "GET", "/api/marketplace/models", "page=1")
	if a != b {
		t.Error("the same request must produce the same key")
	}
	if a == c || a == d {
		t.Error("different requests must produce different keys")
	}
	if a == e {
		t.Error("different scopes must produce different keys")
	}
	if len(a) != 32 {
		t.Errorf("key length = %d, want 32", len(a))
	}
}
