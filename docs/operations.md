# Operations

Day-to-day routines for a machine running Yellowstone, and what to do when
something reports a problem. Installation, configuration and upgrade mechanics
are in [`yellowstone-skill/SKILL.md`](../yellowstone-skill/SKILL.md); this page
is about running it.

## Routine check

```bash
cd ~/Code/yellowstone
git pull
scripts/doctor.sh
```

Once a week is enough for a single-user machine. `doctor.sh` is read-only, so it
is safe to run at any time, including while agents are working — it reads the
herdr socket API and pi's config files, and starts nothing.

Exit 0 means nothing needs attention. If it exits 1, read the `warn`/`fail`
lines in order; the report is grouped so the fix order is top to bottom:

1. **Prerequisites** — a missing node or git breaks everything downstream.
2. **Herdr** — binary, then server freshness, then config, then plugins.
3. **Pi** — settings, packages, models, credentials, then a live auth check.
4. **Agent skills** — symlinks.
5. **Updates available** — informational, unless you care about the drift.

## Updating

```bash
git pull
scripts/upgrade.sh --dry-run     # read the plan
scripts/upgrade.sh               # apply
```

The script handles herdr → plugins → pi → forks in that order. Two things it
cannot do for you:

- **Restart the herdr server.** After a binary update the server keeps the old
  build in memory. `herdr update --handoff` transfers live agent status to a
  restarted server where supported; otherwise the new client works immediately
  and server-side features wait for the next restart.
  **Do not run `herdr server stop` while agents are working** — it ends the panes
  the server owns, and every agent in them dies with it.
- **Accept a plugin bump.** Pinned refs move only when someone edits
  `herdr/plugins.toml`. `scripts/herdr-plugins.sh update` re-fetches the pinned
  ref; it will not move you to a newer upstream release.

## When things break

### An agent looks stuck

```bash
herdr agent list                        # what herdr thinks the state is
herdr agent read <agent> --source recent-unwrapped --lines 80
```

For `agy` and `grok`, herdr's reported state can say `idle` mid-turn. Use the
wrapper, which reads the pane instead of the status field:

```bash
herdr-agy.sh probe <agent>     # what signals it sees
herdr-agy.sh status <agent>    # settled or not
```

For pi, droid, claude and codex the native `herdr agent wait` is reliable.

### An agent replies with a provider error

```bash
pi auth check --provider <provider> --json
```

`{"status":"ready"}` means the credential resolves and the endpoint accepts it.
A failure here is almost always an empty or expired file in
`~/.pi/agent/secrets/`. If the error mentions an upstream stream ending
unexpectedly, that is the transient family `pi/extensions/transient-error-retry.ts`
reclassifies so pi retries it — if it is still surfacing, the gateway returned
something outside that family, and the extension's allowlist is the place to
look.

### Costs jumped without an error

Two causes worth checking, in this order:

1. **Cache misses.** A gateway that routes to multiple backends will serve a
   multi-turn conversation from different upstreams unless
   `compat.sendSessionAffinityHeaders` is set. Check the provider block in
   `pi/models.json`. `pi-cache-optimizer` reports hit rates in the footer when it
   is loaded.
2. **Routing drift.** `modelOverrides` in `pi/models.json` pins OpenRouter
   routing for models where the default could pick a differently quantized
   backend. A missing override produces correct output at a different price.

### A herdr pane will not open

```bash
herdr plugin list
herdr plugin log list --limit 20
```

Plugin command output is logged per invocation, so a failing pane shows the
exact command and exit code. Most failures are a build step (Rust for
`herdr-context`) or a missing runtime (`jj` for the jj plugins).

### A skill is not being picked up

```bash
ls -la ~/.agents/skills/
readlink -f ~/.agents/skills/<name>
```

Skills are discovered recursively, so a stray backup directory beside a skill
loads as a duplicate and the first one wins with a warning. Yellowstone stores
skill backups under `~/.local/state/yellowstone/backups/` for exactly this
reason; if you find a `*.bak-*` directory under `~/.agents/skills`, move it out.

### After a host reboot

herdr is a server: panes survive client detach, but not a reboot. On start:

```bash
herdr                      # attach, or start the default session
herdr plugin list          # confirm plugins registered
scripts/doctor.sh          # confirm nothing drifted while the box was down
```

Plugins with `[[startup]]` hooks (the `unblock` daemon, the jj sidebar sweep)
run on server startup, so no manual step is needed for them.

## Health signals worth watching

| Signal | Where | Meaning when it moves |
|---|---|---|
| Agent state in the sidebar | herdr UI | an integration is broken if it stays blank while an agent is working |
| Cache hit rate / cost footer | pi footer | provider routing or affinity changed |
| `herdr status` → `server_binary_stale` | CLI | a new binary is installed but the server is old — clients are fine, new server features are not |
| `herdr integration status --outdated-only` | CLI | an agent hook is behind; state may still work but miss newer transitions |
| `scripts/doctor.sh` exit code | CLI | use it as the single gate in any automation |

## What to record when you change something

The repo is the record. A change is only complete when:

- the config change is committed here, not only applied under `~/.config`;
- `scripts/doctor.sh` would notice if the machine reverted;
- a fork or pin change is explained in `docs/forks.md` or the manifest's `why`;
- nothing in the diff is a credential.

If a change cannot be represented in the repo — an OAuth login, a browser profile
choice, a project-trust decision — say so in the commit message and leave the
machine-level file alone.
