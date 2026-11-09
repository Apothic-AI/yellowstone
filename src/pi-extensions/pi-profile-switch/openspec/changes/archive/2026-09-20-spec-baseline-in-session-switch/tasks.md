# Tasks

This change produces no code. Each task checks a specification item back against the implementation, confirming no unimplemented behavior was written and no implemented behavior was missed.

## 1. Specification-to-implementation consistency check

- [x] 1.1 Check "/profile command family and mode gating": read the command dispatch section of `extensions/pi-profile/index.ts`; confirm the subcommand set, the three usage rejections, and that the `ctx.mode !== "tui"` gate covers only the four CRUD subcommands
- [x] 1.2 Check "In-session switching": read `switchProfile` in `src/switching/switch-profile.ts`; confirm the six-step sequence, the position of `waitForIdle`, no file writes on resolution failure, `/profile use`'s `clearOverlay` and persistence, and `/profile reload` preserving existing persistence
- [x] 1.3 Check "Rollback on switch failure": read `snapshotFile`, `restoreFile`, `rollback`, and the `assertStale` probe in `src/switching/switch-profile.ts`; confirm exact restoration of the three snapshot classes, the reason for `rm` before restore, and that a silent reload also rolls back
- [x] 1.4 Check "Plan application and change summary at session start": read `src/switching/apply-plan.ts`; confirm tool re-expansion and the `droppedLiterals` warning, the `reason === "reload"` persistence condition, the one-shot nature of the `switchedFrom` summary, and `clearOverlay`'s overlay deletion
- [x] 1.5 Check "Runtime overlay": read `customizeOverlay`, `resetOverlay`, `parseCustomizeArgs` in `src/switching/customize.ts` and the overlay narrowing section of `src/profile-resolver.ts`; confirm the two write-order invariants, the three error sites for disabling unknown resources, and the MCP-disable rejection on the `default` profile
- [x] 1.6 Check "Runtime state": read `src/runtime-state-store.ts`; confirm the two constructions of the state directory, `update`'s read-modify-write merge semantics, and corrupt files read as empty state
- [x] 1.7 Check "Observability surface": read `src/switching/list-profiles.ts` and the list/status/bare branches of `extensions/pi-profile/index.ts`; confirm trust gating, the `shadowsGlobal` marker, degradation to a list without UI, and the structured `details` in both `sendMessage` sites
- [x] 1.8 Check "CRUD effects on the runtime": read the create/edit/delete/duplicate branches of `extensions/pi-profile/index.ts`; confirm immediate reload when editing the active profile, no runtime touch when editing an inactive one, and the two paths of replacement selection and same-name revelation when deleting the active profile

## 2. Specification quality validation

- [x] 2.1 `openspec validate spec-baseline-in-session-switch --strict` passes
- [x] 2.2 Compare the specification against `docs/adr/0005-subprocess-host-with-generated-settings.md`; confirm it does not restate the rejected alternatives or reasoning
- [x] 2.3 Compare the specification against "Activation flow" and "Modules and interfaces" in `docs/architecture/overview.md`; confirm the specification does not repeat mechanism descriptions and no internal field names of the plan file appear
- [x] 2.4 Confirm no overlap with `spec-baseline-profile-catalog`'s write semantics: failure conditions and scope ownership should appear only in the catalog specification
- [x] 2.5 Check wording against `CONTEXT.md`; confirm no avoid-words are used and no implementation class names appear

## 3. Doc Impact follow-through

- [x] 3.1 Check `docs/prd.md`: confirmed no change to positioning, goals, or non-goals; no edit needed
- [x] 3.2 Check `docs/architecture/overview.md`: confirmed no change to module boundaries, data flow, or known limitations; no edit needed
- [x] 3.3 Check `CONTEXT.md`: confirmed no new terms and no changed meanings; no edit needed
- [x] 3.4 Check `docs/adr/`: confirmed no hard-to-reverse decision introduced; no new ADR needed
