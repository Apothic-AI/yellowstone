# Forks and bundled components

Yellowstone runs several things that are not upstream releases. This is what
each one is, why it exists, and where the real copy lives.

Two rules apply to all of them:

- **A fork has an upstream commit it descends from.** Nothing here is a
  rewrite; each fork is a small delta maintained to stay mergeable.
- **Nothing is bundled when it has a home.** A copy of somebody else's package or
  skill in this repo is a fork nobody reviews, whose version `pi list` cannot
  report. Bundling is reserved for things with no installable home at all, and
  each one is listed with what would retire it.

## pi-pretty-tui — fork

| | |
|---|---|
| Upstream | [`ykn0309/pi-pretty-tui`](https://github.com/ykn0309/pi-pretty-tui) 0.3.0 |
| Our fork | `Apothic-AI/pi-pretty-tui` |
| License | MIT, © 2026 Kainan Yang (kept in the fork's `LICENSE`) |
| Installed as | `git:github.com/Apothic-AI/pi-pretty-tui@apothic` in `pi/settings.json` |
| Delta notes | the fork's `LOCAL-PATCHES.md` |

**Why a fork.** pi allows exactly one owner per tool name, and the check runs
after every extension loads — so the losing extension fails as a whole and a
`try`/`catch` around registration cannot recover it. pretty-tui used to register
a `bash` tool in order to render it; `bizzy` owns `bash`. Installing both from
npm breaks one of them.

**The delta has grown past the original twenty lines.** It now carries, on
`apothic`:

- render-only tool registration (the original patch, still the reason it exists);
- **selection excludes frame chrome** — copied multi-line selections no longer
  carry `╭ │ ╰`, the fix for upstream issue
  [#2](https://github.com/ykn0309/pi-pretty-tui/issues/2) that this repo filed;
- bubble chrome rebuilt per render instead of memoized, so a resize does not
  leave stale borders.

The selection fix is worth offering upstream: the issue is open and uncommented,
and it is the part of the delta with no fork-specific reason to exist. The
render-only registration is not — that one is structural.

**The original delta is about twenty lines.** Every built-in tool pretty-tui renders is
now render-only: registrations go through `pi.registerToolRenderer`, which
composes across extensions, so resolvers run in load order and chain to whichever
extension owns the tool. Claiming a tool name changes only how it draws; the
owner keeps its schema, description and behaviour.

**Why a fork rather than a copy in this repo.** The patch is small, but it is
code maintenance: when upstream releases a new version the delta has to be
rebased, and it should be offered upstream. Both of those need the fork to live
where the upstream project lives, so it is a git package like any other and
`pi update` reconciles it. Bundling it here would mean this repo owns an
out-of-tree copy of someone else's extension, and the version an agent runs would
be invisible to `pi list`.

**If upstream ever accepts compositional renderers,** delete the fork and pin the
npm release. That is the retirement condition.

## pi-cache-optimizer — fork

| | |
|---|---|
| Upstream | [`jiangge/pi-cache-optimizer`](https://github.com/jiangge/pi-cache-optimizer) |
| Our fork | [`bitnom/pi-cache-optimizer`](https://github.com/bitnom/pi-cache-optimizer) |
| Installed as | `git:github.com/bitnom/pi-cache-optimizer` in `pi/settings.json` |
| Base | upstream 2.10.4, merged forward |

**Why a fork.** It adds provider adapters and cache-key handling for routes that
upstream does not yet model. The delta is tracked on branches in the fork rather
than squashed, so it can be rebased onto a new upstream release and can be sent
back upstream where a change is general enough.

**Update.** `pi update` reconciles the git package against the configured ref.
A local working tree with uncommitted changes is not touched — check
`scripts/upgrade.sh` output, which reports the branch and whether the tree is
dirty.

## bizzy — fork

| | |
|---|---|
| Upstream | [`patty-io/pi-patty-bg-tasks`](https://github.com/patty-io/pi-patty-bg-tasks) |
| Our fork | [`Apothic-AI/bizzy`](https://github.com/Apothic-AI/bizzy) |
| Installed as | `git:github.com/Apothic-AI/bizzy` in `pi/settings.json` |
| Package name | `pi-bizzy-bg-tasks` |

**Why a fork.** Background tasks are the mechanism this whole setup leans on:
long builds, `agent_bg` delegation, monitor streams. The fork ports several
upstream PRs and retargets peer dependencies to the pi versions we run. It is
published under a different package name so it never shadows upstream on npm.

**What it changes in practice.** `bash` auto-backgrounds after a timeout,
`run_in_background` is available explicitly, Ctrl+Shift+B backgrounds the
running command, and long jobs report completion without stalling the turn.
Also the owner of the `bash` tool name — which is the entire reason
pi-pretty-tui is a git package.

## unblock — fork, linked locally

| | |
|---|---|
| Upstream | [`aneym/unblock`](https://github.com/aneym/unblock) |
| Our fork | [`Apothic-AI/unblock`](https://github.com/Apothic-AI/unblock) |
| Herdr plugin | `herdr/plugins.toml` → `link_path` |
| CLI | `npm link` from the same checkout |

**Why a fork.** The queue is where every "only a human can do this" leaves the
agent's context: sign-ins, consents, payments, messages. The fork adds the
authentication and TUI behaviour we need for that to be safe.

**Why linked, not installed.** herdr refuses to install a plugin over a locally
linked one, and the CLI (`unblock`) must be the same version as the pane. Both
come from one checkout, so `scripts/herdr-plugins.sh install` links it and the
checkout supplies the binary.

## pi-goal — fork

| | |
|---|---|
| Upstream | [`signalridge/pi-extensions`](https://github.com/signalridge/pi-extensions), `packages/pi-goal` |
| Our fork | `Apothic-AI/pi-extensions`, branch `apothic` |
| Upstream PR | [signalridge/pi-extensions#77](https://github.com/signalridge/pi-extensions/pull/77) |
| Installed as | a local path: `$PI_EXTENSIONS_APOTHIC/packages/pi-goal` (default `~/Code/pi-extensions-apothic/packages/pi-goal`). `pi/settings.json` carries the `@PI_EXTENSIONS_APOTHIC@` placeholder and `install.sh` resolves it. |
| Delta | one setting, `experimental.notices` |

**Why a fork.** Enabling the experimental ordered-goal queue emits a warning on
**every** session start, and nothing in the settings file, the Settings menu or
the environment could answer it. A warning the reader cannot acknowledge stops
carrying information, and the same notification level carries notices worth
reading — a malformed settings file, a failed tool restore — so the noise
quietly devalues the channel that matters.

**The delta.** `experimental.notices` sits directly beside `experimental.goals`
and defaults to `true`, so an unmodified configuration behaves exactly as
before. It gates that one announcement and nothing else; validation failures,
settings-load warnings and recovery notices still report because they describe
a problem rather than restate a decision the user already made. The Settings
menu exposes it under **Ordered goal queue**, and the change carries tests,
a README section and a changeset.

**Why a local path and not a git source.** `pi` loads a git package from the
repository root, and this repository's root is a private Bun workspace with no
Pi manifest and no `index.ts`. A git install would either fail to load or
discover every extension in the monorepo. The local path points at
the one package directory, and Bun's per-package module links supply its
dependencies (`@narumitw/pi-tui-kit`, `@signalridge/pi-ui`).

**Retirement condition.** Upstream merges #77 and publishes `pi-goal` with
`experimental.notices`. Then delete the fork, drop the local path from
`pi/settings.json`, and pin `npm:@signalridge/pi-goal`. The setting is the only
thing to preserve: `{"experimental": {"goals": true, "notices": false}}` is
valid in the unmodified package once the release lands.

**Do not patch the installed copy instead.** An npm-installed package is owned
by npm, so `pi update` silently reverts any in-place edit of it, and a local
edit leaves the version `pi list` reports describing code that is not running.
A fork costs one checkout and survives updates.

## pi-rooms — fork

| | |
|---|---|
| Upstream | `signalridge/pi-extensions`, `packages/pi-rooms` (rooms/DM extension) |
| Our fork | `Apothic-AI/pi-rooms`, branch `master` |
| Installed as | `git:github.com/Apothic-AI/pi-rooms@master` |

Rooms, DMs and reply-all between pi sessions, file-based with no daemon. State
lives under `~/.pi/agent/rooms`. Identity is the one thing to pin: a session
registers a name, and without `PI_ROOMS_NAME` the name is derived from cwd plus
pid — so three lanes in one directory are indistinguishable and none of them
survive a restart under the same name.

## apothic-todo — fork

| | |
|---|---|
| Upstream | `@arhen/pi-core-todo` (flat/nested todos with statuses and dependencies) |
| Our fork | `Apothic-AI/apothic-todo`, branch `main` |
| Installed as | `git:github.com/Apothic-AI/apothic-todo@main` |
| Package name | still `@arhen/pi-core-todo`, so it replaces the npm package rather than sitting beside it |

## pi-persist — fork

| | |
|---|---|
| Upstream | `signalridge/pi-extensions`, `packages/pi-persist` |
| Our fork | `Apothic-AI/pi-persist`, branch `main` |
| Installed as | `git:github.com/Apothic-AI/pi-persist@main` |
| Config | `pi/pi-persist.json` — the trailing reminders it appends to every request |

A cached prompt section plus a per-request trailing message that other extensions
append to. This is how a reminder reaches the model without editing `AGENTS.md`:
the file is installed only when absent, because it accumulates the operator's own.

## herdr plugins — pinned upstream, not forked

Everything else is an upstream plugin installed at a pinned commit. We do not
patch them; `herdr/plugins.toml` records the ref so an install is reproducible
and an upgrade is a reviewable one-line change.

| Plugin | Why pinned |
|---|---|
| `herdr-dagr` | also provides the `dagr` validator the `dagr-producer` skill depends on — a version bump must not silently change the contract |
| `herdr-context` | builds Rust at install time, so a ref change is a build change |
| `mroth.jj-status` | supplies the sidebar tokens `config.toml` reads |
| `wilbeibi.catchup` | moves live sessions between agents; behaviour changes are risky |
| `herdr-theme-picker` | writes `[theme.custom]` into `config.toml` |
| `ezracerpac.jj-waltz` | optional; lives in a subdirectory of a larger repo |

## Judging whether a fork is still needed

A fork should be deleted when its delta reaches zero. For each one, ask:

1. **Does upstream now do this?** If yes, drop the fork and pin upstream.
2. **Is the delta still load-bearing?** A fork maintained for a conflict that
   no longer exists is a liability — it drifts from upstream for nothing.
3. **Is it documented?** Every fork above records its reason. A fork without a
   stated reason gets removed.

For this setup, the conflict driving `pi-pretty-tui` is structural (one owner
per tool name), so that fork outlives any single upstream release until pi's
registration model itself changes.
