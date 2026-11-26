# Daily harness update check — 2026-11-14

## Result

No update was applied. The update probe temporarily installed newer npm packages; all moved extension pins were restored to their known-good versions. Pi remains 1.5.0 and Herdr remains 0.9.5.

## Detected movement

- **Pi:** installed `1.5.0`; registry offers `1.5.2`. The exact 1.5.0 → 1.5.2 package diff was inspected at the bundle/file level. It changes generated runtime/provider chunks and changelog; this is a load-bearing harness update touching core runtime, provider integrations, and codemode-related bundles. It was not installed because the required throwaway-lane proof was not completed in this run.
- **Herdr:** installed/server `0.9.5`, stable channel, server binary not stale. No newer ref was identified or applied.
- **Extensions moved in the registry/update probe:**
  - `@99percentpeople/pi-thinking-fold` 0.1.11 → 0.1.12
  - `@narumitw/pi-btw` 0.63.5 → 0.63.8
  - `@signalridge/pi-goal` 1.4.8 → 1.7.0
  - `@timmyjl12/pi-model-picker` 0.2.0 → 0.2.1
  - `@xynogen/pix-voice` 0.2.9 → 0.2.12
  - `pi-hermes-memory` 0.10.0 → 0.11.0
  - `pi-pretty-tui` 0.2.8 → 0.2.9
  - `pi-copy-message` 4.0.12 → 4.0.13

## Diff/security review

The downloaded package diffs were inspected for changed files and sensitive surfaces. No new postinstall scripts or obvious new network/credential/telemetry behavior was found in the reviewed hunks. Notable changes were:

- `pi-goal` adds a `context-overflow` module and is load-bearing for goal tools/contracts; held pending dedicated throwaway-lane verification.
- `pix-voice` adds a packaged skill and moves imports to `@xynogen/pi-runtime`/`@xynogen/pi-data`; it changes the voice/runtime dependency surface and was held.
- `pi-hermes-memory` adds and sanitizes `sessionIndexExclude` configuration and session-index filtering; it touches session discovery and was held.
- `pi-pretty-tui` changes diff rendering/layout and message-boundary handling; held.
- `pi-copy-message` 4.0.13 changes the Node engine requirement to Node >=24.22.3 or >=26.13.1, incompatible with this installed Node 22.23.3; held.
- `pi-btw`, model-picker, and thinking-fold had code/generated bundle changes; no one-lane proof was completed, so held.

The update check itself used `pi update --extensions --no-approve`, which installed the candidate versions. Known-good versions were then explicitly restored with npm `--no-save --package-lock=false --ignore-scripts`. Current installed package tree was re-read afterward.

## Verification and recommendation

- Verified current Pi: `1.5.0`.
- Verified current Herdr client/server: `0.9.5`, stable, `server_binary_stale: no`.
- Verified known-good extension directories are present after restoration.
- No reload/restart was performed because no candidate was applied.

Recommendation: schedule a dedicated canary review for Pi 1.5.2 and the load-bearing extensions, beginning with a disposable lane and exact tool/rooms/skills/goal checks. Do not accept `pi-copy-message` 4.0.13 until the fleet Node runtime is upgraded or the package engine requirement is otherwise resolved.
