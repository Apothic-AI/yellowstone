import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  GOAL_READ_ACTION,
  findReceiverActionRegistry,
  readGoals,
  registerGoalReceiverActions,
  type ReceiverActionRegistryLike,
} from "../src/receiver-actions.js";

/**
 * FT-89, worker side: a leader reads the worker's queue from the worker's own
 * runtime. The properties worth pinning are the ones a plausible shortcut gets
 * wrong — an unbound runtime reported as an empty queue, a completed goal
 * reported as the active one, and a queue whose order is not the answer.
 */

function goal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "g-default",
    text: "do the thing",
    status: "queued",
    iteration: 1,
    tokensUsed: 0,
    updatedAt: 1,
    ...overrides,
  } as never;
}

function runtime(state: Record<string, unknown> = {}) {
  return {
    activeGoal: null,
    queuedGoals: [],
    queueFrozen: false,
    ...state,
  } as never;
}

describe("goal.read answers from the runtime", () => {
  test("returns the active goal and the queue in order", () => {
    const answer = readGoals(
      runtime({
        activeGoal: goal({ id: "g1", status: "active" }),
        queuedGoals: [goal({ id: "g2" }), goal({ id: "g3" })],
      }),
    );
    assert.equal(answer.ok, true);
    const view = answer.result as {
      active: { id: string } | null;
      queue: Array<{ id: string; objective: string }>;
      source: string;
    };
    assert.equal(view.active?.id, "g1");
    assert.deepEqual(
      view.queue.map((item) => item.id),
      ["g2", "g3"],
      "the queue order is the answer — not a sorted or reversed view",
    );
    assert.equal(view.queue[0]?.objective, "do the thing");
    assert.equal(view.source, "runtime");
  });

  test("a completed goal is not reported as active", () => {
    const answer = readGoals(runtime({ activeGoal: goal({ id: "g1", status: "complete" }) }));
    assert.equal(answer.ok, true);
    assert.equal((answer.result as { active: unknown }).active, null);
  });

  test("an unbound runtime is no_goal_state, never an empty queue", () => {
    const answer = readGoals(null);
    assert.equal(answer.ok, false);
    assert.equal(answer.refusal?.code, "no_goal_state");
    assert.equal(answer.result, undefined, "no result at all, so it cannot be read as 'no goals'");
  });

  test("a frozen queue still answers, and says so", () => {
    const answer = readGoals(runtime({ queueFrozen: true, queuedGoals: [goal({ id: "g2" })] }));
    assert.equal(answer.ok, true);
    assert.equal((answer.result as { queueFrozen: boolean }).queueFrozen, true);
  });
});

describe("registration with the receiver", () => {
  function fakeRegistry(): ReceiverActionRegistryLike & { actionsSeen: string[]; disposed: boolean } {
    const actionsSeen: string[] = [];
    const registry = {
      version: 1 as const,
      actionsSeen,
      disposed: false,
      actions: () => actionsSeen,
      register(handler: { actions: readonly string[] }) {
        actionsSeen.push(...handler.actions);
        return () => {
          registry.disposed = true;
        };
      },
    };
    return registry;
  }

  test("registers goal.read and withdraws it through the disposer", () => {
    const registry = fakeRegistry();
    const disposition = registerGoalReceiverActions(() => runtime(), registry);
    assert.equal(disposition.registered, true);
    assert.deepEqual(registry.actionsSeen, [GOAL_READ_ACTION]);
    disposition.dispose();
    assert.equal(registry.disposed, true);
  });

  test("a process without the receiver is a documented absence, not a crash", () => {
    const disposition = registerGoalReceiverActions(() => runtime(), undefined);
    assert.equal(disposition.registered, false);
    assert.equal(disposition.reason, "receiver_actions_unavailable");
    disposition.dispose();
  });

  test("the published registry is found by the versioned global key, and a wrong version is an absence", () => {
    const key = Symbol.for("pi.receiver-actions.v1");
    const store: Record<symbol, unknown> = {};
    store[key] = { version: 1, register: () => () => {}, actions: () => [] };
    assert.ok(findReceiverActionRegistry(store));
    store[key] = { version: 2, register: () => () => {}, actions: () => [] };
    assert.equal(
      findReceiverActionRegistry(store),
      undefined,
      "a registry this build cannot understand must read as absent, not as a partial match",
    );
  });
});
