# Batch 01 — five concurrent Fleet issues

Authority: operator cadence delivered by overlord 2026-11-10T20:39Z: up to FIVE dependency-compatible
issues with MULTIPLE CONCURRENT workers. Supersedes serial issue execution and between-EVERY-issue
compaction. NEW dated handoff and verified overlord same-session compaction BETWEEN BATCHES, plus
real context-threshold compaction. Old issue gates are historical receipts, not artificial blockers.
Per-issue acceptance, reviewed exact-commit gates, privacy/paid/auth/hold/release boundaries remain.
Leaders orchestrate; workers research/edit/test/integrate. No self-release of live controls.

## Issue ownership / concurrent graph

| Issue | Bead | Orchestration | Work ownership | True edges |
|---|---|---|---|---|
| FT18 memory review | swarm-c0l.9.3 | self-improvement-leader | ft18-memory-review: accepted-evidence documentary correction; prior audit artifacts immutable | initial audit → independent REVISE → corrected final review → parent verification |
| FT20 review failures | swarm-c0l.9.4 | self-improvement-leader | ft20-memory-errors: bounded read-only diagnosis, independent artifact directory | may read completed FT18 findings, NOT blocked on FT18 closure; any shared-memory code/live write requires later release |
| FT19 todo accumulation | swarm-c0l.9.22 | self-improvement-leader | ft19-todo-review: context-cost/retention review | independent from memory/rooms/tags; no cleanup or global policy edit in initial release |
| FT26 rooms delivery | swarm-c0l.9.5 | yellowstone-leader | two worker lanes coordinated by Yellowstone (one per issue), isolated worktrees | diagnosis → reviewed isolated implementation if needed → independent acceptance; canonical integration only after exactcommit acceptance |
| FT47 tool tags | swarm-c0l.9.6 | yellowstone-leader | separate worker/worktree from rooms | preserve accepted FT37 behavior; prose remains INERT, never execute parsed fakecalls; independent acceptance before integration |

All five issue strands can move concurrently. FT18 and FT20 may READ the same deployed memory package
but never write the live store/source in this initial release. FT19/FT26/FT47 use disjoint code/output
ownership. Canonical Yellowstone writes, subrepo pushes, root pushes, fleet config publication and live
operations serialize ONLY where actually conflicting, with named exactcommit releases coordinated
between leaders. No research mutex and no five workers waiting on a fabricated serial gate.

## Common initial worker boundaries

Read full assigned operator section `/home/bitnom/Documents/Assistant/Fleet TODOs.md`, applicable
AGENTS and role. Use graft for code understanding and literal exhaustive grep only. Inspect actual
runtime vs canonical source; don't assume bare npm/checkout/lockfiles/mtime prove deployment/history.
Preserve originals and unrelated dirt. Scratch output under issue-specific `.local/state/` directory.
No live store/config/skills/modes/profile edits, consolidation/review triggers/retention/cleanup,
consumer messages/reloads/restarts/session switches, package upgrades, network/billed validation,
accounts/credentials/consents, operator-file edits, or canonical commits/pushes under initial review
release. Ordinary own-bead/TODO records allowed; singlewriter parent owns batch queue/dagr/source
resolution. Workers don't inherit maintenance-pause grant. Wholew2/reservedwE:t19/historicalp1B held,
no pane-output inspection (including indirect transcript dumps). FT32 helper stays quarantined.

Private content: aggregates, short redacted examples, record IDs/hashes; no raw transcript/memory or
credentials in artifacts. Do not scan every private session if bounded event extraction answers it.
Avoid tool-result/pane-capture text for warning counts: structured actual-message provenance only.
No paid calls to reproduce extension behavior; local stubs/fixtures where justified and explicit.
Guard fires → stop/report, never weaken and apply. Any later isolated implementation release names
worktree/path/test boundary; never infer live operations or publication from it.

## Shared records

SI is single writer of own queue/Beads/run. A delegated documentary writer may append cadence
provenance and update current batch annotations, preserving source_file, old refreshes/mappings/
resolved evidence and gate history. No foreign epic mutation. `bd list` fleetwide; only own project:w1K.
No source headings marked resolved until per-issue evidence accepted. FT20 original title assumes
oversize failures.md causation: treat as hypothesis, not proven rootcause.

After FIVE issue acceptances or honest blockers, fan-in batch outcome; NEW live-session datedhandoff,
overlord same-session compaction + exactpathreadack + explicitcompletion before next batch. Genuine
context need may compact midbatch, preserving all worker releases and activework. Do not wait for
more operator nudges when eligible batch work remains.
