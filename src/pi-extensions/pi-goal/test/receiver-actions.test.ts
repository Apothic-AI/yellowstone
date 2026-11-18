import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  applyDueDeferrals,
  authorizerForSession,
  GOAL_READ_ACTION,
  GOAL_WRITE_ACTION,
  GOAL_WRITE_STATUS_ACTION,
  applyGoalWrite,
  findReceiverActionRegistry,
  readGoals,
  registerGoalReceiverActions,
  type ReceiverActionRegistryLike,
} from "../src/receiver-actions.js";
import { createDeferralStore } from "../src/write-deferrals.js";

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
    assert.deepEqual(
      registry.actionsSeen,
      [GOAL_READ_ACTION, GOAL_WRITE_ACTION, GOAL_WRITE_STATUS_ACTION],
      "the receiver serves both halves; a write action registered but unreachable would be a silent gap",
    );
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

describe("goal.write: default deny, proven by an unchanged queue", () => {
  function writableRuntime(queued: ReturnType<typeof goal>[]) {
    const state = { queuedGoals: queued, activeGoal: null, persisted: 0 };
    return {
      state,
      runtime: {
        get queuedGoals() {
          return state.queuedGoals;
        },
        set queuedGoals(next: unknown) {
          state.queuedGoals = next as never;
        },
        activeGoal: null,
        persistQueue() {
          state.persisted += 1;
        },
      } as never,
    };
  }

  test("an unverifiable caller is refused, and the queue is untouched afterwards", () => {
    const { state, runtime } = writableRuntime([goal({ id: "g1" }), goal({ id: "g2" })]);
    const before = JSON.stringify(state.queuedGoals);
    const answer = applyGoalWrite(runtime, { action: GOAL_WRITE_ACTION, op: "remove", id: "g1" });
    assert.equal(answer.ok, false);
    assert.equal(answer.refusal?.code, "caller_unresolved");
    assert.equal(JSON.stringify(state.queuedGoals), before, "a refused write changes nothing");
    assert.equal(state.persisted, 0, "and persists nothing");
  });

  test("with a resolver that admits, the write applies and persists exactly once", () => {
    const { state, runtime } = writableRuntime([goal({ id: "g1" }), goal({ id: "g2" })]);
    const allow = { authorize: () => ({ ok: true }) as const };
    const answer = applyGoalWrite(runtime, { action: GOAL_WRITE_ACTION, op: "remove", id: "g1" }, allow as never);
    assert.equal(answer.ok, true);
    assert.deepEqual((answer.result as { order: string[] }).order, ["g2"]);
    assert.equal(state.persisted, 1);
  });
});

describe("goal.write: the invariants a leader relies on", () => {
  function writableRuntime(queued: ReturnType<typeof goal>[]) {
    const state = { queuedGoals: queued, persisted: 0 };
    return {
      state,
      runtime: {
        get queuedGoals() {
          return state.queuedGoals;
        },
        set queuedGoals(next: unknown) {
          state.queuedGoals = next as never;
        },
        activeGoal: null,
        persistQueue() {
          state.persisted += 1;
        },
      } as never,
    };
  }
  const allow = { authorize: () => ({ ok: true }) as const };

  test("add appends to the tail and reports the order", () => {
    const { runtime } = writableRuntime([goal({ id: "g1" })]);
    const answer = applyGoalWrite(runtime, { op: "add", objective: "third thing" }, allow as never);
    assert.equal(answer.ok, true);
    const order = (answer.result as { order: string[] }).order;
    assert.equal(order.length, 2);
    assert.equal(order[0], "g1", "the existing goal keeps its position");
  });

  test("edit changes one objective and moves nothing", () => {
    const { runtime } = writableRuntime([goal({ id: "g1" }), goal({ id: "g2" })]);
    const answer = applyGoalWrite(runtime, { op: "edit", id: "g2", objective: "rewritten" }, allow as never);
    assert.equal(answer.ok, true);
    assert.deepEqual((answer.result as { order: string[] }).order, ["g1", "g2"]);
  });

  test("prioritize lands on the exact index, and an impossible index is refused", () => {
    const { runtime } = writableRuntime([goal({ id: "g1" }), goal({ id: "g2" }), goal({ id: "g3" })]);
    const ok = applyGoalWrite(runtime, { op: "prioritize", id: "g3", index: 0 }, allow as never);
    assert.equal(ok.ok, true);
    assert.deepEqual((ok.result as { order: string[] }).order, ["g3", "g1", "g2"]);
    const bad = applyGoalWrite(runtime, { op: "prioritize", id: "g3", index: 9 }, allow as never);
    assert.equal(bad.ok, false);
    assert.equal(bad.refusal?.code, "index_out_of_range");
  });

  test("an unknown goal is goal_not_found, not a shorter queue", () => {
    const { state, runtime } = writableRuntime([goal({ id: "g1" })]);
    const answer = applyGoalWrite(runtime, { op: "remove", id: "ghost" }, allow as never);
    assert.equal(answer.ok, false);
    assert.equal(answer.refusal?.code, "goal_not_found");
    assert.equal(state.queuedGoals.length, 1);
    assert.equal(state.persisted, 0);
  });

  test("a queue that moved since it was read is refused with both values", () => {
    const { runtime } = writableRuntime([goal({ id: "g1" }), goal({ id: "g2" })]);
    const answer = applyGoalWrite(runtime, { op: "remove", id: "g1", expectedQueueLength: 1 }, allow as never);
    assert.equal(answer.ok, false);
    assert.equal(answer.refusal?.code, "stale_queue");
    assert.deepEqual(answer.refusal?.detail, { expected: 1, current: 2 });
  });

  test("an unknown op and a missing field are named refusals", () => {
    const { runtime } = writableRuntime([]);
    assert.equal((applyGoalWrite(runtime, { op: "reorder-everything" }, allow as never).refusal as { code: string }).code, "unknown_op");
    assert.equal((applyGoalWrite(runtime, { op: "remove" }, allow as never).refusal as { code: string }).code, "missing_field");
    assert.equal((applyGoalWrite(null, { op: "remove", id: "g1" }, allow as never).refusal as { code: string }).code, "no_goal_state");
  });
});

describe("the production wiring: the claim selects a record, the records decide", () => {
  function lookupFixture() {
    return {
      bySessionId: (sessionId: string) => {
        if (sessionId === "s-leader") return { lane: "yellowstone-leader", sessionId, workspaceId: "w17" };
        if (sessionId === "s-far-leader") return { lane: "far-leader", sessionId, workspaceId: "w25" };
        if (sessionId === "s-worker") return { lane: "yellowstone-worker", sessionId, workspaceId: "w17" };
        return null;
      },
      modeOf: (lane: string) => {
        if (lane === "yellowstone-leader" || lane === "far-leader") return "leader";
        if (lane === "yellowstone-worker") return "worker";
        return null;
      },
    } as never;
  }
  const session = { sessionId: "s-worker", sessionPath: "/tmp/w.jsonl", workspaceId: "w17" };

  test("a leader in the same workspace is admitted, resolved from the record and not the claim", () => {
    const authorizer = authorizerForSession(session, lookupFixture());
    const decision = authorizer.authorize({ caller: { sessionId: "s-leader" } }) as { ok: boolean };
    assert.equal(decision.ok, true);
  });

  test("a claim naming no record is refused: the roll call decides, not the claim", () => {
    const authorizer = authorizerForSession(session, lookupFixture());
    const decision = authorizer.authorize({ caller: { sessionId: "s-invented" } }) as {
      ok: boolean;
      refusal?: { code: string };
    };
    assert.equal(decision.ok, false);
    assert.equal(decision.refusal?.code, "caller_unresolved");
  });

  test("a refusal at the wiring leaves the queue untouched and persists nothing", () => {
    // The property is "refused ⇒ nothing happened", which lives where the ops and
    // the persist meet — not in the rule's decision alone.
    const state = { queuedGoals: [goal({ id: "g1" })], persisted: 0 };
    const runtime = {
      get queuedGoals() {
        return state.queuedGoals;
      },
      set queuedGoals(next: unknown) {
        state.queuedGoals = next as never;
      },
      activeGoal: null,
      persistQueue() {
        state.persisted += 1;
      },
    } as never;
    const before = JSON.stringify(state.queuedGoals);
    const authorizer = authorizerForSession(session, lookupFixture());
    const answer = applyGoalWrite(
      runtime,
      { action: GOAL_WRITE_ACTION, op: "remove", id: "g1", caller: { sessionId: "s-far-leader" } },
      authorizer,
    );
    assert.equal(answer.ok, false);
    assert.equal(answer.refusal?.code, "not_my_worker");
    assert.equal(JSON.stringify(state.queuedGoals), before, "a refused write is not a partial write");
    assert.equal(state.persisted, 0, "and it reaches no persist");
  });

  test("no claim at all is refused", () => {
    const authorizer = authorizerForSession(session, lookupFixture());
    const decision = authorizer.authorize({}) as { ok: boolean; refusal?: { code: string } };
    assert.equal(decision.ok, false);
    assert.equal(decision.refusal?.code, "caller_unresolved");
  });
});

describe("deferral through the receiver (FT-89)", () => {
  function writable(ids: string[]) {
    const state = { queuedGoals: ids.map((id) => goal({ id })), persisted: 0 };
    return {
      state,
      runtime: {
        get queuedGoals() {
          return state.queuedGoals;
        },
        set queuedGoals(next: unknown) {
          state.queuedGoals = next as never;
        },
        activeGoal: null,
        persistQueue() {
          state.persisted += 1;
        },
      } as never,
    };
  }
  const allow = { authorize: () => ({ ok: true }) as const } as never;

  test("defer:true answers with a token and changes nothing yet", () => {
    const { state, runtime } = writable(["g1", "g2"]);
    const store = createDeferralStore();
    const answer = applyGoalWrite(runtime, { op: "remove", id: "g1", defer: true }, allow, store);
    assert.equal(answer.ok, true);
    const result = answer.result as { applied: boolean; deferred_until: string; token: string };
    assert.equal(result.applied, false);
    assert.equal(result.deferred_until, "agent_settled");
    assert.ok(result.token, "a deferral without a token cannot be looked up");
    assert.equal(state.queuedGoals.length, 2, "nothing is applied at defer time");
    assert.equal(state.persisted, 0);
    assert.equal(store.status(result.token)?.state, "deferred");
  });

  test("the settled boundary applies it once, and the token then reads applied", () => {
    const { state, runtime } = writable(["g1", "g2"]);
    const store = createDeferralStore();
    const answer = applyGoalWrite(runtime, { op: "remove", id: "g1", defer: true }, allow, store);
    const token = (answer.result as { token: string }).token;
    const first = applyDueDeferrals(runtime, store, Date.now());
    assert.deepEqual(first.applied, [token]);
    assert.deepEqual(state.queuedGoals.map((g: { id: string }) => g.id), ["g2"]);
    assert.equal(state.persisted, 1);
    const second = applyDueDeferrals(runtime, store, Date.now());
    assert.deepEqual(second.applied, [], "settling twice must not re-apply");
    assert.equal(state.persisted, 1);
    assert.equal(store.status(token)?.state, "applied");
  });


  test("a deferred edit replays with its objective, and the order is unchanged", () => {
    const { state, runtime } = writable(["g1", "g2"]);
    const store = createDeferralStore();
    const answer = applyGoalWrite(
      runtime,
      { op: "edit", id: "g2", objective: "written while the worker was mid-turn", defer: true },
      allow,
      store,
    );
    const token = (answer.result as { token: string }).token;
    assert.equal(state.persisted, 0, "nothing is written before the boundary");
    const outcome = applyDueDeferrals(runtime, store, Date.now());
    assert.deepEqual(outcome.applied, [token]);
    assert.equal(state.persisted, 1, "the replay persists through the one write path");
    assert.deepEqual(
      state.queuedGoals.map((g: { id: string }) => g.id),
      ["g1", "g2"],
      "a deferred edit must not reorder the queue",
    );
    assert.equal(
      (state.queuedGoals[1] as { text: string }).text,
      "written while the worker was mid-turn",
      "the objective the caller asked for is the one that lands",
    );
    assert.equal(store.status(token)?.state, "applied");
  });


  test("a deferral whose goal is gone reports refused, never applied", () => {
    const { runtime } = writable(["g1"]);
    const store = createDeferralStore();
    const answer = applyGoalWrite(runtime, { op: "remove", id: "ghost", defer: true }, allow, store);
    const token = (answer.result as { token: string }).token;
    const outcome = applyDueDeferrals(runtime, store, Date.now());
    assert.deepEqual(outcome.applied, []);
    assert.equal(outcome.refused[0]?.code, "goal_not_found");
    const record = store.status(token);
    assert.equal(record?.state, "refused", "a refused replay reported as applied would be a false success");
    assert.equal(record?.refusalCode, "goal_not_found");
  });

  test("a deferral past its lifetime is target_gone, not an eternal deferral", () => {
    const { runtime } = writable(["g1"]);
    const store = createDeferralStore(1000);
    const answer = applyGoalWrite(runtime, { op: "remove", id: "g1", defer: true }, allow, store, 5_000);
    const token = (answer.result as { token: string }).token;
    store.expire(5_999);
    assert.equal(store.status(token)?.state, "deferred", "the bound is the lifetime, not a guess");
    store.expire(6_000);
    const record = store.status(token);
    assert.equal(record?.state, "target_gone");
    assert.equal(record?.lastSeenAt, 5_000, "the outcome carries when the queue was last seen");
  });
});

