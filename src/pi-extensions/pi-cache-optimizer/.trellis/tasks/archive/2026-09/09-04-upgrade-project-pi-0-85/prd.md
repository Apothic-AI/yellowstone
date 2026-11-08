# Upgrade the project Pi development baseline to 0.85.1

## Goal

Upgrade this repository's local `@earendil-works/pi-coding-agent` development baseline from 0.85.0 to 0.85.1 so `pi` invoked through the project's Volta/local binary resolution matches the currently installed system Pi, while preserving reproducible type checking, tests, CI, package behavior, and the extension's existing user compatibility range.

## Requirements

- Upgrade the project development dependency and lockfile to `@earendil-works/pi-coding-agent` 0.85.1.
- Keep `@earendil-works/pi-coding-agent` as a local development dependency; do not make builds/tests depend on a machine-global Pi installation.
- Keep the published extension peer compatibility policy at `>=0.82.0` unless direct evidence proves 0.85 requires a narrower range.
- Verify `node_modules/.bin/pi --version` and project-directory `pi --version` resolve to 0.85.1 after installation.
- Investigate the observed `@earendil-works/pi-server` module-resolution failure under 0.85.1. Add a project dependency only if the repository's real typecheck/test/runtime import paths require it; choose the narrowest development-only workaround and document why.
- Preserve runtime extension behavior and published package contents. Do not change cache adapters, hooks, compat behavior, stats, commands, or user configuration.
- Keep CI reproducible via `npm ci` and repository-local tooling.
- Do not commit unrelated files and do not push, publish, release, deploy, or open a PR without explicit user approval.

## Acceptance Criteria

- [x] `package.json` and `package-lock.json` resolve the local Pi development baseline to 0.85.1.
- [x] A clean dependency install succeeds and the project-local Pi reports 0.85.1.
- [x] `npm run typecheck` passes against Pi 0.85.1 declarations.
- [x] `npm test` passes against Pi 0.85.1 runtime modules.
- [x] `npm run check:diff` and `npm run check:pack` pass.
- [x] The published extension peer range remains `>=0.82.0` and no Pi runtime is bundled into the extension tarball.
- [x] Any added `pi-server` workaround is proven necessary, development-only, version-aligned, and recorded in the task verification notes; otherwise it is not added.
- [x] No runtime source behavior changes are introduced.

## Verification Notes

- `npm install --save-dev @earendil-works/pi-coding-agent@0.85.1` upgraded the local package and lockfile; `node_modules/.bin/pi --version`, project-directory `pi --version`, and the installed package manifest all report `0.85.1`.
- `npm run typecheck` passed immediately with Pi 0.85.1 declarations.
- Before adding the workaround, `npm test` failed in all three test files while loading the extension. The observed chain was `@earendil-works/pi-coding-agent/dist/index.js` → `dist/main.js` → `dist/experimental/client.js` → `dist/experimental/server.js`, which imports `@earendil-works/pi-server`; Pi 0.85.1's published manifest does not declare that package.
- Adding exact `@earendil-works/pi-server@0.85.1` to `devDependencies` is therefore necessary for this repository's Jiti runtime tests. It is version-aligned, marked `dev: true` in the lockfile, absent from runtime `dependencies`, and not included in the package tarball.
- A subsequent `npm ci` completed successfully with zero reported vulnerabilities, after which the Pi 0.85.1 baseline check passed: typecheck, 89 tests, `git diff --check`, and `npm pack --dry-run`. The later 2.8.9 follow-up check includes the additional prompt-cache-key regression tests.
- The same complete `npm run check` gate also passed under the locally installed Node `22.20.0` and npm `10.9.3`, matching CI's Node 22 major version.
- The dry-run tarball still contains only `LICENSE`, `README.md`, `README.zh-CN.md`, `index.ts`, and `package.json`; no Pi runtime package is bundled.
- `peerDependencies["@earendil-works/pi-coding-agent"]` remains `>=0.82.0`. No runtime source behavior changed; the only test source edit removes the obsolete hard-coded Pi-version wording from a test title.

## Definition of Done

The dependency manifest and lockfile are updated minimally, clean-install reproducibility and the full project quality gate pass, task validation passes, and the task records the exact 0.85.1 dependency-resolution outcome. The baseline was delivered through follow-up PR #14 as part of the 2.8.9 release.

## Technical Approach

1. Reproduce the 0.85.1 install/import behavior in isolation and inspect the package dependency graph.
2. Upgrade the local Pi development dependency with npm so `package.json` and `package-lock.json` remain synchronized.
3. Run typecheck and focused/full tests. If a missing `pi-server` import occurs, trace the importing Pi module and add only the minimal version-aligned development dependency needed by this repository's test path.
4. Verify local CLI resolution, `npm ci` reproducibility, package dry-run contents, and all standard checks.
5. Review the final diff to ensure it contains dependency-baseline changes only.

## Decision (ADR-lite)

**Context:** Removing the local Pi dependency would make types, tests, and CI depend on a developer's global environment. The actual problem is that the project-local Pi binary remained on 0.85.0 while the Volta/system installation moved to 0.85.1.

**Decision:** Retain Pi as a repository-local development dependency and upgrade that reproducible baseline to 0.85.1. Keep the extension peer range independent because users run the extension through their host Pi rather than through this devDependency.

**Consequences:** Local and system Pi versions align for current development, while CI remains deterministic. Future Pi upgrades remain explicit repository changes with full compatibility verification.

## Out of Scope

- Removing the Pi SDK/type dependency from the repository.
- Changing the extension's runtime features or minimum supported Pi version without evidence.
- Publishing a new npm version or changing the package's own version.
- Updating user-installed Pi or user extension packages.

## Technical Notes

- Runtime entry: `index.ts` imports `getAgentDir` and Pi types from `@earendil-works/pi-coding-agent`.
- Permanent tests import Pi 0.84-era runtime modules directly, so 0.85 module graph changes must be verified rather than assumed.
- CI performs `npm ci` followed by `npm run check`; the lockfile is part of the compatibility contract.
- Pi package documentation says host-provided Pi packages belong in `peerDependencies`; Pi-managed extension installs suppress peer auto-installation and resolve Pi APIs from the host loader.
