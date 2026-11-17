import assert from "node:assert/strict";
import { describe, test } from "vitest";

import type { ActiveGoal } from "../src/persistence.js";
import {
  addToTail,
  moveToIndex,
  queueOrder,
  removeById,
  replaceObjective,
} from "../src/queue-ops.js";

/**
 * FT-89, the arithmetic a leader's write performs. The invariants are the ones
 * the requirement names — order unchanged unless the operation says otherwise,
 * exactly one item touched — plus the refusals that keep "not there" distinct
 * from "removed": an unknown id must not behave like a successful removal.
 */

function goal(id: string, overrides: Partial<ActiveGoal> = {}): ActiveGoal {
  return {
    id,
    text: `objective ${id}`,
    status: "queued",
    startedAt: 0,
    updatedAt: 1,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    ...overrides,
  } as ActiveGoal;
}

const base = () => [goal("g1"), goal("g2"), goal("g3")];

describe("queue order is the answer", () => {
  test("an append leaves everything before it exactly where it was", () => {
    const result = addToTail(base(), goal("g4"));
    assert.equal(result.ok, true);
    assert.deepEqual(queueOrder(result.queue), ["g1", "g2", "g3", "g4"]);
    assert.deepEqual(result.ok && result.order, ["g1", "g2", "g3", "g4"]);
  });

  test("removing a middle goal keeps the relative order of the rest", () => {
    const result = removeById(base(), "g2");
    assert.equal(result.ok, true);
    assert.deepEqual(queueOrder(result.queue), ["g1", "g3"]);
  });

  test("a move lands on the exact index, not near it", () => {
    const result = moveToIndex(base(), "g3", 0);
    assert.equal(result.ok, true);
    assert.deepEqual(queueOrder(result.queue), ["g3", "g1", "g2"]);
  });

  test("an objective edit changes one text and moves nothing", () => {
    const result = replaceObjective(base(), "g2", "rewritten");
    assert.equal(result.ok, true);
    assert.deepEqual(queueOrder(result.queue), ["g1", "g2", "g3"]);
    assert.equal(result.queue[1]?.text, "rewritten");
    assert.equal(result.queue[0]?.text, "objective g1");
  });
});

describe("refusals keep 'not there' distinct from 'removed'", () => {
  test("an unknown id is goal_not_found and the queue is untouched", () => {
    const result = removeById(base(), "ghost");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.refusal.code, "goal_not_found");
    assert.deepEqual(queueOrder(result.queue), ["g1", "g2", "g3"], "the queue is returned unchanged");
  });

  test("an out-of-range index is refused, never clamped", () => {
    for (const index of [-1, 3, 99, 1.5]) {
      const result = moveToIndex(base(), "g1", index);
      assert.equal(result.ok, false, `index ${index} must be refused`);
      assert.equal(result.ok === false && result.refusal.code, "index_out_of_range");
      assert.deepEqual(queueOrder(result.queue), ["g1", "g2", "g3"]);
    }
  });

  test("adding a duplicate id is refused rather than shadowing the existing goal", () => {
    const result = addToTail(base(), goal("g2"));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.refusal.code, "goal_id_taken");
  });

  test("the input queue is never mutated in place", () => {
    const queue = base();
    removeById(queue, "g2");
    moveToIndex(queue, "g1", 2);
    replaceObjective(queue, "g1", "changed");
    assert.deepEqual(queueOrder(queue), ["g1", "g2", "g3"]);
    assert.equal(queue[0]?.text, "objective g1");
  });
});
