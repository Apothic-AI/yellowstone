package api

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// Model directory
// ---------------------------------------------------------------------------

// ModelQuery holds the filters accepted by the model directory endpoints.
type ModelQuery struct {
	Keyword    string
	ProviderID int
	Category   string
	Page       int
	PageSize   int
}

// Params renders the query as request parameters.
func (q ModelQuery) Params() Params {
	p := Params{}
	if q.Keyword != "" {
		p["keyword"] = q.Keyword
	}
	if q.ProviderID > 0 {
		p["provider_id"] = q.ProviderID
	}
	if q.Category != "" {
		p["category"] = q.Category
	}
	if q.Page > 0 {
		p["page"] = q.Page
	}
	if q.PageSize > 0 {
		p["page_size"] = q.PageSize
	}
	return p
}

// ModelPage is one page of the model directory.
type ModelPage struct {
	Items []MarketplaceModel `json:"items"`
	Total int                `json:"total"`
	Page  int                `json:"page"`
}

// ListMarketplaceModels returns a page of the public model directory
// (GET /api/marketplace/models).
func (c *Client) ListMarketplaceModels(ctx context.Context, q ModelQuery) (*ModelPage, error) {
	raw, err := c.DoRaw(ctx, "GET", "/api/marketplace/models", q.Params(), nil, AuthPublic)
	if err != nil {
		return nil, err
	}
	var page ModelPage
	var env struct {
		Data  json.RawMessage `json:"data"`
		Total int             `json:"total"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	page.Total = env.Total
	if err := DecodeList(env.Data, &page.Items); err != nil {
		return nil, err
	}
	return &page, nil
}

// GetMarketplaceModel returns one marketplace model
// (GET /api/marketplace/models/{id}).
func (c *Client) GetMarketplaceModel(ctx context.Context, id int) (*MarketplaceModel, error) {
	var m MarketplaceModel
	if err := c.GetPublic(ctx, fmt.Sprintf("/api/marketplace/models/%d", id), nil, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// GetSubrouterModels returns the smart-routing model directory
// (GET /api/user/self/subrouter/models). It is the set of models the account
// can reach, with the cheapest provider offer for each.
func (c *Client) GetSubrouterModels(ctx context.Context) ([]SubrouterModel, error) {
	var out []SubrouterModel
	if err := c.Get(ctx, "/api/user/self/subrouter/models", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetUserModels returns the model names available to the account
// (GET /api/user/models).
func (c *Client) GetUserModels(ctx context.Context) ([]string, error) {
	var raw json.RawMessage
	if err := c.Get(ctx, "/api/user/models", nil, &raw); err != nil {
		return nil, err
	}
	if trimmed := strings.TrimSpace(string(raw)); trimmed == "" || trimmed == "null" {
		// The account has no explicit model list.
		return nil, nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		// The endpoint may return an object keyed by model name.
		var m map[string]any
		if err2 := json.Unmarshal(raw, &m); err2 != nil {
			return nil, err
		}
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out, nil
	}
	sort.Strings(out)
	return out, nil
}

// GetUserGroups returns the routing groups available to the account
// (GET /api/user/self/groups).
func (c *Client) GetUserGroups(ctx context.Context) (GroupMap, error) {
	var g GroupMap
	if err := c.Get(ctx, "/api/user/self/groups", nil, &g); err != nil {
		return nil, err
	}
	return g, nil
}

// GetPricing returns the public price sheet (GET /api/pricing).
func (c *Client) GetPricing(ctx context.Context) (any, error) {
	var out any
	if err := c.GetPublic(ctx, "/api/pricing", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetModelOptions returns the model options list
// (GET /api/marketplace/model-options).
func (c *Client) GetModelOptions(ctx context.Context) (any, error) {
	var out any
	if err := c.GetPublic(ctx, "/api/marketplace/model-options", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Provider directory
// ---------------------------------------------------------------------------

// ProviderQuery holds the filters accepted by the provider directory.
type ProviderQuery struct {
	Keyword  string
	Page     int
	PageSize int
}

// Params renders the query as request parameters.
func (q ProviderQuery) Params() Params {
	p := Params{}
	if q.Keyword != "" {
		p["keyword"] = q.Keyword
	}
	if q.Page > 0 {
		p["page"] = q.Page
	}
	if q.PageSize > 0 {
		p["page_size"] = q.PageSize
	}
	return p
}

// ProviderPage is one page of the provider directory.
type ProviderPage struct {
	Items []MarketplaceProvider `json:"items"`
	Total int                   `json:"total"`
	Page  int                   `json:"page"`
}

// ListMarketplaceProviders returns a page of the provider directory
// (GET /api/marketplace/providers).
func (c *Client) ListMarketplaceProviders(ctx context.Context, q ProviderQuery) (*ProviderPage, error) {
	raw, err := c.DoRaw(ctx, "GET", "/api/marketplace/providers", q.Params(), nil, AuthPublic)
	if err != nil {
		return nil, err
	}
	var env struct {
		Data  json.RawMessage `json:"data"`
		Total int             `json:"total"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	page := ProviderPage{Total: env.Total}
	if err := DecodeList(env.Data, &page.Items); err != nil {
		return nil, err
	}
	return &page, nil
}

// GetMarketplaceProvider returns one provider with its catalogue
// (GET /api/marketplace/providers/{slug}). The endpoint is addressed by slug.
func (c *Client) GetMarketplaceProvider(ctx context.Context, slug string) (*ProviderDetail, error) {
	var d ProviderDetail
	if err := c.GetPublic(ctx, "/api/marketplace/providers/"+slug, nil, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// GetSharedProvider returns one shared pool provider
// (GET /api/marketplace/shared-providers/{slug}).
func (c *Client) GetSharedProvider(ctx context.Context, slug string) (any, error) {
	var out any
	if err := c.GetPublic(ctx, "/api/marketplace/shared-providers/"+slug, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetSharedProviders returns the shared-pool providers
// (GET /api/marketplace/shared-providers).
func (c *Client) GetSharedProviders(ctx context.Context) ([]MarketplaceProvider, error) {
	var out []MarketplaceProvider
	if err := c.GetPublic(ctx, "/api/marketplace/shared-providers", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetSharedModels returns the shared-pool models
// (GET /api/marketplace/shared-models).
func (c *Client) GetSharedModels(ctx context.Context, q ModelQuery) ([]MarketplaceModel, error) {
	var out []MarketplaceModel
	if err := c.GetPublic(ctx, "/api/marketplace/shared-models", q.Params(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Client-side search, sort and filter
// ---------------------------------------------------------------------------

// FilterModels keeps the models matching the free text query. It searches the
// model name, the provider name and the category.
func FilterModels(models []MarketplaceModel, query string) []MarketplaceModel {
	if query == "" {
		return models
	}
	q := strings.ToLower(query)
	out := make([]MarketplaceModel, 0, len(models))
	for _, m := range models {
		hay := strings.ToLower(strings.Join([]string{
			m.ModelName, m.ProviderName, m.ProviderSlug, m.Category, m.UpstreamModel,
		}, " "))
		if strings.Contains(hay, q) {
			out = append(out, m)
		}
	}
	return out
}

// SortModels orders models by a field name in the given direction.
func SortModels(models []MarketplaceModel, field string, desc bool) {
	less := func(i, j int) bool { return false }
	switch strings.ToLower(field) {
	case "model", "name":
		less = func(i, j int) bool { return models[i].ModelName < models[j].ModelName }
	case "provider":
		less = func(i, j int) bool { return models[i].ProviderName < models[j].ProviderName }
	case "input", "input_price":
		less = func(i, j int) bool { return models[i].InputPrice < models[j].InputPrice }
	case "output", "output_price":
		less = func(i, j int) bool { return models[i].OutputPrice < models[j].OutputPrice }
	case "fixed", "fixed_price":
		less = func(i, j int) bool { return models[i].FixedPrice < models[j].FixedPrice }
	case "price":
		less = func(i, j int) bool {
			return models[i].InputPrice+models[i].OutputPrice < models[j].InputPrice+models[j].OutputPrice
		}
	case "availability":
		less = func(i, j int) bool { return models[i].Availability < models[j].Availability }
	case "latency":
		less = func(i, j int) bool { return models[i].AvgLatency < models[j].AvgLatency }
	case "ttft":
		less = func(i, j int) bool { return models[i].MedianTTFT < models[j].MedianTTFT }
	case "rating":
		less = func(i, j int) bool { return models[i].Rating < models[j].Rating }
	case "requests":
		less = func(i, j int) bool { return models[i].TotalRequests < models[j].TotalRequests }
	case "context":
		less = func(i, j int) bool { return models[i].ContextLength < models[j].ContextLength }
	case "updated":
		less = func(i, j int) bool { return models[i].UpdatedTime < models[j].UpdatedTime }
	case "created":
		less = func(i, j int) bool { return models[i].CreatedTime < models[j].CreatedTime }
	default:
		return
	}
	if desc {
		sort.SliceStable(models, func(i, j int) bool { return less(j, i) })
		return
	}
	sort.SliceStable(models, func(i, j int) bool { return less(i, j) })
}

// FilterProviders keeps the providers matching the free text query.
func FilterProviders(providers []MarketplaceProvider, query string) []MarketplaceProvider {
	if query == "" {
		return providers
	}
	q := strings.ToLower(query)
	out := make([]MarketplaceProvider, 0, len(providers))
	for _, p := range providers {
		hay := strings.ToLower(strings.Join([]string{p.Slug, p.CompanyName, p.Description}, " "))
		if strings.Contains(hay, q) {
			out = append(out, p)
		}
	}
	return out
}

// SortProviders orders providers by a field name in the given direction.
func SortProviders(providers []MarketplaceProvider, field string, desc bool) {
	less := func(i, j int) bool { return false }
	switch strings.ToLower(field) {
	case "name", "company":
		less = func(i, j int) bool { return providers[i].CompanyName < providers[j].CompanyName }
	case "slug":
		less = func(i, j int) bool { return providers[i].Slug < providers[j].Slug }
	case "rating":
		less = func(i, j int) bool { return providers[i].Rating < providers[j].Rating }
	case "availability":
		less = func(i, j int) bool { return providers[i].Availability < providers[j].Availability }
	case "models", "model_count":
		less = func(i, j int) bool { return providers[i].ModelCount < providers[j].ModelCount }
	case "credit", "credit_score":
		less = func(i, j int) bool { return providers[i].CreditScore < providers[j].CreditScore }
	case "deposit":
		less = func(i, j int) bool { return providers[i].DepositUSD < providers[j].DepositUSD }
	case "subscribers", "subscription_count":
		less = func(i, j int) bool { return providers[i].SubscriptionCount < providers[j].SubscriptionCount }
	case "anomalies":
		less = func(i, j int) bool { return providers[i].AnomalyModelCount < providers[j].AnomalyModelCount }
	default:
		return
	}
	if desc {
		sort.SliceStable(providers, func(i, j int) bool { return less(j, i) })
		return
	}
	sort.SliceStable(providers, func(i, j int) bool { return less(i, j) })
}

// SortSubrouterModels orders smart-routing models by a field name.
func SortSubrouterModels(models []SubrouterModel, field string, desc bool) {
	less := func(i, j int) bool { return false }
	switch strings.ToLower(field) {
	case "model", "name":
		less = func(i, j int) bool { return models[i].ModelName < models[j].ModelName }
	case "category":
		less = func(i, j int) bool { return models[i].Category < models[j].Category }
	case "providers", "provider_count":
		less = func(i, j int) bool { return models[i].ProviderCount < models[j].ProviderCount }
	case "input", "input_price":
		less = func(i, j int) bool { return models[i].MinInputPrice < models[j].MinInputPrice }
	case "output", "output_price":
		less = func(i, j int) bool { return models[i].MinOutputPr < models[j].MinOutputPr }
	case "fixed", "fixed_price":
		less = func(i, j int) bool { return models[i].MinFixedPrice < models[j].MinFixedPrice }
	case "price":
		less = func(i, j int) bool {
			return models[i].MinInputPrice+models[i].MinOutputPr < models[j].MinInputPrice+models[j].MinOutputPr
		}
	default:
		return
	}
	if desc {
		sort.SliceStable(models, func(i, j int) bool { return less(j, i) })
		return
	}
	sort.SliceStable(models, func(i, j int) bool { return less(i, j) })
}
