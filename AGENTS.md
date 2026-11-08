# yellowstone

`~/AGENTS.md` is the invariant core and applies here in full. This directory has no
space-specific rules of its own: the 78-line file that used to sit here was a byte-identical
copy of the global core (verified with `diff` on 2026-11-02), so this file is a pointer
instead. The core the installer ships to `~/AGENTS.md` lives in `fleet/AGENTS.md`; this file is
what an agent working in *this tree* reads, and it should not be a second copy of it.

## Role deltas

Role-only instructions, if they are ever needed here, go in `.pi/modes/<role>.json` — `key`
equal to the fleet mode key (`leader` or `worker`), `promptStrategy: "append"` — and compose
onto that fleet mode. `.pi/launch.env` carries the launch line:
`PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1`. It said `PI_PROFILE=fleet`
until 2026-11-08; `~/.pi-profile-switch/profiles/` holds `ask`, `leader` and `worker` and no
`fleet`, so the committed value named a profile this machine cannot resolve. `pil` decides the
profile from the tab or role and overrides this file — both idle worker lanes here launched as
`worker` while the file said `leader` — so the line records the project's default rather than
driving the launch.

Repo notes live with the code: `overlord/AGENTS.md` covers the overlord subproject.