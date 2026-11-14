package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Apothic-AI/subrouterctl/pkg/cache"
)

const sampleTokenKey = "oSnBqW3rK9mXtZ2pL7vY4nB6cH8jF1dG5sA0eU2iO4kQwErTyUiOpAsDfGhJkLzXc"

func TestRedactSecretsRemovesTheKeyMaterial(t *testing.T) {
	in := []byte(`{"success":true,"message":"","data":{"id":401019,"name":"demo-fixed","group":"provider:demo",` +
		`"key":"` + sampleTokenKey + `","status":1,"used_quota":42}}`)
	out := redactSecrets(in)

	if strings.Contains(string(out), sampleTokenKey) {
		t.Fatalf("the key survived the redaction:\n%s", out)
	}
	var doc struct {
		Data struct {
			ID     int    `json:"id"`
			Name   string `json:"name"`
			Group  string `json:"group"`
			Key    string `json:"key"`
			Status int    `json:"status"`
			Quota  int64  `json:"used_quota"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("the redacted body no longer decodes: %v\n%s", err, out)
	}
	if doc.Data.ID != 401019 || doc.Data.Name != "demo-fixed" || doc.Data.Group != "provider:demo" {
		t.Errorf("the rest of the record was changed: %+v", doc.Data)
	}
	if doc.Data.Status != 1 || doc.Data.Quota != 42 {
		t.Errorf("the numbers were changed: %+v", doc.Data)
	}
	if len(doc.Data.Key) != len(sampleTokenKey) {
		t.Errorf("the placeholder is %d characters, want %d", len(doc.Data.Key), len(sampleTokenKey))
	}
	if strings.Trim(doc.Data.Key, "*") != "" {
		t.Errorf("the placeholder is not all stars: %q", doc.Data.Key)
	}
}

func TestRedactSecretsReachesIntoLists(t *testing.T) {
	in := []byte(`{"success":true,"data":{"items":[{"id":1,"key":"` + sampleTokenKey + `"},` +
		`{"id":2,"key":"` + sampleTokenKey + `"}],"total":2}}`)
	out := redactSecrets(in)
	if strings.Contains(string(out), sampleTokenKey) {
		t.Fatalf("the key survived the redaction:\n%s", out)
	}
	if !strings.Contains(string(out), `"total":2`) {
		t.Errorf("the rest of the payload was lost:\n%s", out)
	}
}

func TestRedactSecretsLeavesShortKeysAlone(t *testing.T) {
	// A key name is short. Redacting it would throw away information that
	// is not secret.
	in := []byte(`{"success":true,"data":{"token_name":"demo-fixed","key":"short","n":7}}`)
	out := redactSecrets(in)
	if !strings.Contains(string(out), `"key":"short"`) {
		t.Errorf("a short key field was redacted:\n%s", out)
	}
	if !strings.Contains(string(out), `"token_name":"demo-fixed"`) {
		t.Errorf("the rest of the payload was lost:\n%s", out)
	}
}

func TestRedactSecretsLeavesCleanBodiesAlone(t *testing.T) {
	in := []byte(`{"success":true,"data":{"id":1,"name":"demo"}}`)
	out := redactSecrets(in)
	if string(out) != string(in) {
		t.Errorf("a body without secrets was rewritten:\ngot  %s\nwant %s", out, in)
	}
}

func TestRedactSecretsLeavesBodiesItCannotReadAlone(t *testing.T) {
	in := []byte("not json at all")
	if out := redactSecrets(in); string(out) != string(in) {
		t.Errorf("a body that is not JSON was rewritten: %s", out)
	}
}

func TestTheCacheNeverHoldsTheKey(t *testing.T) {
	cl, _ := testClient(t, time.Minute, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{"id":7,"name":"demo-fixed","key":"` + sampleTokenKey + `"}}`))
	})

	// The caller gets the real key.
	var got struct {
		Key string `json:"key"`
	}
	if err := cl.Get(context.Background(), "/api/token/7", nil, &got); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Key != sampleTokenKey {
		t.Fatalf("the caller got %q, want the real key", got.Key)
	}

	// The cache does not.
	raw, ok := cl.Cache.GetAny(cacheKeyFor(t, cl, "/api/token/7"))
	if !ok {
		t.Fatal("the response was not written to the cache")
	}
	if strings.Contains(string(raw), sampleTokenKey) {
		t.Errorf("the cache holds the key:\n%s", raw)
	}
}

// cacheKeyFor recomputes the cache key of a request so a test can read the
// entry back.
func cacheKeyFor(t *testing.T, cl *Client, path string) string {
	t.Helper()
	return cache.Key(cl.Scope(AuthManagement), http.MethodGet, path, "")
}
