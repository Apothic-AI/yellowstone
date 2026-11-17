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
export function registerGoalReceiverActions(
  runtime: () => GoalRuntime | null,
  registry: ReceiverActionRegistryLike | undefined = findReceiverActionRegistry(),
): { registered: boolean; reason?: string; dispose: () => void } {
  if (!registry) {
    return {
      registered: false,
      reason: "receiver_actions_unavailable",
      dispose: () => {},
    };
  }
  const dispose = registry.register({
    actions: [GOAL_READ_ACTION],
    apply: (request) => {
      if (request.action !== GOAL_READ_ACTION) {
        return { ok: false, refusal: { code: "invalid_identifier", message: "not an action this handler serves" } };
      }
      return readGoals(runtime());
    },
  });
  return { registered: true, dispose };
}
