/**
 * goal-edit.test.ts — `goal_edit`, the agent-callable counterpart of `/goal edit`.
 *
 * The load-bearing properties, in the order they can hurt:
 *
 * 1. The queue survives. `/goal <objective>` wipes it behind a confirm modal; an
 *    agent tool must never be the route by which a leader destroys a backlog, so
 *    every accepted edit leaves the other goals byte-identical.
 * 2. The edited instance gets a new id. The turn that called the tool holds the
 *    old id in its own prompt; without rotation a stale `goal_complete` would
 *    complete an objective the model never saw.
 * 3. A stopped goal stays stopped. Editing a paused or blocked goal rewrites its
 *    wording without resuming it, exactly like `/goal edit`.
 * 4. Queued edits are by position and refuse to run while the queue is moving.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import goal from "../src/goal.js";
import { createMockContext, createMockPi } from "./support.js";
import { lastGoal, requireGoalTool, restoreStoredGoalForTest, type StoredGoal } from "./support/goal-fixture.js";

const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-goal-edit-settings-"));
const editionSettingsPath = join(settingsDirectory, "edition.json");
writeFileSync(editionSettingsPath, '{"toolVisibility":"always","experimental":{"goals":true}}\n');
afterAll(() => {
  // Left for the OS to reap; the directory is tiny and cleanup races vitest workers.
});

const GOAL_TOOLS = ["goal_complete", "goal_blocked", "goal_wait", "goal_edit"];

async function createHarness(overrides: Record<string, unknown> = {}, settingsPath = editionSettingsPath) {
  const mock = createMockPi({ activeTools: ["read", "bash", ...GOAL_TOOLS] });
  goal(mock.pi, { settingsPath });
  const context = createMockContext(overrides);
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  return {
    mock,
    ...context,
    command: async (args: string) => mock.commands.get("goal")?.handler(args, context.ctx),
  };
}

function storedState(mock: ReturnType<typeof createMockPi>) {
  const entry = mock.entries.filter((candidate) => candidate.customType === "goal-state").at(-1);
  const data = entry?.data as { goal?: StoredGoal | null; queue?: StoredGoal[] } | undefined;
  return { goal: data?.goal ?? null, queue: data?.queue ?? [] };
}

function executeEdit(
  mock: ReturnType<typeof createMockPi>,
  context: { ctx: unknown },
  args: Record<string, unknown>,
) {
  return requireGoalTool(mock, "goal_edit").execute("call-goal-edit", args, undefined, undefined, context.ctx);
}

test("goal_edit registers with the lifecycle tools and validates its parameters", async () => {
  const harness = await createHarness();
  assert.deepEqual(
    harness.mock.tools.map(({ name }) => name),
    GOAL_TOOLS,
  );
  const definition = harness.mock.tools.find(({ name }) => name === "goal_edit");
  const parameters = definition?.parameters as
    | {
        required?: string[];
        properties?: Record<string, { minimum?: number; minLength?: number; maxLength?: number }>;
      }
    | undefined;
  assert.deepEqual(parameters?.required, ["goal_id", "objective"]);
  assert.equal(parameters?.properties?.goal_id?.maxLength, 128);
  assert.equal(parameters?.properties?.objective?.minLength, 1);
  assert.equal(parameters?.properties?.objective?.maxLength, 4_000);
  assert.equal(parameters?.properties?.queued_index?.minimum, 1);
  assert.match(String(definition?.description), /never to narrow your own scope/i);
});

describe("editing the active goal", () => {
  test("rewrites the objective, keeps the queue, and rotates the goal id", async () => {
    const harness = await createHarness();
    await harness.command("ship the first objective");
    await harness.command("add queued follow-up");
    await harness.command("add last queued follow-up");
    const before = storedState(harness.mock);
    assert.ok(before.goal);
    const queuedIds = before.queue.map((queuedGoal) => queuedGoal.id);
    assert.deepEqual(
      before.queue.map((queuedGoal) => queuedGoal.text),
      ["queued follow-up", "last queued follow-up"],
    );

    const result = await executeEdit(harness.mock, harness, {
      goal_id: before.goal.id,
      objective: "ship the revised objective instead",
    });

    const after = storedState(harness.mock);
    assert.ok(after.goal);
    assert.equal(after.goal.text, "ship the revised objective instead");
    assert.notEqual(after.goal.id, before.goal.id, "an edited goal instance must be re-minted");
    assert.equal(after.goal.status, "active");
    assert.equal(after.goal.iteration, before.goal.iteration);
    assert.equal(after.goal.tokensUsed, before.goal.tokensUsed);
    assert.deepEqual(
      after.queue.map((queuedGoal) => queuedGoal.id),
      queuedIds,
      "the queue must survive an edit unchanged",
    );
    assert.deepEqual(
      after.queue.map((queuedGoal) => queuedGoal.text),
      ["queued follow-up", "last queued follow-up"],
    );
    assert.match(result.content?.[0]?.text ?? "", /Goal updated: ship the revised objective instead/);
    assert.match(result.content?.[0]?.text ?? "", new RegExp(`This goal_id is now ${after.goal.id}`));
    assert.match(result.content?.[0]?.text ?? "", /Queue unchanged \(2 queued\)/);
    assert.equal(result.details?.goal_id, after.goal.id);
    assert.equal(result.details?.previous_goal_id, before.goal.id);
    assert.equal(result.details?.target, "active");
    assert.match(String(harness.statuses.get("goal")), /^active /);
  });

  test("rejects a stale goal id and leaves the objective alone", async () => {
    const harness = await createHarness();
    await harness.command("objective under test");
    const before = storedState(harness.mock);
    assert.ok(before.goal);

    const result = await executeEdit(harness.mock, harness, {
      goal_id: "some-other-goal",
      objective: "objective that must not land",
    });

    assert.match(result.content?.[0]?.text ?? "", /goal_edit rejected: goal_id does not match the active goal/);
    assert.equal(lastGoal(harness.mock)?.text, "objective under test");
    assert.equal(lastGoal(harness.mock)?.id, before.goal.id);
  });

  test("rejects empty and oversized objectives before touching state", async () => {
    const harness = await createHarness();
    await harness.command("objective under test");
    const before = storedState(harness.mock);
    assert.ok(before.goal);

    const empty = await executeEdit(harness.mock, harness, { goal_id: before.goal.id, objective: "   " });
    assert.match(empty.content?.[0]?.text ?? "", /goal_edit rejected: objective is empty/);

    const oversized = await executeEdit(harness.mock, harness, {
      goal_id: before.goal.id,
      objective: "x".repeat(4_001),
    });
    assert.match(oversized.content?.[0]?.text ?? "", /objective is too long \(4001\/4000 characters\)/);
    assert.equal(lastGoal(harness.mock)?.text, "objective under test");
    assert.equal(lastGoal(harness.mock)?.id, before.goal.id);
  });

  test("keeps a paused goal paused and a budget-limited goal budget-limited", async () => {
    const paused = restoreStoredGoalForTest({
      id: "restored-paused",
      text: "paused objective",
      status: "paused",
      startedAt: 1,
      updatedAt: 2,
      iteration: 1,
      tokensUsed: 5,
      timeUsedSeconds: 4,
      baselineTokens: 0,
    });
    const pausedResult = await executeEdit(
      paused.mock,
      paused,
      { goal_id: "restored-paused", objective: "paused objective rewritten" },
    );
    assert.match(pausedResult.content?.[0]?.text ?? "", /Status: paused/);
    assert.equal(lastGoal(paused.mock)?.text, "paused objective rewritten");
    assert.equal(lastGoal(paused.mock)?.status, "paused");
    assert.notEqual(lastGoal(paused.mock)?.id, "restored-paused");

    const limited = restoreStoredGoalForTest({
      id: "restored-budget",
      text: "budgeted objective",
      status: "budget_limited",
      startedAt: 1,
      updatedAt: 2,
      iteration: 1,
      tokenBudget: 10,
      tokensUsed: 10,
      timeUsedSeconds: 4,
      baselineTokens: 0,
    });
    const limitedResult = await executeEdit(
      limited.mock,
      limited,
      { goal_id: "restored-budget", objective: "budgeted objective rewritten" },
    );
    assert.match(limitedResult.content?.[0]?.text ?? "", /Status: budget_limited/);
    assert.equal(lastGoal(limited.mock)?.text, "budgeted objective rewritten");
    assert.equal(lastGoal(limited.mock)?.status, "budget_limited");
  });

  test("refuses to edit a goal that is already queued to be skipped", async () => {
    // A busy context is the honest case: `/goal skip` dispatches immediately when
    // Pi is idle, so the pending skip only exists inside a running turn.
    const harness = await createHarness({ isIdle: () => false });
    await harness.command("objective queued to be skipped");
    await harness.command("add the next one");
    await harness.command("skip");
    const before = storedState(harness.mock);
    assert.ok(before.goal);

    const result = await executeEdit(harness.mock, harness, {
      goal_id: before.goal.id,
      objective: "must not reopen a skipped goal",
    });

    assert.match(result.content?.[0]?.text ?? "", /goal is queued to be skipped/);
    assert.equal(result.terminate, true);
    assert.equal(lastGoal(harness.mock)?.text, "objective queued to be skipped");
  });
});

describe("editing a queued goal", () => {
  test("rewrites only the addressed queue entry", async () => {
    const harness = await createHarness();
    await harness.command("active objective");
    await harness.command("add first queued");
    await harness.command("add second queued");
    const before = storedState(harness.mock);
    assert.ok(before.goal);

    const result = await executeEdit(harness.mock, harness, {
      goal_id: before.goal.id,
      objective: "second queued, rewritten",
      queued_index: 2,
    });

    const after = storedState(harness.mock);
    assert.ok(after.goal);
    assert.equal(after.goal.id, before.goal.id, "a queued edit must not re-mint the active goal");
    assert.equal(after.goal.text, "active objective");
    assert.deepEqual(
      after.queue.map((queuedGoal) => queuedGoal.text),
      ["first queued", "second queued, rewritten"],
    );
    assert.deepEqual(
      after.queue.map((queuedGoal) => queuedGoal.id),
      before.queue.map((queuedGoal) => queuedGoal.id),
      "a queued edit keeps the queue ids, so pending references stay valid",
    );
    assert.equal(result.details?.target, "queued");
    assert.equal(result.details?.queue_position, 2);
    assert.equal(result.details?.goal_id, before.queue[1]?.id);
    assert.match(result.content?.[0]?.text ?? "", /The active goal and its goal_id are unchanged/);
  });

  test("accepts the queued goal's own id as the guard", async () => {
    const harness = await createHarness();
    await harness.command("active objective");
    await harness.command("add only queued");
    const before = storedState(harness.mock);
    assert.ok(before.queue[0]);

    const accepted = await executeEdit(harness.mock, harness, {
      goal_id: before.queue[0].id,
      objective: "addressed by its own id",
      queued_index: 1,
    });
    assert.match(accepted.content?.[0]?.text ?? "", /Queued goal at position 1 updated/);
    assert.equal(storedState(harness.mock).queue[0]?.text, "addressed by its own id");

    const rejected = await executeEdit(harness.mock, harness, {
      goal_id: "neither-the-active-nor-the-queued-id",
      objective: "must not land",
      queued_index: 1,
    });
    assert.match(rejected.content?.[0]?.text ?? "", /goal_id does not match the active goal or the queued goal/);
    assert.equal(storedState(harness.mock).queue[0]?.text, "addressed by its own id");
  });

  test("rejects an out-of-range position and an empty queue", async () => {
    const harness = await createHarness();
    await harness.command("active objective");
    const active = storedState(harness.mock).goal;
    assert.ok(active);

    const emptyQueue = await executeEdit(harness.mock, harness, {
      goal_id: active.id,
      objective: "nowhere to land",
      queued_index: 1,
    });
    assert.match(emptyQueue.content?.[0]?.text ?? "", /no goal is queued at position 1 \(0 queued\)/);

    await harness.command("add one queued");
    const outOfRange = await executeEdit(harness.mock, harness, {
      goal_id: active.id,
      objective: "nowhere to land",
      queued_index: 3,
    });
    assert.match(outOfRange.content?.[0]?.text ?? "", /no goal is queued at position 3 \(1 queued\)/);
    assert.equal(storedState(harness.mock).queue[0]?.text, "one queued");
  });

  test("refuses while the queue is mid-transition", async () => {
    const harness = await createHarness();
    await harness.command("completing objective");
    await harness.command("add queued behind it");
    const before = storedState(harness.mock);
    assert.ok(before.goal);

    // A completed goal sets a pending advance; positions are about to shift, so a
    // positional edit must not be applied against the stale list.
    await requireGoalTool(harness.mock, "goal_complete").execute(
      "call-goal-complete",
      { goal_id: before.goal.id, summary: "Completed and verified with evidence." },
      undefined,
      undefined,
      harness.ctx,
    );
    const result = await executeEdit(harness.mock, harness, {
      goal_id: before.goal.id,
      objective: "must not race the advance",
      queued_index: 1,
    });
    assert.match(result.content?.[0]?.text ?? "", /the goal queue is mid-transition/);
    assert.equal(storedState(harness.mock).queue[0]?.text, "queued behind it");
  });
});
