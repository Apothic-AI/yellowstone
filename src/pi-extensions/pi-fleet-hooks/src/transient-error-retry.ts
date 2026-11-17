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
// This extension reclassifies only those families of messages as `server_error:` (a code pi
// already retries), so the normal retry machinery handles them: settings.retry backoff,
// retry spinners, auto_retry events, and omission of failed attempts from the model
// projection.
//
// FT-75 adds a second family: a gateway that relays a broken upstream reply reports it as
// HTTP 403 instead of 502. The recorded bodies differ by one character --
//   `403: {"message":"openai_error","type":"bad_response_status_code",...}`  -> one attempt, turn ends
//   `502: {"message":"openai_error","type":"bad_response_status_code",...}`  -> normal backoff
// -- because 403 is absent from pi's status list (retry.js:39) while 502 is on it. The status
// digit is not the fact that matters; the body is. Promotion stays narrow (403 AND the
// gateway's own `bad_response_status_code` envelope) and is refused outright when the body
// carries refusal or limit vocabulary, because delaying a real auth/quota error by ~122 s of
// backoff is worse than reporting it immediately.
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

// FT-75: a 4xx status whose body is the gateway's own `bad_response_status_code` envelope --
// the same payload it sends as 502 when its relay fails. Deliberately requires both the exact
// status and the envelope's type field: a 403 without that body is an ordinary authorization
// answer and must not be promoted.
const GATEWAY_BAD_UPSTREAM_STATUS =
  /(?<![a-z0-9])403(?![a-z0-9])[\s\S]*"type"\s*:\s*"bad_response_status_code"/i;

// A refusal that will not clear by itself: credentials, permissions, or account routing. pi's
// own limit pattern runs first and declines quota/billing; this guard covers the rest of the
// family so a 403 the fleet cannot fix by waiting is never rewritten into a retry.
const NON_RETRYABLE_REFUSAL =
  /permission.?denied|forbidden|unauthori[sz]ed|not.?authori[sz]ed|invalid.?api.?.?key|api.?.?key.?(?:invalid|revoked|expired)|not supported by any configured account|no configured account|account in this group|insufficient_?balance/i;

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
  // FT-75: a credentials/permissions/routing refusal is final, whatever its status digit.
  if (NON_RETRYABLE_REFUSAL.test(errorMessage)) return undefined;
  if (!TRANSIENT_HINT.test(errorMessage) && !GATEWAY_BAD_UPSTREAM_STATUS.test(errorMessage))
    return undefined;
  // The gateway families share the `server_error:` shape, including the FT-75 403: the original
  // text (status, body, request id) is preserved verbatim behind the retryable code, so the
  // transcript still shows exactly what the gateway said.
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
