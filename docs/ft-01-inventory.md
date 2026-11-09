# FT-01 inventory — what actually has a canonical home

Reconnaissance for [FT-01](../../../Documents/Assistant/Fleet%20TODOs.md): turning this repo into a
git-subrepo monorepo. This page records **measurements**, not the plan. Every row was read with
`git -C <path>` and the commands are given so anyone can re-derive it.

Read on 2026-11-08, after `git-subrepo` 0.4.9 was confirmed installed
(`~/.local/opt/git-subrepo`, `git subrepo version`). There is **no git-subrepo skill on this
machine** — `~/.agents/skills` has none, and neither does `~/.pi/agent/skills`; the procedure
lives in `yellowstone-skill/SKILL.md` under *Updating subrepos*.

**The completion criterion is a command, not a claim here:** `./test/verify-subrepo-roundtrip.sh`
must pass — a fresh clone of this repo, every `src/**/.gitrepo` resolving, every pin equal to its
remote head, every `git subrepo pull` a no-op. Anything on this page that disagrees with the gate
is stale; the gate is the thing that is re-derived every run.

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

## Forked components — the thirteen subrepos

Each is a real delta we maintain, installed from its own repository.

| Component | Upstream | `apothic*` branch | Checked out | jj | Dirty files | Canonical checkout today |
|---|---|---|---|---|---|---|
| pi-pretty-tui | `Apothic-AI/pi-pretty-tui` | `apothic` | `apothic` | yes | 0 | `~/Code/apothic-monorepo-workspace/tooling/pi-pretty-tui` |
| pi-extensions (supplies `packages/pi-goal`) | `Apothic-AI/pi-extensions` | `apothic` | `apothic` | no | 2 | `~/Code/pi-extensions-apothic` |
| bizzy | `Apothic-AI/bizzy` | `apothic-main` | `apothic-main` | yes | 0 | `~/Code/apothic-monorepo-workspace/tooling/bizzy` |
| unblock | `Apothic-AI/unblock` | `apothic-main` | detached `HEAD` | yes | 6 | `~/Code/apothic-monorepo-workspace/tooling/unblock` |
| pi-rooms | `Apothic-AI/pi-rooms` | **none** | `master` | no | 2 | `~/Code/pi-rooms` |
| apothic-todo | `Apothic-AI/apothic-todo` | **none** | `main` | no | 0 | `~/Code/apothic-todo` |
| pi-persist | `Apothic-AI/pi-persist` | **none** | `main` | no | 0 | `~/Code/pi-persist` |
| herdr-voice-linux | `Apothic-AI/herdr-voice-linux` | **none** | `linux-port` | no | 0 | `~/Code/herdr-voice-linux` |
| pi-cache-optimizer | `bitnom/pi-cache-optimizer` | **none** | `feat/opencode-cache-stats` | no | 2 | `~/Code/pi-cache-optimizer` |
| pi-fleet-hooks | `Apothic-AI/pi-fleet-hooks` | **none** | `master` | no | 0 | `~/Code/pi-fleet-hooks` |
| pi-modes (in `packages/`) | `Apothic-AI/pi-extensions-1` | `origin/apothic-main` (no local) | `feat/same-key-append-composition` | no | 54 | `~/Code/apothic-pi-extensions` |
| pi-profile-switch (`pil`) | `Apothic-AI/pi-profile-switch` | **none** | `main` | no | 4 | `~/Code/pi-profile-switch` |
| mycord | `Apothic-AI/mycord` | **none** | `master` | yes | 0 | `~/Code/apothic-monorepo-workspace/tooling/mycord` |

Thirteen repositories. Five carry an `apothic*` branch (`pi-pretty-tui`, `pi-extensions`,
`bizzy`, `unblock`, and `pi-extensions-1` — the last only as `origin/apothic-main`, with no
local branch); the other eight are on `master`, `main`, `linux-port`,
`feat/opencode-cache-stats` and `feat/same-key-append-composition`.

`mycord` was added after the first pass, and it is the case that shows why "is it a package?" is
the wrong test: it installs nothing as a pi package and appears in no pi manifest, but it owns
nine skills the fleet links, so a conversion without it leaves those skills with no checkout to
resolve against. It converts from its remote at `master`; its local checkout is jj-colocated and
detached, which is exactly the state a remote clone sidesteps.

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

## The skills manifest is a third source of truth

This page started by measuring two surfaces — pi packages and herdr plugins — and inferring the
rest. That was wrong, and it is how `mycord` was missed: **the skills are a separate population**,
listed in `skills/skills.tsv`, and a repository can own skills without installing a single pi
package. `readlink ~/.agents/skills/mycord-skill` pointed at a checkout no package list mentions.

| Kind | Rows | What it means |
|---|---|---|
| `repo` | 9 | the skill comes from a repository's checkout, and only falls back to the network when no checkout exists |
| `bundle` | 4 | no installable home exists; carried here and each row says what would retire it |
| `dagr` | 1 | generated at install time by a pinned plugin's binary, so the text cannot drift from the validator |

The nine `repo` rows resolve against two repositories, and **both are now subrepos**: `unblock`
(`src/herdr-plugins/unblock`) and `mycord` (`src/apps/mycord`, eight rows). Before that,
`mycord` was carried nowhere and its eight skills resolved only because a loose checkout existed
under `tooling/`.

**Resolution order is the load-bearing detail, and it is why D12 has a clause about skills.**
`scripts/skills-sync.sh` asks for a checkout before the network, so if it looks in `~/Code` first
then the thirteen subrepos are carried and never used. It now matches `src/**/.gitrepo` — the
recorded `subrepo.remote` — before any loose checkout, which pins each skill to the same commit
as the component it documents. Measured after the change: `unblock` →
`src/herdr-plugins/unblock`, `mycord-skill` → `src/apps/mycord`.

**Why it must read `.gitrepo` and not ask git:** a subrepo directory has no `.git` of its own, so
`git -C src/apps/mycord remote get-url origin` walks up to the *parent* repository and answers
`Apothic-AI/yellowstone`. A resolver that asked git would match every subrepo against yellowstone
and none of them against the repository actually wanted — a plausible-looking, uniformly wrong
answer. `.gitrepo` is the only file in that directory that knows what it is a copy of.

The manifest resolves paths at run time and takes the repo root as an argument, so it does **not**
use the `@YELLOWSTONE_REPO@` placeholder the package list uses. One substitution scheme per repo
is enough; two is how one of them gets missed.

**One gap this surfaced, unchanged since:** `mycord` ships **ten** skill directories
(`ferdium`, `google-voice`, `mycord-discord`, `mycord-email`, `mycord-irc`, `mycord-signal`,
`mycord-skill`, `mycord-slack`, `mycord-telegram`, `mycord-zoom`) and the manifest carries
**eight** of them. `mycord-signal-skill` and `mycord-zoom-skill` have no row, so nothing links
them. Carrying the repository does not install a skill; the row does.

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

`src/apps` holds `pi-profile-switch` and `mycord`. Still candidates, not converted:
`apothic-website-v2` (`Apothic-AI/apothic-website-v2`, jj-colocated, detached) and
`cargo-remote-3000` (`Apothic-AI/cargo-remote-3000`, git, `master`). Neither is installed from
and neither owns a skill, so nothing resolves against them today.

For `src/libs` this sweep found **nothing**: no library is installed from, or forked into, this
fleet's dependency set. The directory is absent and recorded as empty rather than filled to
match the outline. If a later dependency is genuinely shared code, it goes here; matching the
outline is not a reason to invent one.

## Decisions adopted from the lead's record

`~/Documents/Fleet/pi-fleet-model/FT-01-LEAD-DECISIONS.md` is the decision record; this page is
the measurement. Four of its decisions shaped the entries above:

- **D7** — a conversion is not done until a fresh clone plus `git subrepo status` / `pull`
  reproduces the tree. That is the gate this repo will be judged by, so every claim here is
  written to be re-derivable from a clone.
- **D9** — the manifest names the branch the install *resolves to*, and that branch must be
  published. Hence `pi-pretty-tui@test/composer-selection-on-apothic` in `30648ef` rather than
  `@apothic`; the seven commits the test line carries beyond `apothic` are follow-up, not part
  of FT-01.
- **D10** — `home/` is a literal `$HOME` mirror over the five destinations `install.sh` already
  declares, with the instance tree and secrets excluded (see *Explicitly out of scope* above).
- **D11** — `git subrepo push` never targets a branch a jj worktree is sitting on. Cloning is
  safe; pushing races a live lane.

## Drift found while measuring

1. **Was: the running pi disagreed with the committed manifest — fixed in `30648ef`.** The mirror
   declared `git:github.com/Apothic-AI/pi-pretty-tui@apothic` while `pi list` reported the live
   install at `@test/composer-selection-on-apothic`. That is a **stale pin, not drift**: nothing
   had changed underneath the repo, the pin simply named the merge branch while the fleet ran a
   published test branch. Measured for the record: `tooling/pi-pretty-tui` is exactly
   `origin/apothic` (0 ahead, 0 behind), while `~/Code/pi-pretty-tui` is **7 commits ahead** of
   it — three `Test merge: … on apothic` commits folding in composer-selection, selection-fix and
   repeat-paste, plus a tmux live harness — and only the harness (`64e9ddd`) is unpublished. The
   mirror now names the test branch (D9), so what runs and what is declared agree.
2. **Two remotes have two checkouts each**, and a third `pi-extensions` that is not one of them.
   `Apothic-AI/pi-pretty-tui` → `~/Code/pi-pretty-tui` and `tooling/pi-pretty-tui`;
   `Apothic-AI/pi-persist` → `~/Code/pi-persist` and `~/Code/pi-persist-toggle`.
   `~/Code/pi-extensions` looks like a third duplicate and is not one: it is
   `bitnom/pi-extensions`, a fork of `arhen/pi-extensions`, carrying `packages/add`, `core` and
   `pi-toolset` — neither `pi-goal` nor `pi-persist` is in it. No live settings file references
   it (measured: 0 of 43), so it is unused rather than competing. It is not a subrepo, and
   deleting the checkout is hygiene for a later item — not something this issue does to another
   space's repository.
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
6. **The manifest did not reproduce the machine — fixed in `30648ef`.** It declared 17 packages;
   the live install has 25. Diffed with `pi list` (sources only, `(filtered)` stripped):

   | | Count | Which |
   |---|---|---|
   | Live, **not** declared | 9 | `pi-hermes-memory`, `agents-cron`, `pi-beads-extension`, `pi-paster`, `@henryqw/pi-undo`, `pi-double-paste`, `@xynogen/pix-voice`, and the two local checkouts `~/Code/pi-fleet-hooks`, `~/Code/apothic-pi-extensions/packages/pi-modes` |
   | Declared, **not** live | 1 | `npm:@howaboua/pi-subdir-agents` |
   | Declared and live, **different ref** | 2 | `bizzy` (declared bare, live `@apothic-main`), `pi-pretty-tui` (declared `@apothic`, live `@test/composer-selection-on-apothic`) |
   | Apparent only | 1 | `…/packages/pi-goal` — declared correctly as a placeholder, so it reads as undeclared only when the template is compared against rendered paths |

   The undeclared npm set is not incidental: memory (`pi-hermes-memory`), scheduling
   (`agents-cron`) and beads (`pi-beads-extension`) are the fleet's own operating surface. A
   machine built from this repo would boot without them and lose exactly the machinery that
   tracks work. `30648ef` adds the nine, drops the stale one, and points both ref mismatches at
   the branch the install resolves to; the two new checkouts resolve through placeholders, so a
   moved checkout is an environment variable rather than an edit. Verified both directions:
   merging the template into a copy of the live settings adds nothing and keeps every existing
   source, and merging it into an empty settings resolves all 25.

   `pi-profile-switch` is a separate gap and cannot be fixed here: it is not a pi package, so no
   package list can carry it. It is the `pil` launcher every lane is started by, and it appears
   nowhere in this repo. And pi-modes lives in `Apothic-AI/pi-extensions-1`, a **different
   repository** from `Apothic-AI/pi-extensions`, with a different root commit — two lineages,
   both canonical.
7. **One commit is stranded, but not where it first appeared to be.** `herdr-voice-linux`'s
   tracked branch `linux-port` is exactly `origin/linux-port` (0 ahead, 0 behind). The commit
   `2715621 feat: draw the floating orb on x11 with cairo` lives **only** on the local branch
   `linux-orb`, and on no remote branch at all (`git branch -r --contains 2715621` is empty). So
   a `-b linux-port` subrepo is correct and loses nothing; the stray commit is a separate loose
   end for that fork's owner. `pi-rooms` likewise only looks bad: 12 commits are "unpushed" but
   all sit on `task/*` sibling worktrees belonging to live pi-rooms lanes, and `master` is level
   with `origin/master` (`efe5896`).
8. **The herdr plugin manifest is short one plugin, and it is the one that runs unpublished
   code.** `herdr/plugins.toml` declares 14 plugins; `~/.config/herdr/plugins.json` has 15. The
   missing one is `pi-rooms`, which is the rooms popup, and it is *link*-installed from
   `~/Code/pi-rooms/.worktrees/c2/plugin` — the `task/c2` worktree, head `856a8fb`,
   which is on no remote. Two consequences: a machine built from this repo has no rooms popup
   at all, and the one that runs here is the only plugin in the fleet executing a branch that
   was never published. Note the two pi-rooms *surfaces* have different sources — the pi
   extension runs from the package cache at `master`/`efe5896` (published), the herdr plugin
   from `task/c2` (not). This is the same class of defect as drift 6, on the herdr side, and it
   needs a decision rather than a copy: declare the popup at whatever ref we intend, and land
   `task/c2` on `master` before declaring it.

## Decisions this inventory does not make

1. Which checkout is canonical for the two duplicated remotes, and whether the losers are
   deleted or left alone.
2. What to do about the eight repos with no `apothic*` branch. For the four that are forks
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
