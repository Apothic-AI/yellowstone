# Fleet migration to yellowstone — components and lanes

**Directive (operator, 2026-11-09):** *"We need to migrate all fleet components and lanes to
yellowstone."* And the boundary that makes it tractable: *"`~/Code` contains far more than our fleet.
`~/Code` will always be full of many non-fleet-related projects. `~/Code` will never be 'empty and
deletable'."* Plus: *"several of our herdr lanes are not fleet components."*

So this is **not** a `~/Code` cleanup. It is: everything the *fleet* runs on comes from
`~/Code/yellowstone`; everything else in `~/Code` stays exactly where it is, permanently.

## 1. Scope — what counts as a fleet component

A thing is a fleet component if the fleet's own machinery loads, executes or reads it:

| Kind | Where it lives now | Fleet-tracked? |
|---|---|---|
| pi extensions / plugins / apps (13) | `src/**` subrepos | **yes — done** |
| fleet tooling (`~/.overlord/tools`, `bin`, `skills`) | `$HOME` | **yes — migrated in this change** |
| skills (`~/.agents/skills` ← `skills/skills.tsv`) | `home/.agents/skills` + links | **yes — done** |
| fleet instruction core + per-space roles | `home/AGENTS.md`, `home/.pi/agent`, space `.pi/modes` | **yes — done** |
| config the installer writes | `home/**` | **yes — done** |
| project spaces (lynx, neti, ds, dxdb, lfm3, synomone, vpn2proxy, subtoken, omebian, herdr, sibyl, …) | their own `~/Code` repos | **no — not fleet components** |
| `~/Code` non-fleet projects | their own repos | **no — never in scope** |

The test is not "is it in `~/Code`" — most of `~/Code` never moves. The test is "does the fleet
load or execute it". A lane is a *fleet* lane when its subject is a fleet component; a lane whose
subject is a product (a website, a scraper, a model runner) keeps its own repo and its own cwd.

## 2. Components

**The 13 subrepos are complete** for everything pi loads: 9 `pi-extensions`, 2 `herdr-plugins`,
2 `apps`, with `EXPECTED=13` in the round-trip gate. Every installed package and every skill the
profiles name resolves inside the checkout.

**The tooling gap is now closed.** Before this change the mirror carried 2 files under
`home/.overlord/` (`AGENTS.md`, `README.md`) while **83 fleet files** lived in `$HOME` with no path
into the repo:

```
~/.overlord/tools     51 scripts (760K)   reload-fleet, proc-find, pane-signal,
                                          broadcast-to-fleet, leader-board, watch-leaders, …
~/.overlord/bin        3 executables      bd, pil (the launcher every lane starts from), pi-session-rescue
~/.overlord/skills     1 skill            overlord-operations (reachable today only via a hand-made symlink)
~/.sysops             beads state + note   generated, NOT shipped — but its AGENTS.md and .pi/
                                           ARE shipped (authored 2026-11-09)
```

`home/` now carries 82 files, up from 25. Deliberately **not** mirrored: `pi-modes-cli.secret`
(a credential), `rooms-names.json` (mutable lane pins — generated state, not content),
`__pycache__`, and `*.bak*` drift artifacts.

### Two defects the migration exposed

1. **Two tools hardcoded a `~/Code` checkout.** `mode-composed-digest.mjs` imported
   `…/Code/apothic-pi-extensions/packages/pi-modes/src/modes.ts`, and `reconcile-mode.py` set
   `PKG = Path.home()/"Code"/"apothic-pi-extensions"/"packages"/"pi-modes"`. Both break the moment
   that clone moves — which is what this migration does. Both now resolve the package the way pi
   does: `PI_MODES_PKG`, else the installed package list in `~/.pi/agent/settings.json`, else the
   monorepo path. Verified: `mode-composed-digest.mjs` now emits a real digest from the in-tree copy.
2. **The monorepo copies had no `node_modules`.** pi loads extension *source* fine, but a standalone
   tool that imports package source needs the package's peer deps resolvable. `pi-modes` had 284M of
   them in the clone and none in `src/`. Installed (`npm ci`, lockfile untouched, gitignored):
   `130 packages, 283M`. **This is a prerequisite for retiring any clone**: a migrated tree that
   cannot run its own tooling is a copy, not a home.

### The guard that missed its own case

The first version of the new mirror check grepped only `/home/<user>/Code/…` literals. The Python
`Path.home()/"Code"/"apothic-pi-extensions"` form slipped through — the check passed while a real
`~/Code` dependency was still there. It now tests both shapes (literal path and quoted join),
excluding `_relaunch-lane-monorepo.sh_`, which names the pattern on purpose because it *measures*
loose references. Had the guard not been written before the fix, the fix would have looked complete.

## 3. Lanes — what actually has to move

Measured from `/proc/<pid>/cwd` + `PI_CODING_AGENT_DIR` (the only working lane→instance join;
`herdr agent list`'s `agent_session` points at `~/.pi/agent/sessions` and finds nothing).

### Fleet lanes whose cwd is a clone of a fleet subrepo — these move

| lane | cwd today | subrepo | pin vs checkout | dirty |
|---|---|---|---|---|
| `pi-modes-leader` | `~/Code/apothic-pi-extensions` | `pi-extensions/tryinget` | MATCH `295b3136` | **54** |
| `pi-rooms-leader` | `~/Code/pi-rooms` | `pi-extensions/pi-rooms` | MATCH `efe58960` | 2 |
| `pi-rooms` workers ×6 (`c2`, `client`, `slice1`, `web`, `lock-boot`, `pi-rooms-ft24`) | `~/Code/pi-rooms/.worktrees/*` | same | MATCH | — |
| `herdr-voice-leader` | `~/Code/herdr-voice-linux` | `herdr-plugins/herdr-voice-linux` | MATCH `5c3cf3f7` | 0 |
| `mycord-leader` | `…/apothic-monorepo-workspace/tooling/mycord` | `apps/mycord` | MATCH `082556ff` | 0 |
| `pi-pretty-tui-leader` | `…/tooling/pi-pretty-tui` | `pi-extensions/pi-pretty-tui` | **DIVERGED** `1b1976e2` vs `ec6df5eb` | 0 |
| `unblock-leader` | `…/tooling/unblock` | `herdr-plugins/unblock` | **AHEAD 3** `f76a657d` vs `5887cefa` | 6 |

### Already home

`yellowstone-leader`, `yellowstone-worker` — cwd inside the monorepo. No action.

### Fleet management lanes — different question, not a cwd move

`self-improvement-leader` (`~/Documents/Fleet`), `overlord` (`~/.overlord`), `comms-leader`,
`sysops-leader`, `assistant-leader`: their cwd is a *documents/state* directory, not a code
checkout. They already load packages from the monorepo (canonical settings). Whether their
documents belong in the repo is a separate decision, not blocked by anything here.

### Not ours to move

`lynx-leader`, `neti-leader`, `ds-leader`, `dxdb-leader`, `lfm3-leader`, `snomone-leader`,
`vpn2proxy-leader`, `subtoken-leader`, `omebian-leader`, `herdr-leader`, `sibyl-leader`,
`billion-context-leader`, `apothic-web-leader`, `droid`, `starla-leader`, `pi-auto-translate-dev`,
`ft-01-proof`: product/project lanes. They stay in their own repos.

## 4. Order of operations

1. **Preserve before moving.** Six lanes carry uncommitted work; `pi-modes-leader`'s 54 entries are
   almost entirely `AGENTS.md` + `.pi/` — **space scaffolding**, not product code. That is the
   population a cwd move destroys, and it is mine to place. Nothing moves until each tree's
   scaffolding is either committed or copied to the target worktree.
2. **Resolve the two divergences deliberately.** `pi-pretty-tui` checkout ≠ pin, and `unblock` is 3
   commits ahead of its pin. Moving the lane without deciding which commit is authoritative would
   silently change what the fleet installs.
3. **One space, end to end, then the rest.** Create the worktree, start one lane there, confirm the
   mode composition and skills resolve, *then* roll out. Never migrate all six on the strength of a
   layout that has not run a lane.
4. **Reload/relaunch is overlord's.** Workspace ops — creating spaces, launches, restarts — are
   overlord's; the scaffold and the target layout are mine. Hand over a per-space list, not a
   general instruction.
5. **Delete only after the boundary.** A `~/Code` fleet checkout is deletable when no lane's cwd,
   no instance manifest, and no tool names it.

## 5. Space scaffolding — where it goes, and why not in the component repo

Measured on `mycord` (clean tree, pin match, no worker lanes) as the pilot:

```
~/Code/apothic-monorepo-workspace/tooling/mycord/AGENTS.md   46 lines, UNTRACKED
~/Code/apothic-monorepo-workspace/tooling/mycord/.pi/launch.env   excluded via .git/info/exclude
```

So a space's role contract is **local state today** — untracked in the component clone, invisible to
git, and therefore absent from any fresh machine. That is the same class of gap as the tooling: the
space works because a file happens to be on this disk.

**The obvious fix is the wrong one.** pi finds `AGENTS.md` by walking *up* from cwd, so a lane whose
cwd is `src/apps/mycord` would load a file at `src/apps/mycord/AGENTS.md` — which means committing
the fleet's internal role contract into **mycord's published repo**. `git subrepo push` would
publish it upstream. A fleet-internal contract does not belong in a component other fleets install.

**Decision — a `spaces/` layer in yellowstone, installed into the worktree:**

```
spaces/<space>/AGENTS.md          tracked in yellowstone  (mine: space scaffolding)
spaces/<space>/.pi/modes/*.json   tracked in yellowstone
spaces/<space>/.pi/launch.env     tracked (this space's launch line, as home/.pi/launch.env is)
```

A scaffolding step copies those into the space's worktree at the location pi reads (the component
dir), and the installed copies are gitignored so the worktree stays clean. That is the `home/`
pattern — *tracked source, installed by policy, never hand-edited in place* — applied to spaces
instead of `$HOME`. It keeps fleet contracts out of published components, makes a space reproducible
from the repo, and needs no change to the subrepos at all.

Pilot target: a worktree at `~/Code/yellowstone-wt/space-mycord` (branch `space/mycord`, created from
`master`), cwd `src/apps/mycord`, scaffolding installed from `spaces/mycord/`. Launch and verification
of the composed system record are **overlord's** (workspace ops); the scaffolding is mine.

## 5b. The two pin divergences — decisions on evidence

**`unblock` — nothing was ever at risk; the pin stays where it is.** An earlier version of this
section said the lane's three commits ahead of the pin might exist "only in that clone" and had to be
carried in first. **That was wrong, and it was written on a guess rather than a measurement.**
Measured now:

```
f76a657  Kill the TUI harness child on failure, and escalate to SIGKILL   on origin/tui-verify-harness
565c525  Drive the TUI verification scripts from events, not sleeps       on origin/tui-verify-harness
e88361d  Send with s and dismiss with x x, leaving Enter alone            on origin/tui-dismiss-send-key
```

All three are on **remote branches**, reachable from origin. The detached HEAD is the lane sitting on
unmerged feature work, not work that exists nowhere else. The six modified files in its working tree
are committed too — every one's content matches a blob already present in the object database. So the
migration can proceed in any order, and the correct decision is the one the pin already encodes:
**`apothic-main` at `5887cefa` is what the fleet installs**, and the three commits are unmerged feature
work that belongs on their own branches until someone merges them.

The lesson is the one this document keeps relearning: `origin/HEAD` not resolving is not evidence that
the work is unpublished — `git branch -r --contains <sha>` is. An unresolvable symbolic ref was read as
an absent remote history, which would have justified a push that nobody needed.

**`pi-pretty-tui` — the pin stands; the checkout is on a stale branch.** The pin `ec6df5eb` (branch
`test/composer-selection-on-apothic`, which is what the install resolves to) carries six commits the
checkout lacks, including the whole composer-selection feature:

```
1452b78  feat(composer): select text in the prompt editor and delete or replace it
e1935c1  Replace the selection on any insertion, not just handlePaste
60dc3b5  Own repeat-paste expansion instead of relying on another extension
4494313 / 97385b7 / ec6df5e  the test-merge commits on apothic
```

The checkout's `apothic` branch has **nothing the pin lacks**. So no pin change: create the space
worktree from the pinned branch, and the lane inherits the feature instead of regressing it. (D9 in
one line: the manifest tracks the branch the install *resolves to*, not the branch a clone happens to
sit on.)

**Why these were last, not next:** each needed a decision about which commit is authoritative before a
cwd move, because a cwd move silently changes what the fleet loads. The other five spaces had pins
equal to their checkouts and could move without one.

## 5c. Retirement inventory — measured, with blockers named

24 checkouts under `~/Code` are clones of the 15 fleet subrepos. **Only 6 have a live lane standing in
them**, and nothing may be deleted while a lane's cwd or manifest points at it.

```
apothic-pi-extensions                    LANE pi-modes-leader      dirty 54   unpushed 0
pi-rooms                                 LANE pi-rooms-leader      dirty  2   unpushed 0
apothic-monorepo-workspace/tooling/unblock        LANE unblock-leader    dirty  6   detached
apothic-monorepo-workspace/tooling/pi-pretty-tui  LANE pi-pretty-tui-leader    0    detached
apothic-monorepo-workspace/tooling/mycord         LANE mycord-leader           0    pin-match
herdr-voice-linux                        LANE herdr-voice-leader          0   unpushed 0
```

The other 25 are free of lanes — including five `pi-pretty-tui` clones (`-140`, `-prep`, `-sel`,
`-sel033`) and four `herdr-voice-linux-lanes/*` worktrees — but **free is not safe**, and the number is
worse than it looks. Measured per checkout (dirty tree, and every local branch against `origin/<branch>`):

```
18 of 25 free checkouts hold either a dirty tree or a branch with no remote counterpart

pi-pretty-tui (-140 -prep -sel -sel033)   12 branches each,  9 not on a remote
pi-rooms                                  10 branches,       9 not on a remote
apothic-pi-extensions                     12 branches,       8 not on a remote   dirty 54
herdr-voice-linux + 4 lane worktrees       6 branches each,  4 not on a remote
cargo-remote-3000                          5 branches,       4 not on a remote
```

So "delete once the lane migrates" is wrong as a blanket rule: for most of these, deleting the
directory deletes branches that exist **nowhere else**. Every one needs its local branches
dispositioned — pushed, merged, or explicitly declared expendable — before the directory goes.

**And retirement is not a completion criterion.** `~/Code` stays full of non-fleet projects by the
operator's instruction, so nothing about FT-01 requires an empty `~/Code`. The completion test is
different and cheaper: **every fleet lane runs from a yellowstone worktree, and no instance manifest or
tool resolves a package or skill through a `~/Code` fleet checkout.** Once that holds, the old clones
are dormant rather than wrong, and each can be retired when its owner says so.

**Two blockers that are not mechanical:**

1. `apothic-pi-extensions` holds **54 uncommitted entries**, and they are not space scaffolding — they
   are edits to the component's own `AGENTS.md` and `.pi/prompts/*` across its packages. They belong to
   `pi-modes-leader` to commit at its own boundary. Deleting that checkout deletes them. This is why the
   lane moves last, not first.
2. `unblock` and `pi-pretty-tui` sit on **detached HEADs** with no upstream, so `@{u}` is meaningless
   for them: their unpushed count is unknown, not zero. For those, prove each branch has a remote
   counterpart by name before deleting.

**Order:** migrate the lane (space worktree, lane relaunched, verified from the system record) → confirm
its instance manifest resolves into the monorepo → only then delete the checkout it left behind.

## 6. Open items

- 9 loose package references remain, all in the three *working* lanes' instance manifests
  (`self-improvement-leader`, `overlord`, `yellowstone-leader`); they fall to 0 at those lanes' next
  launch and must not be rewritten under a running process.
- `~/.agents/skills/overlord-operations` is a **symlink** into `~/.overlord/skills/`. The skill is
  now in the mirror, but nothing recreates that symlink on a fresh machine — either it becomes a
  `home/.agents/skills/` entry with a `skills.tsv` row, or `scripts/overlord.sh` creates the link.
- `~/.sysops` holds two kinds of file and only one is generated. Its beads state is generated, and
  `home_generated_dirs()` deliberately ships none of it — correct as-is. Its **contract**
  (`AGENTS.md`, `.pi/launch.env`, `.pi/modes/*.json`) was authored on 2026-11-09 and **is** shipped in
  `home/.sysops/` like every other space's, because a fresh machine must be able to start that lane.
  The two must not be conflated: a generated file is reproduced by running the tool, an authored file
  is reproduced by installing the mirror.
