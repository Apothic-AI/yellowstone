// Package cmd implements the subrouterctl command tree.
package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/Apothic-AI/subrouterctl/internal/render"
	"github.com/Apothic-AI/subrouterctl/pkg/api"
	"github.com/Apothic-AI/subrouterctl/pkg/cache"
	"github.com/Apothic-AI/subrouterctl/pkg/config"
)

var (
	flagBaseURL      string
	flagToken        string
	flagAPIKey       string
	flagUserID       int
	flagOutput       string
	flagNoColor      bool
	flagTimeout      int
	flagQuotaPerUnit float64
	flagShowSecrets  bool
	flagYes          bool
	flagCacheTTL     time.Duration
	flagCacheDir     string
	flagCacheClear   bool
)

// Version is stamped at build time.
var Version = "1.0.0"

// Execute runs the root command.
func Execute() error {
	err := NewRootCommand().Execute()
	if cacheDB != nil {
		_ = cacheDB.Close()
	}
	return err
}

// NewRootCommand builds the command tree.
func NewRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:   "subrouterctl",
		Short: "Manage a SubRouter account from the command line",
		Long: `subrouterctl is the command line companion for SubRouter, the multi-provider
AI API gateway. It drives the full account management API: API keys of every
kind, the model and provider directories, usage logs, async task records,
provider subscriptions and shared pool plans.

Every command works against the account management API using the system access
token. No browser is needed after the one time device authorization.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       Version,
		PersistentPreRun: func(cmd *cobra.Command, args []string) {
			// --cache-clear is a standalone action: it empties the cache
			// and stops, whatever command was asked for.
			if !flagCacheClear {
				return
			}
			dir := flagCacheDir
			if dir == "" {
				dir = defaultCacheDir()
			}
			db, err := cache.Open(dir)
			if err != nil {
				fmt.Fprintln(os.Stderr, "subrouterctl: the cache could not be opened:", err)
				os.Exit(1)
			}
			if err := cache.New(db, 0).Clear(); err != nil {
				fmt.Fprintln(os.Stderr, "subrouterctl:", err)
				os.Exit(1)
			}
			_ = db.Close()
			fmt.Println("cache cleared")
			os.Exit(0)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	pf := root.PersistentFlags()
	pf.StringVar(&flagBaseURL, "base-url", "", "SubRouter site base URL (env SUBROUTER_BASE_URL)")
	pf.StringVar(&flagToken, "token", "", "system access token (env SUBROUTER_ACCESS_TOKEN)")
	pf.StringVar(&flagAPIKey, "api-key", "", "sk- relay key (env SUBROUTER_API_KEY)")
	pf.IntVar(&flagUserID, "user-id", 0, "numeric account id for the New-Api-User header (env SUBROUTER_USER_ID)")
	pf.StringVarP(&flagOutput, "output", "o", "table", "output format: table, json, yaml")
	pf.BoolVar(&flagNoColor, "no-color", false, "disable coloured output")
	pf.IntVar(&flagTimeout, "timeout", 60, "request timeout in seconds")
	pf.Float64Var(&flagQuotaPerUnit, "quota-per-unit", 0, "quota units per 1 USD (default 500000)")
	pf.BoolVar(&flagShowSecrets, "show-secrets", false, "print secret values in full instead of masking them")
	pf.BoolVarP(&flagYes, "yes", "y", false, "assume yes for confirmation prompts")
	pf.DurationVar(&flagCacheTTL, "cache-ttl", 0, "serve cached responses when they are younger than this (0 always reads live, except for cached log ranges)")
	pf.StringVar(&flagCacheDir, "cache-dir", defaultCacheDir(), "directory for the on-disk cache")
	pf.BoolVar(&flagCacheClear, "cache-clear", false, "remove every cached entry and exit")

	root.AddCommand(
		newAuthCommand(),
		newAccountCommand(),
		newUsageCommand(),
		newTokenCommand(),
		newModelCommand(),
		newProviderCommand(),
		newSharedCommand(),
		newSubscriptionCommand(),
		newTaskCommand(),
		newMerchantCommand(),
		newStationCommand(),
		newBridgeCommand(),
	)
	return root
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// cfg resolves the configuration for this invocation.
func cfg() (*config.Config, error) {
	return config.Resolve(flagBaseURL, flagToken, flagAPIKey, flagUserID, flagQuotaPerUnit, flagTimeout, flagShowSecrets)
}

// defaultCacheDir is where the on-disk cache lives.
func defaultCacheDir() string {
	return config.DefaultCacheDir()
}

// cacheDB is the SQLite cache database for this invocation.
var cacheDB *cache.DB

// cacheErr holds the reason the cache could not be opened.
var cacheErr error

// openCacheDB opens the cache database once per invocation. A database that
// cannot be opened is not fatal: the command simply runs without a cache,
// and the reason is reported.
func openCacheDB() *cache.DB {
	if cacheDB != nil {
		return cacheDB
	}
	dir := flagCacheDir
	if dir == "" {
		dir = defaultCacheDir()
	}
	db, err := cache.Open(dir)
	if err != nil {
		cacheErr = err
		return nil
	}
	cacheDB = db
	return db
}

// warnAboutTheCache tells the user that the cache is not in use.
func warnAboutTheCache() {
	if cacheErr == nil {
		return
	}
	writer().Warn("the cache is not in use: %v", cacheErr)
	cacheErr = nil
}

// newCacheStore builds the on-disk cache store for this invocation.
func newCacheStore() *cache.Store {
	return cache.New(openCacheDB(), flagCacheTTL)
}

// client builds an API client and verifies the management credential pair.
func client() (*api.Client, *config.Config, error) {
	c, err := cfg()
	if err != nil {
		return nil, nil, err
	}
	if err := c.RequireManagementAuth(); err != nil {
		return nil, nil, err
	}
	cl := api.New(c.BaseURL, c.AccessToken, c.UserID, c.APIKey, time.Duration(c.Timeout)*time.Second)
	cl.Cache = newCacheStore()
	cl.LogRanges = cache.NewRangeStore(openCacheDB())
	cl.CacheNotice = func(msg string) {
		writer().Warn("%s", msg)
	}
	warnAboutTheCache()
	return cl, c, nil
}

// relayClient builds an API client for the sk- relay surface.
func relayClient() (*api.Client, *config.Config, error) {
	c, err := cfg()
	if err != nil {
		return nil, nil, err
	}
	if err := c.RequireRelayAuth(); err != nil {
		return nil, nil, err
	}
	cl := api.New(c.BaseURL, c.AccessToken, c.UserID, c.APIKey, time.Duration(c.Timeout)*time.Second)
	cl.Cache = newCacheStore()
	cl.CacheNotice = func(msg string) {
		writer().Warn("%s", msg)
	}
	warnAboutTheCache()
	return cl, c, nil
}

// writer builds the output writer.
func writer() *render.Writer {
	opts := render.DefaultOptions()
	switch strings.ToLower(flagOutput) {
	case "json":
		opts.Format = render.FormatJSON
	case "yaml", "yml":
		opts.Format = render.FormatYAML
	default:
		opts.Format = render.FormatTable
	}
	if flagNoColor {
		opts.Color = false
	}
	if flagQuotaPerUnit > 0 {
		opts.QuotaPerUnit = flagQuotaPerUnit
	} else {
		opts.QuotaPerUnit = config.ResolveQuotaPerUnit(0)
	}
	return render.New(opts)
}

// ctx returns the context for a command.
//
// The timeout flag bounds a single request, not the whole command, so that
// a command which walks many pages (a wide log range, the model directory)
// is not cut off half way through.
func ctx() (context.Context, context.CancelFunc) {
	return context.WithCancel(context.Background())
}

// stdin is the reader used by the confirmation prompts. It is kept so that
// a second prompt does not lose the input the first one buffered.
var stdin = bufio.NewReader(os.Stdin)

// confirm asks the operator to approve a destructive action.
//
// The prompt goes to the error stream, so that it never lands inside a JSON
// or YAML payload.
func confirm(prompt string) bool {
	if flagYes {
		return true
	}
	fmt.Fprintf(os.Stderr, "%s [y/N]: ", prompt)
	line, err := stdin.ReadString('\n')
	if err != nil {
		return false
	}
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "y" || line == "yes"
}

// listFlags are the search, sort and filter flags shared by list commands.
type listFlags struct {
	search   string
	sort     string
	order    string
	limit    int
	page     int
	pageSize int
}

// add registers the shared list flags on a command.
func (l *listFlags) add(cmd *cobra.Command, defaultSort string) {
	f := cmd.Flags()
	f.StringVarP(&l.search, "search", "q", "", "free text search")
	f.StringVar(&l.sort, "sort", "", "sort field ("+defaultSort+")")
	f.StringVar(&l.order, "order", "asc", "sort order: asc or desc")
	f.IntVar(&l.limit, "limit", 50, "maximum rows to print (0 for no limit)")
	f.IntVar(&l.page, "page", 1, "page number")
	f.IntVar(&l.pageSize, "page-size", 50, "rows per page")
}

// desc reports whether the sort order is descending.
func (l *listFlags) desc() bool {
	return strings.EqualFold(l.order, "desc") || strings.EqualFold(l.order, "descending")
}

// applyLimit trims a slice to the requested limit.
func (l *listFlags) applyLimit[T any](items []T) []T {
	if l.limit > 0 && len(items) > l.limit {
		return items[:l.limit]
	}
	return items
}

// applyPage trims a slice to the requested page and limit. It is used when
// the whole result set is already in memory, where the server cannot do the
// paging.
func (l *listFlags) applyPage[T any](items []T) []T {
	if l.limit <= 0 {
		return items
	}
	if l.page > 1 {
		start := (l.page - 1) * l.limit
		if start >= len(items) {
			return nil
		}
		items = items[start:]
	}
	return l.applyLimit(items)
}

// parseTimeFlag parses a date, timestamp or relative age into unix seconds.
//
// Accepted forms: 2026-01-31, 2026-01-31T15:04:05Z, 1738281600, 24h, 7d.
func parseTimeFlag(s string, endOfDay bool) (int64, error) {
	return api.ParseTime(s, endOfDay)
}

// timeFlags are the shared date range flags.
type timeFlags struct {
	from string
	to   string
}

// add registers the date range flags on a command.
func (t *timeFlags) add(cmd *cobra.Command) {
	cmd.Flags().StringVar(&t.from, "from", "", "start of the range: 2026-01-31, 24h or a unix timestamp")
	cmd.Flags().StringVar(&t.to, "to", "", "end of the range: 2026-01-31, 1h or a unix timestamp")
}

// range renders the flag values as unix seconds.
func (t *timeFlags) range_() (int64, int64, error) {
	start, err := parseTimeFlag(t.from, false)
	if err != nil {
		return 0, 0, err
	}
	end, err := parseTimeFlag(t.to, true)
	if err != nil {
		return 0, 0, err
	}
	return start, end, nil
}

// splitList splits a comma separated flag value.
func splitList(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// concurrentPages fetches pages in parallel with a bounded worker pool.
func concurrentPages[T any](ctx context.Context, pages, workers int, fetch func(context.Context, int) ([]T, int, error)) ([]T, error) {
	return api.ConcurrentPages(ctx, pages, workers, fetch)
}

// startOfToday is the midnight the platform uses when no start time is
// given for a log query.
func startOfToday() int64 {
	return api.StartOfToday()
}

// apiLogQuery builds a log query from the shared date and list flags.
func apiLogQuery(start, end int64, lf listFlags) api.LogQuery {
	return api.LogQuery{
		PageSize:       lf.pageSize,
		StartTimestamp: start,
		EndTimestamp:   end,
	}
}

// parseModelRoutes parses repeated model=provider1,provider2 flags.
func parseModelRoutes(entries []string) (map[string][]string, error) {
	if len(entries) == 0 {
		return nil, nil
	}
	out := map[string][]string{}
	for _, e := range entries {
		parts := strings.SplitN(e, "=", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("expected model=provider1,provider2, got %q", e)
		}
		model := strings.TrimSpace(parts[0])
		providers := splitList(parts[1])
		if model == "" || len(providers) == 0 {
			return nil, fmt.Errorf("expected model=provider1,provider2, got %q", e)
		}
		out[model] = providers
	}
	return out, nil
}
