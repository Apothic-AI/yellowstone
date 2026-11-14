// Package service exposes the SubRouter client as a machine interface.
//
// The command line tool, the TypeScript binding and the Python binding all
// sit on this package. It owns the request and response shapes, the
// credential resolution and the dispatch table, so that all three front ends
// behave identically.
//
// The transports around it stay deliberately thin:
//
//	bridge/cgo   a C ABI, for an in-process binding
//	bridge/ipc   a stdio server, for a persistent child process
//
// Every call is one JSON object in and one JSON object out. Nothing about
// the command line surface leaks into the protocol.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Apothic-AI/subrouterctl/pkg/api"
	"github.com/Apothic-AI/subrouterctl/pkg/cache"
	"github.com/Apothic-AI/subrouterctl/pkg/config"
)

// Options configures a client.
//
// Every field is optional. An empty field falls back to the environment,
// then to the credential file, then to the built-in default, exactly like
// the command line tool.
type Options struct {
	BaseURL        string  `json:"base_url,omitempty"`
	AccessToken    string  `json:"access_token,omitempty"`
	APIKey         string  `json:"api_key,omitempty"`
	UserID         int     `json:"user_id,omitempty"`
	TimeoutSeconds int     `json:"timeout_seconds,omitempty"`
	CacheDir       string  `json:"cache_dir,omitempty"`
	CacheTTLMillis int64   `json:"cache_ttl_ms,omitempty"`
	QuotaPerUnit   float64 `json:"quota_per_unit,omitempty"`
	CredentialPath string  `json:"credential_path,omitempty"`
}

// Request is one call.
type Request struct {
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	Options *Options        `json:"options,omitempty"`
	// ID is echoed back in the response. It lets a client keep several
	// calls in flight over a stream.
	ID string `json:"id,omitempty"`
}

// Response is the answer to one call.
//
// A failed call carries an error and no result. A successful call carries
// the result and, when the cache answered instead of the network, one or
// more notices.
type Response struct {
	OK      bool            `json:"ok"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
	Notices []string        `json:"notices,omitempty"`
	// ID is the id of the request this response belongs to.
	ID string `json:"id,omitempty"`
}

// Error describes a failed call.
type Error struct {
	Message string `json:"message"`
	Type    string `json:"type,omitempty"`
	Status  int    `json:"status,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// Client is a SubRouter client bound to one set of options.
type Client struct {
	// Options are the resolved options this client runs with.
	Options Options
	// API is the underlying HTTP client.
	API *api.Client

	mu      sync.Mutex
	notices []string
}

// NewClient builds a client. The options are resolved against the
// environment and the credential file, so an empty Options works on a
// machine that has already run the device authorization.
func NewClient(opts Options) (*Client, error) {
	resolved, err := opts.resolve()
	if err != nil {
		return nil, err
	}

	c := &Client{Options: resolved}
	cl := api.New(resolved.BaseURL, resolved.AccessToken, resolved.UserID, resolved.APIKey,
		time.Duration(resolved.TimeoutSeconds)*time.Second)

	db, err := openCache(resolved.CacheDir)
	if err != nil {
		// A cache that cannot be opened is not fatal: the client works
		// without it, and says so.
		c.addNotice("the cache is not in use: " + err.Error())
	} else {
		cl.Cache = cache.New(db, time.Duration(resolved.CacheTTLMillis)*time.Millisecond)
		cl.LogRanges = cache.NewRangeStore(db)
	}
	cl.CacheNotice = c.addNotice
	c.API = cl
	return c, nil
}

// Notice records a message for the caller, such as a cache notice.
func (c *Client) addNotice(msg string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.notices = append(c.notices, msg)
}

// Notices returns the messages collected during the last call.
func (c *Client) Notices() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.notices...)
}

// resolve merges the options with the environment and the credential file.
func (o Options) resolve() (Options, error) {
	creds, err := config.LoadCredentials(o.CredentialPath)
	if err != nil {
		return o, err
	}
	out := o
	out.BaseURL = strings.TrimRight(firstNonEmpty(o.BaseURL, os.Getenv("SUBROUTER_BASE_URL"),
		creds.BaseURL, config.DefaultBaseURL), "/")
	out.AccessToken = firstNonEmpty(o.AccessToken, os.Getenv("SUBROUTER_ACCESS_TOKEN"), creds.AccessToken)
	out.APIKey = firstNonEmpty(o.APIKey, os.Getenv("SUBROUTER_API_KEY"), creds.Key)

	if out.UserID == 0 {
		if s := os.Getenv("SUBROUTER_USER_ID"); s != "" {
			if v, err := strconv.Atoi(s); err == nil {
				out.UserID = v
			}
		}
	}
	if out.UserID == 0 {
		out.UserID = creds.UserID
	}
	if out.TimeoutSeconds <= 0 {
		out.TimeoutSeconds = 60
	}
	if out.CredentialPath == "" {
		out.CredentialPath = config.CredentialPath()
	}
	if out.CacheDir == "" {
		out.CacheDir = config.DefaultCacheDir()
	}
	out.QuotaPerUnit = config.ResolveQuotaPerUnit(o.QuotaPerUnit)
	return out, nil
}

// cacheMu guards the cache databases, which are shared by every client in
// the process so that the SQLite handle and the connection pool stay warm.
var (
	cacheMu  sync.Mutex
	cacheDBs = map[string]*cache.DB{}
)

func openCache(dir string) (*cache.DB, error) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if db, ok := cacheDBs[dir]; ok {
		return db, nil
	}
	db, err := cache.Open(dir)
	if err != nil {
		return nil, err
	}
	cacheDBs[dir] = db
	return db, nil
}

// CloseCaches closes every cache database this process opened.
func CloseCaches() error {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	var first error
	for dir, db := range cacheDBs {
		if err := db.Close(); err != nil && first == nil {
			first = err
		}
		delete(cacheDBs, dir)
	}
	return first
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// handler serves one method.
type handler func(ctx context.Context, c *Client, params json.RawMessage) (any, error)

// params adapts a typed handler to the dispatch table.
func params[T any](fn func(ctx context.Context, c *Client, p T) (any, error)) handler {
	return func(ctx context.Context, c *Client, raw json.RawMessage) (any, error) {
		var p T
		if len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, &Error{Message: fmt.Sprintf("invalid parameters: %v", err), Type: "invalid_params"}
			}
		}
		return fn(ctx, c, p)
	}
}

// Dispatch runs one request and never panics.
func Dispatch(ctx context.Context, req Request) (resp Response) {
	defer func() {
		if r := recover(); r != nil {
			resp = Response{OK: false, Error: &Error{Message: fmt.Sprintf("panic: %v", r), Type: "panic"}}
		}
	}()

	h, ok := registry[req.Method]
	if !ok {
		return Response{OK: false, Error: &Error{
			Message: fmt.Sprintf("unknown method %q", req.Method),
			Type:    "unknown_method",
		}}
	}

	var opts Options
	if req.Options != nil {
		opts = *req.Options
	}
	c, err := NewClient(opts)
	if err != nil {
		return Response{OK: false, Error: &Error{Message: err.Error(), Type: "config"}}
	}

	result, err := h(ctx, c, req.Params)
	if err != nil {
		return failure(err)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return Response{OK: false, Error: &Error{Message: err.Error(), Type: "encode"}}
	}
	return Response{OK: true, Result: raw, Notices: c.Notices()}
}

// failure turns an error into a response.
func failure(err error) Response {
	if e, ok := err.(*Error); ok {
		return Response{OK: false, Error: e}
	}
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		return Response{OK: false, Error: &Error{
			Message: apiErr.Error(),
			Type:    "api",
			Status:  apiErr.Status,
		}}
	}
	return Response{OK: false, Error: &Error{Message: err.Error(), Type: "error"}}
}

// Methods lists the method names the protocol understands.
func Methods() []string {
	names := make([]string, 0, len(registry))
	for name := range registry {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
