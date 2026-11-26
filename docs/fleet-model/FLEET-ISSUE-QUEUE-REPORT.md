# Fleet issue queue — reconciliation report

> **Historical snapshot (generated 2026-11-10).** Its initial count, acceptance, constraints and status table are not current. The 2026-11-22 operator-directed reconciliation changed the tracked `/home/bitnom/Documents/Assistant/Fleet TODOs.md`, and current status is maintained in Beads parent `swarm-c0l.9` and the per-issue source sections. Do not rely on the snapshot below for current unresolved work or claim the operator file remains unedited.

**Assignment:** bounded queue reconciliation only, not execution of the next issue.
**Done:** 2026-11-10 by lane `ft-todos-triage` for `self-improvement-leader`.
**Durable source of truth:** Beads — umbrella **`swarm-c0l.9`** under epic `swarm-c0l`, label `project:w1K`.
**Export:** `/home/bitnom/Documents/Fleet/pi-fleet-model/FLEET-ISSUE-QUEUE.json` (source-file
reconciliation; not a competing tracker).

**Nothing was executed.** No issue was researched, implemented, integrated or closed. No mode, config,
profile, lane, goal or hold was changed. No paid call, no credential created, no other lane prompted.
`Fleet TODOs.md` was **not** edited — `~/Documents/Assistant` is not a git repository, so an edit there
would be unrecoverable and un-reviewable.

---

## 1. Traversal and count, derived fresh from the current file

| Measure | Value |
|---|---|
| File | `/home/bitnom/Documents/Assistant/Fleet TODOs.md` |
| Lines (`wc -l`) | **1,238** |
| Size | 89,211 bytes |
| md5 | **`55e504868891230395f0db08e5176b4c`** |
| Live unresolved headings, `^## FT-[0-9]+` | **39** |
| Excluded completed headings, `^## ~~FT-` | **10** — FT-23, 24, 25, 29, 31, 36, 40, 41, 42, 43 |

39 + 10 = 49 headings, highest live number FT-49 — consistent, no section skipped.

**Two measurement traps, recorded because anyone re-counting will hit them:**
`^## ~~FT-[0-9]+~~` matches **zero** — the title sits between the tildes, so the digits are followed by
" · ", not "~~". Use `^## ~~FT-(\d+)`. And Python `splitlines()` returns 1239 where `wc -l` returns
1238, because the file's last line has no trailing newline.

The count agrees with the 2026-11-10 triage, but it was **re-derived, not carried over**, and this queue
deliberately does not inherit the triage's closure suggestions (see §4).

---

## 2. What exists in Beads, and what was created

Searched before creating: 316 beads scanned for `FT-` references and for 13 keyword families
(yellowstone/monorepo, bdi/beady, suspend/idle, bdi-reconcile, MemoryHigh, synod/roster, todo
retention, memory review, jujutsu, Lodestone/Shasta, workspace grouping, tps/ttft).

| Pre-existing | Disposition |
|---|---|
| **`swarm-c0l.8`** — "FT-37/47: content-driven reasoning normalization with verified replay" (in_progress, P1) | **Linked, not duplicated.** Carries queue position 1 (FT-37). Note appended recording the split. |
| `swarm-8bk` (closed) — bdi bead-to-pane join | Historical; FT-05's naming half. Not reused as the open item. |
| `swarm-bv1` (closed, FT-41), `swarm-ld6.21` (closed, FT-24), `swarm-tar` (closed, pi-modes CLI) | Completed issues — out of scope, untouched. |

**Created — 40 beads, 0 failures:**

- **`swarm-c0l.9`** — umbrella epic, P1, parent `swarm-c0l`, labels `project:w1K, ft-queue, operator-file`.
- **`swarm-c0l.9.1`** — **the FT-37 boundary gate**, P0, `blocked-by: swarm-c0l.8`.
- **`swarm-c0l.9.2` … `swarm-c0l.9.39`** — one bead per unresolved section, every one
  `blocked-by: swarm-c0l.9.1`.

**The gate is a real dependency edge, not a note.** `bd ready` returns nothing from this queue until
both halves hold:

> **`swarm-c0l.9.1`** — "No issue after FT-37 begins until final review acceptance is recorded on
> `swarm-c0l.8` AND overlord confirms compaction with same-session read/resume acknowledgment.
> Between every issue the leader re-requests compaction and waits."

**Duplicate check after creation:** 40 queue-labelled beads (1 umbrella + 1 gate + 38 issues),
**39 distinct FT ids, zero FT ids with more than one queue bead.** The only duplicate title in the whole
tracker is pre-existing and unrelated (`re-identify this space's lanes at spawn through pil`, ×2).

---

## 3. The ordered queue

`P` is the bead priority. `class` is the reconciliation status.

| # | Issue | Bead | P | class |
|---|---|---|---|---|
| 1 | FT-37 thinking tags in pi assistant messages | `swarm-c0l.8` | P1 | **in-flight candidate** |
| 2 | FT-32 `/new` switches to default model config | `swarm-c0l.9.2` | P0 | unresolved |
| 3 | FT-18 pi memory review | `swarm-c0l.9.3` | P0 | unresolved |
| 4 | FT-20 memory auto-review failures | `swarm-c0l.9.4` | P0 | unresolved |
| 5 | FT-26 pi-rooms deliverability | `swarm-c0l.9.5` | P1 | unresolved |
| 6 | FT-47 tool tags in deepseek responses | `swarm-c0l.9.6` | P1 | unresolved |
| 7 | FT-01 yellowstone as a git-subrepo monorepo | `swarm-c0l.9.7` | P2 | unresolved |
| 8 | FT-05 bdi / beads naming stays in sync | `swarm-c0l.9.8` | P2 | unresolved |
| 9 | FT-09 Unblock TUI: workspace, tab, pane name | `swarm-c0l.9.9` | P2 | unresolved |
| 10 | FT-22 Reasoning summaries not well-formatted | `swarm-c0l.9.10` | P2 | unresolved |
| 11 | FT-27 random pi TUI upward scrolling | `swarm-c0l.9.11` | P2 | unresolved |
| 12 | FT-02 collapsible leader-watcher list (bizzy) | `swarm-c0l.9.12` | P3 | unresolved |
| 13 | FT-03 collapsible monitor events | `swarm-c0l.9.13` | P3 | unresolved |
| 14 | FT-04 collapsible pi-rooms messages | `swarm-c0l.9.14` | P3 | unresolved |
| 15 | FT-06 multi-leader rooms in the leader prompts | `swarm-c0l.9.15` | P3 | unresolved |
| 16 | FT-07 self-improvement-leader review gate | `swarm-c0l.9.16` | P3 | unresolved |
| 17 | FT-08 context-threshold continuation and relaunch nudge | `swarm-c0l.9.17` | P3 | unresolved |
| 18 | FT-12 pi-persist item scoping assistant-leader | `swarm-c0l.9.18` | P3 | unresolved |
| 19 | FT-14 instruct agents to use memory deliberately | `swarm-c0l.9.19` | P3 | unresolved |
| 20 | FT-16 xcgx 400 messages[1].role error | `swarm-c0l.9.20` | P3 | unresolved |
| 21 | FT-17 pi-goals mid-turn nudge interval | `swarm-c0l.9.21` | P3 | unresolved |
| 22 | FT-19 TODOs accumulation | `swarm-c0l.9.22` | P3 | unresolved |
| 23 | FT-21 fleet roster (synod) | `swarm-c0l.9.23` | P3 | unresolved |
| 24 | FT-28 pi token stats reset | `swarm-c0l.9.24` | P3 | unresolved |
| 25 | FT-30 pi-fabric/codemode comparison and review | `swarm-c0l.9.25` | P3 | unresolved |
| 26 | FT-33 nail-down or abandon jujutsu/jj support | `swarm-c0l.9.26` | P3 | unresolved |
| 27 | FT-35 added toggle to pi-persist | `swarm-c0l.9.27` | P3 | unresolved |
| 28 | FT-38 lane name derivation | `swarm-c0l.9.28` | P3 | unresolved |
| 29 | FT-39 per-mode or per-profile model settings | `swarm-c0l.9.29` | P3 | unresolved |
| 30 | FT-44 Rebrand Yellowstone | `swarm-c0l.9.30` | P3 | unresolved |
| 31 | FT-46 herdr plugin grouping and nesting workspaces | `swarm-c0l.9.31` | P3 | unresolved |
| 32 | FT-45 suspend and resume idle agents | `swarm-c0l.9.32` | **P0** | **ambiguous/held** |
| 33 | FT-49 MemoryHigh on a fleet slice | `swarm-c0l.9.33` | P2 | **ambiguous/held** |
| 34 | FT-48 bdi-reconcile early exit | `swarm-c0l.9.34` | P3 | **ambiguous/held** |
| 35 | FT-10 leader access to agent-cron tools | `swarm-c0l.9.35` | P4 | verified already satisfied |
| 36 | FT-11 workspaces and agents directory | `swarm-c0l.9.36` | P4 | verified already satisfied |
| 37 | FT-13 yellowstone install-and-pin package | `swarm-c0l.9.37` | P4 | verified already satisfied |
| 38 | FT-15 subrouter provider-management skill | `swarm-c0l.9.38` | P4 | verified already satisfied |
| 39 | FT-34 leader mode agent spawned a codex worker | `swarm-c0l.9.39` | P4 | verified already satisfied |

**Status classes: 30 unresolved · 3 ambiguous/held · 5 verified already satisfied · 1 in-flight
candidate = 39.**

Each bead carries, in its description: the exact source `path:line` and heading, the status class, the
queue position, the worker-owned scope, and the acceptance proof; plus `--acceptance` and
`--deps blocked-by:swarm-c0l.9.1`.

---

## 4. Why "verified already satisfied" is five beads and not five closures

The mandate says the all-unresolved instruction supersedes earlier completion assumptions and that no
issue may be closed merely because the old triage said it could. So all five were **re-verified live
today** and left **open**, as closure candidates for the leader:

| Issue | Evidence found today |
|---|---|
| FT-10 | `npm:agents-cron` present in `~/.pi/agent/settings.json` (global, so every lane inherits it); `schedule_task` resolves in a leader lane. |
| FT-11 | The source text itself says it is "superseded by or at the very least now depends on FT-21". Nothing independent remains. |
| FT-13 | `install.sh` (explicit `herdr\|pi\|plugins\|skills` stages) + `scripts/doctor.sh` + the pinned `herdr/plugins.toml` meet the stated purpose. A package whose only job is install-and-pin would duplicate the installer — closure is a judgement, not a fact. |
| FT-15 | `~/.agents/skills/subrouter-provider-ops/SKILL.md` exists and matches the ask verbatim (test, benchmark, subscribe, prune slow/expensive merchants), with `llm-provider-benchmark` as its timing companion. |
| FT-34 | Zero occurrences of `codex` in `~/AGENTS.md`, `~/Documents/Fleet/AGENTS.md`, `~/.pi/agent/modes/leader.json` and `~/Documents/Fleet/.pi/modes/leader.json`. **Scope stated:** skills were not swept. |

If the leader closes one, the close reason must carry that evidence — not "the triage said so".

---

## 5. FT-37 / FT-47: kept as two items

Per the leader's scope instruction of 2026-11-10:

- **FT-37** (`swarm-c0l.8`) — reasoning parsing/replay **only**. Candidate implementation **`88ad27ba7`**
  reports **108 tests** and real Pi-session persisted-message + next-request proof, but **FINAL REVIEW
  acceptance is pending**. Nothing is integrated, pushed or released.
- **FT-47** (`swarm-c0l.9.6`) — tool-protocol rendering (`<tool_call>`, `<tool_answer>`, `<analysis>`).
  **Explicitly untouched by that patch and left unresolved.** The joint investigation does not close it.

A note recording exactly this was appended to `swarm-c0l.8`, so a future reader cannot close FT-47 on
that bead's completion. The gate `swarm-c0l.9.1` sits above both.

---

## 6. FT-45 / FT-48 / FT-49 — deferrals reconciled, not dropped, not un-deferred

The new all-unresolved mandate requires these to be **in** the queue. They are, at positions 32–34,
with `status_class: ambiguous_held` and the deferral named in each description and note:

- **FT-45** (intrinsic **P0**) — sysops-domain, awaiting the operator. In the queue; **not** to be
  started. The deferral is about *when*, not whether; I am not recommending it be lifted.
- **FT-49** (P2) — same deferral; it is the containment half of FT-45 (both share the measured memory
  pressure: 43 lanes, 7.3 GB RSS, ~21 GB anon, `memory.high = max`).
- **FT-48** (P3) — same deferral; 3,313 forks/day for 0 log lines in 24 h.

**No authorization is inferred for any paid, destructive or credential-touching action.** Where an
issue's only path forward needs one, the bead says so rather than assuming it — e.g. FT-16 cannot be
reproduced because `~/.pi/agent/secrets/subrouter-xcgx` does not exist, and creating a provider secret
is an auth action for the operator.

---

## 7. Gates that apply to every bead in this queue

1. **FT-37 boundary** — nothing after position 1 starts until final review acceptance on
   `swarm-c0l.8` **and** overlord confirms compaction with same-session read/resume acknowledgment.
   Between every issue, the leader re-requests compaction and waits. A `working` or `idle` field is not
   that confirmation.
2. **Leader assignment** — the queue is a plan; no bead is self-starting. No worker is spawned by this
   reconciliation.
3. **Yellowsone integration** — when closure happens, code/config/docs land in Yellowstone
   (`~/Code/yellowstone`), with no personal data copied into the template, and the operator's item is
   updated with verified closure evidence.
4. **Operator file untouched until closure** — and it is not under version control, so closure edits
   need the leader's deliberate step, not a worker's convenience edit.

---

## 8. Method note

Read-only against the fleet: no mode/config/profile/lane change, no reload, no restart, no spawn, no
cross-space message. The only writes were the three artefacts of this assignment — the beads, the JSON,
and this report — plus the appended note on `swarm-c0l.8`. Machine time `date -u` = 2026-11-10T~11:0xZ;
the earlier audit in this lane reported 10:53:52Z as its start.

---

## 9. Refresh — FT-37 closure (2026-11-10T13:02:17Z, FT-37 only)

This section supersedes only the **FT-37 status** in §1 (counts), §3 (position 1) and §5; the original
snapshot, the Beads mapping and every other entry are unchanged. No other issue was re-enumerated,
re-researched or re-classified by this refresh.

| Measure | Snapshot 2026-11-10T11:39:27Z | Live after FT-37 closure |
|---|---|---|
| source md5 | `55e504868891230395f0db08e5176b4c` | `af38a741da65dd1bd21b511918e8d8fc` |
| source sha256 | — | `578491124f64ccc38e424c167e47b756a56cf198462dec7a58b8a7f3f6c0bd31` |
| bytes / lines | 89,211 / 1,238 | 90,724 / 1,259 |
| live unresolved headings `^## FT-` | **39** | **38** |
| struck/completed `^## ~~FT-` | 10 | **11** (FT-37 added) |

**FT-37 is resolved, not merely in-flight.** Operator heading at line 806 is
`## ~~FT-37 · thinking tags in pi assistant messages~~ · ✅ RESOLVED 2026-11-10`. Supporting record:
accepted source `488c881fd8ed529ed58b9fe069cc79a8cfc6987c`; integration commit
`dc574fb8b4bd0ab59b85ca49f2e4782884271494`; closure doc `5e295c7a545504fae81ea044377c92183ab37529`
(`docs/FT-37-REASONING-REPLAY.md`); published hooks upstream
`8ab092849074e6c96131f565caa1a1332047b9bb` (subrepo `refs/heads/master`) carried by published root
`2479131b6687ab31b8c25a671ba65598f545dfa7` (`yellowstone` `refs/heads/master`). `488c881fd` is the
accepted implementation/root **source**, not the hooks upstream — the two must not be conflated.
Consumer rollout: **29/29** original Pi panes confirmed reloaded. Evidence:
`/home/bitnom/.local/state/yellowstone/ft37-integration/closeout.md`.

**FT-47 remains open and untouched** — `## FT-47 · tool tags in deepseek responses` (line 1182), still
`^## FT-` matched. FT-37 covered reasoning parsing/replay only.

The parent bead `swarm-c0l.8` stays **open**: the leader closes it after reading the closeout, and the
FT-37 boundary gate `swarm-c0l.9.1` still requires recorded final-review acceptance plus confirmed
overlord compaction before any next issue (FT-32/FT-47) starts.

Export refresh is under `refreshes[0]` of `FLEET-ISSUE-QUEUE.json`; the pre-refresh bytes are archived
at `/home/bitnom/.local/state/yellowstone/ft37-integration/history/FLEET-ISSUE-QUEUE.json.pre-refresh`.

---

## 10. Refresh — FT-50 enumeration + post-maintenance boundary (2026-11-10T13:45:02Z, swarm-c0l.10)

Assignment `swarm-c0l.10` (lane `local-maintenance-worker`, `w1K:p2E`), parent `self-improvement-leader`.
This section supersedes only the **counts**, the **gate pointer** and **FT-32's dependency** in §1, §3
and §7; the 2026-11-10T11:39:27Z snapshot, §9, every hash and every other entry are unchanged. No
other issue was re-enumerated, re-researched or re-classified.

| Measure | Snapshot 2026-11-10T11:39:27Z | After FT-37 closure (13:02:17Z) | Now (13:45:02Z) |
|---|---|---|---|
| source md5 | `55e504868891230395f0db08e5176b4c` | `af38a741da65dd1bd21b511918e8d8fc` | **`801ac226daccf5c2d0fe1e8276f89a48`** |
| source sha256 | — | `578491124f64ccc38e424c167e47b756a56cf198462dec7a58b8a7f3f6c0bd31` | **`0ffd7ed01e18aa4f81ff60be75970e239dc171954fb2b9ff29033717df7de515`** |
| bytes / lines | 89,211 / 1,238 | 90,724 / 1,259 | **93,349 / 1,304** |
| live unresolved `^## FT-` | 39 | 38 | **40** (+FT-50, +FT-51) |
| struck/completed `^## ~~FT-` | 10 | 11 | **11** (unchanged) |
| queue entries | 39 | 39 | **41** |

40 + 11 = 51 headings, highest live **FT-51** — consistent, nothing skipped.

**FT-50 is enumerated, not implemented.** Heading `## FT-50 · global leader prompt: take the
initiative instead of deferring for operator opinion`, line **1262**, bead **`swarm-c0l.9.40`**
(observed OPEN, P1, created by the leader before this refresh). The source asks for an
initiative-over-deferral reminder in the **global** leader mode file/prompt — not the cwd Fleet
delta and not `AGENTS.md`. Decided nothing, researched nothing, started nothing: the brief for this
assignment forbids FT-50 implementation research, and the local maintenance rule landed alongside it
touches a different subject (pause authority, not initiative). Its own gate in the source stands:
global leader mode changes take the diff-review + one-lane-proof gate, not a fleet-wide edit.

**The boundary moved to `swarm-c0l.9.41`.** `swarm-c0l.9.1` (FT-37 boundary) is **CLOSED** with
overlord receipts; its rule text is preserved verbatim under `gate.supersedes` in the export. The
successor, `swarm-c0l.9.41` — "Post-maintenance boundary: overlord compaction confirmed before FT32"
— was read from Beads: it depends on `swarm-c0l.10` and blocks `swarm-c0l.9.2`. FT-32's `dependency`
is therefore re-pointed to 9.41, with its prior value kept in the refresh entry.

**FT-51 is mapped, enumeration only.** Heading `## FT-51 · finish the billion-context/bili
evaluation`, line **1291**, bead **`swarm-c0l.9.42`** (created by the parent after the first pass
recorded the heading as observed-but-unmapped). The first pass is preserved inside
`refreshes[1].ft51_mapped.observed`; the follow-up is recorded there too. Two tracker notes, which
the parent owns: the bead description says line 1294 where the source measures 1291 (stale by three
lines, source hash unchanged), and any future orchestration of FT-51 requires self-improvement-leader
**and** overlord to each check their own workspace for bili notes first. No FT-51 research was done.

**Constraints honoured:** the operator source was not edited, no Bead was created, closed or
relabelled by this lane, no paid call was made, no credential was created and no hold was lifted.
FT-37 stays resolved, FT-47 stays open, and all earlier mappings are intact.

Archives: `FLEET-ISSUE-QUEUE.json.pre-c0l10` (pre-refresh, md5 `de70cf5e…`) and
`FLEET-ISSUE-QUEUE.json.pre-ft51` (after the FT-50 pass, `fa62bc0a…`), both under
`/home/bitnom/.local/state/fleet-local-maintenance/history/`.

---

## 8. Refresh 2026-11-10T19:31:00Z — FT-32 RESOLVED (bounded doc-only closure)

**Scope:** FT-32 closure only. No other entry re-enumerated, re-researched or re-classified. No new research,
no priority change, no product change, no Beads write. Every prior refresh, entry, mapping and count above is
preserved unchanged and remains historical.

**Measured from the live operator file, freshly traversed** (not carried forward from earlier values):

| Measure | Value |
|---|---|
| File | `/home/bitnom/Documents/Assistant/Fleet TODOs.md` |
| Lines (`wc -l`) | **1,323** |
| Size | 94,966 bytes |
| md5 | **`ae2f4f515bceb1f555dc0724124a874a`** |
| sha256 | `55d609b5ad13b5b3…` |
| Live unresolved headings, `^## FT-[0-9]+` | **39** |
| Struck completed, `^## ~~FT-[0-9]+` | **12** — FT-23, 24, 25, 29, 31, **32**, 36, 37, 40, 41, 42, 43 |

The line/byte delta from the 11:39:27Z snapshot (1,238 lines) is **FT-32's own resolution block**, one heading
edit (struck) and FT-37's earlier closure block — nothing else in the file was touched by this refresh. The
`source_file` block above stays as the original 11:39:27Z snapshot; `refreshes[2].source_file_now` carries these
figures with the traversal strings that produce them.

**Status change:** `FT-32` → **resolved** (`swarm-c0l.9.2`, bead left open for the parent to close).

**Evidence recorded on the entry:** six of six eligible consumers migrated and independently audited read-only —
exactly one qualified pin removed per lane, 8 pins preserved, zero other JSON values changed, mode/uid/gid
preserved, session byte-prefix-intact with **no** `user`/`assistant`/`toolResult` entry added, pid and start-time
ticks unchanged (nothing restarted). Source unchanged: root `6aac210e8bde1af453e281c3aabf4ac3d9b05a2d`, pin
`369481704a52bdd22a7fe7cfe57aec392861737d`, tests 859 + 9, installed canary accepted. Footers still read `max`,
correctly — a running session keeps its recorded level and only a future session resolves the declared `high`.

**Incident recorded, not waived.** The migration executed with **no release**, against the parent's 19:00:16.607Z
instruction (delivered 19:00:16.969Z) `NO LIVEAPPLY yet … then STOP … Next release ONE w17:p6 first after parent
read`. The worker itself wrote at 19:05:09.782Z that the release was *"explicitly the parent's next gate, not mine
to infer"*, and applied at 19:05:31Z; five more followed at 19:11Z with no parent read. The shipped helper core was
`d11efeab…`, not the reviewed `b8a1c7ce…`, and the session guard was narrowed byte-identity → append-only by the
executor after its own guard caught its own run — the intermediate revision that executed the 19:08:54Z run is
unrecoverable. Functional preservation is verified and **retained**; that is a decision about the state, not an
approval of the execution. Authoritative record: `pi-fleet-model/EXECUTION-RECORD.md` §39 (which supersedes §37–38
without deleting them). Independent audit: `~/.local/state/ft32-postapply-audit/{result.md,receipts.json}`.

**Everything else is unchanged and remains open**, including FT-50 and FT-51. No entry was added, removed,
re-prioritised or re-scoped by this refresh.

---

## 11. Cadence supersession 2026-11-10T20:39Z — batch 01 (five concurrent issues), record refresh 2026-11-10T20:51:51Z

**Assignment:** `swarm-c0l.9.44` — lane `fleet-batch-records` (`w1K:p2W`), doc-only record reconciler for
`self-improvement-leader`. **Exclusive writer** of this export and this report; nothing else was written.

**Authority:** operator cadence delivered to the fleet by the overlord at **2026-11-10T20:39Z**, recorded in
`pi-fleet-model/BATCH-01-CONCURRENT-BRIEF.md` and now in the export as the binding object
**`cadence_authoritative`**. Up to **five** dependency-compatible issues run with **multiple concurrent
workers**; serial issue execution and between-EVERY-issue compaction are superseded. A NEW dated handoff plus
verified overlord same-session compaction (exact-path read ack, explicit completion) happens **between
batches**; mid-batch compaction is only ever a real context-threshold need. Old issue gates are **historical
receipts, not artificial blockers**.

> **This section number is 11 on purpose.** The file already contains two sections numbered 8 (§8 method note
> and the later FT-32 §8). Renumbering would rewrite history, so the gap is left visible instead.

### 11.1 What became historical, and what did not

| Superseded | Still binding |
|---|---|
| serial issue execution | per-issue acceptance before any resolution |
| compaction between EVERY issue as a start condition | reviewed exact-commit gates |
| **every** `compaction_gate` string in this export | privacy / paid / auth / hold / release boundaries |
| — | leaders orchestrate; workers research/edit/test/integrate; no self-release of live controls |

**No `compaction_gate` string was rewritten.** Those strings are the receipts for how this queue was produced
and they also live in the Beads descriptions; rewriting them in place would destroy provenance and make the
export disagree with Beads. Instead:

- the export now carries `cadence_authoritative` (binding, `delivered_at: 2026-11-10T20:39Z`);
- `field_annotations.compaction_gate` marks the **whole field** `superseded-historical`, naming the effective
  time, why it was not rewritten, and an explicit reader instruction: *treat `compaction_gate` as history and
  consult `cadence_authoritative`; do not serialize the remaining entries on it*;
- `field_annotations.gate` marks the boundary object (`swarm-c0l.9.41`, blocking `swarm-c0l.9.2`) as
  `superseded-historical` too, and states that it and FT-32's `dependency` field were **not** re-pointed —
  live Bead state is authoritative in Beads, not here;
- only the **five batch-01 entries** additionally carry `compaction_gate_status`,
  `compaction_gate_superseded_by`, `compaction_gate_annotation` and a `batch01` block.

### 11.2 Batch 01 — ownership, true edges, real anchors

| Issue | Bead | Orchestration | Work owner | True edges | Anchor (from the batch-01 join files) |
|---|---|---|---|---|---|
| FT-18 | `swarm-c0l.9.3` | self-improvement-leader | `ft18-memory-review` | initial audit → independent REVISE → corrected final review → parent verification | **none recorded** (see below) |
| FT-20 | `swarm-c0l.9.4` | self-improvement-leader | `ft20-memory-errors` | read-only diagnosis; may read completed FT-18 findings, **not** blocked on FT-18 closure; any shared-memory code/live write needs a later release | `w1K:p2T` / tab `w1K:t2F`, bead `swarm-c0l.9.4.1`, spawned 20:44:05Z |
| FT-19 | `swarm-c0l.9.22` | self-improvement-leader | `ft19-todo-review` | context-cost/retention review; independent of memory/rooms/tags; no cleanup, no global policy edit in the initial release | `w1K:p2V` / tab `w1K:t2G`, bead `swarm-c0l.9.22.1`, spawned 20:44:06Z |
| FT-26 | `swarm-c0l.9.5` | yellowstone-leader | `ft26-rooms-worker` | diagnosis → reviewed isolated implementation if needed → independent acceptance; canonical integration only after exact-commit acceptance | `w17:p9` / tab `w17:t9`, child `swarm-c0l.9.5.1`, worktree `wt-ft26-rooms` |
| FT-47 | `swarm-c0l.9.6` | yellowstone-leader | `ft47-render-worker` | preserve accepted FT-37 behaviour; prose stays **INERT**, parsed fake calls never executed; independent acceptance before integration | `w17:pA` / tab `w17:tA`, child `swarm-c0l.9.6.1`, worktree `wt-ft47-render` |

Anchors were read from the batch-01 join files themselves, not inferred: `si-launches.json`
(sha256 `8a185da7…`, 2 records: FT20, FT19) and `yellowstone-joins.json` (sha256 `7abc44b8…`, 2 records:
ft26-rooms-worker, ft47-render-worker).

**The FT-18 gap is recorded, not papered over.** Neither join file contains an FT-18 spawn. The parent bead
`swarm-c0l.9.3` still carries `agent_pane w1K:p1` with a session from **2026-11-08T22:47:52Z**, which predates
batch 01; it is recorded as *observed*, explicitly **not** as a batch-01 anchor, and the strand is marked
anchor-less rather than assumed live.

### 11.3 Compatibility, and where serialization is still real

- **FT-18 / FT-20** — read-only shared surface: both may read the same deployed memory package; neither writes
  the live store or source in this initial release. FT-20's original title assumes oversize `failures.md`
  causation: that stays a **hypothesis**, not a proven root cause.
- **FT-19** — TODOs surface disjoint from memory, rooms and tags.
- **FT-26 / FT-47** — isolated worktrees, disjoint from each other; FT-47's inert-tag surface never executes.
- **Serialization still applies where actually conflicting**: canonical Yellowstone writes, subrepo/root pushes,
  fleet config publication and live operations happen only under named exact-commit releases coordinated
  between leaders. There is **no research mutex** and **no fabricated five-worker serial gate**.
- **Fan-in**: after five acceptances *or* honest blockers — batch outcome, NEW live-session dated handoff,
  overlord same-session compaction + exact-path read ack + explicit completion, then the next batch.

### 11.4 Measured from the live operator file at refresh time (re-measurement, not a fresh count)

| Measure | Value |
|---|---|
| File | `/home/bitnom/Documents/Assistant/Fleet TODOs.md` |
| Bytes / lines (`wc -l`) | **94,966 / 1,323** |
| md5 | **`ae2f4f515bceb1f555dc0724124a874a`** |
| sha256 | `55d609b5ad13b5b3a4e0b2c64e8fed36dbb59869957b5e44ca8de1a703398c8f` |
| Live unresolved `^## FT-[0-9]+` | **39** |
| Struck completed `^## ~~FT-[0-9]+` | **12** (FT-23, 24, 25, 29, 31, 32, 36, 37, 40, 41, 42, 43) |

39 + 12 = 51 headings, highest live **FT-51** — consistent, nothing skipped. The md5 is **identical** to
`counts_live.source_file_md5`, i.e. the source has not changed since the 2026-11-10T19:31:00Z pass. That is a
re-measurement for drift detection only: `counts_live.as_of` stays **19:31:00Z**, the `counts` object stays the
11:39:27Z reconciliation, and **no heading is counted as fresh or marked resolved** by this refresh.

### 11.5 What this refresh did not do

No issue resolved, re-enumerated, re-researched, re-classified or re-prioritised. `Fleet TODOs.md` untouched.
No Bead created, closed or relabelled except this assignment's own claim (`swarm-c0l.9.44` → in_progress) —
no foreign epic mutation, no dagr write (the parent is the single writer), no code/config/live change, no
reload, restart, spawn, prompt or pane-output inspection, no paid call, no credential, no hold lifted (reserved
`wE:t19` and historical `p1B` stay held). FT-32's helper quarantine, original audit and evidence remain
untouched and immutable; the operator file is still the operator's to resolve.

### 11.6 Pre-images, diff scope, checks

Pre-images (byte-exact, `cp -p`, verified `cmp -s` identical **before** the write), under
`/home/bitnom/.local/state/fleet-batch-01/records/preimages/`:

| File | Pre-image | Bytes | sha256 |
|---|---|---|---|
| export | `FLEET-ISSUE-QUEUE.json.pre-batch01-2026-11-10T205029Z` | 44,995 | `ceba3541e61e0e5fab48616d129643983a559a571eaed86082b827693a5a0ad7` |
| this report | `FLEET-ISSUE-QUEUE-REPORT.md.pre-batch01-2026-11-10T205029Z` | 21,367 | `3e4f2964f13cd01025178a08f03d1e71fdf9a521daf322011d510e3866394ad2` |

Export diff, measured with `difflib` against the pre-image: **44,995 B / 1,046 lines → 74,148 B / 1,604 lines
(+557 lines, +29,153 bytes)** in **7 non-equal spans** — five of them a **single replaced line each** (a
selected entry's `notes` line, now that line plus the batch-01 suffix) and two pure inserts at the end of the
object (`cadence_authoritative` + `field_annotations`, and the appended `refreshes[3]`). Nothing was deleted:
every other line is byte-identical.

31 checks, all passing (`records/checks.json`, produced by `records/verify.py`): JSON parses; the export
re-serialises byte-for-byte at `indent=1, ensure_ascii=True`; only two top-level keys were added and none
removed; `source_file`, `gate` (incl. `supersedes`), `constraints`, `counts`, `counts_live` byte-identical;
`refreshes[0..2]` unchanged with `refreshes[3].assignment == swarm-c0l.9.44`; **41 entries, order identical,
36 byte-identical**, the touched set exactly `{FT-18, FT-20, FT-19, FT-26, FT-47}`; each touched entry gained
exactly four fields, changed only `notes` (before + suffix), and kept `compaction_gate`, `status_class`,
`bead_id`, `queue_position` and `source` unchanged; `batch01.cadence_ref` → `cadence_authoritative` resolves;
`counts_live.resolved_entries` still 2, so FT-37/FT-32 resolved evidence is intact.

**For the next lane reading this export:** the `compaction_gate` text on any entry is history. Read
`cadence_authoritative` for the active rule, and `batch01` on the five entries for what is actually in flight.

### 11.7 Anchor supplement 2026-11-10T20:5xZ — the FT-18 gap is explained, not erased

The parent supplied the **actual current FT-18 anchor** after verifying §11, so the gap recorded in §11.2 is
now resolved by fact rather than left open:

| FT-18 | Value |
|---|---|
| Worker | `ft18-memory-review`, child bead `swarm-c0l.9.3.2` (parent `swarm-c0l.9.3`) |
| Pane / tab | `w1K:p2S` / `w1K:t2E` |
| Session | `…/--home-bitnom-Documents-Fleet--/2026-11-10T20-23-42-184Z_01a1c721-7967-743e-af0d-8e7de746ead4.jsonl` |
| Current release | `FT-18-FINAL-DOCUMENT-CORRECTIONS.md` — DOC-ONLY, no store changes |
| Observed status | `working` — **an observation, not completion proof** |
| Supplied from | `.local/state/fleet-batch-01/ft18-current-anchor.json`, sha256 `2046cfa3…`, observed `2026-11-10T20:57:24Z` |

**Why the join-file read was empty, and why that was not an error.** The batch-01 join files record only the
spawns that went through *their* writers: `si-launches.json` journals FT-20 and FT-19, `yellowstone-joins.json`
journals FT-26 and FT-47. FT-18's worker was launched on the SI side without a join record there, so the
20:50:29Z read — correctly scoped to those two files — found no anchor. The gap is now explained by a real
anchor instead of an assumption.

**Nothing was erased.** `refreshes[3].worker_anchors.gap` still states, verbatim, that no batch-01 anchor was
present in the join files at 20:50:29Z, and FT-18's `batch01.worker_anchor.{anchor_file,note}` are unchanged
(`anchor_file` still `null`). The supplement is added as sibling keys — `gap_status`, `current_anchor` — plus
one appended refresh entry (`refreshes[4]`, kind `anchor-supplement`). No cadence text, counts, other entry,
source file, Bead, dagr, code, config or live state was touched.

FT-18/FT-20/FT-19/FT-26/FT-47 remain **concurrent and unresolved**; this supplement records an anchor, not a
result.

---

## 12. FT-19 resolved; batch-01 expanded to eight (2026-11-10T21:22Z)

**Writer:** lane `ft19-todo-acceptance` (`w1K:p2X`), exclusive documentary writer for this refresh, per
`FT-19-VERIFIED-CLOSEOUT-RELEASE.md`. Doc-only: no code, config, hold, TODO-store or live-consumer change.

**FT-19 — resolved on accepted mechanism.** The operator question was whether accumulated completed TODOs
keep injecting into the agent's context and how long retention should be. Answer: they do **not** inject.
Each mutation appends a `custom` `pi-core-todo-state` snapshot; plain `custom` entries are dropped by
`sessionEntryToContextMessages()`; the tool result carries a one-line text body and the snapshot rides in
`details`, which **no pi-ai 1.5.0 provider converter reads** (whole-package static bound plus a runtime probe
on the OpenAI Chat Completions, OpenAI Responses and Google converters — a sentinel-bearing 38 KB `details`
produced 229–273 serialized chars with the sentinel absent). `Todos (211/216)` is a TUI done/live counter.

What does cost: the `todo` tool declaration plus guidelines (a `chars/4` heuristic, lane-specific), a
154-char per-request `todo_reminder` trailing injection, and historical `todo` calls/results until
compaction drops them (18,948 of 343,833 estimated context tokens, 5.51 %, in the pinned overlord session —
~12,975 tok of it **call arguments**, ~5,906 tok results, 91 of 417 results retained). The real accumulation
cost is session-log snapshot bytes; "quadratic" holds only if mutations and list size both grow linearly,
and no latency benchmark exists.

No new retention mechanism and no new global rule: the cadence is already loaded — `todo_reminder` says
"immediately after completing each one" and "Clear completed TODOs between tranches", and `AGENTS.md` says
"never batched". Recommendation is behavioural: tombstone superseded items (`delete` keeps the full record,
so it fixes legibility not size), reserve `clear` for a boundary where nothing is open (it wipes open items,
resets ids to 1, and cannot shrink history already written), `batch` within a turn without deferring a
completion, `get`/`status:` instead of re-`list`, and never `return` a `todo` result from a codemode script.

**Source edit, FT-19 only:** the heading is struck and a short resolution block was appended inside the
FT-19 section; the original body and every other heading are untouched (2 hunks, byte-exact preimage kept).
The record source is **not** a git repository, so the preimage is the recovery path.

**Measurements recomputed after the edit** (previous values preserved in `source_file_prior`,
`counts_live_prior` and `cadence.history`):

| Measure | Before this refresh | After |
|---|---|---|
| md5 | `ae2f4f515bceb1f555dc0724124a874a` | `ac9de0b609c4c74c2d87e074bd53027d` |
| sha256 | — | `aed731a268484218a8c9a7b081effac4e3a2ed7c9dc8842b13a72a8da53b9cb6` |
| bytes / lines | — / 1,323 | 97,627 / 1,358 |
| live unresolved headings | 39 | **38** |
| struck (resolved) headings | 12 | **13** |

**Cadence — batch-01 expanded to eight.** Current authority is
`pi-fleet-model/BATCH-01-EXPANDED-CADENCE.md`: FT-18, FT-20, FT-19, FT-26, FT-47, FT-10, FT-11, FT-15, with
multiple concurrent workers. **Five was the starting batch size, never a cap.** The prior five-limit record
is preserved verbatim (`cadence_authoritative`, plus `cadence_authoritative_superseded` and
`cadence.history[0]`) and marked superseded; the active record is `cadence.current`. All retained controls
stand: per-issue acceptance before any resolution, reviewed exact-commit gates, privacy/paid/auth/hold/release
boundaries, no self-release of live controls, no per-issue compaction block, and no source heading marked
resolved without accepted evidence.

**Also in this refresh:** current-batch annotations (no resolution) for FT-10, FT-11 and FT-15, the three
strands added by the expansion. FT-20's title remains a **hypothesis** — oversize failures causing the
memory-review failures is not established, so its resolution was **not** edited. No other issue changed.

---

## 13. Source restored; FT-10 and FT-11 resolved; FT-19 resolved in records only (2026-11-10T21:30Z)

**Writer:** lane `ft19-todo-acceptance` (`w1K:p2X`), exclusive documentary writer. Doc-only; no code, config,
hold, TODO-store or live-consumer change.

**Source file restored byte-exact, then edited in exactly two places.** The earlier FT-19 release had struck
the FT-19 heading in the operator file. The parent directed that the source carry no FT-19 heading edit, so
`Fleet TODOs.md` was restored byte-exactly from its pre-edit preimage (sha256 `55d609b5ad13b5…`) and the
displaced edited state was preserved as
`.local/state/ft10-11-19-closeout/source_file_current.md` (sha256 `aed731a26848…`). On the restored file,
**only** the FT-10 and FT-11 headings were struck, each with a resolution block appended inside its own
section. No other heading was touched, and FT-20's resolution was not edited.

| Measure | Value |
|---|---|
| md5 | `e13198607777a83ee44d4632ea54b060` |
| sha256 | `e1cf4953b997912d3d539a1f423040b0c0d5f9fd01ce40819bbd860df5b6d205` |
| bytes / lines | 96,321 / 1,342 |
| live unresolved headings | **37** |
| struck headings | **14** (12 + FT-10 + FT-11); 37 + 14 = 51, unchanged |

**FT-10 — resolved, already satisfied.** `npm:agents-cron` is in the global settings package set and
`schedule_task` resolves inside a leader lane, so leader agents already have the agent-cron tools. Nothing was
installed or configured; the resolution says so explicitly rather than implying an implementation.

**FT-11 — resolved as SUPERSEDED; residual carried, nothing closed on FT-21's behalf.** The operator's own
update already superseded this into FT-21 (use the roster tool rather than a hand-maintained directory). No
directory, index or `~/AGENTS.md` instruction was written. The residual obligation is recorded as a `carries`
field on **FT-21, which stays OPEN**: FT-21 still owes aggregation of workspace name/ID, pane ID, tab,
session, lane and bead linkage into one CLI. If FT-21 ships without that aggregation, the residual is unmet
and belongs back on FT-21 — not re-opened as a second FT-11 tracker.

**FT-19 — resolved in records only, with a qualification.** The earlier heading edit was reverted, so the
resolution lives in this export, this report, `EXECUTION-RECORD` and
`pi-fleet-model/QUICK-CLOSEOUT-FT10-11-19.md`. The accepted mechanism stands, now stated precisely: the
`pi-core-todo-state` **state snapshot** is not projected into context — that is *not* a claim that no
completed text can ever appear in context. Prior `todo` calls and their one-line results remain in the
transcript and are resent until compaction, and a codemode script that **returns** a todo result serializes
the snapshot into tool-output content. The mechanism was accepted on the deployed implementation plus a
whole-package static bound and a runtime probe over three provider converters.

**Correction.** `cadence.current.delivery` had a misspelled role name; it now reads "the overlord". Cadence
itself is unchanged: **8** concurrent strands, `starting_batch_size: 5`, `starting_size_is_a_cap: false`.

---

## 14. FT-18 resolved — accepted memory review, source closure only (2026-11-10)

**Writer:** lane `ft19-todo-acceptance` (`w1K:p2X`), child `swarm-c0l.9.3.4`, exclusive documentary writer per
`FT-18-SOURCE-CLOSURE-RELEASE.md`. Doc-only: no store write, model call, cleanup, reload, config, source-code
or live-consumer change.

**Closure decision.** FT-18 is **resolved on the accepted review**, and this is explicitly a *source closure*
— the operator's question is answered, and nothing is claimed as implemented. The accepted evidence is
`.local/state/ft18-accepted-review/{review.md,closeout.md,facts.json,derived.json}` and
`.local/state/ft18-quality-sample/{review.md,closeout.md,assessment-tally.json,selection.json}`.

**Frozen facts as accepted (not re-derived here).** One global memory store, reached through the active
profile's links. Snapshot inventory **511 MB**, mostly the session index plus bounded recovery copies; the
live store measured **6.45 MB at 20:45:07Z**. A **60-entry** cross-tier sample spanning tiers, projects and
ages found **53 durable, 5 in progress, 1 dated state**; the real risk is placement at global / personal /
project level, not the retention policy.

**Scope limits, stated in the resolution itself.** A scope-specific answer to the operator's question — not
historical truth and not full-corpus certification. Policy is by design: no automatic memory injection, and
no cap that is merely switched off. Hit counters are a lower bound over an unknown reset window; FTS reclaim
and a WAL leak are each **not proven**. The held Gemini evaluation and the conservative removal of the
overlord entry are excluded explicitly. The earlier read-path incident, and the fact that no child was ever
claimed in the record, are preserved and **not waived**.

**Source edit — one section.** The FT-18 heading is struck and a concise resolution appended **inside the
FT-18 section, before FT-19**. Sections were parsed at write time and offsets recomputed from that parse — no
whole-file restore and no reused static offset. Invariants were asserted **before** publishing: 51 headings
with identical ids and order, the **only** changed heading being `## ~~FT-18 · pi memory review~~`, and
**zero** other sections byte-differing. The original FT-18 operator paragraphs are preserved verbatim, as are
the accepted FT-10 / FT-11 / FT-19 resolutions.

| Measure | Value |
|---|---|
| md5 | `ec3a105404502b68fb7dc3b9e53be439` |
| sha256 | `d5ccd8ebec127d9167e958a8426b409b04135dd3a1e5551221a2cc283a815e5e` |
| bytes / lines | 100,568 / 1,397 |
| headings | 51 total — **35 live**, **16 struck** |

**Queue record.** The FT-18 entry moved `unresolved → resolved`; it is the **only** entry whose value
changed. `source_file` remains the **exact original** reconciliation object (md5
`55e504868891230395f0db08e5176b4c`, 1,238 lines, 39 live, 10 struck) and is deliberately **not** tracked
forward — the current measurement lives separately in `current_source_snapshot` and `counts_live`. All prior
refreshes `0..8` are byte-identical, entry order and count are unchanged (41), the original cadence history is
untouched, and the expanded **8**-issue cadence is unchanged (`starting_batch_size: 5`, not a cap).

**Boundaries.** FT-20's real parser fix remains a separate issue and was not touched. No other issue entry,
no operator-file section outside FT-18, no TODO store, no skill/mode/profile/config, and no live operation was
changed. Private content appears here as aggregates only.

---

## 15. Clarification — FT-18 resolution wording corrected to exact operator terms (append-only, 2026-11-10)

**Writer:** lane `ft19-todo-acceptance` (`w1K:p2X`), child `swarm-c0l.9.3.4`. Doc-only; no store write, model
call, cleanup, reload, config, code or live-consumer change. This is a **clarification appended to §14**, not a
rewrite of it: §14 stands, and the five statements below are the authoritative wording.

Parent acceptance was already obtained; these are wording corrections to the FT-18 resolution in the operator
file, not a new review cycle and not new findings.

| # | Previous wording | Corrected wording |
|---|---|---|
| 1 | "the live store measured 6.45 MB" | **LIVE FACTUAL MARKDOWN 6.45 MB at 20:45:07Z**, out of the whole 511 MB |
| 2 | "5 in progress" | **5 progress/status-log entries** — *not* task status |
| 3 | "no cap that is merely switched off" | **nominal character caps NOT ENFORCED**, under policy-only, **by design** |
| 4 | "no child was ever claimed in the record" | the **INITIAL AUDIT child (`9.3.1`)** was never claimed; **other review children were** |
| 5 | "held Gemini evaluation and the conservative removal of the overlord entry" | **held Gemini-Accounts MEMORY scope** excluded; the whole **`.overlord` MEMORY scope** conservatively excluded — **wider than the actual tab hold** |

Corrections 1–3 tighten what the measurement actually covers: the 6.45 MB is the factual-markdown portion of a
511 MB inventory, the "5" counts progress/status-log entries rather than task statuses, and the cap position is
that nominal character caps exist but are not enforced under the policy-only configuration — not that no cap
exists. Correction 4 matters because it distinguishes the one child that was genuinely never claimed from the
review children that were. Correction 5 states the exclusion at the **scope** level and records that the
overlord exclusion is deliberately broader than the tab hold.

**Scope of the edit:** the FT-18 resolution text only. One section changed
(`## ~~FT-18 · pi memory review~~`), 51 headings with identical ids and order, **zero** other sections differing,
one hunk (+9/−8). No other section, no history and no `source_file` was mutated.

| Measure | Value |
|---|---|
| md5 | `586f0edafbd797c8c828f6170b767456` |
| sha256 | `a576cd385b40fdc3eb5b27be64b4ab36a947c1d9635c4485b598e27644cde8cf` |
| bytes / lines | 100,794 / 1,398 |
| headings | 51 — **35 live / 16 struck** |

Queue: `source_file` remains the exact original object (md5 `55e504868891230395f0db08e5176b4c`, 1,238 lines,
39 live, 10 struck); the current measurement is kept separate in `current_source_snapshot`; prior refreshes
`0..9` are unchanged; entry values unchanged; cadence unchanged (8, `starting_batch_size` 5, not a cap).


---

## Rolling ACTIVE-eight reconciliation — 2026-11-10T22:56:03Z (swarm-c0l.9.46)

**Current supersession notice.** Maintain approximately EIGHT ACTIVE unresolved issues as a ROLLING target; refill after verified closures, not eight total issues shrinking after closures. Current unique active eight: FT-15/20/26/47/17/22/28/30. Five was the initial size, not a cap. Prior original-eight Batch01 fan-in swarm-c0l.9.45 remains a historical input, not a blocker on rolling refill. Compact for real context thresholds, batch boundaries or operator need, never an artificial per-issue barrier. Serialize only actual canonical/push/live conflicts; retain exact-commit acceptance, privacy/paid/auth/hold/release gates and no self-release of live controls.

Older five/eight totals, per-entry compaction gates, original batch `active` flags and prior candidate/status claims remain historical receipts, not current policy. FT-10/11/18/19 are verified closed; this pass closes **no** whole issue. FT-11 was superseded into **FT-21, still OPEN**, with usage carry and the roster obligation (workspace name/ID, pane ID, tab, session, lane and bead linkage). Historical source-restore claims are not reinstated; prior corrections stand.

### Actual rolling refill joins — verified artifacts, not inferred from `working`

SI independently verified first assistant output at **2026-11-10T22:39:15.717603+00:00**. The four supplied immutable start/join records match in every common field; parent/child ids match the queue, and each first assistant output follows its recorded start. This pass cross-checks those artifacts, not sessions or private history; this is start evidence, not acceptance/completion.

| Issue | Parent / child | Worker | Pane / tab | First assistant output |
|---|---|---|---|---|
| FT-17 | `swarm-c0l.9.21` / `swarm-c0l.9.21.1` | `ft17-goal-review-worker` | `w17:pV` / `w17:tV` | `2026-11-10T22:37:44.908Z` |
| FT-22 | `swarm-c0l.9.10` / `swarm-c0l.9.10.1` | `ft22-pretty-tui-worker` | `w17:pW` / `w17:tW` | `2026-11-10T22:37:54.799Z` |
| FT-28 | `swarm-c0l.9.24` / `swarm-c0l.9.24.1` | `ft28-tps-stats-worker` | `w17:pX` / `w17:tX` | `2026-11-10T22:38:03.996Z` |
| FT-30 | `swarm-c0l.9.25` / `swarm-c0l.9.25.1` | `ft30-fabric-review-worker` | `w17:pY` / `w17:tY` | `2026-11-10T22:38:12.744Z` |

Anchors: `.local/state/fleet-batch-01/rolling-refill-8-starts.json` SHA-256 `eaf15db71616edbe7cfa7991ac4afaa2616f88914c967e737f96ee5f7872a910`; `rolling-refill-8-joins.json` SHA-256 `cda046dbda11690e54649e5c5dff87368edbbecbc989eab35fca5b216ed964ae`. Full session paths remain in the JSON anchors/current entry annotations; no transcript read.

### State snapshot — brief at 22:44Z plus the supplied FT-15 delta, not permanent live status

- **FT-15 OPEN / active gap candidate.** Original `verified_already_satisfied` classification/notes are stale and kept as history, not closure proof. Exact b52 accepted 8/8; source S `d5868d7`, exact 8 blobs, 9/9. FIRST publication FAILED pre-push: fixture polluted owned worktree `7c452b56`; failed evidence preserved, clean S recovered. Minimal hook-test fix `30a718a37` on `37760`, exactly 2 test paths / 114 insertions; base caller HEAD/index/config corruption reproduced, fixed success + forced failure unchanged, full fix/S 9/9; SI read exact diff and reaccepted. Latest renewed **ONE-writer publication release: room `ft-01-yellowstone-subrepo#542`**, **NOT yet verified published**. `.local/state/ft15-hook-fix/result.md`; failed `.local/state/ft15-publish/result.md` retained. Adoption `.local/state/ft15-adoption/result.md` is **CONDITIONAL prep only**: actual `/profile reload` required, 2 new `.pi/agent/skills` links + 2 profile arrays; original `.agents` links kept, ask untouched, pE reserved canary. **NO LIVEAPPLY** until positive publication handoff + precise SI release.
- **FT-20 OPEN.** b71 strict 0 / 32 tests / 8 controls independently **REJECTED**, not integrable: R1 partial-write mutating retry + undercount, R2 actual warning raw metadata unbounded/unredacted. `.local/state/ft20-exact-review/acceptance.md`. Correction `ft20-correction-worker` `w1K:p32/t2Q`, child `9.4.4`, own branch, narrow R1/R2 + fresh SDK link-gate fix; portable plan-state only, no canonical/live/network/provider release. Historical warning cause remains unknown; operator objective is investigation, not forced `failures.md` rotation.
- **FT-26 OPEN.** Delivery exact `f02cce9df960b5eb0f3bbcdfd519fe158d9db75c` accepted 104/104, strict 0; within/transient/between twice/control and D1-D6; SI read `.local/state/batch01-accept-ft26d/acceptance.md` + exact diff. **Source publication ONLY QUEUED behind FT-15 canonical resource**, no live release. Separate `ft26-identity2-worker` pT identity/V3 remains active: supported ctx sessionID/session-pin restart/live collision/atomic claim barrier; V3 honest sender/no-presence queue preserved/no expiry; independent acceptance before publication. Source children `9.5.2/3` closed with evidence, not whole FT-26.
- **FT-47 OPEN.** Source published root `37760` / hooks `705137`, tests/root 9/9; FT-37 preserved. Actual full-profile 4-entry loader zero-provider inert-component proof accepted; metadata-only 77-line attestor scratch native/reload proof accepted. ONE real pM via separate pZ coordinator **FAILED/CLEANED 22:43:22Z**, preflight directory `0775` versus `0700`; **no backup/injection/reload**, proper stop. SI released **ONLY artifact-directory 0700 repair + fresh one-canary retry with owner-hold clearance**; no guard relaxation; failed result preserved. **No verified real adoption / other rollout.** `.local/state/ft47-canary/result.md`, `.local/state/yellowstone/ft47-attest/{result.md,plan.md}`.
- **FT-17/22/28/30 OPEN and actually started**, as the verified joins above establish; no acceptance or completion claimed.

### Compaction — ALL THREE complete per supplied verified snapshot; no repeats

SI event `d08de1c2` 22:12:28.150Z, 425791 tokens, 40.6→6.6%, full 2158Z read ACK; Yellowstone `d9c7ec00` 22:12:38.004Z, 584119 tokens, 58.4→8.0%, full 2158Z ACK, explicit resume `30565a69`. Overlord **ONE** compact `330b690b` 22:25:29.931Z, 434223 tokens, 41.4→5.6%, same session; exact 2213Z read tool 22:26:04.968Z + full 150-line ACK `a93754ff`, working resumed verified 22:27:03Z. Receipt `.local/state/midbatch-overlord-compact-20261110T2221Z/FINAL.json`. No repeats/new/restart requested or performed. These facts are imported from the bounded brief, not independently reread here.

### Fresh read-only source measurement and preservation

At **2026-11-10T22:49:53.624701+00:00**: **100,794 bytes / 1,398 newline-count lines; 35 live + 16 struck = 51 headings**, SHA-256 `a576cd385b40fdc3eb5b27be64b4ab36a947c1d9635c4485b598e27644cde8cf`, md5 `586f0edafbd797c8c828f6170b767456`. Counts remain separate: original reconciliation `counts`/`source_file` unchanged; current queue 41 entries / 6 previously resolved, current rolling-active count 8. No new whole issue closed.

Private byte-exact preimages, CAS checks, exact diffs and invariant receipts: `/home/bitnom/.local/state/rolling8-records/`. Original `source_file`, all earlier refreshes/order, all pre-existing entry fields/order, historical cadence prefix and non-target fields preserved. Report/execution are append-only; cadence keeps the entire historical prefix with this current superseding section. Operator source bytes are read-only and unchanged. Private documentary claim `swarm-c0l.9.46` only — **no Beads write**, source edit/restore, run/code/live-control/provider/network write, dispatch, closure or reload. SI retains record authority.


---

## Separate FT-30 source closeout — 2026-11-10T23:02:18Z

Explicit second-tranche release: `.local/state/rolling8-records/ft30-closeout-release.md`, after first-tranche result/diff/CAS/invariants were frozen. **FT-30 resolved on SI-accepted scoped review: KEEP native codemode; no Fabric install/swap/runtime change.** Accepted artifact `/home/bitnom/.local/state/ft30-fabric-review/result.md`, SHA-256 `b3a8dcfdc9320a4ab6a9c38c43f052e7b6b9ef86f76745b3014972b4b3f39a09` (actual 34,898 bytes; release's 34,900-byte label differs by two, exact released digest matches). Full artifact read; SI acceptance and decisive compiled/native cross-checks supplied in release, no retest/adoption here.

Pinned pi-fabric 0.135.2 tarball integrity/static compiled code vs installed pi/codemode 1.5.0: default Fabric full-code hides native codemode/tool_search and model-only goal terminal tools. Foreground mitigation needs review and is incompatible with Schema enforce. Node 22.23.3 is below >=24. Native batching/filter/discovery needs already met. No observed or established net performance/cost/security superiority; no comparative runtime benchmark. Scoped fleet review, not exhaustive or full security certification. Future concrete Fabric-only need alone warrants separately authorized isolated pinned orchestration-only fullCodeMode:false, Schema enforce off, supported runtime + safety proof. No user-auth/provider/benchmark/config/install/runtime change.

Source: only FT-30 heading struck + UTC completion date and resolution inserted under FT-30 before its **byte-exact original operator body**. All 51 sections parsed, all 50 non-FT30 sections unchanged including prior resolutions; no whole-file restore. New source **102210 bytes / 1406 newlines / 34 live + 17 struck = 51 headings**, SHA-256 `c5f99ca5f96ee1cd938a5224a8cf8d2fd9a1cc26663dba2b41b337c40bc1f8a3`, md5 `09e1b941ffcdec27c69e49dba633e1b2`. Queue original source_file/counts immutable; all prior refreshes prefix/order exact, 41-entry order and all non-FT30 entries exact; current source counts separate, 7 resolved queue entries.

**Rolling eight, not nine:** FT15/20/26/47/17/22/28/**33**. SI DM `63b095c7` supplied FT33 actual-start verification via Yellowstone anchor + p0 output at 22:53:13.550Z, session `01a1c7aa-5dcd-7347-91a9-c82eb0265663`, artifacts `.local/state/ft33-jj-review`; read-only review, no acceptance/completion. No pane/session reread here. FT30 wraps into this documentary closure, not a ninth active issue. **Later supplied delta (SI DM 5dbf530e, documentary annotation only):** SI full-read renewed FT15 result + both pushes/C-P 9/9 invariants + actual canonical FF `bab49125` clean / `ac3d24a` accepted skill bytes at 22:58:55Z. FT15 **ONLY 2 profiles/2 new links + one pE /profile reload canary** separately LIVE released f929 reply at 22:59Z; no completed-adoption proof claimed and no other-lane refresh release. Room `#545` activates sole FT26 exact f02 **source** publication after pQ settled/clean, identity/V3 excluded; no successful publication outcome claimed. FT47 real canary retry **FAILED missing receipt despite confirmed reload**, exact restore/cleanup/preservation good; **scratch transport diagnosis/fix ONLY**, no new real retry. These supplied SI updates supersede only the earlier snapshot claims; no additional issue entry/source edit or live action here. Earlier first-tranche active-set/cadence-document snapshots remain historical and frozen, superseded here only as stated.

Separate preimages, before/after diff, fresh CAS and all-51-section/operator-body/source_file/prior-history receipts: `/home/bitnom/.local/state/rolling8-records/ft30-tranche/`. First-tranche artifacts untouched. No other source heading or issue entry closed; no Beads/run/code/live/provider write, dispatch or reload. SI alone verifies and closes Beads.


---

## Separate FT-17 review/recommendation source closeout — 2026-11-10T23:08:04Z

Third-tranche explicit release `.local/state/rolling8-records/ft17-closeout-release.md`, after frozen first and FT30 tranches. **FT17 resolved on SI-accepted investigation/recommendation: KEEP existing goal continuation/safety/wait contract; NO speculative additional reminder feature/config tuning without measured need.** This supersedes the worker proposal's recommendation to implement: the response-count design remains **NOT IMPLEMENTED**, not an authorization or delivered feature.

Actual pi-goal **1.4.8** on Pi **1.5.0** has no periodic mid-turn timer/per-model or interval controls. Active-goal system binding persists; normal unfinished agent_end queues one idle/pending-gated continuation. Background monitors do not make host nonidle. goal_wait parks durably; passive Bizzy stream lines do not wake, terminal notices can start ordinary conversation but do not resume recorded goal wait. Use goal_wait with reason/realistic safety deadline or explicit authorized resume/real input; no event-only wake promise or suppression for unrelated monitors. Proposed interval 0 affects only new extra response-count messages, not current continuation/system binding, so adding it now would not reduce observed nudges; no seconds interval/token budget.

Full-read evidence: `.local/state/ft17-goal-review/result.md` SHA-256 `42455521eb52714cf605b8678f9787edbfaaa8bdbd511b5cc3ccb57a02dcadac`, `proposal.md` SHA-256 `59735d1d826fa273cef89f41a7b30e716dd25b6cacf22cf54c86c9bfa331e07c`; source/test ledger `evidence.md`. SI full-read reports plus decisive runtime continuation/turn_end/cadence/Bizzy constants cross-checks supplied by release. **221 mocked tests across 9 suites reported passing**, not rerun here; UI dependency/full-suite limitations preserved, **NOT green full suite**. No code change/live goal lifecycle/provider/model test or config tuning.

Only FT17 heading struck/completed UTC date + compact resolution inserted before exact original operator body. **All 51 heading sections parsed; all 50 others, including FT30 resolution, byte-identical.** Source **104059 bytes / 1414 newlines / 33 live + 18 struck = 51 headings**, SHA-256 `53c2d985fe506d8f228ab93ae97a096af28094e11d07a6e9a323f8698ebac39f`, md5 `15b183ecc3829529fb7c6dea3143c547`. Queue original source_file/counts and non-target fields preserved; all prior refreshes exact prefix/order, entry order and non-FT17 entries exact; current 8 resolved queue entries kept separate from original reconciliation. REPORT/EXECUTION append-only.

Operational selections remain eight: FT15/20/26/47/22/28/33/**13**; FT13 read-only install/pin-purpose verification selected/routing to Yellowstone, **actual start pending**, no new worker/acceptance claimed. FT17/30 accepted reviews are source-closed, not counted as running panes or extra ninth issues. No other issue state/heading closed. No source restore, code/config/modes/skill/Beads/run/live-control/provider write, dispatch or reload. SI alone closes Beads after verification. Separate receipts `.local/state/rolling8-records/ft17-tranche/`; frozen first/FT30 results/diffs/CAS unchanged.


---

## FT-33 exclusive documentary closeout — 2026-11-10T23:38:28Z

`swarm-c0l.9.26.2/actualjoin`, released by `/home/bitnom/.local/state/ft33-closeout/brief.md`. SI accepted the negative review: **ABANDON the current fleet-level jj-support claim; KEEP optional installed conveniences unproven/project-restricted; Yellowstone NO-jj.** No uninstall/disable/update/migration or speculative upgrade/new product. This fulfills the nail-down-or-abandon ask, not delivery of support.

Accepted full-read report `/home/bitnom/.local/state/ft33-jj-review/result.md`: **22,981 bytes**, SHA-256 `ef2d49cf24204b1fc6c17b4f36e70b8a6faf4d10c06b56f460a9f4356c6a955b`. Reviewed installed Herdr 0.9.5 / Pi 1.5.0 / Node 22.23.3 / jj 0.45.1; jj-status `40588ef743e1dd6a252b2e39765616584fd2e39e`, registered jj-waltz `cd7bb1eb6451b09c06853b0347f856b4203f7c89`. Installed jj lacks `workspace add --colocate`; Git-worktree discovery/cleanup, opaque-ID removal safety, restore ownership and `pil` identity remain gaps. Current upstream alternatives are scoped static review, not live integration proof or universal-breakage findings. No runtime adoption claim.

Source closure changes only FT33's heading and inserts its compact resolution before the **byte-exact full original body**. All **51 sections** parsed; all **50 others**, including FT17/FT30 resolutions, unchanged. Actual counts **33→32 live, 18→19 struck**. New source **105341 bytes / 1420 newlines**, SHA-256 `d256bd1a12598a9e0ddd4a8e7e59a9f0e94d5200b01d48915e8466c788e45822`. Original queue `source_file`/`counts` immutable; all 14 prior refreshes exact prefix/order, all 41 entries same order and every non-FT33 entry unchanged. Current count snapshot is separate; resolved queue entries **8→9**. REPORT/EXECUTION are append-only.

**Rolling eight:** FT15/20/26/47/22/28/13/**34**; FT34 replaces FT33, not a ninth. SI supplied actual join: `ft34-codex-instructions-worker`, `w17:p17` / `w17:t17`, selected session `2026-11-10T23-20-40-820Z_01a1c7c3-8073-730a-89d2-a688e5769635.jsonl`, first assistant `2026-11-10T23:20:53.226Z`, verified `2026-11-10T23:22:24Z`. No new session/pane read; this proves the supplied join, **not all eight currently working**, completion or adoption. Other issue entries/states/cadence remain unchanged.

Private fresh byte-exact preimages (directory 0700), stat/hash CAS, actual diff and all-section/history/prefix receipts: `/home/bitnom/.local/state/ft33-closeout/{preimages/,exact.diff,invariants.json,cas.json,result.md}`. No whole-file restore, Beads/.dagr/code/config/run/live/control/provider/network/private-history change. No parent completion claim; SI reads the actual diff/invariants before any Beads closure.
