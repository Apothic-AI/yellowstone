# FT-37 final closeout — bounded worker job

You are ft37-closeout-worker, dispatched by self-improvement-leader. Parent bead swarm-c0l.8.
Do not claim/close that parent or another space's epic. Do not start another issue. Code is accepted,
integrated, published, and verified: Yellowstone root 2479131b6687ab31b8c25a671ba65598f545dfa7;
pi-fleet-hooks master 8ab092849074e6c96131f565caa1a1332047b9bb. Do not re-implement/retest/push.

## Deliverable

Finish the existing rollout from THIS different lane, not from the target worker's own turn, and
write `/home/bitnom/.local/state/yellowstone/ft37-integration/closeout.md` plus atomic confirmation
JSON under that directory. Update result.md corrections, preserve history. Read its latest sections
and finish-rollout.md first. The result watch timed out; the blocker is known, not exploratory.

1. Existing helper `~/.local/state/pil/reload-results/self-w17-p6-1794312827475.json` is waiting.
   It only accepts `idle`; yellowstone-worker w17:p6 is settled `done`, so waiting cannot fire.
   Verify exact helper process and start identity NOW before stopping it. Use sanctioned explicit
   process-field tools/proc-find or an exact freshly-read PID, never pattern kill or a historical PID.
   Preserve old receipt as history; write superseding closeout receipt. No duplicate active helper.
2. Verify tab/pane identity is yellowstone-worker w17:p6 in Yellowstone, safely idle/done (not a
   working turn, modal, or unknown). Reload it with the sanctioned per-pane reload mechanism from
   THIS lane. Do not send Esc, prompt working lanes, restart agents, alter goals or profiles, touch
   watchdog/Dolt/systemd infra, or run a paid model request. Loader/SDK proof already satisfied.
   Verify the real reload confirmation and no extension errors. Record exact pane/session, UTC,
   command, status, log, outcome. If working, use bounded waiting until stop boundary with failure
   handling; no fixed sleep N and no blocking your session.
3. Verify already-confirmed yellowstone-leader receipt `leader-w17-p1-reload.json`. Do not reload it
   redundantly. Final batch inventory is in /tmp/ft37logs/agents*.json and result.md: 26 batch +
   separate loader lane + leader + worker = 29 original Pi consumers. Derive unique pane count,
   scope/exclusions, and correct result.md's inconsistent '27 of29' arithmetic. Do not invent per-pane
   historical confirmations that the tool did not persist; distinguish send-time tool verification
   from live independent reads. Existing count is 26/26 tool-confirmed, not independently re-proven.
4. Existing queue export DOES exist:
   `/home/bitnom/Documents/Fleet/pi-fleet-model/FLEET-ISSUE-QUEUE.json` and matching REPORT.md.
   result.md §9.5 falsely claims no export exists after searching literal strings; correct that.
   Refresh only FT37 closure / source digest/count of the export/report, retaining original snapshot
   provenance and Beads mapping, not re-enumerating/researching all issues. Operator source now has
   FT37 strikethrough/RESOLVED and FT47 unchanged open. Preserve it; no unrelated edits.
5. If successful, write final concise closeout evidence and proposed bead close reason, but LEADER
   closes swarm-c0l.8 after reading. Include any remaining loader/signature/replay limitations from
   committed docs, FT47 still open, root/source/hooks IDs correctly distinguished. If unable to
   confirm reload, report real blocker; never mark complete on waiting/scheduled.

Optional root work ONLY if necessary to fix stale rollout helper artifact inside Yellowstone:
not authorized here; report it as a separate issue for later, do not expand scope. No new code or
mode changes. All research and integration remain workers' work per operator. Leader verifies
artifacts, then writes a NEW dated handoff and asks overlord compaction before next issue (FT32).

Your own new lane loaded the already-published extension on startup; confirm registration if useful
but it is not one of the original 29 consumers and needs no redundant reload. Stop once closeout.md
and confirmations are written. Report paths through available messaging; otherwise final answer
contains exact path (leader watches lane stop). Do not prompt a working leader to report.
