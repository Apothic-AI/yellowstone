# Spaces — where a fleet lane's cwd lives

A **space** is one directory inside a yellowstone worktree that a fleet lane runs in. It holds no
code: the component the lane works on is at `../../src/…` in the same worktree. What it holds is the
scaffolding pi reads from the working directory — this file, and `.pi/launch.env`.

```
~/Code/yellowstone-wt/<space>/           <- lane cwd
    └── .pi/launch.env                   <- the space's launch line
~/Code/yellowstone-wt/<space>/../../src/skills/mycord   <- the code it edits
```

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

The instruction is a pointer rather than a copy: **`find src/<component> -name AGENTS.md`** and read
what it returns. This file does not duplicate that text, deliberately — it belongs where the
maintainers keep it current, and a pointer is the cheap half of keeping it there. (An earlier version
of this paragraph said "four components", which was the root count presented as the population. The
instrument costs one command and returns worse news than the estimate.)

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
