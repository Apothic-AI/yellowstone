package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newStationCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "station",
		Short: "Manage a distributor station (分站站长)",
		Long: `Manage a SubRouter powered station of your own: the profile, the model
shelf, packages, customers, key groups and earnings. These endpoints require
the distributor role; a regular account answers HTTP 403.

Withdrawal, package funding and redemption code creation stay in the browser
console.`,
	}
	cmd.AddCommand(
		newStationSelfCommand(),
		newStationDashboardCommand(),
		newStationModelsCommand(),
		newStationGlobalModelsCommand(),
		newStationPackagesCommand(),
		newStationCustomersCommand(),
		newStationKeyGroupsCommand(),
		newStationSharedCommand(),
		newStationOfficialChannelsCommand(),
		newStationLogsCommand(),
		newStationEarningsCommand(),
	)
	return cmd
}

func newStationSelfCommand() *cobra.Command {
	var body string
	cmd := &cobra.Command{
		Use:   "self",
		Short: "Show or update the station profile",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			if body == "" {
				out, err := cl.DistributorSelf(ctx)
				if err != nil {
					return err
				}
				if w.IsStructured() {
					return w.Structured(out)
				}
				w.Plain("%v", out)
				return nil
			}
			payload := map[string]any{}
			if err := decodeJSONFlag(body, &payload); err != nil {
				return err
			}
			if !confirm(fmt.Sprintf("update the station profile with %d fields?", len(payload))) {
				w.Plain("cancelled")
				return nil
			}
			out, err := cl.UpdateDistributorSelf(ctx, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("station profile updated")
			return nil
		},
	}
	cmd.Flags().StringVar(&body, "body", "", "profile update body as JSON (only the keys you send change)")
	return cmd
}

func newStationDashboardCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "dashboard",
		Short: "Show station traffic and revenue counters",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.DistributorDashboard(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
}

func newStationModelsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "models",
		Short: "List the models listed in manual mode",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorModels(ctx, lf.page, lf.pageSize)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

func newStationGlobalModelsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "global-models",
		Short: "List the models listed in full catalogue mode",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorGlobalModels(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
}

func newStationPackagesCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "packages",
		Short: "List the station packages",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorPackages(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
	lf.add(cmd, "name")
	return cmd
}

func newStationCustomersCommand() *cobra.Command {
	var (
		lf      listFlags
		keyword string
	)
	cmd := &cobra.Command{
		Use:   "customers",
		Short: "List station customers",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorCustomers(ctx, keyword, lf.page, lf.pageSize)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
	lf.add(cmd, "user")
	cmd.Flags().StringVar(&keyword, "keyword", "", "filter by keyword")
	return cmd
}

func newStationKeyGroupsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "key-groups",
		Short: "List the station key groups",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorKeyGroups(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
}

func newStationSharedCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "shared",
		Short: "List the shared plans the station procured",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorSharedSubscriptions(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
}

func newStationOfficialChannelsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "official-channels",
		Short: "List the official channels offered by the platform",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListDistributorOfficialChannels(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
}

func newStationLogsCommand() *cobra.Command {
	var (
		lf      listFlags
		tf      timeFlags
		summary bool
	)
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show station usage logs",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			start, end, err := tf.range_()
			if err != nil {
				return err
			}
			q := apiLogQuery(start, end, lf)
			var out any
			if summary {
				out, err = cl.GetDistributorLogStat(ctx, q)
			} else {
				out, err = cl.GetDistributorLogs(ctx, q)
			}
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
	lf.add(cmd, "time")
	tf.add(cmd)
	cmd.Flags().BoolVar(&summary, "summary", false, "show the totals instead of the list")
	return cmd
}

func newStationEarningsCommand() *cobra.Command {
	var (
		lf      listFlags
		tf      timeFlags
		summary bool
	)
	cmd := &cobra.Command{
		Use:   "earnings",
		Short: "Show station earnings",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			start, end, err := tf.range_()
			if err != nil {
				return err
			}
			q := apiLogQuery(start, end, lf)
			var out any
			if summary {
				out, err = cl.GetDistributorEarningsSummary(ctx, q)
			} else {
				out, err = cl.GetDistributorEarnings(ctx, q)
			}
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Plain("%v", out)
			return nil
		},
	}
	lf.add(cmd, "created")
	tf.add(cmd)
	cmd.Flags().BoolVar(&summary, "summary", false, "show the totals instead of the list")
	return cmd
}
