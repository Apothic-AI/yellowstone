# Daily harness update check — 2026-11-17

## Decision: held; nothing applied

The check ran in the existing session; no session switch was made. No pi, herdr, or extension update was rolled out. The update probe temporarily installed registry candidates, then candidates were restored to their known-good installed versions. No reload or restart was performed.

## What moved

- Pi: installed 1.5.0, registry candidate 1.5.2. No Pi update was applied; the required disposable-lane proof was not run.
- Herdr: installed/serving 0.9.5, installed binary SHA-256 `0555c1f58e0acb88f62785c675dc634df1441a58e8eb6470bb18105dba15747d`. No herdr binary update was identified or applied.
- Registry candidates observed (installed → candidate): `@99percentpeople/pi-thinking-fold` 0.1.11→0.1.12; `@narumitw/pi-btw` 0.63.5→0.63.8; `@timmyjl12/pi-model-picker` 0.2.0→0.2.1; `@xynogen/pix-voice` 0.2.12→0.2.13; `pi-hermes-memory` 0.10.0→0.11.0; `pi-copy-message` 4.0.12→4.0.14; `pi-web-access` 0.47.0→0.48.0; `agents-cron` 0.18.0→0.18.2. `pi-goal` remained 1.4.8 and `pi-modes` remained 0.6.0.

## Review and hold reasons

- The probe reported Node-engine incompatibilities for `@spences10/pi-themes` and `pi-copy-message` 4.0.14; this fleet runs Node 22.23.3.
- Prior actual-diff review identified load-bearing or runtime-sensitive changes in Pi, voice/runtime, session indexing, TUI, and provider/runtime bundles. `pi-goal`, `pi-modes`, `pi-rooms`, `pi-persist`, and `pi-fleet-hooks` remain behind the one-lane proof gate.
- No throwaway lane was started today, so the required startup/rooms registration/skill resolution/goal-completion proof is absent. The gate therefore requires holding all candidates.
- Herdr was not changed: no reviewed new herdr release or rollback pair was established.

## Final verification

Pi still reports 1.5.0; herdr still reports 0.9.5; candidate package versions were restored to the known-good values listed above. No package pin was advanced, no fleet lane was reloaded, and no update is claimed successful.
