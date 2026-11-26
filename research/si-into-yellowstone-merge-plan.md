# Merge self-improvement (SI) into Yellowstone — plan (REVISED)

**Status:** plan only, for the operator's approval. Nothing here has been executed.
**Date:** 2026-11-25, revised same day after the operator's correction.
**Author:** Muse, from live inspection of both spaces on vici.
**Goal:** retire the self-improvement-leader lane entirely and have
yellowstone-leader assume ALL of its roles and responsibilities. This is a
merge of two leaders into one lane — not a relocation. Moving the SI lane into
the Yellowstone space as a second lane would not have the intended effect: the
waste is two leader lanes carrying overlapping role context, not the workspace
address. One lane, one context, one beads DB, one mode composition.

## 0. Why (the operator's reason, confirmed by inspection)

- **Two leaders, overlapping context.** The SI lane loads its own 20K
  `AGENTS.md`, `pi-fleet-model/` (4.5M on disk), `SKILLS-INVENTORY.md`, and
  `continuations/` — much of it duplicating what Yellowstone already holds
  (`fleet-skills`, `pi-fleet-hooks`, modes, pins). SI then works on Yellowstone
  code from *outside* the repo, re-reading files across the workspace boundary.
  Yellowstone-leader loads its own overlapping set. Two lanes, two contexts,
  constant cross-lane coordination.
- **Two beads databases.** Fleet `.beads/` and Yellowstone `.beads/` are separate
  dolt-backed stores. SI's beads (`swarm-*`) and Yellowstone's beads live apart.
- **Two mode compositions to keep in sync.** The Fleet space defines the leader
  role contract in its own `.pi/modes/`; Yellowstone defines role deltas in its
  own `.pi/modes/`. Mode drift already bit once (FT-91: composition dropped,
  lane ran on the native prompt while the footer still read `profile: leader`).
- Yellowstone is already the consolidated fleet repo. SI predates that
  consolidation; the lane and its space are the leftover.

## 1. What each space actually is (measured 2026-11-25)

### SI space — Herdr `w1K`, root `/home/bitnom/Documents/Fleet`
- **Lanes:** `self-improvement-leader` (w1K:p1, working) and
  `pi-auto-translate-dev` (w1K, idle — but its cwd is already
  `/home/bitnom/Code/pi-auto-translate`, outside Fleet).
- **Contents:** `AGENTS.md` (20K, mostly mode-composition / drift docs),
  `.agents/`, `.beads/` (dolt), `.claude/`, `.dagr/`, `.pi/` (`briefs/`,
  `launch.env`, `modes/`, `pi-persist.json`, `pi-modes-cli.secret`),
  `.worktrees/`, `continuations/` (72K), `notes/` (`translate-extension-brief.md`),
  `os/` (`blockers.md`, `cron/`, `skills/`), `pi-fleet-model/` (4.5M:
  `CURRENT-STATE-herdr-pin-drift.md`, `fleet-configuration-model*.md`,
  `FLEET-ISSUE-QUEUE.json`, `DELEGATION-PROTOCOL.md`, `evidence/`,
  `artefacts/`, `EXECUTION-RECORD.md`), `SKILLS-INVENTORY.md`,
  `skills-lock.json`, `translate-extension-recommendation.md`, `node_modules/`.
- **Role (from its own mode text):** "the lane that owns the harness this fleet
  runs on: `pi`, `herdr`, the launcher and profiles, the modes, skills, hooks,
  and the fleet's configuration record in `pi-fleet-model/`."
- **Owns right now:** termination-lag observer + decision-model eval (beads
  `swarm-idq`, `swarm-rfp` — stage 2 not started), Neon escalation assessment
  (DEFERRED), Neon cache-busting investigation (done; fix applied),
  message-level datetime bead (being created), pi-auto-compact / compaction
  design, subrouterctl token-masking bead (`swarm-7vs`, open).

### Yellowstone space — Herdr `w17`, root `/home/bitnom/Code/yellowstone`
- **Lanes:** `yellowstone-leader`, `ft35-toggle-scope` (worktree),
  `ft94-pi-ai-jitter` (worktree).
- **Contents:** git-subrepo monorepo — `src/` (18 subrepos), `home/` (literal
  `$HOME` mirror, incl. the global `AGENTS.md` core), `skills/`, `docs/`,
  `scripts/`, `herdr/`, `spaces/`, `test/`, `yellowstone-skill/`, `.beads/`
  (dolt, separate from Fleet's).
- **Its `AGENTS.md` is a pointer** to the global `~/AGENTS.md` core, not a
  second copy. Role deltas live in `.pi/modes/<role>.json`.

### References to `Documents/Fleet` elsewhere (must be updated, §6)
`~/.overlord/tools/land-mode-fixes.sh`, `~/.overlord/tools/si-batch-dispatch.py`,
`~/.overlord/tools/session-path-test/VERIFICATION.md`, `~/.overlord/AGENTS.md`,
`~/.overlord/coordination-log.md`,
`~/.overlord/SESSION-RESUME-INCIDENT-2026-11-03.md`,
`~/.pi/agent/mode-approvals.json`, `~/.pi/agent/trust.json`.
Overlord's own continuations for SI (`~/.overlord/continuations/self-improvement-leader-*.md`)
stay with overlord regardless — they are not part of either space.

## 2. What transfers to yellowstone-leader (the whole of SI's job)

- **Harness ownership:** `pi`, `herdr`, launcher/profiles, modes, skills,
  hooks, and the fleet configuration record (`pi-fleet-model/`).
- **Open work:** termination-lag stage 2 (decision-model shadow eval, bead
  `swarm-rfp`, not started), Neon escalation assessment (DEFERRED — its
  economics now depend on the cache fix), message-level datetime bead
  (being created), subrouterctl token-masking fix (bead `swarm-7vs`, open),
  cache-verification follow-up (confirm the fix holds on live Neon runs).
- **Standing knowledge:** compaction design (flat 40%, config-generic
  thresholds), the termination-lag observer (prompt-based steering only, no
  code snapshots), the Laminar remember-only note, the Neon cost baselines
  (Subrouter, not official).
- **What does NOT transfer:** the SI lane itself, its session, its Fleet
  workspace. Those retire. `pi-auto-translate-dev` is not SI's job — see §3.2.

## 3. Decisions needed from the operator before execution

1. ~~SI keeps its role and name~~ — **answered 2026-11-25 ~21:05 EST: no.
   Yellowstone-leader assumes all SI roles and responsibilities; the SI lane
   retires.** (This revision reflects that answer.)
2. **`pi-auto-translate-dev` disposition — DEFERRED (operator, 2026-11-25).**
   The pi-auto-translate effort hasn't been fully realized yet and isn't
   important right now. The lane stays parked idle in `w1K` as-is, and the
   `w1K` workspace itself is NOT removed until the effort resumes and its
   disposition is decided (see Step 6 note). Its docs
   (`notes/translate-extension-brief.md`,
   `translate-extension-recommendation.md`) stay with the parked effort.
3. **Beads — DECIDED: migrate (operator, 2026-11-25).** Finding from
   inspection the same day: there is no separate Fleet beads database to
   move. Both `.beads` directories are front-ends to ONE shared dolt server
   database (`swarm` on 127.0.0.1:3307) — `bd status` reports identical
   counts from either directory (488 total, 164 open, 5 in progress,
   28 blocked, 306 closed). So migration is: verify the open SI beads are
   visible from Yellowstone, re-assign their ownership to
   yellowstone-leader, and let the Fleet `.beads` directory retire with the
   archive. No export/import is needed. Fallbacks if the shared server is
   ever unavailable: `bd export` to JSONL + `bd import` (upsert round-trip,
   IDs preserved) and `bd backup` for a full database backup.
4. **Fleet directory — DECIDED: keep it, delete later (operator, 2026-11-25).**
   Moving the agent stuff out does NOT mean deleting or retiring the Fleet
   directory. It lives in the Documents folder because that is the
   operator's Obsidian vault, and it stays browsable/manageable there.
   A Herdr space can't cleanly span two directories (a lane can technically
   sit elsewhere, but it is not good practice), which is why the agent work
   moves — but the directory itself stays put through the merge and a soak
   period. Retire and delete it only after the merge has been tested for a
   while and the operator says so; that is a separate, later decision, not
   part of this merge. Backup already taken 2026-11-25 (before the merge
   runs): the Fleet dir (14M) was rsynced to
   `/media/bitnom/TRANNY/bitnom/Documents/Fleet/` and verified identical by
   file list. Note: there is no `~/.fleet` directory — the backup is of
   `/home/bitnom/Documents/Fleet`. Note also that the TRANNY drive is 97%
   full (15G free of 469G), so it is a safety net for this small backup,
   not headroom for large ones.

## 4. Sequencing (in order — each step verifies before the next)

### Step 1 — Freeze and inventory (overlord coordinates, SI executes)
- SI finishes or parks in-flight work first: the cache-verification capture
  and the message-level datetime bead (both open as of 2026-11-25 ~18:20 EST).
  No new SI work starts in the Fleet space after the freeze.
- Inventory: open Fleet beads with status/owner, open todos in the SI lane,
  uncommitted changes under Fleet, and anything in `pi-fleet-model/` newer
  than its Yellowstone equivalent. Record the inventory in the merge record
  (a file under Yellowstone `docs/`, see §5).

### Step 2 — Handover continuation (SI writes, yellowstone-leader reads)
- SI writes a fresh dated handover file from scratch
  (`~/.overlord/continuations/self-improvement-leader-handover-YYYY-MM-DDTHHMMZ.md`,
  UTC timestamp in the filename — never an edit/append to the base pointer
  file), addressed to yellowstone-leader: objective, decisions, open threads
  (termination-lag stage 2, Neon escalation assessment + its cache
  dependency, datetime bead, token-masking bead, cache verification),
  no-go reminders, and the bead map from Step 1.
- Yellowstone-leader reads it and replies confirming what it has taken on
  and what is unclear. The handover is not complete until YL says it is —
  a continuation nobody is pointed at is a file, not a state.

### Step 3 — Merge the role contract and config (yellowstone-leader owns, SI reviews)
- SI's Fleet `AGENTS.md` role contract and mode-composition notes merge into
  Yellowstone's setup: the role text goes into Yellowstone's `.pi/modes/`
  leader composition (role deltas live in `.pi/modes/<role>.json` with
  `promptStrategy: "append"`); the drift-check documentation goes with it.
  Yellowstone's `AGENTS.md` stays a pointer to the global core — the merged
  role text must not become a second copy of it.
- Fleet `.pi/pi-persist.json` `authority_and_ownership` item → the
  Yellowstone `.pi/pi-persist.json` (or the global one if that is where it
  belongs — decide during the merge; do not duplicate it in both).
- `launch.env`, `.pi/briefs/` → their Yellowstone equivalents.
- Verify with `~/.overlord/tools/reconcile-mode.py --inspect`: verdict must
  be `match` for yellowstone-leader with the merged composition. If it reports
  `drift`, re-approve with `/mode-reapprove --confirm-project` — do not run
  the lane on a dropped composition.

### Step 4 — Beads: verify, re-own, retire the Fleet front-end (yellowstone-leader + SI)
- The beads already live in one shared dolt server database (`swarm` on
  127.0.0.1:3307); both `.beads` directories see the same 488 issues.
  Nothing is exported or imported. From Yellowstone, verify the open SI
  beads (`swarm-*` and any others SI owns) are visible with correct status,
  then re-assign their ownership to yellowstone-leader.
- Check bead content for Fleet-specific paths (`Documents/Fleet`) in
  descriptions/notes and update those references to their new homes.
- The Fleet `.beads` directory can stay or go with the Fleet dir (Step 6) —
  it is only a front-end to the shared database, so either is harmless. The
  shared database itself is untouched — this step changes ownership and
  references, not where the data lives.
- Verify: `bd list` from Yellowstone shows the SI beads with correct status
  and owner, and yellowstone-leader can read/update them. If the shared
  server is ever unavailable, the fallback is `bd export` (JSONL) from Fleet
  + `bd import` into Yellowstone (upsert, IDs preserved).

### Step 5 — Merge the docs (yellowstone-leader, SI reviews)
- `pi-fleet-model/` → Yellowstone `docs/fleet-model/` (new home for the
  configuration record, CURRENT-STATE docs, DELEGATION-PROTOCOL,
  FLEET-ISSUE-QUEUE). Keep filenames; fix internal relative links.
- `continuations/` → archive with the Fleet dir (§7); the *live* handover
  chain stays in `~/.overlord/continuations/` where it already is.
- `notes/translate-extension-brief.md` and
  `translate-extension-recommendation.md` → with `pi-auto-translate-dev`
  (its repo/workspace), not Yellowstone.
- `SKILLS-INVENTORY.md`, `skills-lock.json`, `os/` → Yellowstone `skills/`
  or `docs/` as appropriate; delete if Yellowstone already holds the same
  record (note the dedup in the merge record).
- `os/cron/` → check against live crons first; do not re-install anything
  already running.

### Step 6 — Retarget, retire, archive (overlord)
- Retarget every reference in §1 from SI to yellowstone-leader:
  `si-batch-dispatch.py` (overlord's dispatch path — the hot one: if this
  still points at the SI lane, SI's work stops arriving anywhere),
  `land-mode-fixes.sh`, overlord `AGENTS.md`, `coordination-log.md`,
  `mode-approvals.json`, `trust.json`, and any `leader-board.py` Fleet paths.
  Grep the whole of `~/.overlord`, `~/.pi/agent`, and Yellowstone for
  `Documents/Fleet` and for `self-improvement-leader` after the edit and
  clear the stragglers. Anything that dispatched to SI must now dispatch to
  yellowstone-leader; anything that only mentioned SI historically stays as
  history and is marked as such.
- `pi-auto-translate-dev` stays parked idle in `w1K` (§3.2, deferred) —
  do not move it now.
- Retire the SI lane: close the `w1K` pane only after yellowstone-leader has
  run at least one former-SI task end-to-end (§7 verification). Do NOT remove
  workspace `w1K` itself yet: it still hosts the parked pi-auto-translate-dev
  lane. `w1K` removal waits until the pi-auto-translate effort resumes and
  its disposition is decided.
- The Fleet directory itself is NOT archived or deleted in this merge (§3.4):
  it stays in place in the Documents folder (the operator's Obsidian vault).
  Only the agent stuff moves out. Retiring and deleting the directory is a
  separate later decision, after the merge has been tested for a while.

### Step 7 — Verify (Muse's hourly check + overlord)
- Mode composition `match` on yellowstone-leader with the merged contract
  (Step 3 check, repeated).
- Yellowstone-leader completes one former-SI task end-to-end — proposed
  probe: re-run the Neon cache-verification capture and confirm the
  `<pi_context>` block is still static-only, or finish the message-level
  datetime bead. This exercises the merged config, the migrated beads, and
  the handover in one pass.
- Overlord's leader board shows no lane named self-improvement-leader, no
  BLOCKED / STALE / GONE, and its 15-minute wake fires normally.
- Muse's hourly check (now oversight-of-overlord) confirms all of the above
  over two consecutive runs, then goes quiet.
- Soak: yellowstone-leader runs former-SI work for a while from its new home
  before anyone touches the Fleet directory. Deleting the directory is a
  separate decision for later, when the operator judges the merge proven —
  not part of this merge and not on a fixed date.

## 5. What the merge record must contain (written first, updated as it goes)
- The Step 1 inventory (open beads, open todos, uncommitted changes).
- The handover file path and YL's confirmation.
- The bead old→new ID map, if any.
- The doc dedup notes (what was deleted as already-held by Yellowstone).
- The Fleet dir stays in place (§3.4); its TRANNY backup location.
- The verification results from Step 7.

## 6. Ownership
- **Overlord** coordinates and owns Steps 1, 6, and the reference sweep.
- **Self-improvement-leader** executes the freeze, inventory, and handover
  (Steps 1–2) and reviews the merges — then retires.
- **Yellowstone-leader** owns the merged role and everything landing in the
  repo (Steps 3–5), per the normal gate rules, and proves the merge with the
  Step 7 probe.
- **Muse** watches via the hourly check and reports only if oversight fails.

## 7. Risks and mitigations
- **Handover loss.** The whole merge hinges on Step 2. Mitigated by the dated
  handover file + YL's explicit confirmation, and by migrating the beads
  (the work itself carries its state). Rollback: the old `w1K` pane is
  untouched until YL proves itself.
- **Yellowstone-leader's context grows.** Absorbing SI's role contract and
  open threads makes YL's turns bigger and more frequent. CORRECTION
  (2026-11-25, operator): YL no longer runs gpt-6.2-sol — the operator
  switched it back to the fleet default (DeepSeek V4.1 Flash 1017); the GPT
  run was temporary. So the cost concern is much smaller than first written:
  the saving is one lane's whole duplicated context plus the cross-lane
  coordination, landing on the cheap model. Still watch YL's context on the
  first merged tasks; the flat-40% compaction is already in force fleet-wide.
- **Mode digest drift blocking the merged composition.** Two leader
  compositions into one is exactly the shape that drifts. Mitigated by the
  `reconcile-mode.py --inspect` check and re-approval before any real work.
  This is the FT-91 failure mode; do not skip the check.
- **A missed dispatch reference.** Mitigated by the post-edit grep sweep in
  Step 6. `si-batch-dispatch.py` is the critical one; `mode-approvals.json` /
  `trust.json` are path-bound and will silently stop matching if missed.
- **Beads migration losing history or breaking references.** Mitigated by
  migrating only open beads, preserving IDs where possible, and recording the
  ID map. Fallback is the §3.3 freeze alternative.
- **The Fleet `.pi/pi-persist.json` authority item landing in the wrong
  scope.** It is Fleet-scoped; decide global vs. Yellowstone during Step 3
  and do not duplicate it.
- **In-flight work caught mid-move.** Mitigated by the Step 1 freeze. The
  two open items on 2026-11-25 (cache verification, datetime bead) must be
  closed or explicitly parked first.

## 8. Rollback
- Before Step 6 completes, rollback is: stop the merged work, relaunch SI in
  `w1K` from its session file + handover, and move files back. Nothing is
  deleted before Step 6, so every step up to then is reversible.
- After Step 6 (lane retired), rollback is the same procedure from the
  Fleet directory, which stays in place (§3.4), or from the TRANNY backup.
  Keep both until the operator says otherwise.

## 9. What this plan deliberately does NOT cover
- Any change to what the fleet *does* — only which lane owns SI's half of it.
- The Neon escalation tier decision, the subscription decision, or the
  message-level datetime implementation (the bead covers that separately).
- Deleting `/home/bitnom/Documents/Fleet` or its history — that is a
  separate later decision, after a soak period (§3.4).

## 10. Revision note (2026-11-25 ~21:05 EST)
- v1 of this plan moved the SI lane into the Yellowstone space as a second
  lane. The operator corrected that: the point is eliminating the second
  leader, so yellowstone-leader absorbs all SI roles and responsibilities
  and the SI lane retires. This revision rewrites the goal (§0), the transfer
  list (§2), and the sequencing (§4) to match. Decisions §3.2–§3.4 are still open.
- 2026-11-25 ~21:09 EST: pi-auto-translate disposition deferred by the
  operator (effort not fully realized, not important right now) — §3.2 and
  Step 6 updated; `w1K` removal now waits on the effort resuming.
- 2026-11-25 ~21:14 EST: beads decision made (migrate — §3.3, Step 4
  rewritten with the shared-dolt-server finding) and the Fleet dir backed up
  to /media/bitnom/TRANNY/bitnom/Documents/Fleet/ (14M, verified).
- 2026-11-25 ~21:31 EST: Fleet directory decision made (keep it — §3.4,
  Step 6/7 updated). The dir stays in the Documents folder because it is in
  the operator's Obsidian vault; retire + delete only after a soak period,
  as a separate later decision. All four §3 decisions are now settled.
