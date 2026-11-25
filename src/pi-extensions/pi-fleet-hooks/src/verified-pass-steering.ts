// verified-pass-steering — prompt the agent when it keeps working after a verifier already passed.
//
// Based on the termination-lag assessment (arXiv:2611.14960): coding agents often reach a
// correct patch early and then spend a large share of the run on post-fix steps. The paper's
// oracle is retrospective, so nothing here claims to know which patch was correct. What a Pi
// extension CAN observe is narrower and honest: a declared verifier command completed with
// exit 0, and the agent has edited source since. That is a moment worth a question, not a stop.
//
// This hook is prompt-based only. It takes no snapshot, writes nothing to the working tree,
// opens no temporary index, and never stops, restores or submits anything. It injects one
// steering message per verifier pass, delivered at the next tool boundary, and the agent
// decides.
//
// OFF by default. Enable for a machine or project that runs declared verifiers with:
//     echo '{"enabled":true}' > ~/.pi/agent/verified-pass.json
// or PI_VERIFIED_PASS=1 in the environment. `verifierPatterns` narrows what counts as a
// declared verifier; the defaults cover the common runners.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";

/** Substrings that mark a command as a declared verifier. */
export const DEFAULT_VERIFIER_PATTERNS = [
  "npm test",
  "npm run test",
  "npm run check",
  "pnpm test",
  "yarn test",
  "node --test",
  "vitest",
  "jest",
  "pytest",
  "python -m pytest",
  "cargo test",
  "go test",
  "make test",
  "dotnet test",
  "./test.sh",
  "test/run.sh",
  "run-tests.sh",
];

/** Tool names that count as a source edit for the purposes of "kept working". */
export const EDIT_TOOL_NAMES = ["edit", "write", "multi_edit", "str_replace", "apply_patch"];

export interface SteeringConfig {
  enabled: boolean;
  verifierPatterns: string[];
  /** Source edits after a pass before the notice fires. Default 1. */
  editsBeforeNotice: number;
}

export function defaultConfig(): SteeringConfig {
  return { enabled: false, verifierPatterns: DEFAULT_VERIFIER_PATTERNS, editsBeforeNotice: 1 };
}

/** The agent directory; PI_CODING_AGENT_DIR overrides ~/.pi/agent, as Pi itself does. */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Reads ~/.pi/agent/verified-pass.json; PI_VERIFIED_PASS=1 forces enabled. Never throws. */
export function loadConfig(): SteeringConfig {
  const base = defaultConfig();
  if (process.env.PI_VERIFIED_PASS === "1") base.enabled = true;
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "verified-pass.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (raw.enabled === true) base.enabled = true;
      if (raw.enabled === false && process.env.PI_VERIFIED_PASS !== "1") base.enabled = false;
      if (Array.isArray(raw.verifierPatterns)) {
        const patterns = raw.verifierPatterns.filter((p: unknown): p is string => typeof p === "string" && p.length > 0);
        if (patterns.length > 0) base.verifierPatterns = patterns;
      }
      if (typeof raw.editsBeforeNotice === "number" && Number.isFinite(raw.editsBeforeNotice) && raw.editsBeforeNotice >= 1) {
        base.editsBeforeNotice = Math.floor(raw.editsBeforeNotice);
      }
    }
  } catch {
    // No config file (or unreadable): keep the defaults.
  }
  return base;
}

export function isVerifierCommand(command: string, patterns: string[] = DEFAULT_VERIFIER_PATTERNS): boolean {
  return patterns.some((pattern) => command.includes(pattern));
}

/** A bash run is a pass only when the tool reported success. */
export function isVerifierPass(command: string, isError: boolean, patterns: string[] = DEFAULT_VERIFIER_PATTERNS): boolean {
  return !isError && isVerifierCommand(command, patterns);
}

export interface SteeringState {
  /** A verifier pass is on record and no notice has been sent for it yet. */
  armed: boolean;
  passCommand?: string;
  editsSincePass: number;
  notified: boolean;
}

export function initialState(): SteeringState {
  return { armed: false, editsSincePass: 0, notified: false };
}

export type SteeringEvent =
  | { kind: "input" }
  | { kind: "bash"; command: string; isError: boolean }
  | { kind: "edit"; toolName: string }
  | { kind: "other" };

export interface SteeringDecision {
  state: SteeringState;
  notice?: string;
}

/**
 * Pure state machine. Returns the next state and, at most once per verifier pass, the notice to
 * steer with. It never returns anything that stops, blocks or reverts work.
 */
export function decideSteering(
  state: SteeringState,
  event: SteeringEvent,
  config: SteeringConfig,
): SteeringDecision {
  if (!config.enabled) return { state };

  if (event.kind === "input") {
    // A new human prompt starts new work; a stale pass must not colour it.
    return { state: initialState() };
  }

  if (event.kind === "bash") {
    if (isVerifierPass(event.command, event.isError, config.verifierPatterns)) {
      return {
        state: { armed: true, passCommand: event.command, editsSincePass: 0, notified: false },
      };
    }
    return { state };
  }

  if (event.kind === "edit" && state.armed && !state.notified) {
    const editsSincePass = state.editsSincePass + 1;
    if (editsSincePass < config.editsBeforeNotice) {
      return { state: { ...state, editsSincePass } };
    }
    return {
      state: { ...state, editsSincePass, notified: true },
      notice: buildNotice(state.passCommand ?? "a declared verifier", editsSincePass),
    };
  }

  return { state };
}

export function buildNotice(passCommand: string, edits: number): string {
  const plural = edits === 1 ? "edit" : "edits";
  return [
    "[verified-pass] A declared verifier passed in this run and the work has continued since.",
    `- Verifier pass: ${passCommand} (exit 0)`,
    `- Source ${plural} since that pass: ${edits}`,
    "- No snapshot was taken and nothing will be rolled back; this is a question, not a stop.",
    "Answer it explicitly: if every remaining requirement is named and still unmet, continue and say which one;",
    "if the task is complete, stop and report now. Re-running the verifier is justified when something changed",
    "that the last pass did not cover; repeating it unchanged is not progress.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  let state = initialState();
  let config = loadConfig();
  // tool_execution_end carries no args, so the command is captured at start and matched by call id.
  const commands = new Map<string, string>();

  pi.on("input", () => {
    config = loadConfig();
    state = initialState();
    commands.clear();
  });

  pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
    if (event.toolName !== "bash") return;
    const command = (event.args as { command?: unknown } | undefined)?.command;
    if (typeof command === "string") commands.set(event.toolCallId, command);
  });

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
    const command = commands.get(event.toolCallId);
    if (command !== undefined) commands.delete(event.toolCallId);
    if (!config.enabled) return;

    const steeringEvent: SteeringEvent =
      event.toolName === "bash"
        ? { kind: "bash", command: command ?? "", isError: event.isError }
        : EDIT_TOOL_NAMES.includes(event.toolName)
          ? { kind: "edit", toolName: event.toolName }
          : { kind: "other" };

    const decision = decideSteering(state, steeringEvent, config);
    state = decision.state;
    if (decision.notice) {
      // Steering only: delivered at the next tool boundary, never a stop or a rewrite.
      void pi.sendUserMessage(decision.notice, { deliverAs: "steer" });
    }
  });
}
