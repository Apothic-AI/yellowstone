package cache

import (
	"encoding/json"
	"testing"
)

func row(at int64, id string) Row {
	return Row{CreatedAt: at, Data: json.RawMessage(`{"id":"` + id + `"}`)}
}

func TestRangeStoreMissingOnAnEmptyStore(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	missing := s.Missing("sig", 100, 200)
	if len(missing) != 1 || missing[0].From != 100 || missing[0].To != 200 {
		t.Fatalf("Missing = %v, want one span of 100 to 200", missing)
	}
}

func TestRangeStoreCoversWhatItHolds(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("sig", Window{Span: Span{From: 100, To: 200}, Rows: []Row{row(150, "a")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if missing := s.Missing("sig", 100, 200); len(missing) != 0 {
		t.Errorf("Missing = %v, want nothing", missing)
	}
	// A range that is partly covered reports only the gap.
	missing := s.Missing("sig", 50, 250)
	if len(missing) != 2 {
		t.Fatalf("Missing = %v, want two spans", missing)
	}
	if missing[0].From != 50 || missing[0].To != 99 {
		t.Errorf("first gap = %v, want 50 to 99", missing[0])
	}
	if missing[1].From != 201 || missing[1].To != 250 {
		t.Errorf("second gap = %v, want 201 to 250", missing[1])
	}
}

func TestRangeStoreFetchesOnlyTheGap(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("sig", Window{Span: Span{From: 100, To: 200}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	missing := s.Missing("sig", 100, 300)
	if len(missing) != 1 || missing[0].From != 201 || missing[0].To != 300 {
		t.Fatalf("Missing = %v, want 201 to 300", missing)
	}
}

func TestRangeStoreRowsAreFilteredByTime(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("sig", Window{Span: Span{From: 100, To: 200}, Rows: []Row{row(120, "a"), row(180, "b")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rows := s.Rows("sig", 150, 200)
	if len(rows) != 1 || rows[0].CreatedAt != 180 {
		t.Errorf("Rows = %v, want only the row at 180", rows)
	}
}

func TestRangeStoreRowsAreNewestFirst(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("sig", Window{Span: Span{From: 0, To: 1000}, Rows: []Row{row(100, "a"), row(900, "b"), row(500, "c")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	rows := s.Rows("sig", 0, 1000)
	if len(rows) != 3 {
		t.Fatalf("Rows = %d, want 3", len(rows))
	}
	if rows[0].CreatedAt != 900 || rows[2].CreatedAt != 100 {
		t.Errorf("Rows are not newest first: %v", rows)
	}
}

func TestRangeStoreMergesOverlappingWindows(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("sig", Window{Span: Span{From: 100, To: 200}, Rows: []Row{row(150, "a")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Put("sig", Window{Span: Span{From: 200, To: 300}, Rows: []Row{row(250, "b")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	covered := s.Covered("sig")
	if len(covered) != 1 || covered[0].From != 100 || covered[0].To != 300 {
		t.Errorf("Covered = %v, want one span of 100 to 300", covered)
	}
	rows := s.Rows("sig", 100, 300)
	if len(rows) != 2 {
		t.Errorf("Rows = %d, want 2", len(rows))
	}
}

func TestRangeStoreDropsDuplicateRows(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("sig", Window{Span: Span{From: 0, To: 100}, Rows: []Row{row(50, "a")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Put("sig", Window{Span: Span{From: 0, To: 100}, Rows: []Row{row(50, "a")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if rows := s.Rows("sig", 0, 100); len(rows) != 1 {
		t.Errorf("Rows = %d, want 1 after de-duplication", len(rows))
	}
}

func TestRangeStoreKeepsSignaturesApart(t *testing.T) {
	s := NewRangeStore(newTestDB(t))
	if err := s.Put("one", Window{Span: Span{From: 0, To: 100}, Rows: []Row{row(50, "a")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if missing := s.Missing("two", 0, 100); len(missing) != 1 {
		t.Errorf("a different signature must not see the stored rows")
	}
}

func TestRangeStoreSurvivesAReopen(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	s := NewRangeStore(db)
	if err := s.Put("sig", Window{Span: Span{From: 10, To: 20}, Rows: []Row{row(15, "a")}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	db.Close()

	db2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()
	s2 := NewRangeStore(db2)
	if covered := s2.Covered("sig"); len(covered) != 1 {
		t.Errorf("Covered = %v, want the stored window", covered)
	}
	if rows := s2.Rows("sig", 0, 100); len(rows) != 1 {
		t.Errorf("Rows = %d, want 1", len(rows))
	}
}

func TestMissingSpans(t *testing.T) {
	cases := []struct {
		covered []Span
		from    int64
		to      int64
		want    []Span
	}{
		{nil, 0, 100, []Span{{0, 100}}},
		{[]Span{{0, 100}}, 0, 100, nil},
		{[]Span{{0, 100}}, 50, 150, []Span{{101, 150}}},
		{[]Span{{50, 100}}, 0, 100, []Span{{0, 49}}},
		{[]Span{{0, 100}, {200, 300}}, 0, 300, []Span{{101, 199}}},
		{[]Span{{0, 1000}}, 0, 100, nil},
	}
	for _, c := range cases {
		got := missingSpans(c.covered, c.from, c.to)
		if len(got) != len(c.want) {
			t.Errorf("missingSpans(%v, %d, %d) = %v, want %v", c.covered, c.from, c.to, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("missingSpans(%v, %d, %d)[%d] = %v, want %v", c.covered, c.from, c.to, i, got[i], c.want[i])
			}
		}
	}
}
