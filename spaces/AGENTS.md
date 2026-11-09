# Spaces — where a fleet lane's cwd lives

A **space** is one directory inside a yellowstone worktree that a fleet lane runs in. It holds no
code: the component the lane works on is at `../../src/…` in the same worktree. What it holds is the
scaffolding pi reads from the working directory — this file, and `.pi/launch.env`.

```
~/Code/yellowstone-wt/<space>/           <- lane cwd
    └── .pi/launch.env                   <- the space's launch line
~/Code/yellowstone-wt/<space>/../../src/skills/mycord   <- the code it edits
```

## What a space is for — and what it is not for

> **Superseded in part, 2026-11-09.** The operator's FT-01 Objectives settle what this section was
> written before: *"Components like mycord, pi-modes, pi-pretty-tui, pi-rooms, unblock do not need
> herdr spaces because once those components have yellowstone subrepos, the yellowstone space will
> cover them all."* So a component no longer gets a **herdr workspace** of its own, and the
> `spaces/<component>` directories below are **transitional, not a pattern to extend**. A lane
> working a component runs in the **yellowstone space** (or a yellowstone worktree) and edits
> `../../src/…` from there. What still holds, unchanged, is the second half: the six operational
> spaces are permanently out of this tree, because they carry fleet data we do not want in git.

**A space exists for one thing: a lane developing a fleet component** — a pi extension, a herdr plugin,
or herdr itself. If the lane's subject is documents, coordination, personal data, or the fleet's own
working state, it does not live here.

| space | where a lane runs | in this tree? |
|---|---|---|
| `pi-rooms`, `pi-pretty-tui`, `pi-modes`, `unblock`, `mycord` | **transitional** — a lane runs in the **yellowstone** space/worktree; these directories are not the destination for new work | **yes, for now** |
| `herdr-voice` | as above, but this directory exists **only on branch `space/herdr-voice`** — not on `master` | **on that branch only** |
| `assistant`, `comms`, `overlord`, `self-improvement`, `sysops`, `personal` | `~/Documents/*`, `~/.overlord`, `~/.sysops` | **no, permanently** |

The reason is not tidiness. Those spaces carry **fleet-specific data we do not want in git** — continuity
files, coordination logs, personal notes, lane history — and a lane that keeps working state inside a
repo eventually commits it. They share *code* with the monorepo through `git subrepo pull` / `push`,
which is the whole point of carrying components as subrepos: the code syncs, the data stays put.

So do not add a `spaces/<name>` for a non-component lane, and do not move fleet state into `home/`
because it is fleet-related. **The mirror carries content that lands on a machine; it does not carry the
fleet's working data.**

### The pilot lanes are the last holders of this layer

Six pilot lanes run in these directories today, each in its own worktree whose branch is
`space/<component>`:

```
mycord-pilot-leader          ~/Code/yellowstone-wt/space-mycord/spaces/mycord
pi-modes-pilot-leader        ~/Code/yellowstone-wt/space-pi-modes/spaces/pi-modes
pi-pretty-tui-pilot-leader   ~/Code/yellowstone-wt/space-pi-pretty-tui/spaces/pi-pretty-tui
pi-rooms-pilot-leader        ~/Code/yellowstone-wt/space-pi-rooms/spaces/pi-rooms
unblock-pilot-leader         ~/Code/yellowstone-wt/space-unblock/spaces/unblock
herdr-voice-pilot-leader     ~/Code/yellowstone-wt/space-herdr-voice/spaces/herdr-voice
```

They are the experiment that showed a component space works, and they are now the only thing keeping
the layer alive. **No new `spaces/<component>` is created.** When the last pilot lane retires, these
directories and the `space/*` worktrees go with them, and a component lane starts in the yellowstone
space like any other lane.

Until then the directories stay, because deleting one removes the cwd of a running lane — and a lane
cannot change its own cwd. Retiring a pilot is a lane restart, so it belongs to whoever runs
workspace ops, not to whoever edits this file.

## Why the space is not the component directory

pi finds `AGENTS.md` by walking **up** from the working directory, so a lane whose cwd were
`src/skills/mycord` would load `src/skills/mycord/AGENTS.md` — and that file would be committed to
**mycord's published repository**. `git subrepo push` would then publish a fleet-internal role
contract to every fleet that installs mycord. Keeping the space beside the code rather than inside it
is the whole reason this layer exists.

It also means nothing is installed into the subrepo tree, so the worktree stays clean and no
`gitignore` rule has to hide scaffolding from the component's own history.

## The space directory is the only sanctioned lane cwd

A lane for a component runs here — `spaces/<component>/` — not in `src/<component>/`.

This is a rule, not a preference, and the reason is a hazard that is currently **latent rather than
live**. There is no `AGENTS.md` beside the code today, and no `.git` in a subrepo directory (a subrepo
is plain files inside the parent repo), so a lane started in `src/skills/mycord` would find no component
`AGENTS.md` to leak. The day someone writes one, the same cwd publishes a fleet-internal role contract
through `git subrepo push` to every fleet that installs that component.

So do not "simplify" a space by pointing a lane at the code directory because it works today. The
guard is the cwd, and the cwd is one config edit away from being wrong. If a lane needs the component
`AGENTS.md`, it does not: that file describes the component to its own developers, and the space
describes the fleet lane.

### …and a space lane never loads a component `AGENTS.md` at all

That is the other half of the same fact, and it is structural rather than a policy. pi walks **up** from
cwd; the walk from `spaces/<component>` is `spaces/` → worktree root → `~/`. **`src/` is beside that
path, never above it**, so a component's own `AGENTS.md` is unreachable however the space is arranged.
Adding one to a component that lacks it would not change a single lane's context.

**44 `AGENTS.md` files live under `src/`** — four at a component root, and **forty nested inside
packages**. Check both levels before touching code, because the walk-up reaches neither:

```
src/<component>/AGENTS.md                      4 files, component-level conventions
src/<component>/packages/<pkg>/AGENTS.md       40 files, written for exactly that directory
```

The sharpest case is the one a lane is most likely to hit: `pi-modes` lives at
`tryinget/packages/pi-modes`, and **both** files exist above the code it edits —
`tryinget/AGENTS.md` (84 lines: structure, package conventions, live package activation) and
`tryinget/packages/pi-modes/AGENTS.md` (71 lines, written for that directory). The inner one is the
worse miss, because it is the file written for the exact directory the lane is changing.

### Required before work: read the component's own AGENTS.md

This is not a pointer for convenience. It is a **required first step for any lane working under
`src/`**, because those files carry *constraints that exist because of how the component works* — not
style notes — and a lane cannot go looking for a file it has no reason to know exists.

Measured example, from `tryinget/packages/pi-modes/AGENTS.md` (71 lines, unreachable from a space cwd):

> pi-modes' own out-of-band mode contract — `state|expected|attest` is read-only and **must never
> attach** (a second writer on a live session is forbidden), and `--expect` digests are per-key over
> scope+path via `modeDefinitionFingerprint`, never a hash of file bytes.

A lane editing that package could have broken a safety rule on its first working turn, with no signal
that a rule existed. That is the cost of the blind spot, and it is why this is a requirement rather
than a mention.

**Do this before touching anything under `src/`:**

```sh
find src/<component> -name AGENTS.md     # 44 exist under src/: 4 at component roots, 40 in packages
```

Read every file it returns and treat the constraints in them as binding. The text is not copied here,
deliberately — it belongs where each component's maintainers keep it current, and a copy would drift
from its source within a week. A pointer plus a requirement is the cheap half of keeping instructions
where they are maintained; a coordinator remembering to mention it at launch is not a state.

## Verifying that a space composed correctly

Do this from artifacts, never from the lane's own report and never from the footer — the footer reads
`profile: leader` even when the composition was dropped entirely.

1. **Send a probe turn first.** The session file is created per request, so on a freshly-idle pane
   there is nothing for the verification to read and the check silently has no subject.
2. `pi-modes state <session> --json` → `verdict: match`, `recordedDigest == currentDigest`.
3. Read the system record's `sections` **at `message.sections` on the first user message** — not a
   top-level field. `project_context` should carry this scaffold, the worktree root `AGENTS.md`, and
   `~/AGENTS.md`, and should not carry the component's own `AGENTS.md`.
4. `pi-modes` is not on `PATH`: it is `src/pi-extensions/tryinget/packages/pi-modes/bin/pi-modes.mjs`
   and needs `PI_MODES_CLI_SECRET_FILE` pointing at the credential the mirror deliberately excludes.
   The verification therefore depends on a file the repo does not carry — that is intended, and it
   means verification is an operator-side step, not something a fresh clone can do alone.

## Role deltas

This file is shared by every lane in every space. A role-only instruction goes in
`.pi/modes/<role>.json` with `key` equal to the fleet mode key and `promptStrategy: "append"` —
the fleet definition and the space definition compose into one, with the fleet text first.

`.pi/launch.env` in the space directory carries that space's launch line, e.g.
`PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1`. It is tracked on purpose: it is the
space's identity, not a local preference.
