# Leader delegation default — bounded audit

Owner: self-improvement-leader. Request: overlord DM 12e3b602, reflecting the operator's renewed delegation directive (2026-11-07 original).

This is useful parallel work while FT-37 implementation is in progress, not a request to spawn lanes or change anyone's objective. Use the existing ft-todos-triage worker only.

## Deliverable

Write `/home/bitnom/Documents/Fleet/pi-fleet-model/LEADER-DELEGATION-AUDIT.md`, concise and evidence-first. Read-only except that report. No mode/config/profile changes, reapproval, reload, restarts, goals, prompts, DMs to other spaces, infra, paid resources, or new workers.

## Questions

1. Inspect global `~/.pi/agent/modes/leader.json` and operator memory/directive (2026-11-07). It already says `Default to spawning a worker` and contains the self-signal `reaching for a command, a file open, or a research pass ... not your own brief`. Identify the MINIMAL ADDITIVE change that makes an explicit narrow exception for brief leader-owned decisions/verification/config work, keeps bounded verifiable work delegated by default, reuses suitable existing workers, and avoids manufacturing workers when there is no useful deliverable. Preserve all existing text; do not rewrite the contract or accidentally relax the default. Propose exact addition only.
2. Read supported pi-modes observability/CLI docs and inspect effective LIVE selections/fingerprints for current leader lanes. Historical system preamble markers alone are insufficient: session records may predate refreshed instances. Do not infer drift or loss merely from a marker missing in an old preamble. Use package CLI / reconciler DRY RUN; no mutation. Report scope, exclusions, actual source paths and genuine mismatches/unknowns. Source is `~/.pi/agent/modes/leader.json`, runtime modes may be materialized copies. Do not edit instance files.
3. Report safe propagation plan for the proposed final global edit: one-lane proof then refresh/reapprove/reload as required, queue for working lanes, no Esc/abort; use supported tools. Do not execute rollout.
4. Report what bounded work is currently feasible to delegate from leaders' active objectives/claims, using a compact live roster + beads graph and only narrow artifact/last-output reads as necessary. A `working` field alone is not progress. Preserve holds and objectives; distinguish active execution, operator wait, no bounded work, and unknown. Do NOT hand out tasks or spawn workers; this is a feasibility report, not a new fleet work plan.

## Evidence and limits

Use machine `date -u`, explicit pane/session/source, and name what each check covers. Keep output bounded; no exhaustive full-session reads or full-history corpus scans. Existing helpers under `~/.overlord/tools`: `mode-composed-digest.mjs`, `reconcile-mode.py`, `propagate-mode-change.py`, `defer-mode-reapprove.py`, `reload-fleet`; inspect semantics before using even dry-run. Relevant package is canonical Yellowstone `src/pi-extensions/pi-modes`; own AGENTS.md first. Never resolve a live question by grepping raw session text for a quoted prompt marker.

Send only the report path and high-impact findings to self-improvement-leader. Do not close the leader's local TODOs or claim another space's epic.
