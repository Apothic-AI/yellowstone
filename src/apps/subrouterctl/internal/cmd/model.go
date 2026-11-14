package cmd

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func newModelCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "model",
		Short: "Search the model directory",
	}
	cmd.AddCommand(
		newModelListCommand(),
		newModelShowCommand(),
		newModelPricingCommand(),
		newModelOptionsCommand(),
		newModelSubrouterCommand(),
	)
	return cmd
}

func newModelListCommand() *cobra.Command {
	var (
		lf         listFlags
		category   string
		providerID int
	)
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List marketplace models with their prices",
		Long: `List the public model directory.

--search is sent to the server as a keyword filter. --sort is applied locally,
so it fetches every matching page before ordering.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			models, err := fetchModels(ctx, cl, lf, category, providerID)
			if err != nil {
				return err
			}
			models = api.FilterModels(models, lf.search)
			api.SortModels(models, lf.sort, lf.desc())
			if w.IsStructured() {
				return w.Structured(map[string]any{"total": len(models), "items": models})
			}
			w.Table(modelColumns(), lf.applyLimit(modelRows(models)))
			return nil
		},
	}
	lf.add(cmd, "model")
	f := cmd.Flags()
	f.StringVar(&category, "category", "", "filter by category")
	f.IntVar(&providerID, "provider-id", 0, "filter by provider id")
	return cmd
}

// fetchModels loads models, walking pages when a local sort is requested.
func fetchModels(ctx context.Context, cl *api.Client, lf listFlags, category string, providerID int) ([]api.MarketplaceModel, error) {
	size := lf.pageSize
	if size <= 0 {
		size = 50
	}
	q := api.ModelQuery{Keyword: lf.search, Category: category, ProviderID: providerID, PageSize: size}
	if lf.sort == "" {
		q.Page = lf.page
		page, err := cl.ListMarketplaceModels(ctx, q)
		if err != nil {
			return nil, err
		}
		return page.Items, nil
	}
	// A local sort needs every page, so fetch them in parallel.
	q.Page = 1
	first, err := cl.ListMarketplaceModels(ctx, q)
	if err != nil {
		return nil, err
	}
	all := first.Items
	pages := 1
	if first.Total > size {
		pages = (first.Total + size - 1) / size
	}
	if pages > 1 {
		rest, err := concurrentPages(ctx, pages-1, 4, func(ctx context.Context, page int) ([]api.MarketplaceModel, int, error) {
			p := q
			p.Page = page + 1
			res, err := cl.ListMarketplaceModels(ctx, p)
			if err != nil {
				return nil, 0, err
			}
			return res.Items, res.Total, nil
		})
		if err != nil {
			return nil, err
		}
		all = append(all, rest...)
	}
	return all, nil
}

func newModelShowCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id>",
		Short: "Show one marketplace model",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			id, err := strconv.Atoi(args[0])
			if err != nil {
				return fmt.Errorf("id must be a number, got %q", args[0])
			}
			m, err := cl.GetMarketplaceModel(ctx, id)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(m)
			}
			w.Detail("Model "+m.ModelName, []render.Field{
				{Label: "Id", Value: m.ID.String()},
				{Label: "Provider", Value: orDash(m.ProviderName)},
				{Label: "Provider slug", Value: orDash(m.ProviderSlug)},
				{Label: "Upstream model", Value: orDash(m.UpstreamModel)},
				{Label: "Category", Value: orDash(m.Category)},
				{Label: "Billing mode", Value: orDash(m.BillingMode)},
				{Label: "Region", Value: orDash(m.Region)},
				{Label: "Routing mode", Value: orDash(m.RoutingMode)},
				{Label: "Input price", Value: fmt.Sprintf("%.4f %s", m.InputPrice, m.PriceCurrency)},
				{Label: "Output price", Value: fmt.Sprintf("%.4f %s", m.OutputPrice, m.PriceCurrency)},
				{Label: "Fixed price", Value: fmt.Sprintf("%.4f %s", m.FixedPrice, m.PriceCurrency)},
				{Label: "Official input", Value: fmt.Sprintf("%.4f", m.OfficialInputPrice)},
				{Label: "Official output", Value: fmt.Sprintf("%.4f", m.OfficialOutputPrice)},
				{Label: "Cache read", Value: fmt.Sprintf("%.4f", m.CacheReadPrice)},
				{Label: "Cache creation", Value: fmt.Sprintf("%.4f", m.CacheCreationPrice)},
				{Label: "Context length", Value: strconv.Itoa(m.ContextLength)},
				{Label: "Availability", Value: fmt.Sprintf("%.1f%%", m.Availability)},
				{Label: "Average latency", Value: fmt.Sprintf("%.0f ms", m.AvgLatency)},
				{Label: "Median TTFT", Value: fmt.Sprintf("%.0f ms", m.MedianTTFT)},
				{Label: "Cache hit rate", Value: fmt.Sprintf("%.1f%%", m.CacheHitRate)},
				{Label: "Rating", Value: fmt.Sprintf("%.2f", m.Rating)},
				{Label: "Requests", Value: strconv.FormatInt(m.TotalRequests, 10)},
				{Label: "Last call", Value: w.Time(m.LastCallTime)},
				{Label: "Updated", Value: w.Time(m.UpdatedTime)},
				{Label: "Endpoints", Value: orDash(m.Endpoints)},
				{Label: "Description", Value: orDash(m.Description)},
				{Label: "Features", Value: orDash(m.Features)},
			})
			return nil
		},
	}
}

func newModelPricingCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "pricing",
		Short: "Show the public price sheet",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			pricing, err := cl.GetPricing(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(pricing)
			}
			w.Plain("%v", pricing)
			return nil
		},
	}
}

func newModelOptionsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "options",
		Short: "List every model name the marketplace offers",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			opts, err := cl.GetModelOptions(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(opts)
			}
			w.Plain("%v", opts)
			return nil
		},
	}
}

func newModelSubrouterCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "routing",
		Short: "List the smart-routing models and their provider offers",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			models, err := cl.GetSubrouterModels(ctx)
			if err != nil {
				return err
			}
			if lf.search != "" {
				q := strings.ToLower(lf.search)
				filtered := models[:0]
				for _, m := range models {
					hay := strings.ToLower(m.ModelName + " " + m.Category)
					for _, p := range m.Providers {
						hay += " " + strings.ToLower(p.ProviderSlug+" "+p.ProviderName)
					}
					if strings.Contains(hay, q) {
						filtered = append(filtered, m)
					}
				}
				models = filtered
			}
			api.SortSubrouterModels(models, lf.sort, lf.desc())
			if w.IsStructured() {
				return w.Structured(models)
			}
			rows := make([][]string, 0, len(models))
			for _, m := range models {
				providers := make([]string, 0, len(m.Providers))
				for _, p := range m.Providers {
					providers = append(providers, p.ProviderSlug)
				}
				rows = append(rows, []string{
					m.ModelName,
					orDash(m.Category),
					strconv.Itoa(m.ProviderCount),
					fmt.Sprintf("%.4f", m.MinInputPrice),
					fmt.Sprintf("%.4f", m.MinOutputPr),
					strings.Join(providers, ", "),
				})
			}
			w.Table([]render.Column{
				{Title: "MODEL"}, {Title: "CATEGORY"}, {Title: "PROVIDERS", Align: render.AlignRight},
				{Title: "IN/M", Align: render.AlignRight}, {Title: "OUT/M", Align: render.AlignRight},
				{Title: "ROUTES"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

// modelColumns is the column layout of the model directory.
func modelColumns() []render.Column {
	return []render.Column{
		{Title: "MODEL"}, {Title: "PROVIDER"}, {Title: "CATEGORY"},
		{Title: "IN/M", Align: render.AlignRight}, {Title: "OUT/M", Align: render.AlignRight},
		{Title: "CCY"}, {Title: "UPTIME", Align: render.AlignRight},
		{Title: "RATING", Align: render.AlignRight}, {Title: "CTX", Align: render.AlignRight},
	}
}

// modelRows renders model rows for the model table.
func modelRows(models []api.MarketplaceModel) [][]string {
	rows := make([][]string, 0, len(models))
	for _, m := range models {
		rows = append(rows, []string{
			m.ModelName,
			orDash(m.ProviderName),
			orDash(m.Category),
			fmt.Sprintf("%.4f", m.InputPrice),
			fmt.Sprintf("%.4f", m.OutputPrice),
			orDash(m.PriceCurrency),
			fmt.Sprintf("%.1f%%", m.Availability),
			fmt.Sprintf("%.2f", m.Rating),
			strconv.Itoa(m.ContextLength),
		})
	}
	return rows
}
