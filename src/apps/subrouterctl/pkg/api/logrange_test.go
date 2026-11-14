package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/Apothic-AI/subrouterctl/pkg/cache"
)

// logServer serves usage logs inside the window it is asked for.
func logServer(t *testing.T, hits *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		from, _ := strconv.ParseInt(r.URL.Query().Get("start_timestamp"), 10, 64)
		to, _ := strconv.ParseInt(r.URL.Query().Get("end_timestamp"), 10, 64)
		items := []string{}
		for ts := from; ts <= to; ts += 100 {
			items = append(items, fmt.Sprintf(
				`{"id":%d,"created_at":%d,"request_id":"req-%d","token_name":"k","model_name":"m"}`,
				ts, ts, ts))
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"success":true,"data":{"items":[%s],"has_more":false,"next_cursor":""}}`,
			joinJSON(items))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// joinJSON joins the items with commas.
func joinJSON(items []string) string {
	out := ""
	for i, s := range items {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}

// rangeClient builds a client with a range store in front of a test server.
func rangeClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	db, err := cache.Open(t.TempDir())
	if err != nil {
		t.Fatalf("cache.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	cl := New(srv.URL, "token", 42, "sk-test", 5*time.Second)
	cl.Cache = cache.New(db, 0)
	cl.LogRanges = cache.NewRangeStore(db)
	return cl
}

func TestGetLogRangeServesACoveredRangeFromDisk(t *testing.T) {
	hits := 0
	srv := logServer(t, &hits)
	cl := rangeClient(t, srv)
	q := LogQuery{StartTimestamp: 1000, EndTimestamp: 2000}

	rows, err := cl.GetLogRange(context.Background(), q)
	if err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	if len(rows) != 11 {
		t.Fatalf("rows = %d, want 11", len(rows))
	}
	if hits == 0 {
		t.Fatal("the first call must reach the network")
	}

	// The range is covered now, so the same call must not reach the
	// network again.
	before := hits
	rows, err = cl.GetLogRange(context.Background(), q)
	if err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	if hits != before {
		t.Errorf("the server was hit %d more times, want 0: a covered range must come from disk", hits-before)
	}
	if len(rows) != 11 {
		t.Errorf("rows = %d, want 11", len(rows))
	}
}

func TestGetLogRangeFetchesOnlyTheMissingPart(t *testing.T) {
	hits := 0
	srv := logServer(t, &hits)
	cl := rangeClient(t, srv)

	if _, err := cl.GetLogRange(context.Background(), LogQuery{StartTimestamp: 1000, EndTimestamp: 2000}); err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	before := hits

	// A wider range: only the new part has to be fetched.
	rows, err := cl.GetLogRange(context.Background(), LogQuery{StartTimestamp: 1000, EndTimestamp: 3000})
	if err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	if hits <= before {
		t.Error("the missing part of the range must be fetched")
	}
	if len(rows) != 21 {
		t.Errorf("rows = %d, want 21", len(rows))
	}
}

func TestGetLogRangeKeepsTheRowsOfAFailedFetch(t *testing.T) {
	hits := 0
	srv := logServer(t, &hits)
	cl := rangeClient(t, srv)

	if _, err := cl.GetLogRange(context.Background(), LogQuery{StartTimestamp: 1000, EndTimestamp: 2000}); err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	// The server goes away. The rows that are on disk are still served and
	// the failure is reported.
	srv.Close()
	rows, err := cl.GetLogRange(context.Background(), LogQuery{StartTimestamp: 1000, EndTimestamp: 3000})
	if err == nil {
		t.Error("the failure must be reported")
	}
	if len(rows) != 11 {
		t.Errorf("rows = %d, want the 11 rows that are on disk", len(rows))
	}
}

func TestGetLogRangeLeavesThePresentOpen(t *testing.T) {
	hits := 0
	srv := logServer(t, &hits)
	cl := rangeClient(t, srv)
	now := time.Now().Unix()
	q := LogQuery{StartTimestamp: now - 3600, EndTimestamp: now}

	if _, err := cl.GetLogRange(context.Background(), q); err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	before := hits
	// The same range is fetched again. The part that reaches into the
	// present is never filed as covered, because a request that was still
	// running has no log row yet.
	if _, err := cl.GetLogRange(context.Background(), q); err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	if hits == before {
		t.Error("the open end of the range must be fetched again")
	}
}

func TestGetLogRangeKeepsAccountsApart(t *testing.T) {
	hits := 0
	srv := logServer(t, &hits)
	cl := rangeClient(t, srv)
	other := *cl
	other.UserID = 43

	if _, err := cl.GetLogRange(context.Background(), LogQuery{StartTimestamp: 1000, EndTimestamp: 2000}); err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	before := hits
	if _, err := other.GetLogRange(context.Background(), LogQuery{StartTimestamp: 1000, EndTimestamp: 2000}); err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	if hits == before {
		t.Error("another account must not read the first account's log range")
	}
}
