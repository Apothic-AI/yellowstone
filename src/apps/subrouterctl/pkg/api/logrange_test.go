package api

import (
	"context"
	"fmt"
	"math"
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

// typedLogServer serves usage logs filtered by type. One second holds a billed
// row and an error row that share a request id, the pair that an unfiltered
// pull used to keep only half of.
func typedLogServer(t *testing.T, hits *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*hits++
		from, _ := strconv.ParseInt(r.URL.Query().Get("start_timestamp"), 10, 64)
		to, _ := strconv.ParseInt(r.URL.Query().Get("end_timestamp"), 10, 64)
		wantType, _ := strconv.Atoi(r.URL.Query().Get("type"))
		rows := []struct {
			at         int64
			typ        int
			requestID  string
			quota      int
			prompt     int
			completion int
		}{
			{1200, 2, "req-a", 100, 10, 2},
			{1500, 5, "req-pair", 0, 11, 0},
			{1500, 2, "req-pair", 5005, 1345677, 269},
			{1800, 5, "req-b", 0, 12, 1},
		}
		items := []string{}
		for _, x := range rows {
			if x.at < from || x.at > to {
				continue
			}
			if wantType > 0 && x.typ != wantType {
				continue
			}
			items = append(items, fmt.Sprintf(
				`{"id":1,"created_at":%d,"type":%d,"request_id":%q,"token_name":"k","model_name":"m","quota":%d,"prompt_tokens":%d,"completion_tokens":%d}`,
				x.at, x.typ, x.requestID, x.quota, x.prompt, x.completion))
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"success":true,"data":{"items":[%s],"has_more":false,"next_cursor":"","total":%d}}`,
			joinJSON(items), len(items))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestGetLogRangeKeepsABilledRowThatSharesItsSecondWithAnError(t *testing.T) {
	hits := 0
	srv := typedLogServer(t, &hits)
	cl := rangeClient(t, srv)
	window := func(logType int) LogQuery {
		return LogQuery{Type: logType, StartTimestamp: 1000, EndTimestamp: 2000}
	}
	quota := func(rows []LogEntry) float64 {
		total := 0.0
		for _, row := range rows {
			total += row.Quota
		}
		return total
	}
	pair := func(rows []LogEntry) (billed, errored bool) {
		for _, row := range rows {
			if row.RequestID != "req-pair" {
				continue
			}
			switch row.Type {
			case 2:
				billed = true
			case 5:
				errored = true
			}
		}
		return billed, errored
	}

	all, err := cl.GetLogRange(context.Background(), window(0))
	if err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	billed, errored := pair(all)
	if !billed || !errored {
		t.Fatalf("the unfiltered pull dropped part of the billed+error pair: %d rows", len(all))
	}

	two, err := cl.GetLogRange(context.Background(), window(2))
	if err != nil {
		t.Fatalf("GetLogRange type 2: %v", err)
	}
	five, err := cl.GetLogRange(context.Background(), window(5))
	if err != nil {
		t.Fatalf("GetLogRange type 5: %v", err)
	}

	// The unfiltered pull is the union of the per-type pulls, row for row.
	if len(all) != len(two)+len(five) {
		t.Errorf("unfiltered rows = %d, want %d from types 2 and 5", len(all), len(two)+len(five))
	}
	if got, want := quota(all), quota(two)+quota(five); math.Abs(got-want) > 1e-9 {
		t.Errorf("unfiltered quota = %g, want %g from types 2 and 5", got, want)
	}

	// The second call is served from disk. The row identity that the merge
	// and the cache use must keep both rows of the pair there too.
	before := hits
	again, err := cl.GetLogRange(context.Background(), window(0))
	if err != nil {
		t.Fatalf("GetLogRange: %v", err)
	}
	if hits != before {
		t.Errorf("the covered range was fetched again: %d requests", hits-before)
	}
	billed, errored = pair(again)
	if !billed || !errored || len(again) != len(all) {
		t.Errorf("the cached pull lost the billed+error pair: %d rows, billed=%v errored=%v", len(again), billed, errored)
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
