// receiver-actions.ts — FT-89: a worker's own goals, served to its leader.
//
// A leader must be able to read and edit a worker's goal queue. The edit cannot
// be a session-file write: a live worker keeps its queue in memory, so a file
// written behind it is overwritten by the worker's next persist while the
// worker keeps operating on the old order. The change therefore lands in the
// worker's own process, applied by its own runtime.
//
// The transport is pi-parameter-tools' receiver — one UNIX socket per session,
// derived from (sessionId, normalised sessionPath), with the caller owning the
// deadline. This module serves actions *through* that receiver rather than
// opening a second socket, and reaches it through a versioned `globalThis`
// registry so pi-goal needs no dependency on another repo's package.
//
// Everything here answers from the runtime. Nothing reads a session file, and
// nothing starts a turn: a read costs the worker nothing.

import type { GoalRuntime, ActiveGoal } from "./runtime.js";
import { createGoal } from "./runtime.js";
import { createLaneLookup, type LaneLookup, type LaneRecord } from "./lane-lookup.js";
import { createWriteAuthorizer } from "./write-authorization.js";
import {
  addToTail,
  moveToIndex,
  type QueueResult,
  removeById,
  replaceObjective,
} from "./queue-ops.js";

/** The shape pi-parameter-tools publishes. Structural on purpose: pi-goal must
 *  not import across a repo boundary, and a changed registry version must be a
 *  visible absence rather than a silent mismatch. */
export interface ReceiverActionRegistryLike {
  readonly version: 1;
  register(handler: {
    actions: readonly string[];
    apply(
      request: Record<string, unknown>,
      session: Record<string, unknown>,
    ): Promise<ChannelAnswer> | ChannelAnswer;
  }): () => void;
  actions(): string[];
}

export interface ChannelAnswer {
  ok: boolean;
  refusal?: { code: string; message: string; detail?: Record<string, unknown> };
  result?: Record<string, unknown>;
}

/** The registry's key, as pi-parameter-tools publishes it. */
export const RECEIVER_ACTIONS_KEY = Symbol.for("pi.receiver-actions.v1");

export const GOAL_READ_ACTION = "goal.read";

/** A goal, as a leader is allowed to see it: identity, order and status. */
export interface GoalView {
  id: string;
  objective: string;
  status: string;
  iteration?: number;
  tokensUsed?: number;
  updatedAt?: number;
}

export interface GoalQueueView {
  /** The goal the worker is operating on, or null when there is none. */
  active: GoalView | null;
  /** Every other goal, **in queue order**. The order is the answer: a leader
   *  that reads this must be able to rely on it. */
  queue: GoalView[];
  /** True when the queue is frozen because the experimental queue is disabled:
   *  a read still answers, and a write will refuse with `queue_frozen`. */
  queueFrozen: boolean;
  /** What the worker's runtime says about its own store, so an empty queue is
   *  distinguishable from an unreadable one. */
  source: "runtime";
}

function viewOf(goal: ActiveGoal): GoalView {
  return {
    id: goal.id,
    objective: goal.text,
    status: goal.status,
    iteration: goal.iteration,
    tokensUsed: goal.tokensUsed,
    updatedAt: goal.updatedAt,
  };
}

/**
 * The read answer, from the runtime.
 *
 * `runtime` is null when no goal runtime is bound yet (a session that has not
 * started): that is `no_goal_state`, not an empty queue. Reporting "no goals"
 * for "nothing to answer with" is the same error as reporting an unknown
 * percentage as zero.
 */
export function readGoals(runtime: GoalRuntime | null): ChannelAnswer {
  if (!runtime) {
    return {
      ok: false,
      refusal: {
        code: "no_goal_state",
        message: "this session has no goal runtime bound, so it has no queue to report",
      },
    };
  }
  const active = runtime.activeGoal && runtime.activeGoal.status !== "complete" ? runtime.activeGoal : null;
  const queue = [...runtime.queuedGoals];
  const view: GoalQueueView = {
    active: active ? viewOf(active) : null,
    queue: queue.map(viewOf),
    queueFrozen: runtime.queueFrozen === true,
    source: "runtime",
  };
  return { ok: true, result: view as unknown as Record<string, unknown> };
}

/** The registry, or undefined when the receiver is not loaded in this process. */
export function findReceiverActionRegistry(
  global: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): ReceiverActionRegistryLike | undefined {
  const candidate = global[RECEIVER_ACTIONS_KEY] as ReceiverActionRegistryLike | undefined;
  if (!candidate || candidate.version !== 1 || typeof candidate.register !== "function") return undefined;
  return candidate;
}

/**
 * Register the worker-side goal actions with the receiver.
 *
 * Returns a disposition rather than throwing: a process without the receiver is
 * a documented state (`receiver_actions_unavailable`), and a caller that can see
 * that state can say "unknown" instead of "no goals". Registration is returned
 * as a disposer so a reload can withdraw exactly what it added.
 */
/**
 * The write path's authorization seam.
 *
 * Default deny, deliberately: until a resolver reads the durable records that
 * say who the caller is and which worker is theirs, every write is refused with
 * caller_unresolved. There must be no window in which an unverified caller can
 * change a queue, and a resolver is passed in rather than imported so the
 * receiver never guesses at identity it has not checked.
 */
export interface WriteAuthorizer {
  authorize(request: Record<string, unknown>): { ok: true } | { ok: false; refusal: ChannelRefusal };
}

/** Where the fleet keeps its own records. Overridable so a test never reads the
 *  live fleet. */
export function defaultPilDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PI_PIL_DIR;
  if (explicit && explicit.trim()) return explicit.trim();
  const home = env.HOME || "";
  return home + "/.local/state/pil";
}

const DENY_ALL: WriteAuthorizer = {
  authorize: () => ({
    ok: false,
    refusal: {
      code: "caller_unresolved",
      message: "this receiver cannot verify who is asking, so it changes nothing",
    },
  }),
};

export interface ChannelRefusal {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export const GOAL_WRITE_ACTION = "goal.write";

/** Queue length is the version a caller reads and writes against: it is the
 *  cheapest value that changes whenever the order a caller saw can differ. */
function queueVersion(runtime: GoalRuntime): number {
  return runtime.queuedGoals.length;
}

export function applyGoalWrite(
  runtime: GoalRuntime | null,
  request: Record<string, unknown>,
  authorizer: WriteAuthorizer = DENY_ALL,
): ChannelAnswer {
  if (!runtime) {
    return { ok: false, refusal: { code: "no_goal_state", message: "this session has no goal runtime bound" } };
  }
  const decision = authorizer.authorize(request);
  if (!decision.ok) return { ok: false, refusal: decision.refusal };

  const op = typeof request.op === "string" ? request.op : "";
  const id = typeof request.id === "string" ? request.id : undefined;
  const objective = typeof request.objective === "string" ? request.objective : undefined;
  const index = typeof request.index === "number" ? request.index : undefined;
  const expected = typeof request.expectedQueueLength === "number" ? request.expectedQueueLength : undefined;

  if (expected !== undefined && expected !== queueVersion(runtime)) {
    return {
      ok: false,
      refusal: {
        code: "stale_queue",
        message: "the queue moved since it was read; re-read before writing",
        detail: { expected, current: queueVersion(runtime) },
      },
    };
  }

  let result: QueueResult;
  if (op === "add") {
    if (!objective) return { ok: false, refusal: { code: "missing_field", message: "add needs an objective" } };
    const goal = createGoal(objective, undefined, runtime.activeGoal ? runtime.activeGoal.tokensUsed : 0);
    result = addToTail(runtime.queuedGoals, goal);
  } else if (op === "edit") {
    if (!id || !objective) {
      return { ok: false, refusal: { code: "missing_field", message: "edit needs a goal id and an objective" } };
    }
    result = replaceObjective(runtime.queuedGoals, id, objective);
  } else if (op === "prioritize") {
    if (!id || index === undefined) {
      return { ok: false, refusal: { code: "missing_field", message: "prioritize needs a goal id and an index" } };
    }
    result = moveToIndex(runtime.queuedGoals, id, index);
  } else if (op === "remove") {
    if (!id) return { ok: false, refusal: { code: "missing_field", message: "remove needs a goal id" } };
    result = removeById(runtime.queuedGoals, id);
  } else {
    return {
      ok: false,
      refusal: { code: "unknown_op", message: "that is not an operation this worker performs", detail: { op } },
    };
  }

  if (!result.ok) return { ok: false, refusal: result.refusal };
  runtime.queuedGoals = result.queue;
  runtime.persistQueue();
  return {
    ok: true,
    result: { applied: op, order: result.order, queueLength: queueVersion(runtime) },
  };
}

/** The caller's claim from the request. It selects which record to check; it never
 *  decides the answer. */
function claimedCallerSessionId(request: Record<string, unknown>): string | null {
  const caller = request.caller;
  if (!caller || typeof caller !== "object") return null;
  const id = (caller as Record<string, unknown>).sessionId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Resolve the caller from the fleet's records, given the claim it carried.
 *
 * An unreadable claim, an unknown session id, or a lane with no role record all
 * resolve to null — and the rule then refuses caller_unresolved. There is no
 * branch here that guesses: a receiver that guessed would be a receiver that
 * lets a lane command a queue it was never given.
 */
export function resolveCallerIdentity(
  request: Record<string, unknown>,
  lookup: LaneLookup,
): { sessionId: string; sessionPath: null; lane: string; mode: string | null; workspaceId: string | null } | null {
  const claimed = claimedCallerSessionId(request);
  if (!claimed) return null;
  const record: LaneRecord | null = lookup.bySessionId(claimed);
  if (!record) return null;
  return {
    sessionId: record.sessionId,
    sessionPath: null,
    lane: record.lane,
    mode: lookup.modeOf(record.lane),
    workspaceId: record.workspaceId,
  };
}

/** The authorizer for one request: the receiver's own identity as the target, the
 *  claimed caller resolved through the records. */
export function authorizerForSession(
  session: Record<string, unknown>,
  lookup: LaneLookup,
): WriteAuthorizer {
  const sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
  const sessionPath = typeof session.sessionPath === "string" ? session.sessionPath : null;
  const workspaceId = typeof session.workspaceId === "string" ? session.workspaceId : null;
  const lane = (lookup.bySessionId(sessionId ?? "") || null)?.lane ?? null;
  return createWriteAuthorizer({
    target: { sessionId, sessionPath, lane, mode: lane ? lookup.modeOf(lane) : null, workspaceId },
    source: { resolveCaller: (request) => resolveCallerIdentity(request, lookup) },
  });
}

export function registerGoalReceiverActions(
  runtime: () => GoalRuntime | null,
  registry: ReceiverActionRegistryLike | undefined = findReceiverActionRegistry(),
  authorizer: WriteAuthorizer | null = null,
  lookup: LaneLookup = createLaneLookup(defaultPilDir()),
): { registered: boolean; reason?: string; dispose: () => void } {
  if (!registry) {
    return {
      registered: false,
      reason: "receiver_actions_unavailable",
      dispose: () => {},
    };
  }
  const dispose = registry.register({
    actions: [GOAL_READ_ACTION, GOAL_WRITE_ACTION],
    apply: (request, session) => {
      if (request.action === GOAL_READ_ACTION) return readGoals(runtime());
      if (request.action === GOAL_WRITE_ACTION) {
        const chosen = authorizer ?? authorizerForSession(session as unknown as Record<string, unknown>, lookup);
        return applyGoalWrite(runtime(), request, chosen);
      }
      return { ok: false, refusal: { code: "invalid_identifier", message: "not an action this handler serves" } };
    },
  });
  return { registered: true, dispose };
}
