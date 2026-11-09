# Spaces — where a fleet lane's cwd lives

A **space** is one directory inside a yellowstone worktree that a fleet lane runs in. It holds no
code: the component the lane works on is at `../../src/…` in the same worktree. What it holds is the
scaffolding pi reads from the working directory — this file, and `.pi/launch.env`.

```
~/Code/yellowstone-wt/<space>/           <- lane cwd
    └── .pi/launch.env                   <- the space's launch line
~/Code/yellowstone-wt/<space>/../../src/apps/mycord   <- the code it edits
```

## Why the space is not the component directory

pi finds `AGENTS.md` by walking **up** from the working directory, so a lane whose cwd were
`src/apps/mycord` would load `src/apps/mycord/AGENTS.md` — and that file would be committed to
**mycord's published repository**. `git subrepo push` would then publish a fleet-internal role
contract to every fleet that installs mycord. Keeping the space beside the code rather than inside it
is the whole reason this layer exists.

It also means nothing is installed into the subrepo tree, so the worktree stays clean and no
`gitignore` rule has to hide scaffolding from the component's own history.

## Role deltas

This file is shared by every lane in every space. A role-only instruction goes in
`.pi/modes/<role>.json` with `key` equal to the fleet mode key and `promptStrategy: "append"` —
the fleet definition and the space definition compose into one, with the fleet text first.

`.pi/launch.env` in the space directory carries that space's launch line, e.g.
`PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1`. It is tracked on purpose: it is the
space's identity, not a local preference.
