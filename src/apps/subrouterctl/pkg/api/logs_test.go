package api

import (
	"encoding/json"
	"strconv"
	"testing"
)

func TestLogEntryOutputTPSMatchesTheConsole(t *testing.T) {
	// The SubRouter console shows the throughput as the completion tokens
	// divided by the total request duration: 2334 / 49 = 47.6 t/s.
	e := LogEntry{CompletionTokens: 2334, UseTime: 49, IsStream: true}
	if got := e.OutputTPS(); got < 47.6 || got > 47.7 {
		t.Errorf("OutputTPS = %.2f, want 47.63", got)
	}
	if !e.ShowsTPS() {
		t.Error("a streaming entry with output tokens should show a throughput")
	}
}

func TestLogEntryThroughputNeedsStreaming(t *testing.T) {
	e := LogEntry{CompletionTokens: 2334, UseTime: 49, IsStream: false}
	if e.ShowsTPS() {
		t.Error("a non streaming entry must not show a throughput")
	}
	if e.OutputTPS() == 0 {
		t.Error("OutputTPS should still compute for a non streaming entry")
	}
}

func TestLogEntryThroughputGuardsAgainstZero(t *testing.T) {
	for _, e := range []LogEntry{
		{CompletionTokens: 100, UseTime: 0},
		{CompletionTokens: 0, UseTime: 10},
	} {
		if e.OutputTPS() != 0 {
			t.Errorf("OutputTPS = %v, want 0", e.OutputTPS())
		}
	}
}

func TestLogOtherKeepsEveryField(t *testing.T) {
	raw := `{"frt":35949,"cache_tokens":266368,"provider_slug":"demo","provider_name":"Demo",` +
		`"site_input_price":0.0169,"reasoning_effort":"max","request_conversion":["OpenAI Compatible"]}`
	var e LogEntry
	if err := json.Unmarshal([]byte(`{"other":`+strconv.Quote(raw)+`}`), &e); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(e.Other) != 7 {
		t.Fatalf("other kept %d fields, want 7", len(e.Other))
	}
	if e.Other.FRT() != 35949 {
		t.Errorf("FRT = %d, want 35949", e.Other.FRT())
	}
	if e.Other.CacheTokens() != 266368 {
		t.Errorf("CacheTokens = %d, want 266368", e.Other.CacheTokens())
	}
	if e.Other.ProviderSlug() != "demo" {
		t.Errorf("ProviderSlug = %q, want demo", e.Other.ProviderSlug())
	}
	if e.FirstResponseTimeMs() != 35949 {
		t.Errorf("FirstResponseTimeMs = %d, want 35949", e.FirstResponseTimeMs())
	}
}

func TestLogOtherAcceptsThePlainObjectForm(t *testing.T) {
	var e LogEntry
	if err := json.Unmarshal([]byte(`{"other":{"frt":1234}}`), &e); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if e.Other.FRT() != 1234 {
		t.Errorf("FRT = %d, want 1234", e.Other.FRT())
	}
}

func TestLogOtherToleratesNull(t *testing.T) {
	var e LogEntry
	if err := json.Unmarshal([]byte(`{"other":null}`), &e); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(e.Other) != 0 {
		t.Errorf("other = %v, want an empty map", e.Other)
	}
}
