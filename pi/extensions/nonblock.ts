// never-block — deflect the blocking form of a wait into its non-blocking twin.
//
// A single-conversational-intake agent (the overlord) must be reachable at every
// instant: a call that holds the turn queues the operator's next message behind
// it. The blocking forms are the *diligent-sounding* ones (`jobs action='attach'`
// reads as "I will wait for the report"), which is why they get used at all.
//
// pi's `tool_call` hook may mutate `event.input` in place, so the fix is a
// rewrite rather than a lecture:
//   jobs attach            -> jobs output   (read the tail; come back later)
// and a refusal for the one case that cannot be rewritten into something useful.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const POLICY = `
[non-block] That call would hold the session open. This agent must stay reachable —
the operator's next message queues behind a blocking turn.

- jobs action='attach'   -> use action='output' to read the tail now.
- To wait for completion, keep the job, do other work, and check with 'output'.
- For a condition, use bash with run_in_background=true and an 'until' loop.
- For events, use the monitor tool.

Blocking is a defect class, not a style choice.`;

// OFF by default. Blocking a tool call changes agent behaviour, and a machine
// whose agent legitimately needs a bounded wait (a one-shot script that must
// finish before the next step) should not silently lose that. Enable it for a
// machine that runs an intake-style agent — the overlord — with:
//     echo '{"enabled":true}' > ~/.pi/agent/nonblock.json
// or PI_NONBLOCK=1 in the environment.
function enabled(): boolean {
  if (process.env.PI_NONBLOCK === "1") return true;
  try {
    const cfg = JSON.parse(readFileSync(join(getAgentDir(), "nonblock.json"), "utf8"));
    return cfg?.enabled === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;
  pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult | undefined => {
    if (event.toolName !== "jobs") return undefined;
    const input = event.input as { action?: string; wait?: boolean };
    if (input?.action !== "attach") return undefined;

    // attach with wait:false is just output; make that explicit and allow it.
    if (input.wait === false) {
      input.action = "output";
      return undefined;
    }

    // Anything else is a real block. Refuse and say what to do instead.
    return { block: true, reason: POLICY };
  });
}
