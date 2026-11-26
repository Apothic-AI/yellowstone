# FT-01 lane brief — the D12 one-lane proof

Owner: `self-improvement-leader`. Source: `/home/bitnom/Documents/Assistant/Fleet TODOs.md`, FT-01.
Decision record: `pi-fleet-model/FT-01-LEAD-DECISIONS.md` (D12, and "Rollout").

This is **step 2** of the D12 rollout. Read the correction below before doing anything: as
originally written this brief claimed a live lane would already be running monorepo packages. It is
not, and it cannot be until the fleet install runs.

**What is true:** D12 changed the *repository* mirror. The canonical `~/.pi/agent/settings.json` on
this machine still names three `~/Code` checkouts, and every live instance holds its own absolute
references. So a lane launched now loads the old sources, proves the launcher composes a role
correctly, and demonstrates nothing about D12.

**Therefore this lane's job, in order:**

1. **Before the fleet install** — prove the launcher composes in a cwd with no project mode
   (`PI_MODE`/`PI_PROFILE` in the system record, not the footer alone), and that the *installed*
   machine still resolves its three `~/Code` sources. That is the baseline, and it is a pass.
2. **After the fleet install** — re-check: no package source outside the checkout, `pi list` paths
   under `src/**`, the mycord/unblock skills resolving into `src/apps/mycord` and
   `src/herdr-plugins/unblock`, and one `goal_complete` to prove a package is loaded and live rather
   than merely listed.

**The trap that will waste your first ten minutes:** this shell is zsh, and an unquoted
`@YELLOWSTONE_REPO@/…` fails before the command runs (`zsh: no matches found`). Quote it. A step that
"fails" that way has proved nothing. Step 1 (throwaway `HOME`, no
lane) is the lead's and happens first; if step 1 fails, stop and report — do not proceed.

## What "monorepo-sourced" means, concretely

After D12 the fleet must load components from `~/Code/yellowstone/src/**`, not from
`~/Code/<scattered checkout>` and not from a `git:` materialisation under
`~/.pi-profile-switch/instances/<id>/git/`. The nine pi packages are:

```
pi-goal            src/pi-extensions/signalridge/packages/pi-goal
pi-modes           src/pi-extensions/tryinget/packages/pi-modes
pi-fleet-hooks     src/pi-extensions/pi-fleet-hooks
bizzy              src/pi-extensions/bizzy
pi-pretty-tui      src/pi-extensions/pi-pretty-tui
pi-rooms           src/pi-extensions/pi-rooms
apothic-todo       src/pi-extensions/apothic-todo
pi-persist         src/pi-extensions/pi-persist
pi-cache-optimizer src/pi-extensions/pi-cache-optimizer
```

plus `pil`/`pi-profile` from `src/apps/pi-profile-switch`, the two herdr plugins from
`src/herdr-plugins/`, and the mycord skill library from `src/apps/mycord`.

## Job

1. Take a scratch `HOME` (`mktemp -d`) and the four destination variables overridden, run
   `./install.sh --yes` from the monorepo, and start `pi` with that `HOME`.
2. Prove the loaded set: `pi list` reports every one of the nine packages from a path **under the
   yellowstone checkout**, and **no** entry from `~/Code/` or from an instance's `git/` copy.
   Capture the command and its output — a path list is `reported`; a loaded lane is `verified`.
3. Prove composition still works: the lane must run with `PI_MODE=worker PI_PROFILE=worker` and
   show the worker contract in its system record, which is the thing `pi-modes` provides. If
   composition silently drops, the matrix in `~/Documents/Fleet/AGENTS.md` is the reference:
   a dropped composition falls back to the **native** prompt and the footer still lies.
4. Prove the hooks load: `pi-fleet-hooks` supplies `nonblock`; confirm it is present in the
   installed extensions list, because a missing hook does not announce itself.
5. Prove skills resolve from the monorepo: `readlink ~/.agents/skills/mycord-skill` must point
   under `src/apps/mycord/`, and `unblock` under `src/herdr-plugins/unblock/skills/unblock`.
6. Prove one capability survives end-to-end: on a goal-capable lane, `goal_complete` still works.
   That is the check that catches a package loaded-but-inert, which is the failure mode a path
   list cannot see.

## Boundaries

- **Do not install against the real `HOME`.** That is step 3, the lead's, after this proof.
- Do not edit anything under `~/Code/yellowstone` — work in your own worktree; the branch is the
  lead's to merge.
- Do not modify `~/Code` checkouts, `tooling/` included. They are read-only inputs to this proof,
  and after D12 they are inputs nothing should need.
- `.pi/launch.env` is not touched anywhere. It is the space's tracked launch line.

## Acceptance

Report: the scratch-`HOME` path, the `install.sh` invocation, `pi list` with paths, the mode
composition evidence (system-record section, not the footer), the hook presence line, the two
`readlink` results, and the `goal_complete` result. Anything you could not prove, name it as
unproven rather than rounding it up.

If a package loads from an instance `git/` copy rather than the checkout, that is not a pass with
a caveat — it is the exact failure D12 exists to remove. Say so and stop.
