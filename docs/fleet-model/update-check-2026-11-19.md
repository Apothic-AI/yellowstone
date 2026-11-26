# Daily update check — 2026-11-19

## Result
No harness update was applied. Herdr remains 0.9.5 and its launcher hash matches the durable pin 0555c1f58e0acb88f62785c675dc634df1441a58e8eb6470bb18105dba15747d. Pi is 1.5.0; registry has 1.5.2 available. All checked git-subrepo pins match upstream heads.

## Moved npm packages
Registry moves: @99percentpeople/pi-thinking-fold 0.1.11 → 0.1.12; @narumitw/pi-btw 0.63.5 → 0.63.8; @signalridge/pi-goal 1.4.8 → 1.7.1; @timmyjl12/pi-model-picker 0.2.0 → 0.2.1; @xynogen/pix-voice 0.2.12 → 0.2.13; agents-cron 0.18.0 → 0.18.2; pi-copy-message 4.0.12 → 4.0.15; pi-hermes-memory 0.10.0 → 0.11.0; pi-pretty-tui 0.2.9 → 0.3.6; pi-web-access 0.47.0 → 0.48.0. Pi 1.5.0 → 1.5.2 is also available.

## Review and disposition
Held all moves. Candidate metadata shows meaningful runtime/dependency changes: pi-goal changes pi-ui/pi-tui-kit dependencies; pi-hermes-memory uses better-sqlite3; pi-web-access changes dependencies and build/publish scripts; pi-pretty-tui adds regression/selection tests. These include load-bearing packages, and a complete source diff plus throwaway-lane proof was not completed in this run. No install, pin change, reload, or restart occurred. Known-good Herdr pin retained.

## Verification
Pi version 1.5.0; Herdr version 0.9.5; launcher hash equals the durable expected-binary hash; git-subrepo upstream comparison found no movement.
