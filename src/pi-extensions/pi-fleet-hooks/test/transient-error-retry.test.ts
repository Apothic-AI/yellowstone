/**
 * FT-75 — a gateway 403 that ends the turn instead of retrying.
 *
 * The decision under test is not "does the regex match" but "would pi retry". Every case
 * therefore asserts through the **installed** `isRetryableAssistantError`, the exact function
 * `agent-session` calls in `_handlePostAgentRun`, imported from the same build the fleet runs.
 * A rewrite that this classifier still rejects is a no-op dressed as a fix, so both directions
 * are asserted on the real decision function:
 *
 *   - the recorded gateway 403 must become retryable (requirement 1);
 *   - an auth/quota/billing/routing 403 must stay unretryable (requirement 2), because 122 s of
 *     backoff before reporting a credentials problem is a diagnosability regression.
 *
 * The recorded strings are the real ones from the fleet's session files (2026-11-16T23:17:18Z
 * 403 and the identical payload as 502), not invented shapes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------------------------
// The installed classifier
// ---------------------------------------------------------------------------------------------

function candidateRetryJs(): string[] {
  const explicit = process.env.PI_AI_DIST;
  if (explicit) {
    return [path.join(explicit, "utils/retry.js"), path.join(explicit, "dist/utils/retry.js")];
  }
  const home = process.env.HOME ?? "";
  const roots = [
    path.join(
      home,
      ".local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
    ),
    path.join(home, ".local/share/mise/installs/node/22.23.3/lib/node_modules"),
    path.join(home, ".npm-global/lib/node_modules"),
    "/usr/local/lib/node_modules",
  ];
  return roots.flatMap((root) => [
    path.join(root, "@earendil-works/pi-ai/dist/utils/retry.js"),
    path.join(root, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js"),
  ]);
}

const retryJs = candidateRetryJs().find((file) => fs.existsSync(file));

test("verification gate: the installed retry classifier is discoverable", () => {
  assert.ok(
    retryJs !== undefined,
    `installed pi-ai retry.js not found (looked in: ${candidateRetryJs().join(", ")}). ` +
      "A suite that cannot load the real classifier would report green while proving nothing; " +
      "set PI_AI_DIST to the @earendil-works/pi-ai package root or its dist directory.",
  );
});

// The extension imports `@earendil-works/pi-ai` as a bare specifier, which only pi's own
// runtime resolves. Map it to the installed build before the source module is loaded, so the
// test exercises the real source (not a copy) against the real classifier (not a mirror).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai") {
      return { url: pathToFileURL(retryJs!).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { isRetryableAssistantError } = (await import(pathToFileURL(retryJs!).href)) as {
  isRetryableAssistantError: (message: Record<string, unknown>) => boolean;
};

const { rewriteTransientError, default: transientErrorRetry } = (await import(
  "../src/transient-error-retry.ts"
)) as {
  rewriteTransientError: (message: Record<string, unknown>) => string | undefined;
  default: (pi: unknown) => void;
};

function errorMessage(errorMessage: string, overrides: Record<string, unknown> = {}) {
  return { role: "assistant", stopReason: "error", errorMessage, content: [], ...overrides };
}

const GATEWAY_BODY =
  '"message":"openai_error","type":"bad_response_status_code","param":"","code":"bad_response_status_code"';
const RECORDED_403 = `403: {${GATEWAY_BODY}}`;
const RECORDED_502 = `502: {${GATEWAY_BODY}}`;

// ---------------------------------------------------------------------------------------------
// Requirement 1 — the gateway 403 retries
// ---------------------------------------------------------------------------------------------

test("gateway 403 (recorded body): pi rejects it, the rewrite makes pi retry", () => {
  const message = errorMessage(RECORDED_403);
  assert.equal(isRetryableAssistantError(message), false, "premise: pi does not retry the raw 403");

  const rewritten = rewriteTransientError(message as never);
  assert.ok(rewritten, "the gateway 403 must be rewritten, not left to end the turn");
  assert.equal(rewritten, `server_error: ${RECORDED_403}`);
  assert.equal(
    isRetryableAssistantError(errorMessage(rewritten)),
    true,
    "the rewrite must be accepted by pi's own classifier — otherwise it is a no-op",
  );
});

test("the rewrite preserves the gateway's words: status, body and request id are not replaced", () => {
  const withId = `403: {${GATEWAY_BODY}} (request id: 3f9c-abc123)`;
  const rewritten = rewriteTransientError(errorMessage(withId) as never);
  assert.ok(rewritten?.endsWith(withId), "the original text must survive behind the retryable code");
});

test("the identical payload as 502 is left alone — pi already retries it", () => {
  const message = errorMessage(RECORDED_502);
  assert.equal(isRetryableAssistantError(message), true, "premise: 502 is on pi's status list");
  assert.equal(
    rewriteTransientError(message as never),
    undefined,
    "rewriting a message pi already retries would only edit the transcript",
  );
});

// ---------------------------------------------------------------------------------------------
// Requirement 2 — a genuine refusal never becomes a retry
// ---------------------------------------------------------------------------------------------

const REFUSALS: Array<[string, string]> = [
  ["403 permission denied", '403: {"error":{"code":"permission_denied","message":"forbidden"}}'],
  ["403 invalid api key", '403: {"error":{"message":"invalid api key"}}'],
  ["403 revoked key", '403: {"message":"api key revoked"}'],
  ["403 unauthorized", '403: {"message":"unauthorized"}'],
  [
    "403 account routing (recorded)",
    '403: {"message":"Model \\"deepseek-v4.1-flash-1017\\" is not supported by any configured account in this group"}',
  ],
  ["403 budget", '403: {"message":"out of budget"}'],
  ["403 billing", '403: {"message":"billing_hard_limit_reached"}'],
  ["403 quota", '403: {"message":"insufficient_quota"}'],
  ["401 auth", '401: {"message":"invalid api key"}'],
  ["402 balance", '402: {"message":"insufficient balance"}'],
  ["429 subscription limit", "429: subscription_sharing_usage_limit_exceeded"],
];

for (const [name, text] of REFUSALS) {
  test(`refusal stays unretryable: ${name}`, () => {
    const message = errorMessage(text);
    assert.equal(
      rewriteTransientError(message as never),
      undefined,
      `${name} must not be rewritten into a retry`,
    );
    assert.equal(
      isRetryableAssistantError(message),
      false,
      `${name} must stay unretryable after the hook sees it`,
    );
  });
}

test("a gateway body that also carries refusal vocabulary is refused, not promoted", () => {
  const text = `403: {${GATEWAY_BODY}, "detail":"not supported by any configured account in this group"}`;
  assert.equal(
    rewriteTransientError(errorMessage(text) as never),
    undefined,
    "the refusal guard must win over the gateway-body match",
  );
});

test("a 403 without the gateway envelope is an ordinary authorization answer", () => {
  assert.equal(rewriteTransientError(errorMessage("403: Forbidden") as never), undefined);
  assert.equal(
    rewriteTransientError(errorMessage('403: {"message":"you do not have access to this model"}') as never),
    undefined,
  );
});

// ---------------------------------------------------------------------------------------------
// Existing behaviour must not regress
// ---------------------------------------------------------------------------------------------

test("the original transient family still rewrites, and still retries", () => {
  const text = "unknown: The upstream response stream ended unexpectedly before completion. Retry the request";
  const rewritten = rewriteTransientError(errorMessage(text) as never);
  assert.equal(rewritten, text.replace(/^unknown:\s*/i, "server_error: "));
  assert.equal(isRetryableAssistantError(errorMessage(rewritten!)), true);
});

test("unrecognised errors are left alone", () => {
  assert.equal(rewriteTransientError(errorMessage("unknown: something else entirely") as never), undefined);
  assert.equal(rewriteTransientError(errorMessage("syntax error in tool arguments") as never), undefined);
});

test("eligibility lives in the handler, and the handler applies it", () => {
  // `rewriteTransientError` is a pure text transform: it rewrites whatever body it is handed.
  // Role and stopReason are the handler's filter (asserted in the entry test below), so a
  // rewrite here for a non-error message is expected and harmless — nothing calls it that way.
  assert.equal(rewriteTransientError(errorMessage("") as never), undefined, "no body, nothing to rewrite");
  assert.equal(
    rewriteTransientError({ role: "user", stopReason: "error", content: [] } as never),
    undefined,
    "no errorMessage, nothing to rewrite",
  );
  assert.equal(
    typeof rewriteTransientError(errorMessage(RECORDED_403, { stopReason: "stop" }) as never),
    "string",
    "the rewriter does not second-guess the caller's eligibility decision",
  );
});

// ---------------------------------------------------------------------------------------------
// The extension entry: one registration, and it returns a replacement only when it should
// ---------------------------------------------------------------------------------------------

test("extension entry registers message_end and rewrites only the gateway 403", () => {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const pi = {
    on(event: string, handler: (event: unknown) => unknown) {
      handlers[event] = handler;
    },
  };
  transientErrorRetry(pi as never);
  assert.deepEqual(Object.keys(handlers), ["message_end"], "one durable registration, no timers");

  const handler = handlers.message_end!;
  const promoted = handler({ message: errorMessage(RECORDED_403) }) as
    | { message: { errorMessage: string } }
    | undefined;
  assert.equal(promoted?.message.errorMessage, `server_error: ${RECORDED_403}`);

  assert.equal(handler({ message: errorMessage('403: {"message":"invalid api key"}') }), undefined);
  assert.equal(handler({ message: errorMessage(RECORDED_502) }), undefined);
  assert.equal(handler({ message: errorMessage(RECORDED_403, { stopReason: "stop" }) }), undefined);
});
