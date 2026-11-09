# `PI_PROFILE` as an explicit launch selection

For the resolution order this extends, see [ADR-0003](0003-no-profile-inheritance.md) and [ADR-0013](0013-per-profile-file-storage.md).

## Context

A profile is selected at launch from, in order: a positional name, the trusted project's saved selection, the global saved selection, then `default`. Both saved selections are **cwd-scoped**: `RuntimeStateStore(path.join(context.cwd, ".pi"))` for the project, the global store otherwise.

That works while one cwd implies one role. It stops working when two roles share a directory. In this fleet a **worker lane runs in its leader's cwd** — deliberately, so it inherits that space's `AGENTS.md` context files — and a profile is the wrong shape to fix that, because context files are chosen by cwd and profiles cannot narrow them (ADR-0011).

The visible consequence: with the global selection set to `fleet`, every worker spawned with `pil` inherits `fleet`, not `worker`. The worker narrowing — 2 skills and a 13-tool allowlist instead of 13 skills and every tool — silently never applies to the lanes that need it most. Nothing errors; the lane just costs more than intended.

The alternative was to require every leader to spell `pi-profile worker` instead of `pil` in each spawn command. That works today but moves a fleet invariant into prose that each new spawner has to remember, which is the failure mode this repository exists to avoid elsewhere.

## Decision

`PI_PROFILE` is honoured as an **explicit** launch selection. Precedence becomes:

1. positional name on the command line
2. **`PI_PROFILE`**
3. trusted project's saved selection
4. global saved selection
5. `default`

It is parsed with `?.trim() || undefined`, so an empty or whitespace value is the same as unset — a shell that exports `PI_PROFILE=` by accident does not break every launch.

An unknown value **fails loudly**, exactly as an unknown positional name does: `unknown profile: no-such-profile`, no fallback. The tolerant path stays reserved for *restored* selections, which are a convenience rather than a commitment. A spawner that mistypes is a configuration error at the moment it happens, and a lane that silently starts unfiltered is the failure this input exists to prevent.

## Consequences

- A worker is spawned declaratively: `PI_PROFILE=worker pil`. `pil` stays ignorant of profiles — it only exports its lane name and execs — and the launcher stays ignorant of lanes.
- A positional name still wins, so `PI_PROFILE=worker pi-profile ask` resolves `ask`. Interactive overrides behave as before.
- Nothing changes for a launch that sets no `PI_PROFILE` and has no saved selection: it still resolves `default`.
- The selection is transient, like a positional name: no runtime state is written, so it cannot leak into a later launch.
- `PI_PROFILE` is a pi-profile concept, not a Pi one. Pi is unaware of it, and a `pi` process started without the launcher ignores it entirely — which is why the launcher remains mandatory for profiles at all.