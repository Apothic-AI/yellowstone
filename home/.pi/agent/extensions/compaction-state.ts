// compaction-state — publish a lane's compaction as a fact an observer can read.
//
// WHY THIS EXISTS (FT-57)
// -----------------------
// During a `/compact` the lane reads `idle` in herdr, so an observer cannot tell a fold
// in progress from a finished one — and `reload-fleet`'s idle barrier can satisfy itself
// mid-fold and send `/reload` into a compaction that is still executing. Measured
// 2026-11-11 06:02Z: the lane read `idle` for ~7 minutes while a fold genuinely ran; the
// 03:21Z case read `working` the whole time. Both are correct for the same reason.
//
// pi DOES emit the transition (dist/core/agent-session.js): `session_before_compact`
// fires before the summary request, `session_compact` after the entry is appended, and
// `session_compact_failed` on error, abort or extension-cancel. pi's own `isIdle()` is
// already `!runActive && !isCompacting`.
//
// The herdr-managed reporter (`herdr-agent-state.ts`) consumes NONE of it: it derives
// `working` from `agent_start` and `idle` from `agent_settled`. A fold that runs inside a
// turn therefore reads `working` (agent_start already fired), and a fold that runs after
// the turn closed has no transition to publish at all, so the lane keeps its last state —
// `idle`. That is the whole observed split, and it is not flakiness.
//
// That file is installed and overwritten by herdr, and its own header says to add hooks
// BESIDE it rather than editing it. This is that companion.

// WHAT IT PUBLISHES, AND WHY NOT `agent_status`
// --------------------------------------------
// `pane.report_agent` is a single-authority slot per terminal, keyed by (source, agent),
// and `hook_report_is_newer` drops any report whose `seq` is not greater than the last
// seen for that source. A second reporter sharing source `herdr:pi` has its own counter:
// the two would reject each other, and the managed reporter's next `idle` after a settle
// (base+1) is *older* than a wall-clock fold report, so it would be dropped and the lane
// would freeze at `working`. A distinct source is no better — `full_lifecycle_hook_authority`
// matches only the managed pair, so writing through a third source replaces the lane's
// authority and re-enables screen detection, which can flip state unpredictably.
//
// So this uses herdr's DISPLAY-ONLY metadata channel (`pane.report_metadata`): a separate
// surface with its own per-source sequence, it cannot disturb agent status, and it is
// returned in the same `herdr agent get` / `agent list` record an observer already reads:
//
//   tokens: { compacting: "manual", compacting_since: "1794923000" }
//
// herdr's state vocabulary has no `compacting` (PaneAgentState: idle/working/blocked/
// unknown), so a distinct STATE is a herdr schema change, not a pi one. A token is the
// honest surface the protocol already provides.
//
// The token is a bounded claim, never a lock:
//   * a TTL means a killed process cannot leave a lane looking busy forever;
//   * `compacting_since` lets a reader tell a healthy long fold from a wedged one — the
//     distinction FT-56 needed process-level measurements to make.
//
// WHY THIS SENDS NO `seq`
// -----------------------
// herdr keeps `metadata_report_sequences[source]` per pane and DROPS any report whose seq
// is not strictly greater, answering `{"result":{"type":"ok"}}` with exit status 0 — a
// silent no-op. Measured 2026-11-17 on a live pane: `--seq 1` applied, `--seq 2` applied,
// `--seq 1` again was ignored with no error. A wall-clock seq therefore has a permanent
// failure mode: one report carrying a larger value (a clock step, a probe, a bug) makes
// every later report from this source vanish and the lane silently stops reporting folds,
// which is the exact class of defect this extension exists to fix. `sequence_is_fresh`
// treats `None` as always fresh (metadata_tokens.rs:22), so omitting it is immune.
//
// Ordering is preserved where it matters instead: reports are applied in the order they
// are SENT, and the queue below awaits each delivery before starting the next, so a clear
// can never overtake its set. Every report is an absolute, idempotent patch (set the two
// names / clear the two names), so a duplicate is harmless and a lost one is corrected by
// the next event.
//
// The side effect that matters is that `reload-fleet` can now see the fold and WAIT for
// it, which is the behaviour the operator asked for: never interrupt a compaction, and
// never make the agent poll a pane to discover it.
//
// Fail-open by construction: every failure is swallowed, nothing here can break a turn,
// and a lane without herdr is simply not reported.

import { execFile } from "node:child_process";

const TOKEN = "compacting";
const SINCE = "compacting_since";
const SOURCE = "herdr:pi-compaction";
const HERDR = process.env.HERDR_BIN_PATH || "herdr";

// 2 hours. A fold has been measured at up to ~36 minutes (operator-assisted), so this is a
// crash backstop, not a timeout on a healthy fold. It is the maximum a stale token may
// make a lane look busy if this process is killed mid-fold.
const TTL_MS = 2 * 60 * 60 * 1000;

const CALL_TIMEOUT_MS = 2000;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Only a herdr pane can be reported about; everywhere else this is inert. */
export function enabled(): boolean {
  return env("HERDR_ENV") === "1" && !!env("HERDR_PANE_ID");
}

/** Strip anything herdr's token grammar would reject, and keep the reason a word. */
export function normalizeReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  const cleaned = text.replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return cleaned || "unknown";
}

export type Spawn = (args: string[]) => Promise<void> | void;

/** argv that marks the pane as folding. Exported so a test can pin the exact call. */
export function setArgs(pane: string, reason: string, sinceEpoch: number,
                         ttlMs: number = TTL_MS): string[] {
  return [
    "pane", "report-metadata",
    "--source", SOURCE,
    "--token", `${TOKEN}=${normalizeReason(reason)}`,
    "--token", `${SINCE}=${Math.max(0, Math.floor(sinceEpoch))}`,
    "--ttl-ms", String(ttlMs),
    pane,
  ];
}

/** argv that clears the claim. Both names are always sent: clearing is idempotent. */
export function clearArgs(pane: string): string[] {
  return [
    "pane", "report-metadata",
    "--source", SOURCE,
    "--clear-token", TOKEN,
    "--clear-token", SINCE,
    pane,
  ];
}

/**
 * Register the handlers. `spawn` is injected so the behaviour can be tested without a
 * live herdr server, and `now` so the timestamp is deterministic.
 */
export function register(pi: any, spawn: Spawn, now: () => number = Date.now): void {
  const pane = env("HERDR_PANE_ID");
  if (!pane) return;

  // One delivery at a time, and each one is AWAITED: herdr applies reports in the order it
  // receives them, so this is what stops a clear from overtaking its set on a fold that
  // fails immediately. Never awaited by a handler, so a slow herdr cannot delay a turn.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (args: string[]): void => {
    chain = chain.then(async () => {
      try {
        await spawn(args);
      } catch {
        /* reporting is best-effort */
      }
    });
  };

  const mark = (reason: unknown): void => {
    enqueue(setArgs(pane, normalizeReason(reason), Math.floor(now() / 1000)));
  };
  const clear = (): void => {
    enqueue(clearArgs(pane));
  };

  // A fold owns the pane from before the summary request until the entry lands — and on
  // every failure path too: pi emits `session_compact_failed` for an error, an abort, and
  // an extension-cancel (`result.cancel` throws inside the same try), so the clear cannot
  // be skipped by a path that only "usually" runs.
  pi.on("session_before_compact", (event: any) => {
    mark(event?.reason);
  });
  pi.on("session_compact", () => {
    clear();
  });
  pi.on("session_compact_failed", () => {
    clear();
  });

  // Stale-claim hygiene. A session start means no fold from a previous process survives
  // it (a killed mid-fold process leaves the token until its TTL), and a shutdown should
  // not leave the lane looking busy after the agent is gone.
  pi.on("session_start", () => {
    clear();
  });
  pi.on("session_shutdown", () => {
    clear();
  });
}

function defaultSpawn(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(HERDR, args, { timeout: CALL_TIMEOUT_MS, windowsHide: true }, () => {
      // The exit status is not a signal here: herdr answers a stale-seq report with
      // success and no effect, and may legitimately not be listening at all. Resolving
      // (rather than rejecting) is what keeps the queue moving.
      resolve();
    });
  });
}

export default function (pi: any): void {
  // Gated to the interactive root session, like the managed reporter: a headless child
  // session's fold must not mark the lane the operator is watching.
  if (!enabled()) return;
  register(pi, defaultSpawn);
}
