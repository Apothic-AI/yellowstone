# yellowstone

`~/AGENTS.md` is the invariant core and applies here in full. This directory has no
space-specific rules of its own: the 78-line file that used to sit here was a byte-identical
copy of the global core (verified with `diff` on 2026-11-02), so this file is a pointer
instead. The core the installer ships to `~/AGENTS.md` lives in `home/AGENTS.md`; this file is
what an agent working in *this tree* reads, and it should not be a second copy of it.

## Role deltas

Role-only instructions, if they are ever needed here, go in `.pi/modes/<role>.json` — `key`
equal to the fleet mode key (`leader` or `worker`), `promptStrategy: "append"` — and compose
onto that fleet mode. `.pi/launch.env` carries the launch line:
`PI_MODE=leader PI_PROFILE=fleet PI_MODE_CONFIRM_PROJECT=1`.

Repo notes live with the code: `home/.overlord/AGENTS.md` covers the overlord subproject.