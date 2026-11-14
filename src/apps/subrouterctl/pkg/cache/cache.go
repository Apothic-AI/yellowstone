// Package cache keeps API responses in a local SQLite database.
//
// Responses are written through on every request, so the cache is always
// warm. Reading from it is a separate decision:
//
//   - a read is served from the cache when the caller passes a time to live,
//   - a read falls back to the cache when the network is unavailable,
//   - logs are the exception: a time range that is already cached is served
//     from the cache, and only the ranges that are missing are fetched.
//
// Account state is never served from the cache unless the network is down.
package cache

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

// DBName is the database file inside the cache directory.
const DBName = "cache.db"

// DB is the SQLite database that holds the cache.
type DB struct {
	db   *sql.DB
	path string
}

// Open opens or creates the cache database in dir.
//
// A database that cannot be opened is not fatal for the caller: a command
// that cannot open the cache simply runs without one.
func Open(dir string) (*DB, error) {
	if dir == "" {
		return nil, fmt.Errorf("cache: no directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("cache: create %s: %w", dir, err)
	}
	d := &DB{path: filepath.Join(dir, DBName)}
	if err := d.open(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *DB) open() error {
	db, err := sql.Open("sqlite", d.path)
	if err != nil {
		return fmt.Errorf("cache: open %s: %w", d.path, err)
	}
	// One writer at a time keeps the database free of lock contention.
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
		"PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return fmt.Errorf("cache: %s: %w", pragma, err)
		}
	}
	const schema = `
CREATE TABLE IF NOT EXISTS entries (
    key       TEXT PRIMARY KEY,
    stored_at INTEGER NOT NULL,
    body      BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS log_rows (
    signature  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    rid        TEXT NOT NULL,
    data       BLOB NOT NULL,
    UNIQUE (signature, created_at, rid)
);
CREATE TABLE IF NOT EXISTS log_windows (
    signature TEXT NOT NULL,
    from_ts   INTEGER NOT NULL,
    to_ts     INTEGER NOT NULL,
    PRIMARY KEY (signature, from_ts)
) WITHOUT ROWID;`
	if err := d.migrate(db, schema); err != nil {
		db.Close()
		return err
	}
	d.db = db
	// The cache can hold account data, so it stays readable by its owner
	// only. The write ahead log and the shared memory file hold the same
	// data as the database, so they are locked down as well.
	d.lockDown()
	d.removeLegacyFiles()
	return nil
}

// lockDown restricts the database and its side files to their owner.
func (d *DB) lockDown() {
	for _, path := range []string{d.path, d.path + "-wal", d.path + "-shm", d.path + "-journal"} {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		_ = os.Chmod(path, 0o600)
	}
}

// schemaVersion is the layout of the cache tables. A database that holds a
// different version is rebuilt from scratch: the cache is a copy of data the
// platform still serves, so throwing it away costs nothing but a fetch.
const schemaVersion = 3

// migrate brings the database up to the current schema.
func (d *DB) migrate(db *sql.DB, schema string) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("cache: meta table: %w", err)
	}
	var version string
	err := db.QueryRow(`SELECT value FROM meta WHERE key = 'schema'`).Scan(&version)
	switch {
	case err == nil && version == strconv.Itoa(schemaVersion):
		return nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("cache: schema version: %w", err)
	}
	for _, table := range []string{"entries", "log_rows", "log_windows"} {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return fmt.Errorf("cache: drop %s: %w", table, err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("cache: schema: %w", err)
	}
	if _, err := db.Exec(
		`INSERT INTO meta (key, value) VALUES ('schema', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		strconv.Itoa(schemaVersion)); err != nil {
		return fmt.Errorf("cache: schema version: %w", err)
	}
	return nil
}

// removeLegacyFiles clears out the text file cache that came before SQLite.
//
// Only the files the old cache wrote are touched: a 32 character hex name
// with a .json suffix. A cache directory that holds anything else keeps it.
func (d *DB) removeLegacyFiles() {
	dir := filepath.Dir(d.path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() && name == "ranges" {
			_ = os.RemoveAll(filepath.Join(dir, name))
			continue
		}
		if !e.IsDir() && legacyName.MatchString(name) {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}

// legacyName matches the files the text file cache wrote.
var legacyName = regexp.MustCompile(`^[0-9a-f]{32}\.json$`)

// Close releases the database.
func (d *DB) Close() error {
	if d == nil || d.db == nil {
		return nil
	}
	return d.db.Close()
}

// Path returns the location of the database file.
func (d *DB) Path() string {
	if d == nil {
		return ""
	}
	return d.path
}

// Store is a key/value view of the cache.
type Store struct {
	DB  *DB
	TTL time.Duration
}

// New builds a store over a database. A TTL of zero means that nothing is
// served from the cache except as an offline fallback.
func New(db *DB, ttl time.Duration) *Store {
	return &Store{DB: db, TTL: ttl}
}

// Enabled reports whether the store can hold entries.
func (s *Store) Enabled() bool { return s != nil && s.DB != nil && s.DB.db != nil }

// Fresh reports whether a cached entry may be served on its own merits.
func (s *Store) Fresh() bool { return s != nil && s.TTL > 0 }

// Key derives a cache key from the scope of a request, its method, its path
// and its query.
//
// The scope separates the accounts and the sites that share one cache
// directory: a response for one account must never be served to another.
func Key(scope, method, path, query string) string {
	sum := sha256.Sum256([]byte(scope + "\x00" + method + " " + path + "?" + query))
	return hex.EncodeToString(sum[:])[:32]
}

// Get returns a cached response when it is still fresh. It returns nothing
// when no time to live is set, because the caller then wants live data.
func (s *Store) Get(key string) ([]byte, bool) {
	if !s.Enabled() || !s.Fresh() {
		return nil, false
	}
	var (
		body     []byte
		storedAt int64
	)
	err := s.DB.db.QueryRow(`SELECT body, stored_at FROM entries WHERE key = ?`, key).Scan(&body, &storedAt)
	if err != nil {
		return nil, false
	}
	if time.Since(time.UnixMilli(storedAt)) > s.TTL {
		return nil, false
	}
	out, err := decompress(body)
	if err != nil {
		return nil, false
	}
	return out, true
}

// GetAny returns a cached response regardless of its age. It is the offline
// fallback.
func (s *Store) GetAny(key string) ([]byte, bool) {
	if !s.Enabled() {
		return nil, false
	}
	var body []byte
	err := s.DB.db.QueryRow(`SELECT body FROM entries WHERE key = ?`, key).Scan(&body)
	if err != nil {
		return nil, false
	}
	out, err := decompress(body)
	if err != nil {
		return nil, false
	}
	return out, true
}

// Put stores a response with the current timestamp.
func (s *Store) Put(key string, body []byte) error {
	if !s.Enabled() {
		return nil
	}
	_, err := s.DB.db.Exec(
		`INSERT INTO entries (key, stored_at, body) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET stored_at = excluded.stored_at, body = excluded.body`,
		key, time.Now().UnixMilli(), compress(body))
	return err
}

// Clear removes every cached entry.
func (s *Store) Clear() error {
	if !s.Enabled() {
		return nil
	}
	for _, table := range []string{"entries", "log_rows", "log_windows"} {
		if _, err := s.DB.db.Exec("DELETE FROM " + table); err != nil {
			return fmt.Errorf("cache: clear %s: %w", table, err)
		}
	}
	// Hand the freed pages back to the file system.
	if _, err := s.DB.db.Exec("VACUUM"); err != nil {
		return fmt.Errorf("cache: vacuum: %w", err)
	}
	return nil
}

// rowID extracts the request identifier of a cached row so that duplicates
// can be dropped.
func rowID(data []byte) string {
	var probe struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(data, &probe); err == nil && probe.RequestID != "" {
		return probe.RequestID
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16]
}

// compress shrinks a payload with gzip.
//
// The payloads are highly repetitive JSON, so this cuts the size of the
// cache by more than an order of magnitude. A payload that cannot be
// compressed is stored as it is.
func compress(data []byte) []byte {
	if len(data) == 0 {
		return data
	}
	var buf bytes.Buffer
	w, err := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	if err != nil {
		return data
	}
	if _, err := w.Write(data); err != nil {
		return data
	}
	if err := w.Close(); err != nil {
		return data
	}
	return buf.Bytes()
}

// decompress restores a payload that compress wrote. Payloads that were
// stored before compression existed are returned unchanged.
func decompress(data []byte) ([]byte, error) {
	if len(data) < 2 || data[0] != 0x1f || data[1] != 0x8b {
		return data, nil
	}
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("cache: read compressed payload: %w", err)
	}
	defer r.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("cache: read compressed payload: %w", err)
	}
	return out, nil
}
