package api

import (
	"context"
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// Merchant (provider / 商家) endpoints
//
// These require the account to hold the provider role. A normal user gets
// HTTP 403 无权进行此操作，权限不足.
// ---------------------------------------------------------------------------

// ProviderSelf is the merchant profile (GET /api/provider/self).
func (c *Client) ProviderSelf(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/provider/self", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateProviderSelf edits the merchant profile (PUT /api/provider/self).
func (c *Client) UpdateProviderSelf(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, "/api/provider/self", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ProviderModelPage is one page of merchant model listings.
type ProviderModelPage struct {
	Items []map[string]any `json:"items"`
	Total int              `json:"total"`
	Page  int              `json:"page"`
}

// ListProviderModels returns the merchant's own listings
// (GET /api/provider/models).
func (c *Client) ListProviderModels(ctx context.Context, page, pageSize int) (*ProviderModelPage, error) {
	var p ProviderModelPage
	err := c.Get(ctx, "/api/provider/models", Params{"page": page, "page_size": pageSize}, &p)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// CreateProviderModel creates a merchant listing (POST /api/provider/models).
func (c *Client) CreateProviderModel(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/provider/models", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateProviderModel updates a merchant listing
// (PUT /api/provider/models/{id}).
func (c *Client) UpdateProviderModel(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/provider/models/%d", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ProviderModelBatch creates, enables, disables or deletes listings in bulk
// (POST /api/provider/models/batch{,-status,-delete}).
func (c *Client) ProviderModelBatch(ctx context.Context, variant string, body map[string]any) (any, error) {
	var out any
	path := "/api/provider/models/batch"
	if variant != "" {
		path += "-" + variant
	}
	if err := c.Post(ctx, path, body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// PreviewProviderModelPrice calculates a price proposal without saving it
// (POST /api/provider/models/price-preview).
func (c *Client) PreviewProviderModelPrice(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/provider/models/price-preview", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetProviderModelRoutes returns the ordered route list of a listing
// (GET /api/provider/models/{id}/routes).
func (c *Client) GetProviderModelRoutes(ctx context.Context, id int) (any, error) {
	var out any
	if err := c.Get(ctx, fmt.Sprintf("/api/provider/models/%d/routes", id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetProviderModelRoutes replaces the ordered route list of a listing
// (PUT /api/provider/models/{id}/routes).
func (c *Client) SetProviderModelRoutes(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/provider/models/%d/routes", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListProviderChannels returns the merchant's channels
// (GET /api/provider/channels).
func (c *Client) ListProviderChannels(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/provider/channels", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateProviderChannel creates a channel (POST /api/provider/channels).
func (c *Client) CreateProviderChannel(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/provider/channels", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateProviderChannel updates a channel (PUT /api/provider/channels/{id}).
func (c *Client) UpdateProviderChannel(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/provider/channels/%d", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteProviderChannel deletes a channel (DELETE /api/provider/channels/{id}).
func (c *Client) DeleteProviderChannel(ctx context.Context, id int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/provider/channels/%d", id), nil)
}

// TestProviderChannel runs a channel health check
// (POST /api/provider/channels/{id}/test).
func (c *Client) TestProviderChannel(ctx context.Context, id int) (any, error) {
	var out any
	if err := c.Post(ctx, fmt.Sprintf("/api/provider/channels/%d/test", id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// FetchProviderChannelModels refreshes the model list of a channel
// (POST /api/provider/channels/{id}/fetch_models).
func (c *Client) FetchProviderChannelModels(ctx context.Context, id int) (any, error) {
	var out any
	if err := c.Post(ctx, fmt.Sprintf("/api/provider/channels/%d/fetch_models", id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ProviderEarnings is the merchant earnings view.
type ProviderEarnings struct {
	Items   []map[string]any `json:"items"`
	Summary map[string]any   `json:"summary"`
	Total   int              `json:"total"`
	HasMore bool             `json:"has_more"`
	NextCur string           `json:"next_cursor"`
}

// ProviderEarningsQuery holds the merchant earnings filters.
type ProviderEarningsQuery struct {
	Cursor        string
	PageSize      int
	StartTime     int64
	EndTime       int64
	ModelName     string
	CallerID      int
	EarningSource string
	LogType       int
	RequestID     string
	TokenName     string
}

// Params renders the earnings query as request parameters.
func (q ProviderEarningsQuery) Params() Params {
	p := Params{"page_size": q.PageSize}
	if q.Cursor != "" {
		p["cursor"] = q.Cursor
	}
	if q.StartTime > 0 {
		p["start_timestamp"] = q.StartTime
	}
	if q.EndTime > 0 {
		p["end_timestamp"] = q.EndTime
	}
	if q.ModelName != "" {
		p["model_name"] = q.ModelName
	}
	if q.CallerID > 0 {
		p["caller_id"] = q.CallerID
	}
	if q.EarningSource != "" {
		p["earning_source"] = q.EarningSource
	}
	if q.LogType > 0 {
		p["type"] = q.LogType
	}
	if q.RequestID != "" {
		p["request_id"] = q.RequestID
	}
	if q.TokenName != "" {
		p["token_name"] = q.TokenName
	}
	return p
}

// GetProviderEarnings returns the merchant earnings list
// (GET /api/provider/earnings).
func (c *Client) GetProviderEarnings(ctx context.Context, q ProviderEarningsQuery) (*ProviderEarnings, error) {
	var e ProviderEarnings
	if err := c.Get(ctx, "/api/provider/earnings", q.Params(), &e); err != nil {
		return nil, err
	}
	return &e, nil
}

// GetProviderEarningsSummary returns the merchant earnings totals
// (GET /api/provider/earnings/summary).
func (c *Client) GetProviderEarningsSummary(ctx context.Context, q ProviderEarningsQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/provider/earnings/summary", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetProviderEarningsFilterSummary returns the filtered merchant totals
// (GET /api/provider/earnings/filter-summary).
func (c *Client) GetProviderEarningsFilterSummary(ctx context.Context, q ProviderEarningsQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/provider/earnings/filter-summary", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetProviderModelBreakdown returns earnings split by model
// (GET /api/provider/earnings/model-breakdown).
func (c *Client) GetProviderModelBreakdown(ctx context.Context, q ProviderEarningsQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/provider/earnings/model-breakdown", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetProviderPayouts returns the merchant payout history
// (GET /api/provider/payouts).
func (c *Client) GetProviderPayouts(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/provider/payouts", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// RegisterProvider applies to become a provider (POST /api/provider/register).
func (c *Client) RegisterProvider(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/provider/register", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Distributor station (分站站长) endpoints
// ---------------------------------------------------------------------------

// DistributorSelf is the station profile (GET /api/distributor/self).
func (c *Client) DistributorSelf(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/self", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateDistributorSelf edits the station profile (PUT /api/distributor/self).
// The endpoint is a partial update: only the supplied keys change.
func (c *Client) UpdateDistributorSelf(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, "/api/distributor/self", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DistributorDashboard returns the station traffic and revenue counters
// (GET /api/distributor/dashboard).
func (c *Client) DistributorDashboard(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/dashboard", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorModels returns the station listings
// (GET /api/distributor/models).
func (c *Client) ListDistributorModels(ctx context.Context, page, pageSize int) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/models", Params{"page": page, "page_size": pageSize}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorGlobalModels returns the listings in full-catalogue mode
// (GET /api/distributor/models/global).
func (c *Client) ListDistributorGlobalModels(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/models/global", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorGlobalStatus lists or unlists one model
// (PUT /api/distributor/models/global/status).
func (c *Client) SetDistributorGlobalStatus(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, "/api/distributor/models/global/status", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorGlobalProviderStatus lists or unlists a whole provider
// (PUT /api/distributor/models/global/provider-status).
func (c *Client) SetDistributorGlobalProviderStatus(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, "/api/distributor/models/global/provider-status", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorGlobalPrice overrides the price of one model
// (PUT /api/distributor/models/global/price).
func (c *Client) SetDistributorGlobalPrice(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, "/api/distributor/models/global/price", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateDistributorModel adds a listing (POST /api/distributor/models).
func (c *Client) CreateDistributorModel(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/distributor/models", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateDistributorModel replaces a listing (PUT /api/distributor/models/{id}).
func (c *Client) UpdateDistributorModel(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/distributor/models/%d", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteDistributorModel removes a listing (DELETE /api/distributor/models/{id}).
func (c *Client) DeleteDistributorModel(ctx context.Context, id int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/distributor/models/%d", id), nil)
}

// ListDistributorProviders returns the providers the station subscribed to
// (GET /api/distributor/providers).
func (c *Client) ListDistributorProviders(ctx context.Context, keyword string, page, pageSize int) (any, error) {
	var out any
	err := c.Get(ctx, "/api/distributor/providers", Params{"keyword": keyword, "page": page, "page_size": pageSize}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorProviderModels returns the catalogue of one subscribed
// provider (GET /api/distributor/providers/{id}/models).
func (c *Client) ListDistributorProviderModels(ctx context.Context, id int) (any, error) {
	var out any
	if err := c.Get(ctx, fmt.Sprintf("/api/distributor/providers/%d/models", id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorPackages returns the station packages
// (GET /api/distributor/packages).
func (c *Client) ListDistributorPackages(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/packages", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateDistributorPackage creates a package (POST /api/distributor/packages).
func (c *Client) CreateDistributorPackage(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/distributor/packages", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateDistributorPackage replaces a package
// (PUT /api/distributor/packages/{id}). The body must carry every field.
func (c *Client) UpdateDistributorPackage(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/distributor/packages/%d", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteDistributorPackage removes a package
// (DELETE /api/distributor/packages/{id}).
func (c *Client) DeleteDistributorPackage(ctx context.Context, id int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/distributor/packages/%d", id), nil)
}

// ListDistributorCustomers returns the station customers
// (GET /api/distributor/customers).
func (c *Client) ListDistributorCustomers(ctx context.Context, keyword string, page, pageSize int) (any, error) {
	var out any
	err := c.Get(ctx, "/api/distributor/customers", Params{"keyword": keyword, "page": page, "page_size": pageSize}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// GetDistributorCustomerDashboard returns one customer's usage counters
// (GET /api/distributor/customers/{id}/dashboard).
func (c *Client) GetDistributorCustomerDashboard(ctx context.Context, id int) (any, error) {
	var out any
	if err := c.Get(ctx, fmt.Sprintf("/api/distributor/customers/%d/dashboard", id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorCustomerStatus enables or bans a customer
// (PUT /api/distributor/customers/{id}/status). Status 1 enables, 2 bans.
func (c *Client) SetDistributorCustomerStatus(ctx context.Context, id, status int) (any, error) {
	var out any
	err := c.Put(ctx, fmt.Sprintf("/api/distributor/customers/%d/status", id), map[string]any{"status": status}, &out)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorKeyGroups returns the station key groups
// (GET /api/distributor/key-groups).
func (c *Client) ListDistributorKeyGroups(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/key-groups", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorKeyGroupModels returns the models a key group may include
// (GET /api/distributor/key-groups/models).
func (c *Client) ListDistributorKeyGroupModels(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/key-groups/models", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateDistributorKeyGroup creates a key group
// (POST /api/distributor/key-groups).
func (c *Client) CreateDistributorKeyGroup(ctx context.Context, body map[string]any) (any, error) {
	var out any
	if err := c.Post(ctx, "/api/distributor/key-groups", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UpdateDistributorKeyGroup replaces a key group
// (PUT /api/distributor/key-groups/{id}).
func (c *Client) UpdateDistributorKeyGroup(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/distributor/key-groups/%d", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteDistributorKeyGroup removes a key group
// (DELETE /api/distributor/key-groups/{id}).
func (c *Client) DeleteDistributorKeyGroup(ctx context.Context, id int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/distributor/key-groups/%d", id), nil)
}

// ListDistributorSharedSubscriptions returns the station's shared plans
// (GET /api/distributor/shared-subscriptions).
func (c *Client) ListDistributorSharedSubscriptions(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/shared-subscriptions", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorSharedSubscription updates a shared plan record
// (PUT /api/distributor/shared-subscriptions/{id}).
func (c *Client) SetDistributorSharedSubscription(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/distributor/shared-subscriptions/%d", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorSharedSubscriptionModels updates the model list of a shared
// plan (PUT /api/distributor/shared-subscriptions/{id}/models).
func (c *Client) SetDistributorSharedSubscriptionModels(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/distributor/shared-subscriptions/%d/models", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SetDistributorSharedSubscriptionModelStatus bulk enables or disables the
// models of a shared plan
// (PUT /api/distributor/shared-subscriptions/{id}/models/bulk-status).
func (c *Client) SetDistributorSharedSubscriptionModelStatus(ctx context.Context, id int, body map[string]any) (any, error) {
	var out any
	if err := c.Put(ctx, fmt.Sprintf("/api/distributor/shared-subscriptions/%d/models/bulk-status", id), body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListDistributorOfficialChannels returns the official channels offered by
// the platform (GET /api/distributor/official-channels).
func (c *Client) ListDistributorOfficialChannels(ctx context.Context) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/official-channels", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetDistributorLogs returns the station usage logs
// (GET /api/distributor/logs).
func (c *Client) GetDistributorLogs(ctx context.Context, q LogQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/logs", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetDistributorLogStat returns the station usage totals
// (GET /api/distributor/logs/stat).
func (c *Client) GetDistributorLogStat(ctx context.Context, q LogQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/logs/stat", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetDistributorEarnings returns the station earnings
// (GET /api/distributor/earnings).
func (c *Client) GetDistributorEarnings(ctx context.Context, q LogQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/earnings", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetDistributorEarningsSummary returns the station earnings totals
// (GET /api/distributor/earnings/summary).
func (c *Client) GetDistributorEarningsSummary(ctx context.Context, q LogQuery) (any, error) {
	var out any
	if err := c.Get(ctx, "/api/distributor/earnings/summary", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Generic escape hatch
// ---------------------------------------------------------------------------

// Raw performs an arbitrary management request and returns the decoded
// payload. It exists so uncommon endpoints stay reachable without a dedicated
// command.
func (c *Client) Raw(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	raw, err := c.DoRaw(ctx, method, path, nil, body, AuthManagement)
	if err != nil {
		return nil, err
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && len(env.Data) > 0 {
		return env.Data, nil
	}
	return raw, nil
}
