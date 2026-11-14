package api

import (
	"encoding/json"
	"testing"
)

func TestTokenKindClassification(t *testing.T) {
	cases := []struct {
		name  string
		token Token
		want  TokenKind
	}{
		{"smart routes everywhere", Token{Group: "subrouter",
			IncludeProviderSelf: true, IncludeOfficialChannels: true, IncludeSharedSubscriptions: true}, KindSmart},
		{"official only", Token{Group: "subrouter", IncludeOfficialChannels: true}, KindOfficial},
		{"shared only", Token{Group: "subrouter", IncludeSharedSubscriptions: true}, KindShared},
		{"pinned provider", Token{Group: "provider:demo"}, KindFixed},
		{"pinned official provider", Token{Group: "official:demo"}, KindFixed},
		{"official channel id wins", Token{Group: "subrouter", OfficialChannelID: 7}, KindOfficial},
		{"auto group", Token{Group: "auto"}, KindAuto},
	}
	for _, c := range cases {
		if got := c.token.Kind(); got != c.want {
			t.Errorf("%s: kind = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestTokenSpecPayloadPerKind(t *testing.T) {
	smart := NewTokenSpec(KindSmart)
	smart.Name = "r"
	smart.Providers = []string{"demo", "acme"}
	smartPayload := smart.Payload()
	if smartPayload["group"] != "subrouter" {
		t.Errorf("smart group = %v, want subrouter", smartPayload["group"])
	}
	if smartPayload["subrouter_providers"] != "demo,acme" {
		t.Errorf("smart providers = %v, want demo,acme", smartPayload["subrouter_providers"])
	}
	for _, k := range []string{"include_provider_self", "include_official_channels", "include_shared_subscriptions"} {
		if smartPayload[k] != true {
			t.Errorf("smart %s = %v, want true", k, smartPayload[k])
		}
	}

	fixedSpec := NewTokenSpec(KindFixed)
	fixedSpec.Provider = "demo"
	fixed := fixedSpec.Payload()
	if fixed["group"] != "provider:demo" {
		t.Errorf("fixed group = %v, want provider:demo", fixed["group"])
	}
	if fixed["include_provider_self"] != true {
		t.Errorf("fixed include_provider_self = %v, want true", fixed["include_provider_self"])
	}

	shared := NewTokenSpec(KindShared).Payload()
	if shared["include_shared_subscriptions"] != true {
		t.Errorf("shared include_shared_subscriptions = %v, want true", shared["include_shared_subscriptions"])
	}
	if shared["include_official_channels"] != false {
		t.Errorf("shared include_official_channels = %v, want false", shared["include_official_channels"])
	}
}

func TestTokenSpecModelRoutesAreJSON(t *testing.T) {
	spec := NewTokenSpec(KindSmart)
	spec.ModelRoutes = map[string][]string{"gpt-5.4": {"demo"}, "claude-sonnet-4-6": {"acme", "demo"}}
	payload := spec.Payload()
	raw, ok := payload["subrouter_model_providers"].(string)
	if !ok {
		t.Fatalf("subrouter_model_providers is %T, want string", payload["subrouter_model_providers"])
	}
	var decoded map[string][]string
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("subrouter_model_providers is not valid JSON: %v", err)
	}
	if len(decoded["claude-sonnet-4-6"]) != 2 {
		t.Errorf("decoded routes = %v", decoded)
	}
}

func TestTokenSpecDefaultsNeverExpire(t *testing.T) {
	payload := NewTokenSpec(KindSmart).Payload()
	if payload["expired_time"] != int64(-1) {
		t.Errorf("expired_time = %v, want -1", payload["expired_time"])
	}
	if payload["subrouter_route_preference"] != DefaultRoutePreference {
		t.Errorf("route preference = %v", payload["subrouter_route_preference"])
	}
	if payload["subrouter_sort_mode"] != SortModes[0] {
		t.Errorf("sort mode = %v", payload["subrouter_sort_mode"])
	}
}

func TestTokenFullKeyAddsPrefixOnce(t *testing.T) {
	if got := (Token{Key: "abc"}).FullKey(); got != "sk-abc" {
		t.Errorf("FullKey = %q, want sk-abc", got)
	}
	if got := (Token{Key: "sk-abc"}).FullKey(); got != "sk-abc" {
		t.Errorf("FullKey = %q, want sk-abc", got)
	}
}

func TestFilterAndSortTokens(t *testing.T) {
	tokens := []Token{
		{Name: "zebra", UsedQuota: 10, ID: 3},
		{Name: "alpha", UsedQuota: 30, ID: 1},
		{Name: "middle", UsedQuota: 20, ID: 2},
	}
	filtered := FilterTokens(tokens, "alp")
	if len(filtered) != 1 || filtered[0].Name != "alpha" {
		t.Errorf("FilterTokens returned %v", filtered)
	}
	SortTokens(tokens, "used", true)
	if tokens[0].Name != "alpha" {
		t.Errorf("sort desc by used gave %v first", tokens[0].Name)
	}
	SortTokens(tokens, "used", false)
	if tokens[0].Name != "zebra" {
		t.Errorf("sort asc by used gave %v first", tokens[0].Name)
	}
}

func TestFilterAndSortModels(t *testing.T) {
	models := []MarketplaceModel{
		{ModelName: "claude-sonnet-4-6", ProviderName: "Demo", InputPrice: 3},
		{ModelName: "gpt-5.4", ProviderName: "Acme", InputPrice: 1},
	}
	if got := FilterModels(models, "acme"); len(got) != 1 {
		t.Errorf("FilterModels returned %d rows, want 1", len(got))
	}
	SortModels(models, "input", true)
	if models[0].ModelName != "claude-sonnet-4-6" {
		t.Errorf("sort desc by input gave %v first", models[0].ModelName)
	}
}

func TestFlexStringAndFlexInt(t *testing.T) {
	var s FlexString
	for _, raw := range []string{`"abc"`, `42`, `true`} {
		if err := s.UnmarshalJSON([]byte(raw)); err != nil {
			t.Fatalf("UnmarshalJSON(%s): %v", raw, err)
		}
	}
	if s.String() != "true" {
		t.Errorf("FlexString = %q, want true", s.String())
	}

	var i FlexInt
	if err := i.UnmarshalJSON([]byte(`{"prompt_tokens": 10, "completion_tokens": 5}`)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	if i.Int() != 15 {
		t.Errorf("FlexInt = %d, want 15", i.Int())
	}
	if err := i.UnmarshalJSON([]byte(`1234`)); err != nil {
		t.Fatalf("UnmarshalJSON: %v", err)
	}
	if i.Int() != 1234 {
		t.Errorf("FlexInt = %d, want 1234", i.Int())
	}
}

func TestParamsOmitsEmptyValues(t *testing.T) {
	p := Params{"a": "x", "b": "", "c": 0, "d": true, "e": []string{"p", "q"}}
	got := p.Encode()
	want := "?a=x&d=true&e=p%2Cq"
	if got != want {
		t.Errorf("Encode = %q, want %q", got, want)
	}
}
