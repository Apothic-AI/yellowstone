# FT-01 inventory — what actually has a canonical home

Reconnaissance for [FT-01](../../../Documents/Assistant/Fleet%20TODOs.md): turning this repo into a
git-subrepo monorepo. This page records **measurements**, not the plan. Every row was read with
`git -C <path>` and the commands are given so anyone can re-derive it.

Read on 2026-11-08, after `git-subrepo` 0.4.9 was confirmed installed
(`~/.local/opt/git-subrepo`, `git subrepo version`). There is **no git-subrepo skill on this
machine** — `~/.agents/skills` has none, and neither does `~/.pi/agent/skills`.

## Reproduce

```bash
# declared pi packages and the refs they resolve to
python3 -c 'import json;print(json.load(open("pi/settings.json"))["packages"])'
pi list | grep -E '^(  git:|  /)'          # what is *running*, not what is declared

# declared herdr plugins
grep -E '^id|^source|^ref' herdr/plugins.toml

# per-repo state
git -C <path> remote get-url origin
git -C <path> branch -a | grep -E 'apothic(-main|-master)?$'
git -C <path> status --porcelain | wc -l
test -d <path>/.jj && echo jj
```

## Forked components — these are the subrepo candidates

Each is a real delta we maintain, installed from its own repository.

| Component | Upstream | `apothic*` branch | Checked out | jj | Dirty files | Canonical checkout today |
|---|---|---|---|---|---|---|
| pi-pretty-tui | `Apothic-AI/pi-pretty-tui` | `apothic` | `apothic` | yes | 0 | `/home/bitnom/Code/apothic-monorepo-workspace/tooling/pi-pretty-tui` |
| pi-extensions (supplies `packages/pi-goal`) | `Apothic-AI/pi-extensions` | `apothic` | `apothic` | no | 2 | `/home/bitnom/Code/pi-extensions-apothic` |
| bizzy | `Apothic-AI/bizzy` | `apothic-main` | `apothic-main` | yes | 0 | `/home/bitnom/Code/apothic-monorepo-workspace/tooling/bizzy` |
| unblock | `Apothic-AI/unblock` | `apothic-main` | detached `HEAD` | yes | 6 | `/home/bitnom/Code/apothic-monorepo-workspace/tooling/unblock` |
| pi-rooms | `Apothic-AI/pi-rooms` | **none** | `master` | no | 2 | `/home/bitnom/Code/pi-rooms` |
| apothic-todo | `Apothic-AI/apothic-todo` | **none** | `main` | no | 0 | `/home/bitnom/Code/apothic-todo` |
| pi-persist | `Apothic-AI/pi-persist` | **none** | `main` | no | 0 | `/home/bitnom/Code/pi-persist` |
| herdr-voice-linux | `Apothic-AI/herdr-voice-linux` | **none** | `linux-port` | no | 0 | `/home/bitnom/Code/herdr-voice-linux` |
| pi-cache-optimizer | `bitnom/pi-cache-optimizer` | **none** | `feat/opencode-cache-stats` | no | 2 | `/home/bitnom/Code/pi-cache-optimizer` |
| pi-fleet-hooks | `Apothic-AI/pi-fleet-hooks` | **none** | `master` | no | 0 | `/home/bitnom/Code/pi-fleet-hooks` |
| pi-modes (in `packages/`) | `Apothic-AI/pi-extensions-1` | `origin/apothic-main` (no local) | `feat/same-key-append-composition` | no | 54 | `/home/bitnom/Code/apothic-pi-extensions` |
| pi-profile-switch (`pil`) | `Apothic-AI/pi-profile-switch` | **none** | `main` | no | 4 | `/home/bitnom/Code/pi-profile-switch` |

Twelve repositories. Five carry an `apothic*` branch (`pi-pretty-tui`, `pi-extensions`,
`bizzy`, `unblock`, and `pi-extensions-1` — the last only as `origin/apothic-main`, with no
local branch); the other seven are on `master`, `main`, `linux-port`,
`feat/opencode-cache-stats` and `feat/same-key-append-composition`.

The last three rows are **installed but not declared**, so a sweep of `pi/settings.json` alone
misses them: `pi-fleet-hooks` (absolute path), `pi-modes` (local path into
`pi-extensions-1/packages/`), and `pi-profile-switch` (not a pi package at all — it is the
`pil` launcher every lane is started by, which is why no install record names it).

### Which of these is a fork, and which is an original

FT-01 assumes every canonical repo is a fork with an `apothic*` merge branch. Measured, the rule
needs two signals, because neither is sufficient alone:

| Signal | Reads from | Fails when |
|---|---|---|
| A configured `upstream` remote | `git remote get-url upstream` | `pi-pretty-tui` and `bizzy` are forks with **no** `upstream` remote |
| `docs/forks.md` says it is a fork | the doc | it says nothing about `pi-fleet-hooks`, `mycord`, `herdr-voice-linux`, `pi-profile-switch` |

Present `upstream` remotes: `pi-extensions-apothic` (signalridge), `pi-extensions` (arhen),
`unblock` (aneym), `pi-cache-optimizer` (jiangge), `apothic-pi-extensions` (tryingET).
Documented forks with no `upstream` remote: `pi-pretty-tui`, `bizzy`, `pi-rooms`, `apothic-todo`,
`pi-persist`. So **`pi-rooms`, `apothic-todo` and `pi-persist` are forks** whose merge branch was
simply never named `apothic*` — they are not originals that need no merge branch. Recorded forks
have a delta to rebase onto an upstream release even while their branch is called `master`.

One repo is unclassified: `pi-profile-switch` has no `upstream` remote and no entry in
`docs/forks.md`, so whether it is a fork of an upstream launcher or our own original cannot be
read off the machine. Its branch outcome is `main` either way; the label stays open.

## Not forks — they stay declared refs, not subrepos

- **Twelve pinned upstream herdr plugins** in `herdr/plugins.toml` (`herdr-bar`,
  `ray.plugin-manager`, `herdr-dagr`, `codeforbreakfast.beady-eye`, `mroth.jj-status`,
  `herdr-context`, `wilbeibi.catchup`, `vsh.stash`, `ntindle.herdr-resurrect`,
  `herdr-theme-picker`, `ezracerpac.jj-waltz`, `abhishekrana.dictate`). We do not patch them;
  a pinned commit *is* the record.
- **Ten npm pi packages** (`pi-web-access`, `pi-auto-compact`, `@spences10/pi-themes`,
  `pi-nested-skills`, `@narumitw/pi-btw`, `pi-copy-message`, `@timmyjl12/pi-model-picker`,
  `@arhen/pi-core-tps-stats`, `@99percentpeople/pi-thinking-fold`,
  `@howaboua/pi-subdir-agents`). Upstream releases; nothing of ours to carry.
- **Two local herdr plugins** (`unblock`, `herdr-voice`) are `link`-installed from the fork
  checkouts above, so they are covered by those rows.
- **Hand-written code that belongs to the superproject**: `pi/extensions/nonblock.ts`,
  `pi/extensions/transient-error-retry.ts`, `scripts/`, `herdr/scripts/`, `skills/`,
  `fleet/AGENTS.md`, and the config files (`config.toml`, `plugins.toml`, `models.json`,
  `settings.json`, `pi/*.json`).

## Explicitly out of scope

- **`pi-ghost-text-x`** (`Apothic-AI/pi-ghost-text-x`, branch `apothic-main`) is an org fork
  that appears in neither `pi/settings.json` nor `herdr/plugins.toml` — `grep -r` over both
  finds nothing. Unused; not a subrepo.
- **Generated and secret-bearing state** never goes in: `~/.pi/agent/secrets/`, and the
  profile-switch instance tree `~/.pi-profile-switch/instances/<id>/` (auth, sessions, npm
  cache, modes). `$HOME/.pi/agent` is a real directory, not a symlink to it, and the two
  `settings.json` files already differ (md5 `25d27c7d…` vs `b83f31e4…`), so `home/.pi/agent/`
  must be documented as *the path pi uses when no profile is selected*.

## `src/apps` and `src/libs`

Candidates that exist, are clean, and could be members of `src/apps`:
`mycord` (`Apothic-AI/mycord`, jj-colocated, detached), `apothic-website-v2`
(`Apothic-AI/apothic-website-v2`, jj-colocated, detached), `cargo-remote-3000`
(`Apothic-AI/cargo-remote-3000`, git, `master`).

For `src/libs` this sweep found **nothing**: no library is installed from, or forked into, this
fleet's dependency set. The directory should be recorded as empty rather than filled to match the
outline.

## Drift found while measuring

1. **The running pi disagrees with the committed manifest, and runs unreleased code.**
   `pi/settings.json` declares `git:github.com/Apothic-AI/pi-pretty-tui@apothic`; `pi list`
   reports the live install at `@test/composer-selection-on-apothic`. Measured: the
   `tooling/pi-pretty-tui` checkout is exactly `origin/apothic` (0 ahead, 0 behind), while
   `~/Code/pi-pretty-tui` is **7 commits ahead** of it. Those 7 are a merge rehearsal — three
   `Test merge: … on apothic` commits folding in composer-selection, selection-fix and
   repeat-paste, plus `Add a tmux-based live harness for composer selection`. So the shape is
   not "two candidates, pick one": the test line is *ahead* of the published branch and the
   fleet runs it. Either that work lands on `apothic`, or the install is rolled back to it.
   Both are decisions; neither is a copy.
2. **Three remotes have two checkouts each.**
   `Apothic-AI/pi-pretty-tui` → `~/Code/pi-pretty-tui` and `tooling/pi-pretty-tui`;
   `Apothic-AI/pi-persist` → `~/Code/pi-persist` and `~/Code/pi-persist-toggle`;
   pi-extensions exists as `~/Code/pi-extensions` (**`bitnom/pi-extensions.git`**) and
   `~/Code/pi-extensions-apothic` (**`Apothic-AI/pi-extensions`**, the one
   `pi/settings.json` resolves `@PI_EXTENSIONS_APOTHIC@` to).
3. **Uncommitted work sits in six of the twelve.** `unblock` (6 files, including a new
   `test/weekly-keep.test.js`), `apothic-pi-extensions` (54 files — and it is a live lane's
   workspace), `pi-rooms` (2: `.pi/`, `AGENTS.md`), `pi-extensions-apothic` (untracked `.pi/`),
   `pi-cache-optimizer` (2), `pi-profile-switch` (4: `AGENTS.md`, `.pi/launch.env`, `.pi/modes/`,
   one openspec change dir). `git subrepo` will not take a dirty tree.
4. **Four of the twelve are jj-managed** (`tooling/pi-pretty-tui`, `tooling/bizzy`,
   `tooling/unblock`, `tooling/mycord`), and each sits at a detached `HEAD` in jj's working copy
   — so there is no branch name to read out of them. Cloning them into a git-only superproject is fine — subrepo records
   plain git refs — but any push from yellowstone lands on the same `apothic*` branch jj is
   working in, so those two worktrees must not be edited concurrently.
5. `yellowstone` itself is clean except `.pi/launch.env` (`PI_PROFILE=fleet` → `leader`). No
   stashes, no extra worktrees, nothing a restructure could destroy.
6. **The manifest does not reproduce the machine.** `pi/settings.json` declares 17 packages; the
   live install has 25. Diffed with `pi list` (sources only, `(filtered)` stripped):

   | | Count | Which |
   |---|---|---|
   | Live, **not** declared | 10 | `pi-hermes-memory`, `agents-cron`, `pi-beads-extension`, `pi-paster`, `@henryqw/pi-undo`, `pi-double-paste`, `@xynogen/pix-voice`, plus the three local paths `~/Code/pi-fleet-hooks`, `~/Code/pi-extensions-apothic/packages/pi-goal`, `~/Code/apothic-pi-extensions/packages/pi-modes` |
   | Declared, **not** live | 1 | `npm:@howaboua/pi-subdir-agents` |
   | Declared and live, **different ref** | 2 | `bizzy` (declared bare, live `@apothic-main`), `pi-pretty-tui` (declared `@apothic`, live `@test/composer-selection-on-apothic`) |

   The undeclared npm set is not incidental: memory (`pi-hermes-memory`), scheduling
   (`agents-cron`) and beads (`pi-beads-extension`) are the fleet's own operating surface. A
   machine built from this repo would boot without them and lose exactly the machinery that
   tracks work. So FT-01 is not only a re-arrangement: **the manifest has to be made honest
   before it can claim to reproduce anything.** `pi-profile-switch` appears nowhere in the repo
   at all — it is the `pil` launcher every lane is started by, which is why no install record
   names it. And pi-modes lives in `Apothic-AI/pi-extensions-1`, a **different repository** from
   `Apothic-AI/pi-extensions`, with a different root commit — two lineages, both canonical.
7. **One commit is stranded, but not where it first appeared to be.** `herdr-voice-linux`'s
   tracked branch `linux-port` is exactly `origin/linux-port` (0 ahead, 0 behind). The commit
   `2715621 feat: draw the floating orb on x11 with cairo` lives **only** on the local branch
   `linux-orb`, and on no remote branch at all (`git branch -r --contains 2715621` is empty). So
   a `-b linux-port` subrepo is correct and loses nothing; the stray commit is a separate loose
   end for that fork's owner. `pi-rooms` likewise only looks bad: 12 commits are "unpushed" but
   all sit on `task/*` sibling worktrees belonging to live pi-rooms lanes, and `master` is level
   with `origin/master` (`efe5896`).

## Decisions this inventory does not make

1. Which checkout is canonical for the two duplicated remotes, and whether the losers are
   deleted or left alone.
2. What to do about the seven repos with no `apothic*` branch. For the four that are forks
   (`pi-rooms`, `apothic-todo`, `pi-persist`, `pi-cache-optimizer`) the choice is create the
   merge branch, or track `master`/`main`/`feat/…` as-is. For `pi-fleet-hooks`,
   `pi-profile-switch`, `mycord` and `herdr-voice-linux` there is no upstream to merge from, so
   their default branch is the only sensible ref.
3. Whether pinned upstream herdr plugins get subrepos too, or stay pinned refs. They are not
   forks, and a subrepo of an unmodified upstream is a clone with no delta to review.
4. What `home/` mirrors: only yellowstone-owned configs, or also the generated state under
   `~/.pi-profile-switch/instances/<id>/` that `install.sh` writes.
5. Whether `pi-pretty-tui`'s test branch is adopted (fix the manifest) or abandoned (fix the
   install).
