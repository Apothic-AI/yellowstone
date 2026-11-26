# Worker assignment: live unresolved Fleet TODO queue

Owner self-improvement-leader. Operator's latest instruction supersedes any completion assumption:
after FT-37, resolve ALL unresolved issues in `/home/bitnom/Documents/Assistant/Fleet TODOs.md`.
Both self-improvement-leader and yellowstone-leader orchestrate; workers own research and integration.
All code/config changes must be integrated in Yellowstone. Between EVERY issue, leader explicitly
requests overlord compaction and waits for same-session confirmation + read/resume acknowledgment.

## Bounded deliverable — queue reconciliation only, not execution of the next issue

Reuse the existing triage, inspect the CURRENT complete operator file, and map its actual unresolved
sections into the shared Beads tracker (`project:w1K`, parent `swarm-c0l`). Do not create duplicates;
search before creating. Use an orchestration epic/task for the entire queue and per-issue tasks only
where useful. If a single old task already represents an issue, link it instead of replacing it.
Record the exact source title/line, current status, priority, dependency/blocker, proposed worker-owned
scope, and acceptance proof. Count from this traversal (completed sections excluded), not the older
39-item triage. Distinguish unresolved, verified already satisfied, and ambiguous/held; do not resolve
or label any issue complete merely because the old triage said it could close.

Report a concise ordered queue and bead IDs in `pi-fleet-model/FLEET-ISSUE-QUEUE.json` and a short
`FLEET-ISSUE-QUEUE-REPORT.md`. The task graph in Beads is the durable source of truth; the JSON is
its source-file reconciliation/export, not a separate competing tracker.

No source issue edits yet; `~/Documents/Assistant` is not a git repo. No implementation/research of
individual issues, no fleet mutation, no package/config/mode edits, no code integration, no goals,
no paid calls, no other-lane prompts. No next issue starts before the FT-37 boundary compaction.
Merely prepare this queue while FT-37 is active. Preserve genuine paid/auth/hold constraints; flag
prior FT-45/48/49 deferrals against the latest all-unresolved instruction for leader reconciliation.
Do not silently omit those issues or infer authorization for paid/destructive actions.

When later closure happens, integration workers must update the operator's item with verified
closure evidence and ensure implementation/config/docs are in Yellowstone, with no personal data
copied into the template. Every next-issue handoff must include the operator compaction gate.

Return absolute report/JSON paths plus umbrella and per-issue bead IDs. No room chatter.
