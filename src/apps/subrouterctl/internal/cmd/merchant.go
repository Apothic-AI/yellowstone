package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func newMerchantCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "merchant",
		Short: "Manage the account as a provider (商家)",
		Long: `Manage the merchant side of the platform: your own model listings,
channels, earnings and payouts. These endpoints require the provider role; a
regular account answers HTTP 403.`,
	}
	cmd.AddCommand(
		newMerchantSelfCommand(),
		newMerchantModelsCommand(),
		newMerchantModelCreateCommand(),
		newMerchantModelUpdateCommand(),
		newMerchantModelBatchCommand(),
		newMerchantPricePreviewCommand(),
		newMerchantChannelsCommand(),
		newMerchantChannelTestCommand(),
		newMerchantEarningsCommand(),
		newMerchantPayoutsCommand(),
		newMerchantRegisterCommand(),
	)
	return cmd
}

func newMerchantSelfCommand() *cobra.Command {
	var body string
	cmd := &cobra.Command{
		Use:   "self",
		Short: "Show or update the merchant profile",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			if body == "" {
				out, err := cl.ProviderSelf(ctx)
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
			out, err := cl.UpdateProviderSelf(ctx, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("merchant profile updated")
			return nil
		},
	}
	cmd.Flags().StringVar(&body, "body", "", "profile update body as JSON")
	return cmd
}

func newMerchantModelsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "models",
		Short: "List your own model listings",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			page, err := cl.ListProviderModels(ctx, lf.page, lf.pageSize)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(page)
			}
			rows := make([][]string, 0, len(page.Items))
			for _, m := range page.Items {
				rows = append(rows, []string{
					fmt.Sprintf("%v", m["id"]),
					fmt.Sprintf("%v", m["model_name"]),
					fmt.Sprintf("%v", m["status"]),
					fmt.Sprintf("%v", m["input_price"]),
					fmt.Sprintf("%v", m["output_price"]),
					fmt.Sprintf("%v", m["price_currency"]),
				})
			}
			w.Table([]render.Column{
				{Title: "ID"}, {Title: "MODEL"}, {Title: "STATUS"},
				{Title: "IN/M", Align: render.AlignRight}, {Title: "OUT/M", Align: render.AlignRight}, {Title: "CCY"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

func newMerchantModelCreateCommand() *cobra.Command {
	var body string
	cmd := &cobra.Command{
		Use:   "model-create",
		Short: "Create a model listing",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			payload := map[string]any{}
			if err := decodeJSONFlag(body, &payload); err != nil {
				return err
			}
			out, err := cl.CreateProviderModel(ctx, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("model listing created")
			w.Plain("  %v", out)
			return nil
		},
	}
	cmd.Flags().StringVar(&body, "body", "", "listing body as JSON (required)")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

func newMerchantModelUpdateCommand() *cobra.Command {
	var body string
	cmd := &cobra.Command{
		Use:   "model-update <id>",
		Short: "Update a model listing",
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
			payload := map[string]any{}
			if err := decodeJSONFlag(body, &payload); err != nil {
				return err
			}
			out, err := cl.UpdateProviderModel(ctx, id, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("model listing %d updated", id)
			return nil
		},
	}
	cmd.Flags().StringVar(&body, "body", "", "listing body as JSON (required)")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

func newMerchantModelBatchCommand() *cobra.Command {
	var (
		variant string
		body    string
	)
	cmd := &cobra.Command{
		Use:   "model-batch",
		Short: "Create, enable, disable or delete listings in bulk",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			switch variant {
			case "", "batch", "status", "delete":
			default:
				return fmt.Errorf("--variant must be batch, status or delete")
			}
			payload := map[string]any{}
			if err := decodeJSONFlag(body, &payload); err != nil {
				return err
			}
			if !confirm(fmt.Sprintf("run the %s batch operation?", variant)) {
				w.Plain("cancelled")
				return nil
			}
			out, err := cl.ProviderModelBatch(ctx, variant, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("batch operation finished")
			return nil
		},
	}
	cmd.Flags().StringVar(&variant, "variant", "batch", "batch variant: batch, status or delete")
	cmd.Flags().StringVar(&body, "body", "", "batch body as JSON (required)")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

func newMerchantPricePreviewCommand() *cobra.Command {
	var body string
	cmd := &cobra.Command{
		Use:   "price-preview",
		Short: "Calculate a price proposal without saving it",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			payload := map[string]any{}
			if err := decodeJSONFlag(body, &payload); err != nil {
				return err
			}
			out, err := cl.PreviewProviderModelPrice(ctx, payload)
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
	cmd.Flags().StringVar(&body, "body", "", "pricing body as JSON (required)")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

func newMerchantChannelsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "channels",
		Short: "List your upstream channels",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.ListProviderChannels(ctx)
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

func newMerchantChannelTestCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "channel-test <id>",
		Short: "Run a channel health check",
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
			out, err := cl.TestProviderChannel(ctx, id)
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

func newMerchantEarningsCommand() *cobra.Command {
	var (
		lf      listFlags
		tf      timeFlags
		summary bool
	)
	cmd := &cobra.Command{
		Use:   "earnings",
		Short: "Show merchant earnings",
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
			q := api.ProviderEarningsQuery{PageSize: lf.pageSize, StartTime: start, EndTime: end}
			if summary {
				out, err := cl.GetProviderEarningsSummary(ctx, q)
				if err != nil {
					return err
				}
				if w.IsStructured() {
					return w.Structured(out)
				}
				w.Plain("%v", out)
				return nil
			}
			earnings, err := cl.GetProviderEarnings(ctx, q)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(earnings)
			}
			rows := make([][]string, 0, len(earnings.Items))
			for _, e := range earnings.Items {
				rows = append(rows, []string{
					fmt.Sprintf("%v", e["created_at"]),
					fmt.Sprintf("%v", e["model_name"]),
					fmt.Sprintf("%v", e["earning_source"]),
					fmt.Sprintf("%v", e["quota"]),
					fmt.Sprintf("%v", e["caller_id"]),
				})
			}
			w.Table([]render.Column{
				{Title: "CREATED"}, {Title: "MODEL"}, {Title: "SOURCE"},
				{Title: "QUOTA", Align: render.AlignRight}, {Title: "CALLER"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "created")
	tf.add(cmd)
	cmd.Flags().BoolVar(&summary, "summary", false, "show the totals instead of the list")
	return cmd
}

func newMerchantPayoutsCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "payouts",
		Short: "Show merchant payout history",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.GetProviderPayouts(ctx)
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

func newMerchantRegisterCommand() *cobra.Command {
	var body string
	cmd := &cobra.Command{
		Use:   "register",
		Short: "Apply to become a provider",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			payload := map[string]any{}
			if err := decodeJSONFlag(body, &payload); err != nil {
				return err
			}
			if !confirm("submit a provider application?") {
				w.Plain("cancelled")
				return nil
			}
			out, err := cl.RegisterProvider(ctx, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(out)
			}
			w.Success("provider application submitted")
			return nil
		},
	}
	cmd.Flags().StringVar(&body, "body", "", "application body as JSON (required)")
	_ = cmd.MarkFlagRequired("body")
	return cmd
}

// decodeJSONFlag parses a JSON flag value into a map.
func decodeJSONFlag(s string, out *map[string]any) error {
	if s == "" {
		return fmt.Errorf("a JSON body is required")
	}
	if err := json.Unmarshal([]byte(s), out); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}
