# FT18 — independent read-only acceptance review

Worker: `ft18-memory-review`. Parent `swarm-c0l.9.3`; child in prompt.
Review the completed `ft18-memory-audit` deliverable, do not duplicate the whole investigation.
Primary artifacts: `/home/bitnom/.local/state/ft18-memory-review/{review.md,evidence-index.md,provenance.json,store-inventory-v2.json,projects-inventory.json,content-shape.json,snapshot-size-series.json}` plus scripts/pre-postfingerprints/superseded measurements there.
Original release: `/home/bitnom/Documents/Fleet/pi-fleet-model/FT-18-MEMORY-REVIEW-BRIEF.md`.
Operator FT18 in `/home/bitnom/Documents/Assistant/Fleet TODOs.md`: review what memory stores and whether it is doing a good job. FT20 transport-failure implementation is separate, not released.

## Deliverable / release

Write ONLY new artifacts under `/home/bitnom/.local/state/ft18-independent-review/`, ending in
`review.md` with ACCEPT / REVISE / BLOCK verdict, mechanical receipts/limitations and proposed exact
corrections where necessary. Original report/evidence/code/stores remain immutable. STOP after report.
Do not edit live store/config/source/doc/operatorfile, consolidate, review-trigger, index/optimize/
VACUUM/checkpoint, set retention, run model calls, network, install/update packages, commit/push,
launch agents or operate any consumer. No maintenance authority inheritance. No FT32 controls/helper.
Wholew2 and reservedwE:t19/historicalp1B held, including no pane-output inspection. Private content
stays private: use aggregates/identifiers/redacted bounded examples, no raw memory/transcript export.

This is evidence review, not a request to make every observation into an implementation. The current
operator request is a review; justify whether corrected review+documented recommendations satisfies
it without billing, destructive cleanup, or unrelated feature expansion. Any genuinely necessary
narrow in-scope non-destructive change is a candidate for a later explicit release, not this one.

## Questions raised by parent read — verify independently

1. Verify actual deployed memory runtime and store joins, default config/behavior from the package
   and broader package surface (graft for understanding; grep only exhaustive literal enumeration).
   Does 30profile symlinks→1root correctly cover active runtime? Distinguish sessions index vs memory,
   recovery copies vs active bytes, project root lock DB vs per-project data. Verify scope/count
   arithmetic, note live races and units (SQLite length(TEXT) is characters, not UTF8 bytes).
2. Report says live corpus5,766,330B versus scratch5,807,954B then "same corpus"/~93MB reclaimable.
   Determine exact provenance/instrument/snapshot/id/text/index-building differences. Clean build
   vs live delta alone does not prove corruption, exact reclaimability or correct maintenance fix.
   DO NOT perform live optimize/rebuild/VACUUM; audit existing receipts and if a bounded scratch
   experiment is necessary preserve privacy/check disk/no persistent raw exports. Label no proof
   rather than turning an estimate into certainty.
3. Empty lock table + large WAL is called "unambiguously a leak" with "trivial fix". Check actual
   lock implementation, checkpoint policy, concurrent-reader/multipleprocess behavior and time
   evidence. Can a one-time footprint prove a leak or missingcheckpoint, or expectedtraffic/reader
   retention? No live checkpoint. Specify unproven mechanisms and tests, not invented cause.
4. What does hit_count/last_hit mean and when was tracking introduced/reset/reconciled? Low returned
   result fraction does not establish unused facts or retrievalquality. Test bounded safe read-only
   queries only if not themselves recording hits; no memory_search invocation if it mutates counters.
   Is the 20entry quality sample reproducible and sufficient across global/user/failure/projects?
   Avoid "nothing wrong"/"quality fine" overreach from bounded samples; report honest coverage.
5. Verify exact/no-nearduplicate and budget claims with scope/exclusions: normalize delimiter/metadata,
   6largeststores vs entire corpus, entry vs pair percentages, policy-only documented uncapped behavior
   vs violated budgets. Are both memory mirror/markdown counts identity-consistent or merely equal?
6. Package mtimes/stale lock entries cannot alone prove which version wrote historic snapshots or
   exact install/update times. Review report claims 0.9.11wrotepreNov6 + startupnotices realNov9update,
   "no canonical source/no localpin" and history. Use actual authoritative package manifests/paths/
   content/installed dependency provenance; distinguish fullpackage survey from one source directory.
   Record unknowns, don't manufacture an unauthorized-update incident from mtime alone.
7. Auto-review notice: verify ALL entrypoints and direct/fallback behavior, receipt persistence
   package-wide (not justsrc), and what old snapshots/metadata can actually attribute. FT20 cause
   remains not implemented. Attribution of incidental writes must not overclaim from changing WAL.
8. Verify original worker adhered to read-only/privacy scope from its actual commands/outputs in its
   session if needed, bounded to this assignment: selectedsession
   `/home/bitnom/.pi/agent/sessions/--home-bitnom-Documents-Fleet--/2026-11-10T19-58-32-983Z_01a1c70a-7216-72f2-8a71-c07185de185d.jsonl`.
   It claimed ownbead but child remainedopen/nojoin at20:21:40. Do not treat that claim as true;
   report scope/metadata issue if verified, no need to fix anotherworker's record. Warn if creating
   scratch memory copies/privacy exposures or prohibited pane content happened, without reproducing
   private text or treating a discarded count as proof none was read.

Claim only your assigned child and verify bdshow metadata pane/session; actual join matters. No
parent/epicwrites. Confirm rolecomposition via ownprompt/currentmode authority; do not infer fromfooter.
Choose minimum bounded checks that prove or reject the material conclusions. Preserve failed and
superseded evidence; no test relaxation or baseline-red waivers. All recommendations must separate
already-supported findings, inferred mechanisms, destructive/billing boundaries and implementation
acceptance tests. A report can ACCEPT the review objective while rejecting unsupported subclaims.
