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

func newTokenCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "token",
		Aliases: []string{"key"},
		Short:   "Create and manage model API keys",
		Long: `Manage model API keys. SubRouter exposes four kinds of key and each one is
a different routing policy:

  smart      the router picks the cheapest healthy provider and fails over
  official   only platform official channels are used
  shared     only subscribed shared account pools are used
  fixed      one provider is pinned, with no cross-provider failover

Use "subrouterctl token types" for the full description of each kind.`,
	}
	cmd.AddCommand(
		newTokenListCommand(),
		newTokenShowCommand(),
		newTokenCreateCommand(),
		newTokenUpdateCommand(),
		newTokenDeleteCommand(),
		newTokenDeleteBatchCommand(),
		newTokenTypesCommand(),
	)
	return cmd
}

// tokenFlags collects everything that shapes a key.
type tokenFlags struct {
	kind        string
	name        string
	provider    string
	providers   string
	models      string
	modelRoutes []string

	routePreference string
	sortMode        string
	loadBalance     bool
	includeCacheHit bool

	includeProvider bool
	includeOfficial bool
	includeShared   bool

	officialMaxDisc float64
	sharedMaxDisc   float64
	officialChannel int

	unlimited  bool
	quotaUSD   float64
	quotaUnit  float64
	expire     string
	allowIPs   string
	crossRetry bool
	group      string
	keyGroup   int
}

// add registers the key shaping flags.
func (t *tokenFlags) add(cmd *cobra.Command, withKind bool) {
	f := cmd.Flags()
	if withKind {
		f.StringVar(&t.kind, "type", "", "key kind: smart, official, shared or fixed")
	}
	f.StringVar(&t.name, "name", "", "key name")
	f.StringVar(&t.provider, "provider", "", "provider slug to pin (required for --type fixed)")
	f.StringVar(&t.providers, "providers", "", "comma separated provider slugs the smart router may use")
	f.StringVar(&t.models, "models", "", "comma separated model whitelist (empty means every model)")
	f.StringArrayVar(&t.modelRoutes, "model-route", nil, "pin a model to providers: model=provider1,provider2 (repeatable)")
	f.StringVar(&t.routePreference, "route-preference", api.DefaultRoutePreference,
		"ordered routing criteria: "+strings.Join(api.RoutePreferences, ","))
	f.StringVar(&t.sortMode, "sort-mode", api.SortModes[0], "routing sort mode: "+strings.Join(api.SortModes, ","))
	f.BoolVar(&t.loadBalance, "load-balance", false, "enable load balancing across candidates")
	f.BoolVar(&t.includeCacheHit, "include-cache-hit", true, "weigh cache hit rate when ordering candidates")
	f.BoolVar(&t.includeProvider, "include-provider-self", false, "allow routes through provider operated channels")
	f.BoolVar(&t.includeOfficial, "include-official-channels", false, "allow routes through platform official channels")
	f.BoolVar(&t.includeShared, "include-shared-subscriptions", false, "allow routes through subscribed shared pools")
	f.Float64Var(&t.officialMaxDisc, "official-max-discount", 0, "maximum discount factor of an official channel (0 = no limit)")
	f.Float64Var(&t.sharedMaxDisc, "shared-max-discount", 0, "maximum discount factor of a shared plan (0 = no limit)")
	f.IntVar(&t.officialChannel, "official-channel", 0, "pin the key to one official channel id")
	f.BoolVar(&t.unlimited, "unlimited", false, "give the key unlimited quota")
	f.Float64Var(&t.quotaUSD, "quota-usd", 0, "quota limit in USD (converted to platform quota units)")
	f.Float64Var(&t.quotaUnit, "quota-units", 0, "quota limit in raw platform quota units")
	f.StringVar(&t.expire, "expire", "never", "expiry: never, 30d, 12h or a unix timestamp")
	f.StringVar(&t.allowIPs, "allow-ips", "", "IP or CIDR allowlist, one per line")
	f.BoolVar(&t.crossRetry, "cross-group-retry", false, "retry the next group when the current one fails")
	f.StringVar(&t.group, "group", "", "override the routing group")
	f.IntVar(&t.keyGroup, "key-group", 0, "attach the key to a key group id")
}

// spec converts the flags into an API token specification.
func (t *tokenFlags) spec(cmd *cobra.Command, perUnit float64) (*api.TokenSpec, error) {
	kind := api.TokenKind(t.kind)
	switch kind {
	case api.KindSmart, api.KindOfficial, api.KindShared, api.KindFixed:
	case "":
		return nil, fmt.Errorf("--type is required: smart, official, shared or fixed")
	default:
		return nil, fmt.Errorf("unknown --type %q: smart, official, shared or fixed", t.kind)
	}
	if kind == api.KindFixed && t.provider == "" {
		return nil, fmt.Errorf("--type fixed needs --provider <slug>")
	}

	spec := api.NewTokenSpec(kind)
	spec.Name = t.name
	spec.Provider = t.provider
	spec.Providers = splitList(t.providers)
	spec.Models = splitList(t.models)
	spec.RoutePreference = t.routePreference
	spec.SortMode = t.sortMode
	spec.OfficialMaxDisc = t.officialMaxDisc
	spec.SharedMaxDisc = t.sharedMaxDisc
	spec.OfficialChannel = t.officialChannel
	spec.AllowIPs = t.allowIPs
	spec.CrossGroupOnly = t.crossRetry
	spec.Group = t.group
	spec.KeyGroupID = t.keyGroup

	routes, err := parseModelRoutes(t.modelRoutes)
	if err != nil {
		return nil, err
	}
	spec.ModelRoutes = routes

	// A flag the operator set explicitly wins over the kind default.
	overrides := map[string]*bool{
		"include-provider-self":        &spec.IncludeProvider,
		"include-official-channels":    &spec.IncludeOfficial,
		"include-shared-subscriptions": &spec.IncludeShared,
		"load-balance":                 &spec.LoadBalance,
		"include-cache-hit":            &spec.IncludeCacheHit,
	}
	for flag, target := range overrides {
		if cmd.Flags().Changed(flag) {
			*target = cmd.Flags().Lookup(flag).Value.String() == "true"
		}
	}

	if !cmd.Flags().Changed("unlimited") {
		spec.Unlimited = true
	}
	switch {
	case t.quotaUnit > 0:
		spec.Quota = t.quotaUnit
		spec.Unlimited = false
	case t.quotaUSD > 0:
		spec.Quota = t.quotaUSD * perUnit
		spec.Unlimited = false
	}

	spec.Expires, err = resolveExpiry(t.expire)
	if err != nil {
		return nil, err
	}

	if !validRoutePreference(spec.RoutePreference) {
		return nil, fmt.Errorf("invalid --route-preference %q: choose from %s",
			spec.RoutePreference, strings.Join(api.RoutePreferences, ","))
	}
	if !validSortMode(spec.SortMode) {
		return nil, fmt.Errorf("invalid --sort-mode %q: choose from %s", spec.SortMode, strings.Join(api.SortModes, ","))
	}
	return spec, nil
}

func validRoutePreference(v string) bool {
	for _, p := range strings.Split(v, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		found := false
		for _, known := range api.RoutePreferences {
			if p == known {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func validSortMode(v string) bool {
	for _, known := range api.SortModes {
		if v == known {
			return true
		}
	}
	return false
}

// resolveExpiry turns the --expire flag into a unix timestamp.
func resolveExpiry(v string) (int64, error) {
	return api.ResolveExpiry(v)
}

func newTokenListCommand() *cobra.Command {
	var (
		lf   listFlags
		kind string
	)
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List model API keys",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			tokens, err := fetchTokens(ctx, cl, lf, kind)
			if err != nil {
				return err
			}
			tokens = api.FilterTokens(tokens, lf.search)
			api.SortTokens(tokens, lf.sort, lf.desc())
			if w.IsStructured() {
				return w.Structured(tokens)
			}
			rows := make([][]string, 0, len(tokens))
			for _, t := range tokens {
				kindLabel := w.KindColor(string(t.Kind()))
				key := render.MaskKey(t.FullKey())
				if flagShowSecrets {
					key = t.FullKey()
				}
				rows = append(rows, []string{
					strconv.Itoa(t.ID),
					t.Name,
					kindLabel,
					t.ProviderSlug(),
					strings.Join(t.Providers(), ","),
					orDash(strconv.FormatInt(t.ExpiredTime, 10)),
					key,
					w.StatusColor(api.StatusLabel(t.Status)),
				})
			}
			w.Table([]render.Column{
				{Title: "ID", Align: render.AlignRight}, {Title: "NAME"}, {Title: "KIND"},
				{Title: "PROVIDER"}, {Title: "PROVIDERS"}, {Title: "EXPIRES"}, {Title: "KEY"}, {Title: "STATUS"},
			}, lf.applyLimit(rows))
			for _, t := range tokens {
				if render.IsRedacted(t.Key) {
					w.Note("the platform redacted the key values in this response")
					break
				}
			}
			return nil
		},
	}
	lf.add(cmd, "name")
	cmd.Flags().StringVar(&kind, "kind", "all", "filter by kind: smart, official, shared, fixed or all")
	return cmd
}

// fetchTokens loads keys, walking pages when a client side sort is needed.
func fetchTokens(ctx context.Context, cl *api.Client, lf listFlags, kind string) ([]api.Token, error) {
	size := lf.pageSize
	if size <= 0 {
		size = 100
	}
	if lf.sort == "" {
		list, err := cl.ListTokens(ctx, lf.page, size, kind)
		if err != nil {
			return nil, err
		}
		return list.Items, nil
	}
	var all []api.Token
	for page := 1; page <= 50; page++ {
		list, err := cl.ListTokens(ctx, page, size, kind)
		if err != nil {
			return nil, err
		}
		all = append(all, list.Items...)
		if len(list.Items) < size || len(all) >= list.Total {
			break
		}
	}
	return all, nil
}

func newTokenShowCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id>",
		Short: "Show one key in full",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, c, err := client()
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
			t, err := cl.GetToken(ctx, id)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(t)
			}
			key := render.MaskKey(t.FullKey())
			if flagShowSecrets {
				key = t.FullKey()
			}
			expires := "never"
			if t.ExpiredTime > 0 {
				expires = w.Time(t.ExpiredTime)
			}
			quota := "unlimited"
			if !t.UnlimitedQuota {
				quota = w.Money(t.RemainQuota)
			}
			w.Detail("Key "+t.Name, []render.Field{{Label: "Id", Value: strconv.Itoa(t.ID)},
				{Label: "Kind", Value: w.KindColor(string(t.Kind()))},
				{Label: "Status", Value: w.StatusColor(api.StatusLabel(t.Status))},
				{Label: "Key", Value: key},
				{Label: "Group", Value: orDash(t.Group)},
				{Label: "Provider", Value: orDash(t.ProviderSlug())},
				{Label: "Providers", Value: orDash(strings.Join(t.Providers(), ", "))}, {Label: "Models", Value: orDash(strings.Join(t.Models(), ", "))}, {Label: "Route preference", Value: orDash(t.SubrouterRoutePreference)},
				{Label: "Sort mode", Value: orDash(t.SubrouterSortMode)},
				{Label: "Include provider", Value: boolLabel(t.IncludeProviderSelf)},
				{Label: "Include official", Value: boolLabel(t.IncludeOfficialChannels)},
				{Label: "Include shared", Value: boolLabel(t.IncludeSharedSubscriptions)},
				{Label: "Include cache hit", Value: boolLabel(t.IncludeCacheHitRate)},
				{Label: "Load balance", Value: boolLabel(t.LoadBalanceEnabled)},
				{Label: "Cross group retry", Value: boolLabel(t.CrossGroupRetry)},
				{Label: "Official max discount", Value: fmt.Sprintf("%g", t.OfficialKeyMaxDiscount)}, {Label: "Shared max discount", Value: fmt.Sprintf("%g", t.SharedSubscriptionMaxDisc)}, {Label: "Official channel", Value: strconv.Itoa(t.OfficialChannelID)},
				{Label: "Quota", Value: quota},
				{Label: "Used", Value: w.Money(t.UsedQuota)},
				{Label: "Expires", Value: expires},
				{Label: "Allow IPs", Value: orDash(t.AllowIPs)},
				{Label: "Created", Value: w.Time(t.CreatedTime)},
				{Label: "Last used", Value: w.Age(t.AccessedTime)},
			})
			_ = c
			return nil
		},
	}
}

func newTokenCreateCommand() *cobra.Command {
	var tf tokenFlags
	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a model API key",
		Long: `Create a key of one of the four kinds.

  # smart routing across every subscribed provider
  subrouterctl token create --type smart --name "router" --providers demo,acme

  # pinned to a single provider, no failover
  subrouterctl token create --type fixed --name "demo only" --provider demo

  # shared account pools only
  subrouterctl token create --type shared --name "shared pool" --shared-max-discount 0

  # platform official channels only
  subrouterctl token create --type official --name "official"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, c, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			spec, err := tf.spec(cmd, c.QuotaPerUnit)
			if err != nil {
				return err
			}
			payload := spec.Payload()

			t, err := cl.CreateToken(ctx, payload)
			if err != nil {
				return err
			}
			// The create response omits the routing group, so read the stored
			// record back to report exactly what the platform applied.
			if stored, err := cl.GetToken(ctx, t.ID); err == nil {
				t = stored
			}
			if w.IsStructured() {
				return w.Structured(t)
			}
			key := t.FullKey()
			if !flagShowSecrets {
				key = render.MaskKey(key)
			}
			w.Success("created %s key %q (id %d)", w.KindColor(string(t.Kind())), t.Name, t.ID)
			w.Plain("  key:    %s", key)
			w.Plain("  group:  %s", orDash(t.Group))
			if t.ProviderSlug() != "" {
				w.Plain("  pinned: %s", t.ProviderSlug())
			}
			if len(t.Providers()) > 0 {
				w.Plain("  routes: %s", strings.Join(t.Providers(), ", "))
			}
			useKey := t.FullKey()
			if !flagShowSecrets {
				useKey = render.MaskKey(useKey)
			}
			w.Plain("  use it: export OPENAI_BASE_URL=%s/v1  OPENAI_API_KEY=%s", c.BaseURL, useKey)
			if !flagShowSecrets {
				w.Plain("  reveal it with --show-secrets")
			}
			return nil
		},
	}
	tf.add(cmd, true)
	return cmd
}

func newTokenUpdateCommand() *cobra.Command {
	var tf tokenFlags
	cmd := &cobra.Command{
		Use:   "update <id>",
		Short: "Update an existing key",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, c, err := client()
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
			current, err := cl.GetToken(ctx, id)
			if err != nil {
				return err
			}

			// Start from the stored key so that unset flags keep their value.
			tf.kind = string(current.Kind())
			if tf.kind == string(api.KindAuto) {
				tf.kind = string(api.KindSmart)
			}
			if tf.provider == "" {
				tf.provider = current.ProviderSlug()
			}
			if tf.providers == "" {
				tf.providers = current.SubrouterProviders
			}
			if tf.models == "" {
				tf.models = current.ModelLimits
			}
			if tf.name == "" {
				tf.name = current.Name
			}
			if tf.routePreference == api.DefaultRoutePreference {
				tf.routePreference = current.SubrouterRoutePreference
			}
			if tf.sortMode == api.SortModes[0] {
				tf.sortMode = current.SubrouterSortMode
			}
			tf.includeProvider = current.IncludeProviderSelf
			tf.includeOfficial = current.IncludeOfficialChannels
			tf.includeShared = current.IncludeSharedSubscriptions
			tf.loadBalance = current.LoadBalanceEnabled
			tf.includeCacheHit = current.IncludeCacheHitRate
			tf.officialMaxDisc = current.OfficialKeyMaxDiscount
			tf.sharedMaxDisc = current.SharedSubscriptionMaxDisc
			tf.officialChannel = current.OfficialChannelID
			tf.allowIPs = current.AllowIPs
			tf.crossRetry = current.CrossGroupRetry
			tf.keyGroup = current.KeyGroupID
			tf.unlimited = current.UnlimitedQuota
			tf.quotaUnit = current.RemainQuota
			if current.ExpiredTime <= 0 {
				tf.expire = "never"
			} else {
				tf.expire = strconv.FormatInt(current.ExpiredTime, 10)
			}
			// A stored fixed key keeps its pinned group.
			if current.ProviderSlug() != "" {
				tf.kind = string(api.KindFixed)
			}

			spec, err := tf.spec(cmd, c.QuotaPerUnit)
			if err != nil {
				return err
			}
			payload := spec.Payload()
			payload["id"] = id
			if current.Group != "" && spec.GroupValue() == "" {
				payload["group"] = current.Group
			}

			t, err := cl.UpdateToken(ctx, payload)
			if err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(t)
			}
			w.Success("updated key %d (%s)", t.ID, t.Name)
			return nil
		},
	}
	tf.add(cmd, false)
	return cmd
}

func newTokenDeleteCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete a key",
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
			t, err := cl.GetToken(ctx, id)
			if err != nil {
				return err
			}
			if !confirm(fmt.Sprintf("delete key %d (%s)?", id, t.Name)) {
				w.Plain("cancelled")
				return nil
			}
			if err := cl.DeleteToken(ctx, id); err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{"deleted": id})
			}
			w.Success("deleted key %d (%s)", id, t.Name)
			return nil
		},
	}
}

func newTokenDeleteBatchCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "delete-batch <id> [id...]",
		Short: "Delete several keys at once",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			w := writer()
			ctx, cancel := ctx()
			defer cancel()

			ids := make([]int, 0, len(args))
			for _, a := range args {
				n, err := strconv.Atoi(a)
				if err != nil {
					return fmt.Errorf("id must be a number, got %q", a)
				}
				ids = append(ids, n)
			}
			if !confirm(fmt.Sprintf("delete %d keys (%s)?", len(ids), strings.Join(args, ", "))) {
				w.Plain("cancelled")
				return nil
			}
			if err := cl.DeleteTokens(ctx, ids); err != nil {
				return err
			}
			if w.IsStructured() {
				return w.Structured(map[string]any{"deleted": ids})
			}
			w.Success("deleted %d keys", len(ids))
			return nil
		},
	}
}

func newTokenTypesCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "types",
		Short: "Explain the four key kinds",
		RunE: func(cmd *cobra.Command, args []string) error {
			w := writer()
			type entry struct {
				Kind    string
				Group   string
				Routing string
			}
			entries := []entry{
				{"smart", "subrouter", "every subscribed source, cheapest healthy route wins, automatic failover"},
				{"official", "subrouter", "platform official channels only"},
				{"shared", "subrouter", "subscribed shared account pools only"},
				{"fixed", "provider:<slug>", "one pinned provider, no cross provider failover"},
			}
			if w.IsStructured() {
				return w.Structured(entries)
			}
			rows := make([][]string, 0, len(entries))
			for _, e := range entries {
				rows = append(rows, []string{w.KindColor(e.Kind), e.Group, e.Routing})
			}
			w.Table([]render.Column{
				{Title: "KIND"}, {Title: "GROUP"}, {Title: "ROUTING"},
			}, rows)
			w.Note("")
			w.Note("Route preference criteria, in order: %s", strings.Join(api.RoutePreferences, ", "))
			w.Note("Sort modes: %s", strings.Join(api.SortModes, ", "))
			return nil
		},
	}
}

func boolLabel(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}
