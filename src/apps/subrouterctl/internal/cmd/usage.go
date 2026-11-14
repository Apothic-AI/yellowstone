package cmd

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
)

func newUsageCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "usage",
		Aliases: []string{"logs"},
		Short:   "Inspect usage, quota and request logs",
	}
	cmd.AddCommand(
		newUsageLogsCommand(),
		newUsageLogShowCommand(),
		newUsageStatsCommand(),
		newUsageDataCommand(),
		newUsageExportCommand(),
	)
	return cmd
}

func newUsageLogsCommand() *cobra.Command {
	var (
		lf        listFlags
		tf        timeFlags
		tokenName string
		modelName string
		group     string
		requestID string
		logType   int
	)
	cmd := &cobra.Command{
		Use:   "logs",
		Short: "List request logs",
		Long: `List request logs. Filters are sent to the server; --search and --sort are
applied locally, which makes --sort fetch every matching page first.

The time range is cached. A range that was fetched before is served from
disk, and only the parts of it that are missing are fetched from the
platform, so a window that reaches into the present still shows new calls.

The TPS column is the generation throughput the SubRouter console shows in
the "Time/first word" column: the completion tokens divided by the request
duration. It is only meaningful for streaming responses.

The server accepts a window of at most 31 days per request.`,
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
			// The range cache needs explicit bounds, so fall back to the
			// platform defaults of today when the operator gave none.
			if start == 0 {
				start = startOfToday()
			}
			if end == 0 {
				end = time.Now().Unix()
			}
			q := api.LogQuery{
				PageSize:       logPageSize(cmd, lf),
				Type:           logType,
				TokenName:      tokenName,
				ModelName:      modelName,
				Group:          group,
				RequestID:      requestID,
				StartTimestamp: start,
				EndTimestamp:   end,
			}

			var items []api.LogEntry
			ranged := cl.LogRanges != nil && cl.LogRanges.Enabled()
			if ranged {
				items, err = cl.GetLogRange(ctx, q)
				if err != nil {
					if len(items) == 0 {
						return err
					}
					// The cached part of the range is still served.
					w.Warn("the requested range is incomplete: %v", err)
				}
			} else {
				items, err = fetchLogPages(ctx, cl, q, lf)
				if err != nil {
					return err
				}
			}
			items = api.FilterLogs(items, lf.search)
			api.SortLogs(items, lf.sort, lf.desc())
			if ranged {
				// The whole range is in memory, so the page is picked here.
				items = lf.applyPage(items)
			}
			if w.IsStructured() {
				return w.Structured(items)
			}
			rows := make([][]string, 0, len(items))
			for _, l := range items {
				rows = append(rows, []string{
					w.Time(l.CreatedAt),
					orDash(l.TokenName),
					orDash(l.ModelName),
					orDash(l.Group),
					w.Money(l.Quota),
					strconv.Itoa(l.PromptTokens + l.CompletionTokens),
					fmt.Sprintf("%.1f", l.UseTime),
					formatTTFT(l),
					formatTPS(l),
					orDash(l.RequestID),
				})
			}
			w.Table([]render.Column{
				{Title: "TIME"}, {Title: "KEY"}, {Title: "MODEL"}, {Title: "GROUP"},
				{Title: "COST", Align: render.AlignRight}, {Title: "TOKENS", Align: render.AlignRight},
				{Title: "TIME(s)", Align: render.AlignRight}, {Title: "TTFT(s)", Align: render.AlignRight},
				{Title: "TPS", Align: render.AlignRight}, {Title: "REQUEST"},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "time")
	tf.add(cmd)
	f := cmd.Flags()
	f.StringVar(&tokenName, "key-name", "", "filter by API key name")
	f.StringVar(&modelName, "model", "", "filter by model name")
	f.StringVar(&group, "group", "", "filter by routing group")
	f.StringVar(&requestID, "request", "", "filter by request id")
	f.IntVar(&logType, "type", 0, "filter by log type (0 = all)")
	return cmd
}

// logPageSize is the page size used to walk the logs. The platform serves at
// most 100 rows per request, and a wide range is fetched in many requests,
// so the largest page is used unless the operator asked for another one.
func logPageSize(cmd *cobra.Command, lf listFlags) int {
	if cmd.Flags().Changed("page-size") {
		return lf.pageSize
	}
	return api.MaxLogPageSize
}

// fetchLogPages walks the cursor paging of the log endpoint.
func fetchLogPages(ctx context.Context, cl *api.Client, q api.LogQuery, lf listFlags) ([]api.LogEntry, error) {
	var all []api.LogEntry
	cursor := "first"
	page := 1
	for {
		q.Cursor = cursor
		pageRes, err := cl.GetLogs(ctx, q)
		if err != nil {
			return nil, err
		}
		all = append(all, pageRes.Items...)
		if page >= lf.page && lf.page > 0 {
			break
		}
		if !pageRes.HasMore || pageRes.NextCursor == "" {
			break
		}
		cursor = pageRes.NextCursor
		page++
		if lf.sort == "" && lf.limit > 0 && len(all) >= lf.limit {
			break
		}
	}
	return all, nil
}

func newUsageStatsCommand() *cobra.Command {
	var (
		tf        timeFlags
		tokenName string
		modelName string
		group     string
		logType   int
	)
	cmd := &cobra.Command{
		Use:   "stats",
		Short: "Summarize usage",
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
			q := api.LogQuery{
				Type:           logType,
				TokenName:      tokenName,
				ModelName:      modelName,
				Group:          group,
				StartTimestamp: start,
				EndTimestamp:   end,
			}
			stat, err := cl.GetLogStat(ctx, q)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(stat)
			}
			w.Detail("Usage", []render.Field{{Label: "Spend", Value: w.Money(stat.Quota)},
				{Label: "Tokens", Value: strconv.FormatInt(int64(stat.Token), 10)},
				{Label: "Requests per minute", Value: strconv.Itoa(stat.RPM)},
				{Label: "Tokens per minute", Value: strconv.Itoa(stat.TPM)},
			})
			return nil
		},
	}
	tf.add(cmd)
	f := cmd.Flags()
	f.StringVar(&tokenName, "key-name", "", "filter by API key name")
	f.StringVar(&modelName, "model", "", "filter by model name")
	f.StringVar(&group, "group", "", "filter by routing group")
	f.IntVar(&logType, "type", 0, "filter by log type (0 = all)")
	return cmd
}

func newUsageDataCommand() *cobra.Command {
	var (
		lf listFlags
		tf timeFlags
	)
	cmd := &cobra.Command{
		Use:   "data",
		Short: "Show per-day quota usage",
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
			points, err := cl.GetData(ctx, start, end)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(points)
			}
			rows := make([][]string, 0, len(points))
			for _, p := range points {
				rows = append(rows, []string{
					w.Time(p.CreatedAt),
					orDash(p.ModelName),
					w.Money(p.Quota),
					strconv.Itoa(p.Count),
					strconv.FormatInt(p.TokenUsed, 10),
				})
			}
			w.Table([]render.Column{
				{Title: "DAY"}, {Title: "MODEL"}, {Title: "COST", Align: render.AlignRight},
				{Title: "REQUESTS", Align: render.AlignRight}, {Title: "TOKENS", Align: render.AlignRight},
			}, lf.applyLimit(rows))
			return nil
		},
	}
	lf.add(cmd, "day")
	tf.add(cmd)
	return cmd
}

func newUsageExportCommand() *cobra.Command {
	var (
		tf        timeFlags
		tokenName string
		modelName string
		group     string
		logType   int
	)
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Print the CSV export URL for the current filters",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			start, end, err := tf.range_()
			if err != nil {
				return err
			}
			q := api.LogQuery{
				Type:           logType,
				TokenName:      tokenName,
				ModelName:      modelName,
				Group:          group,
				StartTimestamp: start,
				EndTimestamp:   end,
			}
			w.Plain("%s", cl.ExportLogsURL(q))
			return nil
		},
	}
	tf.add(cmd)
	f := cmd.Flags()
	f.StringVar(&tokenName, "key-name", "", "filter by API key name")
	f.StringVar(&modelName, "model", "", "filter by model name")
	f.StringVar(&group, "group", "", "filter by routing group")
	f.IntVar(&logType, "type", 0, "filter by log type (0 = all)")
	return cmd
}

// formatTTFT renders the time to first token in seconds.
func formatTTFT(l api.LogEntry) string {
	if ms := l.FirstResponseTimeMs(); ms > 0 {
		return fmt.Sprintf("%.1f", float64(ms)/1000)
	}
	return "-"
}

// formatTPS renders the generation throughput the way the SubRouter console
// does: completion tokens over the total request duration, shown only for
// streaming responses.
func formatTPS(l api.LogEntry) string {
	if !l.ShowsTPS() {
		return "-"
	}
	return fmt.Sprintf("%.1f", l.OutputTPS())
}

func newUsageLogShowCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "log <request-id>",
		Short: "Show one log entry with every field the platform returned",
		Long: `Show one usage log entry by its request id.

The table view is a summary. This command prints every field the platform
returned, including the full performance payload that the API sends in the
"other" field.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			q := api.LogQuery{RequestID: args[0], PageSize: 5}
			page, err := cl.GetLogs(ctx, q)
			if err != nil {
				return err
			}
			if len(page.Items) == 0 {
				return fmt.Errorf("no log entry with request id %q", args[0])
			}
			l := page.Items[0]
			if w.IsStructured() {
				return w.Structured(l)
			}

			w.Detail("Log "+l.RequestID, []render.Field{
				{Label: "Id", Value: strconv.Itoa(l.ID)},
				{Label: "Created", Value: w.Time(l.CreatedAt)},
				{Label: "Type", Value: fmt.Sprintf("%d", l.Type)},
				{Label: "User", Value: orDash(l.Username)},
				{Label: "User id", Value: strconv.Itoa(l.UserID)},
				{Label: "Key", Value: orDash(l.TokenName)},
				{Label: "Key id", Value: strconv.Itoa(l.TokenID)},
				{Label: "Model", Value: orDash(l.ModelName)},
				{Label: "Group", Value: orDash(l.Group)},
				{Label: "Channel", Value: orDash(l.ChannelName)},
				{Label: "Node", Value: orDash(l.NodeName)},
				{Label: "IP", Value: orDash(l.IP)},
				{Label: "Prompt tokens", Value: strconv.Itoa(l.PromptTokens)},
				{Label: "Completion tokens", Value: strconv.Itoa(l.CompletionTokens)},
				{Label: "Duration", Value: fmt.Sprintf("%.1fs", l.UseTime)},
				{Label: "Time to first token", Value: formatTTFT(l) + "s"},
				{Label: "Throughput", Value: formatTPS(l) + " t/s"},
				{Label: "Streaming", Value: boolLabel(l.IsStream)},
				{Label: "Cost", Value: w.Money(l.Quota)},
				{Label: "Request id", Value: orDash(l.RequestID)},
				{Label: "Upstream request id", Value: orDash(l.UpstreamRequestID)},
				{Label: "Content", Value: orDash(l.Content)},
			})

			if len(l.Other) == 0 {
				return nil
			}
			w.Plain("")
			w.Plain("  performance payload")
			keys := render.SortedKeys(l.Other)
			rows := make([][]string, 0, len(keys))
			for _, k := range keys {
				rows = append(rows, []string{k, fmt.Sprintf("%v", l.Other[k])})
			}
			w.Table([]render.Column{{Title: "FIELD"}, {Title: "VALUE"}}, rows)
			return nil
		},
	}
}
