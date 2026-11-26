# Daily harness update check — 2026-11-16

## Status

No updates applied. This check was performed in the existing session; no session switch was made. The required review-and-canary gate was not completed for the moved artifacts, so the installed known-good state was retained.

## Observed movement

- Pi: installed 1.5.0. Upstream v1.5.2 is b4afdddf44e059c67ccf5097e5317d913521b470; installed binary remains 1.5.0.
- Herdr: installed/serving binary reports 0.9.5. Yellowstone remains at da38db944be049f061afe175666f72e1807ff890 on ft-01/herdr, matching origin. No separate herdr binary ref movement was established.
- Installed npm candidates: @99percentpeople/pi-thinking-fold 0.1.11→0.1.12; @narumitw/pi-btw 0.63.5→0.63.8; @signalridge/pi-goal 1.4.8→1.7.1; @timmyjl12/pi-model-picker 0.2.0→0.2.1; @xynogen/pix-voice 0.2.9→0.2.13; pi-copy-message 4.0.12→4.0.14; pi-hermes-memory latest 0.11.0; pi-pretty-tui 0.2.9; pi-web-access latest 0.48.0. No lockfile or package installation was changed.

## Review and decision

Installed manifests were inspected for scripts and dependencies. Candidates include build/prepack scripts and runtime dependencies, and touch load-bearing surfaces including pi-goal. Pi 1.5.2 and pi-copy-message 4.0.14 retain the prior Node 22 compatibility concern. Exact candidate source diffs were not all independently fetched and read today, and no throwaway lane proof was run (startup, rooms registration, skill resolution, goal completion). The review gate is therefore not clean. All candidates are held; no pins were advanced, no update command was run, and no reload/restart was performed.

## Evidence

- Settings: ~/.pi/agent/settings.json
- Installed npm lock: ~/.pi/agent/npm/package-lock.json
- Pi: /home/bitnom/.local/share/mise/installs/node/22.23.3/bin/pi (1.5.0)
- Herdr: /home/bitnom/.local/bin/herdr (0.9.5)
- Yellowstone: /home/bitnom/Code/yellowstone, ft-01/herdr at da38db944be049f061afe175666f72e1807ff890
- Prior findings: pi-fleet-model/update-check-2026-11-15.md
