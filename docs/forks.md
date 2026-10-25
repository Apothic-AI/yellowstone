# Forks and vendored components

Yellowstone runs several things that are not upstream releases. This is what
each one is, why it exists, and where the real copy lives.

Two rules apply to all of them:

- **A fork has an upstream commit it descends from.** Nothing here is a
  rewrite; each fork is a small delta maintained to stay mergeable.
- **A vendored component is vendored because it has no public home.** If you
  find one that does, move it to a pinned source instead of keeping a copy.

## pi-pretty-tui — vendored

| | |
|---|---|
| Upstream | [`ykn0309/pi-pretty-tui`](https://github.com/ykn0309/pi-pretty-tui) 0.3.0 |
| Our copy | `plugins/pi-pretty-tui/` |
| License | MIT, © 2026 Kainan Yang (kept in `plugins/pi-pretty-tui/LICENSE`) |
| Installed as | a local path package in `pi/settings.json` |
| Delta notes | `plugins/pi-pretty-tui/LOCAL-PATCHES.md` |

**Why a copy.** pi allows one owner per tool name, and the check that enforces
it runs after every extension loads — so the losing extension fails as a whole
and a `try`/`catch` around registration cannot recover it. pretty-tui used to
register a `bash` tool to render it; `bizzy` owns `bash`. Installing both from
npm breaks one of them.

**The delta.** Every built-in tool pretty-tui renders is now render-only.
`pi.registerToolRenderer` composes instead of competing: resolvers run in load
order and chain to whichever extension owns the tool. Claiming a tool name now
changes only how that tool draws.

**Why vendored rather than forked on GitHub.** The patch is small and lives
next to the config that needs it. Vendoring keeps the load path absolute and
local — `pi` reads the extension straight out of this repository, so a `git
pull` updates it with no reinstall step. If the upstream project starts
accepting compositional renderers, drop the vendored copy and pin the npm
version instead.

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
pi-pretty-tui is vendored.

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
per tool name), so that vendored copy outlives any single upstream release until
the registration model itself changes.
