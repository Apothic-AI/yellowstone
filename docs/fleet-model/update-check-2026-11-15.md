# Daily harness update check — 2026-11-15

## Status: incomplete; no updates applied

The check was performed in the existing session; no session switch was made. Installed packages and binaries were not modified. The review and disposable-lane proof remain incomplete, so these findings must not be treated as authorization to upgrade. The existing npm declarations are ranges, not durable exact pins: the current installed versions were retained, but have **not** been converted to exact version declarations in this run.

## Observed candidates

- Pi installed `1.5.0`; registry `1.5.2`. The previous check reported a bundle-level diff touching runtime/provider and codemode bundles, but the disposable-lane test was not performed. Hold pending full review and canary.
- Herdr reports client/server `0.9.5`, with no stale server binary. The installed Yellowstone subrepo pins `Apothic-AI/herdr` branch `apothic-main` at `501275a38e7f59e1b4704d95d98fb386c6afddcb`; its remote branch reports that same SHA. This establishes the source pin has not moved, not the precise provenance of the serving binary.
- Active npm candidates (installed → registry candidate): `@99percentpeople/pi-thinking-fold 0.1.11→0.1.12` (extension disabled); `@narumitw/pi-btw 0.63.5→0.63.8`; `@timmyjl12/pi-model-picker 0.2.0→0.2.1`; `@xynogen/pix-voice 0.2.9→0.2.12`; `pi-hermes-memory 0.10.0→0.11.0`; `pi-copy-message 4.0.12→4.0.14` (npm's `wanted`, despite its `latest` tag pointing to 2.1.0). `@spences10/pi-themes` latest tag points backward from installed 0.0.11 to 0.0.3, not an upgrade.
- The 11 Yellowstone extension subrepo branch tips checked, including `pi-rooms`, `pi-persist`, `pi-goal`, `pi-modes`, `pi-fleet-hooks`, and `pi-profile-switch`, matched their `.gitrepo` commits. `pi-parameter-tools` is local Yellowstone source without a `.gitrepo`; local Yellowstone HEAD was `75a7bcf073d2225cb47f616ada132cc11cd1ee49`. Remote default HEAD `4a47e4577ede2627d30a744156238f6a899504f5` was an ancestor of that local commit, not a forward update.

## Review and holds

- The actual `pi-copy-message` 4.0.12→4.0.14 npm package diff adds `stripTerminalSequences` from `@earendil-works/pi-tui` to preview sanitization, raises the Pi development dependency from 1.5.0 to 1.5.2, and changes the Node engine requirement to `>=24.22.3 <25 || >=26.13.1`. The inspected diff has no new network, credential, environment, telemetry, lifecycle script, or external-write behavior. This machine runs Node 22.23.3; hold for runtime compatibility and Pi upgrade. Diff: `/tmp/fleet-copy-message-4014.diff` (temporary artifact).
- The 2026-11-14 check reported actual package-diff review of the other unchanged candidates: voice changed runtime dependencies; memory changed session-index filtering; btw, model-picker, and thinking-fold changed code/bundles. It reported no new postinstall or obvious new network/credential/telemetry behavior in reviewed hunks. Those observations have not been independently revalidated in full today; the required canary has not been run. Hold all.
- The registry `npm outdated --all` results also contain transitive changes; only configured direct npm sources were summarized above. The first formatting command failed after writing the JSON, which was subsequently parsed successfully. The nonzero `npm outdated` result is expected when packages are outdated.

## Recommendation and limitations

Perform full exact-artifact review for each candidate and a disposable-lane test (startup, rooms registration, skill resolution, goal completion), establish rollback and exact persistent pins, then roll out only verified changes. In particular, do not update `pi-copy-message` on the present Node/Pi versions. This run did not establish exact package pins or independently inspect every candidate diff, and did not perform the required canary or fleet rollout. No success is claimed for those steps.
