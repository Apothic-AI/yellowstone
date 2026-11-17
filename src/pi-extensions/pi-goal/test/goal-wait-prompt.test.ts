import assert from "node:assert/strict";
import { test } from "vitest";
import { buildContinuePrompt, buildGoalSystemPrompt } from "../src/prompts.js";
import { createMockPi } from "./support.js";
import { registerGoal, requireGoalTool } from "./support/goal-fixture.js";

/**
 * FT-61: the goal nudge/reminder prompt must tell a lane how to choose
 * `resume_after_ms`. Recorded lane behaviour before this test: 50 of 61
 * `goal_wait` calls carried exactly 180000ms — a repeated arbitrary number —
 * because the nudge explained goal_complete and goal_blocked at length and
 * said nothing about goal_wait, while the tool's own guidance called the
 * deadline "a safety net" that may be omitted.
 *
 * These assertions pin the delivered wording, not an implementation detail:
 * `runtime.requestContinuation()` sends `buildContinuePrompt(...)` as a user
 * message, and the system prompt a goal lane sees is `buildGoalSystemPrompt`.
 */

const goal = {
  id: "goal-ft61",
  text: "Prove the goal_wait instruction reaches the lane.",
  status: "active" as const,
  iteration: 3,
  tokensUsed: 0,
  startedAt: 0,
  updatedAt: 0,
  timeUsedSeconds: 0,
  baselineTokens: 0,
};

const ESTIMATE_RULE = /estimate how long the remaining goal work or the awaited event will take/i;

test("the continuation nudge tells the lane to derive resume_after_ms from an estimate", () => {
  const nudge = buildContinuePrompt(goal, "ft61-marker");
  assert.match(nudge, ESTIMATE_RULE);
  assert.match(nudge, /never an arbitrary round number/i);
});

test("the goal system prompt carries the same resume_after_ms rule", () => {
  assert.match(buildGoalSystemPrompt(goal), ESTIMATE_RULE);
});

test("the goal_wait tool description and guidelines carry the estimate rule", () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  registerGoal(mock.pi, "always");
  const wait = requireGoalTool(mock, "goal_wait") as unknown as {
    description: string;
    promptGuidelines?: string[];
  };
  assert.match(wait.description, ESTIMATE_RULE);
  assert.match(wait.description, /not an arbitrary round number/i);
  const guidelines = (wait.promptGuidelines ?? []).join("\n");
  assert.match(guidelines, ESTIMATE_RULE);
  assert.match(guidelines, /state the basis in reason/i);
});
