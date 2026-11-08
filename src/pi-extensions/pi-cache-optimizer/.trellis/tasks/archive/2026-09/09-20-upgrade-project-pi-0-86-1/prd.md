# Upgrade the project Pi development baseline to 0.86.1

## Goal

Upgrade this repository's reproducible local Pi development baseline from 0.85.1 to the npm `latest` release 0.86.1, while preserving extension behavior, clean-install reproducibility, test/type compatibility, and the published peer compatibility policy.

## What I already know

- The user requested Pi 0.86.1 explicitly.
- npm currently reports `@earendil-works/pi-coding-agent@0.86.1` as the `latest` dist-tag.
- `package.json` currently uses `@earendil-works/pi-coding-agent: ^0.85.1` and the development-only workaround `@earendil-works/pi-server: 0.85.1`.
- The published extension peer range is `@earendil-works/pi-coding-agent >=0.82.0` and should remain independent of the local development baseline unless compatibility evidence requires otherwise.
- Both target packages require Node `>=22.19.0`, consistent with the repository's prior Pi 0.85 baseline work.
- Pi 0.86.1 aligns its internal `@earendil-works/*` dependencies on the 0.86.1 family.
- The prior 0.85.1 upgrade proved that `pi-server` is required by this repository's Jiti runtime-test import path even though `pi-coding-agent` does not declare it directly.

## Assumptions (temporary)

- This is a development-baseline upgrade only: no extension feature changes and no package version/release work.
- Upgrade both direct Pi development packages to 0.86.1, preserving `^0.86.1` for `pi-coding-agent` and exact `0.86.1` for `pi-server`.
- Keep the peer range at `>=0.82.0` unless the compatibility checks provide direct contrary evidence.

## Open Questions

- None. The user confirmed the minimal baseline upgrade and requested a post-upgrade assessment of whether project code or policy needs adjustment.

## Requirements (evolving)

- Upgrade `@earendil-works/pi-coding-agent` and `@earendil-works/pi-server` development dependencies to 0.86.1.
- Regenerate `package-lock.json` with npm and keep dependency resolution reproducible with `npm ci`.
- Verify the local Pi CLI reports 0.86.1.
- Run typecheck, the full permanent test suite, diff checks, and package dry-run checks.
- Preserve runtime extension behavior and package contents.
- Do not update the extension's own version, publish, release, push, or open a PR without explicit approval.
- After upgrading, assess Pi 0.86.1 API/runtime/package differences and test evidence to determine whether this project needs source, test, compatibility-policy, or documentation adjustments; make only proven, in-scope compatibility fixes.

## Acceptance Criteria

- [x] `package.json` and `package-lock.json` resolve the local Pi development baseline to 0.86.1.
- [x] `node_modules/.bin/pi --version` reports 0.86.1.
- [x] A clean `npm ci` succeeds on the supported Node version.
- [x] `npm run typecheck` passes against Pi 0.86.1 declarations.
- [x] `npm test` passes against Pi 0.86.1 runtime modules.
- [x] `npm run check:diff` and `npm run check:pack` pass.
- [x] The peer range remains `>=0.82.0`; no compatibility evidence requires narrowing it.
- [x] No runtime source behavior or published package contents changed beyond synchronized compatibility documentation and dependency metadata.
- [x] The post-upgrade compatibility assessment records whether source, tests, peer policy, or documentation require adjustment.

## Definition of Done

- Dependency manifest and lockfile are updated minimally.
- Local and clean-install dependency resolution are verified.
- Full repository quality gates pass.
- Any Pi 0.86.1 compatibility issue is either fixed with focused regression coverage or reported before scope expands.
- Task validation passes and verification evidence is recorded.

## Verification and Compatibility Assessment

- Upgraded local development dependencies to `@earendil-works/pi-coding-agent@0.86.1` (`^0.86.1`) and exact `@earendil-works/pi-server@0.86.1`; the lockfile contains no remaining 0.85.1 resolution and aligns the direct `@earendil-works/*` Pi family on 0.86.1.
- `npm ci` succeeded with zero reported vulnerabilities under Node 24.18.0/npm 11.16.0; both target packages require Node `>=22.19.0`.
- `node_modules/.bin/pi --version` reports `0.86.1`; `npm ls --depth=0` resolves both direct Pi development packages to 0.86.1.
- `npm run check` passed: TypeScript validation, 102/102 permanent tests, `git diff --check`, and package dry run.
- The dry-run tarball still contains exactly `LICENSE`, `README.md`, `README.zh-CN.md`, `index.ts`, and `package.json`; no Pi runtime dependency is bundled.
- Pi 0.86.0 breaking changes affect custom provider stream context, JSON-restricted tool-call/result values, and fail-closed `user_bash` handlers. This extension implements none of those surfaces. Its test-only `registerProvider` compatibility fixture still passes.
- All ten Pi lifecycle/provider hooks used by `index.ts` remain exported with compatible registrations in 0.86.1; compiling against official declarations and loading through the full Jiti runtime suite succeeds.
- Pi 0.86 adds optional native cache warming and a `cache_warming_decision` extension event. The project is not required to subscribe: native warming owns its hidden usage entries, while this extension's footer continues to measure finalized assistant-message cache usage. No conflict or source adaptation was observed.
- `supportsPromptCacheKey` remains absent from Pi 0.86.1 declarations/runtime schema, so the extension-owned exact-model opt-out remains necessary and its existing regression test passes.
- Required adjustment: synchronize English/Chinese compatibility documentation, the implementation comment, and the executable cache contract from 0.85.1 to the validated 0.86.1 baseline. No runtime logic, tests, peer minimum, package version, or additional compatibility policy change is needed.

## Out of Scope (explicit)

- New extension features or behavior changes unrelated to Pi 0.86.1 compatibility.
- Updating the extension package version.
- Publishing to npm, releasing, deploying, pushing, or opening a PR.
- Raising the minimum supported host Pi version without evidence.

## Technical Approach

1. Inspect Pi 0.86.1 package/changelog/API differences relevant to this extension's imports and hooks.
2. Upgrade the two direct development dependencies with npm so manifest and lockfile stay synchronized.
3. Verify local CLI resolution, typecheck, and focused/full tests.
4. Run a clean `npm ci`, then the complete repository quality gate and package dry run.
5. Review the final diff for dependency-only scope; if upstream API changes require source updates, document and test the narrow compatibility adaptation.

## Decision (ADR-lite)

**Context:** The repository uses Pi both for compile-time extension APIs and runtime test imports. A local development dependency keeps CI and local verification deterministic; the separate peer range describes supported host Pi versions for users.

**Decision:** Move the reproducible development baseline to 0.86.1, then assess the project against Pi 0.86.1's declarations and runtime behavior. Keep the peer policy and runtime behavior unchanged unless direct evidence requires a compatibility adaptation.

**Consequences:** Development validates against current Pi without unnecessarily dropping older supported hosts. Any upstream incompatibility is detected by the existing full quality gate.

## Technical Notes

- Primary files: `package.json`, `package-lock.json`; source/tests only if Pi 0.86.1 introduces a proven compatibility break.
- Runtime entry: `index.ts` imports Pi APIs/types from `@earendil-works/pi-coding-agent`.
- Pi docs continue to recommend host-provided APIs in peer dependencies for Pi packages.
- npm metadata checked for `@earendil-works/pi-coding-agent@0.86.1` and `@earendil-works/pi-server@0.86.1`; both require Node `>=22.19.0`.
