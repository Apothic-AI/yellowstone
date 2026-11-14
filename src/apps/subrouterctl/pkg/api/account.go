package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Apothic-AI/subrouterctl/pkg/cache"
)

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

// GetStatus returns the public site configuration (GET /api/status).
func (c *Client) GetStatus(ctx context.Context) (*SiteStatus, error) {
	var s SiteStatus
	if err := c.GetPublic(ctx, "/api/status", nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// GetNodeStatus returns the health of the platform nodes (GET /api/node-status).
func (c *Client) GetNodeStatus(ctx context.Context) (any, error) {
	var v any
	if err := c.GetPublic(ctx, "/api/node-status", nil, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

// GetUser returns the current account (GET /api/user/self).
func (c *Client) GetUser(ctx context.Context) (*User, error) {
	var u User
	if err := c.Get(ctx, "/api/user/self", nil, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// UpdateUser changes the account profile (PUT /api/user/self).
func (c *Client) UpdateUser(ctx context.Context, body map[string]any) (*User, error) {
	var u User
	if err := c.Put(ctx, "/api/user/self", body, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// GetTopupInfo returns the available top-up methods (GET /api/user/topup/info).
func (c *Client) GetTopupInfo(ctx context.Context) (*TopupInfo, error) {
	var t TopupInfo
	if err := c.Get(ctx, "/api/user/topup/info", nil, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// GetTopups returns the top-up history (GET /api/user/topup/self).
func (c *Client) GetTopups(ctx context.Context, page, pageSize int) ([]TopupRecord, error) {
	var raw json.RawMessage
	err := c.Get(ctx, "/api/user/topup/self", Params{"p": page, "page_size": pageSize}, &raw)
	if err != nil {
		return nil, err
	}
	var out []TopupRecord
	if err := DecodeList(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RedeemVoucher redeems a voucher code the account already owns.
// It tries the current route first and falls back to the legacy route.
func (c *Client) RedeemVoucher(ctx context.Context, code string) (string, error) {
	body := map[string]any{"key": code}
	var lastErr error
	for _, path := range []string{"/api/user/self/topup", "/api/user/topup"} {
		var out any
		err := c.Post(ctx, path, body, &out)
		if err == nil {
			return fmt.Sprintf("voucher %s redeemed", code), nil
		}
		lastErr = err
	}
	return "", lastErr
}

// GetNotifications returns the account notification feed.
func (c *Client) GetNotifications(ctx context.Context, page, pageSize int) (any, error) {
	var out any
	err := c.Get(ctx, "/api/user/self/notifications", Params{"p": page, "page_size": pageSize}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Affiliate / referral
// ---------------------------------------------------------------------------

// GetAffSummary returns the referral invite code (GET /api/user/aff). The
// endpoint answers with the plain code string.
func (c *Client) GetAffSummary(ctx context.Context) (*AffSummary, error) {
	var code string
	if err := c.Get(ctx, "/api/user/aff", nil, &code); err != nil {
		return nil, err
	}
	return &AffSummary{AffCode: code}, nil
}

// GetAffEarningTotals folds the referral earnings rows into totals.
func (c *Client) GetAffEarningTotals(ctx context.Context) (invites int, quota float64, commission float64, err error) {
	var rows []struct {
		Quota           float64 `json:"quota"`
		CommissionQuota float64 `json:"commission_quota"`
	}
	if err := c.Get(ctx, "/api/user/aff_earnings", nil, &rows); err != nil {
		return 0, 0, 0, err
	}
	for _, r := range rows {
		quota += r.Quota
		commission += r.CommissionQuota
	}
	return len(rows), quota, commission, nil
}

// GetAffEarnings returns detailed referral earnings (GET /api/user/aff_earnings).
func (c *Client) GetAffEarnings(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/user/aff_earnings", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetAffPayouts returns referral payout history (GET /api/user/aff_payouts).
func (c *Client) GetAffPayouts(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/user/aff_payouts", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// TransferAff moves referral earnings into the usable balance.
// quota is in internal quota units, where 500000 equals 1 USD.
func (c *Client) TransferAff(ctx context.Context, quota float64) (any, error) {
	var out any
	err := c.Post(ctx, "/api/user/aff_transfer", map[string]any{"quota": quota}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

// LogQuery holds the filters accepted by the usage log endpoints.
type LogQuery struct {
	Cursor            string
	PageSize          int
	Type              int
	TokenName         string
	ModelName         string
	Username          string
	Group             string
	RequestID         string
	UpstreamRequestID string
	StartTimestamp    int64
	EndTimestamp      int64
}

// Params renders the query as request parameters. A zero Type is omitted so
// the server default applies.
func (q LogQuery) Params() Params {
	p := Params{}
	if q.Cursor != "" {
		p["cursor"] = q.Cursor
	}
	if q.PageSize > 0 {
		p["page_size"] = q.PageSize
	}
	if q.Type > 0 {
		p["type"] = q.Type
	}
	if q.TokenName != "" {
		p["token_name"] = q.TokenName
	}
	if q.ModelName != "" {
		p["model_name"] = q.ModelName
	}
	if q.Username != "" {
		p["username"] = q.Username
	}
	if q.Group != "" {
		p["group"] = q.Group
	}
	if q.RequestID != "" {
		p["request_id"] = q.RequestID
	}
	if q.UpstreamRequestID != "" {
		p["upstream_request_id"] = q.UpstreamRequestID
	}
	if q.StartTimestamp > 0 {
		p["start_timestamp"] = q.StartTimestamp
	}
	if q.EndTimestamp > 0 {
		p["end_timestamp"] = q.EndTimestamp
	}
	return p
}

// LogPage is one page of usage logs.
type LogPage struct {
	Items      []LogEntry `json:"items"`
	HasMore    bool       `json:"has_more"`
	NextCursor string     `json:"next_cursor"`
	PageSize   int        `json:"page_size"`
}

// Signature identifies a log query by its filters, ignoring the time window.
func (q LogQuery) Signature() string {
	return strings.Join([]string{
		strconv.Itoa(q.Type),
		q.TokenName, q.ModelName, q.Username, q.Group, q.RequestID, q.UpstreamRequestID,
	}, "\x00")
}

// logSignature identifies a log query inside the cache. It adds the scope of
// the account, so the logs of one account are never served to another.
func (c *Client) logSignature(q LogQuery) string {
	return c.Scope(AuthManagement) + "|" + q.Signature()
}

// GetLogs returns a page of usage logs (GET /api/log/self).
func (c *Client) GetLogs(ctx context.Context, q LogQuery) (*LogPage, error) {
	var p LogPage
	if err := c.Get(ctx, "/api/log/self", q.Params(), &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// logPageRaw is one page of usage logs with the items left as raw JSON, so
// that nothing is lost when a page is filed in the cache.
type logPageRaw struct {
	items      []json.RawMessage
	hasMore    bool
	nextCursor string
	// total is the number of rows the platform counts for the range. It is
	// used to tell a complete walk from a truncated one.
	total int
}

// getLogPageRaw fetches one page of raw log items.
//
// The request skips the key/value cache: the range store owns the log rows,
// and a page that was served from the key/value cache would file a stale
// range as if it had been fetched.
func (c *Client) getLogPageRaw(ctx context.Context, q LogQuery) (logPageRaw, error) {
	raw, err := c.doRaw(ctx, "GET", "/api/log/self", q.Params(), nil, AuthManagement, false)
	if err != nil {
		return logPageRaw{}, err
	}
	var env struct {
		Data struct {
			Items      []json.RawMessage `json:"items"`
			HasMore    bool              `json:"has_more"`
			NextCursor string            `json:"next_cursor"`
			Total      int               `json:"total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return logPageRaw{}, err
	}
	return logPageRaw{env.Data.Items, env.Data.HasMore, env.Data.NextCursor, env.Data.Total}, nil
}

// maxLogPages is the page limit for one log range. It keeps a cursor that
// never ends from looping forever.
const maxLogPages = 2000

// MaxLogPageSize is the largest page the log endpoint serves.
const MaxLogPageSize = 100

// GetLogRange returns every log row that falls inside the requested window.
//
// The parts of the window that the range store already holds are served from
// disk. The parts it does not hold are fetched from the API and added, so a
// cached range never hides newer rows.
func (c *Client) GetLogRange(ctx context.Context, q LogQuery) ([]LogEntry, error) {
	if c.LogRanges == nil || !c.LogRanges.Enabled() || q.StartTimestamp <= 0 || q.EndTimestamp <= 0 {
		return nil, nil
	}
	sig := c.logSignature(q)
	spans := c.LogRanges.Missing(sig, q.StartTimestamp, q.EndTimestamp)

	// The gaps are cut into chunks that are fetched side by side, so a
	// wide range does not turn into one long serial walk.
	var chunks []cache.Span
	for _, span := range spans {
		chunks = append(chunks, chunkSpan(span, logChunkSeconds)...)
	}
	rows, errs := fetchLogChunks(ctx, chunks, func(ctx context.Context, sp cache.Span) ([]cache.Row, error) {
		return c.fetchLogSpan(ctx, q, sp.From, sp.To)
	})

	// A chunk that cannot be fetched does not invalidate the chunks that
	// can. The rows already on disk are still served, and the failure is
	// reported so the caller can warn about the gap.
	var fetchErr error
	for i, chunk := range chunks {
		if errs[i] != nil {
			if fetchErr == nil {
				fetchErr = errs[i]
			}
			continue
		}
		if err := c.LogRanges.Put(sig, cache.Window{Span: settled(chunk), Rows: rows[i]}); err != nil && fetchErr == nil {
			// The rows were fetched, so they are shown even when they
			// could not be written to the cache.
			fetchErr = fmt.Errorf("cache the log range: %w", err)
		}
	}

	// The rows that are shown are the ones on disk plus the ones that were
	// just fetched, so a chunk that could not be written to the cache is
	// still shown.
	cached := c.LogRanges.Rows(sig, q.StartTimestamp, q.EndTimestamp)
	out := make([]LogEntry, 0, len(cached))
	seen := make(map[string]bool, len(cached))
	add := func(row cache.Row) {
		var e LogEntry
		if err := json.Unmarshal(row.Data, &e); err != nil {
			return
		}
		key := logRowKey(e, row.Data)
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, e)
	}
	for _, row := range cached {
		add(row)
	}
	for _, chunkRows := range rows {
		for _, row := range chunkRows {
			add(row)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, fetchErr
}

// settled returns the span that a fetched chunk may be filed as covered.
//
// A chunk that reaches into the present is left open for a while: the rows
// of the requests that were still running when it was fetched are written
// later, and the next run has to fetch them again.
func settled(chunk cache.Span) cache.Span {
	limit := time.Now().Unix() - logSettleSeconds
	if chunk.To > limit {
		return cache.Span{From: chunk.From, To: limit}
	}
	return chunk
}

// logRowKey identifies a log row, so that the same row is not shown twice.
func logRowKey(e LogEntry, raw []byte) string {
	if e.RequestID == "" {
		sum := sha256.Sum256(raw)
		return strconv.FormatInt(e.CreatedAt, 10) + "\x00" + hex.EncodeToString(sum[:])[:16]
	}
	return strconv.FormatInt(e.CreatedAt, 10) + "\x00" + e.RequestID
}

// logChunkSeconds is the size of one parallel log fetch.
const logChunkSeconds = 24 * 60 * 60

// logWorkers is how many log chunks are fetched at the same time.
const logWorkers = 6

// logSettleSeconds is how long a fetched range is left open.
//
// A usage log row is written when the request that it describes is over, so
// a request that is still running has no row yet. A range that ends at the
// present is therefore only filed as covered up to this many seconds in the
// past, which keeps the rows of the requests that were in flight at that
// moment from falling into a hole.
const logSettleSeconds = 600

// fetchLogChunks fetches the chunks of a log range side by side with a
// bounded worker pool. Every chunk keeps its own result and error, so one
// failing chunk does not lose the others.
func fetchLogChunks(ctx context.Context, chunks []cache.Span, fetch func(context.Context, cache.Span) ([]cache.Row, error)) ([][]cache.Row, []error) {
	rows := make([][]cache.Row, len(chunks))
	errs := make([]error, len(chunks))
	if len(chunks) == 0 {
		return rows, errs
	}
	workers := logWorkers
	if workers > len(chunks) {
		workers = len(chunks)
	}
	var wg sync.WaitGroup
	queue := make(chan int)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range queue {
				rows[i], errs[i] = fetch(ctx, chunks[i])
			}
		}()
	}
	for i := range chunks {
		queue <- i
	}
	close(queue)
	wg.Wait()
	return rows, errs
}

// fetchLogSpan downloads every log row inside a time span.
//
// The rows that were read before a failure are returned as well, so a half
// finished chunk still shows what it has.
func (c *Client) fetchLogSpan(ctx context.Context, q LogQuery, from, to int64) ([]cache.Row, error) {
	var rows []cache.Row
	cursor := "first"
	pages := 0
	total := -1
	for {
		qq := q
		qq.Cursor = cursor
		qq.StartTimestamp = from
		qq.EndTimestamp = to
		page, err := c.getLogPageRaw(ctx, qq)
		if err != nil {
			return rows, err
		}
		if total < 0 {
			total = page.total
		}
		for _, item := range page.items {
			var probe struct {
				CreatedAt int64 `json:"created_at"`
			}
			if err := json.Unmarshal(item, &probe); err != nil {
				continue
			}
			if probe.CreatedAt < from || probe.CreatedAt > to {
				continue
			}
			rows = append(rows, cache.Row{CreatedAt: probe.CreatedAt, Data: item})
		}
		if !page.hasMore || page.nextCursor == "" {
			break
		}
		cursor = page.nextCursor
		pages++
		if pages >= maxLogPages {
			// A cursor that never ends would otherwise loop forever.
			return rows, fmt.Errorf("stopped after %d pages of logs in the range %d to %d", maxLogPages, from, to)
		}
	}
	if total >= 0 && len(rows) < total {
		// The platform counts more rows than the walk produced, so the
		// range is not complete. It is not filed as covered, so the next
		// run fetches it again.
		return rows, fmt.Errorf("the range %d to %d holds %d rows, but only %d could be read",
			from, to, total, len(rows))
	}
	return rows, nil
}

// chunkSpan splits a span into pieces the platform will accept.
func chunkSpan(s cache.Span, max int64) []cache.Span {
	if s.To <= s.From {
		return nil
	}
	var out []cache.Span
	from := s.From
	for from < s.To {
		to := from + max
		if to > s.To {
			to = s.To
		}
		out = append(out, cache.Span{From: from, To: to})
		from = to
	}
	return out
}

// GetLogStat returns the usage summary (GET /api/log/self/stat).
func (c *Client) GetLogStat(ctx context.Context, q LogQuery) (*LogStat, error) {
	var s LogStat
	if err := c.Get(ctx, "/api/log/self/stat", q.Params(), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// GetData returns per-day quota usage (GET /api/data/self).
func (c *Client) GetData(ctx context.Context, start, end int64) ([]DataPoint, error) {
	var out []DataPoint
	err := c.Get(ctx, "/api/data/self", Params{"start_timestamp": start, "end_timestamp": end}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ExportLogsURL returns the CSV export URL for the given filters.
func (c *Client) ExportLogsURL(q LogQuery) string {
	return c.BaseURL + "/api/log/self/export" + q.Params().Encode()
}

// ---------------------------------------------------------------------------
// Billing (relay key)
// ---------------------------------------------------------------------------

// GetBillingSubscription reads the wallet summary (GET /v1/dashboard/billing/subscription).
func (c *Client) GetBillingSubscription(ctx context.Context) (any, error) {
	var out any
	if err := c.GetRelay(ctx, "/v1/dashboard/billing/subscription", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetBillingUsage reads the billing usage summary (GET /v1/dashboard/billing/usage).
func (c *Client) GetBillingUsage(ctx context.Context) (any, error) {
	var out any
	if err := c.GetRelay(ctx, "/v1/dashboard/billing/usage", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetRelayModels lists the models reachable with the relay key (GET /v1/models).
// The endpoint answers with a bare array on the OpenAI protocol surface.
func (c *Client) GetRelayModels(ctx context.Context) ([]map[string]any, error) {
	raw, err := c.DoRaw(ctx, "GET", "/v1/models", nil, nil, AuthRelay)
	if err != nil {
		return nil, err
	}
	var direct []map[string]any
	if err := json.Unmarshal(raw, &direct); err == nil {
		return direct, nil
	}
	var resp struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// ---------------------------------------------------------------------------
// Device authorization
// ---------------------------------------------------------------------------

// DeviceAuthRequest is the first leg of the device authorization flow.
type DeviceAuthRequest struct {
	UserCode        string `json:"user_code"`
	DeviceCode      string `json:"device_code"`
	VerificationURL string `json:"verification_url"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

// StartDeviceAuth begins the device authorization flow (POST /api/device_auth).
func (c *Client) StartDeviceAuth(ctx context.Context, channel string) (*DeviceAuthRequest, error) {
	var d DeviceAuthRequest
	err := c.Do(ctx, "POST", "/api/device_auth", nil, map[string]any{"channel": channel}, AuthPublic, &d)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// DeviceAuthPoll is the result of polling the device authorization flow.
type DeviceAuthPoll struct {
	Status      string `json:"status"`
	Key         string `json:"key"`
	AccessToken string `json:"access_token"`
	UserID      int    `json:"user_id"`
	BaseURL     string `json:"base_url"`
	Message     string `json:"message"`
}

// PollDeviceAuth polls the device authorization flow (POST /api/device_auth/poll).
func (c *Client) PollDeviceAuth(ctx context.Context, deviceCode string) (*DeviceAuthPoll, error) {
	var p DeviceAuthPoll
	err := c.Do(ctx, "POST", "/api/device_auth/poll", nil, map[string]any{"device_code": deviceCode}, AuthPublic, &p)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// RawJSON is a helper for commands that print an arbitrary payload.
type RawJSON = json.RawMessage
