package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func newAccountCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "account",
		Short: "Inspect and edit the account",
	}
	cmd.AddCommand(
		newAccountInfoCommand(),
		newAccountUpdateCommand(),
		newAccountGroupsCommand(),
		newAccountModelsCommand(),
		newAccountSubrouterModelsCommand(),
		newAccountTopupInfoCommand(),
		newAccountTopupsCommand(),
		newAccountRedeemCommand(),
		newAccountBalanceCommand(),
		newAccountNotificationsCommand(),
		newAccountAffCommand(),
		newSiteStatusCommand(),
	)
	return cmd
}

func newAccountInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info",
		Short: "Show the account profile and wallet balance",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			user, err := cl.GetUser(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(user)
			}
			w.Detail("Account "+user.Username, []render.Field{{Label: "Id", Value: strconv.Itoa(user.ID)},
				{Label: "Username", Value: user.Username},
				{Label: "Display name", Value: orDash(user.DisplayName)},
				{Label: "Email", Value: orDash(user.Email)},
				{Label: "Role", Value: roleName(user.Role)},
				{Label: "Group", Value: orDash(user.Group)},
				{Label: "Balance", Value: w.Money(user.Quota)},
				{Label: "Used", Value: w.Money(user.UsedQuota)},
				{Label: "Requests", Value: strconv.FormatInt(int64(user.RequestCount), 10)},
				{Label: "Referral code", Value: orDash(user.AffCode)},
				{Label: "Referral quota", Value: w.Money(user.AffQuota)},
				{Label: "Created", Value: w.Time(user.CreatedTime)},
			})
			return nil
		},
	}
}

func newAccountUpdateCommand() *cobra.Command {
	var (
		username    string
		displayName string
		email       string
		group       string
	)
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update the account profile",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			body := map[string]any{}
			if cmd.Flags().Changed("username") {
				body["username"] = username
			}
			if cmd.Flags().Changed("display-name") {
				body["display_name"] = displayName
			}
			if cmd.Flags().Changed("email") {
				body["email"] = email
			}
			if cmd.Flags().Changed("group") {
				body["group"] = group
			}
			if len(body) == 0 {
				return fmt.Errorf("nothing to update: pass at least one of --username, --display-name, --email or --group")
			}
			ctx, cancel := ctx()
			defer cancel()

			user, err := cl.UpdateUser(ctx, body)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(user)
			}
			w.Success("account updated")
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&username, "username", "", "new username")
	f.StringVar(&displayName, "display-name", "", "new display name")
	f.StringVar(&email, "email", "", "new email address")
	f.StringVar(&group, "group", "", "new default routing group")
	return cmd
}

func newAccountGroupsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "groups",
		Short: "List the routing groups available to the account",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			groups, err := cl.GetUserGroups(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(groups)
			}
			keys := render.SortedKeys(groups)
			rows := make([][]string, 0, len(keys))
			for _, k := range keys {
				g := groups[k]
				rows = append(rows, []string{
					k,
					orDash(g.Desc),
					orDash(g.Source),
					fmt.Sprintf("%.2f", g.Ratio),
				})
			}
			w.Table([]render.Column{
				{Title: "GROUP"}, {Title: "DESCRIPTION"}, {Title: "SOURCE"}, {Title: "RATIO", Align: render.AlignRight},
			}, rows)
			return nil
		},
	}
	_ = lf
	return cmd
}

func newAccountModelsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "models",
		Short: "List the model names the account can call",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			models, err := cl.GetUserModels(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(models)
			}
			q := strings.ToLower(lf.search)
			rows := [][]string{}
			for _, m := range models {
				if q != "" && !strings.Contains(strings.ToLower(m), q) {
					continue
				}
				rows = append(rows, []string{m})
			}
			w.Table([]render.Column{{Title: "MODEL"}}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

func newAccountSubrouterModelsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "subrouter-models",
		Short: "List the smart-routing models with their cheapest provider offer",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, c, err := client()
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
			if lf.sort != "" {
				api.SortSubrouterModels(models, lf.sort, lf.desc())
			}
			if w.IsStructured() {
				return w.Structured(models)
			}
			rows := make([][]string, 0, len(models))
			for _, m := range models {
				rows = append(rows, []string{
					m.ModelName,
					orDash(m.Category),
					strconv.Itoa(m.ProviderCount),
					fmt.Sprintf("%.4f", m.MinInputPrice),
					fmt.Sprintf("%.4f", m.MinOutputPr),
					orDash(m.PriceCurrency),
				})
			}
			w.Table([]render.Column{
				{Title: "MODEL"}, {Title: "CATEGORY"}, {Title: "PROVIDERS", Align: render.AlignRight},
				{Title: "IN/M", Align: render.AlignRight}, {Title: "OUT/M", Align: render.AlignRight},
				{Title: "CCY"},
			}, lf.applyLimit(rows))
			_ = c
			return nil
		},
	}
	lf.add(cmd, "model")
	return cmd
}

func newAccountTopupInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "topup-info",
		Short: "Show the available top-up methods and amounts",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			info, err := cl.GetTopupInfo(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(info)
			}
			amounts := make([]string, 0, len(info.AmountOptions))
			for _, a := range info.AmountOptions {
				amounts = append(amounts, fmt.Sprintf("%.2f", a))
			}
			w.Detail("Top-up", []render.Field{
				{Label: "Amount options", Value: strings.Join(amounts, ", ")},
				{Label: "Discount", Value: fmt.Sprintf("%v", info.Discount)},
			})
			return nil
		},
	}
}

func newAccountTopupsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "topups",
		Short: "Show the top-up history",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			records, err := cl.GetTopups(ctx, lf.page, lf.pageSize)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(records)
			}
			rows := make([][]string, 0, len(records))
			for _, r := range records {
				rows = append(rows, []string{
					strconv.FormatInt(r.CreateTime, 10),
					fmt.Sprintf("%.2f", r.Amount),
					orDash(r.Status),
					orDash(r.TradeNo),
				})
			}
			w.Table([]render.Column{
				{Title: "CREATED"}, {Title: "AMOUNT", Align: render.AlignRight}, {Title: "STATUS"}, {Title: "TRADE"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "created")
	return cmd
}

func newAccountRedeemCommand() *cobra.Command {
	var code string
	cmd := &cobra.Command{
		Use:   "redeem",
		Short: "Redeem a voucher code",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			msg, err := cl.RedeemVoucher(ctx, code)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(map[string]string{"result": msg})
			}
			w.Success("%s", msg)
			return nil
		},
	}
	cmd.Flags().StringVar(&code, "code", "", "voucher redemption code")
	_ = cmd.MarkFlagRequired("code")
	return cmd
}

func newAccountBalanceCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "balance",
		Short: "Show the wallet balance from the relay billing API",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, c, err := relayClient()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			sub, err := cl.GetBillingSubscription(ctx)
			if err != nil {
				return err
			}
			usage, err := cl.GetBillingUsage(ctx)
			if err != nil {
				usage = nil
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{"subscription": sub, "usage": usage})
			}
			fields := []render.Field{
				{Label: "Balance", Value: moneyOf(sub, "hard_limit_usd")},
				{Label: "Soft limit", Value: moneyOf(sub, "soft_limit_usd")},
				{Label: "Payment method", Value: boolText(sub, "has_payment_method")},
			}
			if usage != nil {
				fields = append(fields,
					render.Field{Label: "Usage", Value: moneyOf(usage, "total_usage")},
					render.Field{Label: "Object", Value: stringOf(usage, "object")})
			}
			w.Detail("Billing", fields)
			_ = c
			return nil
		},
	}
}

// moneyOf reads a dollar amount out of a decoded API payload.
func moneyOf(payload any, field string) string {
	m, ok := payload.(map[string]any)
	if !ok {
		return "-"
	}
	v, ok := m[field].(float64)
	if !ok {
		return "-"
	}
	return fmt.Sprintf("$%.2f", v)
}

// boolText reads a boolean out of a decoded API payload.
func boolText(payload any, field string) string {
	m, ok := payload.(map[string]any)
	if !ok {
		return "-"
	}
	v, ok := m[field].(bool)
	if !ok {
		return "-"
	}
	return boolLabel(v)
}

// stringOf reads a string out of a decoded API payload.
func stringOf(payload any, field string) string {
	m, ok := payload.(map[string]any)
	if !ok {
		return "-"
	}
	v, ok := m[field].(string)
	if !ok || v == "" {
		return "-"
	}
	return v
}

func newAccountNotificationsCommand() *cobra.Command {
	var lf listFlags
	cmd := &cobra.Command{
		Use:   "notifications",
		Short: "Show the account notification feed",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			out, err := cl.GetNotifications(ctx, lf.page, lf.pageSize)
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
	return cmd
}

func newAccountAffCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "aff",
		Short: "Show the referral code and earnings",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			summary, err := cl.GetAffSummary(ctx)
			if err != nil {
				return err
			}
			earnings, err := cl.GetAffEarnings(ctx)
			if err != nil {
				earnings = nil
			}
			invites, quota, commission, err := cl.GetAffEarningTotals(ctx)
			if err != nil {
				invites, quota, commission = 0, 0, 0
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{
					"summary":  summary,
					"earnings": earnings,
					"totals":   map[string]any{"invites": invites, "quota": quota, "commission": commission},
				})
			}
			w.Detail("Referral", []render.Field{{Label: "Code", Value: orDash(summary.AffCode)},
				{Label: "Invites", Value: strconv.Itoa(invites)},
				{Label: "Quota", Value: w.Money(quota)},
				{Label: "Commission", Value: w.Money(commission)},
				{Label: "Invite link", Value: orDash(summary.AffCode)},
			})
			return nil
		},
	}
	return cmd
}

func newSiteStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the public site configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			status, err := cl.GetStatus(ctx)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(status)
			}
			w.Detail("Site", []render.Field{{Label: "Name", Value: orDash(status.SystemName)},
				{Label: "Server", Value: orDash(status.ServerAddress)},
				{Label: "Version", Value: orDash(status.Version)},
				{Label: "Quota per unit", Value: fmt.Sprintf("%g", status.QuotaPerUnit)}, {Label: "USD rate", Value: fmt.Sprintf("%g", status.UsdExchangeRate)}, {Label: "Async tasks", Value: fmt.Sprintf("%v", status.EnableTask)},
			})
			return nil
		},
	}
}

func roleName(role int) string {
	switch role {
	case 1:
		return "user"
	case 2:
		return "provider"
	case 3:
		return "distributor"
	case 10:
		return "admin"
	case 100:
		return "root"
	default:
		return fmt.Sprintf("role %d", role)
	}
}
