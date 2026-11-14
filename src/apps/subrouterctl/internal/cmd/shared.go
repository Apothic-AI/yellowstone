package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
)

func newSharedCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "shared",
		Short: "Manage shared pool subscriptions",
	}
	cmd.AddCommand(
		newSharedListCommand(),
		newSharedSubscribeCommand(),
		newSharedCancelCommand(),
	)
	return cmd
}

func newSharedListCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List the shared plans and the subscription state",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			plans, err := cl.ListSharedPlans(ctx)
			if err != nil {
				return err
			}
			if lf.search != "" {
				q := strings.ToLower(lf.search)
				filtered := plans[:0]
				for _, p := range plans {
					hay := strings.ToLower(p.Plan.Slug + " " + p.Plan.Title + " " + p.Plan.Vendor)
					if strings.Contains(hay, q) {
						filtered = append(filtered, p)
					}
				}
				plans = filtered
			}
			if w.IsStructured() {
				return w.Structured(plans)
			}
			rows := make([][]string, 0, len(plans))
			for _, p := range plans {
				state := "available"
				if p.Subscribed {
					state = "subscribed"
				}
				rows = append(rows, []string{
					strconv.Itoa(p.Plan.ID),
					p.Plan.Slug,
					orDash(p.Plan.Title),
					orDash(p.Plan.Vendor),
					orDash(p.Plan.Tier),
					w.StatusColor(state),
					strconv.Itoa(len(p.Models)),
					orDash(p.PoolStatus.Health),
					strconv.Itoa(p.PoolStatus.AvailableAccounts),
				})
			}
			w.Table([]render.Column{
				{Title: "ID", Align: render.AlignRight}, {Title: "SLUG"}, {Title: "TITLE"}, {Title: "VENDOR"},
				{Title: "TIER"}, {Title: "STATE"}, {Title: "MODELS", Align: render.AlignRight},
				{Title: "HEALTH"}, {Title: "ACCOUNTS", Align: render.AlignRight},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "slug")
	return cmd
}

func newSharedSubscribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "subscribe <plan-id>",
		Short: "Subscribe to a shared pool plan",
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
				return fmt.Errorf("plan id must be a number, got %q", args[0])
			}
			out, err := cl.SubscribeSharedPlan(ctx, id)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("subscribed to shared plan %d", id)
			return nil
		},
	}
}

func newSharedCancelCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <plan-id>",
		Short: "Cancel a shared pool subscription",
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
				return fmt.Errorf("plan id must be a number, got %q", args[0])
			}
			if !confirm(fmt.Sprintf("cancel the shared plan subscription %d?", id)) {
				w.Plain("cancelled")
				return nil
			}
			if err := cl.CancelSharedPlan(ctx, id); err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{"cancelled": id})
			}
			w.Success("cancelled shared plan %d", id)
			return nil
		},
	}
}
