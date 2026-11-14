package api

import (
	"encoding/json"
	"strconv"
	"strings"
)

// FlexString decodes a JSON string, number or boolean into text. The platform
// returns the same field as different types across endpoints.
type FlexString string

// UnmarshalJSON implements json.Unmarshaler.
func (f *FlexString) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*f = ""
		return nil
	}
	var str string
	if err := json.Unmarshal(b, &str); err == nil {
		*f = FlexString(str)
		return nil
	}
	var num json.Number
	if err := json.Unmarshal(b, &num); err == nil {
		*f = FlexString(num.String())
		return nil
	}
	var boolean bool
	if err := json.Unmarshal(b, &boolean); err == nil {
		*f = FlexString(strconv.FormatBool(boolean))
		return nil
	}
	*f = FlexString(s)
	return nil
}

// String renders the value.
func (f FlexString) String() string { return string(f) }

// FlexInt decodes a JSON number into an integer. It also accepts an object
// carrying a token count so that the same field can be read either way.
type FlexInt int64

// UnmarshalJSON implements json.Unmarshaler.
func (f *FlexInt) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	var num json.Number
	if err := json.Unmarshal(b, &num); err == nil {
		v, err := num.Int64()
		if err != nil {
			fv, ferr := num.Float64()
			if ferr != nil {
				return err
			}
			*f = FlexInt(fv)
			return nil
		}
		*f = FlexInt(v)
		return nil
	}
	var obj struct {
		Total            int64 `json:"total"`
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	}
	if err := json.Unmarshal(b, &obj); err == nil {
		if obj.Total != 0 {
			*f = FlexInt(obj.Total)
			return nil
		}
		*f = FlexInt(obj.PromptTokens + obj.CompletionTokens)
		return nil
	}
	*f = 0
	return nil
}

// Int returns the value as an int.
func (f FlexInt) Int() int { return int(f) }

// User is the account record returned by GET /api/user/self.
type User struct {
	ID           int     `json:"id"`
	Username     string  `json:"username"`
	DisplayName  string  `json:"display_name"`
	Email        string  `json:"email"`
	Role         int     `json:"role"`
	Group        string  `json:"group"`
	Quota        float64 `json:"quota"`
	UsedQuota    float64 `json:"used_quota"`
	RequestCount int     `json:"request_count"`
	Status       int     `json:"status"`
	AffCode      string  `json:"aff_code"`
	AffQuota     float64 `json:"aff_quota"`
	InviterID    int     `json:"inviter_id"`
	DeletedAt    any     `json:"deleted_at"`
	CreatedTime  int64   `json:"created_time"`
}

// Token is a model API key.
type Token struct {
	ID                         int     `json:"id"`
	UserID                     int     `json:"user_id"`
	Name                       string  `json:"name"`
	Key                        string  `json:"key"`
	Status                     int     `json:"status"`
	CreatedTime                int64   `json:"created_time"`
	AccessedTime               int64   `json:"accessed_time"`
	ExpiredTime                int64   `json:"expired_time"`
	RemainQuota                float64 `json:"remain_quota"`
	UnlimitedQuota             bool    `json:"unlimited_quota"`
	UsedQuota                  float64 `json:"used_quota"`
	ModelLimitsEnabled         bool    `json:"model_limits_enabled"`
	ModelLimits                string  `json:"model_limits"`
	AllowIPs                   string  `json:"allow_ips"`
	Group                      string  `json:"group"`
	CrossGroupRetry            bool    `json:"cross_group_retry"`
	LoadBalanceEnabled         bool    `json:"load_balance_enabled"`
	DistributorID              int     `json:"distributor_id"`
	KeyGroupID                 int     `json:"key_group_id"`
	OfficialChannelID          int     `json:"official_channel_id"`
	OfficialKeyMaxDiscount     float64 `json:"official_key_max_discount"`
	SharedSubscriptionMaxDisc  float64 `json:"shared_subscription_max_discount"`
	IncludeCacheHitRate        bool    `json:"include_cache_hit_rate"`
	IncludeProviderSelf        bool    `json:"include_provider_self"`
	IncludeOfficialChannels    bool    `json:"include_official_channels"`
	IncludeSharedSubscriptions bool    `json:"include_shared_subscriptions"`
	SubrouterProviders         string  `json:"subrouter_providers"`
	SubrouterModelProviders    string  `json:"subrouter_model_providers"`
	SubrouterModelPriceLimits  string  `json:"subrouter_model_price_limits"`
	SubrouterSortMode          string  `json:"subrouter_sort_mode"`
	SubrouterRoutePreference   string  `json:"subrouter_route_preference"`
}

// TokenKind classifies a token the same way the SubRouter console does.
type TokenKind string

// The four token kinds the console exposes.
const (
	KindSmart    TokenKind = "smart"
	KindOfficial TokenKind = "official"
	KindShared   TokenKind = "shared"
	KindFixed    TokenKind = "fixed"
	KindAuto     TokenKind = "auto"
	KindAll      TokenKind = "all"
)

// FullKey returns the relay key in its sk- form. The list endpoint stores the
// key without the prefix while the create response includes it.
func (t Token) FullKey() string {
	if strings.HasPrefix(t.Key, "sk-") {
		return t.Key
	}
	return "sk-" + t.Key
}

// Kind reports the console classification of the token.
func (t Token) Kind() TokenKind {
	g := t.Group
	if t.OfficialChannelID > 0 || g == "dist_official" {
		return KindOfficial
	}
	if strings.HasPrefix(g, "provider:") || strings.HasPrefix(g, "official:") {
		return KindFixed
	}
	if g == "subrouter" {
		off := t.IncludeOfficialChannels
		prov := t.IncludeProviderSelf
		shared := t.IncludeSharedSubscriptions
		if off && !prov && !shared {
			return KindOfficial
		}
		if shared && !prov && !off {
			return KindShared
		}
	}
	if g == "auto" {
		return KindAuto
	}
	return KindSmart
}

// ProviderSlug returns the pinned provider slug for a fixed token.
func (t Token) ProviderSlug() string {
	g := t.Group
	for _, p := range []string{"provider:", "official:"} {
		if strings.HasPrefix(g, p) {
			return strings.TrimPrefix(g, p)
		}
	}
	return ""
}

// Providers returns the provider slugs attached to a smart-routing token.
func (t Token) Providers() []string {
	if t.SubrouterProviders == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(t.SubrouterProviders, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Models returns the model whitelist of a token.
func (t Token) Models() []string {
	if t.ModelLimits == "" {
		return nil
	}
	var out []string
	for _, m := range strings.Split(t.ModelLimits, ",") {
		m = strings.TrimSpace(m)
		if m != "" {
			out = append(out, m)
		}
	}
	return out
}

// ModelProviderMap decodes the per-model provider pinning of a token.
func (t Token) ModelProviderMap() map[string][]string {
	if t.SubrouterModelProviders == "" {
		return nil
	}
	var m map[string][]string
	if err := json.Unmarshal([]byte(t.SubrouterModelProviders), &m); err != nil {
		return nil
	}
	return m
}

// ModelPriceLimitMap decodes the per-model price caps of a token.
func (t Token) ModelPriceLimitMap() map[string]any {
	if t.SubrouterModelPriceLimits == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(t.SubrouterModelPriceLimits), &m); err != nil {
		return nil
	}
	return m
}

// MarketplaceModel is one row of the public model directory.
type MarketplaceModel struct {
	ID                  FlexString     `json:"id"`
	ModelName           string         `json:"model_name"`
	UpstreamModel       string         `json:"upstream_model"`
	ProviderID          FlexString     `json:"provider_id"`
	ProviderName        string         `json:"provider_name"`
	ProviderSlug        string         `json:"provider_slug"`
	Category            string         `json:"category"`
	BillingMode         string         `json:"billing_mode"`
	InputPrice          float64        `json:"input_price"`
	OutputPrice         float64        `json:"output_price"`
	FixedPrice          float64        `json:"fixed_price"`
	PriceCurrency       string         `json:"price_currency"`
	ContextLength       int            `json:"context_length"`
	Status              FlexString     `json:"status"`
	Source              string         `json:"source"`
	Rating              float64        `json:"rating"`
	Availability        float64        `json:"availability"`
	AvgLatency          float64        `json:"avg_latency"`
	MedianTTFT          float64        `json:"median_ttft"`
	CacheHitRate        float64        `json:"cache_hit_rate"`
	TotalRequests       int64          `json:"total_requests"`
	TotalTokens         int64          `json:"total_tokens"`
	CreatedTime         int64          `json:"created_time"`
	UpdatedTime         int64          `json:"updated_time"`
	Endpoints           string         `json:"endpoints"`
	Features            string         `json:"features"`
	Description         string         `json:"description"`
	Region              string         `json:"region"`
	RoutingMode         string         `json:"routing_mode"`
	PricingStrategy     string         `json:"pricing_strategy"`
	PricingSource       string         `json:"pricing_source"`
	ProviderLogo        string         `json:"provider_logo"`
	OfficialInputPrice  float64        `json:"official_input_price"`
	OfficialOutputPrice float64        `json:"official_output_price"`
	OfficialFixedPrice  float64        `json:"official_fixed_price"`
	OfficialDiscount    float64        `json:"official_discount_percent"`
	CacheReadPrice      float64        `json:"cache_read_price"`
	CacheCreationPrice  float64        `json:"cache_creation_price"`
	ProbeScore          float64        `json:"probe_score"`
	LastCallTime        int64          `json:"last_call_time"`
	IsPublic            bool           `json:"is_public"`
	ParamsDoc           string         `json:"params_doc"`
	AvailabilityWindow  []Availability `json:"availability_windows"`
}

// ProviderDetail is the response of GET /api/marketplace/providers/{slug}.
type ProviderDetail struct {
	Provider           MarketplaceProvider `json:"provider"`
	Models             []MarketplaceModel  `json:"models"`
	PublicModelCount   int                 `json:"public_model_count"`
	FilteredModelCount int                 `json:"filtered_model_count"`
}

// Availability is one uptime bucket of a marketplace model.
type Availability struct {
	BucketTime    int64   `json:"bucket_time"`
	BucketSeconds int     `json:"bucket_seconds"`
	Availability  float64 `json:"availability"`
	Successes     int     `json:"successes"`
	Total         int     `json:"total"`
}

// MarketplaceProvider is one row of the provider directory.
type MarketplaceProvider struct {
	ID                FlexString `json:"id"`
	Slug              string     `json:"slug"`
	CompanyName       string     `json:"company_name"`
	Description       string     `json:"description"`
	Logo              string     `json:"logo"`
	Status            FlexString `json:"status"`
	Verified          bool       `json:"verified"`
	Rating            float64    `json:"rating"`
	Availability      float64    `json:"availability"`
	ModelCount        int        `json:"model_count"`
	AnomalyModelCount int        `json:"anomaly_model_count"`
	BlacklistCount    int        `json:"blacklist_count"`
	CreditScore       float64    `json:"credit_score"`
	DepositUSD        float64    `json:"deposit_usd"`
	GuaranteeUSD      float64    `json:"guarantee_amount_usd"`
	GuaranteeLevel    FlexString `json:"guarantee_level"`
	MaxRPM            int        `json:"max_rpm"`
	SubscriptionCount int        `json:"subscription_count"`
	CreatedTime       int64      `json:"created_time"`
	UpdatedTime       int64      `json:"updated_time"`
}

// SubrouterModel is one smart-routing model with its provider offers.
type SubrouterModel struct {
	ModelName     string          `json:"model_name"`
	Category      string          `json:"category"`
	BillingMode   string          `json:"billing_mode"`
	MinInputPrice float64         `json:"min_input_price"`
	MinOutputPr   float64         `json:"min_output_price"`
	MinFixedPrice float64         `json:"min_fixed_price"`
	PriceCurrency string          `json:"price_currency"`
	PricingSource string          `json:"pricing_source"`
	ProviderCount int             `json:"provider_count"`
	Providers     []ModelProvider `json:"providers"`
}

// ModelProvider is one provider offer of a smart-routing model.
type ModelProvider struct {
	ProviderID    int     `json:"provider_id"`
	ProviderSlug  string  `json:"provider_slug"`
	ProviderName  string  `json:"provider_name"`
	BillingMode   string  `json:"billing_mode"`
	MinInputPrice float64 `json:"min_input_price"`
	MinOutputPr   float64 `json:"min_output_price"`
	MinFixedPrice float64 `json:"min_fixed_price"`
}

// Group is one routing group available to the account.
type Group struct {
	Key          string  `json:"-"`
	Desc         string  `json:"desc"`
	Ratio        float64 `json:"ratio"`
	Logo         string  `json:"logo"`
	ProviderSlug string  `json:"provider_slug"`
	Source       string  `json:"source"`
	SharedPlanID int     `json:"shared_plan_id"`
}

// GroupMap is the response of GET /api/user/self/groups.
type GroupMap map[string]Group

// LogEntry is one usage log row. Every field the platform returns is kept so
// that no detail is lost between the API and the terminal.
type LogEntry struct {
	ID                int      `json:"id"`
	UserID            int      `json:"user_id"`
	CreatedAt         int64    `json:"created_at"`
	Type              int      `json:"type"`
	Content           string   `json:"content"`
	Username          string   `json:"username"`
	TokenName         string   `json:"token_name"`
	ModelName         string   `json:"model_name"`
	Quota             float64  `json:"quota"`
	PromptTokens      int      `json:"prompt_tokens"`
	CompletionTokens  int      `json:"completion_tokens"`
	UseTime           float64  `json:"use_time"`
	IsStream          bool     `json:"is_stream"`
	Channel           int      `json:"channel"`
	ChannelName       string   `json:"channel_name"`
	TokenID           int      `json:"token_id"`
	Group             string   `json:"group"`
	IP                string   `json:"ip"`
	RequestID         string   `json:"request_id"`
	UpstreamRequestID string   `json:"upstream_request_id"`
	DistributorID     int      `json:"distributor_id"`
	NodeName          string   `json:"node_name"`
	UseGroup          string   `json:"use_group"`
	Other             LogOther `json:"other"`
}

// LogOther is the performance payload attached to a usage log entry. The
// platform sends it as a JSON string and keeps adding fields to it, so it is
// held as a map: nothing the API returns is ever dropped.
type LogOther map[string]any

// UnmarshalJSON accepts the string encoded and the plain object form.
func (o *LogOther) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*o = LogOther{}
		return nil
	}
	if s[0] == '"' {
		var inner string
		if err := json.Unmarshal(b, &inner); err != nil {
			return nil
		}
		inner = strings.TrimSpace(inner)
		if inner == "" || inner == "null" {
			*o = LogOther{}
			return nil
		}
		b = []byte(inner)
	}
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil
	}
	*o = m
	return nil
}

// Int returns an integer field of the payload.
func (o LogOther) Int(key string) int64 {
	switch v := o[key].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}

// Float returns a floating point field of the payload.
func (o LogOther) Float(key string) float64 {
	switch v := o[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	}
	return 0
}

// String returns a string field of the payload.
func (o LogOther) String(key string) string {
	if v, ok := o[key].(string); ok {
		return v
	}
	return ""
}

// FRT returns the time to first token in milliseconds.
func (o LogOther) FRT() int64 { return o.Int("frt") }

// CacheTokens returns the number of prompt tokens served from the cache.
func (o LogOther) CacheTokens() int64 { return o.Int("cache_tokens") }

// ProviderSlug returns the slug of the provider that served the call.
func (o LogOther) ProviderSlug() string { return o.String("provider_slug") }

// ProviderName returns the name of the provider that served the call.
func (o LogOther) ProviderName() string { return o.String("provider_name") }

// IsConsumption reports whether the entry is a model call rather than a
// top-up or a system event.
func (e LogEntry) IsConsumption() bool { return e.Type == LogTypeConsume }

// FirstResponseTimeMs returns the time to first token in milliseconds.
func (e LogEntry) FirstResponseTimeMs() int64 { return e.Other.FRT() }

// OutputTPS returns the generation throughput in output tokens per second.
//
// The SubRouter console computes it exactly this way: the completion tokens
// divided by the total request duration. A non streaming response has no
// meaningful throughput, so the console does not show one.
func (e LogEntry) OutputTPS() float64 {
	if e.UseTime <= 0 || e.CompletionTokens <= 0 {
		return 0
	}
	return float64(e.CompletionTokens) / e.UseTime
}

// ShowsTPS reports whether the console would show a throughput figure.
func (e LogEntry) ShowsTPS() bool { return e.IsStream && e.OutputTPS() > 0 }

// Log types reported by the platform.
const (
	// LogTypeAll matches every log entry.
	LogTypeAll = 0
	// LogTypeTopup is a wallet top-up.
	LogTypeTopup = 1
	// LogTypeConsume is a model call.
	LogTypeConsume = 2
	// LogTypeError is a failed request.
	LogTypeError = 5
)

// LogStat is the aggregate usage summary.
type LogStat struct {
	Quota float64 `json:"quota"`
	RPM   int     `json:"rpm"`
	// Token is the total token count. Some deployments answer with a
	// prompt/completion breakdown instead, which FlexInt folds into one number.
	Token FlexInt `json:"token"`
	TPM   int     `json:"tpm"`
}

// DataPoint is one day of per-day quota usage for a single model.
type DataPoint struct {
	ID        int     `json:"id"`
	UserID    int     `json:"user_id"`
	Username  string  `json:"username"`
	ModelName string  `json:"model_name"`
	CreatedAt int64   `json:"created_at"`
	UseGroup  string  `json:"use_group"`
	TokenID   int     `json:"token_id"`
	ChannelID int     `json:"channel_id"`
	NodeName  string  `json:"node_name"`
	TokenUsed int64   `json:"token_used"`
	Count     int     `json:"count"`
	Quota     float64 `json:"quota"`
}

// Task is one asynchronous media task record.
type Task struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Action    string `json:"action"`
	Model     string `json:"model"`
	Status    string `json:"status"`
	Progress  int    `json:"progress"`
	CreatedAt int64  `json:"created_at"`
	Quota     int64  `json:"quota"`
	Error     any    `json:"error"`
	Result    struct {
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
		Videos []struct {
			URL string `json:"url"`
		} `json:"videos"`
	} `json:"result"`
}

// SharedPlan is one shared-pool subscription plan.
type SharedPlan struct {
	Plan struct {
		ID                 int    `json:"id"`
		Slug               string `json:"slug"`
		Title              string `json:"title"`
		Description        string `json:"description"`
		Vendor             string `json:"vendor"`
		Tier               string `json:"tier"`
		Status             string `json:"status"`
		DefaultDiscountBPS int    `json:"default_discount_bps"`
		CreatedAt          string `json:"created_at"`
		UpdatedAt          string `json:"updated_at"`
	} `json:"plan"`
	Subscribed bool `json:"subscribed"`
	PoolStatus struct {
		Health               string `json:"health"`
		TotalAccounts        int    `json:"total_accounts"`
		AvailableAccounts    int    `json:"available_accounts"`
		TotalConcurrency     int    `json:"total_concurrency"`
		AvailableConcurrency int    `json:"available_concurrency"`
		PausedAccounts       int    `json:"paused_accounts"`
		RateLimitedAccounts  int    `json:"rate_limited_accounts"`
		ErrorAccounts        int    `json:"error_accounts"`
		LastSyncedAt         string `json:"last_synced_at"`
		NextRecoveryAt       string `json:"next_recovery_at"`
	} `json:"pool_status"`
	SupplyCount int     `json:"supply_count"`
	ProbeScore  float64 `json:"probe_score"`
	Models      []struct {
		ID            int     `json:"id"`
		ModelName     string  `json:"model_name"`
		InputPrice    float64 `json:"input_price"`
		OutputPrice   float64 `json:"output_price"`
		FixedPrice    float64 `json:"fixed_price"`
		PriceCurrency string  `json:"price_currency"`
		Protocol      string  `json:"protocol"`
		Status        string  `json:"status"`
	} `json:"models"`
}

// SubscriptionPlan is a purchasable paid account plan.
type SubscriptionPlan struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Price       float64 `json:"price"`
	Quota       float64 `json:"quota"`
	Duration    int     `json:"duration"`
	Status      string  `json:"status"`
	Description string  `json:"description"`
}

// SubscriptionState is the response of GET /api/subscription/self.
type SubscriptionState struct {
	Subscriptions     []map[string]any `json:"subscriptions"`
	AllSubscriptions  []map[string]any `json:"all_subscriptions"`
	BillingPreference any              `json:"billing_preference"`
}

// ProviderSubscription is one subscribed provider row.
type ProviderSubscription struct {
	ID                int        `json:"id"`
	Slug              string     `json:"slug"`
	CompanyName       string     `json:"company_name"`
	Status            FlexString `json:"status"`
	Balance           float64    `json:"balance"`
	CommissionRate    float64    `json:"commission_rate"`
	ModelCount        int        `json:"model_count"`
	SubscriptionCount int        `json:"subscription_count"`
	AutoProbeEnabled  bool       `json:"auto_probe_enabled"`
	CreatedTime       int64      `json:"created_time"`
	UpdatedTime       int64      `json:"updated_time"`
}

// SubscriptionConfig is the provider auto-subscribe configuration.
type SubscriptionConfig struct {
	AutoSubscribeNew bool  `json:"auto_subscribe_new"`
	BlacklistedCount int   `json:"blacklisted_count"`
	EligibleCount    int   `json:"eligible_count"`
	SubscribedCount  int   `json:"subscribed_count"`
	BlacklistedIDs   []int `json:"blacklisted_provider_ids"`
}

// TopupInfo describes the available top-up methods.
type TopupInfo struct {
	AmountOptions  []float64 `json:"amount_options"`
	Discount       any       `json:"discount"`
	MinTopUp       float64   `json:"min_topup"`
	CryptoWallets  any       `json:"crypto_wallets"`
	CreemProducts  any       `json:"creem_products"`
	PaymentMethods any       `json:"payment_methods"`
}

// TopupRecord is one top-up history row.
type TopupRecord struct {
	ID           int     `json:"id"`
	Amount       float64 `json:"amount"`
	Money        float64 `json:"money"`
	CreateTime   int64   `json:"create_time"`
	CompleteTime int64   `json:"complete_time"`
	Status       string  `json:"status"`
	TradeNo      string  `json:"trade_no"`
}

// AffSummary is the referral dashboard. The endpoint answers with the plain
// invite code, so the surrounding numbers come from the earnings endpoint.
type AffSummary struct {
	AffCode      string  `json:"aff_code"`
	AffQuota     float64 `json:"aff_quota"`
	InviterID    int     `json:"inviter_id"`
	TotalInvites int     `json:"total_invites"`
	TotalQuota   float64 `json:"total_quota"`
}

// SiteStatus is the public site configuration from GET /api/status.
type SiteStatus struct {
	SystemName        string  `json:"system_name"`
	ServerAddress     string  `json:"server_address"`
	Version           string  `json:"version"`
	QuotaPerUnit      float64 `json:"quota_per_unit"`
	UsdExchangeRate   float64 `json:"usd_exchange_rate"`
	DisplayInCurrency bool    `json:"display_in_currency"`
	EnableTask        bool    `json:"enable_task"`
	EnableDrawing     bool    `json:"enable_drawing"`
	StartTime         int64   `json:"start_time"`
	Announcements     []any   `json:"announcements"`
}

// StatusLabel maps a provider status value to a readable label.
func (p MarketplaceProvider) StatusLabel() string {
	switch strings.TrimSpace(string(p.Status)) {
	case "1":
		return "active"
	case "2":
		return "disabled"
	case "3":
		return "pending"
	case "":
		return "unknown"
	default:
		return string(p.Status)
	}
}

// StatusLabel maps a subscription status value to a readable label.
func (p ProviderSubscription) StatusLabel() string {
	switch strings.TrimSpace(string(p.Status)) {
	case "1":
		return "active"
	case "2":
		return "disabled"
	case "3":
		return "pending"
	case "":
		return "unknown"
	default:
		return string(p.Status)
	}
}

// StatusLabel maps a token status code to a readable label.
func StatusLabel(status int) string {
	switch status {
	case 1:
		return "enabled"
	case 2:
		return "disabled"
	case 3:
		return "expired"
	case 4:
		return "exhausted"
	default:
		return "unknown"
	}
}

// FormatQuota converts quota units to a USD string using the given ratio.
func FormatQuota(q float64, perUnit float64) string {
	if perUnit <= 0 {
		perUnit = 500000
	}
	return "$" + strconv.FormatFloat(q/perUnit, 'f', 2, 64)
}
