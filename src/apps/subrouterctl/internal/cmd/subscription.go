package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func newSubscriptionCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "subscription",
		Short: "Inspect and manage paid account plans",
	}
	cmd.AddCommand(
		newSubscriptionListCommand(),
		newSubscriptionPlansCommand(),
		newSubscriptionPreferenceCommand(),
		newSubscriptionPayCommand(),
	)
	return cmd
}

func newSubscriptionListCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "Show the current paid plans and quota",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			state, err := cl.GetSubscriptionState(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(state)
			}
			w.Detail("Plans", []render.Field{{Label: "Active", Value: strconv.Itoa(len(state.Subscriptions))},
				{Label: "All", Value: strconv.Itoa(len(state.AllSubscriptions))},
				{Label: "Billing preference", Value: fmt.Sprintf("%v", state.BillingPreference)},
			})
			return nil
		},
	}
}

func newSubscriptionPlansCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "plans",
		Short: "List the purchasable paid plans",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			plans, err := cl.ListSubscriptionPlans(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(plans)
			}
			rows := make([][]string, 0, len(plans))
			for _, p := range plans {
				rows = append(rows, []string{
					strconv.Itoa(p.ID),
					p.Name,
					fmt.Sprintf("%.2f", p.Price),
					w.Money(p.Quota),
					strconv.Itoa(p.Duration),
					orDash(p.Status),
				})
			}
			w.Table([]render.Column{
				{Title: "ID", Align: render.AlignRight}, {Title: "NAME"}, {Title: "PRICE", Align: render.AlignRight},
				{Title: "QUOTA", Align: render.AlignRight}, {Title: "DAYS", Align: render.AlignRight}, {Title: "STATUS"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "name")
	return cmd
}

func newSubscriptionPreferenceCommand() *cobra.Command {
	var (
		priority  string
		walletUse string
	)
	cmd := &cobra.Command{
		Use:   "preference",
		Short: "Update the wallet and plan billing priority",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			body := map[string]any{}
			if cmd.Flags().Changed("priority") {
				body["billing_priority"] = priority
			}
			if cmd.Flags().Changed("wallet") {
				body["use_wallet_first"] = walletUse == "first"
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass --priority or --wallet")
			}
			state, err := cl.UpdateSubscriptionPreference(ctx, body)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(state)
			}
			w.Success("billing preference updated")
			return nil
		},
	}
	cmd.Flags().StringVar(&priority, "priority", "", "billing priority, for example plan_first or wallet_first")
	cmd.Flags().StringVar(&walletUse, "wallet", "", "wallet usage order: first or last")
	return cmd
}

func newSubscriptionPayCommand() *cobra.Command {
	var (
		provider string
		planID   int
		body     string
	)
	cmd := &cobra.Command{
		Use:   "pay",
		Short: "Start a checkout session for a paid account plan",
		Long: `Start a checkout session. The server returns a URL that is opened in a
browser; no card data ever passes through this CLI.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			var pay api.PayProvider
			switch strings.ToLower(provider) {
			case "stripe":
				pay = api.PayStripe
			case "creem":
				pay = api.PayCreem
			case "epay":
				pay = api.PayEPay
			default:
				return fmt.Errorf("--provider must be stripe, creem or epay")
			}
			payload := map[string]any{}
			if planID > 0 {
				payload["plan_id"] = planID
			}
			if body != "" {
				if err := decodeJSONFlag(body, &payload); err != nil {
					return err
				}
			}
			if !confirm(fmt.Sprintf("create a %s checkout session?", pay)) {
				w.Plain("cancelled")
				return nil
			}
			out, err := cl.CreatePlanCheckout(ctx, pay, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("checkout session created")
			w.Plain("  %v", out)
			return nil
		},
	}
	cmd.Flags().StringVar(&provider, "provider", "", "checkout backend: stripe, creem or epay")
	cmd.Flags().IntVar(&planID, "plan-id", 0, "plan id to purchase")
	cmd.Flags().StringVar(&body, "body", "", "extra request body as JSON")
	return cmd
}
