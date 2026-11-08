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
| pi-modes (in `packages/`) | `Apothic-AI/pi-extensions-1` | **none** | `feat/same-key-append-composition` | no | 54 | `/home/bitnom/Code/apothic-pi-extensions` |

Eleven repositories. Only four carry a branch named the way FT-01 expects
(`apothic-master` / `apothic-main` / `apothic`); the other seven are on `master`, `main`,
`linux-port`, `feat/opencode-cache-stats` and `feat/same-key-append-composition`, and have
**no** `apothic*` branch at all.

The last two rows are **installed but not declared** — see drift 6. They were found by reading
`pi list`, not `pi/settings.json`, which is why the first pass of this page missed them.

### Which of these is a fork, and which is an original

FT-01 assumes every canonical repo is a fork with an `apothic*` merge branch. Measured, the rule
needs two signals, because neither is sufficient alone:

| Signal | Reads from | Fails when |
|---|---|---|
| A configured `upstream` remote | `git remote get-url upstream` | `pi-pretty-tui` and `bizzy` are forks with **no** `upstream` remote |
| `docs/forks.md` says it is a fork | the doc | it says nothing about `pi-fleet-hooks`, `mycord`, `herdr-voice-linux` |

Present `upstream` remotes: `pi-extensions-apothic` (signalridge), `pi-extensions` (arhen),
`unblock` (aneym), `pi-cache-optimizer` (jiangge), `apothic-pi-extensions` (tryingET).
Documented forks with no `upstream` remote: `pi-pretty-tui`, `bizzy`, `pi-rooms`, `apothic-todo`,
`pi-persist`. So **`pi-rooms`, `apothic-todo` and `pi-persist` are forks** whose merge branch was
simply never named `apothic*` — they are not originals that need no merge branch.

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

## Drift found while measuring

1. **The running pi disagrees with the committed manifest.** `pi/settings.json` declares
   `git:github.com/Apothic-AI/pi-pretty-tui@apothic`; `pi list` reports the live install at
   `@test/composer-selection-on-apothic`. The `~/Code/pi-pretty-tui` checkout is on that same
   test branch (last commit 2026-11-01) and the `tooling/pi-pretty-tui` checkout is on `apothic`
   (last commit 2026-10-27). Nothing in the repo says which of the two is canonical.
2. **Three remotes have two checkouts each.**
   `Apothic-AI/pi-pretty-tui` → `~/Code/pi-pretty-tui` and `tooling/pi-pretty-tui`;
   `Apothic-AI/pi-persist` → `~/Code/pi-persist` and `~/Code/pi-persist-toggle`;
   pi-extensions exists as `~/Code/pi-extensions` (**`bitnom/pi-extensions.git`**) and
   `~/Code/pi-extensions-apothic` (**`Apothic-AI/pi-extensions`**, the one
   `pi/settings.json` resolves `@PI_EXTENSIONS_APOTHIC@` to).
3. **Uncommitted work sits in five of the eleven.** `unblock` (6 files, including a new
   `test/weekly-keep.test.js`), `apothic-pi-extensions` (54 files — and it is a live lane's
   workspace), `pi-rooms` (2: `.pi/`, `AGENTS.md`), `pi-extensions-apothic` (untracked `.pi/`),
   `pi-cache-optimizer` (2). `git subrepo` will not take a dirty tree.
4. **Three of the eleven are jj-managed** (`tooling/pi-pretty-tui`, `tooling/bizzy`,
   `tooling/unblock`), and all three sit at a detached `HEAD` in jj's working copy — so there is
   no branch name to read out of them. `mycord` is jj-managed too, and detached. Cloning them into a git-only superproject is fine — subrepo records
   plain git refs — but any push from yellowstone lands on the same `apothic*` branch jj is
   working in, so those two worktrees must not be edited concurrently.
5. `yellowstone` itself is clean except `.pi/launch.env` (`PI_PROFILE=fleet` → `leader`). No
   stashes, no extra worktrees, nothing a restructure could destroy.
6. **The manifest is two packages short of the install.** `pi list` runs
   `/home/bitnom/Code/pi-fleet-hooks` and `/home/bitnom/Code/apothic-pi-extensions/packages/pi-modes`;
   neither appears in `pi/settings.json`. A machine built from this repo would have neither fleet
   hooks nor pi-modes. Note that pi-modes lives in `Apothic-AI/pi-extensions-1`, a **different
   repository** from `Apothic-AI/pi-extensions` — two pi-extensions repos, both canonical.
7. **One local-only commit exists.** `herdr-voice-linux` has an unpushed commit on `linux-port`
   (`2715621 feat: draw the floating orb on x11 with cairo`). Every other fork's checked-out
   branch is in sync with its remote. `pi-rooms` looks worse than it is: 12 commits are
   "unpushed" but all of them sit on `task/*` sibling worktree branches belonging to live
   pi-rooms lanes; `master` itself is level with `origin/master`.

## Decisions this inventory does not make

1. Which checkout is canonical for the two duplicated remotes, and whether the losers are
   deleted or left alone.
2. What to do about the seven repos with no `apothic*` branch. For the four that are forks
   (`pi-rooms`, `apothic-todo`, `pi-persist`, `pi-cache-optimizer`) the choice is create the
   merge branch, or track `master`/`main`/`feat/…` as-is. For `pi-fleet-hooks`, `mycord` and
   `herdr-voice-linux` there is no upstream to merge from, so their default branch is the only
   sensible ref.
3. Whether pinned upstream herdr plugins get subrepos too, or stay pinned refs. They are not
   forks, and a subrepo of an unmodified upstream is a clone with no delta to review.
4. What `home/` mirrors: only yellowstone-owned configs, or also the generated state under
   `~/.pi-profile-switch/instances/<id>/` that `install.sh` writes.
5. Whether `pi-pretty-tui`'s test branch is adopted (fix the manifest) or abandoned (fix the
   install).
