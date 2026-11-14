package api

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// RoutePreference values accepted by the smart-routing engine, in the order
// the console offers them.
var RoutePreferences = []string{
	"stability_first",
	"authenticity_first",
	"provider_credit_first",
	"first_token_first",
	"price_first",
}

// DefaultRoutePreference is the platform default ordering.
const DefaultRoutePreference = "stability_first,authenticity_first,provider_credit_first,first_token_first,price_first"

// Sort modes accepted for smart routing.
var SortModes = []string{"token_price_first", "per_call_price_first"}

// TokenSpec describes the token a user wants to create or update. It maps
// directly onto the four token kinds the SubRouter console exposes.
type TokenSpec struct {
	Kind        TokenKind
	Name        string
	Provider    string   // fixed kind: the provider slug
	Providers   []string // smart kind: candidate provider slugs
	Models      []string // optional model whitelist
	ModelRoutes map[string][]string

	// Smart routing behaviour.
	RoutePreference string
	SortMode        string
	LoadBalance     bool
	IncludeCacheHit bool
	IncludeProvider bool
	IncludeOfficial bool
	IncludeShared   bool
	OfficialMaxDisc float64
	SharedMaxDisc   float64
	OfficialChannel int

	// Quota and lifetime.
	Unlimited bool
	Quota     float64
	Expires   int64 // unix seconds, -1 for never

	// Access control.
	AllowIPs       string
	CrossGroupOnly bool
	Group          string
	KeyGroupID     int
}

// NewTokenSpec returns a spec preloaded with the routing defaults of a kind.
//
//	smart     every source: provider, official and shared
//	official  platform official channels only
//	shared    subscribed shared pools only
//	fixed     the pinned provider only
func NewTokenSpec(kind TokenKind) *TokenSpec {
	s := &TokenSpec{Kind: kind}
	switch kind {
	case KindSmart:
		s.IncludeProvider, s.IncludeOfficial, s.IncludeShared = true, true, true
		s.IncludeCacheHit = true
	case KindOfficial:
		s.IncludeOfficial = true
		s.IncludeCacheHit = true
	case KindShared:
		s.IncludeShared = true
		s.IncludeCacheHit = true
	case KindFixed:
		s.IncludeProvider = true
	}
	return s
}

// Normalize fills in the platform defaults for a spec.
func (s *TokenSpec) Normalize() {
	if s.RoutePreference == "" {
		s.RoutePreference = DefaultRoutePreference
	}
	if s.SortMode == "" {
		s.SortMode = SortModes[0]
	}
	if s.Expires == 0 {
		s.Expires = -1
	}
	if s.OfficialChannel > 0 {
		// A key pinned to one official channel is an official key.
		s.Kind = KindOfficial
	}
}

// GroupValue returns the routing group a spec resolves to.
func (s *TokenSpec) GroupValue() string {
	switch s.Kind {
	case KindFixed:
		if s.Provider == "" {
			return ""
		}
		return "provider:" + s.Provider
	case KindSmart, KindOfficial, KindShared:
		return "subrouter"
	default:
		return s.Group
	}
}

// Payload renders the spec as the JSON body the API expects.
func (s *TokenSpec) Payload() map[string]any {
	s.Normalize()

	p := map[string]any{
		"name":                             s.Name,
		"group":                            s.GroupValue(),
		"unlimited_quota":                  s.Unlimited,
		"remain_quota":                     s.Quota,
		"expired_time":                     s.Expires,
		"model_limits_enabled":             len(s.Models) > 0,
		"model_limits":                     strings.Join(s.Models, ","),
		"allow_ips":                        s.AllowIPs,
		"cross_group_retry":                s.CrossGroupOnly,
		"subrouter_sort_mode":              s.SortMode,
		"subrouter_route_preference":       s.RoutePreference,
		"include_cache_hit_rate":           s.IncludeCacheHit,
		"load_balance_enabled":             s.LoadBalance,
		"include_provider_self":            s.IncludeProvider,
		"include_official_channels":        s.IncludeOfficial,
		"official_key_max_discount":        s.OfficialMaxDisc,
		"include_shared_subscriptions":     s.IncludeShared,
		"shared_subscription_max_discount": s.SharedMaxDisc,
	}

	if len(s.Providers) > 0 {
		p["subrouter_providers"] = strings.Join(s.Providers, ",")
	} else {
		p["subrouter_providers"] = ""
	}
	if len(s.ModelRoutes) > 0 {
		if b, err := json.Marshal(s.ModelRoutes); err == nil {
			p["subrouter_model_providers"] = string(b)
		}
	}
	if s.OfficialChannel > 0 {
		p["official_channel_id"] = s.OfficialChannel
	}
	if s.KeyGroupID > 0 {
		p["key_group_id"] = s.KeyGroupID
	}
	return p
}

// TokenList is a page of tokens.
type TokenList struct {
	Items []Token `json:"items"`
	Page  int     `json:"page"`
	Size  int     `json:"page_size"`
	Total int     `json:"total"`
}

// ListTokens returns the token list (GET /api/token/).
func (c *Client) ListTokens(ctx context.Context, page, size int, kind string) (*TokenList, error) {
	p := Params{"p": page, "size": size}
	if kind != "" && kind != "all" {
		p["kind"] = kind
	}
	var l TokenList
	if err := c.Get(ctx, "/api/token/", p, &l); err != nil {
		return nil, err
	}
	return &l, nil
}

// SearchTokens searches tokens by name (GET /api/token/search).
func (c *Client) SearchTokens(ctx context.Context, page, pageSize int, keyword, token, kind string) (*TokenList, error) {
	p := Params{"p": page, "page_size": pageSize}
	if keyword != "" {
		p["keyword"] = keyword
	}
	if token != "" {
		p["token"] = token
	}
	if kind != "" && kind != "all" {
		p["kind"] = kind
	}
	var l TokenList
	if err := c.Get(ctx, "/api/token/search", p, &l); err != nil {
		return nil, err
	}
	return &l, nil
}

// GetToken returns one token (GET /api/token/{id}).
func (c *Client) GetToken(ctx context.Context, id int) (*Token, error) {
	var t Token
	if err := c.Get(ctx, fmt.Sprintf("/api/token/%d", id), nil, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// CreateToken creates a token (POST /api/token/).
func (c *Client) CreateToken(ctx context.Context, body map[string]any) (*Token, error) {
	var t Token
	if err := c.Post(ctx, "/api/token/", body, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// UpdateToken updates a token (PUT /api/token/). The body must carry the id.
func (c *Client) UpdateToken(ctx context.Context, body map[string]any) (*Token, error) {
	var t Token
	if err := c.Put(ctx, "/api/token/", body, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// DeleteToken deletes a token (DELETE /api/token/{id}).
func (c *Client) DeleteToken(ctx context.Context, id int) error {
	return c.Delete(ctx, fmt.Sprintf("/api/token/%d/", id), nil)
}

// DeleteTokens deletes several tokens at once (POST /api/token/batch).
func (c *Client) DeleteTokens(ctx context.Context, ids []int) error {
	return c.Post(ctx, "/api/token/batch", map[string]any{"ids": ids}, nil)
}

// SortTokens orders tokens by a field name in the given direction.
func SortTokens(tokens []Token, field string, desc bool) {
	less := func(i, j int) bool { return false }
	switch strings.ToLower(field) {
	case "name":
		less = func(i, j int) bool { return tokens[i].Name < tokens[j].Name }
	case "id":
		less = func(i, j int) bool { return tokens[i].ID < tokens[j].ID }
	case "used":
		less = func(i, j int) bool { return tokens[i].UsedQuota < tokens[j].UsedQuota }
	case "remain":
		less = func(i, j int) bool { return tokens[i].RemainQuota < tokens[j].RemainQuota }
	case "created":
		less = func(i, j int) bool { return tokens[i].CreatedTime < tokens[j].CreatedTime }
	case "accessed":
		less = func(i, j int) bool { return tokens[i].AccessedTime < tokens[j].AccessedTime }
	case "status":
		less = func(i, j int) bool { return tokens[i].Status < tokens[j].Status }
	case "kind":
		less = func(i, j int) bool { return string(tokens[i].Kind()) < string(tokens[j].Kind()) }
	default:
		return
	}
	if desc {
		sort.SliceStable(tokens, func(i, j int) bool { return less(j, i) })
		return
	}
	sort.SliceStable(tokens, func(i, j int) bool { return less(i, j) })
}

// FilterTokens keeps the tokens matching the free text query. It matches the
// name, the key, the group and the provider slugs.
func FilterTokens(tokens []Token, query string) []Token {
	if query == "" {
		return tokens
	}
	q := strings.ToLower(query)
	out := make([]Token, 0, len(tokens))
	for _, t := range tokens {
		hay := strings.ToLower(strings.Join([]string{
			t.Name, t.Group, t.SubrouterProviders, string(t.Kind()), t.ProviderSlug(),
		}, " "))
		if strings.Contains(hay, q) {
			out = append(out, t)
		}
	}
	return out
}
