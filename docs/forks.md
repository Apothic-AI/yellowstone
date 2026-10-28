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
| Installed as | `git:github.com/Apothic-AI/pi-pretty-tui` in `pi/settings.json` |
| Delta notes | the fork's `LOCAL-PATCHES.md` |

**Why a fork.** pi allows exactly one owner per tool name, and the check runs
after every extension loads — so the losing extension fails as a whole and a
`try`/`catch` around registration cannot recover it. pretty-tui used to register
a `bash` tool in order to render it; `bizzy` owns `bash`. Installing both from
npm breaks one of them.

**The delta is about twenty lines.** Every built-in tool pretty-tui renders is
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

## Local patches — npm packages we edit in place

`scripts/pi-patches.js` holds the small text patches we apply to packages that
are installed from npm. `scripts/upgrade.sh` runs it straight after
`pi update --all`, because that is the command that reinstalls the files and
throws the patches away.

| Patch | Package | Why | Retired when |
|---|---|---|---|
| `pi-goal-experimental-warning` | `npm:@signalridge/pi-goal` | the experimental ordered-goals notice fires on every session start and pi-goal 1.4.8 exposes no setting to silence it | pi-goal ships a setting that silences the notice |

**Why a patch and not a fork.** The patch is a removed notification, not
behaviour we depend on, and `pi-goal` ships from a monorepo whose root is not a
Pi package — a git install would need the package restructured to the fork's
root. A patch that upstream can retire in one release is smaller than a fork
that has to be rebased forever.

Each entry names the exact text it replaces, so upstream changing that text
makes the patch report itself as stale instead of silently doing nothing. Run
`node scripts/pi-patches.js --check` to see the current state, and `--revert`
to restore the file saved before patching (`*.bak-local-patch`).

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
