#!/usr/bin/env bash
# overlord-wake — hourly self-wake for the overlord lane.
#
# Why: the overlord is the swarm's intake. Going idle with unfinished work is silent, and so
# is a dead watcher — the two failure modes that leave the fleet unwatched. An hourly prompt
# to this pane makes both self-detecting instead of something the operator has to notice.
#
# Contract, learned the hard way:
#   * a `working` lane IS prompted. Operator ruling, 2026-11-09: the prompt queues behind the
#     live turn instead of aborting it, so skipping bought nothing and cost the hourly cadence —
#     seven fires delivered once on a night this lane never idled (01:00-04:00Z all skipped).
#     Only `blocked` is skipped now, because herdr rejects a prompt at an approval dialog.
#     Consequence to keep in mind: a wake can land mid-work, so it must stay short and must not
#     assume the lane is at a boundary — and it must never be the reason a turn is interrupted.
#   * never submit an operator's draft. If anything sits in the composer box, skip.
#   * the prompt is labelled with provenance so the transcript never reads as an operator
#     instruction the agent invented.
#   * never reset a session that holds work. Operator rule, 2026-11-08: the reset exists to
#     stop idle wakes accumulating, never to discard a session with work in it. The wake
#     prompt states the rule outright and the agent reads it off its own session — the
#     session is in context, so checks (1)-(3) can come back clean while the session is not.
#     A detector script computes the same answer from outside, so there is none: the
#     instruction is the mechanism, and it is re-read on every tick. As of 2026-11-09 the
#     action behind that gate is `/undo` + Ctrl+C (tools/undo-self.py), not `/new` — the gate
#     is the same rule, the action no longer costs a session.
#
# Exit 0 in every skip case: a skipped wake is a healthy wake, not a failure.
#
# `--dry-run` logs the decision and prints the exact prompt without sending it.
set -uo pipefail
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

PANE="${OVERLORD_PANE:-wE:p1}"
HERDR="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
LOG="$HOME/.local/state/overlord/hourly-wake.log"
mkdir -p "$(dirname "$LOG")"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }
# In a dry run a would-be skip is reported and then ignored: nothing is sent either way, and
# the point of the run is to see the prompt the next real wake would carry.
skip() { say "skip $PANE: $1"; [ "$DRY_RUN" = 1 ] || exit 0; }

status=$("$HERDR" agent get "$PANE" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["agent_status"])
except Exception: print("absent")' 2>/dev/null)

case "$status" in
  absent)      skip "no agent in the pane" ;;
  blocked)     skip "status=$status (approval dialog; herdr rejects a prompt here)" ;;
  working)     : ;;   # queue behind the live turn — operator ruling 2026-11-09
esac

# Composer guard: any non-blank line inside the input box is someone's draft.
visible=$("$HERDR" pane read "$PANE" --source visible --lines 14 2>/dev/null || true)
if printf '%s\n' "$visible" | sed -n '/╭/,/╰/p' | grep -qE '^│[^│]*[^ │][^│]*│$'; then
  skip "composer holds a draft"
fi

msg='[hourly wake — self-scheduled by overlord-wake.timer, not from the operator] Self-check, then stop or continue: (1) `todo` list — anything in progress or pending that should be finished; (2) ./tools/leader-board.py — any lane BLOCKED, STALE, GONE or goal-degraded and unhandled, and any `!!` line at the top of the board — a `!! herdr binary` line means the fleet is not running the deployed herdr build, or will not reboot into it, and it is repaired that hour with the three-command sequence in pi-fleet-model/CURRENT-STATE-herdr-pin-drift.md §4a (a fleet ran pre-fix herdr for a day and a half because nothing read that signal); (3) systemctl --user is-active overlord-watch.service — the leader watcher is a systemd unit that outlives this session, so there is nothing to re-arm in-session; restart the unit only if it is not active. Do not start a bash background job to watch lanes: it dies when this turn ends and can never deliver its notification. If work is outstanding, continue it. (4) UNDO GATE — read this off the session you are in, not off a task list. Undo this wake turn ONLY when this session holds no work predating this wake: if any earlier message in THIS session is anything other than a wake — an operator prompt, a lane message, a job you were given, a thread you started — then do NOT undo this hour. No `~/.overlord/tools/undo-self.py`, no `/undo`, no session switch of any kind, however clean checks (1)-(3) look: an empty `todo` list, an idle leader board and an active watcher unit do not make a session disposable, and that misjudgement is why the operator had to restate this rule on 2026-11-08. This replaced the old `/new` reset on 2026-11-09: `/undo` rewinds the context to the latest user prompt (removing this wake turn) and Ctrl+C clears the composer, so wake prompts stop accumulating WITHOUT paying for a new session every idle hour. Continue any outstanding work, record anything durable, and say in one line why the undo was withheld. When the session holds nothing but wakes and checks (1)-(3) are clean, before you stop: record anything durable this session learned into the workspace (`continuations/overlord.md` if a standing fact changed, `notes/` for anything longer) and verify the file is substantive; then run `~/.overlord/tools/undo-self.py`. It is deferred — it fires after this turn ends — and it refuses if the composer holds a draft. Never send `/undo` or `/new` inline. An hour that taught nothing durable means no file edit; the undo still runs. Either way, reply one line and stop.

STANDING OPERATOR POLICY — self-improvement-leader (w1K:p1) compacts at an explicit line until the operator says otherwise. At >=500k context (50% of the 1.0M window — the operator relaxed this from 250k/25% on 2026-11-08, so it now equals the global line), run the full compaction procedure, do not defer it: have the lane write a NEW dated continuation file from scratch — `~/.overlord/continuations/self-improvement-leader-continuation-YYYY-MM-DDTHHMMZ.md` (UTC, timestamp in the filename) — NEVER an edit or append to the base `continuations/self-improvement-leader.md`, which is only a pointer naming the newest dated file. Say the exact filename in your prompt, and say the file must describe the LIVE session (its objective, decisions, open threads, no-go reminders), rather than the accumulated history of the previous base file. Verify by RECENCY not size: the mtime of the dated file is at or after the current session start AND its content names the work this session actually did — check the session .jsonl from `herdr agent list` (`agents[].agent_session.value`) to know what that work was. A substantive 90-line file from two days ago passes a size check and fails this one, which is exactly how two days of decisions were nearly compacted away. Then `/compact` at an idle boundary, then confirm it resumed (context drops, same session, settles idle). Then **REORIENT IT — a compaction is not finished at the summary.** Prompt the lane with the EXACT absolute path of the dated continuation file you just verified, say it was compacted and that the message exists for that reason, and ask it to reply confirming it has read the file and whether it resumes work or stands by. A compacted context is a summary and may not carry its own continuation path; a continuation nobody is pointed at is a file, not a state. This step was dropped once (2026-11-09, three lanes compacted and left un-pointed) because this sentence did not previously require it — do not treat "context dropped, same session" as done. A `working` lane IS prompted — the prompt queues behind the live turn (operator ruling 2026-11-09), so wait for its stop boundary only in the sense that the compaction itself needs an idle pane. MEASURE CONTEXT, NOT CACHE: the footer carries both `CH...%` (cache hit) and the trailing context `NN.N%/1.0M`. Decode by LABEL, never by position — a cache-hit figure misread as context is how a healthy lane gets compacted, or a full one gets skipped.'

if [ "$DRY_RUN" = 1 ]; then
  say "dry-run for $PANE (was $status)"
  printf '%s\n' "$msg"
  exit 0
fi

if "$HERDR" agent prompt "$PANE" "$msg" >/dev/null 2>&1; then
  say "woke $PANE (was $status)"
else
  say "send to $PANE failed (was $status)"
  exit 1
fi
