// behold-state.ts — a Behold-owned pi extension.
//
// WHAT IT IS
// ----------
// A reporter for the runtime facts a pi session knows and the disk does not: the selected
// model, the thinking level, whether the agent is streaming, whether messages are queued,
// the context usage, and the lane's own identity.
//
// It writes ONE small JSON document per observation into Behold's own spool directory:
//
//   <state dir>/inbox/pane-<pane id>.tab-<tab id>.inc-<incarnation>.s<seq>.json
//
// The roster's cache ingests that spool (`behold roster` in a live run, or with
// `--cache on`) and stores the record in its SQLite cache: one current row per pane,
// owned by the *incarnation* that wrote it.
//
// THE INCARNATION — WHO WROTE THIS
// --------------------------------
// Every record names the incarnation that wrote it: the machine's boot id, this
// process's pid and its start time (from /proc), plus the sequence number this process
// has written for this lane. That is what makes a restart decidable:
//
//   * the same incarnation may only move forward (its sequence number must grow);
//   * an incarnation that started LATER takes the pane over;
//   * an incarnation that started EARLIER may not take it back — that is the late
//     reporter, and the cache refuses it;
//   * a record from another boot is ordered by the boot's epoch, and two boot epochs
//     too close to order are refused rather than guessed at.
//
// The sequence number is per incarnation and counts up from 1, so it is NOT derived from
// the wall clock: a backwards clock step cannot freeze a lane's observation. The record
// also carries the reporter's monotone estimate of the moment (`mono_epoch`), so the
// reader can tell that the clock moved and dispute the observation's age instead of
// calling it fresh.
//
// The incarnation says WHO wrote a record. It is not a liveness proof: nothing here
// shows that the process is still running.
//
// DEFAULTS — no setup is required
// -------------------------------
// The state directory is resolved, in order:
//
//   1. $BEHOLD_STATE_DIR
//   2. the directory of $BEHOLD_CACHE_DB
//   3. ~/.local/state/behold
//
// So the reporter and the reader agree by default: both use ~/.local/state/behold, and
// both follow BEHOLD_CACHE_DB when it is set. Set BEHOLD_STATE_ENABLED=0 to turn the
// reporter off entirely.
//
// ADMISSION — WHY IT MAY NOT WRITE
// --------------------------------
// The roster publishes an **admission map** beside the cache (`denied-lanes.json`): the
// deny ids (held workspaces, reserved panes, reserved tabs) AND the topology's
// pane -> tab / pane -> workspace mapping. The reporter consults it before every write:
//
//   * a refused lane is not written at all;
//   * a MISSING, unreadable, malformed, wrong-version or STALE map means the reporter
//     cannot establish admission, so it writes NOTHING. "I could not check" is not
//     "admitted".
//
// The map is not the boundary — the cache's ingester refuses a refused lane's record
// before opening it — but a reporter that never writes for a refused lane is one
// problem fewer.
//
// THE SPOOL TRANSPORT IS A FILE, NOT A SOCKET
// --------------------------------------------
// The reporter writes one small JSON file per observation (write to a temp file, then
// rename) and the reader ingests whatever is there when it runs. The consequences are
// honest ones: a record is at most one rename old, the reader sees the last complete
// record rather than a stream, and two reporters for the same pane both leave their
// record instead of overwriting each other. A socket or a daemon would fix the latency
// and cost a background process on every lane; a file does not.
//
// WHY THE NAME CARRIES THE INCARNATION
// ------------------------------------
// An earlier version kept ONE file per lane and replaced it. That is a read-modify-write
// with no compare-and-swap: two writers could interleave, and the older one could win
// the file before the first ingest -- and the reader would then never see the newer
// observation at all.
//
// Now every write gets **its own name**, and a name is never reused: the incarnation
// and the sequence number are in the name. Two writers therefore never touch the same
// pathname, there is no window to interleave in, and the reader may unlink a file it
// has read without the risk of destroying a newer record for the same lane. The reader
// owns the ordering: it groups the records of a pane by incarnation and keeps the one
// that is actually the newest.
//
// THE REPORTER'S PLACEMENT IS THE MAP'S, AND THE MAP IS AS OF THE LAST CAPTURE
// ---------------------------------------------------------------------------------
// The reporter's tab id is **inherited**: it is the tab the lane was launched with, and
// it does not follow a pane that moves. The admission map is the topology *as of the
// last capture*, and it says where the pane is now -- as far as that capture knows. The
// record is written under the **map's** tab, because the inherited tab does not follow
// a pane that moves and a pane that moved to another admitted tab would otherwise fall
// silent forever.
//
// That is a **bounded staleness, not a guarantee**: a pane that moves into a reserved
// tab *after* the capture is not visible to the map until the next roster run, so a
// record for it can be written in that window. The roster's reader refuses a moved or
// reserved lane's record **before** it opens the file, on every run -- so the record is
// never stored and never surfaced, but the reporter is not silent across the move
// itself. The window is bounded by the map's age and the roster's cadence. Closing it
// entirely would need a live topology the reporter cannot have without a second writer
// or a change to herdr.
//
// THE LIFECYCLE: WHEN IT WRITES, AND WHAT IT SAMPLES
// ---------------------------------------------------
// The reporter writes on a pi event, and on a **bounded lifecycle timer** (60 s by
// default, `BEHOLD_STATE_INTERVAL_MS`). The timer is what makes two cases work:
//
//   * an **idle** lane has no event, so without the timer it would never report at
//     all -- and the roster would have nothing to receive for it;
//   * the admission map **expires** (300 s). A reporter that is only woken by an event
//     never notices the renewal, so it stays silent until the next event.
//
// WHAT A SAMPLE IS
//
// Pi's own extension contract says it: "Context values are resolved at call time, so
// changes via bindCore/bindUI are reflected". The context object is a live view, so a
// tick samples the session **again**:
//
//   | field | what it is at the sample |
//   |---|---|
//   | `model_id`, `model_provider` | the model in force now |
//   | `thinking_level` | the thinking level now |
//   | `idle`, `pending_messages` | the streaming and queue state now |
//   | `context_tokens`, `context_window`, `context_percent` | the usage now |
//   | `system_prompt_length`, `system_prompt_sha256` | the effective prompt now |
//   | `session_file`, `leaf_entry_id`, `session_id` | the session's own identity (constant for the session) |
//   | `cwd` | the lane's working directory (constant) |
//   | `herdr_pane_id`, `herdr_workspace_id`, `herdr_tab_id` | the handles the lane was **launched** with: constants, and they do not follow a pane that moves |
//
// So the record is stamped with the **sampling instant**: `observed_at` (ISO) and
// `observed_at_epoch` come from the same value and cannot disagree, and the reader
// computes the freshness from it. The one thing the record does not claim is a
// **placement**: the file is named under the tab the *map* gives, while the state's
// `herdr_tab_id` is the inherited one.
//
// The first roster after an install publishes the map, and the lanes publish on their
// next tick: the observation reaches the **next** roster run, not the one that
// published the map.
//
// The timer is bounded (one interval, no retry storm), it never blocks (one small file
// read and one small file write), it is `unref`ed so it cannot keep the process alive,
// and it is cleared when the session shuts down.
//
// WHAT IT IS NOT
// --------------
// * It does not read a prompt, a message, a tool argument, a credential, a skill body, a
//   room body or a bead note. The state it writes is an allowlist of scalar fields, and
//   the cache drops anything else a second time before it reaches the database.
// * It does not store environment values. The herdr *socket path* and the env flag are
//   environment values and are not written; the pane, workspace and tab ids are identity
//   handles (the roster already publishes them) and are, because the join needs them.
//   The boot id is the machine's boot identity, not an environment value: it is what
//   makes an incarnation orderable across reboots.
// * It does not open a session, does not parse the session JSONL, and does not re-open a
//   session over `pi --mode rpc --session`. It reads the ExtensionContext it is handed,
//   in memory.
// * It does not talk to herdr. It reads the herdr environment metadata the lane was
//   launched with and nothing else.
//
// The extension is best-effort by design, like every other reporter in this fleet: a cache
// write must never break a turn, so every failure is swallowed.
//
// NOT INSTALLED. This file ships in the Behold repository. Installing it fleet-wide is a
// separate, reviewed step (see pi-extension/README.md).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The record format version. The cache refuses a record with any other version.
export const STATE_RECORD_VERSION = 2;

// The spool directory name, beside the cache database.
export const INBOX_DIRNAME = "inbox";

// The file the roster publishes with its admission map, beside the cache database.
export const DENY_FILE_NAME = "denied-lanes.json";

// The admission map version this reporter understands. A map with any other version is
// refused: the reporter writes nothing.
export const ADMISSION_VERSION = 2;

// How long a published admission map stays usable. A map older than this is stale: the
// deny list may have changed since it was written, and admitting on a stale map is
// admitting on a guess.
export const ADMISSION_TTL_MS = 300_000;

// How far a map's capture time may lie in the future before it is refused. A map dated
// in the future is either a clock that moved or a hand-written one; neither may be
// trusted to be fresh, and a future date must not be clamped to "age 0".
export const FUTURE_TOLERANCE_MS = 5_000;

// Two boot epochs closer than this cannot be ordered against each other, so a record
// from a different boot is refused rather than believed.
export const BOOT_EPOCH_AMBIGUITY_S = 60;

/** A safe handle: the shapes the roster's ids take. No path separators, no control
 * characters, and bounded in length -- a handle that can name a file is a handle that
 * can be made to name one. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

// The only fields that may leave this process. The cache applies the same list a second
// time, so a mistake here is caught there too.
export const ALLOWED_STATE_KEYS = [
  "model_id",
  "model_provider",
  "thinking_level",
  "idle",
  "pending_messages",
  "context_tokens",
  "context_window",
  "context_percent",
  "session_file",
  "leaf_entry_id",
  "cwd",
  "herdr_pane_id",
  "herdr_workspace_id",
  "herdr_tab_id",
  "system_prompt_length",
  "system_prompt_sha256",
] as const;

/**
 * The part of pi's ExtensionContext this extension reads.
 *
 * The types are declared locally rather than imported: an extension that imports pi's
 * type package can fail to LOAD when the type resolution differs, and a cache reporter is
 * never worth a broken session. Every access is optional-chained and guarded.
 *
 * What pi does NOT expose, and this reporter therefore cannot observe (the roster reports
 * these as unavailable, never as a value):
 *   - herdr's agent status (working / blocked / done): pi exposes only isIdle()
 *   - time to first token
 *   - rooms presence, beads counts
 */
type BeholdContext = {
  mode?: string;
  cwd?: string;
  model?: { id?: string; provider?: string };
  thinkingLevel?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  getContextUsage?: () =>
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | undefined;
  getSystemPrompt?: () => string;
};

export type AdmissionMap = {
  version: number;
  captured_at_epoch: number;
  pane_tab: Record<string, string>;
  pane_workspace: Record<string, string>;
  denied_workspaces: string[];
  reserved_panes: string[];
  reserved_tabs: string[];
};

export type Incarnation = {
  /** boot id, pid and start ticks: unique per process instance, stable across writes. */
  id: string;
  bootId: string;
  startTicks: number;
  /** The wall clock at boot, captured once. Orders incarnations across reboots. */
  bootEpoch: number;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Is the reporter enabled? On by default; BEHOLD_STATE_ENABLED=0 turns it off. */
export function enabled(): boolean {
  return env("BEHOLD_STATE_ENABLED") !== "0";
}

//: How often the reporter re-checks the admission map and re-publishes its last
//: observation. It must be shorter than the admission map's TTL (300 s), so a renewed
//: map is picked up within one interval -- and so that an idle lane still reports.
export const DEFAULT_INTERVAL_MS = 60_000;

//: The floor. A misconfigured interval must not turn the reporter into a busy loop.
export const MIN_INTERVAL_MS = 1_000;

/** The lifecycle interval in milliseconds. */
export function intervalMs(): number {
  const raw = Number.parseInt(env("BEHOLD_STATE_INTERVAL_MS") || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, raw);
}

/**
 * The spool root. No setup is required: BEHOLD_STATE_DIR wins, then the directory of
 * BEHOLD_CACHE_DB, then ~/.local/state/behold — the same default the reader uses.
 */
export function stateDir(): string {
  const explicit = env("BEHOLD_STATE_DIR");
  if (explicit) return explicit;
  const db = env("BEHOLD_CACHE_DB");
  if (db) return path.dirname(path.resolve(db));
  return path.join(os.homedir(), ".local", "state", "behold");
}

/**
 * The boot epoch, captured once.
 *
 * It is the wall clock minus the system uptime, so it does not move when the clock does.
 * A later clock step therefore cannot reorder this process's records: the ordering uses
 * the boot id and the process start ticks, and the boot epoch only decides which of two
 * *boots* came first.
 */
const BOOT_EPOCH = Date.now() / 1000 - os.uptime();

/** The machine's boot id, or "unknown-boot" when /proc is not readable. */
export function bootId(): string {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    return value.length > 0 ? value : "unknown-boot";
  } catch {
    return "unknown-boot";
  }
}

/**
 * This process's start time, in clock ticks since boot.
 *
 * The unit does not matter: the value is only ever compared with another value from the
 * same clock, to say which process started first. It is immune to wall-clock steps,
 * which is exactly what the ownership rule needs.
 */
export function startTicks(): number {
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf-8");
    // The command name is parenthesised and may contain spaces: parse after the last ')'.
    const close = stat.lastIndexOf(")");
    if (close < 0) return 0;
    const fields = stat.slice(close + 2).split(" ");
    // fields[0] is field 3 (state); starttime is field 22, so index 19 here.
    const value = Number.parseInt(fields[19], 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** This process's incarnation: who it is, for the ownership rule. */
export function incarnationOf(): Incarnation {
  const boot = bootId();
  const ticks = startTicks();
  return {
    id: `${boot}:${process.pid}:${ticks}`,
    bootId: boot,
    startTicks: ticks,
    bootEpoch: BOOT_EPOCH,
  };
}

/**
 * The reporter's monotone estimate of the current moment.
 *
 * It advances with the system uptime, so a backwards clock step does not make the
 * reporter's own timestamps go backwards. The reader compares it with the wall clock and
 * disputes the observation's age when the two disagree.
 */
export function monoEpoch(): number {
  return BOOT_EPOCH + os.uptime();
}

/** The filesystem-safe spelling of a handle. Must match `behold.cache._safe_component`. */
function safeComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The spool file name for a pane. Must match `behold.cache.spool_file_name`. */
export function spoolFileName(
  paneId: string,
  tabId?: string,
  incarnation?: string,
  seq?: number,
): string {
  let name = `pane-${safeComponent(paneId)}`;
  if (tabId) name += `.tab-${safeComponent(tabId)}`;
  if (incarnation && typeof seq === "number" && Number.isFinite(seq)) {
    // The incarnation and the sequence number are IN THE NAME, not only in the record.
    // The name is what the reader applies its admission map to before it opens
    // anything, and it is what makes the file unique: one file per write, and a name
    // is never reused, so a reader may unlink a file it has read without the risk of
    // destroying a newer record for the same lane.
    name += `.inc-${safeComponent(incarnation)}.s${seq}`;
  }
  return `${name}.json`;
}

/**
 * The most records this reporter may leave in the spool for one lane.
 *
 * One file per write means the spool grows with the lane's event rate until the roster
 * ingests it. A lane that writes faster than the roster runs must not fill the disk,
 * so the bound is a **refusal**: the last observation stays where it is, and the lane
 * goes quiet until the reader has cleared the backlog.
 */
export const SPOOL_FILE_CAP = 256;

/** Keep only the allowlisted keys, with the right primitive type. */
export function sanitizeState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_STATE_KEYS) {
    if (!(key in state)) continue;
    const value = state[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** The lane's session id, when pi exposes one. */
export function sessionIdOf(ctx: BeholdContext): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the admission map the roster publishes.
 *
 * Every failure is a refusal: a missing, unreadable, malformed, wrong-version or stale
 * map means the reporter cannot establish admission, and the caller writes nothing.
 */
export function readAdmission(
  dir: string,
  nowMs: number = Date.now(),
): { map?: AdmissionMap; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, DENY_FILE_NAME), "utf-8");
  } catch {
    return {
      reason:
        "no admission map: the reporter cannot establish admission, so it writes nothing",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: "the admission map is not valid JSON: the reporter writes nothing" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "the admission map is not an object: the reporter writes nothing" };
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.version !== ADMISSION_VERSION) {
    return {
      reason: `unsupported admission map version ${String(payload.version)}: the reporter writes nothing`,
    };
  }
  const captured = Number(payload.captured_at_epoch);
  if (!Number.isFinite(captured)) {
    return {
      reason: "the admission map's capture time is not a finite number: the reporter writes nothing",
    };
  }
  if (captured * 1000 > nowMs + FUTURE_TOLERANCE_MS) {
    return {
      reason: "the admission map's capture time is in the future: the reporter writes nothing",
    };
  }
  // A deny list that is missing, not a list, or holds something that is not a safe handle
  // is a BROKEN map -- not an empty deny list. The reporter writes nothing.
  const ids = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    if (!value.every((item) => isSafeId(item))) return null;
    return value as string[];
  };
  const deniedWorkspaces = ids(payload.denied_workspaces);
  const reservedPanes = ids(payload.reserved_panes);
  const reservedTabs = ids(payload.reserved_tabs);
  if (!deniedWorkspaces || !reservedPanes || !reservedTabs) {
    return {
      reason:
        "the admission map's deny lists are missing or malformed: the reporter writes nothing",
    };
  }
  const mapping = (value: unknown): Record<string, string> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!isSafeId(key) || !isSafeId(item)) return null;
      out[key] = item;
    }
    return out;
  };
  const paneTab = mapping(payload.pane_tab);
  const paneWorkspace = mapping(payload.pane_workspace);
  if (!paneTab || !paneWorkspace) {
    return {
      reason:
        "the admission map's pane mappings are missing or malformed: the reporter writes nothing",
    };
  }
  // The two mappings must cover exactly the same panes: a partial mapping would let a
  // pane the roster cannot place be admitted on the strength of the half it knows.
  const tabKeys = Object.keys(paneTab).sort();
  const workspaceKeys = Object.keys(paneWorkspace).sort();
  if (tabKeys.length !== workspaceKeys.length || tabKeys.some((key, i) => key !== workspaceKeys[i])) {
    return {
      reason: "the admission map's pane mappings disagree: the reporter writes nothing",
    };
  }
  const age = nowMs / 1000 - captured;
  if (age > ADMISSION_TTL_MS / 1000) {
    return {
      reason: `the admission map is stale (${Math.round(age)}s old): the reporter writes nothing`,
    };
  }
  return {
    map: {
      version: ADMISSION_VERSION,
      captured_at_epoch: captured,
      pane_tab: paneTab,
      pane_workspace: paneWorkspace,
      denied_workspaces: deniedWorkspaces,
      reserved_panes: reservedPanes,
      reserved_tabs: reservedTabs,
    },
    reason: "admitted",
  };
}

/**
 * May the reporter write for this pane, and under which tab?
 *
 * The reporter's own tab id is **inherited**: it is the tab the lane was launched with,
 * and it does not follow a pane that moves. The map says where the pane is *now*, so the
 * map is the authority for the placement, and the record is written under **the map's**
 * tab -- otherwise a pane that moved to another admitted tab would never be ingested
 * again (the file's name and the map would disagree forever).
 *
 * The refusals are about the **reserved** set, and they are checked twice: once against
 * the map's placement (where the pane is now) and once against the reporter's inherited
 * handles (where the lane was launched). A lane launched in a reserved tab stays silent
 * even if the map has moved it out.
 *
 * The order matches the roster's: the holds that do not need the placement come
 * first. The map publishes the placement of the *admitted* lanes only, so a held lane
 * would otherwise be refused as "unknown" instead of as held.
 */
export function admissionAllows(
  map: AdmissionMap,
  paneId: string | undefined,
  inheritedTab: string | undefined,
  inheritedWorkspace: string | undefined,
): { allowed: boolean; reason: string; tab?: string } {
  if (!paneId) return { allowed: false, reason: "no_pane" };
  if (map.reserved_panes.includes(paneId)) {
    return { allowed: false, reason: `reserved_pane:${paneId}` };
  }
  if (inheritedTab && map.reserved_tabs.includes(inheritedTab)) {
    return { allowed: false, reason: `reserved_tab:${inheritedTab}` };
  }
  if (inheritedWorkspace && map.denied_workspaces.includes(inheritedWorkspace)) {
    return { allowed: false, reason: `held_workspace:${inheritedWorkspace}` };
  }
  const knownTab = map.pane_tab[paneId];
  const knownWorkspace = map.pane_workspace[paneId];
  if (!knownTab || !knownWorkspace) {
    return { allowed: false, reason: `unknown_pane:${paneId}` };
  }
  if (map.reserved_tabs.includes(knownTab)) {
    return { allowed: false, reason: `reserved_tab:${knownTab}` };
  }
  if (map.denied_workspaces.includes(knownWorkspace)) {
    return { allowed: false, reason: `held_workspace:${knownWorkspace}` };
  }
  return { allowed: true, reason: "admitted", tab: knownTab };
}

/**
 * Collect the runtime state, and nothing else.
 *
 * The system prompt is reduced to its LENGTH and a truncated digest before it leaves this
 * function: the prompt text itself never becomes state, and a digest of it cannot be read
 * back into a prompt.
 */
export function collectState(ctx: BeholdContext): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  const model = ctx.model;
  if (model && typeof model.id === "string") state.model_id = model.id;
  if (model && typeof model.provider === "string") state.model_provider = model.provider;
  if (typeof ctx.thinkingLevel === "string") state.thinking_level = ctx.thinkingLevel;

  try {
    if (typeof ctx.isIdle === "function") state.idle = ctx.isIdle() === true;
  } catch {
    /* optional */
  }
  try {
    if (typeof ctx.hasPendingMessages === "function") {
      state.pending_messages = ctx.hasPendingMessages() === true;
    }
  } catch {
    /* optional */
  }

  try {
    const usage = ctx.getContextUsage?.();
    if (usage) {
      if (typeof usage.tokens === "number") state.context_tokens = usage.tokens;
      if (typeof usage.contextWindow === "number") state.context_window = usage.contextWindow;
      if (typeof usage.percent === "number") state.context_percent = usage.percent;
    }
  } catch {
    /* optional */
  }

  try {
    const file = ctx.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file.length > 0) state.session_file = file;
    const leaf = ctx.sessionManager?.getLeafId?.();
    if (typeof leaf === "string" && leaf.length > 0) state.leaf_entry_id = leaf;
  } catch {
    /* optional */
  }

  if (typeof ctx.cwd === "string") state.cwd = ctx.cwd;

  // Identity handles only. The herdr socket path and the env flag are environment values
  // and are deliberately NOT read here.
  const paneId = env("HERDR_PANE_ID");
  if (paneId) state.herdr_pane_id = paneId;
  const workspaceId = env("HERDR_WORKSPACE_ID");
  if (workspaceId) state.herdr_workspace_id = workspaceId;
  const tabId = env("HERDR_TAB_ID");
  if (tabId) state.herdr_tab_id = tabId;

  try {
    const prompt = ctx.getSystemPrompt?.();
    if (typeof prompt === "string") {
      state.system_prompt_length = prompt.length;
      state.system_prompt_sha256 = createHash("sha256")
        .update(prompt, "utf8")
        .digest("hex")
        .slice(0, 16);
    }
  } catch {
    /* optional */
  }

  return sanitizeState(state);
}

/**
 * The sequence number this incarnation has already used for this lane.
 *
 * It is the highest sequence number in the spool for this lane and this incarnation,
 * so a `/reload` inside the same process -- which restarts this module but not the
 * process -- continues the sequence instead of going back to 1. The cache refuses a
 * sequence number that does not move forward, so a restarted counter would freeze the
 * lane's observation.
 *
 * The sequence is per **(lane, incarnation)**, not per tab: a pane that moved is still
 * the same lane, and the record is written under the tab the *map* gives. Matching the
 * tab here would miss the record written before a move, and the counter would restart
 * at 1 -- which collides with the record that is already there and freezes the
 * observation.
 */
export function lastSeq(
  dir: string,
  paneId: string,
  incarnation: string,
): number {
  const inbox = path.join(dir, INBOX_DIRNAME);
  let names: string[] = [];
  try {
    names = fs.readdirSync(inbox);
  } catch {
    return 0;
  }
  const prefix = `pane-${safeComponent(paneId)}.tab-`;
  const marker = `.inc-${safeComponent(incarnation)}.s`;
  let best = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const index = name.indexOf(marker);
    if (index < 0) continue;
    const seq = Number.parseInt(
      name.slice(index + marker.length, name.length - ".json".length), 10);
    if (Number.isFinite(seq) && seq > best) best = seq;
  }
  return best;
}

/** How many records this incarnation has left in the spool for this lane. */
export function spoolFileCount(
  dir: string,
  paneId: string,
  incarnation: string,
): number {
  const inbox = path.join(dir, INBOX_DIRNAME);
  let names: string[] = [];
  try {
    names = fs.readdirSync(inbox);
  } catch {
    return 0;
  }
  const prefix = `pane-${safeComponent(paneId)}.tab-`;
  const marker = `.inc-${safeComponent(incarnation)}.s`;
  let count = 0;
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".json") && name.includes(marker)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Write the spool record atomically: a temp file and a rename.
 *
 * The file name carries the incarnation and the sequence number, so **every write gets
 * its own name and a name is never reused**. That is what makes the writer safe: there
 * is no read-modify-write, so there is no window in which two writers interleave and
 * the older one wins. A reader may unlink a file it has read without the risk of
 * destroying a newer record for the same lane, because no writer will ever write that
 * name again.
 *
 * `sampledAt` is the instant the observation was **sampled**, in epoch seconds. Both
 * timestamps come from it, so the ISO string and the epoch can never disagree: the
 * reader computes the freshness from the epoch, and the two must mean the same moment.
 */
export function writeSpool(
  dir: string,
  paneId: string,
  tabId: string | undefined,
  sessionId: string,
  state: Record<string, unknown>,
  seq: number,
  sampledAt: number,
  incarnation: Incarnation = incarnationOf(),
): string {
  const inbox = path.join(dir, INBOX_DIRNAME);
  fs.mkdirSync(inbox, { recursive: true });
  // The growth bound. One file per write means the spool grows with the lane's event
  // rate until the roster ingests it; the cap is a refusal, not a deletion: the last
  // observation stays where it is and the lane goes quiet.
  if (spoolFileCount(dir, paneId, incarnation.id) >= SPOOL_FILE_CAP) {
    return "";
  }
  const record = {
    behold_state: STATE_RECORD_VERSION,
    pane_id: paneId,
    tab_id: tabId,
    session_id: sessionId,
    incarnation: incarnation.id,
    boot_id: incarnation.bootId,
    incarnation_start_ticks: incarnation.startTicks,
    incarnation_boot_epoch: incarnation.bootEpoch,
    seq,
    observed_at: new Date(sampledAt * 1000).toISOString(),
    observed_at_epoch: sampledAt,
    mono_epoch: monoEpoch(),
    state: sanitizeState(state),
    writer: "pi-extension",
  };
  const target = path.join(inbox, spoolFileName(paneId, tabId, incarnation.id, seq));
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}

export default function (pi: any) {
  // Off only when BEHOLD_STATE_ENABLED=0. There is no mandatory setup.
  if (!enabled()) return;

  const dir = stateDir();
  const incarnation = incarnationOf();

  // A per-incarnation sequence number, counted up from 1. It is NOT derived from the
  // wall clock, so a backwards clock step cannot freeze the lane's observation. The
  // seed is the lane's own highest sequence number, whichever tab it was written
  // under: the sequence belongs to the lane, not to the tab it happens to sit in now.
  let seq = 0;
  let seqSeeded = false;
  const nextSeq = (paneId: string): number => {
    if (!seqSeeded) {
      seq = lastSeq(dir, paneId, incarnation.id);
      seqSeeded = true;
    }
    seq += 1;
    return seq;
  };

  // The last context, kept so the timer can sample again. Pi resolves the context's
  // values **at call time** ("Context values are resolved at call time, so changes via
  // bindCore/bindUI are reflected" -- pi's own extension contract), so a tick re-reads
  // the live values: the model, the thinking level, the idle flag, the queued messages,
  // the context usage and the system prompt are the ones of *now*. The record is
  // stamped with the sampling instant, so the observation is current and says so.
  //
  // The identity handles in the environment (the pane, workspace and tab the lane was
  // launched with) are the exception: they are launch-time constants and do not follow
  // a pane that moves. The file is named under the tab the MAP gives; the state's
  // `herdr_tab_id` is the inherited one.
  let lastContext: BeholdContext | undefined;

  const publish = (ctx: BeholdContext) => {
    lastContext = ctx;
    try {
      const paneId = env("HERDR_PANE_ID");
      if (!paneId) return;
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const workspaceId = env("HERDR_WORKSPACE_ID");
      const tabId = env("HERDR_TAB_ID");
      // Fail closed: without a usable admission map the reporter writes nothing.
      const admission = readAdmission(dir);
      if (!admission.map) return;
      const decision = admissionAllows(admission.map, paneId, tabId, workspaceId);
      if (!decision.allowed || !decision.tab) return;
      // The state is sampled NOW, and the record is stamped with the sampling instant:
      // the ISO string and the epoch come from the same value, so they cannot disagree.
      const sampledAt = Date.now() / 1000;
      // The record is written under the tab the MAP gives for this pane: the map is the
      // current topology, and the inherited tab does not follow a pane that moves.
      writeSpool(
        dir,
        paneId,
        decision.tab,
        sessionId,
        collectState(ctx),
        nextSeq(paneId),
        sampledAt,
        incarnation,
      );
    } catch {
      // A cache write must never break a turn.
    }
  };

  const onState = (_event: unknown, ctx: BeholdContext) => {
    publish(ctx);
  };

  // THE LIFECYCLE TIMER
  // -------------------
  // Without it the reporter only ever writes on a pi event, and that has two failures
  // the review named:
  //
  //   * an **idle** lane produces no event, so it never reports at all -- and after
  //     the first roster publishes the map, the roster has nothing to receive;
  //   * the admission map **expires** (300 s), and a reporter that is not woken by an
  //     event never notices the renewal, so it stays silent until the next event.
  //
  // The timer re-reads the map on every tick -- the publish path does that anyway --
  // and samples the context again, so the record it writes is current. It is bounded
  // (one interval, no retry storm), it never blocks (one small file read and one small
  // file write), and it is cleaned up when the session shuts down. The interval is
  // shorter than the map's TTL, so a renewed map is picked up within one interval.
  const timer = setInterval(() => {
    if (!lastContext) return;
    publish(lastContext);
  }, intervalMs());
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);

  pi.on("session_start", onState);
  pi.on("agent_start", onState);
  pi.on("agent_end", onState);
  pi.on("turn_end", onState);
  pi.on("model_select", onState);
  pi.on("thinking_level_select", onState);
  pi.on("session_shutdown", onState);
  pi.on("session_shutdown", () => {
    clearInterval(timer);
  });
}
