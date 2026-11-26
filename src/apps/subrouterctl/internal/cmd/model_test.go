package cmd

import (
	"testing"

	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

// The catalogue tables gained a TPS column when the API started returning a
// platform-measured output speed per model offer. These tests pin the column
// layout and the two cases that matter: a measured offer prints its speed, and
// an offer the platform has not measured prints a dash rather than 0.0.

func TestModelColumnsMatchEveryRowWidth(t *testing.T) {
	models := []api.MarketplaceModel{
		{ModelName: "demo-chat", ProviderName: "Demo", Category: "chat", InputPrice: 0.15,
			OutputPrice: 0.6, PriceCurrency: "USD", Availability: 99.5, Rating: 4.5,
			ContextLength: 128000, OutputTokensPerSecond: 124.5, OutputSpeedSamples: 42},
		{ModelName: "unmeasured", ProviderName: "Demo"},
	}
	cols := modelColumns()
	for i, row := range modelRows(models) {
		if len(row) != len(cols) {
			t.Fatalf("row %d has %d cells, the table has %d columns", i, len(row), len(cols))
		}
	}
}

func TestModelRowsRenderOutputSpeed(t *testing.T) {
	cols := modelColumns()
	tpsIndex := -1
	for i, c := range cols {
		if c.Title == "TPS" {
			tpsIndex = i
		}
	}
	if tpsIndex < 0 {
		t.Fatalf("the catalogue table has no TPS column: %v", cols)
	}

	rows := modelRows([]api.MarketplaceModel{
		{ModelName: "measured", OutputTokensPerSecond: 124.53, OutputSpeedSamples: 42},
		{ModelName: "unmeasured"},
	})
	if got, want := rows[0][tpsIndex], "124.5"; got != want {
		t.Errorf("measured offer renders TPS %q, want %q", got, want)
	}
	if got, want := rows[1][tpsIndex], "-"; got != want {
		t.Errorf("unmeasured offer renders TPS %q, want %q", got, want)
	}
}

func TestTPSCell(t *testing.T) {
	cases := []struct {
		tps     float64
		samples int
		want    string
	}{
		{0, 0, "-"},
		{124.53, 42, "124.5"},
		{0, 7, "0.0/7"},
	}
	for _, c := range cases {
		if got := tpsCell(c.tps, c.samples); got != c.want {
			t.Errorf("tpsCell(%v, %d) = %q, want %q", c.tps, c.samples, got, c.want)
		}
	}
}

func TestTPSDetail(t *testing.T) {
	if got, want := tpsDetail(124.5, 42), "124.5 tok/s from 42 samples"; got != want {
		t.Errorf("tpsDetail = %q, want %q", got, want)
	}
	if got, want := tpsDetail(0, 0), "not measured"; got != want {
		t.Errorf("tpsDetail = %q, want %q", got, want)
	}
}

func TestProviderColumnsMatchEveryRowWidth(t *testing.T) {
	providers := []api.MarketplaceProvider{
		{Slug: "demo", CompanyName: "Demo", Status: "1", Availability: 99.5, Rating: 4.5,
			ModelCount: 10, CreditScore: 500, RiskModelCount: 2, ReportAnomalyCount: 1,
			GuaranteeLevel: "4"},
	}
	cols := providerColumns()
	for i, row := range providerRows(providers) {
		if len(row) != len(cols) {
			t.Fatalf("row %d has %d cells, the table has %d columns", i, len(row), len(cols))
		}
	}
}

func TestProviderRowsRenderRiskAndReports(t *testing.T) {
	cols := providerColumns()
	index := func(title string) int {
		for i, c := range cols {
			if c.Title == title {
				return i
			}
		}
		t.Fatalf("the provider table has no %s column: %v", title, cols)
		return -1
	}
	rows := providerRows([]api.MarketplaceProvider{{
		Slug: "demo", CompanyName: "Demo Provider", Status: "1", Availability: 99.5,
		Rating: 4.5, ModelCount: 10, CreditScore: 512, RiskModelCount: 3,
		ReportAnomalyCount: 2, GuaranteeLevel: "4",
	}})
	if got, want := rows[0][index("RISK")], "3"; got != want {
		t.Errorf("RISK cell = %q, want %q", got, want)
	}
	if got, want := rows[0][index("REPORTS")], "2"; got != want {
		t.Errorf("REPORTS cell = %q, want %q", got, want)
	}
}

func TestCreditInputsExplainsTheScore(t *testing.T) {
	got := creditInputs(api.MarketplaceProvider{
		CreditBaseSpendUSD:     250,
		CreditPaidUserCount:    7,
		CreditReviewAdjustment: 1.5,
		CreditReviewCount:      2,
		CreditReportAdjustment: -0.5,
		CreditReportCount:      1,
		CreditSocialMultiplier: 1.2,
	})
	want := "base $250.00, paid users 7, review +1.50 (n=2), report -0.50 (n=1), social x1.20"
	if got != want {
		t.Errorf("creditInputs = %q, want %q", got, want)
	}
}
