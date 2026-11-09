# Tasks

This change produces no code. Each task checks a specification item back against the implementation, confirming no unimplemented behavior was written and no implemented behavior was missed.

## 1. Specification-to-implementation consistency check

- [x] 1.1 Check "CLI argument parsing and pass-through": read `src/launcher/args.ts`; confirm only one leading positional argument and at most one `--` are consumed, the four trust flags are recognized with last-wins, and everything else passes through verbatim
- [x] 1.2 Check "Initial profile selection": read `resolveInitialProfile` in `src/launcher/initial-profile.ts`; confirm the three-level fallback order, `UnknownProfileError`'s hard-failure condition, the soft fallback with warning for a stale saved selection, and that runtime state is not written
- [x] 1.3 Check "Pre-launch failure and exit codes": read the catch branch of `bin/pi-profile.ts`; confirm the list of six usage-error classes and the exit-code `2`/`1` split
- [x] 1.4 Check "Project trust gating": read `src/project-trust.ts`; confirm the four-step determination order, the inclusion of `hasPiProfileProjectFiles`, and that no extension code is executed
- [x] 1.5 Check "Launch diagnostic output": read `unmatchedWarnings` in `src/launcher/initial-profile.ts` and the warning output in `bin/pi-profile.ts`; confirm both diagnostic classes go to stderr and do not block
- [x] 1.6 Check "Instance directory contract": read `generateRuntimeDir`, `writeRuntimeFiles`, and `syncAgentSymlinks` in `src/settings-generator.ts`; confirm path construction, the managed file list, mirroring and broken-link cleanup, the `trust.json` filter condition, and the removal of `PI_CODING_AGENT_SESSION_DIR`
- [x] 1.7 Check "Subprocess launch": read `buildPiArgs` and `spawnPi` in `src/launcher/spawn.ts`; confirm argv order, the forwarding condition of `trustOverride`, and exit-code/signal forwarding

## 2. Specification quality validation

- [x] 2.1 `openspec validate spec-baseline-launcher --strict` passes
- [x] 2.2 Compare the specification against `docs/adr/0005-subprocess-host-with-generated-settings.md`; confirm it does not restate the rejected alternatives or reasoning
- [x] 2.3 Compare the specification against "Overall structure" and "Runtime directory" in `docs/architecture/overview.md`; confirm the specification does not repeat mechanism descriptions: neither the scope-to-Pi-mechanism mapping nor the generated-settings encoding goes into the specification
- [x] 2.4 Check wording against `CONTEXT.md`; confirm no avoid-words are used and no implementation class or internal function names appear
- [x] 2.5 Confirm the specification nowhere turns stale-instance cleanup into a contract

## 3. Doc Impact follow-through

- [x] 3.1 Fix the "Runtime directory" section of `docs/architecture/overview.md`: remove the assertion "stale directories with dead `pid`s are swept at startup", which does not match reality, and state the actual layout instead (the instance path is fixed per profile and reused, not cleaned)
- [x] 3.2 Add a row to the "Known limitations" table of `docs/architecture/overview.md`: stale instance directories are not cleaned; the existing sweep implementation targets `<agentDir>/pi-profile/runtime/launch-*`, which differs from the instance path, so it never takes effect
- [x] 3.3 Check `docs/prd.md`: confirmed no change to positioning, goals, or non-goals; no edit needed
- [x] 3.4 Check `CONTEXT.md`: confirmed no new terms and no changed meanings; no edit needed
- [x] 3.5 Check `docs/adr/`: confirmed no hard-to-reverse decision introduced; no new ADR needed

## 4. Out of scope for this change

The ineffective stale-instance sweep is not handled in this change: `src/launcher/runtime-cleanup.ts` scans `<agentDir>/pi-profile/runtime/launch-*`, while instances are written at `<PI_PROFILE_SWITCH_DIR>/instances/<profile>/agent`, so the sweep never takes effect and the `pid` write has no consumer. Fixing or removing that module requires a separate change. This change does not modify code.
