# Tasks

## 1. Instance generation becomes per-launch

- [x] 1.1 Change `generateRuntimeDir` in `src/settings-generator.ts` to create a unique directory under the instance root (`launch-` prefix, random id); the returned `runtimeDir` is the agentDir handed to Pi. Verification: path cases in `test/settings-generator.test.ts` changed to assert the directory lives under the instance root and that two generations produce different paths; `npm test` passes
- [x] 1.2 `src/settings-generator.ts` seeds the real agentDir's `missions` directory before mirroring (`mkdir` when missing, untouched when present, never writes content). Verification: a new case asserts the directory appears under the real agentDir after the first generation, the in-instance entry is a symlink to it, and the directory content is unchanged after the second generation
- [x] 1.3 The sweep invocation in `bin/pi-profile.ts` changes to run against the instance root before generating this run's instance. Verification: after one manual launch, only this run's `launch-*` directory remains under `instances/`
- [x] 1.4 Confirm `getInstancesRootDir` and its comment in `src/workspace.ts` still match per-launch semantics; no change needed. Verification: `npm run check` passes
- [x] 1.5 `src/settings-generator.ts` seeds the state files Pi creates at runtime (`auth.json`, `models-store.json`) into the instance as dangling-tolerant symlinks, with the seed step placed after broken-link cleanup. Verification: `test/settings-generator.test.ts` asserts the dangling symlinks exist, writes pass through to the real agentDir, and the links survive an in-place rewrite
- [x] 1.6 Integration-verify the landing spots of a real launch. Verification: `test/instance-lifecycle.integration.test.ts` asserts both are symlinks inside the instance after launch and the real agentDir receives the two files

## 2. Sweep and unrecognized-entry protection

- [x] 2.1 Change the sweep root of `src/launcher/runtime-cleanup.ts` to `<PI_PROFILE_SWITCH_DIR>/instances`, handling only `launch-`-prefixed directories. Verification: `test/runtime-cleanup.test.ts` covers the four determinations — keep when pid alive, reclaim when pid exited, reclaim when no pid and beyond the grace period, keep when no pid and within the grace period
- [x] 2.2 Implement unrecognized-entry determination (neither a symlink nor a managed generated artifact, including entries inside managed directories); on a hit, keep the directory and hand the warning (naming the directory, the entries, and available dispositions) to the caller for stderr output. Verification: a new case asserts an instance containing a wild directory is not deleted and a warning is produced
- [x] 2.3 Regression: the determination MUST NOT use "a same-named entry exists in the real agentDir" as a deletable condition. Verification: a new case asserts an instance containing a real directory named `missions` is still kept when the real agentDir already has `missions`
- [x] 2.4 Boundary: directories under the instance root not in `launch-` shape are neither deleted nor affect this launch. Verification: a new case places a directory of another shape and asserts it still exists after the sweep
- [x] 2.5 Sweep is best-effort: an error in one directory interrupts neither the other directories nor this launch. Verification: a new case makes one directory unreadable and asserts the remaining dead directories are still reclaimed and the function does not throw
- [x] 2.6 Confirm no exit-time deletion logic was added to `src/launcher/spawn.ts`. Verification: read the file and confirm the `finally` branch only removes signal handlers

## 3. Tests and integration

- [x] 3.1 Assertions hardcoding `instances/<profile>/agent` in `test/settings-generator.test.ts`, `test/project-scope.integration.test.ts`, `test/mcp.integration.test.ts` changed to discovering this run's unique `launch-*` directory under `PI_PROFILE_SWITCH_DIR`. Verification: `npm test` passes
- [x] 3.2 Integration-verify concurrency semantics: two launches of the same profile use different instance paths. Verification: a new integration case asserts the two launches' `PI_CODING_AGENT_DIR` differ and neither's files are rewritten by the other
- [x] 3.3 Full validation. Verification: `npm run check` and `npm test` all green

## 4. Doc Impact follow-through

- [x] 4.1 Rewrite the whole "Runtime directory" section of `docs/architecture/overview.md`: path shape becomes a unique directory per launch, `pid` location, seed rules, sweep rules, and the managed file table synced
- [x] 4.2 Rewrite "Known limitations" in `docs/architecture/overview.md`: remove "fixed instance path causes concurrent launches to rewrite each other" and "instance directories of deleted or renamed profiles are not cleaned"; add one row "legacy 0.4.x instance directories are untouched by the new sweep; users dispose of them manually"
- [x] 4.3 Add the seed list table to `docs/architecture/overview.md` (currently only `missions`), noting "entries require observed evidence, not inference"
- [x] 4.4 Add `docs/adr/0010-per-launch-instance-lifecycle.md` (landed with this change). Verification: its decisions match `design.md`; if the design is revised during apply, update that file in sync
- [x] 4.5 Confirm `docs/prd.md` and `CONTEXT.md` genuinely need no changes (the `instance` definition already describes per-launch). Verification: `git diff --stat` shows these two files untouched
- [x] 4.6 `openspec validate per-launch-instance-lifecycle --strict` passes

## 5. Out of scope for this change

- 0.4.x's `instances/<profile>/agent` and 0.1–0.3's `<agentDir>/pi-profile/runtime/launch-*` are neither migrated nor cleaned, and no compatibility sweep is done.
- Third-party state inside managed directories (e.g. `extensions/subagent/config.json`) gets no inner seed; unobserved third-party state directories such as `chains` do not enter the seed list — when they surface as unrecognized entries, 2.2's warning names them.
- Deleting instance directories at exit is not in this change; reclamation is carried solely by the startup sweep.
