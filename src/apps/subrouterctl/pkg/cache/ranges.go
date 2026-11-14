package cache

import (
	"encoding/json"
	"sort"
)

// RangeStore keeps time series payloads together with the windows of time
// they cover.
//
// It exists for the usage logs. A log request names a time range, and the
// store can answer the parts of that range it already holds. The parts it
// does not hold are fetched from the API and added.
type RangeStore struct {
	DB *DB
}

// NewRangeStore builds a range store over a database.
func NewRangeStore(db *DB) *RangeStore { return &RangeStore{DB: db} }

// Enabled reports whether the store can hold entries.
func (s *RangeStore) Enabled() bool { return s != nil && s.DB != nil && s.DB.db != nil }

// Span is a stretch of unix seconds. Both ends are included.
type Span struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// Row is one cached record with the timestamp it was filed under.
type Row struct {
	CreatedAt int64           `json:"t"`
	Data      json.RawMessage `json:"d"`
}

// Window is a span of time together with the rows that fall inside it.
type Window struct {
	Span
	Rows []Row `json:"rows"`
}

// Covered returns the spans of time that the store already holds for a
// signature, merged into the smallest possible set.
func (s *RangeStore) Covered(signature string) []Span {
	if !s.Enabled() {
		return nil
	}
	rows, err := s.DB.db.Query(
		`SELECT from_ts, to_ts FROM log_windows WHERE signature = ? ORDER BY from_ts`, signature)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var spans []Span
	for rows.Next() {
		var sp Span
		if err := rows.Scan(&sp.From, &sp.To); err != nil {
			continue
		}
		spans = append(spans, sp)
	}
	return mergeSpans(spans)
}

// Missing returns the parts of [from,to] that the store does not hold.
func (s *RangeStore) Missing(signature string, from, to int64) []Span {
	if to <= from {
		return nil
	}
	return missingSpans(s.Covered(signature), from, to)
}

// Rows returns every cached row that falls inside [from,to], newest first.
func (s *RangeStore) Rows(signature string, from, to int64) []Row {
	if !s.Enabled() {
		return nil
	}
	rows, err := s.DB.db.Query(
		`SELECT created_at, data FROM log_rows
		 WHERE signature = ? AND created_at >= ? AND created_at <= ?
		 ORDER BY created_at DESC`, signature, from, to)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var data []byte
		if err := rows.Scan(&r.CreatedAt, &data); err != nil {
			continue
		}
		body, err := decompress(data)
		if err != nil {
			continue
		}
		r.Data = body
		out = append(out, r)
	}
	return out
}

// Put stores a window and merges it with the coverage already held.
func (s *RangeStore) Put(signature string, w Window) error {
	if !s.Enabled() {
		return nil
	}
	tx, err := s.DB.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, r := range w.Rows {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO log_rows (signature, created_at, rid, data) VALUES (?, ?, ?, ?)`,
			signature, r.CreatedAt, rowID(r.Data), compress(r.Data)); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO log_windows (signature, from_ts, to_ts) VALUES (?, ?, ?)
		 ON CONFLICT(signature, from_ts) DO UPDATE SET to_ts = excluded.to_ts`,
		signature, w.From, w.To); err != nil {
		return err
	}
	return tx.Commit()
}

// mergeSpans merges overlapping or touching spans. Both ends of a span are
// included, so two spans that share a second are one span.
func mergeSpans(spans []Span) []Span {
	if len(spans) == 0 {
		return nil
	}
	sort.SliceStable(spans, func(i, j int) bool {
		if spans[i].From != spans[j].From {
			return spans[i].From < spans[j].From
		}
		return spans[i].To < spans[j].To
	})
	var out []Span
	for _, s := range spans {
		if len(out) == 0 || s.From > out[len(out)-1].To+1 {
			out = append(out, s)
			continue
		}
		if s.To > out[len(out)-1].To {
			out[len(out)-1].To = s.To
		}
	}
	return out
}

// missingSpans subtracts the covered spans from [from,to]. Both ends of a
// span are included, so a covered second is never fetched twice.
func missingSpans(covered []Span, from, to int64) []Span {
	var out []Span
	cursor := from
	for _, c := range covered {
		if c.To < cursor {
			continue
		}
		if c.From > to {
			break
		}
		if c.From > cursor {
			end := c.From - 1
			if end > to {
				end = to
			}
			out = append(out, Span{From: cursor, To: end})
		}
		if c.To >= cursor {
			cursor = c.To + 1
		}
		if cursor > to {
			return out
		}
	}
	if cursor <= to {
		out = append(out, Span{From: cursor, To: to})
	}
	return out
}
