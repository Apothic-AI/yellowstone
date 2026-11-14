package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

// registry maps a method name to its handler. The names are the contract
// between the Go library and the TypeScript and Python bindings.
var registry = map[string]handler{
	// Auth
	"auth.status": params(authStatus),

	// Account
	"account.info":            params(accountInfo),
	"account.update":          params(accountUpdate),
	"account.groups":          params(accountGroups),
	"account.models":          params(accountModels),
	"account.subrouterModels": params(accountSubrouterModels),
	"account.topupInfo":       params(accountTopupInfo),
	"account.topups":          params(accountTopups),
	"account.redeem":          params(accountRedeem),
	"account.balance":         params(accountBalance),
	"account.notifications":   params(accountNotifications),
	"account.aff":             params(accountAff),
	"account.status":          params(accountStatus),

	// Usage
	"usage.logs":   params(usageLogs),
	"usage.log":    params(usageLog),
	"usage.stats":  params(usageStats),
	"usage.data":   params(usageData),
	"usage.export": params(usageExport),

	// Tokens
	"token.list":        params(tokenList),
	"token.show":        params(tokenShow),
	"token.types":       params(tokenTypes),
	"token.create":      params(tokenCreate),
	"token.update":      params(tokenUpdate),
	"token.delete":      params(tokenDelete),
	"token.deleteBatch": params(tokenDeleteBatch),

	// Models
	"model.list":    params(modelList),
	"model.show":    params(modelShow),
	"model.pricing": params(modelPricing),
	"model.options": params(modelOptions),
	"model.routing": params(modelRouting),

	// Providers
	"provider.list":           params(providerList),
	"provider.show":           params(providerShow),
	"provider.models":         params(providerModels),
	"provider.subs":           params(providerSubs),
	"provider.subscribe":      params(providerSubscribe),
	"provider.unsubscribe":    params(providerUnsubscribe),
	"provider.subscribeAll":   params(providerSubscribeAll),
	"provider.unsubscribeAll": params(providerUnsubscribeAll),
	"provider.subConfig":      params(providerSubConfig),
	"provider.shared":         params(providerShared),

	// Shared plans
	"shared.list":      params(sharedList),
	"shared.subscribe": params(sharedSubscribe),
	"shared.cancel":    params(sharedCancel),

	// Subscription
	"subscription.list":       params(subscriptionList),
	"subscription.plans":      params(subscriptionPlans),
	"subscription.preference": params(subscriptionPreference),
	"subscription.pay":        params(subscriptionPay),

	// Tasks
	"task.list": params(taskList),
	"task.show": params(taskShow),

	// Merchant
	"merchant.self":         params(merchantSelf),
	"merchant.channels":     params(merchantChannels),
	"merchant.channelTest":  params(merchantChannelTest),
	"merchant.models":       params(merchantModels),
	"merchant.modelCreate":  params(merchantModelCreate),
	"merchant.modelUpdate":  params(merchantModelUpdate),
	"merchant.modelBatch":   params(merchantModelBatch),
	"merchant.pricePreview": params(merchantPricePreview),
	"merchant.earnings":     params(merchantEarnings),
	"merchant.payouts":      params(merchantPayouts),
	"merchant.register":     params(merchantRegister),

	// Station
	"station.self":             params(stationSelf),
	"station.dashboard":        params(stationDashboard),
	"station.customers":        params(stationCustomers),
	"station.models":           params(stationModels),
	"station.globalModels":     params(stationGlobalModels),
	"station.keyGroups":        params(stationKeyGroups),
	"station.shared":           params(stationShared),
	"station.officialChannels": params(stationOfficialChannels),
	"station.packages":         params(stationPackages),
	"station.logs":             params(stationLogs),
	"station.earnings":         params(stationEarnings),

	// Escape hatch
	"raw": params(rawRequest),
}

// ---------------------------------------------------------------------------
// Shared parameter shapes
// ---------------------------------------------------------------------------

// PageParams are the paging, search and sorting parameters of the list
// methods.
type PageParams struct {
	Page     int    `json:"page,omitempty"`
	PageSize int    `json:"page_size,omitempty"`
	Limit    int    `json:"limit,omitempty"`
	Search   string `json:"search,omitempty"`
	Sort     string `json:"sort,omitempty"`
	Order    string `json:"order,omitempty"`
}

func (p PageParams) desc() bool {
	return strings.EqualFold(p.Order, "desc") || strings.EqualFold(p.Order, "descending")
}

func (p PageParams) size(def int) int {
	if p.PageSize > 0 {
		return p.PageSize
	}
	return def
}

func (p PageParams) page() int {
	if p.Page > 0 {
		return p.Page
	}
	return 1
}

// slice trims a result set to the requested page and limit.
func slice[T any](items []T, p PageParams, size int) []T {
	if p.Page > 1 {
		start := (p.Page - 1) * size
		if start >= len(items) {
			return nil
		}
		items = items[start:]
	}
	if p.Limit > 0 && len(items) > p.Limit {
		items = items[:p.Limit]
	}
	return items
}

// LogParams are the filters of the log methods.
type LogParams struct {
	PageParams
	From     string `json:"from,omitempty"`
	To       string `json:"to,omitempty"`
	Type     int    `json:"type,omitempty"`
	Model    string `json:"model,omitempty"`
	Group    string `json:"group,omitempty"`
	KeyName  string `json:"key_name,omitempty"`
	Request  string `json:"request,omitempty"`
	Username string `json:"username,omitempty"`
}

// query turns the parameters into an API log query.
func (p LogParams) query() (api.LogQuery, error) {
	start, err := api.ParseTime(p.From, false)
	if err != nil {
		return api.LogQuery{}, err
	}
	end, err := api.ParseTime(p.To, true)
	if err != nil {
		return api.LogQuery{}, err
	}
	if start == 0 {
		start = api.StartOfToday()
	}
	if end == 0 {
		end = api.StartOfToday()
	}
	return api.LogQuery{
		PageSize:       p.size(api.MaxLogPageSize),
		Type:           p.Type,
		TokenName:      p.KeyName,
		ModelName:      p.Model,
		Group:          p.Group,
		RequestID:      p.Request,
		Username:       p.Username,
		StartTimestamp: start,
		EndTimestamp:   end,
	}, nil
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

func authStatus(ctx context.Context, c *Client, p struct{}) (any, error) {
	out := map[string]any{
		"base_url":         c.Options.BaseURL,
		"user_id":          c.Options.UserID,
		"credential_path":  c.Options.CredentialPath,
		"has_access_token": c.Options.AccessToken != "",
		"has_api_key":      c.Options.APIKey != "",
		"authenticated":    false,
	}
	if c.Options.AccessToken == "" || c.Options.UserID == 0 {
		return out, nil
	}
	user, err := c.API.GetUser(ctx)
	if err != nil {
		out["error"] = err.Error()
		return out, nil
	}
	out["authenticated"] = true
	out["username"] = user.Username
	out["display_name"] = user.DisplayName
	if c.Options.APIKey != "" {
		models, err := c.API.GetRelayModels(ctx)
		if err != nil {
			out["relay_error"] = err.Error()
		} else {
			out["relay_models"] = len(models)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

func accountInfo(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetUser(ctx)
}

func accountUpdate(ctx context.Context, c *Client, p struct {
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	Email       string `json:"email,omitempty"`
	Group       string `json:"group,omitempty"`
}) (any, error) {
	body := map[string]any{}
	if p.Username != "" {
		body["username"] = p.Username
	}
	if p.DisplayName != "" {
		body["display_name"] = p.DisplayName
	}
	if p.Email != "" {
		body["email"] = p.Email
	}
	if p.Group != "" {
		body["group"] = p.Group
	}
	if len(body) == 0 {
		return nil, &Error{Message: "nothing to update: pass at least one of username, display_name, email or group", Type: "invalid_params"}
	}
	return c.API.UpdateUser(ctx, body)
}

func accountGroups(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetUserGroups(ctx)
}

func accountModels(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetUserModels(ctx)
}

func accountSubrouterModels(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetSubrouterModels(ctx)
}

func accountTopupInfo(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetTopupInfo(ctx)
}

func accountTopups(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.GetTopups(ctx, p.page(), p.size(50))
}

func accountRedeem(ctx context.Context, c *Client, p struct {
	Code string `json:"code"`
}) (any, error) {
	if p.Code == "" {
		return nil, &Error{Message: "code is required", Type: "invalid_params"}
	}
	msg, err := c.API.RedeemVoucher(ctx, p.Code)
	if err != nil {
		return nil, err
	}
	return map[string]any{"result": msg}, nil
}

func accountBalance(ctx context.Context, c *Client, p struct{}) (any, error) {
	sub, err := c.API.GetBillingSubscription(ctx)
	if err != nil {
		return nil, err
	}
	usage, err := c.API.GetBillingUsage(ctx)
	if err != nil {
		usage = nil
	}
	return map[string]any{"subscription": sub, "usage": usage}, nil
}

func accountNotifications(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.GetNotifications(ctx, p.page(), p.size(50))
}

func accountAff(ctx context.Context, c *Client, p struct{}) (any, error) {
	summary, err := c.API.GetAffSummary(ctx)
	if err != nil {
		return nil, err
	}
	earnings, err := c.API.GetAffEarnings(ctx)
	if err != nil {
		return nil, err
	}
	invites, quota, commission, err := c.API.GetAffEarningTotals(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"earnings": earnings,
		"summary":  summary,
		"totals":   map[string]any{"invites": invites, "quota": quota, "commission": commission},
	}, nil
}

func accountStatus(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetStatus(ctx)
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

func usageLogs(ctx context.Context, c *Client, p LogParams) (any, error) {
	q, err := p.query()
	if err != nil {
		return nil, err
	}
	var items []api.LogEntry
	if c.API.LogRanges != nil && c.API.LogRanges.Enabled() {
		items, err = c.API.GetLogRange(ctx, q)
		if err != nil {
			if len(items) == 0 {
				return nil, err
			}
			// The cached part of the range is still served.
			c.addNotice("the requested range is incomplete: " + err.Error())
		}
	} else {
		items, err = fetchLogPages(ctx, c.API, q, p)
		if err != nil {
			return nil, err
		}
	}
	items = api.FilterLogs(items, p.Search)
	api.SortLogs(items, p.Sort, p.desc())
	return slice(items, p.PageParams, q.PageSize), nil
}

// fetchLogPages walks the cursor paging of the log endpoint.
func fetchLogPages(ctx context.Context, cl *api.Client, q api.LogQuery, p LogParams) ([]api.LogEntry, error) {
	var all []api.LogEntry
	cursor := "first"
	page := 1
	for {
		q.Cursor = cursor
		res, err := cl.GetLogs(ctx, q)
		if err != nil {
			return nil, err
		}
		all = append(all, res.Items...)
		if page >= p.page() {
			break
		}
		if !res.HasMore || res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
		page++
	}
	return all, nil
}

func usageLog(ctx context.Context, c *Client, p struct {
	RequestID string `json:"request_id"`
}) (any, error) {
	if p.RequestID == "" {
		return nil, &Error{Message: "request_id is required", Type: "invalid_params"}
	}
	q := api.LogQuery{RequestID: p.RequestID, PageSize: api.MaxLogPageSize, Cursor: "first"}
	res, err := c.API.GetLogs(ctx, q)
	if err != nil {
		return nil, err
	}
	if len(res.Items) == 0 {
		return nil, &Error{Message: "no log entry for request " + p.RequestID, Type: "not_found"}
	}
	return res.Items[0], nil
}

func usageStats(ctx context.Context, c *Client, p LogParams) (any, error) {
	q, err := p.query()
	if err != nil {
		return nil, err
	}
	return c.API.GetLogStat(ctx, q)
}

func usageData(ctx context.Context, c *Client, p struct {
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
}) (any, error) {
	start, err := api.ParseTime(p.From, false)
	if err != nil {
		return nil, err
	}
	end, err := api.ParseTime(p.To, true)
	if err != nil {
		return nil, err
	}
	if start == 0 {
		start = api.StartOfToday()
	}
	if end == 0 {
		end = api.StartOfToday()
	}
	return c.API.GetData(ctx, start, end)
}

func usageExport(ctx context.Context, c *Client, p LogParams) (any, error) {
	q, err := p.query()
	if err != nil {
		return nil, err
	}
	return map[string]any{"url": c.API.ExportLogsURL(q)}, nil
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

func tokenList(ctx context.Context, c *Client, p struct {
	PageParams
	Kind string `json:"kind,omitempty"`
}) (any, error) {
	kind := p.Kind
	if kind == "" {
		kind = string(api.KindAll)
	}
	tokens, total, err := fetchTokens(ctx, c.API, p.PageParams, kind)
	if err != nil {
		return nil, err
	}
	tokens = api.FilterTokens(tokens, p.Search)
	api.SortTokens(tokens, p.Sort, p.desc())
	tokens = slice(tokens, p.PageParams, p.size(100))
	return map[string]any{"items": tokens, "total": total, "page": p.page()}, nil
}

// fetchTokens loads tokens, walking pages when a local sort is requested.
func fetchTokens(ctx context.Context, cl *api.Client, p PageParams, kind string) ([]api.Token, int, error) {
	size := p.size(100)
	if p.Sort == "" {
		list, err := cl.ListTokens(ctx, p.page(), size, kind)
		if err != nil {
			return nil, 0, err
		}
		return list.Items, list.Total, nil
	}
	var all []api.Token
	total := 0
	for page := 1; page <= 50; page++ {
		list, err := cl.ListTokens(ctx, page, size, kind)
		if err != nil {
			return nil, 0, err
		}
		all = append(all, list.Items...)
		total = list.Total
		if len(list.Items) < size || len(all) >= list.Total {
			break
		}
	}
	return all, total, nil
}

func tokenShow(ctx context.Context, c *Client, p struct {
	ID int `json:"id"`
}) (any, error) {
	if p.ID == 0 {
		return nil, &Error{Message: "id is required", Type: "invalid_params"}
	}
	return c.API.GetToken(ctx, p.ID)
}

// tokenTypes explains the four key kinds.
func tokenTypes(ctx context.Context, c *Client, p struct{}) (any, error) {
	return []map[string]string{
		{"kind": "smart", "group": "subrouter", "routing": "every subscribed source, cheapest healthy route wins, automatic failover"},
		{"kind": "official", "group": "subrouter", "routing": "platform official channels only"},
		{"kind": "shared", "group": "subrouter", "routing": "subscribed shared account pools only"},
		{"kind": "fixed", "group": "provider:<slug>", "routing": "one pinned provider, no cross provider failover"},
	}, nil
}

// TokenSpec is the JSON shape of a token request. A field that is left out
// keeps the default of the key kind.
type TokenSpec struct {
	Kind        string              `json:"kind"`
	Name        string              `json:"name,omitempty"`
	Provider    string              `json:"provider,omitempty"`
	Providers   []string            `json:"providers,omitempty"`
	Models      []string            `json:"models,omitempty"`
	ModelRoutes map[string][]string `json:"model_routes,omitempty"`

	RoutePreference string  `json:"route_preference,omitempty"`
	SortMode        string  `json:"sort_mode,omitempty"`
	LoadBalance     *bool   `json:"load_balance,omitempty"`
	IncludeCacheHit *bool   `json:"include_cache_hit,omitempty"`
	IncludeProvider *bool   `json:"include_provider,omitempty"`
	IncludeOfficial *bool   `json:"include_official,omitempty"`
	IncludeShared   *bool   `json:"include_shared,omitempty"`
	OfficialMaxDisc float64 `json:"official_max_discount,omitempty"`
	SharedMaxDisc   float64 `json:"shared_max_discount,omitempty"`
	OfficialChannel int     `json:"official_channel,omitempty"`

	Unlimited *bool   `json:"unlimited,omitempty"`
	Quota     float64 `json:"quota,omitempty"`
	QuotaUSD  float64 `json:"quota_usd,omitempty"`
	Expires   *int64  `json:"expires,omitempty"`
	ExpiresIn string  `json:"expires_in,omitempty"`

	AllowIPs       string `json:"allow_ips,omitempty"`
	CrossGroupOnly bool   `json:"cross_group_retry,omitempty"`
	Group          string `json:"group,omitempty"`
	KeyGroupID     int    `json:"key_group_id,omitempty"`
}

// spec converts the request into an API token specification.
func (t TokenSpec) spec(perUnit float64) (*api.TokenSpec, error) {
	kind := api.TokenKind(t.Kind)
	switch kind {
	case api.KindSmart, api.KindOfficial, api.KindShared, api.KindFixed:
	case "":
		return nil, &Error{Message: "kind is required: smart, official, shared or fixed", Type: "invalid_params"}
	default:
		return nil, &Error{Message: fmt.Sprintf("unknown kind %q: smart, official, shared or fixed", t.Kind), Type: "invalid_params"}
	}
	if kind == api.KindFixed && t.Provider == "" {
		return nil, &Error{Message: "a fixed key needs a provider slug", Type: "invalid_params"}
	}

	spec := api.NewTokenSpec(kind)
	spec.Name = t.Name
	spec.Provider = t.Provider
	spec.Providers = t.Providers
	spec.Models = t.Models
	spec.ModelRoutes = t.ModelRoutes
	if t.RoutePreference != "" {
		spec.RoutePreference = t.RoutePreference
	}
	if t.SortMode != "" {
		spec.SortMode = t.SortMode
	}
	spec.OfficialMaxDisc = t.OfficialMaxDisc
	spec.SharedMaxDisc = t.SharedMaxDisc
	spec.OfficialChannel = t.OfficialChannel
	spec.AllowIPs = t.AllowIPs
	spec.CrossGroupOnly = t.CrossGroupOnly
	spec.Group = t.Group
	spec.KeyGroupID = t.KeyGroupID

	setBool(&spec.LoadBalance, t.LoadBalance)
	setBool(&spec.IncludeCacheHit, t.IncludeCacheHit)
	setBool(&spec.IncludeProvider, t.IncludeProvider)
	setBool(&spec.IncludeOfficial, t.IncludeOfficial)
	setBool(&spec.IncludeShared, t.IncludeShared)

	// A key is unlimited unless a quota says otherwise.
	spec.Unlimited = true
	if t.Unlimited != nil {
		spec.Unlimited = *t.Unlimited
	}
	switch {
	case t.Quota > 0:
		spec.Quota = t.Quota
		spec.Unlimited = false
	case t.QuotaUSD > 0:
		spec.Quota = t.QuotaUSD * perUnit
		spec.Unlimited = false
	}

	switch {
	case t.Expires != nil:
		spec.Expires = *t.Expires
	case t.ExpiresIn != "":
		v, err := api.ResolveExpiry(t.ExpiresIn)
		if err != nil {
			return nil, &Error{Message: err.Error(), Type: "invalid_params"}
		}
		spec.Expires = v
	default:
		spec.Expires = -1
	}
	return spec, nil
}

func setBool(target *bool, v *bool) {
	if v != nil {
		*target = *v
	}
}

func boolPtr(v bool) *bool { return &v }

func int64Ptr(v int64) *int64 { return &v }

func tokenCreate(ctx context.Context, c *Client, p struct {
	TokenSpec
}) (any, error) {
	spec, err := p.TokenSpec.spec(c.Options.QuotaPerUnit)
	if err != nil {
		return nil, err
	}
	t, err := c.API.CreateToken(ctx, spec.Payload())
	if err != nil {
		return nil, err
	}
	// The create response omits the routing group, so read the stored
	// record back to report exactly what the platform applied.
	if stored, err := c.API.GetToken(ctx, t.ID); err == nil {
		t = stored
	}
	return t, nil
}

func tokenUpdate(ctx context.Context, c *Client, p struct {
	TokenSpec
	ID int `json:"id"`
}) (any, error) {
	if p.ID == 0 {
		return nil, &Error{Message: "id is required", Type: "invalid_params"}
	}
	current, err := c.API.GetToken(ctx, p.ID)
	if err != nil {
		return nil, err
	}

	// A field that was not sent keeps the value of the stored key.
	if p.Kind == "" {
		p.Kind = string(current.Kind())
	}
	if p.Kind == string(api.KindAuto) {
		p.Kind = string(api.KindSmart)
	}
	if p.Provider == "" {
		p.Provider = current.ProviderSlug()
	}
	if len(p.Providers) == 0 {
		p.Providers = splitList(current.SubrouterProviders)
	}
	if len(p.Models) == 0 {
		p.Models = splitList(current.ModelLimits)
	}
	if p.Name == "" {
		p.Name = current.Name
	}
	if p.RoutePreference == "" {
		p.RoutePreference = current.SubrouterRoutePreference
	}
	if p.SortMode == "" {
		p.SortMode = current.SubrouterSortMode
	}
	if p.LoadBalance == nil {
		p.LoadBalance = boolPtr(current.LoadBalanceEnabled)
	}
	if p.IncludeCacheHit == nil {
		p.IncludeCacheHit = boolPtr(current.IncludeCacheHitRate)
	}
	if p.IncludeProvider == nil {
		p.IncludeProvider = boolPtr(current.IncludeProviderSelf)
	}
	if p.IncludeOfficial == nil {
		p.IncludeOfficial = boolPtr(current.IncludeOfficialChannels)
	}
	if p.IncludeShared == nil {
		p.IncludeShared = boolPtr(current.IncludeSharedSubscriptions)
	}
	if p.OfficialMaxDisc == 0 {
		p.OfficialMaxDisc = float64(current.OfficialKeyMaxDiscount)
	}
	if p.SharedMaxDisc == 0 {
		p.SharedMaxDisc = float64(current.SharedSubscriptionMaxDisc)
	}
	if p.OfficialChannel == 0 {
		p.OfficialChannel = current.OfficialChannelID
	}
	if p.Unlimited == nil {
		p.Unlimited = boolPtr(current.UnlimitedQuota)
	}
	if p.Quota == 0 && p.QuotaUSD == 0 && current.RemainQuota > 0 {
		p.Quota = float64(current.RemainQuota)
	}
	if p.Expires == nil && p.ExpiresIn == "" {
		if current.ExpiredTime > 0 {
			p.Expires = int64Ptr(current.ExpiredTime)
		} else {
			p.Expires = int64Ptr(-1)
		}
	}
	if p.AllowIPs == "" {
		p.AllowIPs = current.AllowIPs
	}
	if !p.CrossGroupOnly {
		p.CrossGroupOnly = current.CrossGroupRetry
	}
	if p.Group == "" {
		p.Group = current.Group
	}
	if p.KeyGroupID == 0 {
		p.KeyGroupID = current.KeyGroupID
	}
	// A stored fixed key keeps its pinned group.
	if current.ProviderSlug() != "" {
		p.Kind = string(api.KindFixed)
	}

	spec, err := p.TokenSpec.spec(c.Options.QuotaPerUnit)
	if err != nil {
		return nil, err
	}
	payload := spec.Payload()
	payload["id"] = p.ID
	return c.API.UpdateToken(ctx, payload)
}

func tokenDelete(ctx context.Context, c *Client, p struct {
	ID int `json:"id"`
}) (any, error) {
	if p.ID == 0 {
		return nil, &Error{Message: "id is required", Type: "invalid_params"}
	}
	if err := c.API.DeleteToken(ctx, p.ID); err != nil {
		return nil, err
	}
	return map[string]any{"deleted": p.ID}, nil
}

func tokenDeleteBatch(ctx context.Context, c *Client, p struct {
	IDs []int `json:"ids"`
}) (any, error) {
	if len(p.IDs) == 0 {
		return nil, &Error{Message: "ids is required", Type: "invalid_params"}
	}
	if err := c.API.DeleteTokens(ctx, p.IDs); err != nil {
		return nil, err
	}
	return map[string]any{"deleted": p.IDs}, nil
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

func modelList(ctx context.Context, c *Client, p struct {
	PageParams
	Category   string `json:"category,omitempty"`
	ProviderID int    `json:"provider_id,omitempty"`
}) (any, error) {
	models, total, err := fetchModels(ctx, c.API, p.PageParams, p.Category, p.ProviderID)
	if err != nil {
		return nil, err
	}
	models = api.FilterModels(models, p.Search)
	api.SortModels(models, p.Sort, p.desc())
	models = slice(models, p.PageParams, p.size(50))
	return map[string]any{"items": models, "total": total, "page": p.page()}, nil
}

// fetchModels loads models, walking pages when a local sort is requested.
func fetchModels(ctx context.Context, cl *api.Client, p PageParams, category string, providerID int) ([]api.MarketplaceModel, int, error) {
	size := p.size(50)
	q := api.ModelQuery{Keyword: p.Search, Category: category, ProviderID: providerID, PageSize: size}
	if p.Sort == "" {
		q.Page = p.page()
		page, err := cl.ListMarketplaceModels(ctx, q)
		if err != nil {
			return nil, 0, err
		}
		return page.Items, page.Total, nil
	}
	// A local sort needs every page, so fetch them in parallel.
	q.Page = 1
	first, err := cl.ListMarketplaceModels(ctx, q)
	if err != nil {
		return nil, 0, err
	}
	all := first.Items
	pages := 1
	if first.Total > size {
		pages = (first.Total + size - 1) / size
	}
	if pages > 1 {
		rest, err := api.ConcurrentPages(ctx, pages-1, 4, func(ctx context.Context, page int) ([]api.MarketplaceModel, int, error) {
			pq := q
			pq.Page = page + 1
			res, err := cl.ListMarketplaceModels(ctx, pq)
			if err != nil {
				return nil, 0, err
			}
			return res.Items, res.Total, nil
		})
		if err != nil {
			return nil, 0, err
		}
		all = append(all, rest...)
	}
	return all, first.Total, nil
}

func modelShow(ctx context.Context, c *Client, p struct {
	ID int `json:"id"`
}) (any, error) {
	if p.ID == 0 {
		return nil, &Error{Message: "id is required", Type: "invalid_params"}
	}
	return c.API.GetMarketplaceModel(ctx, p.ID)
}

func modelPricing(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetPricing(ctx)
}

func modelOptions(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetModelOptions(ctx)
}

func modelRouting(ctx context.Context, c *Client, p PageParams) (any, error) {
	models, err := c.API.GetSubrouterModels(ctx)
	if err != nil {
		return nil, err
	}
	api.SortSubrouterModels(models, p.Sort, p.desc())
	models = slice(models, p, p.size(50))
	return map[string]any{"items": models, "total": len(models)}, nil
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

func providerList(ctx context.Context, c *Client, p PageParams) (any, error) {
	providers, total, err := fetchProviders(ctx, c.API, p)
	if err != nil {
		return nil, err
	}
	providers = api.FilterProviders(providers, p.Search)
	api.SortProviders(providers, p.Sort, p.desc())
	providers = slice(providers, p, p.size(50))
	return map[string]any{"items": providers, "total": total, "page": p.page()}, nil
}

// fetchProviders loads providers, walking pages when a local sort is
// requested.
func fetchProviders(ctx context.Context, cl *api.Client, p PageParams) ([]api.MarketplaceProvider, int, error) {
	size := p.size(50)
	q := api.ProviderQuery{Keyword: p.Search, PageSize: size}
	if p.Sort == "" {
		q.Page = p.page()
		page, err := cl.ListMarketplaceProviders(ctx, q)
		if err != nil {
			return nil, 0, err
		}
		return page.Items, page.Total, nil
	}
	q.Page = 1
	first, err := cl.ListMarketplaceProviders(ctx, q)
	if err != nil {
		return nil, 0, err
	}
	all := first.Items
	pages := 1
	if first.Total > size {
		pages = (first.Total + size - 1) / size
	}
	if pages > 1 {
		rest, err := api.ConcurrentPages(ctx, pages-1, 8, func(ctx context.Context, page int) ([]api.MarketplaceProvider, int, error) {
			pq := q
			pq.Page = page + 1
			res, err := cl.ListMarketplaceProviders(ctx, pq)
			if err != nil {
				return nil, 0, err
			}
			return res.Items, res.Total, nil
		})
		if err != nil {
			return nil, 0, err
		}
		all = append(all, rest...)
	}
	return all, first.Total, nil
}

func providerShow(ctx context.Context, c *Client, p struct {
	Slug string `json:"slug"`
}) (any, error) {
	if p.Slug == "" {
		return nil, &Error{Message: "slug is required", Type: "invalid_params"}
	}
	return c.API.GetMarketplaceProvider(ctx, p.Slug)
}

func providerModels(ctx context.Context, c *Client, p struct {
	PageParams
	Slug string `json:"slug"`
}) (any, error) {
	if p.Slug == "" {
		return nil, &Error{Message: "slug is required", Type: "invalid_params"}
	}
	detail, err := c.API.GetMarketplaceProvider(ctx, p.Slug)
	if err != nil {
		return nil, err
	}
	models := slice(detail.Models, p.PageParams, p.size(50))
	return map[string]any{"items": models, "total": len(detail.Models)}, nil
}

func providerSubs(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.ListProviderSubscriptions(ctx)
}

func providerSubscribe(ctx context.Context, c *Client, p struct {
	ProviderID int `json:"provider_id"`
}) (any, error) {
	if p.ProviderID == 0 {
		return nil, &Error{Message: "provider_id is required", Type: "invalid_params"}
	}
	return c.API.SubscribeProvider(ctx, p.ProviderID)
}

func providerUnsubscribe(ctx context.Context, c *Client, p struct {
	ProviderID int `json:"provider_id"`
}) (any, error) {
	if p.ProviderID == 0 {
		return nil, &Error{Message: "provider_id is required", Type: "invalid_params"}
	}
	if err := c.API.UnsubscribeProvider(ctx, p.ProviderID); err != nil {
		return nil, err
	}
	return map[string]any{"unsubscribed": p.ProviderID}, nil
}

func providerSubscribeAll(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.SubscribeAll(ctx)
}

func providerUnsubscribeAll(ctx context.Context, c *Client, p struct{}) (any, error) {
	if err := c.API.UnsubscribeAll(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"unsubscribed": "all"}, nil
}

func providerSubConfig(ctx context.Context, c *Client, p struct {
	AutoSubscribe *bool `json:"auto_subscribe,omitempty"`
}) (any, error) {
	if p.AutoSubscribe == nil {
		return c.API.GetSubscriptionConfig(ctx)
	}
	return c.API.UpdateSubscriptionConfig(ctx, map[string]any{"auto_subscribe": *p.AutoSubscribe})
}

func providerShared(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetSharedProviders(ctx)
}

// ---------------------------------------------------------------------------
// Shared plans
// ---------------------------------------------------------------------------

func sharedList(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.ListSharedPlans(ctx)
}

func sharedSubscribe(ctx context.Context, c *Client, p struct {
	PlanID int `json:"plan_id"`
}) (any, error) {
	if p.PlanID == 0 {
		return nil, &Error{Message: "plan_id is required", Type: "invalid_params"}
	}
	return c.API.SubscribeSharedPlan(ctx, p.PlanID)
}

func sharedCancel(ctx context.Context, c *Client, p struct {
	PlanID int `json:"plan_id"`
}) (any, error) {
	if p.PlanID == 0 {
		return nil, &Error{Message: "plan_id is required", Type: "invalid_params"}
	}
	if err := c.API.CancelSharedPlan(ctx, p.PlanID); err != nil {
		return nil, err
	}
	return map[string]any{"cancelled": p.PlanID}, nil
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

func subscriptionList(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetSubscriptionState(ctx)
}

func subscriptionPlans(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.ListSubscriptionPlans(ctx)
}

func subscriptionPreference(ctx context.Context, c *Client, p struct {
	Priority string `json:"priority,omitempty"`
	Wallet   string `json:"wallet,omitempty"`
}) (any, error) {
	body := map[string]any{}
	if p.Priority != "" {
		body["priority"] = p.Priority
	}
	if p.Wallet != "" {
		body["wallet"] = p.Wallet
	}
	if len(body) == 0 {
		return nil, &Error{Message: "nothing to change: pass a priority or a wallet", Type: "invalid_params"}
	}
	return c.API.UpdateSubscriptionPreference(ctx, body)
}

func subscriptionPay(ctx context.Context, c *Client, p struct {
	PlanID   int            `json:"plan_id,omitempty"`
	Provider string         `json:"provider,omitempty"`
	Body     map[string]any `json:"body,omitempty"`
}) (any, error) {
	provider := api.PayProvider(p.Provider)
	switch provider {
	case api.PayStripe, api.PayCreem, api.PayEPay:
	case "":
		return nil, &Error{Message: "provider is required: stripe, creem or epay", Type: "invalid_params"}
	default:
		return nil, &Error{Message: fmt.Sprintf("unknown provider %q: stripe, creem or epay", p.Provider), Type: "invalid_params"}
	}
	body := map[string]any{}
	for k, v := range p.Body {
		body[k] = v
	}
	if p.PlanID > 0 {
		body["plan_id"] = p.PlanID
	}
	return c.API.CreatePlanCheckout(ctx, provider, body)
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

func taskList(ctx context.Context, c *Client, p struct {
	PageParams
	Action string `json:"action,omitempty"`
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	TaskID string `json:"task_id,omitempty"`
}) (any, error) {
	start, err := api.ParseTime(p.From, false)
	if err != nil {
		return nil, err
	}
	end, err := api.ParseTime(p.To, true)
	if err != nil {
		return nil, err
	}
	q := api.TaskQuery{
		Page:           p.page(),
		PageSize:       p.size(50),
		TaskID:         p.TaskID,
		Action:         p.Action,
		StartTimestamp: start,
		EndTimestamp:   end,
	}
	page, err := c.API.ListTasks(ctx, q)
	if err != nil {
		return nil, err
	}
	tasks := api.FilterTasks(page.Items, p.Search)
	api.SortTasks(tasks, p.Sort, p.desc())
	return map[string]any{"items": tasks, "total": page.Total, "page": page.Page}, nil
}

func taskShow(ctx context.Context, c *Client, p struct {
	TaskID string `json:"task_id"`
}) (any, error) {
	if p.TaskID == "" {
		return nil, &Error{Message: "task_id is required", Type: "invalid_params"}
	}
	return c.API.GetTask(ctx, p.TaskID)
}

// ---------------------------------------------------------------------------
// Merchant
// ---------------------------------------------------------------------------

func merchantSelf(ctx context.Context, c *Client, p struct {
	Body map[string]any `json:"body,omitempty"`
}) (any, error) {
	if len(p.Body) > 0 {
		return c.API.UpdateProviderSelf(ctx, p.Body)
	}
	return c.API.ProviderSelf(ctx)
}

func merchantChannels(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.ListProviderChannels(ctx)
}

func merchantChannelTest(ctx context.Context, c *Client, p struct {
	ID int `json:"id"`
}) (any, error) {
	if p.ID == 0 {
		return nil, &Error{Message: "id is required", Type: "invalid_params"}
	}
	return c.API.TestProviderChannel(ctx, p.ID)
}

func merchantModels(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.ListProviderModels(ctx, p.page(), p.size(50))
}

func merchantModelCreate(ctx context.Context, c *Client, p struct {
	Body map[string]any `json:"body"`
}) (any, error) {
	if len(p.Body) == 0 {
		return nil, &Error{Message: "body is required", Type: "invalid_params"}
	}
	return c.API.CreateProviderModel(ctx, p.Body)
}

func merchantModelUpdate(ctx context.Context, c *Client, p struct {
	ID   int            `json:"id"`
	Body map[string]any `json:"body"`
}) (any, error) {
	if p.ID == 0 {
		return nil, &Error{Message: "id is required", Type: "invalid_params"}
	}
	if len(p.Body) == 0 {
		return nil, &Error{Message: "body is required", Type: "invalid_params"}
	}
	return c.API.UpdateProviderModel(ctx, p.ID, p.Body)
}

func merchantModelBatch(ctx context.Context, c *Client, p struct {
	Variant string         `json:"variant,omitempty"`
	Body    map[string]any `json:"body"`
}) (any, error) {
	if len(p.Body) == 0 {
		return nil, &Error{Message: "body is required", Type: "invalid_params"}
	}
	variant := p.Variant
	if variant == "" {
		variant = "batch"
	}
	return c.API.ProviderModelBatch(ctx, variant, p.Body)
}

func merchantPricePreview(ctx context.Context, c *Client, p struct {
	Body map[string]any `json:"body"`
}) (any, error) {
	if len(p.Body) == 0 {
		return nil, &Error{Message: "body is required", Type: "invalid_params"}
	}
	return c.API.PreviewProviderModelPrice(ctx, p.Body)
}

func merchantEarnings(ctx context.Context, c *Client, p struct {
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Summary bool   `json:"summary,omitempty"`
}) (any, error) {
	q, err := earningsQuery(p.From, p.To)
	if err != nil {
		return nil, err
	}
	if p.Summary {
		return c.API.GetProviderEarningsSummary(ctx, q)
	}
	return c.API.GetProviderEarnings(ctx, q)
}

func merchantPayouts(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.GetProviderPayouts(ctx)
}

func merchantRegister(ctx context.Context, c *Client, p struct {
	Body map[string]any `json:"body"`
}) (any, error) {
	if len(p.Body) == 0 {
		return nil, &Error{Message: "body is required", Type: "invalid_params"}
	}
	return c.API.RegisterProvider(ctx, p.Body)
}

// earningsQuery builds the time window of the earnings endpoints.
func earningsQuery(from, to string) (api.ProviderEarningsQuery, error) {
	start, err := api.ParseTime(from, false)
	if err != nil {
		return api.ProviderEarningsQuery{}, err
	}
	end, err := api.ParseTime(to, true)
	if err != nil {
		return api.ProviderEarningsQuery{}, err
	}
	if start == 0 {
		start = api.StartOfToday()
	}
	if end == 0 {
		end = api.StartOfToday()
	}
	return api.ProviderEarningsQuery{StartTime: start, EndTime: end}, nil
}

// ---------------------------------------------------------------------------
// Station
// ---------------------------------------------------------------------------

func stationSelf(ctx context.Context, c *Client, p struct {
	Body map[string]any `json:"body,omitempty"`
}) (any, error) {
	if len(p.Body) > 0 {
		return c.API.UpdateDistributorSelf(ctx, p.Body)
	}
	return c.API.DistributorSelf(ctx)
}

func stationDashboard(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.DistributorDashboard(ctx)
}

func stationCustomers(ctx context.Context, c *Client, p struct {
	PageParams
	Keyword string `json:"keyword,omitempty"`
}) (any, error) {
	return c.API.ListDistributorCustomers(ctx, p.Keyword, p.page(), p.size(50))
}

func stationModels(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.ListDistributorModels(ctx, p.page(), p.size(50))
}

func stationGlobalModels(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.ListDistributorGlobalModels(ctx)
}

func stationKeyGroups(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.ListDistributorKeyGroups(ctx)
}

func stationShared(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.ListDistributorSharedSubscriptions(ctx)
}

func stationOfficialChannels(ctx context.Context, c *Client, p struct{}) (any, error) {
	return c.API.ListDistributorOfficialChannels(ctx)
}

func stationPackages(ctx context.Context, c *Client, p PageParams) (any, error) {
	return c.API.ListDistributorPackages(ctx)
}

func stationLogs(ctx context.Context, c *Client, p LogParams) (any, error) {
	q, err := p.query()
	if err != nil {
		return nil, err
	}
	return c.API.GetDistributorLogs(ctx, q)
}

func stationEarnings(ctx context.Context, c *Client, p struct {
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Summary bool   `json:"summary,omitempty"`
}) (any, error) {
	start, err := api.ParseTime(p.From, false)
	if err != nil {
		return nil, err
	}
	end, err := api.ParseTime(p.To, true)
	if err != nil {
		return nil, err
	}
	if start == 0 {
		start = api.StartOfToday()
	}
	if end == 0 {
		end = api.StartOfToday()
	}
	q := api.LogQuery{PageSize: api.MaxLogPageSize, StartTimestamp: start, EndTimestamp: end}
	if p.Summary {
		return c.API.GetDistributorEarningsSummary(ctx, q)
	}
	return c.API.GetDistributorEarnings(ctx, q)
}

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

// rawRequest performs an arbitrary management request. It exists so that an
// endpoint without a dedicated method stays reachable.
func rawRequest(ctx context.Context, c *Client, p struct {
	Method string         `json:"method"`
	Path   string         `json:"path"`
	Body   map[string]any `json:"body,omitempty"`
}) (any, error) {
	if p.Path == "" {
		return nil, &Error{Message: "path is required", Type: "invalid_params"}
	}
	method := strings.ToUpper(p.Method)
	if method == "" {
		method = "GET"
	}
	raw, err := c.API.Raw(ctx, method, p.Path, p.Body)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// splitList splits a comma separated value.
func splitList(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
