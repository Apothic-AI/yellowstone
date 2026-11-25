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
// FT-94 adds the router families observed in the fleet's session records, which pi's
// classifier also declines. Each is the router speaking about ITS own retry layer having
// given up, which is precisely the condition where waiting and asking again is the fix:
//   shared upstream overload retry stopped: context deadline exceeded (request id: ...)
//   routing retry budget expired before first protocol event (request id: ...)
//   upstream first stream event timeout
// (The third is already accepted by pi-ai 1.5.0's classifier because of the "timeout"
// pattern; it stays in the hint list as a fallback in case a later pi narrows the list.)
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
//
// FT-94 diagnostics: every retryable failure in a chain is appended as one JSON line to a
// durable state file (see `diagnosticLogPath`), with the attempt number, the reason, the
// delay pi will sleep for that attempt (computed with pi's own exported `retryDelayMs` and
// the session's effective `retry` settings), the gateway request id, and a terminal record
// when the chain ends (recovered / settled / aborted). The file never blocks a turn: every
// write is wrapped and a write failure is swallowed after being printed to stderr.

import { isRetryableAssistantError, retryDelayMs, type AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  AgentSettledEvent,
  MessageEndEvent,
  MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Quota and billing exhaustion. pi's classifier already declines these; the guard exists
// so this extension never turns one INTO a retryable code, which would make pi retry a
// limit that only resets later. Deliberately vocabulary-based rather than a copy of pi's
// list so it also covers limit codes pi adds later: it catches
// subscription_sharing_usage_limit_exceeded and the ChatGPT Business
// subscription_sharing_workplace_individual_usage_limit_exceeded without naming them,
// while leaving pi's retryable subscription_sharing_usage_unavailable alone (no "limit").
const NON_RETRYABLE_LIMIT =
  /usage.?limit|available balance|insufficient_quota|out of budget|quota exceeded|billing|GoUsageLimitError|FreeUsageLimitError/i;

// Transient upstream phrasing observed on the failures that fall through pi's pattern.
// Narrow on purpose: this is the allowlist that decides what may be promoted to
// `server_error:`. The FT-94 additions are the router's own give-up phrasings; a router
// that says it stopped retrying is telling us to wait and ask again, not that the request
// was wrong.
const TRANSIENT_HINT =
  /upstream response stream|upstream stream read failed before completion|stream ended unexpectedly|response stream ended|temporarily unavailable|please retry later|shared upstream overload|retry budget expired|before first protocol event|first stream event timeout/i;

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

// FT-94: a malformed request would fail identically forever. Status digits use pi's
// word-boundary lookarounds (retry.js) so a request id like "1400abc" is not a 400.
const NON_RETRYABLE_MALFORMED =
  /(?<![a-z0-9])(?:400|404|405|422)(?![a-z0-9])|invalid_request_error|malformed|invalid.?json|unexpected.?token|validation.?fail|unsupported.?parameter|missing.?required|unknown.?field/i;

// FT-94: invalid configuration would also fail identically forever: wrong model id, wrong
// api, bad key format, context that can never fit.
const NON_RETRYABLE_CONFIG =
  /model.?not.?found|no such model|unknown model|invalid.?model.?id|invalid.?config|misconfigur|context.?length.?exceed|context.?window|does not exist|not a valid/i;

// FT-94: an explicit user cancellation must never spin. pi surfaces real cancellations as
// stopReason "aborted" (never reaches the rewriter); this text guard is the second line of
// defense for cancellation phrasing that arrives on an error-shaped message. Deliberately
// user-scoped: "pending stream has been canceled" (ERR_HTTP2_STREAM_CANCEL) is a transport
// death pi retries, and the guard below only runs on messages pi does NOT already retry.
const NON_RETRYABLE_CANCELLED =
  /(?:aborted|cancel(?:l)?ed|interrupted)\s+by\s+(?:the\s+)?user|user.?(?:abort|cancel(?:l)?ed)|operation.?(?:was|has).?(?:been.?)?(?:abort|cancel(?:l)?ed)/i;

/** Extracts the gateway request id from a recorded error body, or undefined. */
export function extractRequestId(errorMessage: string): string | undefined {
  return /request id:\s*([\w.:-]+)/i.exec(errorMessage)?.[1];
}

/** The durable JSONL file retry chains are recorded to; `PI_FLEET_RETRY_LOG` overrides. */
export function diagnosticLogPath(): string {
  if (process.env.PI_FLEET_RETRY_LOG) return process.env.PI_FLEET_RETRY_LOG;
  return path.join(os.homedir(), ".local", "state", "pi-fleet-retry", "retry-events.jsonl");
}

/** Appends one diagnostic record; failures never propagate into the session. */
function appendDiagnostic(record: Record<string, unknown>): void {
  try {
    const file = diagnosticLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch (error) {
    console.error(`[transient-error-retry] diagnostic write failed: ${String(error)}`);
  }
}

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
  // FT-94: a malformed request or invalid configuration would fail identically forever.
  if (NON_RETRYABLE_MALFORMED.test(errorMessage)) return undefined;
  if (NON_RETRYABLE_CONFIG.test(errorMessage)) return undefined;
  // FT-94: an explicit user cancellation must end the turn, not spin.
  if (NON_RETRYABLE_CANCELLED.test(errorMessage)) return undefined;
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

/** The effective retry policy pi's agent loop will use, read from session settings. */
function retryPolicy(pi: ExtensionAPI) {
  const retry = pi.getSettings().retry ?? {};
  return {
    enabled: retry.enabled ?? true,
    maxRetries: retry.maxRetries ?? 3,
    baseDelayMs: retry.baseDelayMs ?? 2000,
    maxAgentDelayMs: retry.maxAgentDelayMs ?? 60_000,
    jitterRatio: retry.jitterRatio ?? 0,
  };
}

export default function (pi: ExtensionAPI) {
  // Consecutive retryable failures since the last success, settle, or session start. This
  // tracks pi's own `_retryAttempt` exactly: pi increments once per retryable agent-run
  // error (agent-session.js `_prepareRetry`) and resets on any non-error assistant message
  // (agent-session.js ~line 799) and when a run settles on a final error (~line 1575).
  let attempt = 0;
  let lastReason: string | undefined;
  let lastRequestId: string | undefined;

  pi.on("session_start", () => {
    attempt = 0;
    lastReason = undefined;
    lastRequestId = undefined;
  });

  pi.on(
    "message_end",
    (event: MessageEndEvent): MessageEndEventResult | undefined => {
      const message = event.message;
      if (message.role !== "assistant") return undefined;

      if (message.stopReason !== "error") {
        // Any clean assistant message closes the chain, matching pi's own counter reset.
        if (attempt > 0) {
          appendDiagnostic({
            event: "recovered",
            attempts: attempt,
            session: pi.getSessionName(),
          });
          attempt = 0;
          lastReason = undefined;
          lastRequestId = undefined;
        }
        return undefined;
      }

      const errorMessage = message.errorMessage;
      if (!errorMessage) return undefined;
      // Record the true final reason even when this error is not itself retryable, so a
      // chain that ends on a permanent failure reports what actually ended it.
      lastReason = errorMessage;
      lastRequestId = extractRequestId(errorMessage);

      const policy = retryPolicy(pi);
      const promoted = rewriteTransientError(message);
      const retryable = promoted !== undefined || isRetryableAssistantError(message);
      if (!policy.enabled || !retryable)
        return promoted ? { message: { ...message, errorMessage: promoted } as typeof message } : undefined;

      // Only record a retry when pi's gates will actually take one. `_prepareRetry` increments
      // its counter and decrements it again when the budget is exhausted, so the failure that
      // ends an exhausted chain is not a retry and must not be logged as one; the terminal
      // `settled` record from `agent_settled` reports it instead.
      const nextAttempt = attempt + 1;
      if (nextAttempt > policy.maxRetries) {
        return promoted && promoted !== errorMessage
          ? { message: { ...message, errorMessage: promoted } as typeof message }
          : undefined;
      }
      attempt = nextAttempt;
      // The delay pi's agent loop will sleep for this attempt: same exported function pi's
      // `_prepareRetry` calls, same policy, same attempt index.
      const delayMs = retryDelayMs(policy, attempt);
      appendDiagnostic({
        event: "retry_scheduled",
        attempt,
        maxAttempts: policy.maxRetries,
        delayMs,
        reason: promoted ?? errorMessage,
        requestId: lastRequestId,
        session: pi.getSessionName(),
      });
      if (!promoted || promoted === errorMessage) return undefined;
      // Returning a replacement triggers pi's _replaceMessageInPlace, so agent state,
      // persistence, and the retry decision in _handlePostAgentRun all see the rewrite.
      return { message: { ...message, errorMessage: promoted } as typeof message };
    },
  );

  pi.on("agent_settled", (event: AgentSettledEvent) => {
    if (attempt === 0) return;
    appendDiagnostic({
      event: event.aborted ? "aborted" : "settled",
      attempts: attempt,
      aborted: event.aborted,
      reason: lastReason,
      requestId: lastRequestId,
      session: pi.getSessionName(),
    });
    attempt = 0;
    lastReason = undefined;
    lastRequestId = undefined;
  });
}
