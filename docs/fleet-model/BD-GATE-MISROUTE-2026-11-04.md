# `bd gate create` misroutes a gate edge across id prefixes — full detail

**Date found**: 2026-11-07 · **Reporter**: `ds-leader` (`wX:p1`) · **Status**: root cause demonstrated, repaired, verified

Split out of `INCIDENT-slash-command-as-prose-2026-11-07.md`, where it was originally bundled. It is
a **beads/Dolt** defect and has nothing to do with the slash-command incident beyond being reported
by the same lane on the same evening. The fleet record of it is `EXECUTION-RECORD.md` §30.

This is an **unsummarised detail file**; the standing fleet record is §30.

---

## 1. Summary

`bd gate create` can write a gate edge into `dependencies.depends_on_external` instead of
`depends_on_issue_id`. `ready_issues` is a view matching on `depends_on_issue_id`, so a NULL target
can never match — the gate exists, `bd gate list` shows it, and the bead stays **claimable**. The
one confirmed trigger is a **blocked bead whose id prefix differs from the gate's**.

One edge in the fleet was misrouted (`open-surrealdb-ds-287.13`, written 2026-11-04, invisible for
three days). Repaired and verified; fleet-wide malformed count now 0.

---

## 2. The defect

`bd gate create` wrote a gate edge into `dependencies.depends_on_external` instead of
`depends_on_issue_id`. `ready_issues` is a **view** matching on `depends_on_issue_id`, so a NULL
target can never match: the gate exists, `bd gate list` shows it, and the bead stays claimable in
`bd ready`.

**Confirmed from Dolt's own diff.** Commit `dl04fmuhrbeprmgvpvnieigkk8vdg91u`
(`dependency: add blocks open-surrealdb-ds-287.13 -> swarm-7uh`, **2026-11-04 22:05:03Z**) reads:

```
to_depends_on_issue_id = NULL
to_depends_on_external  = swarm-7uh
```

added on top of `3fp366lv4c0g88pok70fsdmbfgpp0682`, which created the gate 39ms earlier.

## 3. Root cause: prefix mismatch between blocked bead and gate

The exact command line, retrieved verbatim from `ds-leader`'s transcript at
`2026-11-04T22:05:03.737Z`:

```
cd /home/bitnom/Code/open-surrealdb-ds && bd gate create --type=human --blocks open-surrealdb-ds-287.13 \
  --reason="Only the operator can decide this — accept, amend or reject docs/goal-production-ready.md" 2>&1
```

Nothing unusual in the argument shape. The variable was the **id prefix**: the blocked bead is
`open-surrealdb-ds-287.13` (prefix `open`) while the gate is `swarm-…` (prefix `swarm`).

`ds-leader` ran two probes with an identical command line, differing only in prefix:

| probe | blocked bead | prefix | gate created | column written |
|---|---|---|---|---|
| cross-prefix | `open-surrealdb-ds-287` | `open` | `swarm-d9p` | **`depends_on_external`** ✗ |
| control | `swarm-7p5.3` | `swarm` | `swarm-zyw` | `depends_on_issue_id` ✓ |

**The correlation holds on the whole database**, verified independently in §5: of 14 gate edges,
`open-surrealdb-ds-287.13` is the **only** one whose blocked-bead prefix differs from its gate
prefix — and it was the only one that misrouted. All same-prefix edges wrote correctly.

## 4. Candidate elimination

| candidate | test | result |
|---|---|---|
| odd `--blocks` argument shape | exact command line retrieved; plain flag, flat id, no `:` route | **eliminated** |
| bead is a `decision`, not a `task` | `swarm-nvo.1`, `swarm-nvo.2` are decisions with correctly-routed gates | **eliminated** |
| bead already carrying a malformed row | gate created on such a bead | **eliminated** (wrote the correct column) |
| **blocked-bead prefix ≠ gate prefix** | **two probes, one variable** | **CONFIRMED** |

## 5. Independent verification performed for this record

- The cross-prefix asymmetry holds live: every gate edge now has matching prefixes except
  `open-surrealdb-ds-287.13`
- Commit `pgi31ced` exists (`probe: cross-prefix gate routing isolates the misroute trigger, then
  restores prior state`)
- Probe gates `swarm-d9p`, `swarm-zyw`, `swarm-cdy`, `swarm-7uh` are all `closed`; `swarm-94e` is
  the open live gate
- Malformed-edge sweep now returns **0**

## 6. Cleanup accounting (before-and-after, as requested)

`ds-leader` reports, and this record preserves: **before probes, 1 malformed / 57 blocks edges;
after, 0 malformed / 56 blocks edges** — the pre-probe state restored. `dolt_status` empty; 0 rows
referencing either probe gate; both probes resolved and closed; committed as `pgi31ced` so the
experiment is visible in history.

**This is the correct form of the accounting this record asked for previously.** The earlier
`bd gate` entry in `EXECUTION-RECORD.md` §30 was rewritten twice in one day — first to claim the
defect could not be reproduced, then to correct that — because an after-count of 0 alone cannot
distinguish "cleaned one bad row" from "created one and cleaned it". A before-count makes the
accounting checkable.

## 7. The repair is verified sound

- `open-surrealdb-ds-287.13` carries `blocks → swarm-94e`, `depends_on_external = NULL`, `is_blocked = 1`
- `bd ready --explain` reads `← blocked by swarm-94e: Gate: human [open]`
- All 14 gate edges sit in `depends_on_issue_id`
- Malformed-edge sweep returns 0 of 301 rows

---

---

## Sources

- Dolt: `dolt_diff_dependencies` on `dl04fmuhrbeprmgvpvnieigkk8vdg91u`; commits `3fp366lv…`, `odp1ebek`, `pgi31ced`
- `bd sql` against the shared beads database — prefix asymmetry, gate-edge and malformed-edge sweeps
- `~/.pi/agent/sessions/--home-bitnom-Code-open-surrealdb-ds--/2026-11-03T00-55-17-596Z_01a19ee7-3f5b-761b-88be-23064a5b45f6.jsonl` — the 2026-11-04 command line (`2026-11-04T22:05:03.737Z`)
- `pi-fleet-model/EXECUTION-RECORD.md` §30
- Group DM from `ds-leader`, id `24126231`
