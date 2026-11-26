# CURRENT STATE — Herdr/Pi session pin-drift (read this first)

**Written:** 2026-11-06 ~14:50Z by `self-improvement-leader`, pane `w1K:p1`, cwd `/home/bitnom/Documents/Fleet`.
**Supersedes:** every earlier continuation and handoff on this defect, including
`CONTINUATION-herdr-idle-2026-11-06-fresh-session.md` (which says "NOT SOLVED" and is now **obsolete**),
`CONTINUATION-herdr-pi-idle-authority.md`, and `/var/tmp/herdr-leader-*.md`.

**Status: RESOLVED, DEPLOYED, AND CUT OVER.** The defect is closed. Do not reopen it from the older
documents — they were written while it was still open and their "not solved" and "next action" sections
are superseded by this file.

---

## 1. What the defect was

A Pi lane whose Herdr pin had drifted to a stale session file could not recover. It stayed
`agent_status: working` indefinitely with `screen_detection_skipped: true`, because full-lifecycle hook
authority suppressed screen detection while the authority itself pointed at a session Pi was no longer
writing. Ordinary turns advanced the sequence watermark and were silently dropped.

Three separate defects stacked to produce it. Fixing any one alone was never enough, which is why it
survived several repair attempts.

## 2. The three fixes

| Commit (merge branch) | Deployed-line SHA | What it fixes |
|---|---|---|
| `b81330b7` | `04d9c973` | Stale `hook_authority` survived a validated process-exit replacement, so later reports were rejected. 5-line production hunk. |
| `ce7d86d7` | `2d37601b` | Reason-less lifecycle state reports could arm a synthetic `ProcessExit` gate that re-armed itself every turn. **Hardening, not the recovery.** |
| `6dca9a29` | `222edf09` | `persist/snapshot.rs` preferred `hook_authority` over `persisted_agent_session` on save, so **every handoff rewrote the accepted session back to the stale one** and undid each repair. **This was the loop that made the bug survive repeated fixing.** |

Recovery itself was a genuine same-session `/resume`, executed by the operator at `12:38:44Z`
(note: the lane's footer showed `working` at ~14:55Z because this document was being written in it —
that is this writing turn, not a relapse of the defect). Verified
from the server trace (`applied=true`, `incoming_session_is_current=true`, `authority_session=C`), not
from a lane report. The patches removed what blocked recovery; they did not perform it.

## 3. Git state

- **Merge branch:** `apothic-main` at `Apothic-AI/herdr` (`origin`), head **`6dca9a29`**, 8 commits,
  20 files, +1059/−32 from `origin/master` (`ee5bfb50`). Pushed and verified: `origin/apothic-main == 6dca9a29`.
- Built from `origin/master` **excluding** the `a1526efe` diagnostic tracing layer (`pi.session.*` events,
  `PiSessionAcceptanceDiagnostic`). Our merge branch is clean of debug scaffolding.
- SHA mapping between branches (cherry-picks, **not** rebases): `04d9c973→b81330b7`,
  `2d37601b→ce7d86d7`, `222edf09→6dca9a29`. Resolving `04d9c973` dropped a diagnostic-only test, so the
  branches are **behaviourally identical, not byte-identical**.
- **No upstream PR.** The upstream intake gate was never satisfied and nothing in this work changes that.
  Do not propose one.

## 4. Live state

- Live server runs the merge branch: PID **2518273**, `/proc/2518273/exe` sha256
  `0555c1f58e0acb88f62785c675dc634df1441a58e8eb6470bb18105dba15747d`, deployed via supported `live-handoff`.
- Panes **67→67 at cutover**, no additions or removals (verified from `pre-panes.json`).
  Live counts drift afterwards as lanes open and close: `wE:p2M`/`wE:p2Q` were **closed by the operator**
  as ordinary cleanup, `w1Z:pD` opened. **A different count now is churn, not a symptom.** Verify
  continuity by comparing against `/var/tmp/herdr-apothic-deploy/pre-panes.json`, not against 67.
- Server log `/home/bitnom/.config/herdr/herdr-server.log` mode `0600` (re-verify with `stat -c %a`).
- Affected lane's pin reads the real session file
  (`.../2026-11-06T10-44-38-632Z_01a1b075-e467-7797-99f0-f2dc7f05d333.jsonl`) — recovery survived the cutover.
- **Rollback chain**, most-preferred first: `/var/tmp/herdr-apothic-deploy/herdr` (live source) →
  `/var/tmp/herdr-defect2-deploy/herdr.next` (`05782eab…`, previous live) →
  `/var/tmp/herdr-reanchor-88e3166d/herdr` (`88e3166d…`, known-good).
  Command: `herdr server live-handoff --import-exe <path> --expected-protocol 22 --expected-version 0.9.5`.

## 4a. DEPLOYMENT DURABILITY — added 2026-11-08, read before any herdr deploy

**`herdr server live-handoff --import-exe <path>` swaps the running process and nothing else.** It does
not install anything. If you do not also rewrite the launcher binary, **the next reboot reverts the
fleet to whatever `~/.local/bin/herdr` held** — and the revert is silent.

That is not theory: every fix in §2 was cut over with `live-handoff` from `/var/tmp`, the launcher file
was left at the 2026-11-05 build (`88e3166d…`), the machine rebooted at **2026-11-07 21:23:35**, and the
server came back at 21:38:19 on a plain `herdr server started` from the launcher path. The fleet then ran
**pre-fix code for a day and a half** while the status icons looked healthy, because the defect needs a
session transition with a stale pin and no lane had hit that path. Proven behaviourally, not by
inference: the disposable probe in `/var/tmp/herdr-livebuild-probe/` shows `88e3166d…` dropping the first
`pane.report_agent_session` for an unregistered pane (`agent get` → `agent_not_found`) where `0555c1f5…`
adopts it (`unknown` → `working`); `exact_serving_binary: true` on both runs.

**The deploy sequence is therefore two steps, never one:**

```sh
herdr server live-handoff --import-exe /var/tmp/herdr-apothic-deploy/herdr \
  --expected-protocol 22 --expected-version 0.9.5
install -m 0755 /var/tmp/herdr-apothic-deploy/herdr ~/.local/bin/herdr   # survives reboot
~/.overlord/tools/herdr-binary-guard.sh --pin                            # re-pin the watcher
```

**Live state after the 2026-11-08 redeploy:** server pid 1329463, `/proc/1329463/exe`,
`~/.local/bin/herdr` and the pinned sha all `0555c1f58e0acb88…`; panes 69→69, agents 42→42 preserved;
previous launcher kept at `/var/tmp/herdr-launcher-88e3166d.bak`.

**The guard:** `~/.overlord/tools/herdr-binary-guard.sh` with `herdr-binary-guard.{service,timer}`
(enabled, every 15 min, 3 min after boot). It compares the serving `exe` **and** the launcher file
against `~/.local/state/pil/herdr-expected-binary`, exits 1 on drift, appends to
`~/.local/state/pil/herdr-binary-guard.log` and writes `herdr-binary-guard.MISMATCH`. Read-only; it
reports and never repairs. If it fires, the answer is the three commands above, not a rebuild.

`--version` is `0.9.5` on every build we have, so **a version string proves nothing here**. The pinned
sha is the only identifier that distinguishes them.

## 5. Test status — read this before running tests

⚠️ **`cargo test --release --bin herdr` reports 35–37 failures. These are PRE-EXISTING and ENVIRONMENTAL.
They are not caused by this work. Do not scope them into it and do not "fix" them as part of it.**

Evidence:
- Pristine `origin/master` in this environment shows the **same 35 names**.
- `apothic-main` runs 3767 tests vs 3755 baseline — exactly the 12 added regression tests — with
  correspondingly more passing.
- Largest cluster: one `NotFound` unwrap at `detect/manifest_update.rs:842` poisons a shared `Mutex`,
  cascading into 7 `PoisonError`s. Test isolation under parallel execution, not production behaviour.
- Two names appear only on our branch; both pass **3/3 in isolation** and are load-sensitive
  (`primary_screen_replay_honors_ed3_for_droid_at_chunk_boundaries`,
  `finite_clipboard_commands_report_exit_status`).

**Toolchain that matters:** `RUSTUP_TOOLCHAIN=1.96.1`, `ZIG=…/zig/0.16.0/bin/zig`,
`CARGO_TARGET_DIR` set to a scratch path. `mise current` reports rust 1.99.0, which is **not** what this
repo builds with.

## 6. Known limitation, deliberately not closed

`HandoffAgentState` on `apothic-main` is `{authority, sequence, acquisition_pending}`. It does **not**
carry `verified_pi_reporter`, so **Pi provenance is lost on every handoff**.

- A genuine `session_start` with a reason (`new`/`resume`/`fork`) still works after a handoff —
  `session_report_allows_session_replacement` permits `herdr:pi`/`pi` on those reasons regardless of provenance.
- A **reason-less** report cannot reanchor after a handoff, because `verified_pi_reporter` is `None`, so
  `same_reporter_reanchor` is false and the report dies at `session_replacement_not_allowed`.
- **Practical effect: recovery after any restart needs a real `/resume` or `/new`, not an ordinary turn.**
  This is observed, not theoretical — every `w1K:p1` acceptance record after the `11:20Z` handoff carried
  `raw_verified_reporter: None` and `effective_verified_reporter: None`.
- The abandoned `a5e20206` addressed exactly this and was retired on 2026-11-06, correctly: the uncommitted
  OptionA rule beside it would have dropped Pi authority on every handoff from an exporter lacking
  `pi_authority_proof`. Archived at `/var/tmp/herdr-pin-drift-retirement/` (`SHA256SUMS` 4/4 verified);
  the commit object survives in `/home/bitnom/Code/herdr` as an unreachable prunable object, so the patches
  are the durable copy.

Also open, pre-existing: a hard kill between the 15-minute snapshot writes can lose state after the last save.
Untested window; not introduced here.

## 7. Mistakes made in this session, recorded so they are not repeated

1. **Two regression tests were vacuous.** They seeded authority and persisted session *identically*, so the
   code took the innocent branch and the tests passed against unmodified code. Both were caught and rewritten.
2. **`CH99.8%` in a lane footer is the cache-hit field, not context.** I misread it and raised a false concern
   about another lane's context. Read `23.2%/1.0M` — the `N%/1.0M` form is context.
3. **Searched the wrong path for the session snapshot.** It is flat at `config_dir/session.json`
   (`persist/io.rs:11`), not under `sessions/<name>/`. The server log's own `persist.save` events had the
   exact path all along; grep the writer's own log before spelunking source.
4. **A scratch probe worktree was created and removed** (`/var/tmp/herdr-pindrift-probe`). It is gone;
   `git worktree list` is clean. Recorded so its absence is not mistaken for tampering.

## 8. Where the detail lives

- `EXECUTION-RECORD.md` — Defect 1 / Defect 2 / Note 3 sections, the RECOVERY entry with trace evidence,
  "MERGE BRANCH AND CUTOVER — 2026-11-06 13:45Z", and "KNOWN LIMITATION — Pi provenance is lost on every handoff".
- `HERDR-SESSION-SUMMARY-2026-11-06.md` — standalone narrative summary.
- `~/.overlord/notes/queued-herdr-pin-drift-resolved.md` — the report sent to the overlord.

## 9. What is NOT the next action

- Do not re-run the diagnostic investigation.
- Do not propose an upstream PR.
- Do not treat the 35–37 test failures as a regression from this work.
- Do not reopen `pi-modes` / mode-composition questions — those are settled elsewhere.
