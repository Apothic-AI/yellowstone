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

	// Platform-measured generation speed of this provider's offer of the
	// model, in output tokens per second, and the number of measured samples
	// it rests on. OutputTokensPerSecond is only meaningful when
	// OutputSpeedSamples is greater than zero; the platform omits both for an
	// offer it has not measured yet.
	OutputTokensPerSecond float64 `json:"output_tokens_per_second"`
	OutputSpeedSamples    int     `json:"output_speed_samples"`

	// Probe detail behind ProbeScore. ProbeScoreAvailable reports whether the
	// platform has a usable score, ProbeScoreBuiltin whether the built-in
	// probe produced it, and ProbeScoreCount how many probes it averages.
	// ProbeResults holds the per-probe records keyed by probe source.
	ProbeScoreAvailable bool                   `json:"probe_score_available"`
	ProbeScoreBuiltin   bool                   `json:"probe_score_builtin"`
	ProbeScoreCount     int                    `json:"probe_score_count"`
	ProbeResults        map[string]ProbeResult `json:"probe_results"`

	// Uptime windows at three resolutions. AvailabilityWindows above is the
	// default window list; these are the coarser and the realtime cuts of the
	// same measurement.
	Availability24h      []Availability `json:"availability_24h"`
	Availability7d       []Availability `json:"availability_7d"`
	AvailabilityRealtime []Availability `json:"availability_realtime"`

	// Authenticity and review state of the model as the platform holds it.
	AuthenticityScore          float64           `json:"authenticity_score"`
	AuthenticityScoreAvailable bool              `json:"authenticity_score_available"`
	AutoDelistLocked           bool              `json:"auto_delist_locked"`
	IsOfficialLocked           bool              `json:"is_official_locked"`
	ReviewReason               string            `json:"review_reason"`
	RiskSummary                ProviderRiskModel `json:"risk_summary"`

	// Current price contract of the row.
	BillingExpr               string  `json:"billing_expr"`
	IsTieredExpr              bool    `json:"is_tiered_expr"`
	IsPerCall                 bool    `json:"is_per_call"`
	PricingAuthoritative      bool    `json:"pricing_authoritative"`
	PriceContractVersion      int     `json:"price_contract_version"`
	PriceContractReference    string  `json:"price_contract_reference"`
	PriceMultiplier           float64 `json:"price_multiplier"`
	ReferenceContextLength    int     `json:"reference_context_length"`
	CachePricingAuthoritative bool    `json:"cache_pricing_authoritative"`
	CacheCreationPrice1h      float64 `json:"cache_creation_price_1h"`
	CacheCreationPriceCustom  bool    `json:"cache_creation_price_custom"`
	CacheCreationDiscount     float64 `json:"cache_creation_discount_rate"`
	CacheCreation1hDiscount   float64 `json:"cache_creation_price_1h_discount_rate"`
	CacheDiscountRate         float64 `json:"cache_discount_rate"`
	CacheReadPriceCustom      bool    `json:"cache_read_price_custom"`
	CacheReadDiscountRate     float64 `json:"cache_read_discount_rate"`

	EffectiveCacheReadPrice       float64 `json:"effective_cache_read_price"`
	EffectiveCacheCreationPrice   float64 `json:"effective_cache_creation_price"`
	EffectiveCacheCreationPrice1h float64 `json:"effective_cache_creation_price_1h"`
	CacheHitRateComputedAt        int64   `json:"cache_hit_rate_computed_at"`
	CacheHitRateWindowSeconds     int     `json:"cache_hit_rate_window_seconds"`
	SupportsCacheRead             bool    `json:"supports_cache_read"`
	SupportsCacheCreation         bool    `json:"supports_cache_creation"`

	// Pending price contract: a price change the platform has staged but not
	// yet made authoritative. The field set mirrors the current contract.
	PendingBillingMode               string  `json:"pending_billing_mode"`
	PendingPricingStrategy           string  `json:"pending_pricing_strategy"`
	PendingInputPrice                float64 `json:"pending_input_price"`
	PendingOutputPrice               float64 `json:"pending_output_price"`
	PendingFixedPrice                float64 `json:"pending_fixed_price"`
	PendingPriceCurrency             string  `json:"pending_price_currency"`
	PendingPriceContractVersion      int     `json:"pending_price_contract_version"`
	PendingPriceEffectiveAt          int64   `json:"pending_price_effective_at"`
	PendingPriceRequestedAt          int64   `json:"pending_price_requested_at"`
	PendingPriceReviewStatus         int     `json:"pending_price_review_status"`
	PendingCachePricingAuthoritative bool    `json:"pending_cache_pricing_authoritative"`
	PendingCacheReadPrice            float64 `json:"pending_cache_read_price"`
	PendingCacheCreationPrice        float64 `json:"pending_cache_creation_price"`
	PendingCacheCreationPrice1h      float64 `json:"pending_cache_creation_price_1h"`
	PendingEffectiveCacheReadPrice   float64 `json:"pending_effective_cache_read_price"`

	PendingEffectiveCacheCreationPrice   float64 `json:"pending_effective_cache_creation_price"`
	PendingEffectiveCacheCreationPrice1h float64 `json:"pending_effective_cache_creation_price_1h"`

	// Official channel this offer is linked to, and the platform catalogue
	// price it is referenced against.
	OfficialChannelID           int                    `json:"official_channel_id"`
	OfficialChannelName         string                 `json:"official_channel_name"`
	OfficialModelID             int                    `json:"official_model_id"`
	OfficialCacheReadPrice      float64                `json:"official_cache_read_price"`
	OfficialCacheCreationPrice  float64                `json:"official_cache_creation_price"`
	OfficialCacheCreation1h     float64                `json:"official_cache_creation_price_1h"`
	OfficialPriceReference      OfficialPriceReference `json:"official_price_reference"`
	OfficialSupplyKeyCount      int                    `json:"official_supply_key_count"`
	OfficialSupplyProviderCount int                    `json:"official_supply_provider_count"`

	// Provider roll-up the platform repeats on every row of a provider's
	// catalogue, so that a row read on its own still carries it.
	ProviderChannelID              int        `json:"provider_channel_id"`
	ProviderCreditBaseSpendUSD     float64    `json:"provider_credit_base_spend_usd"`
	ProviderCreditPaidUserCount    int        `json:"provider_credit_paid_user_count"`
	ProviderCreditReviewAdjust     float64    `json:"provider_credit_review_adjustment"`
	ProviderCreditReviewCount      int        `json:"provider_credit_review_count"`
	ProviderCreditScore            float64    `json:"provider_credit_score"`
	ProviderCreditSocialMultiplier float64    `json:"provider_credit_social_multiplier"`
	ProviderDepositUSD             float64    `json:"provider_deposit_usd"`
	ProviderDescription            string     `json:"provider_description"`
	ProviderGuaranteeAmountUSD     float64    `json:"provider_guarantee_amount_usd"`
	ProviderGuaranteeLevel         FlexString `json:"provider_guarantee_level"`
	ProviderMaxRPM                 int        `json:"provider_max_rpm"`

	// Routing and listing metadata.
	DetailPath                 string `json:"detail_path"`
	Protocol                   string `json:"protocol"`
	RoutingRevision            int    `json:"routing_revision"`
	PrimaryRouteID             int    `json:"primary_route_id"`
	PlanID                     int    `json:"plan_id"`
	SharedPlanID               int    `json:"shared_plan_id"`
	PlatformOfficial           bool   `json:"platform_official"`
	Subscribed                 bool   `json:"subscribed"`
	ModelAnimationDemoEligible bool   `json:"model_animation_demo_eligible"`
}

// ProviderDetail is the response of GET /api/marketplace/providers/{slug}.
type ProviderDetail struct {
	Provider           MarketplaceProvider `json:"provider"`
	Models             []MarketplaceModel  `json:"models"`
	PublicModelCount   int                 `json:"public_model_count"`
	FilteredModelCount int                 `json:"filtered_model_count"`
	BazaarlinkSummary  BazaarlinkSummary   `json:"bazaarlink_summary"`
}

// BazaarlinkSummary is the platform's integrity review of one provider: how
// many of its models were observed, tested and reviewed, and over what
// period. Issues carries the review findings; the platform sends an empty
// list for a provider it has not reviewed, and the element shape of a
// finding is not part of the payloads observed so far, so it is kept as the
// platform sent it.
type BazaarlinkSummary struct {
	AIReviewedModelCount int    `json:"ai_reviewed_model_count"`
	FailedModelCount     int    `json:"failed_model_count"`
	IntegrityStatus      string `json:"integrity_status"`
	Issues               []any  `json:"issues"`
	ObservedModelCount   int    `json:"observed_model_count"`
	PeriodDays           int    `json:"period_days"`
	PeriodEnd            int64  `json:"period_end"`
	PeriodStart          int64  `json:"period_start"`
	ReviewingModelCount  int    `json:"reviewing_model_count"`
	RiskModelCount       int    `json:"risk_model_count"`
	RunningModelCount    int    `json:"running_model_count"`
	SkippedModelCount    int    `json:"skipped_model_count"`
	Source               string `json:"source"`
	TestedModelCount     int    `json:"tested_model_count"`
	TotalModelCount      int    `json:"total_model_count"`
}

// OfficialPriceReference is the platform catalogue price a provider offer is
// referenced against.
type OfficialPriceReference struct {
	InputPrice            float64 `json:"input_price"`
	OutputPrice           float64 `json:"output_price"`
	FixedPrice            float64 `json:"fixed_price"`
	CacheReadPrice        float64 `json:"cache_read_price"`
	CacheCreationPrice    float64 `json:"cache_creation_price"`
	CacheCreationPrice1h  float64 `json:"cache_creation_price_1h"`
	PeakInputPrice        float64 `json:"peak_input_price"`
	PeakOutputPrice       float64 `json:"peak_output_price"`
	PeakCacheReadPrice    float64 `json:"peak_cache_read_price"`
	SupportsCacheRead     bool    `json:"supports_cache_read"`
	SupportsCacheCreation bool    `json:"supports_cache_creation"`
	BillingMode           string  `json:"billing_mode"`
	BillingExpr           string  `json:"billing_expr"`
	Provider              string  `json:"provider"`
	Model                 string  `json:"model"`
	ModelVersion          string  `json:"model_version"`
	Region                string  `json:"region"`
	RateTier              string  `json:"rate_tier"`
	Unit                  string  `json:"unit"`
	Currency              string  `json:"currency"`
	SourceURL             string  `json:"source_url"`
	EffectiveAt           string  `json:"effective_at"`
	VerifiedAt            string  `json:"verified_at"`
}

// ProbeResult is one probe record of a model offer. ProbeResults on
// MarketplaceModel is keyed by the probe source (for example
// bazaarlink_local), so one model can carry several recordings at once.
type ProbeResult struct {
	ID                      int     `json:"id"`
	ProviderID              int     `json:"provider_id"`
	ProviderModelID         int     `json:"provider_model_id"`
	ProviderChannelID       int     `json:"provider_channel_id"`
	ChannelID               int     `json:"channel_id"`
	RouteID                 int     `json:"route_id"`
	ModelName               string  `json:"model_name"`
	UpstreamModel           string  `json:"upstream_model"`
	DetectedModel           string  `json:"detected_model"`
	DeclaredUpstreamModel   string  `json:"declared_upstream_model"`
	Status                  string  `json:"status"`
	Verdict                 string  `json:"verdict"`
	Source                  string  `json:"source"`
	ProbeBatchID            string  `json:"probe_batch_id"`
	EnhancedAttempt         int     `json:"enhanced_attempt"`
	EnhancedSampling        bool    `json:"enhanced_sampling"`
	EnhancedRecheckRequired bool    `json:"enhanced_recheck_required"`
	ModelReplacementRisk    bool    `json:"model_replacement_risk"`
	Score                   float64 `json:"score"`
	ScoreAvailable          bool    `json:"score_available"`
	ScoreInvalidReason      string  `json:"score_invalid_reason"`
	LatencyMs               int     `json:"latency_ms"`
	PromptTokens            int     `json:"prompt_tokens"`
	CompletionTokens        int     `json:"completion_tokens"`
	Details                 string  `json:"details"`
	Diagnostic              string  `json:"diagnostic"`
	Error                   string  `json:"error"`
	CreatedTime             int64   `json:"created_time"`
	UpdatedTime             int64   `json:"updated_time"`
}

// ProviderRiskModel is one model the platform flagged as risky for a
// provider, with the error window the flag rests on. The same shape is used
// for the risk summary of a single model row.
type ProviderRiskModel struct {
	ProviderModelID      int     `json:"provider_model_id"`
	ModelName            string  `json:"model_name"`
	WindowMinutes        int     `json:"window_minutes"`
	ErrorCount           int     `json:"error_count"`
	SuccessCount         int     `json:"success_count"`
	ObservedCount        int     `json:"observed_count"`
	ErrorRate            float64 `json:"error_rate"`
	BadWindowCount       int     `json:"bad_window_count"`
	EvaluatedWindowCount int     `json:"evaluated_window_count"`
	HTTPCode             int     `json:"http_code"`
	ErrorType            string  `json:"error_type"`
	ErrorCode            string  `json:"error_code"`
	LatestErrorAt        int64   `json:"latest_error_at"`
	RiskLevel            string  `json:"risk_level"`
}

// ProviderAnomaly is one anomaly the platform recorded against a provider
// model.
type ProviderAnomaly struct {
	ProviderModelID int    `json:"provider_model_id"`
	ModelName       string `json:"model_name"`
	Category        string `json:"category"`
	CategoryCode    string `json:"category_code"`
	Reason          string `json:"reason"`
	ReasonCode      string `json:"reason_code"`
	OccurredAt      int64  `json:"occurred_at"`
}

// ProviderReportAnomaly is one published user report against a provider
// model.
type ProviderReportAnomaly struct {
	Source      string `json:"source"`
	Message     string `json:"message"`
	ModelName   string `json:"model_name"`
	OccurredAt  int64  `json:"occurred_at"`
	PublicUntil int64  `json:"public_until"`
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

	// Model anomalies, published reports and risk flags the platform attaches
	// to the provider. AnomalyModelCount and RiskModelCount are the lengths of
	// AnomalyModels and RiskModels.
	AnomalyModels      []ProviderAnomaly       `json:"anomaly_models"`
	ReportAnomalies    []ProviderReportAnomaly `json:"report_anomalies"`
	ReportAnomalyCount int                     `json:"report_anomaly_count"`
	RiskModels         []ProviderRiskModel     `json:"risk_models"`
	RiskModelCount     int                     `json:"risk_model_count"`

	// Credit score inputs. The platform sends the parts of the score so that
	// it can be explained: a base spend, a review adjustment and a report
	// adjustment, with counts, and a social multiplier.
	CreditBaseSpendUSD     float64 `json:"credit_base_spend_usd"`
	CreditPaidUserCount    int     `json:"credit_paid_user_count"`
	CreditReportAdjustment float64 `json:"credit_report_adjustment"`
	CreditReportCount      int     `json:"credit_report_count"`
	CreditReviewAdjustment float64 `json:"credit_review_adjustment"`
	CreditReviewCount      int     `json:"credit_review_count"`
	CreditSocialMultiplier float64 `json:"credit_social_multiplier"`
}

// SharedProvider is one row of GET /api/marketplace/shared-providers. It is a
// provider pooled from subscribers' own plans rather than a provider account
// of its own, so it has its own field set: a plan tier, a vendor, a supply
// count, the plan's default discount and a live pool status. Models is the
// plan's model list, a narrowed subset of MarketplaceModel: the platform
// sends a price record per model, not the full directory row.
type SharedProvider struct {
	ID                     FlexString    `json:"id"`
	Slug                   string        `json:"slug"`
	CompanyName            string        `json:"company_name"`
	Description            string        `json:"description"`
	Vendor                 string        `json:"vendor"`
	Tier                   string        `json:"tier"`
	Source                 string        `json:"source"`
	GuaranteeLevel         FlexString    `json:"guarantee_level"`
	Rating                 float64       `json:"rating"`
	Availability           float64       `json:"availability"`
	ModelCount             int           `json:"model_count"`
	SubscriptionCount      int           `json:"subscription_count"`
	SupplyCount            int           `json:"supply_count"`
	DefaultDiscountBps     int           `json:"default_discount_bps"`
	CreditScore            float64       `json:"credit_score"`
	CreditBaseSpendUSD     float64       `json:"credit_base_spend_usd"`
	CreditPaidUserCount    int           `json:"credit_paid_user_count"`
	CreditReviewAdjustment float64       `json:"credit_review_adjustment"`
	CreditReviewCount      int           `json:"credit_review_count"`
	CreditSocialMultiplier float64       `json:"credit_social_multiplier"`
	ProbeScore             float64       `json:"probe_score"`
	ProbeScoreAvailable    bool          `json:"probe_score_available"`
	ProbeScoreBuiltin      bool          `json:"probe_score_builtin"`
	ProbeScoreCount        int           `json:"probe_score_count"`
	PoolStatus             PoolStatus    `json:"pool_status"`
	RouteProviderKey       string        `json:"route_provider_key"`
	SharedPlanID           int           `json:"shared_plan_id"`
	PlatformOfficial       bool          `json:"platform_official"`
	Subscribed             bool          `json:"subscribed"`
	Models                 []SharedModel `json:"models"`
	CreatedTime            int64         `json:"created_time"`
	UpdatedTime            int64         `json:"updated_time"`
}

// PoolStatus is the live account pool behind a shared provider plan: how many
// of its upstream accounts are usable now, how much concurrency they add up
// to, and per model the same counts. The timestamps are RFC 3339 strings as
// the platform sends them, kept as strings so that an empty value and an
// unparseable one both survive the round trip.
type PoolStatus struct {
	Health                         string            `json:"health"`
	TotalAccounts                  int               `json:"total_accounts"`
	AvailableAccounts              int               `json:"available_accounts"`
	RateLimitedAccounts            int               `json:"rate_limited_accounts"`
	OverloadedAccounts             int               `json:"overloaded_accounts"`
	TemporarilyUnavailableAccounts int               `json:"temporarily_unavailable_accounts"`
	PausedAccounts                 int               `json:"paused_accounts"`
	ErrorAccounts                  int               `json:"error_accounts"`
	ExpiredAccounts                int               `json:"expired_accounts"`
	UnsupportedAccounts            int               `json:"unsupported_accounts"`
	UnavailableAccounts            int               `json:"unavailable_accounts"`
	TotalConcurrency               int               `json:"total_concurrency"`
	AvailableConcurrency           int               `json:"available_concurrency"`
	NextRecoveryAt                 string            `json:"next_recovery_at"`
	LastSyncedAt                   string            `json:"last_synced_at"`
	Models                         []PoolModelStatus `json:"models"`
}

// PoolModelStatus is the pool state of one model inside a shared plan.
type PoolModelStatus struct {
	ModelName           string `json:"model_name"`
	TotalAccounts       int    `json:"total_accounts"`
	AvailableAccounts   int    `json:"available_accounts"`
	RateLimitedAccounts int    `json:"rate_limited_accounts"`
	NextRecoveryAt      string `json:"next_recovery_at"`
}

// SharedModel is one model of a shared provider plan. It carries the prices,
// the platform-measured generation speed and the probe score of the offer, but
// none of the provider or uptime fields of a full MarketplaceModel.
type SharedModel struct {
	ID                   FlexString `json:"id"`
	ModelName            string     `json:"model_name"`
	UpstreamModel        string     `json:"upstream_model"`
	Protocol             string     `json:"protocol"`
	BillingMode          string     `json:"billing_mode"`
	BillingExpr          string     `json:"billing_expr"`
	IsTieredExpr         bool       `json:"is_tiered_expr"`
	IsPerCall            bool       `json:"is_per_call"`
	PriceCurrency        string     `json:"price_currency"`
	PriceMultiplier      float64    `json:"price_multiplier"`
	PricingSource        string     `json:"pricing_source"`
	InputPrice           float64    `json:"input_price"`
	OutputPrice          float64    `json:"output_price"`
	FixedPrice           float64    `json:"fixed_price"`
	CacheReadPrice       float64    `json:"cache_read_price"`
	CacheCreationPrice   float64    `json:"cache_creation_price"`
	CacheCreationPrice1h float64    `json:"cache_creation_price_1h"`

	EffectiveCacheReadPrice       float64 `json:"effective_cache_read_price"`
	EffectiveCacheCreationPrice   float64 `json:"effective_cache_creation_price"`
	EffectiveCacheCreationPrice1h float64 `json:"effective_cache_creation_price_1h"`
	SupportsCacheRead             bool    `json:"supports_cache_read"`
	SupportsCacheCreation         bool    `json:"supports_cache_creation"`

	OfficialInputPrice         float64 `json:"official_input_price"`
	OfficialOutputPrice        float64 `json:"official_output_price"`
	OfficialFixedPrice         float64 `json:"official_fixed_price"`
	OfficialDiscountPercent    float64 `json:"official_discount_percent"`
	OfficialCacheReadPrice     float64 `json:"official_cache_read_price"`
	OfficialCacheCreationPrice float64 `json:"official_cache_creation_price"`
	OfficialCacheCreation1h    float64 `json:"official_cache_creation_price_1h"`

	ContextLength int     `json:"context_length"`
	CacheHitRate  float64 `json:"cache_hit_rate"`
	MedianTTFT    float64 `json:"median_ttft"`

	// Platform-measured generation speed of this plan's offer of the model, in
	// output tokens per second, with the number of samples behind it.
	OutputTokensPerSecond float64 `json:"output_tokens_per_second"`
	OutputSpeedSamples    int     `json:"output_speed_samples"`

	ProbeScore          float64    `json:"probe_score"`
	ProbeScoreAvailable bool       `json:"probe_score_available"`
	ProbeScoreBuiltin   bool       `json:"probe_score_builtin"`
	ProbeScoreCount     int        `json:"probe_score_count"`
	Status              FlexString `json:"status"`
	PlanID              int        `json:"plan_id"`
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
//
// ID is the platform's row id and is not unique across rows. A request is
// identified by RequestID together with Type, because the platform reuses a
// request id for the billed and the error row of one request.
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
