package cmd

import (
	"testing"
	"time"
)

func TestParseTimeFlag(t *testing.T) {
	cases := []struct {
		in      string
		wantErr bool
		check   func(int64) bool
	}{
		{in: "", check: func(v int64) bool { return v == 0 }},
		{in: "now", check: func(v int64) bool { return v > 0 }},
		{in: "1738281600", check: func(v int64) bool { return v == 1738281600 }},
		{in: "24h", check: func(v int64) bool { return v > 0 && time.Since(time.Unix(v, 0)) < 25*time.Hour }},
		{in: "7d", check: func(v int64) bool { return v > 0 && time.Since(time.Unix(v, 0)) < 8*24*time.Hour }},
		{in: "2026-01-31", check: func(v int64) bool { return time.Unix(v, 0).Format("2006-01-02") == "2026-01-31" }},
		{in: "not-a-time", wantErr: true},
	}
	for _, c := range cases {
		got, err := parseTimeFlag(c.in, false)
		if c.wantErr {
			if err == nil {
				t.Errorf("parseTimeFlag(%q) should have failed", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseTimeFlag(%q): %v", c.in, err)
			continue
		}
		if !c.check(got) {
			t.Errorf("parseTimeFlag(%q) = %d, unexpected value", c.in, got)
		}
	}
}

func TestParseTimeFlagEndOfDay(t *testing.T) {
	start, _ := parseTimeFlag("2026-01-31", false)
	end, _ := parseTimeFlag("2026-01-31", true)
	if end <= start {
		t.Errorf("end of day (%d) should be after the start of the day (%d)", end, start)
	}
}

func TestParseModelRoutes(t *testing.T) {
	routes, err := parseModelRoutes([]string{"gpt-5.4=demo", "claude=acme,demo"})
	if err != nil {
		t.Fatalf("parseModelRoutes: %v", err)
	}
	if len(routes["gpt-5.4"]) != 1 || routes["gpt-5.4"][0] != "demo" {
		t.Errorf("gpt-5.4 routes = %v", routes["gpt-5.4"])
	}
	if len(routes["claude"]) != 2 {
		t.Errorf("claude routes = %v", routes["claude"])
	}
	if _, err := parseModelRoutes([]string{"broken"}); err == nil {
		t.Error("parseModelRoutes should reject an entry without =")
	}
	if _, err := parseModelRoutes([]string{"model="}); err == nil {
		t.Error("parseModelRoutes should reject an entry without providers")
	}
}

func TestSplitList(t *testing.T) {
	got := splitList(" a, b ,, c ")
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("splitList = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("splitList[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if splitList("  ") != nil {
		t.Error("splitList should return nil for a blank value")
	}
}

func TestResolveExpiry(t *testing.T) {
	if got, err := resolveExpiry("never"); err != nil || got != -1 {
		t.Errorf("resolveExpiry(never) = %d, %v", got, err)
	}
	got, err := resolveExpiry("720h")
	if err != nil {
		t.Fatalf("resolveExpiry: %v", err)
	}
	if got <= time.Now().Unix() {
		t.Errorf("resolveExpiry(720h) = %d, want a future timestamp", got)
	}
	if _, err := resolveExpiry("gibberish"); err == nil {
		t.Error("resolveExpiry should reject an unparsable value")
	}
}

func TestValidRoutePreferenceAndSortMode(t *testing.T) {
	if !validRoutePreference("price_first,stability_first") {
		t.Error("price_first,stability_first should be valid")
	}
	if validRoutePreference("cheapest_first") {
		t.Error("cheapest_first is not a known criterion")
	}
	if !validSortMode("per_call_price_first") {
		t.Error("per_call_price_first should be valid")
	}
	if validSortMode("random") {
		t.Error("random is not a known sort mode")
	}
}
