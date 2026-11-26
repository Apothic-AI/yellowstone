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

func newProviderCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "provider",
		Aliases: []string{"providers"},
		Short:   "Browse providers and manage provider subscriptions",
	}
	cmd.AddCommand(
		newProviderListCommand(),
		newProviderShowCommand(),
		newProviderModelsCommand(),
		newProviderSubsCommand(),
		newProviderSubscribeCommand(),
		newProviderUnsubscribeCommand(),
		newProviderSubscribeAllCommand(),
		newProviderUnsubscribeAllCommand(),
		newProviderSubConfigCommand(),
		newProviderSharedProvidersCommand(),
	)
	return cmd
}

func newProviderListCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the provider directory",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			providers, err := fetchProviders(ctx, cl, lf)
			if err != nil {
				return err
			}
			providers = api.FilterProviders(providers, lf.search)
			api.SortProviders(providers, lf.sort, lf.desc())
			if w.IsStructured() {
				return w.Structured(map[string]any{"total": len(providers), "items": providers})
			}
			w.Table(providerColumns(), lf.applyLimit(providerRows(providers)))
			return nil
		},
	}
	lf.add(cmd, "name")
	return cmd
}

// providerColumns is the column layout of the provider directory.
//
// There is no TPS column here: the provider record carries no provider-level
// generation speed. Speed is measured per model offer, so it appears on the
// catalogue tables of 'provider show', 'provider models' and 'model list'.
func providerColumns() []render.Column {
	return []render.Column{
		{Title: "SLUG"}, {Title: "COMPANY"}, {Title: "STATUS"},
		{Title: "UPTIME", Align: render.AlignRight}, {Title: "RATING", Align: render.AlignRight},
		{Title: "MODELS", Align: render.AlignRight}, {Title: "CREDIT", Align: render.AlignRight},
		{Title: "RISK", Align: render.AlignRight}, {Title: "REPORTS", Align: render.AlignRight},
		{Title: "GUARANTEE"},
	}
}

// providerRows renders the directory rows.
func providerRows(providers []api.MarketplaceProvider) [][]string {
	rows := make([][]string, 0, len(providers))
	for _, p := range providers {
		rows = append(rows, []string{
			p.Slug,
			orDash(p.CompanyName),
			p.StatusLabel(),
			fmt.Sprintf("%.1f%%", p.Availability),
			fmt.Sprintf("%.2f", p.Rating),
			strconv.Itoa(p.ModelCount),
			fmt.Sprintf("%.0f", p.CreditScore),
			strconv.Itoa(p.RiskModelCount),
			strconv.Itoa(p.ReportAnomalyCount),
			orDash(p.GuaranteeLevel),
		})
	}
	return rows
}

// creditInputs renders the parts of a provider's credit score, so that the
// score can be explained rather than taken on faith.
func creditInputs(p api.MarketplaceProvider) string {
	return fmt.Sprintf("base $%.2f, paid users %d, review %+.2f (n=%d), report %+.2f (n=%d), social x%.2f",
		p.CreditBaseSpendUSD, p.CreditPaidUserCount,
		p.CreditReviewAdjustment, p.CreditReviewCount,
		p.CreditReportAdjustment, p.CreditReportCount,
		p.CreditSocialMultiplier)
}

// fetchProviders loads providers, walking pages when a local sort is asked for.
func fetchProviders(ctx context.Context, cl *api.Client, lf listFlags) ([]api.MarketplaceProvider, error) {
	size := lf.pageSize
	if size <= 0 {
		size = 50
	}
	q := api.ProviderQuery{Keyword: lf.search, PageSize: size}
	if lf.sort == "" {
		q.Page = lf.page
		page, err := cl.ListMarketplaceProviders(ctx, q)
		if err != nil {
			return nil, err
		}
		return page.Items, nil
	}
	// A local sort needs every page, so fetch them in parallel.
	q.Page = 1
	first, err := cl.ListMarketplaceProviders(ctx, q)
	if err != nil {
		return nil, err
	}
	all := first.Items
	pages := 1
	if first.Total > size {
		pages = (first.Total + size - 1) / size
	}
	if pages > 1 {
		rest, err := concurrentPages(ctx, pages-1, 8, func(ctx context.Context, page int) ([]api.MarketplaceProvider, int, error) {
			p := q
			p.Page = page + 1
			res, err := cl.ListMarketplaceProviders(ctx, p)
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

func newProviderShowCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "show <slug>",
		Short: "Show one provider with its catalogue",
		Long: `Show one provider from the directory, followed by the models it serves.

The provider is addressed by slug, for example demo. Use --search and --sort to
narrow the catalogue.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			detail, err := cl.GetMarketplaceProvider(ctx, args[0])
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(detail)
			}
			p := detail.Provider
			w.Detail("Provider "+p.CompanyName, []render.Field{
				{Label: "Id", Value: p.ID.String()},
				{Label: "Slug", Value: orDash(p.Slug)},
				{Label: "Status", Value: p.StatusLabel()},
				{Label: "Verified", Value: boolLabel(p.Verified)},
				{Label: "Rating", Value: fmt.Sprintf("%.2f", p.Rating)},
				{Label: "Uptime", Value: fmt.Sprintf("%.2f%%", p.Availability)},
				{Label: "Models", Value: fmt.Sprintf("%d listed, %d public", len(detail.Models), detail.PublicModelCount)},
				{Label: "Credit score", Value: fmt.Sprintf("%.0f", p.CreditScore)},
				{Label: "Deposit", Value: fmt.Sprintf("$%.0f", p.DepositUSD)},
				{Label: "Guarantee", Value: fmt.Sprintf("$%.0f (level %s)", p.GuaranteeUSD, p.GuaranteeLevel)},
				{Label: "Max RPM", Value: strconv.Itoa(p.MaxRPM)},
				{Label: "Subscribers", Value: strconv.Itoa(p.SubscriptionCount)},
				{Label: "Anomaly models", Value: fmt.Sprintf("%d (same models: %d)", p.AnomalyModelCount, len(p.AnomalyModels))},
				{Label: "Risk models", Value: strconv.Itoa(p.RiskModelCount)},
				{Label: "Reported anomalies", Value: fmt.Sprintf("%d (listed: %d)", p.ReportAnomalyCount, len(p.ReportAnomalies))},
				{Label: "Integrity", Value: orDash(detail.BazaarlinkSummary.IntegrityStatus)},
				{Label: "Reviewed models", Value: fmt.Sprintf("%d of %d observed, %d tested, %d failed", detail.BazaarlinkSummary.AIReviewedModelCount, detail.BazaarlinkSummary.ObservedModelCount, detail.BazaarlinkSummary.TestedModelCount, detail.BazaarlinkSummary.FailedModelCount)},
				{Label: "Credit inputs", Value: creditInputs(p)},
				{Label: "Description", Value: orDash(p.Description)},
			})
			models := api.FilterModels(detail.Models, lf.search)
			api.SortModels(models, lf.sort, lf.desc())
			w.Plain("")
			w.Table(modelColumns(), lf.applyLimit(modelRows(models)))
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

func newProviderModelsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "models <slug>",
		Short: "List the models one provider serves",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			detail, err := cl.GetMarketplaceProvider(ctx, args[0])
			if err != nil {
				return err
			}
			models := api.FilterModels(detail.Models, lf.search)
			api.SortModels(models, lf.sort, lf.desc())
			if w.IsStructured() {
				return w.Structured(map[string]any{
					"provider": detail.Provider,
					"models":   models,
				})
			}
			w.Table(modelColumns(), lf.applyLimit(modelRows(models)))
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

func newProviderSubsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "subs",
		Short: "List the providers this account subscribes to",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			subs, err := cl.ListProviderSubscriptions(ctx)
			if err != nil {
				return err
			}
			if lf.search != "" {
				q := strings.ToLower(lf.search)
				filtered := subs[:0]
				for _, s := range subs {
					if strings.Contains(strings.ToLower(s.Slug+" "+s.CompanyName), q) {
						filtered = append(filtered, s)
					}
				}
				subs = filtered
			}
			if w.IsStructured() {
				return w.Structured(subs)
			}
			rows := make([][]string, 0, len(subs))
			for _, s := range subs {
				rows = append(rows, []string{
					strconv.Itoa(s.ID),
					s.Slug,
					orDash(s.CompanyName),
					s.StatusLabel(),
					w.Money(s.Balance),
					strconv.Itoa(s.ModelCount),
					fmt.Sprintf("%.1f%%", s.CommissionRate*100),
				})
			}
			w.Table([]render.Column{
				{Title: "ID", Align: render.AlignRight}, {Title: "SLUG"}, {Title: "COMPANY"}, {Title: "STATUS"},
				{Title: "BALANCE", Align: render.AlignRight}, {Title: "MODELS", Align: render.AlignRight},
				{Title: "COMMISSION", Align: render.AlignRight},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "slug")
	return cmd
}

func newProviderSubscribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "subscribe <provider-id>",
		Short: "Add a provider to the routing sources",
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
				return fmt.Errorf("provider id must be a number, got %q", args[0])
			}
			out, err := cl.SubscribeProvider(ctx, id)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("subscribed to provider %d", id)
			return nil
		},
	}
}

func newProviderUnsubscribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "unsubscribe <provider-id>",
		Short: "Remove a provider from the routing sources",
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
				return fmt.Errorf("provider id must be a number, got %q", args[0])
			}
			if !confirm(fmt.Sprintf("unsubscribe from provider %d?", id)) {
				w.Plain("cancelled")
				return nil
			}
			if err := cl.UnsubscribeProvider(ctx, id); err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{"unsubscribed": id})
			}
			w.Success("unsubscribed from provider %d", id)
			return nil
		},
	}
}

func newProviderSubscribeAllCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "subscribe-all",
		Short: "Subscribe to every available provider and shared pool",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			if !confirm("subscribe to every available provider and shared pool?") {
				w.Plain("cancelled")
				return nil
			}
			out, err := cl.SubscribeAll(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("subscribed to all available providers and shared pools")
			return nil
		},
	}
}

func newProviderUnsubscribeAllCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "unsubscribe-all",
		Short: "Remove every provider and shared pool subscription",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			if !confirm("unsubscribe from every provider and shared pool?") {
				w.Plain("cancelled")
				return nil
			}
			if err := cl.UnsubscribeAll(ctx); err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{"unsubscribed": "all"})
			}
			w.Success("unsubscribed from every provider and shared pool")
			return nil
		},
	}
}

func newProviderSubConfigCommand() *cobra.Command {
	var autoSubscribe bool
	cmd := &cobra.Command{
		Use:   "sub-config",
		Short: "Show or change the provider auto-subscribe settings",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			if !cmd.Flags().Changed("auto-subscribe") {
				cfg, err := cl.GetSubscriptionConfig(ctx)
				if err != nil {
					return err
				}
				if w.IsStructured() {
					return w.Structured(cfg)
				}
				w.Detail("Auto-subscribe", []render.Field{{Label: "Enabled", Value: boolLabel(cfg.AutoSubscribeNew)},
					{Label: "Eligible", Value: strconv.Itoa(cfg.EligibleCount)},
					{Label: "Subscribed", Value: strconv.Itoa(cfg.SubscribedCount)},
					{Label: "Blacklisted", Value: strconv.Itoa(cfg.BlacklistedCount)},
				})
				return nil
			}
			body := map[string]any{"auto_subscribe_new": autoSubscribe}
			cfg, err := cl.UpdateSubscriptionConfig(ctx, body)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(cfg)
			}
			w.Success("auto-subscribe set to %v", autoSubscribe)
			return nil
		},
	}
	cmd.Flags().BoolVar(&autoSubscribe, "auto-subscribe", false, "set the auto-subscribe flag")
	return cmd
}

func newProviderSharedProvidersCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "shared",
		Short: "List the shared pool providers",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			providers, err := cl.GetSharedProviders(ctx)
			if err != nil {
				return err
			}
			if lf.search != "" {
				q := strings.ToLower(lf.search)
				filtered := providers[:0]
				for _, p := range providers {
					hay := strings.ToLower(strings.Join([]string{p.Slug, p.CompanyName, p.Description, p.Vendor, p.Tier}, " "))
					if strings.Contains(hay, q) {
						filtered = append(filtered, p)
					}
				}
				providers = filtered
			}
			if w.IsStructured() {
				return w.Structured(providers)
			}
			rows := make([][]string, 0, len(providers))
			for _, p := range providers {
				state := "available"
				if p.Subscribed {
					state = "subscribed"
				}
				rows = append(rows, []string{
					p.Slug,
					orDash(p.CompanyName),
					orDash(p.Vendor),
					orDash(p.Tier),
					w.StatusColor(state),
					orDash(p.PoolStatus.Health),
					strconv.Itoa(p.PoolStatus.AvailableAccounts) + "/" + strconv.Itoa(p.PoolStatus.TotalAccounts),
					strconv.Itoa(p.SupplyCount),
					strconv.Itoa(p.ModelCount),
					fmt.Sprintf("%.2f%%", float64(p.DefaultDiscountBps)/100),
					fmt.Sprintf("%.1f%%", p.Availability),
				})
			}
			w.Table([]render.Column{
				{Title: "SLUG"}, {Title: "COMPANY"}, {Title: "VENDOR"}, {Title: "TIER"},
				{Title: "STATE"}, {Title: "HEALTH"},
				{Title: "ACCOUNTS", Align: render.AlignRight}, {Title: "SUPPLY", Align: render.AlignRight},
				{Title: "MODELS", Align: render.AlignRight}, {Title: "DISCOUNT", Align: render.AlignRight},
				{Title: "UPTIME", Align: render.AlignRight},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "name")
	return cmd
}
