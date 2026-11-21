// harmony-duplicates — the extension entry for FT-92.
//
// Two hooks, one function:
//
//   - `message_end` removes a leaked harmony call from the message that was just finalized, so
//     the duplicate never enters the record or the next request. `message_end` handlers may
//     return `{ message }`; pi applies the replacement before it persists the message and before
//     it dispatches tools, which is why the strip has to leave every native `toolCall` block
//     untouched — it only ever drops `text` blocks.
//
//   - `context_with_system` removes the same blocks from the transcript pi is about to send. This
//     is the half that repairs history: the nine recorded leaks are already stored, and only the
//     outgoing request can stop paying for them. It is deterministic and idempotent, so the
//     stripped prefix is stable from the first call onwards rather than changing per turn.
//
// What this hook deliberately does not do:
//
//   - It does not synthesise a `toolCall` from the text. On DeepSeek a text-only call is the only
//     carrier of that call and `pi-dsml` appends one for that reason; here the native call is the
//     carrier, the text never executed, and appending would run a call twice.
//   - It does not gate on a model id. The marker is the discriminator (see
//     `harmony-duplicate-calls.ts`), so the fix also covers the next checkpoint with the same
//     habit.
//   - It does not touch anything it cannot classify: prose that quotes the marker fails the
//     residue test and is left alone.
//
// The host is typed structurally rather than importing `ExtensionAPI`, for the same reason
// `tool-markup-inert.ts` does: this package ships no SDK dependency, so a type-only import of the
// SDK fails the package's own `typecheck` with TS2307. That is also why the environment is read
// through `globalThis.process` instead of the `process` global — the typecheck command carries no
// `@types/node` either.
//
// Switches, read at load time:
//   PI_HARMONY_STRIP=off     disable the hook entirely (default: on)
//   PI_HARMONY_HISTORY=off   keep message_end stripping, but do not rewrite the outgoing transcript
//   PI_HARMONY_DEBUG=1       write one line per strip to stderr

import {
  stripHarmonyToolCalls,
  type AssistantMessageLike,
  type HarmonyStripResult,
} from "./harmony-duplicate-calls.ts";

/** The two event shapes this hook sees, as pi delivers them. */
export interface MessageEndEvent {
  message: unknown;
}

export interface ContextWithSystemEvent {
  messages: unknown[];
}

/** Mirrors the slice of pi's extension host this entry uses. */
export interface HarmonyHost {
  on(name: "message_end", handler: (event: MessageEndEvent) => unknown): void;
  on(name: "context_with_system", handler: (event: ContextWithSystemEvent) => unknown): void;
  registerCommand?(
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: { ui: { notify(message: string, level?: string): void } }) => Promise<void>;
    },
  ): void;
}

interface HarmonyProcess {
  env?: Record<string, string | undefined>;
  stderr?: { write(chunk: string): void };
}

function hostProcess(): HarmonyProcess {
  return (globalThis as unknown as { process?: HarmonyProcess }).process ?? {};
}

/** Cumulative counters for the process. Exported so a test can assert the hook fired rather than
 *  assume it did: a stripper whose removals are not counted is indistinguishable from one that
 *  never ran. */
export const harmonyStripCounters = {
  messages: 0,
  blocks: 0,
  chars: 0,
  duplicate: 0,
  stale: 0,
  fragment: 0,
};

export function resetHarmonyStripCounters(): void {
  harmonyStripCounters.messages = 0;
  harmonyStripCounters.blocks = 0;
  harmonyStripCounters.chars = 0;
  harmonyStripCounters.duplicate = 0;
  harmonyStripCounters.stale = 0;
  harmonyStripCounters.fragment = 0;
}

function record(result: HarmonyStripResult, debug: boolean): void {
  harmonyStripCounters.messages += 1;
  harmonyStripCounters.blocks += result.removed.length;
  harmonyStripCounters.chars += result.removedChars;
  harmonyStripCounters.duplicate += result.counts.duplicate;
  harmonyStripCounters.stale += result.counts.stale;
  harmonyStripCounters.fragment += result.counts.fragment;
  if (debug) {
    const tools = result.removed.map((leak) => leak.tool ?? "?").join(",");
    hostProcess().stderr?.write(
      `[harmony] removed=${result.removed.length} chars=${result.removedChars} ` +
        `duplicate=${result.counts.duplicate} stale=${result.counts.stale} ` +
        `fragment=${result.counts.fragment} tools=${tools}\n`,
    );
  }
}

/** Strip one message when it is an assistant message. Returns the replacement, or undefined when
 *  there is nothing to change — which is the common case and must stay cheap. */
export function stripAssistantMessage(
  message: unknown,
  debug: boolean,
): AssistantMessageLike | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as AssistantMessageLike;
  const result = stripHarmonyToolCalls(candidate);
  if (!result.changed) return undefined;
  record(result, debug);
  return result.message;
}

export function countersLine(): string {
  const c = harmonyStripCounters;
  return (
    `harmony stripper: strips=${c.messages} blocks=${c.blocks} chars=${c.chars} ` +
    `duplicate=${c.duplicate} stale=${c.stale} fragment=${c.fragment}`
  );
}

export default function (host: HarmonyHost): void {
  const env = hostProcess().env ?? {};
  if (env.PI_HARMONY_STRIP === "off") return;
  const debug = env.PI_HARMONY_DEBUG === "1";

  // An in-band way to prove this entry loaded, without a launch-time env var: `/reload` re-runs
  // the extensions but cannot change the process environment, so a debug flag set in a shell
  // never reaches a reloaded lane. The counters are the same numbers the debug line carries.
  host.registerCommand?.("harmony", {
    description: "Report the harmony duplicate-call stripper's counters",
    handler: async (_args, ctx) => {
      ctx.ui.notify(countersLine(), "info");
    },
  });

  host.on("message_end", (event) => {
    const replacement = stripAssistantMessage(event.message, debug);
    if (!replacement) return;
    return { message: replacement };
  });

  if (env.PI_HARMONY_HISTORY === "off") return;

  host.on("context_with_system", (event) => {
    const messages = event.messages;
    if (!Array.isArray(messages)) return;
    let changed = false;
    const next = messages.map((message) => {
      const replacement = stripAssistantMessage(message, debug);
      if (!replacement) return message;
      changed = true;
      return replacement;
    });
    if (!changed) return;
    return { messages: next };
  });
}