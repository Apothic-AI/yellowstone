package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Apothic-AI/subrouterctl/pkg/cache"
)

// testClient builds a client with a cache in front of a test server.
func testClient(t *testing.T, ttl time.Duration, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	db, err := cache.Open(t.TempDir())
	if err != nil {
		t.Fatalf("cache.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	cl := New(srv.URL, "token", 42, "sk-test", 5*time.Second)
	cl.Cache = cache.New(db, ttl)
	cl.retryWait = time.Millisecond
	return cl, srv
}

func TestClientWritesThroughButDoesNotRead(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	// Without a time to live every call goes to the network, but the
	// response is written to the cache on the way through.
	for i := 0; i < 2; i++ {
		if _, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err != nil {
			t.Fatalf("DoRaw: %v", err)
		}
	}
	if hits != 2 {
		t.Errorf("the server was hit %d times, want 2: the cache must not be read without a time to live", hits)
	}
}

func TestClientReadsTheCacheWithATTL(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, time.Minute, func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	for i := 0; i < 2; i++ {
		if _, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err != nil {
			t.Fatalf("DoRaw: %v", err)
		}
	}
	if hits != 1 {
		t.Errorf("the server was hit %d times, want 1: the cache must be read with a time to live", hits)
	}
}

func TestClientFallsBackToTheCacheWhenOffline(t *testing.T) {
	cl, srv := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	body, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement)
	if err != nil {
		t.Fatalf("DoRaw: %v", err)
	}
	if string(body) != `{"success":true,"data":{"n":1}}` {
		t.Fatalf("body = %s", body)
	}

	// The server goes away. The cached response must still be served, and
	// the caller must be told that it came from the cache.
	srv.Close()
	var notice string
	cl.CacheNotice = func(msg string) { notice = msg }
	body, err = cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement)
	if err != nil {
		t.Fatalf("DoRaw offline: %v", err)
	}
	if string(body) != `{"success":true,"data":{"n":1}}` {
		t.Errorf("body = %s, want the cached response", body)
	}
	if notice == "" {
		t.Error("the offline fallback must be reported")
	}
}

func TestClientKeepsAccountsApart(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, time.Minute, func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	if _, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err != nil {
		t.Fatalf("DoRaw: %v", err)
	}

	// A second account on the same site must not read the first one's
	// response.
	other := *cl
	other.UserID = 43
	if _, err := other.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err != nil {
		t.Fatalf("DoRaw: %v", err)
	}
	if hits != 2 {
		t.Errorf("the server was hit %d times, want 2: two accounts must not share a cache entry", hits)
	}
}

func TestClientRetriesWhenThePlatformAsksItToSlowDown(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"success":false,"message":"slow down"}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	body, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement)
	if err != nil {
		t.Fatalf("DoRaw: %v", err)
	}
	if string(body) != `{"success":true,"data":{"n":1}}` {
		t.Errorf("body = %s, want the successful response", body)
	}
	if hits != 3 {
		t.Errorf("the server was hit %d times, want 3", hits)
	}
}

func TestClientGivesUpAfterTooManyRetries(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"success":false,"message":"slow down"}`))
	})
	if _, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err == nil {
		t.Fatal("DoRaw should have failed")
	}
	if hits != 4 {
		t.Errorf("the server was hit %d times, want 4: three retries and no more", hits)
	}
}

func TestClientDecodesAPlainObject(t *testing.T) {
	// The relay surface answers without an envelope.
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"object":"billing_subscription","hard_limit_usd":12.5}`))
	})
	var out map[string]any
	if err := cl.Do(context.Background(), "GET", "/v1/dashboard/billing/subscription", nil, nil, AuthRelay, &out); err != nil {
		t.Fatalf("Do: %v", err)
	}
	if out["object"] != "billing_subscription" {
		t.Errorf("out = %v, want the decoded object", out)
	}
}

func TestClientDecodesAnEnvelope(t *testing.T) {
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"ok","data":{"n":7}}`))
	})
	var out struct {
		N int `json:"n"`
	}
	if err := cl.Do(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement, &out); err != nil {
		t.Fatalf("Do: %v", err)
	}
	if out.N != 7 {
		t.Errorf("out = %v, want n = 7", out)
	}
}

func TestClientNamesTheReasonItFellBack(t *testing.T) {
	var hang atomic.Bool
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		if hang.Load() {
			time.Sleep(200 * time.Millisecond)
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	if _, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err != nil {
		t.Fatalf("DoRaw: %v", err)
	}
	var notice string
	cl.CacheNotice = func(msg string) { notice = msg }

	// The server stops answering, so the request runs out of time. The
	// cached response is served, and the reason says so.
	hang.Store(true)
	cl.HTTP.Timeout = 50 * time.Millisecond
	body, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement)
	if err != nil {
		t.Fatalf("DoRaw: %v", err)
	}
	if string(body) != `{"success":true,"data":{"n":1}}` {
		t.Errorf("body = %s, want the cached response", body)
	}
	if !strings.Contains(notice, "time") {
		t.Errorf("notice = %q, want it to name the timeout", notice)
	}
}

func TestClientNeverCachesAWrite(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, time.Minute, func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"success":true,"data":{"n":1}}`))
	})
	for i := 0; i < 2; i++ {
		if _, err := cl.DoRaw(context.Background(), "POST", "/api/thing", nil, map[string]any{"a": 1}, AuthManagement); err != nil {
			t.Fatalf("DoRaw: %v", err)
		}
	}
	if hits != 2 {
		t.Errorf("the server was hit %d times, want 2: a write must never be cached", hits)
	}
}

func TestClientDoesNotCacheAFailure(t *testing.T) {
	hits := 0
	cl, _ := testClient(t, time.Minute, func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"message":"no"}`))
	})
	for i := 0; i < 2; i++ {
		if _, err := cl.DoRaw(context.Background(), "GET", "/api/thing", nil, nil, AuthManagement); err == nil {
			t.Fatal("DoRaw should have failed")
		}
	}
	if hits != 2 {
		t.Errorf("the server was hit %d times, want 2: a failure must not be cached", hits)
	}
}
