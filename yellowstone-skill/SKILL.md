---
name: yellowstone
description: Install, configure, upgrade, and diagnose the Yellowstone stack — a herdr + pi coding-agent setup with its plugins, extensions, and agent skills. Use when setting up a new machine, reproducing this agent environment, checking which components are installed or out of date, upgrading herdr/pi/plugins, or repairing a component that stopped working. Covers the forks we maintain (pi-pretty-tui, pi-cache-optimizer, bizzy, unblock), the herdr plugins this setup pins, and the `overlord` orchestrator space.
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
  ├─ packages            npm releases plus our forks, each from its own repo
  ├─ extensions/         hand-written extensions (retry classifier)
  └─ models.json         provider routing, one credential file per provider
~/.agents/skills         shared skills both harnesses read
~/AGENTS.md              shared agent instructions, inherited by every project under $HOME
~/.overlord              the overlord space's cwd: role instructions + space index
~/.sysops                the sysops space's cwd: machine and service operations
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

**2. Credentials are never in the repo.** `home/.pi/agent/models.json` declares `apiKey`
as a shell command (`!cat ${HOME}/.pi/agent/secrets/relayfast`), so the
committed file contains paths and no secrets. The installer creates empty files
for each provider it finds referenced and tells you which ones to fill. If you
ever find a literal key in this repo, treat it as a bug and rotate it.

**3. Pins are commits, not branches.** Plugin refs live in `herdr/plugins.toml`
and model/package sources in `home/.pi/agent/settings.json`. Moving a component forward is
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

Stages, in the order they run. Each stage installs the `home/` subtree that owns
the destination — the tree is a literal mirror of `$HOME`, so the paths below are
the installed paths:

| Stage | What it does |
|---|---|
| `herdr` | installs `home/.config/herdr/` (`config.toml`, `plugins.toml`), the pi integration, the plugins declared in `plugins.toml`, and `home/.local/bin/` (`herdr-agy.sh`, mode 755) |
| `pi` | installs `home/.pi/agent/`: merges owned keys into `settings.json` (rendering `@PLACEHOLDER@` package sources on a first install), merges providers into `models.json`, installs extensions and configs, keeps the personal files, then reconciles packages |
| `skills` | installs every agent skill from the tree that owns it (`skills/skills.tsv`); the ones this repo owns are linked from `home/.agents/skills/` |
| `agents` | installs `~/AGENTS.md` from `home/AGENTS.md`, the shared agent instructions |
| `overlord` | installs `home/.overlord/`, creates `~/.sysops`, both spaces, and their agent tabs |
| `secrets` | creates empty credential files for every provider `models.json` references |
| `verify` | runs `scripts/doctor.sh` |

A stage that cannot finish (a missing checkout, a plugin needing a herdr server)
reports and lets the run continue: an install that stops half way leaves a
machine in a state nobody described.

After it finishes, fill the credential files and check one route end to end:

```bash
printf '%s' 'sk-...' > ~/.pi/agent/secrets/relayfast
chmod 600 ~/.pi/agent/secrets/relayfast
pi auth check --provider relayfast --json      # {"status":"ready",...}
```

### What install deliberately does not do

- It does not overwrite `model-picker.json` (its MRU list is personal),
  `web-search.json` (browser-cookie settings are machine-specific) or
  `pi-persist.json` (the trailing reminders a person wrote). Each ships as a
  first-install default and is then kept.
- It does not write into an existing `models.json` provider block. If you
  already route `relayfast` yourself, your `baseUrl` and key command stay.
- It does not touch `auth.json`, which holds OAuth credentials and belongs to pi.
- It does not install `unblock` from npm if the local checkout is missing; the
  plugin is linked from a checkout so the CLI and the pane share one version.
- It does not mirror `~/.pi/agent/secrets/` or `~/.pi-profile-switch/instances/`.
  Credentials and generated profile state are not shipped content:
  `home/.pi/agent/` is the path pi uses **when no profile is selected**, which on
  a profile-driven machine is not the directory it actually reads.

## Configuration

### herdr — `home/.config/herdr/config.toml`

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
| `herdr-bar` | command bar: `prefix+k` fuzzy-jumps to any tab, pane, agent, repo or branch; also titles unnamed tabs | — |
| `ray.plugin-manager` | plugin popup: `prefix+p` to install, update, remove, toggle and browse plugins | — |
| `abhishekrana.dictate` | local speech-to-text into the focused pane: `prefix+v` toggle, `prefix+shift+v` toggle-and-submit, `prefix+alt+v` live typing | Rust ≥ 1.88 to build, a microphone, Linux |
| `brogrammermw.herdr-voice` | realtime voice session that drives the panes, with a floating orb: `prefix+m` | a Swift toolchain to build, a microphone, a local checkout |
| `codeforbreakfast.beady-eye` | `bdi` split beside the focused pane: the project's bead trees with the agent on each one: `prefix+i` | a beads database for that project |
| `vsh.stash` | park a workspace (agents stopped, layout and conversations kept) and restore it from a popup: `prefix+s`, `prefix+shift+s` | — |
| `ntindle.herdr-resurrect` | tmux-resurrect for herdr: snapshot the herd and restore it after a crash or reboot (no keybind; command palette) | — |
| `ezracerpac.jj-waltz` | jj workspace switcher (optional) | `jj` |

Apply the manifest:

```bash
scripts/herdr-plugins.sh list       # what the manifest declares
scripts/herdr-plugins.sh status     # installed / missing / optional
scripts/herdr-plugins.sh install    # install what is missing
scripts/herdr-plugins.sh update     # refresh GitHub-managed plugins in place
```

### Installing a plugin: the popup, and why the manifest still matters

`ray.plugin-manager` (`prefix+p`) is a popup over the `herdr plugin` CLI. It is the
comfortable way to install, update, remove, toggle and browse plugins, and
`herdr-bar` (`prefix+k`) is the navigation counterpart — jump to anything, rather
than remembering where it lives.

**It installs into the machine, not into this repo.** So there are two surfaces and
only one source of truth:

| Surface | What it is | Where the record lives |
|---|---|---|
| the popup (`prefix+p`) | interactive discovery and one-off management | `~/.config/herdr/plugins.json`, per machine |
| `herdr/plugins.toml` | the declared set, with pinned refs | this repo |

A plugin installed through the popup exists on that machine and nowhere else — a
second machine provisioned from this repo will not have it, and `doctor.sh` will
report it as undeclared only if you also remove it from the manifest. So after
installing something you intend to keep, add a `[[plugin]]` row with its resolved
commit and a one-line `why`; `herdr plugin list` prints the ref.

Neither plugin ships keybindings in its manifest, so the binds live in
`home/.config/herdr/config.toml` and are part of this repo: `prefix+k` → `herdr-bar.open` and
`prefix+p` → `ray.plugin-manager.open`. Install the plugin without the bind and it
is unreachable; install the bind without the plugin and the key does nothing.

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

`home/.local/bin/herdr-agy.sh` installs to `~/.local/bin`. It exists because
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

### pi — `home/.pi/agent/settings.json`

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
- `"theme": "neon-noir"` comes from the `@spences10/pi-themes` package (11
  themes under `~/.pi/agent/npm/node_modules/@spences10/pi-themes/themes/`).

Several packages are load-bearing enough to be worth naming here, because their
failure modes are silent.

**`@signalridge/pi-goal`** — the goal extension, and it is **not** `pi-codex-goal`.
It replaced that extension and is stricter; do not carry old instructions across.
Verified against the installed source (`@signalridge/pi-goal` 1.4.8), not the README:

- **Tool surface is three tools: `goal_complete`, `goal_blocked`, `goal_wait`.**
  There is no `create_goal`, `get_goal` or `update_goal` — so on pi **an agent cannot
  create or change its own goal objective**. Only a `/goal` slash command does that.
  Tools are hidden until a goal exists (`toolVisibility: after-first-goal`), so a
  fresh session will not see them.
- **`/goal <objective>` REPLACES the active goal and wipes the whole queue**, behind a
  `Replace goal?` confirm modal. A modal in an agent pane absorbs the next Enter, so
  the send reports success and no turn runs. Prefer, in order: `/goal edit <obj>`
  (in place, no modal, keeps counters), `/goal add <obj>` (appends; starts
  immediately when no goal is active), and only then a bare `/goal <obj>` with a
  human at the modal.
- **The queue advances itself** at the settled boundary after `goal_complete`.
  Verbs: `pause`, `resume`, `clear`, `edit`, `add`, `prioritize`, `drop-last`,
  `skip`, `status`. `add` to build a backlog and let the agent walk it.
- **Prompting a lane that is working pauses the goal**, not just the turn
  (`pauseForAbort`), so automatic continuation stops and the pane looks like an
  ordinary stop. Recovery is that lane's own bare `/goal resume`.
- A goal also stops on `budgetLimited` (a distinct status, not paused) and stays
  stopped on `blocked` until an explicit `/goal resume`. `/new` does not carry a goal
  across. **Goal state is only readable from a pane footer** — `herdr agent get` and
  `agent list` carry no goal fields.

**`pi-rooms`** — rooms, DMs and reply-all between pi sessions. File-based, no
daemon, state under `~/.pi/agent/rooms`. Identity is a name registered per session;
set `PI_ROOMS_NAME` per lane or a name is derived from cwd + pid and does not survive
a restart.

**`pi-persist`** — a cached prompt section plus a per-request trailing message that
other extensions append to. Configured by `home/.pi/agent/pi-persist.json` (trailing reminders).
Installed only when absent: it accumulates the operator's own reminders.

**`apothic-todo`** (`@arhen/pi-core-todo`) and **`pi-core-tps-stats`** — todos and
live tokens-per-second stats. Small, no config.

**`transient-error-retry`** (below) exists because pi's classifier does not cover
every gateway's dropped-stream phrasing.

**`nonblock`** (see [Never block the session](#never-block-the-session)) refuses the
blocking form of a wait, so an intake-style agent stays reachable. It ships
**disabled**: it changes agent behaviour, and a machine that legitimately needs a
bounded wait should not lose it silently. Opt in with
`echo '{"enabled":true}' > ~/.pi/agent/nonblock.json` or `PI_NONBLOCK=1`.

Packages are declared, not copied, and nothing points into this repository.
Two entries are our forks:

```json
"git:github.com/bitnom/pi-cache-optimizer",
"git:github.com/Apothic-AI/pi-pretty-tui"
```

Both install from their own repositories, so `pi update` reconciles them and the
fork's code is reviewed and versioned where it lives. A machine that already has
either package from a different source is left alone: the merge compares package
names, not source strings, so you never end up with two copies of an extension
that claims a tool name.

#### Where the run file lives, and why a closed run must move

The dagr pane watches one path: `dagr view` resolves `.dagr/run.json` under the
herdr context cwd, and the herdr plugin's pane uses the same default. Two
consequences are easy to get wrong, and both make finished work look live:

- **A settled run must not stay at `.dagr/run.json`.** Move it to
  `.dagr/archive/<run-id>.json` and let `.dagr/run.json` hold the current one.
  Re-rendering will not fix a stale file — that is a content problem, not a
  viewer problem.
- **Every `locator` in a run must name a pane that exists now.** A locator aimed
  at a closed pane renders as `pane gone`, and a board of those is a historical
  record wearing a live label. Re-read topology before publishing.

Neither is a dagr bug: dagr renders what the file says, and the file is the
producer's responsibility.

### Themes

Two theme systems, and it matters which one you are reading, because a
`config.toml` can name one theme while displaying another.

| Surface | Set in | Source of the colours |
|---|---|---|
| herdr | `[theme]` + `[theme.custom]` in `home/.config/herdr/config.toml` | built-in theme by name; `[theme.custom]` overrides individual tokens |
| pi | `"theme"` in `home/.pi/agent/settings.json` | an npm package (`@spences10/pi-themes` here) |

**`[theme.custom]` wins, and `theme.name` stays whatever it was.**
`herdr-theme-picker` never changes `theme.name`; it rewrites `[theme.custom]`
from a *terminalcolors/ghostty* palette through its own
`palette_to_tokens` mapping (`bin/map.sh`). So a shipped config can read
`name = "tokyo-night"` while every rendered colour comes from a derived palette —
`tokyo-night` is vestigial in that case, not the active theme.

**A custom palette is not a package, so do not document it as one.** The palette
in `home/.config/herdr/config.toml` is 19 derived tokens, not a file any plugin ships. To find
where it came from, derive it yourself and compare:

```bash
# herdr-theme-picker's own mapping, applied to a cached palette
source ~/.config/herdr/plugins/github/herdr-theme-picker-*/bin/map.sh
palette_to_tokens ~/.local/state/herdr/plugins/herdr-theme-picker/themes/<name> | sort
# and the live values
sed -n '/theme.custom/,$p' ~/.config/home/.config/herdr/config.toml | grep -E '^[a-z_0-9]+ = ' | sort
```

If those match, the live palette *is* that palette file, mechanically derived;
if they differ, a human hand-tuned the tokens. Both are legitimate, and only the
comparison tells you which you have.

Do not ship a static catalogue of available themes. herdr's list comes from the
binary (`herdr --default-config`), pi's from an installed npm package (list
`themes/*.json`), and the picker's from a cache it fills on demand — all three
move with their source, so a pinned list goes stale. Enumerate at run time.

### Never block the session

An agent that is the single conversational intake for a fleet must be reachable at
every instant. A call that holds the turn queues the operator's next message behind
it, so **blocking is a defect class, not slowness** — and the blocking forms are the
diligent-sounding ones, which is why a competent agent reaches for them:

| Need | Blocking (never) | Non-blocking (always) |
|---|---|---|
| check on a delegated job | `jobs action='attach'` | `jobs action='output'` |
| wait for a condition | a `sleep` loop in the turn | `run_in_background=true` with an `until` loop |
| watch for events | polling inside the turn | the `monitor` tool |
| wait for a lane's stop boundary | prompting or spinning | a backgrounded boundary wait, then next item |

`jobs action='attach'` is the specific trap: it reads as diligence ("I will wait for
the agent's own report") while doing the one thing that must not happen. This has
already cost a real operator message — the turn held, their instruction queued behind
it, and they had to interrupt by hand.

Documentation alone does not hold this invariant, because the tempting call looks
correct. `home/.pi/agent/extensions/nonblock.ts` enforces it through pi's `tool_call` hook, which
may mutate `event.input` in place: an `attach` with `wait: false` is rewritten to
`output`, and an `attach` that would block is refused with the table above as the
reason. Enable it wherever an agent is an intake:

```bash
echo '{"enabled":true}' > ~/.pi/agent/nonblock.json   # or PI_NONBLOCK=1
```

The general lesson is worth more than the specific case: **when the right action is
available but the wrong one is more discoverable, fix the affordance rather than
writing the rule again.** An invariant that depends on an agent remembering it is
followed by luck; one enforced at the call site is followed by construction.

### Extension configs

Four small files decide how the packages behave. They are config, not state:

| File | Controls |
|---|---|
| `pi/pi-goal.json` | goal extension: `toolVisibility: after-first-goal`, `experimental.goals`, `rpc.enabled`, and **`continuationLimits` — both `automaticTurns` and `noProgressTurns` are `null`**, i.e. no automatic ceiling. Do not set `--tokens` on a goal: a budget stops it at `budgetLimited` and revives it only with a new goal. |
| `pi/pretty-tui.json` | `{"mode": "clean"}` — the three TUI modes are clean/compact/full, and clean is what the shipped theme is tuned for |
| `pi/pi-auto-compact.json` | compaction threshold and alignment |
| `home/.pi/agent/pi-persist.json` | trailing reminders appended to every request (installed only when absent — it accumulates the operator's own) |

### pi — `home/.pi/agent/models.json`

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

### The two default spaces — `~/.overlord` and `~/.sysops`

Yellowstone ships two herdr workspaces that are not projects:

| Space | cwd | Tabs (each hosts a pi agent of the same name) | Job |
|---|---|---|---|
| `overlord` | `~/.overlord` | `overlord` | coordinate the coding-agent orchestrators in the other spaces |
| `sysops` | `~/.sysops` | `sysop-leader` | machine and service operations: host config, disks, services, network |

They are separate because they are different jobs. Mixing ops work into the
orchestrator's context puts disk and service noise next to project coordination,
and the orchestrator's own instructions are already long.

```bash
scripts/overlord.sh install    # dirs, docs, both spaces, all three tabs
scripts/overlord.sh status     # dirs? docs? spaces? tabs? agents in them?
```

`install.sh` runs this as its `overlord` stage. The `sysops` space is found by
label like `overlord` is, so an existing one is never duplicated, and an existing
`sysop-leader` agent is never restarted.

The directory holds exactly two files:

| File | Role | Reinstalled? |
|---|---|---|
| `AGENTS.md` | the orchestrator's role, boundaries, and operating rules | yes — the repo is the source of truth |
| `README.md` | the live workspace index: which space maps to which directory | **no** — never overwritten once it exists |

`README.md` is the one file the operator updates as spaces come and go, so
overwriting it would destroy the only map. `install.sh` replaces `AGENTS.md` and
leaves `README.md` alone.

**The space is created only if a workspace labelled `overlord` is absent.**
`herdr workspace create` does not deduplicate by label or cwd — calling it twice
produces two workspaces with the same name — so `overlord.sh` lists workspaces
first and treats an existing one as done. That check is the whole reason the
script exists rather than two commands in the install guide.

The script never moves an existing space's cwd. If the operator has pointed
`overlord` somewhere deliberate, changing it is a layout change outside what an
installer should do.

#### The two agent tabs

The `overlord` workspace has exactly two tabs, each hosting a **pi** agent:

| Space | Tab label | Agent name | Role |
|---|---|---|---|
| `overlord` | `overlord` | `overlord` | the parent orchestrator — reads `~/.home/.overlord/AGENTS.md` and directs the other spaces |
| `sysops` | `sysop-leader` | `sysop-leader` | machine and service operations |

`overlord.sh install` creates each tab if it is missing and starts a `pi` agent
in it. A tab that already exists but is labelled differently is **reported, not
renamed**: `status` lists any tab the script did not provision
(`sysops-extra ... other tabs present`), because an older hand-made `sysop-lead`
beside `sysop-leader` is exactly how an operator drives the wrong pane. Renaming
or closing someone's tab is their call.

Three more rules keep this safe to re-run:

- **A tab that already hosts an agent is left alone.** `herdr agent start`
  requires a pane at a shell prompt, and replacing an existing session would
  discard the operator's conversation. If the tab already has a live agent, the
  script reports it and moves on — it does not restart, rename, or rebuild it.
- **Naming is separate from starting.** A tab whose agent is already running but
  unnamed keeps its session; name it with
  `herdr agent rename <pane_id> <tab-label>` rather than restarting it.
- **A freshly created tab needs a moment.** The shell inside it is still coming
  up, so the script retries `agent start` a few times before giving up and
  printing the exact command to run by hand.

`overlord.sh status` reports each tab and whether it hosts an agent, so
`scripts/doctor.sh` surfaces a missing or agentless tab without anyone having to
click around.

### Comms — the mycord skills

A comms space is only useful if the agent there knows how to reach each channel.
Those skills all live in one repository,
[`Apothic-AI/mycord`](https://github.com/Apothic-AI/mycord), one directory per
channel:

| Skill | Channel | Notes |
|---|---|---|
| `mycord-skill` | *(router)* | install this first: the index of every medium, which are planned, and which skill to install for the one you need |
| `mycord-discord-skill` | Discord | `discord.py-self` REPL. **Selfbot automation violates Discord's ToS and can get the account banned** — the operator's risk to accept, never initiated unprompted |
| `mycord-telegram-skill` | Telegram | Telethon REPL. Telegram permits third-party clients |
| `mycord-slack-skill` | Slack | drives Slack as the signed-in human via an `xoxc-` client token plus the httpOnly `d` cookie, with no app registration |
| `mycord-irc-skill` | IRC | pydle REPL, TLS by default |
| `mycord-email-skill` | email | Himalaya CLI with a per-account wrapper config |
| `google-voice-skill` | SMS / voice | unofficial `gvoice` TS client; reading works, sending SMS needs a captured exchange |
| `ferdium-skill` | *(catch-all)* | drives a Ferdium install over CDP — for a service that has no dedicated skill |

`mycord-skill` is a **router, not an implementation**: it tells the agent which
medium exists and to install that medium's own skill before writing code. Install
it first, because an agent handed only `mycord-skill` will otherwise try to
improvise the medium instead of installing the skill that implements it.

The repository grows — Slack and the router both appeared after email and IRC —
so derive the list from the checkout rather than from this table:

```bash
ls -d ~/Code/mycord/*/ | while read d; do [ -f "$d/SKILL.md" ] && basename "$d"; done
```

They are declared in `skills/skills.tsv` as `repo` rows, so `install.sh skills`
installs them like any other skill. Two things are specific to this repository:

- **The skills sit at the repository root, not under `skills/`.** `skills-sync.sh`
  resolves both layouts, but a resolver that only knew `skills/<id>/` would fall
  through to the network and fail: `npx skills add Apothic-AI/mycord` reports
  "No valid skills found". Clone the repo instead — that is the reliable path and
  it makes later updates a `git pull`:

  ```bash
  gh repo clone Apothic-AI/mycord ~/Code/mycord
  ./scripts/skills-sync.sh install
  ```

- **`-g` does not work for this repository.** Verified: `npx skills add
  Apothic-AI/mycord --skill <component> -g` fails with `PromptScript does not
  support global skill installation`. Drop `-g` and it writes into the *current*
  project instead, which is not where a global agent reads from. Treat a command
  that is documented but fails as undocumented: use the checkout.
- **A fetch overwrites a link with a copy.** Running `npx skills add` for a skill
  this installer already linked replaces the symlink with a real directory, and
  the copy is then free to drift from the checkout it came from (it also loses
  the siblings that only the checkout has — `Makefile`, `pyproject.toml`,
  `.env.example`). `skills-sync.sh install` puts the link back and backs the copy
  up; `skills-sync.sh status` reports it as `present` rather than `linked` in the
  meantime.

- **A checkout beats a hand-copied skill.** These skills ship `.env.example`,
  `pyproject.toml`, `Makefile` and `src/` beside `SKILL.md`; a copy of just the
  markdown loses the environment template and drifts. If you already keep copies
  under `~/.agents/skills/`, move them aside and let the script link the
  checkout — it backs them up under
  `~/.local/state/yellowstone/backups/` first.

Each skill documents its own setup (`uv sync`, `cp .env.example .env`, then a
REPL start command); run those inside the skill's directory, not through this
installer. The `comms` agent reads them, so it needs the checkout to be readable
by whoever runs it.

### Skills

Every skill is installed from the tree that owns it, decided by
`skills/skills.tsv`. That file is the authority; `scripts/skills-sync.sh` reads
it and nothing else decides what gets installed.

| Skill | Owned by | Installed by |
|---|---|---|
| `yellowstone` | this repo | symlinked from `yellowstone-skill/` |
| `herdr` | this repo (a fork of the shipped skill) | symlinked from `home/.agents/skills/herdr/` |
| `hotshot` | this repo, for now | symlinked from `home/.agents/skills/hotshot/` |
| `dagr-producer` | the `herdr-dagr` plugin | `dagr --skill`, then symlinked |
| `unblock` | `Apothic-AI/unblock` | linked from a checkout, else `npx skills add` |

Three rules, each learned the hard way:

**Do not bundle a skill another tree already ships.** A copy of `dagr-producer`
here would be a silent fork of a file the pinned plugin owns, free to drift from
the `dagr` binary beside it. Same for `unblock`: the fork's copy is the current
one, so a copy here would freeze agents on older instructions.

**For `dagr`, generate from the binary.** `dagr --skill` prints the copy bundled
with your installed dagr, which is the only version guaranteed to match the
contract that binary validates. `skills-sync.sh` writes it to
`<plugin_root>/skills/dagr-producer/SKILL.md` — inside the plugin, so the
`examples/*.json` links in the skill still resolve — and links that directory
into `~/.agents/skills`:

```bash
scripts/skills-sync.sh install          # all of them
scripts/skills-sync.sh status           # installed / drift / bundled debt
dagr --skill                            # the text itself, if you just want to read it
```

A `repo` skill is linked from a checkout when one exists, because that is what
makes its updates a `git pull`. `npx skills add` is the fallback, and it is not
dependable for every repository — it did not discover `Apothic-AI/unblock`'s
`skills/unblock/` at all, and it refused a global install for `herdr-dagr`'s
layout. When the CLI comes up empty, `skills-sync.sh` prints the `gh repo clone`
command to run instead, which is also what you want if you intend to edit the
skill.

**`bundle` is debt, not a design.** `hotshot`'s home repository
(`Apothic-AI/one-shot-genius`) exists but is empty, and the `herdr` skill here is
a fork whose delta is worth sending upstream. `scripts/skills-sync.sh status`
and `scripts/doctor.sh` both count what is bundled, so the debt stays visible
instead of turning into an unofficial fork.

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
| `pi-cache-optimizer` | `src/pi-extensions/pi-cache-optimizer` (`feat/opencode-cache-stats`) | `git subrepo pull` + gate; upstream is `jiangge/pi-cache-optimizer` |
| `bizzy` | `src/pi-extensions/bizzy` (`apothic-main`) | `git subrepo pull` + gate; upstream is `patty-io/pi-patty-bg-tasks` |
| `pi-pretty-tui` | `src/pi-extensions/pi-pretty-tui` (`test/composer-selection-on-apothic`) | `git subrepo pull` + gate; upstream is `ykn0309/pi-pretty-tui` |
| `pi-rooms` | `src/pi-extensions/pi-rooms` (`master`) | `git subrepo pull` + gate |
| `apothic-todo` | `src/pi-extensions/apothic-todo` (`main`) | `git subrepo pull` + gate (replaces `@arhen/pi-core-todo`) |
| `pi-persist` | `src/pi-extensions/pi-persist` (`main`) | `git subrepo pull` + gate |
| `pi-goal` | `src/pi-extensions/signalridge/packages/pi-goal` | `git subrepo pull` + gate; see `docs/forks.md` |
| `pi-modes` | `src/pi-extensions/tryinget/packages/pi-modes` | `git subrepo pull` + gate; the second `pi-extensions` lineage |
| `pi-fleet-hooks` | `src/pi-extensions/pi-fleet-hooks` | `git subrepo pull` + gate |
| `unblock` | `src/herdr-plugins/unblock` | `git subrepo pull` + gate, then re-link the CLI if it changed |
| `herdr-dagr` | a herdr plugin | `scripts/herdr-plugins.sh update`, or bump `ref` first |

**`pi update` no longer touches those nine, and that is correct rather than broken.**
Every carried package is a local path into this checkout, rendered from the
`@YELLOWSTONE_REPO@` placeholder at install time, so `pi update --extensions`
reconciles the npm packages and does nothing to them. An upgrade is a
`git subrepo pull <dir>` — one subrepo at a time, so each change is a commit you
can read and revert — followed by the round-trip gate, which proves the pin
matches its remote and that a further pull is a no-op. The `.gitrepo` file is the
record of what each component is synced to.

Upgrading a pinned plugin is a two-step decision, not a command: bump `ref` in
`herdr/plugins.toml`, run `upgrade.sh plugins`, run `doctor.sh`, then commit.
That way the version a machine runs is visible in the repo.

### Rolling back

Nothing here is destructive, so rollback is file-level:

```bash
ls ~/.config/home/.config/herdr/config.toml.bak-yellowstone-*     # previous config
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

## Updating subrepos

This repo carries its components as **git subrepos** under `src/`: each directory has a
`.gitrepo` file recording the remote, the tracked branch and the commit it is synced to. That
file is the record — never hand-edit `commit =` or `parent =`, because the next `pull` will
disagree with you and the failure looks like a corrupted checkout.

**Check what is current** (safe, read-only, network):

```sh
git subrepo status                      # every subrepo
git subrepo status src/pi-extensions/bizzy   # one
```

**Pull one upstream change** — one subrepo at a time, never a sweep, so each change is a commit
you can read and revert on its own:

```sh
git subrepo pull src/herdr-plugins/unblock
```

When the subrepo is already at its tracked commit, `pull` prints `is up to date` and creates no
commit; that is the expected result, not a failure. After **any** pull, run the round-trip gate:

```sh
./test/verify-subrepo-roundtrip.sh
```

It clones the branch into a throwaway tree and asserts that every subrepo resolves, that the
pulled commit matches `.gitrepo`, that the directory has content, and that a `pull` is a no-op —
plus a **count** (`EXPECTED` in the script). If you add or remove a subrepo, that number moves in
the same commit, or the gate fails on purpose.

**Two rules that come from how this fleet works, not from git:**

- **Never `git subrepo push` into a branch a jj working copy is sitting on.** `tooling/` repos are
  jj-colocated and shared with live lanes; cloning is safe, pushing can race a lane mid-edit.
- **Cloning needs a clean tree.** `git subrepo clone` refuses to run while anything is unstaged,
  including someone else's in-progress edit. That refusal is correct: work in your own worktree
  rather than stashing another lane's files.

Adding a subrepo is `git subrepo clone <url> -b <branch> <path>` from the remote — never from a
local checkout, or the `.gitrepo` records a filesystem path and the repo stops being reproducible
on another machine. Then raise `EXPECTED` and run the gate.

## Troubleshooting

| Symptom | First check | Fix |
|---|---|---|
| Sidebar shows no agent state | `herdr integration status` | `herdr integration install <agent>` |
| `$jj_bookmark` row is empty | `herdr plugin list`, then `jj --version` | install `jj`, re-run `scripts/herdr-plugins.sh install` |
| `herdr agent wait` returns early for agy/grok | `herdr-agy.sh probe <agent>` | use `herdr-agy.sh wait`, not `herdr agent wait` |
| pi says a model is unavailable | `pi auth check --provider <p> --json` | fill `~/.pi/agent/secrets/<p>` |
| Requests succeed but the bill jumps | `home/.pi/agent/models.json` `compat` | `sendSessionAffinityHeaders: true` on the gateway |
| Config edit does nothing | `herdr config check` | `herdr server reload-config` |
| A plugin pane will not open | `herdr plugin log list --plugin <id>` | `scripts/herdr-plugins.sh install` |
| A package silently stopped loading | `pi list` vs `settings.json` | `pi update --extensions` |
| Two extensions claim the same tool | startup error naming both | they conflict by design; disable one |
| herdr updated but behaves old | `herdr status` → `server_binary_stale` | reattach (`herdr`); the new client works at once, server features need a server restart — avoid `herdr server stop` while agents are running, it ends their panes |
| `doctor.sh` says a skill is elsewhere | `readlink -f ~/.agents/skills/<s>` | re-run `./install.sh skills`, or leave it if intentional |
| `overlord` tab has no agent | `scripts/overlord.sh status` | re-run `./install.sh overlord`; it starts a pi agent in an agentless tab and renames nothing |
| `npx skills add Apothic-AI/mycord` finds no skills | the skills are at the repo root | clone the repo and run `./scripts/skills-sync.sh install` |
| A test passes but the code you changed is not the code that ran | `./test/run.sh`, not a bare `docker run` | the image bakes the repo at build time; the wrapper mounts your work tree |
| Two `overlord` workspaces exist | `herdr workspace list` | `overlord.sh install` should have prevented it; close the extra one, then re-run to confirm |
| `~/.agent-context` still exists | `ls -ld ~/.agent-context` | it is probably the compatibility symlink from the rename to `~/.overlord`; remove it once no pane uses it |

Two conflicts are worth naming because they look like bugs:

**`pi-pretty-tui` versus `bizzy`.** Both historically claimed the `bash` tool,
and pi fails the whole losing extension. Our fork registers render-only handlers
that compose with whoever owns the tool instead of claiming the name. Installing
the upstream npm release alongside `bizzy` breaks one of them — that is why
`home/.pi/agent/settings.json` points at the fork. See `docs/forks.md`.

**`transient-error-retry` versus pi's retry classifier.** pi retries a fixed set
of error shapes. Some gateways report a dropped stream as `unknown:`, which pi
does not retry, so the run settles and the agent looks dead until nudged. The
extension reclassifies only that family as `server_error:` and delegates the
retry/no-retry decision to `isRetryableAssistantError` so it cannot drift from
pi's own rules. It refuses to touch quota and billing errors.

## Layout

`home/` is the mirror: a path under it is the path it installs to, so the tree
below reads straight down into `$HOME`.

```
AGENTS.md                  this repo's own instructions (a pointer to the global core)
install.sh                 install / reconcile a machine
skills/skills.tsv          which skill comes from which tree, and why
scripts/                   install helpers, plugin sync, doctor, upgrade
docs/                      longer-form notes (trust.example.json lives here)
test/                      the container suite
home/
  AGENTS.md                the fleet core, installed to ~/AGENTS.md
  .config/herdr/
    config.toml            theme, sidebar rows, keybindings        -> ~/.config/herdr/
    plugins.toml           plugin manifest with pinned refs
  .pi/agent/                                                      -> ~/.pi/agent/
    settings.json          owned keys + package declarations
    pi-goal.json           goal extension: tool visibility, no automatic ceiling
    pretty-tui.json        {"mode": "clean"}
    pi-persist.json        trailing reminders (installed once, then kept)
    models.json            provider routing (no secrets; key commands only)
    model-picker.json      picker defaults (installed once, then personal)
    web-search.json        browser-cookie search defaults (same rule)
    pi-auto-compact.json   compaction threshold
    extensions/            hand-written pi extensions
  .agents/skills/                                                 -> ~/.agents/skills/
    herdr/SKILL.md         how agents drive herdr panes (linked)
    hotshot/               bundled: its repo is still empty (linked)
    shared-flyio-build-server/  the Fly build box half (linked)
  .local/bin/herdr-agy.sh  reliable waits for agy/grok agents      -> ~/.local/bin/
  .overlord/                                                      -> ~/.overlord/
    AGENTS.md              orchestrator role + operating rules (installed once)
    README.md              workspace-index template (installed once)
                           its space hosts one pi tab: `overlord`
```

`~/.sysops` is created empty by the `overlord` stage, which is why it is the one
documented destination with no file under `home/`.

## Related

- herdr documentation: https://herdr.dev/docs/ — `herdr --skill` prints the
  agent-facing skill the binary itself ships.
- pi documentation: shipped with the package under
  `<pi install>/docs` — start with `configuration.md`, `models.md`,
  `packages.md` and `extensions.md`.
- The two skill files that describe operating *this* stack rather than
  installing it are `home/.agents/skills/herdr/SKILL.md` (driving panes) and
  `dagr --skill` (publishing a valid run graph, straight from your binary).
