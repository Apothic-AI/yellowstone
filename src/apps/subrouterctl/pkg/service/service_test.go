package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeSite answers the envelope every /api endpoint returns.
func fakeSite(t *testing.T, data string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":` + data + `}`))
	}))
	t.Cleanup(server.Close)
	return server
}

func dispatch(t *testing.T, method, params string, opts *Options) Response {
	t.Helper()
	req := Request{Method: method, Options: opts}
	if params != "" {
		req.Params = json.RawMessage(params)
	}
	return Dispatch(t.Context(), req)
}

func TestUnknownMethod(t *testing.T) {
	resp := dispatch(t, "nope", "", nil)
	if resp.OK {
		t.Fatal("the call should have failed")
	}
	if resp.Error == nil || resp.Error.Type != "unknown_method" {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
}

func TestInvalidParameters(t *testing.T) {
	resp := dispatch(t, "token.show", `{"id":"abc"}`, nil)
	if resp.OK {
		t.Fatal("the call should have failed")
	}
	if resp.Error == nil || resp.Error.Type != "invalid_params" {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
}

func TestMissingParameter(t *testing.T) {
	resp := dispatch(t, "token.show", `{}`, nil)
	if resp.OK {
		t.Fatal("the call should have failed")
	}
	if resp.Error == nil || resp.Error.Type != "invalid_params" {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
}

func TestMethodsAreListed(t *testing.T) {
	names := Methods()
	if len(names) < 40 {
		t.Fatalf("only %d methods are registered", len(names))
	}
	for _, want := range []string{"account.info", "usage.logs", "token.create", "model.list", "raw"} {
		found := false
		for _, name := range names {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("the method %q is missing", want)
		}
	}
}

// TestTheProtocolReachesTheServer checks that a request travels from the
// dispatcher to the platform and that the answer comes back.
func TestTheProtocolReachesTheServer(t *testing.T) {
	site := fakeSite(t, `{"id":10001,"username":"demo-user"}`)
	resp := dispatch(t, "account.info", "", &Options{
		BaseURL:     site.URL,
		AccessToken: "token",
		UserID:      10001,
		CacheDir:    t.TempDir(),
	})
	if !resp.OK {
		t.Fatalf("the call failed: %+v", resp.Error)
	}
	var user struct {
		ID       int    `json:"id"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(resp.Result, &user); err != nil {
		t.Fatalf("cannot read the result: %v", err)
	}
	if user.ID != 10001 || user.Username != "demo-user" {
		t.Fatalf("unexpected result: %+v", user)
	}
}

// TestTheOptionsTravel checks that the options of a request reach the
// client.
func TestTheOptionsTravel(t *testing.T) {
	site := fakeSite(t, `{"ok":true}`)
	client, err := NewClient(Options{BaseURL: site.URL, AccessToken: "t", UserID: 1, CacheDir: t.TempDir()})
	if err != nil {
		t.Fatalf("cannot build the client: %v", err)
	}
	if client.Options.BaseURL != site.URL {
		t.Fatalf("the base url was not taken: %q", client.Options.BaseURL)
	}
	if client.Options.AccessToken != "t" {
		t.Fatalf("the token was not taken: %q", client.Options.AccessToken)
	}
}

// TestTokenSpecNeedsAKind checks the guards of the token methods.
func TestTokenSpecNeedsAKind(t *testing.T) {
	resp := dispatch(t, "token.create", `{"name":"x"}`, &Options{CacheDir: t.TempDir()})
	if resp.OK {
		t.Fatal("the call should have failed")
	}
	if resp.Error == nil || resp.Error.Type != "invalid_params" {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
}

// TestAFixedKeyNeedsAProvider checks the guard of the fixed kind.
func TestAFixedKeyNeedsAProvider(t *testing.T) {
	resp := dispatch(t, "token.create", `{"kind":"fixed"}`, &Options{CacheDir: t.TempDir()})
	if resp.OK {
		t.Fatal("the call should have failed")
	}
	if resp.Error == nil || resp.Error.Type != "invalid_params" {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
}

// TestTheTokenTypesAreStatic checks a method that needs no account.
func TestTheTokenTypesAreStatic(t *testing.T) {
	resp := dispatch(t, "token.types", "", &Options{CacheDir: t.TempDir()})
	if !resp.OK {
		t.Fatalf("the call failed: %+v", resp.Error)
	}
	var entries []struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(resp.Result, &entries); err != nil {
		t.Fatalf("cannot read the result: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("expected four kinds, got %d", len(entries))
	}
	if entries[0].Kind != "smart" {
		t.Fatalf("unexpected kind: %q", entries[0].Kind)
	}
}

// TestTheRawEscapeHatch checks that an endpoint without a method stays
// reachable.
func TestTheRawEscapeHatch(t *testing.T) {
	site := fakeSite(t, `{"username":"demo-user"}`)
	resp := dispatch(t, "raw", `{"method":"GET","path":"/api/user/self"}`, &Options{
		BaseURL:     site.URL,
		AccessToken: "t",
		UserID:      1,
		CacheDir:    t.TempDir(),
	})
	if !resp.OK {
		t.Fatalf("the call failed: %+v", resp.Error)
	}
	if string(resp.Result) != `{"username":"demo-user"}` {
		t.Fatalf("unexpected result: %s", resp.Result)
	}
}
