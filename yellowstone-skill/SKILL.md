---
name: yellowstone
description: Install, configure, upgrade, and diagnose the Yellowstone stack — a herdr + pi coding-agent setup with its plugins, extensions, and agent skills. Use when setting up a new machine, reproducing this agent environment, checking which components are installed or out of date, upgrading herdr/pi/plugins, or repairing a component that stopped working. Covers the vendored forks (pi-pretty-tui, pi-cache-optimizer, bizzy, unblock) and the herdr plugins this setup pins.
---

# Yellowstone

Yellowstone is a working herdr + pi setup, checked into a repository so it can
be reproduced on another machine and reviewed like code. herdr is the terminal
workspace manager; pi is the coding agent that runs inside its panes; the rest
is the layer that makes the two behave like one system.

```
herdr                    terminal workspace manager, plugin host, socket API
  ├─ plugins             DAG viewer, ask queue, session handoff, themes, jj state
  └─ integrations        per-agent state hooks so the sidebar shows live status
pi                       coding agent, extension host
  ├─ packages            npm and git extensions (some vendored, some forked)
  ├─ extensions/         hand-written extensions (retry classifier)
  └─ models.json         provider routing, one credential file per provider
~/.agents/skills         shared skills both harnesses read
scripts/                 install, upgrade, doctor, plugin sync
```

The repo is the source of truth. Nothing here is meant to be edited in place
under `~/.config` or `~/.pi` and left there: `scripts/doctor.sh` reports when
the installed copy has drifted from the repository, and re-running `install.sh`
is how you reconcile.

## Read this first

Three rules make the rest of the document predictable.

**1. Everything is idempotent.** `install.sh` backs up before it overwrites and
skips what already matches. Running it twice is safe; running it after an
upstream change reconciles. There is no uninstall step because nothing is
deleted — the `.bak-yellowstone-<stamp>` files are the rollback path.

**2. Credentials are never in the repo.** `pi/models.json` declares `apiKey`
as a shell command (`!cat ${HOME}/.pi/agent/secrets/relayfast`), so the
committed file contains paths and no secrets. The installer creates empty files
for each provider it finds referenced and tells you which ones to fill. If you
ever find a literal key in this repo, treat it as a bug and rotate it.

**3. Pins are commits, not branches.** Plugin refs live in `herdr/plugins.toml`
and model/package sources in `pi/settings.json`. Moving a component forward is
a commit that changes a ref, so a machine that has not pulled keeps working and
a machine that has pulled can be diffed.

## Install

### Prerequisites

| Component | Version | Why |
|---|---|---|
| Node.js | >= 22.19 | pi requires it; several plugins use `node:sqlite` |
| git | any | plugin installs and package updates |
| python3 | any | helper parsing in `herdr-agy.sh` and some plugins |
| cargo | optional | builds `herdr-context` from source at install time |
| jj | optional | only if you use the jj plugins |

herdr and pi each have a one-line installer. Install them before this repo's
script, which drives them rather than replacing them:

```bash
curl -fsSL https://herdr.dev/install.sh | sh          # herdr
curl -fsSL https://pi.dev/install.sh   | sh          # pi (or: npm i -g @earendil-works/pi-coding-agent)
```

On a machine where those are managed by brew/mise/nix, install them there
instead and skip straight to `install.sh`; the repo never installs the binaries
themselves, only their configuration.

### Install Yellowstone

```bash
git clone https://github.com/Apothic-AI/yellowstone.git
cd yellowstone
./install.sh                 # interactive; asks before anything large
./install.sh --dry-run       # print the plan, change nothing
./install.sh --yes           # unattended
./install.sh herdr pi        # only selected stages
```

Stages, in the order they run:

| Stage | What it does |
|---|---|
| `herdr` | writes `config.toml`, installs the pi integration, installs/links the plugins from `herdr/plugins.toml`, symlinks the herdr skill, installs `herdr-agy.sh` |
| `pi` | merges owned keys into `settings.json`, merges providers into `models.json`, installs hand-written extensions, reconciles packages |
| `skills` | symlinks `hotshot`, `dagr-producer`, `unblock` into `~/.agents/skills` |
| `secrets` | creates empty credential files for every provider `models.json` references |
| `verify` | runs `scripts/doctor.sh` |

After it finishes, fill the credential files and check one route end to end:

```bash
printf '%s' 'sk-...' > ~/.pi/agent/secrets/relayfast
chmod 600 ~/.pi/agent/secrets/relayfast
pi auth check --provider relayfast --json      # {"status":"ready",...}
```

### What install deliberately does not do

- It does not overwrite `model-picker.json` (its MRU list is personal) or
  `web-search.json` (browser-cookie settings are machine-specific).
- It does not write into an existing `models.json` provider block. If you
  already route `relayfast` yourself, your `baseUrl` and key command stay.
- It does not touch `auth.json`, which holds OAuth credentials and belongs to pi.
- It does not install `unblock` from npm if the local checkout is missing; the
  plugin is linked from a checkout so the CLI and the pane share one version.

## Configuration

### herdr — `herdr/config.toml`

The file is committed whole, because every section of it is part of the setup:

```toml
onboarding = false
[theme] name = "tokyo-night"            # plus a custom palette below
[ui.sidebar.spaces] rows = [["state_icon","workspace"],["branch","git_status"],["$jj_bookmark","$jj_status"]]
[ui] show_agent_labels_on_pane_borders = true
[ui.toast] delivery = "system"
[[keys.command]] key = "prefix+d"  -> herdr-dagr.open-dagr
[[keys.command]] key = "prefix+u"  -> unblock.open
```

The sidebar rows are what make the jj plugins worth installing: `$jj_bookmark`
and `$jj_status` are tokens the `mroth.jj-status` plugin fills. Remove the
plugin and those rows render empty.

Validate and reload after editing:

```bash
herdr config check              # parse + diagnostics
herdr server reload-config      # apply in the running server
```

`herdr config reset-keys` exists if a keybinding fights your terminal; it backs
up the file first.

### herdr plugins — `herdr/plugins.toml`

One `[[plugin]]` table per plugin, with a pinned `ref` and a `why` line:

| Plugin | Role | Needs |
|---|---|---|
| `herdr-dagr` | live DAG pane for orchestrated work; also provides the `dagr` binary | — |
| `unblock` | queue for things only a human can do | a local checkout |
| `mroth.jj-status` | jj bookmark/status in the sidebar | `jj` on PATH |
| `herdr-context` | per-tab project context dock | Rust (built at install) |
| `wilbeibi.catchup` | summarize/fork/hand a session to another agent | — |
| `herdr-theme-picker` | theme browser writing `[theme.custom]` | — |
| `ezracerpac.jj-waltz` | jj workspace switcher (optional) | `jj` |

Apply the manifest:

```bash
scripts/herdr-plugins.sh list       # what the manifest declares
scripts/herdr-plugins.sh status     # installed / missing / optional
scripts/herdr-plugins.sh install    # install what is missing
scripts/herdr-plugins.sh update     # refresh GitHub-managed plugins in place
```

Two behaviours worth knowing. herdr refuses to install over a locally linked
plugin, so `unblock` must be cloned to `link_path` first — the script prints the
exact `gh repo clone` command when it is missing. And `herdr plugin update`
only exists on herdr 0.9.4+; on older servers the script reinstalls each pinned
ref instead, which has the same effect.

### herdr integrations

Integrations are separate from plugins: they are per-agent hooks that report
liveness so the sidebar can show `working` / `blocked` / `done`. `install.sh`
installs the pi one, which is the only one this setup requires. The rest are
per-agent and optional:

```bash
herdr integration status                    # what is installed and current
herdr integration status --outdated-only    # just the drift
herdr integration install <agent>           # pi, droid, opencode, agy, grok, claude, codex, ...
```

An integration reporting `outdated` still works but misses newer state
transitions; upgrade it after a herdr update. Note that `herdr integration
install pi` writes `~/.pi/agent/extensions/herdr-agent-state.ts` and herdr
manages that file — put your own hooks beside it, never in it.

### herdr-agy.sh — reliable waits for agy and grok

`herdr/scripts/herdr-agy.sh` installs to `~/.local/bin`. It exists because
herdr may report `idle`/`done` mid-turn for `agy` and `grok` agents, which makes
`herdr agent wait` return early. The script treats the pane tail as ground truth
and only believes a settled reading after consecutive clean polls:

```bash
herdr-agy.sh status <agent|pane>     # is it really settled?
herdr-agy.sh wait   <agent|pane> [--until STATE] [--timeout MS]
herdr-agy.sh prompt <agent|pane> "text"
herdr-agy.sh probe  <agent|pane>     # dump the signals it sees
```

Tune it with `HERDR_AGY_LINES` (tail depth, default 10), `HERDR_AGY_STABLE`
(clean polls required, default 2) and `HERDR_AGY_POLL` (seconds, default 2).
Use it whenever an orchestrator depends on an agy or grok agent finishing;
for pi, droid, claude and codex the native `herdr agent wait` is trustworthy.

### pi — `pi/settings.json`

`install.sh` merges only the keys Yellowstone owns and leaves the rest alone:
`defaultTools`, `theme`, `terminal`, `steeringMode`, `transport`, `retry`,
`collapseChangelog`, `enableInstallTelemetry`, `defaultProjectTrust`,
`enableSkillCommands`, `autocompleteMaxVisible`, `defaultThinkingLevel`, plus
the `packages` array (union by source, never duplicated).

Judge the values by what they fix:

- `"defaultTools": ["+codemode"]` — codemode is additive; pi's built-ins stay.
- `"retry": { maxRetries: 6, baseDelayMs: 2000 }` — gateways drop streams that
  a single retry does not cover.
- `"defaultProjectTrust": "always"` — appropriate for a personal machine; set it
  to `"ask"` if you open untrusted repositories.
- `"enableInstallTelemetry": false` — no install pings.
- `"theme": "neon-noir"` comes from the `@spences10/pi-themes` package.

Packages are declared, not copied. Two entries are special:

```json
"git:github.com/bitnom/pi-cache-optimizer",
"@YELLOWSTONE_REPO@/plugins/pi-pretty-tui"
```

The first is a fork installed from git, so `pi update` reconciles it. The second
is a placeholder the installer rewrites to an absolute path inside your clone —
pi loads that extension from this repository directly, so pulling the repo
updates it with no reinstall.

### pi — `pi/models.json`

Providers are keyed by name and each `apiKey` is a command that reads a file:

```json
"relayfast": {
  "baseUrl": "https://relay.fast/v1",
  "api": "openai-completions",
  "apiKey": "!cat ${HOME}/.pi/agent/secrets/relayfast",
  "compat": { "sendSessionAffinityHeaders": true }
}
```

`${HOME}` is expanded by the shell pi runs the command through, so the file is
portable between machines and contains no secrets. The merge never replaces a
provider you already have — delete the block first if you want the repo's
version back.

`compat.sendSessionAffinityHeaders` is not cosmetic: without it, multi-turn
requests land on different upstreams and the prompt cache misses, which shows up
as a much larger bill rather than as an error. Keep it on any gateway that
routes to more than one backend. `modelOverrides` pins routing for OpenRouter
models (for example `xiaomi/fp8`) where the default could silently pick a
different backend with different quantization.

Adding a provider is two steps: append the block, then create the credential
file. `scripts/doctor.sh` reports `pi-secrets` for any provider whose file is
missing or empty, so the second step is not easy to forget.

### Skills

`skills/` and `herdr/skills/` are symlinked into `~/.agents/skills`, which both
pi and other Agent Skills hosts read. Symlinking rather than copying means a
`git pull` updates every agent at once.

| Skill | What it does |
|---|---|
| `herdr` | how an agent drives herdr: panes, agents, waits, target verification |
| `hotshot` | two-phase one-shot job: cheap model reads everything, strong model executes |
| `dagr-producer` | write and validate a `run.json` DAG without ever publishing an invalid one |
| `unblock` | decide when something genuinely needs a human, then file the ask |

`hotshot` reads model ids from `.env` beside its `SKILL.md`. The repo ships that
file with empty values on purpose: the first run asks once, then writes them
back, so the choice is the operator's and not the repository's.

## Check for updates

`scripts/doctor.sh` is read-only and answers "is this machine still correct".
It checks prerequisites, the herdr binary and channel, whether `config.toml`
matches the repo, every plugin in the manifest, every herdr integration, pi's
version, whether each declared package actually loaded, provider and credential
counts, whether the default provider authenticates, skill symlinks, and whether
herdr or pi has a newer release upstream.

```bash
scripts/doctor.sh              # human-readable
scripts/doctor.sh --json       # {"ok":bool,"findings":[...]}
scripts/doctor.sh --quiet      # exit status only, for cron or CI
```

Exit 0 means nothing needs attention; exit 1 means something does. The statuses
are `ok`, `warn`, `fail` and `--` (informational, never counted). Warnings are
things to fix but not emergencies — an outdated integration, an empty key, a
skill symlinked somewhere else.

Check component versions by hand:

```bash
herdr --version && herdr status          # binary, plus whether the server is stale
herdr channel show                       # stable or preview
herdr plugin list                        # ids, versions, pinned refs
herdr integration status                 # per-agent hook versions
pi --version && pi list                  # agent, then every loaded package
dagr --version                           # comes with the herdr-dagr plugin
scripts/herdr-plugins.sh status          # manifest vs installed
```

## Upgrade

```bash
git pull                                 # the repo itself comes first
scripts/upgrade.sh                       # everything, in dependency order
scripts/upgrade.sh --dry-run             # the plan, no changes
scripts/upgrade.sh herdr plugins         # one or more components
```

The order in `upgrade.sh` is load-bearing:

1. **herdr binary** — plugins declare `min_herdr_version`, so the host upgrades
   before anything that depends on it. `herdr update` is used; when herdr came
   from brew/mise/nix it refuses and the script says so instead of fighting it.
2. **herdr server** — the running server keeps the old binary in memory. A new
   client works immediately, but server-side features stay unavailable until
   the server itself restarts, which is why the update runs with `--handoff`:
   that transfers live agent status to a restarted server instead of losing it.
3. **plugins** — `herdr plugin update` on 0.9.4+, pinned-ref reinstall below
   that. Locally linked plugins are skipped, since their update is a `git pull`
   in their own checkout.
4. **pi** — `pi update --all` moves the agent and every installed package.
5. **skills** — symlinked, so they were already updated by the `git pull`; this
   step reports any that point somewhere else rather than overwriting them.

Then it prints the state of the forks, which do not move with a blanket update:

| Component | Where it lives | How it updates |
|---|---|---|
| `pi-cache-optimizer` | `git:github.com/bitnom/pi-cache-optimizer` | `pi update` reconciles; upstream is `jiangge/pi-cache-optimizer` |
| `bizzy` | `git:github.com/Apothic-AI/bizzy` | `pi update`; upstream is `patty-io/pi-patty-bg-tasks` |
| `pi-pretty-tui` | vendored at `plugins/pi-pretty-tui` | `git pull` here; there is no public fork |
| `unblock` | a local checkout, linked | `git pull` there, then `npm link` if the CLI changed |
| `herdr-dagr` | a herdr plugin | `scripts/herdr-plugins.sh update`, or bump `ref` first |

Upgrading a pinned plugin is a two-step decision, not a command: bump `ref` in
`herdr/plugins.toml`, run `upgrade.sh plugins`, run `doctor.sh`, then commit.
That way the version a machine runs is visible in the repo.

### Rolling back

Nothing here is destructive, so rollback is file-level:

```bash
ls ~/.config/herdr/config.toml.bak-yellowstone-*     # previous config
ls ~/.pi/agent/settings.json.bak-yellowstone-*       # previous settings
herdr plugin install aemrebarut/herdr-dagr --ref <old-sha>
```

For a herdr binary that regressed, `herdr channel set stable` then
`herdr update` moves off preview; there is no supported downgrade to an
arbitrary older version, so keep the previous binary if you depend on one.

`herdr server stop` is not a safe rollback lever: it ends the panes the server
owns, which means every agent running in them dies with it. `herdr status`
distinguishes the two states — `restart_needed` (a new binary is installed) and
`server_binary_stale` (the server predates it) — and neither requires a stop
while you are working.

## Troubleshooting

| Symptom | First check | Fix |
|---|---|---|
| Sidebar shows no agent state | `herdr integration status` | `herdr integration install <agent>` |
| `$jj_bookmark` row is empty | `herdr plugin list`, then `jj --version` | install `jj`, re-run `scripts/herdr-plugins.sh install` |
| `herdr agent wait` returns early for agy/grok | `herdr-agy.sh probe <agent>` | use `herdr-agy.sh wait`, not `herdr agent wait` |
| pi says a model is unavailable | `pi auth check --provider <p> --json` | fill `~/.pi/agent/secrets/<p>` |
| Requests succeed but the bill jumps | `pi/models.json` `compat` | `sendSessionAffinityHeaders: true` on the gateway |
| Config edit does nothing | `herdr config check` | `herdr server reload-config` |
| A plugin pane will not open | `herdr plugin log list --plugin <id>` | `scripts/herdr-plugins.sh install` |
| A package silently stopped loading | `pi list` vs `settings.json` | `pi update --extensions` |
| Two extensions claim the same tool | startup error naming both | they conflict by design; disable one |
| herdr updated but behaves old | `herdr status` → `server_binary_stale` | reattach (`herdr`); the new client works at once, server features need a server restart — avoid `herdr server stop` while agents are running, it ends their panes |
| `doctor.sh` says a skill is elsewhere | `readlink -f ~/.agents/skills/<s>` | re-run `./install.sh skills`, or leave it if intentional |

Two conflicts are worth naming because they look like bugs:

**`pi-pretty-tui` versus `bizzy`.** Both historically claimed the `bash` tool,
and pi fails the whole losing extension. The vendored copy registers render-only
handlers that compose with whoever owns the tool, instead of claiming the name.
If you replace the vendored copy with the npm release, it breaks when `bizzy` is
also installed — that is why the fork exists and why it is vendored rather than
fetched. See `plugins/pi-pretty-tui/LOCAL-PATCHES.md`.

**`transient-error-retry` versus pi's retry classifier.** pi retries a fixed set
of error shapes. Some gateways report a dropped stream as `unknown:`, which pi
does not retry, so the run settles and the agent looks dead until nudged. The
extension reclassifies only that family as `server_error:` and delegates the
retry/no-retry decision to `isRetryableAssistantError` so it cannot drift from
pi's own rules. It refuses to touch quota and billing errors.

## Layout

```
AGENTS.md                  shared agent instructions for this setup
install.sh                 install / reconcile a machine
herdr/
  config.toml              theme, sidebar rows, keybindings
  plugins.toml             plugin manifest with pinned refs
  scripts/herdr-agy.sh     reliable waits for agy/grok agents
  skills/herdr/SKILL.md    how agents drive herdr
pi/
  settings.json            owned keys + package declarations
  models.json              provider routing (no secrets; key commands only)
  model-picker.json        picker defaults (installed once, then personal)
  web-search.json          browser-cookie search defaults
  pi-auto-compact.json     compaction threshold
  trust.example.json       how trust.json is shaped — copy, do not install blind
  extensions/              hand-written pi extensions
plugins/
  pi-pretty-tui/           vendored fork; render-only tool handlers
skills/
  herdr, hotshot, dagr-producer, unblock
scripts/
  install helpers, plugin sync, doctor, upgrade
docs/                      longer-form notes
```

## Related

- herdr documentation: https://herdr.dev/docs/ — `herdr --skill` prints the
  agent-facing skill the binary itself ships.
- pi documentation: shipped with the package under
  `<pi install>/docs` — start with `configuration.md`, `models.md`,
  `packages.md` and `extensions.md`.
- The two skill files that describe operating *this* stack rather than
  installing it are `herdr/skills/herdr/SKILL.md` (driving panes) and
  `skills/dagr-producer/SKILL.md` (publishing a valid run graph).
