import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { currentTokenTotal, rebaseGoalUsage } from "./accounting.js";
import { validateObjective } from "./command.js";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import {
  blocksStaleGoalToolCalls,
  editedGoalStatus,
  formatStatus,
  GOAL_BLOCKED_TOOL,
  GOAL_COMPLETE_TOOL,
  GOAL_EDIT_TOOL,
  GOAL_WAIT_TOOL,
  type GoalRuntime,
  goalIdRejectionReason,
  isContradictoryCompletionSummary,
  MAX_GOAL_ID_LENGTH,
  nextGoalInstance,
  queueGoalSafetyReset,
  STATUS_KEY,
  transitionGoal,
  truncateNotification,
} from "./runtime.js";
import { formatGoalSafetyPause } from "./safety.js";
import {
  createGoalWait,
  MAX_GOAL_WAIT_REASON_LENGTH,
  MIN_GOAL_WAIT_DELAY_MS,
  normalizeGoalWait,
  resolveGoalWaitDelay,
} from "./wait.js";

interface GoalCompleteDetails {
  goal: string;
  goal_id: string;
  summary: string;
}

interface GoalWaitDetails {
  goal: string;
  goal_id: string;
  reason: string;
  requested_resume_after_ms?: number;
  effective_resume_after_ms?: number;
  resume_at?: number;
}

interface GoalBlockedDetails {
  goal: string;
  goal_id: string;
  reason: string;
  evidence: string;
  repeated_turns: number;
}

interface GoalEditQueueEntry {
  position: number;
  goal_id: string;
  status: string;
  objective: string;
}

interface GoalEditDetails {
  target: "active" | "queued";
  goal: string;
  goal_id: string;
  previous_goal_id?: string;
  objective: string;
  queue_position?: number;
  queue: GoalEditQueueEntry[];
}

const MAX_GOAL_TEXT_LENGTH = 4_000;
const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalRuntime) {
  const goalCompleteTool = defineTool({
    name: GOAL_COMPLETE_TOOL,
    // Nested execution strips terminate; terminal transitions must be direct model calls.
    exposure: "model-only",
    label: "Goal Complete",
    description:
      "Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
    promptSnippet: "Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
    promptGuidelines: [
      "When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
      "Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
      "Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
      "Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
      }),
      summary: Type.String({
        minLength: 1,
        maxLength: MAX_COMPLETION_SUMMARY_LENGTH,
        description:
          "State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const completedGoal = runtime.activeGoal;
      const goal = completedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";

      if (!completedGoal) {
        const rejection = "Goal completion rejected: no active goal.";
        notifyTerminal(ctx.ui, rejection, "warning");

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
      const safetyPause = formatGoalSafetyPause(completedGoal, runtime.settings.continuationLimits);
      if (safetyPause) {
        const rejection = `Goal completion rejected: ${safetyPause}`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
        const rejection = "Goal completion rejected: current run does not own the active goal.";
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }
      if (hasPendingSkipForGoal(runtime, completedGoal.id)) {
        runtime.recordGoalUsage(completedGoal, ctx);
        runtime.persistGoal(completedGoal);
        runtime.updateStatus(ctx, completedGoal);
        runtime.clearBudgetWrapUp();
        const rejection = `Goal completion rejected: ${pendingAdvanceMessage(runtime)}`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: true,
        };
      }
      const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
      if (staleGoalRejection) {
        const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        if (completingDuringBudgetWrapUp) {
          runtime.recordGoalUsage(completedGoal, ctx);
          runtime.persistGoal(completedGoal);
          runtime.updateStatus(ctx, completedGoal);
          runtime.clearBudgetWrapUp();
        }

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: completingDuringBudgetWrapUp || undefined,
        };
      }
      if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
        const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
        notifyTerminal(ctx.ui, rejection, "warning");

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
        };
      }

      const rejectionReason = !summary
        ? "summary is empty"
        : summary.length > MAX_COMPLETION_SUMMARY_LENGTH
          ? "summary is too long"
          : isContradictoryCompletionSummary(summary)
            ? "summary says the goal is not complete"
            : undefined;
      if (rejectionReason) {
        runtime.recordGoalUsage(completedGoal, ctx);
        runtime.persistGoal(completedGoal);
        runtime.updateStatus(ctx, completedGoal);
        const rejection = `Goal completion rejected: ${rejectionReason}.`;
        notifyTerminal(ctx.ui, rejection, "warning");
        if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

        return {
          content: toolContent(rejection),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: completingDuringBudgetWrapUp || undefined,
        };
      }

      runtime.activeGoal = transitionGoal(completedGoal, "complete");
      runtime.setCompletionSummary(runtime.activeGoal.id, summary);
      runtime.recordGoalUsage(runtime.activeGoal, ctx);
      if (runtime.pendingQueueAction?.kind === "prioritize") {
        runtime.persistGoal(runtime.activeGoal);
        ctx.ui.setStatus(STATUS_KEY, "complete");
        notifyTerminal(ctx.ui, `Goal complete: ${goal}. Priority goal waits for Pi to settle.`, "info");
        return {
          content: toolContent(`Goal complete: ${summary}`),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: true,
        };
      }
      if (runtime.queuedGoals.length > 0) {
        runtime.pendingQueueAction = {
          kind: "advance",
          goalId: runtime.activeGoal.id,
          reason: "complete",
          completedText: goal,
        };
        runtime.persistGoal(runtime.activeGoal);
        ctx.ui.setStatus(STATUS_KEY, "complete");
        notifyTerminal(ctx.ui, `Goal complete: ${goal}. Next goal queued: ${runtime.queuedGoals[0]?.text}`, "info");
        return {
          content: toolContent(`Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`),
          details: completionDetails(goal, requestedGoalId, summary),
          terminate: true,
        };
      }
      runtime.persistGoal(runtime.activeGoal);

      ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
      runtime.clearActiveGoal(ctx);
      runtime.showCompletionStatus(ctx);
      notifyTerminal(ctx.ui, `Goal complete: ${goal}`, "info");

      return {
        content: toolContent(`Goal complete: ${summary}`),
        details: completionDetails(goal, requestedGoalId, summary),
        terminate: true,
      };
    },
  });

  const goalBlockedTool = defineTool({
    name: GOAL_BLOCKED_TOOL,
    exposure: "model-only",
    label: "Goal Blocked",
    description:
      "Stop the active /goal only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
    promptSnippet: "Mark the active /goal blocked only after the same blocker recurs for three consecutive goal turns",
    promptGuidelines: [
      "Use goal_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
      "After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
      "Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
      "Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_REASON_LENGTH,
        description: "The specific user or external action required to unblock the goal.",
      }),
      evidence: Type.String({
        minLength: 1,
        maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
        description: "Concrete evidence from the repeated attempts that proves the impasse.",
      }),
      repeated_turns: Type.Integer({
        minimum: 3,
        description: "Number of separate turns spent trying to resolve this same blocker.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const blockedGoal = runtime.activeGoal;
      const goal = blockedGoal?.text ?? "unknown goal";
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      const repeatedTurns = typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
      const reject = (rejectionReason: string, terminate = false) => {
        const rejection = `goal_blocked rejected: ${rejectionReason}${rejectionReason.endsWith(".") ? "" : "."}`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!blockedGoal) return reject("no active goal");
      const safetyPause = formatGoalSafetyPause(blockedGoal, runtime.settings.continuationLimits);
      if (safetyPause) return reject(safetyPause);
      if (!runtime.canRecordGoalUsage()) {
        return reject("current run does not own the active goal");
      }
      if (hasPendingSkipForGoal(runtime, blockedGoal.id)) {
        runtime.recordGoalUsage(blockedGoal, ctx);
        runtime.persistGoal(blockedGoal);
        runtime.updateStatus(ctx, blockedGoal);
        runtime.clearBudgetWrapUp();
        return reject(pendingAdvanceMessage(runtime), true);
      }
      const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (blockedGoal.status !== "active") {
        return reject(`goal is ${blockedGoal.status}, not active`);
      }
      if (!reason) return reject("reason is empty");
      if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
      if (!evidence) return reject("evidence is empty");
      if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
      if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
      if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

      const stoppedGoal = runtime.stopActiveGoal(ctx, {
        kind: "blocker_report",
        expectedGoalId: blockedGoal.id,
        reason,
      });
      if (!stoppedGoal) return reject("active goal changed before blocker transition");
      notifyTerminal(ctx.ui, `Goal blocked: ${truncateNotification(reason)}`, "warning");

      return {
        content: toolContent(`Goal blocked: ${reason}`),
        details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
        terminate: true,
      };
    },
  });

  const goalWaitTool = defineTool({
    name: GOAL_WAIT_TOOL,
    exposure: "model-only",
    label: "Goal Wait",
    description: `Keep the active /goal alive but quiet while something outside this session is expected — CI finishing, a review landing, a reply arriving. The goal pauses, stays resumable, and records why. Call it alone, after arranging whatever will wake it, and pass resume_after_ms from your estimate of when the remaining goal work or the awaited event will finish — not an arbitrary round number. Requests below ${MIN_GOAL_WAIT_DELAY_MS}ms are clamped to ${MIN_GOAL_WAIT_DELAY_MS}ms. Do not use it for ordinary unfinished work: if there is anything left you can do yourself, do it instead.`,
    promptSnippet: "Pause the active /goal while waiting on something outside this session",
    promptGuidelines: [
      "Use goal_wait only when progress genuinely depends on a later external event — not when work remains that you could do now.",
      `Set resume_after_ms from your estimate of how long the remaining goal work or the awaited event will take, and state the basis in reason; anything under ${MIN_GOAL_WAIT_DELAY_MS}ms is a polling loop and is clamped.`,
      "Omit resume_after_ms only when arriving input will wake the goal sooner; a stated estimate beats a guessed round number.",
      "Call goal_wait alone: a sibling tool call in the same turn can prevent the turn from ending.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description: "The exact goal_id shown in the current active /goal prompt.",
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_WAIT_REASON_LENGTH,
        description: "What is being waited for, and what will make it done.",
      }),
      resume_after_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Wake-up delay in milliseconds: your estimate of how long the remaining goal work or the awaited event will take. Raised to ${MIN_GOAL_WAIT_DELAY_MS}ms if lower. Omit to wait for external input only.`,
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const goal = runtime.activeGoal;
      const requestedGoalId = params.goal_id.trim();
      const reason = safeTerminalText(params.reason).trim();
      const requestedResumeAfterMs = params.resume_after_ms;

      const details = (): GoalWaitDetails => {
        const { requestedMs, effectiveMs } = resolveGoalWaitDelay(requestedResumeAfterMs);
        return {
          goal: (goal?.text ?? "").slice(0, MAX_GOAL_TEXT_LENGTH),
          goal_id: requestedGoalId.slice(0, MAX_GOAL_ID_LENGTH),
          reason: reason.slice(0, MAX_GOAL_WAIT_REASON_LENGTH),
          ...(requestedMs === undefined ? {} : { requested_resume_after_ms: requestedMs }),
          ...(effectiveMs === undefined ? {} : { effective_resume_after_ms: effectiveMs }),
        };
      };

      const reject = (why: string, terminate = false) => {
        const rejection = `goal_wait rejected: ${why}`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: details(),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!goal) return reject("no active goal");
      const safetyPause = formatGoalSafetyPause(goal, runtime.settings.continuationLimits);
      if (safetyPause) return reject(safetyPause);
      if (!runtime.canRecordGoalUsage()) return reject("current run does not own the active goal");
      if (hasPendingSkipForGoal(runtime, goal.id)) {
        runtime.recordGoalUsage(goal, ctx);
        runtime.persistGoal(goal);
        runtime.updateStatus(ctx, goal);
        runtime.clearBudgetWrapUp();
        return reject(pendingAdvanceMessage(runtime), true);
      }
      const staleGoalRejection = goalIdRejectionReason(goal, requestedGoalId);
      if (staleGoalRejection) return reject(staleGoalRejection);
      if (goal.status !== "active") return reject(`goal is ${goal.status}, not active`);
      if (!reason) return reject("reason is empty");

      if (
        requestedResumeAfterMs !== undefined &&
        (!Number.isSafeInteger(requestedResumeAfterMs) || requestedResumeAfterMs < 1)
      )
        return reject("resume_after_ms must be a positive safe integer");
      const wait = normalizeGoalWait(createGoalWait(reason, requestedResumeAfterMs));
      if (!wait) return reject("invalid wait reason or deadline");
      const stoppedGoal = runtime.stopActiveGoal(ctx, {
        kind: "wait",
        expectedGoalId: goal.id,
        wait,
      });
      if (!stoppedGoal) return reject("active goal changed before the wait took effect");

      // Armed after the stop, so a wake can never race a goal that is still
      // being transitioned out of `active`.
      if (runtime.activeGoal === stoppedGoal) runtime.scheduleGoalWaitWake(ctx);

      const { requestedMs, effectiveMs } = resolveGoalWaitDelay(requestedResumeAfterMs);
      const clamped = requestedMs !== undefined && effectiveMs !== undefined && effectiveMs !== requestedMs;
      const deadline =
        effectiveMs === undefined
          ? "It will stay paused until you send it something or resume it."
          : `It will wake in ${Math.round(effectiveMs / 1000)}s${clamped ? ` (raised from ${requestedMs}ms)` : ""}.`;
      notifyTerminal(ctx.ui, `Goal waiting: ${truncateNotification(reason)}`, "info");

      return {
        content: toolContent(`Goal waiting: ${reason}. ${deadline}`),
        details: { ...details(), ...(wait.resumeAt === undefined ? {} : { resume_at: wait.resumeAt }) },
        terminate: true,
      };
    },
  });

  const goalEditTool = defineTool({
    name: GOAL_EDIT_TOOL,
    // Editing rewrites the objective the current turn is pursuing; it must be a
    // direct model call for the same reason terminal transitions are.
    exposure: "model-only",
    label: "Goal Edit",
    description:
      "Rewrite the objective of an existing /goal in this session — the active goal, or a queued goal by 1-based position — keeping the rest of the queue, the usage counters and the goal's status. Use it only to apply an objective change the user or the owning leader actually asked for, never to narrow your own scope. The active goal gets a new goal_id; use it from now on.",
    promptSnippet: "Rewrite an existing /goal objective in place when the user or leader asked for it, without replacing the queue",
    promptGuidelines: [
      "Use goal_edit only for an objective change the user or the owning leader stated; never edit your own goal to narrow, soften, or redefine what was asked.",
      "Pass the exact goal_id from the current /goal prompt. Editing the active goal mints a new goal_id, so re-read the tool result and use that id for goal_complete and goal_blocked afterwards.",
      "Omit queued_index to edit the active goal; pass a 1-based queued_index to edit a queued goal without touching the active goal or the rest of the queue.",
      "Never recreate a goal to change its wording: a new /goal or goal replacement drops the queue and the usage history, while goal_edit preserves both.",
    ],
    parameters: Type.Object({
      goal_id: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_ID_LENGTH,
        description:
          "The exact goal_id from the current /goal prompt. When queued_index is set, either that id or the id of the queued goal at that position is accepted.",
      }),
      objective: Type.String({
        minLength: 1,
        maxLength: MAX_GOAL_TEXT_LENGTH,
        description:
          "The complete replacement objective. It fully supersedes the previous objective; keep every requirement that still applies.",
      }),
      queued_index: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "1-based position in the queued goals list. Omit to edit the active goal; the active goal and the rest of the queue are then left alone.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const active = runtime.activeGoal;
      const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
      const objective = typeof params.objective === "string" ? params.objective.trim() : "";
      const queuedIndex = params.queued_index;

      const queueDetails = (): GoalEditQueueEntry[] =>
        runtime.queuedGoals.map((queuedGoal, index) => ({
          position: index + 1,
          goal_id: queuedGoal.id,
          status: queuedGoal.status,
          objective: queuedGoal.text.slice(0, MAX_GOAL_TEXT_LENGTH),
        }));

      const details = (target: "active" | "queued", goalId: string, previousGoalId?: string): GoalEditDetails => ({
        target,
        goal: objective.slice(0, MAX_GOAL_TEXT_LENGTH),
        goal_id: goalId,
        ...(previousGoalId === undefined ? {} : { previous_goal_id: previousGoalId }),
        objective: objective.slice(0, MAX_GOAL_TEXT_LENGTH),
        ...(target === "queued" && queuedIndex !== undefined ? { queue_position: queuedIndex } : {}),
        queue: queueDetails(),
      });

      const reject = (why: string, terminate = false) => {
        const rejection = `goal_edit rejected: ${why}${why.endsWith(".") ? "" : "."}`;
        notifyTerminal(ctx.ui, rejection, "warning");
        return {
          content: toolContent(rejection),
          details: details(queuedIndex === undefined ? "active" : "queued", active?.id ?? ""),
          ...(terminate ? { terminate: true as const } : {}),
        };
      };

      if (!active) return reject("no active goal");
      if (!objective) return reject("objective is empty");
      if (objective.length > MAX_GOAL_TEXT_LENGTH) {
        return reject(`objective is too long (${objective.length}/${MAX_GOAL_TEXT_LENGTH} characters)`);
      }
      const objectiveError = validateObjective(objective);
      // validateObjective reports an empty objective with slash-command usage text;
      // that is already handled above, so anything left is a real rejection.
      if (objectiveError) return reject(objectiveError.replace(/^Usage: \/goal .*$/u, "objective is invalid"));

      if (queuedIndex === undefined) {
        // Active goal: same transition `/goal edit` performs, minus the follow-up
        // prompt — the tool result is the authoritative objective for this turn.
        const safetyPause = formatGoalSafetyPause(active, runtime.settings.continuationLimits);
        if (safetyPause) return reject(safetyPause);
        if (!runtime.canRecordGoalUsage()) return reject("current run does not own the active goal");
        if (hasPendingSkipForGoal(runtime, active.id)) {
          runtime.recordGoalUsage(active, ctx);
          runtime.persistGoal(active);
          runtime.updateStatus(ctx, active);
          runtime.clearBudgetWrapUp();
          return reject(pendingAdvanceMessage(runtime), true);
        }
        const staleGoalRejection = goalIdRejectionReason(active, requestedGoalId);
        if (staleGoalRejection) return reject(staleGoalRejection);

        const previousGoalId = active.id;
        const previousStatus = active.status;
        if (previousStatus === "active") runtime.recordGoalUsage(active, ctx);
        runtime.cancelContinuationWork();
        runtime.clearGoalRecovery();
        runtime.clearBudgetWrapUp();
        const transitioned = transitionGoal(
          { ...nextGoalInstance(active), text: objective },
          editedGoalStatus(previousStatus),
        );
        const nextGoal =
          transitioned.status === "active"
            ? queueGoalSafetyReset(
                previousStatus === "active" ? transitioned : rebaseGoalUsage(transitioned, currentTokenTotal(ctx)),
              )
            : transitioned;
        runtime.activeGoal = nextGoal;
        // The run's own instructions still name the previous id; re-bind it on the
        // next request so a correct model does not chase a stale guard.
        runtime.editedGoalBindingId = nextGoal.id;
        if (blocksStaleGoalToolCalls(nextGoal.status)) runtime.blockStaleGoalToolCalls();
        else runtime.clearStaleGoalToolCallBlock();
        runtime.persistGoal(nextGoal);
        runtime.updateStatus(ctx, nextGoal);
        notifyTerminal(ctx.ui, `Goal updated: ${truncateNotification(objective)}`, "info");

        const queuedCount = runtime.queuedGoals.length;
        return {
          content: toolContent(
            `Goal updated: ${objective}\n` +
              `Status: ${nextGoal.status}. This goal_id is now ${nextGoal.id}; the previous id ${previousGoalId} is stale, so pass the new one to goal_complete and goal_blocked. ` +
              `Queue unchanged${queuedCount === 0 ? " (no queued goals)" : ` (${queuedCount} queued)`}.`,
          ),
          details: details("active", nextGoal.id, previousGoalId),
        };
      }

      // Queued goal: text only. Its id, position and status stay as they are, so
      // nothing that refers to the queue by id is invalidated.
      if (!Number.isInteger(queuedIndex) || queuedIndex < 1) {
        return reject("queued_index must be a whole number of at least 1");
      }
      if (!runtime.canRecordGoalUsage()) return reject("current run does not own this session's goals");
      if (runtime.queueFrozen) return reject("the goal queue is frozen; no queued goal can be edited");
      if (runtime.pendingQueueAction) {
        return reject("the goal queue is mid-transition; retry once Pi has settled");
      }
      const queuedGoal = runtime.queuedGoals[queuedIndex - 1];
      if (!queuedGoal) {
        return reject(`no goal is queued at position ${queuedIndex} (${runtime.queuedGoals.length} queued)`);
      }
      if (requestedGoalId !== active.id && requestedGoalId !== queuedGoal.id) {
        return reject("goal_id does not match the active goal or the queued goal at that position");
      }

      runtime.queuedGoals = runtime.queuedGoals.map((entry, index) =>
        index === queuedIndex - 1 ? { ...entry, text: objective, updatedAt: Date.now() } : entry,
      );
      runtime.persistGoal(active);
      notifyTerminal(ctx.ui, `Goal updated at position ${queuedIndex}: ${truncateNotification(objective)}`, "info");

      return {
        content: toolContent(
          `Queued goal at position ${queuedIndex} updated: ${objective}\n` +
            `The active goal and its goal_id are unchanged; this queued goal keeps its id ${queuedGoal.id} and activates with this objective.`,
        ),
        details: details("queued", queuedGoal.id),
      };
    },
  });

  pi.registerTool(goalCompleteTool);
  pi.registerTool(goalBlockedTool);
  pi.registerTool(goalWaitTool);
  pi.registerTool(goalEditTool);
}

function toolContent(text: string) {
  return [
    {
      type: "text" as const,
      text: truncateHead(safeTerminalText(text), {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      }).content,
    },
  ];
}

function completionDetails(goal: string, goalId: string, summary: string): GoalCompleteDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH),
  };
}

function blockerDetails(
  goal: string,
  goalId: string,
  reason: string,
  evidence: string,
  repeatedTurns: number,
): GoalBlockedDetails {
  return {
    goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
    goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
    reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
    evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
    repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
  };
}

function pendingAdvanceMessage(runtime: GoalRuntime) {
  return runtime.pendingQueueAction?.kind === "advance" && runtime.pendingQueueAction.reason === "next"
    ? "goal is queued to be rotated"
    : "goal is queued to be skipped";
}

function hasPendingSkipForGoal(runtime: GoalRuntime, goalId: string) {
  return (
    runtime.pendingQueueAction?.kind === "advance" &&
    (runtime.pendingQueueAction.reason === "skip" || runtime.pendingQueueAction.reason === "next") &&
    runtime.pendingQueueAction.goalId === goalId
  );
}
