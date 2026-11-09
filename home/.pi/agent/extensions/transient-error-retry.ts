// transient-error-retry — recover runs from transient upstream errors pi's built-in
// retry classifier misses.
//
// pi auto-retries assistant errors that its own classifier accepts, but some
// gateways report transient stream drops with an unmapped code, e.g. relayfast:
//   unknown: The upstream response stream ended unexpectedly before completion. Retry the
//   request; ... (request id: ...) Current source: "GPT Team/Plus".
// That matches nothing in pi's pattern, so the run settles immediately and the agent
// "dies" until the user nudges it.
//
// This extension reclassifies only that family of messages as `server_error:` (a code pi
// already retries), so the normal retry machinery handles them: settings.retry backoff,
// retry spinners, auto_retry events, and omission of failed attempts from the model
// projection.
//
// Why it asks pi instead of mirroring pi: earlier revisions duplicated pi's
// NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN and RETRYABLE_PROVIDER_ERROR_PATTERN
// verbatim to stay "byte-compatible". Pi 1.4.0 rewrote both lists (status codes gained
// word-boundary lookarounds so a request id like "1500abc" no longer counts as a 500,
// a dozen new transient phrasings were added, and ChatGPT Business workspace limits
// became explicitly non-retryable), which silently broke that mirror: errors pi had
// stopped retrying were still skipped here, and a workspace usage limit could be
// rewritten into a retryable code. `isRetryableAssistantError` is the exact function
// pi's own retry loop uses, is exported by pi-ai in every version we run, and cannot
// drift, so the retry decision is delegated and only the *rewrite* decision is ours.

import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, MessageEndEvent, MessageEndEventResult } from "@earendil-works/pi-coding-agent";

// Quota and billing exhaustion. pi's classifier already declines these; the guard exists
// so this extension never turns one INTO a retryable code, which would make pi retry a
// limit that only resets later. Deliberately vocabulary-based rather than a copy of pi's
// list so it also covers limit codes pi adds later: it catches
// subscription_sharing_usage_limit_exceeded and the ChatGPT Business
// subscription_sharing_workplace_individual_usage_limit_exceeded without naming them,
// while leaving pi's retryable subscription_sharing_usage_unavailable alone (no "limit").
const NON_RETRYABLE_LIMIT =
  /usage.?limit|available balance|insufficient_quota|out of budget|quota exceeded|billing|GoUsageLimitError|FreeUsageLimitError/i;

// Transient upstream phrasing observed on the "unknown:"-coded failures that fall
// through pi's pattern. Narrow on purpose: this is the allowlist that decides what may
// be promoted to `server_error:`.
const TRANSIENT_HINT =
  /upstream response stream|stream ended unexpectedly|response stream ended|temporarily unavailable|please retry later/i;

/**
 * Returns a retryable rewrite of the message's `errorMessage`, or undefined when it must
 * be left alone. Takes the whole message so pi's classifier sees the genuine object.
 */
export function rewriteTransientError(message: AssistantMessage): string | undefined {
  const errorMessage = message.errorMessage;
  if (!errorMessage) return undefined;
  // Quota/billing exhaustion: pi handles those itself; retrying would be wrong.
  if (NON_RETRYABLE_LIMIT.test(errorMessage)) return undefined;
  // pi already classifies this as retryable — don't rewrite its transcript entry.
  if (isRetryableAssistantError(message)) return undefined;
  if (!TRANSIENT_HINT.test(errorMessage)) return undefined;
  // Keep the native shape: the same gateway writes its own errors as `server_error: ...`.
  if (/^unknown:\s*/i.test(errorMessage)) {
    return errorMessage.replace(/^unknown:\s*/i, "server_error: ");
  }
  return `server_error: ${errorMessage}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event: MessageEndEvent): MessageEndEventResult | undefined => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
    const rewritten = rewriteTransientError(message);
    if (!rewritten || rewritten === message.errorMessage) return undefined;
    // Returning a replacement triggers pi's _replaceMessageInPlace, so agent state,
    // persistence, and the retry decision in _handlePostAgentRun all see the rewrite.
    return { message: { ...message, errorMessage: rewritten } as typeof message };
  });
}
