import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRunController } from "./run-protocol.js";
import { GoalRuntime } from "./runtime.js";
import { registerGoalReceiverActions, settleDeferredWrites } from "./receiver-actions.js";
import { registerGoalTools } from "./tools.js";

interface GoalOptions {
  settingsPath?: string;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  const commands = new GoalCommandController(runtime);
  const runController = new GoalRunController(runtime, commands);

  // A `goal_wait` deadline resumes through the SAME path as `/goal resume`:
  // tool-policy preparation, recovery clearing and prompt delivery all have to
  // happen, and a shortcut would be a second, worse resume path drifting from
  // the real one. Wired here because the controller owns it and the runtime,
  // which arms the timer, deliberately does not depend on the controller.
  runtime.onGoalWaitElapsed = (ctx) => {
    void commands.resumeGoal(ctx, "deadline");
  };

  // Keep registration order explicit: managed-run bus listeners exist before tools,
  // command routing, and session lifecycle bind the per-factory runtime.
  runController.register(pi);
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, runtime, commands, options);
  registerGoalLifecycle(pi, runtime, commands, runController, options);

  // FT-89: serve this session's own goal queue to its leader through the
  // pi-parameter-tools receiver. Registration is a disposition, not a throw: a
  // process without the receiver is a documented state a caller can report as
  // `unknown`, never as "no goals".
  // FT-89: the receiver registry is published by pi-parameter-tools, which pi may
  // load *after* this extension (it does: pi-goal is 23rd in the package list and
  // parameter-tools 25th). A one-shot registration at load therefore finds no
  // registry and silently serves nothing — measured, not theorised. So the
  // registration is attempted now and again at session_start, which is after every
  // extension has loaded; the second attempt is a no-op once the first succeeded.
  let receiverActions: { registered: boolean; dispose: () => void } | null = null;
  // A fresh session has no turn running. Cleared on agent_start, restored at every
  // boundary that resolves deferrals.
  let workerIdle = true;
  const ensureReceiverActions = () => {
    if (receiverActions && receiverActions.registered) return;
    receiverActions = registerGoalReceiverActions(
      () => runtime,
      undefined,
      null,
      undefined,
      undefined,
      () => workerIdle,
    );
  };
  ensureReceiverActions();
  pi.on("session_start", () => {
    ensureReceiverActions();
  });

  // FT-89: a deferred write lands at the boundary the deferral names. Expiry and
  // application are the same hook, so a worker that never settles resolves its
  // deferrals to target_gone instead of leaving the caller waiting on a token.
  // Three boundaries, because a deferral that never resolves is a lost write and the
  // events are cheap: turn_end fires after every assistant turn, agent_end when a
  // low-level run ends, agent_settled when pi is finally idle. Applying twice is
  // harmless (settling is idempotent); applying never is not.
  const settle = () => {
    settleDeferredWrites(runtime);
  };
  pi.on("agent_start", () => {
    workerIdle = false;
  });
  pi.on("turn_end", () => {
    // Any boundary that resolves deferrals also means no turn is running: clearing
    // idleness only on agent_settled leaves it stuck false after a turn that ended
    // with agent_end, and then every defer request parks forever.
    workerIdle = true;
    settle();
  });
  pi.on("agent_end", () => {
    workerIdle = true;
    settle();
  });
  pi.on("agent_settled", () => {
    workerIdle = true;
    settle();
  });
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
  registerGoalRuntime(pi, options);
}

export {
  assistantUsageTokens,
  cumulativeAssistantTokens,
  formatDuration,
  formatTokenCount,
} from "./accounting.js";

export {
  completeGoalArguments,
  parseCommand,
  parseTokenBudget,
  validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt } from "./prompts.js";

export {
  findFinalAssistantMessage,
  formatStatus,
  isContradictoryCompletionSummary,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
} from "./runtime.js";
