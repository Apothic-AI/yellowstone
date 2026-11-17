// queue-ops.ts — FT-89: targeted queue operations, by goal id.
//
// The slash verbs operate on the shape a human types (`add` appends, `drop` is
// `drop-last`, `prioritize` moves the newest). A leader addresses a queue it did
// not type, so it needs operations that name the goal and state where it goes:
// remove *this* id, move *this* id to index *n*, replace *this* objective.
//
// These are pure functions over the queue. They return the new queue and the
// resulting order, or a typed refusal and the queue untouched — never a silently
// shorter list, because "the item I removed was not there" and "the item is gone"
// are different answers and a caller that cannot tell them apart will act on the
// wrong one.
//
// Nothing here persists: applying a result is the runtime's job, which is what
// keeps one write path and one persist.

import type { ActiveGoal } from "./persistence.js";

export interface QueueRefusal {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type QueueResult =
  | { ok: true; queue: ActiveGoal[]; order: string[] }
  | { ok: false; refusal: QueueRefusal; queue: ActiveGoal[] };

/** The queue's ids, in order. The order is the answer a caller must be able to trust. */
export function queueOrder(queue: readonly ActiveGoal[]): string[] {
  return queue.map((goal) => goal.id);
}

function refuse(code: string, message: string, queue: readonly ActiveGoal[], detail?: Record<string, unknown>): QueueResult {
  return { ok: false, refusal: { code, message, ...(detail ? { detail } : {}) }, queue: [...queue] };
}

function accept(queue: readonly ActiveGoal[]): QueueResult {
  const next = [...queue];
  return { ok: true, queue: next, order: queueOrder(next) };
}

/** Append to the tail. Nothing already queued moves. */
export function addToTail(queue: readonly ActiveGoal[], goal: ActiveGoal): QueueResult {
  if (queue.some((item) => item.id === goal.id)) {
    return refuse("goal_id_taken", "a goal with that id is already queued", queue, { id: goal.id });
  }
  return accept([...queue, goal]);
}

/** Remove exactly one goal by id; everything else keeps its relative order. */
export function removeById(queue: readonly ActiveGoal[], id: string): QueueResult {
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) {
    return refuse("goal_not_found", "no queued goal carries that id", queue, {
      id,
      order: queueOrder(queue),
    });
  }
  const next = queue.filter((_, position) => position !== index);
  return accept(next);
}

/** Move one goal to an explicit index. The index is validated, not clamped. */
export function moveToIndex(queue: readonly ActiveGoal[], id: string, index: number): QueueResult {
  const from = queue.findIndex((item) => item.id === id);
  if (from < 0) {
    return refuse("goal_not_found", "no queued goal carries that id", queue, {
      id,
      order: queueOrder(queue),
    });
  }
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    // Clamping would make an out-of-range request look like it worked, and the
    // caller would conclude the queue is in an order it is not in.
    return refuse("index_out_of_range", "that index is outside the queue", queue, {
      id,
      index,
      length: queue.length,
    });
  }
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(index, 0, moved as ActiveGoal);
  return accept(next);
}

/** Replace one goal's objective in place. Order is untouched. */
export function replaceObjective(queue: readonly ActiveGoal[], id: string, text: string): QueueResult {
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) {
    return refuse("goal_not_found", "no queued goal carries that id", queue, {
      id,
      order: queueOrder(queue),
    });
  }
  const next = [...queue];
  next[index] = { ...(next[index] as ActiveGoal), text, updatedAt: Date.now() };
  return accept(next);
}
