package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// The provider directory, the provider detail feed and the shared provider
// list all answer with their own row shape. The fixtures in testdata are
// captured from the live endpoints, one row per endpoint, and carry every
// field those endpoints send. The parity tests below fail when a struct drops
// a field, because the CLI output is compared against the payload key by key.

// loadPayload reads one captured payload from testdata.
func loadPayload(t *testing.T, name string) json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read testdata/%s: %v", name, err)
	}
	return b
}

// decodeJSON turns a payload into the generic JSON value tree.
func decodeJSON(t *testing.T, raw []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", string(raw), err)
	}
	return v
}

// asJSONTree renders a typed value the way the CLI writes it with -o json.
func asJSONTree(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal output: %v", err)
	}
	return decodeJSON(t, b)
}

// assertKeyParity walks the payload and the CLI output side by side and
// reports every key that only one of them carries.
func assertKeyParity(t *testing.T, path string, payload, output any) {
	t.Helper()
	switch want := payload.(type) {
	case map[string]any:
		got, ok := output.(map[string]any)
		if !ok {
			t.Errorf("%s: payload is an object, CLI output is %T", path, output)
			return
		}
		for _, k := range sortedKeys(want) {
			gv, present := got[k]
			if !present {
				t.Errorf("%s.%s: the API sends this field and the CLI drops it", path, k)
				continue
			}
			assertKeyParity(t, path+"."+k, want[k], gv)
		}
		for _, k := range sortedKeys(got) {
			if _, present := want[k]; !present {
				t.Errorf("%s.%s: the CLI invents this field, the API does not send it", path, k)
			}
		}
	case []any:
		if want == nil {
			// A null list is not evidence about the element shape.
			return
		}
		got, ok := output.([]any)
		if !ok {
			if output == nil {
				// A typed nil slice still serialises to null.
				return
			}
			t.Errorf("%s: payload is a list, CLI output is %T", path, output)
			return
		}
		if len(want) != len(got) {
			t.Errorf("%s: payload has %d rows, CLI output has %d", path, len(want), len(got))
			return
		}
		for i := range want {
			assertKeyParity(t, fmt.Sprintf("%s[%d]", path, i), want[i], got[i])
		}
	}
}

// sortedKeys returns the map keys in a stable order, so that a failing test
// reports the same field first on every run.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// envelope wraps a payload the way every /api endpoint does.
func envelope(t *testing.T, data json.RawMessage, total int) []byte {
	t.Helper()
	body := map[string]any{"success": true, "data": data}
	if total > 0 {
		body["total"] = total
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("build envelope: %v", err)
	}
	return b
}

// payloadServer serves one envelope on any path.
func payloadServer(t *testing.T, body []byte) *Client {
	t.Helper()
	cl, _ := testClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
	return cl
}

func TestProviderDirectoryJSONParity(t *testing.T) {
	raw := loadPayload(t, "provider.json")
	// The list envelope carries the rows under data, and the total beside it.
	cl := payloadServer(t, envelope(t, json.RawMessage("["+string(raw)+"]"), 1))

	page, err := cl.ListMarketplaceProviders(context.Background(), ProviderQuery{PageSize: 1})
	if err != nil {
		t.Fatalf("ListMarketplaceProviders: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("decoded %d providers, want 1", len(page.Items))
	}
	assertKeyParity(t, "provider", decodeJSON(t, raw), asJSONTree(t, page.Items[0]))
}

func TestProviderDetailJSONParity(t *testing.T) {
	raw := loadPayload(t, "provider_detail.json")
	cl := payloadServer(t, envelope(t, raw, 0))

	detail, err := cl.GetMarketplaceProvider(context.Background(), "demo")
	if err != nil {
		t.Fatalf("GetMarketplaceProvider: %v", err)
	}
	if len(detail.Models) != 1 {
		t.Fatalf("decoded %d models, want 1", len(detail.Models))
	}
	assertKeyParity(t, "detail", decodeJSON(t, raw), asJSONTree(t, detail))
}

func TestSharedProviderJSONParity(t *testing.T) {
	raw := loadPayload(t, "shared_provider.json")
	cl := payloadServer(t, envelope(t, json.RawMessage("["+string(raw)+"]"), 0))

	providers, err := cl.GetSharedProviders(context.Background())
	if err != nil {
		t.Fatalf("GetSharedProviders: %v", err)
	}
	if len(providers) != 1 {
		t.Fatalf("decoded %d shared providers, want 1", len(providers))
	}
	assertKeyParity(t, "shared", decodeJSON(t, raw), asJSONTree(t, providers[0]))
}

// unmeasuredDetailPayload is a provider detail response whose first model row
// omits the speed pair, exactly as the live API does for an offer it has not
// measured, beside a measured row for contrast.
const unmeasuredDetailPayload = `{
  "success": true,
  "data": {
    "provider": {"id": "12", "slug": "demo", "company_name": "Demo Provider"},
    "public_model_count": 2,
    "filtered_model_count": 2,
    "bazaarlink_summary": {"integrity_status": "verified"},
    "models": [
      {"id": 1, "model_name": "unmeasured-offer", "provider_slug": "demo",
       "input_price": 0.1, "output_price": 0.2},
      {"id": 2, "model_name": "measured-offer", "provider_slug": "demo",
       "input_price": 0.1, "output_price": 0.2,
       "output_tokens_per_second": 124.5, "output_speed_samples": 42}
    ]
  }
}`

// TestUnmeasuredOfferJSONShape pins the CLI contract for an offer the platform
// has not measured, which is not the same as the API contract.
//
// The API omits both speed fields. The CLI does not: pkg/api intentionally
// writes every declared field (no omitempty anywhere in this package), so an
// unmeasured offer must arrive in -o json as output_tokens_per_second: 0 with
// output_speed_samples: 0. OutputSpeedSamples is the discriminator, because a
// measured offer at 0 tok/s does not occur. Tables render the same offer as a
// dash instead; that half is pinned by TestModelRowsRenderOutputSpeed.
func TestUnmeasuredOfferJSONShape(t *testing.T) {
	cl := payloadServer(t, []byte(unmeasuredDetailPayload))
	detail, err := cl.GetMarketplaceProvider(context.Background(), "demo")
	if err != nil {
		t.Fatalf("GetMarketplaceProvider: %v", err)
	}
	if len(detail.Models) != 2 {
		t.Fatalf("decoded %d models, want 2", len(detail.Models))
	}

	unmeasured, ok := asJSONTree(t, detail.Models[0]).(map[string]any)
	if !ok {
		t.Fatalf("the unmeasured model did not marshal to an object")
	}
	tps, present := unmeasured["output_tokens_per_second"]
	if !present {
		t.Fatalf("output_tokens_per_second is missing from the JSON output; the package writes every declared field")
	}
	if tps != float64(0) {
		t.Errorf("output_tokens_per_second = %v, want 0", tps)
	}
	samples, present := unmeasured["output_speed_samples"]
	if !present {
		t.Fatalf("output_speed_samples is missing from the JSON output; it is the discriminator and must always be present")
	}
	if samples != float64(0) {
		t.Errorf("output_speed_samples = %v, want 0", samples)
	}

	// A measured offer keeps its figure, so the two are distinguishable by the
	// sample count alone.
	measured, ok := asJSONTree(t, detail.Models[1]).(map[string]any)
	if !ok {
		t.Fatalf("the measured model did not marshal to an object")
	}
	if got, want := measured["output_speed_samples"], float64(42); got != want {
		t.Errorf("measured output_speed_samples = %v, want %v", got, want)
	}
	if got, want := measured["output_tokens_per_second"], 124.5; got != want {
		t.Errorf("measured output_tokens_per_second = %v, want %v", got, want)
	}
}

func TestProviderDetailCarriesOutputSpeed(t *testing.T) {
	raw := loadPayload(t, "provider_detail.json")
	cl := payloadServer(t, envelope(t, raw, 0))

	detail, err := cl.GetMarketplaceProvider(context.Background(), "demo")
	if err != nil {
		t.Fatalf("GetMarketplaceProvider: %v", err)
	}
	model := detail.Models[0]
	if model.OutputTokensPerSecond != 124.5 {
		t.Errorf("OutputTokensPerSecond = %v, want 124.5", model.OutputTokensPerSecond)
	}
	if model.OutputSpeedSamples != 42 {
		t.Errorf("OutputSpeedSamples = %d, want 42", model.OutputSpeedSamples)
	}
	// The speed must survive the trip to -o json under its API name.
	tree, ok := asJSONTree(t, model).(map[string]any)
	if !ok {
		t.Fatalf("model did not marshal to an object")
	}
	if got, want := tree["output_tokens_per_second"], 124.5; got != want {
		t.Errorf("output_tokens_per_second = %v, want %v", got, want)
	}
	if got, want := tree["output_speed_samples"], float64(42); got != want {
		t.Errorf("output_speed_samples = %v, want %v", got, want)
	}
}

func TestSortModelsByOutputSpeed(t *testing.T) {
	models := []MarketplaceModel{
		{ModelName: "unmeasured"},
		{ModelName: "fast", OutputTokensPerSecond: 200, OutputSpeedSamples: 5},
		{ModelName: "steady", OutputTokensPerSecond: 50, OutputSpeedSamples: 10},
	}
	SortModels(models, "tps", false)
	if got := []string{models[0].ModelName, models[1].ModelName, models[2].ModelName}; !equalStrings(got, []string{"steady", "fast", "unmeasured"}) {
		t.Errorf("ascending TPS order = %v, want [steady fast unmeasured]", got)
	}
	SortModels(models, "tps", true)
	if got := []string{models[0].ModelName, models[1].ModelName, models[2].ModelName}; !equalStrings(got, []string{"fast", "steady", "unmeasured"}) {
		t.Errorf("descending TPS order = %v, want [fast steady unmeasured]", got)
	}
}

func TestSortProvidersByRisk(t *testing.T) {
	providers := []MarketplaceProvider{
		{Slug: "quiet"},
		{Slug: "risky", RiskModelCount: 4, ReportAnomalyCount: 2},
		{Slug: "reported", ReportAnomalyCount: 7},
	}
	SortProviders(providers, "risk", true)
	if providers[0].Slug != "risky" {
		t.Errorf("descending risk order starts with %q, want risky", providers[0].Slug)
	}
	SortProviders(providers, "reports", true)
	if providers[0].Slug != "reported" {
		t.Errorf("descending report order starts with %q, want reported", providers[0].Slug)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
