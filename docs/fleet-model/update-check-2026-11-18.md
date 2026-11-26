# Daily harness update check — 2026-11-18

## Scope and method

Checked `/home/bitnom/.pi/agent/settings.json`, the instance npm manifest/lockfile, installed package versions, local Yellowstone checkout, and installed pi/herdr binaries. Candidate npm release contents were downloaded for manifest and sensitive-surface review; no package was installed or pinned.

## Moved refs found

- **pi:** installed 1.5.0; npm registry reports 1.5.2 available. The exact installed binary is the mise-installed pi bundle; no local pi source checkout was present to provide a source commit diff. Candidate 1.5.2 contains substantial core/bundle changes, including auth/runtime, HTTP dispatch, telemetry, package manager, skills, extension loader, settings, and bug-report code. This is a load-bearing and security-sensitive change; it is held.
- **herdr:** installed binary reports 0.9.5. No source checkout or pinned source ref was found in the instance configuration, and no authoritative newer herdr ref could be compared. No update applied.
- **npm extensions with newer registry releases:** `@99percentpeople/pi-thinking-fold` 0.1.11 → 0.1.12; `@narumitw/pi-btw` 0.63.5 → 0.63.8; `@signalridge/pi-goal` 1.4.8 → 1.7.1; `@timmyjl12/pi-model-picker` 0.2.0 → 0.2.1; `@xynogen/pix-voice` 0.2.12 → 0.2.13; `agents-cron` 0.18.0 → 0.18.2; `pi-copy-message` 4.0.12 → 4.0.15; `pi-hermes-memory` 0.10.0 → 0.11.0; `pi-pretty-tui` 0.2.9 → 0.3.6; `pi-web-access` 0.47.0 → 0.48.0. Registry reports also showed some lock/manifest inconsistencies; these were not silently normalised.

## Review and decision

**Nothing was applied.** The update gate requires an actual code diff, throwaway-lane proof, and rollback. This run could not establish all three safely:

- pi 1.5.0 → 1.5.2 is a broad core change touching load-bearing runtime, extension loading, credentials/auth, HTTP, skills, settings, and telemetry surfaces; a complete source diff and throwaway-lane proof are unavailable in this run.
- pi-goal 1.4.8 → 1.7.1 is load-bearing (`pi-goal`) and requires the fleet's goal acceptance proof before rollout.
- pi-hermes-memory 0.10.0 → 0.11.0 is load-bearing memory/session code and the package contains new process, SQLite, path, and content-scanning code; it needs dedicated review and proof.
- pi-web-access 0.47.0 → 0.48.0 changes network-capable MCP/readability tooling and dependencies; it needs dedicated review.
- Other candidates likewise were not promoted without per-package source diff and one-lane verification. No money, account, or consent operation was attempted.

Known-good installed pins remain in place. No reload/restart was needed because no code or package pin changed.
