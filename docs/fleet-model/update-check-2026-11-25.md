# Daily update check — 2026-11-25

## Scope and method

Checked runtime pins in /home/bitnom/.pi/agent/settings.json, the resolved npm lockfile and instance directory, the installed pi package, cached git package repositories, and the Yellowstone Herdr source ref. Compared candidate npm tarballs against currently pinned versions.

## Movement found

- pi: installed @earendil-works/pi-coding-agent 1.5.0; npm offers 1.6.1.
- herdr: installed CLI reports 0.9.5. No newer Herdr ref was identified locally; Yellowstone remained at 99ad540994ea1ea5fd82d13e7fe6fcc5dbc88dc after fetch.
- npm candidates: @99percentpeople/pi-thinking-fold 0.1.11 -> 0.1.12; @narumitw/pi-btw 0.63.5 -> 0.63.9; @signalridge/pi-goal 1.4.8 -> 1.7.1; @timmyjl12/pi-model-picker 0.2.0 -> 0.2.1; @xynogen/pix-voice 0.2.12 -> 0.2.14; agents-cron 0.18.0 -> 0.18.2; pi-auto-compact 1.3.1 -> 1.4.0; pi-copy-message 4.0.12 -> 4.0.16; pi-hermes-memory 0.10.0 -> 0.11.0; pi-web-access 0.47.0 -> 0.48.0; pi-pretty-tui 0.2.9 -> 0.3.7.

## Review summary

- pi-goal 1.7.1 changes goal runtime, commands, settings and lifecycle, adds context-overflow handling, updates Pi/TUI dependencies, and writes goal/settings state. It touches the load-bearing goal completion contract.
- pi-hermes-memory 0.11.0 changes session indexing/parsing, SQLite store, config and handlers; it requires migration/indexing proof.
- agents-cron 0.18.2 changes CLI, scheduler/dashboard formatting and notifications.
- pix-voice 0.2.14 retains credential-bearing provider HTTP calls and audio/text writes.
- pi-model-picker writes model/agent state and reads environment/config paths.
- pi-auto-compact and pi-web-access are runtime-integrated.
- pi 1.6.1 is a broad host/runtime diff across bundled runtime, tools, auth/bug-report/telemetry surfaces and dependencies.

## Decision

Applied: none. Existing known-good pins were preserved. The complete gate was not met because no throwaway-lane proof and affected-lane reload/restart verification were completed; several candidates touch load-bearing or credential/network surfaces. No rollback was needed.

Recommendation: stage a disposable lane next, prove pi first, then load-bearing extensions individually before changing pins.
