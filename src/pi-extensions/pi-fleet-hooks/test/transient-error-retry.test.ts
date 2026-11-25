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

const { rewriteTransientError, extractRequestId, diagnosticLogPath, default: transientErrorRetry } = (await import(
  "../src/transient-error-retry.ts"
)) as {
  rewriteTransientError: (message: Record<string, unknown>) => string | undefined;
  extractRequestId: (errorMessage: string) => string | undefined;
  diagnosticLogPath: () => string;
  default: (pi: unknown) => void;
};

function errorMessage(errorMessage: string, overrides: Record<string, unknown> = {}) {
  return { role: "assistant", stopReason: "error", errorMessage, content: [], ...overrides };
}

// The FT-94 handler now writes diagnostics on promoted failures. Every test that drives the
// handler therefore points the durable log at a throwaway file: nothing may reach the fleet's
// real state path from a test process.
const DIAGNOSTICS_TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ft94-diag-"));
process.env.PI_FLEET_RETRY_LOG = path.join(DIAGNOSTICS_TMP, "retry-events.jsonl");

const GATEWAY_BODY =
  '"message":"openai_error","type":"bad_response_status_code","param":"","code":"bad_response_status_code"';
const RECORDED_403 = `403: {${GATEWAY_BODY}}`;
const RECORDED_502 = `502: {${GATEWAY_BODY}}`;

// ---------------------------------------------------------------------------------------------
// FT-94 — the router families recorded in fleet session records
// ---------------------------------------------------------------------------------------------

const FLEET_FAMILIES: Array<[string, string]> = [
  // The recorded shapes from fleet session records — bare router text with the request id, no
  // HTTP status prefix (the `✕ Error ·` in the transcript is the TUI, not the message):
  [
    "routing retry budget expired (recorded, bare)",
    "routing retry budget expired before first protocol event (request id: 20261119095112854781304HZXFss7T)",
  ],
  [
    "shared upstream overload (recorded, bare)",
    "shared upstream overload retry stopped: context deadline exceeded (request id: 20261118153109485512669m6aRMLUA)",
  ],
  [
    "HTTP/2 upstream stream read failure (recorded)",
    "upstream stream read failed before completion: http2: response body closed",
  ],
  // The same families as relayed by the openai-completions adapter, which prefixes the status:
  [
    "routing retry budget expired (403-wrapped)",
    '403: {"message":"routing retry budget expired before first protocol event (request id: 20261119095112854781304HZXFss7T)"}',
  ],
  // "upstream first stream event timeout" — already accepted by pi-ai 1.5.0 ("timeout");
  // the hint stays as a fallback in case a later pi narrows the list.
  ["upstream first stream event timeout", "upstream first stream event timeout"],
];

for (const [name, text] of FLEET_FAMILIES) {
  test(`FT-94 router family is retried after the rewrite: ${name}`, () => {
    const message = errorMessage(text);
    const rewritten = rewriteTransientError(message as never);
    if (isRetryableAssistantError(message)) {
      // pi already retries this one; the hook must not touch its transcript entry.
      assert.equal(rewritten, undefined, `${name}: pi retries it already, no rewrite`);
    } else {
      assert.ok(rewritten, `${name}: must be rewritten, not left to end the turn`);
      assert.equal(
        isRetryableAssistantError(errorMessage(rewritten)),
        true,
        `${name}: the rewrite must be accepted by pi's own classifier`,
      );
      if (text.includes("request id: ")) {
        assert.ok(rewritten.includes("request id: "), "the request id survives verbatim");
      }
      assert.ok(rewritten.endsWith(text.replace(/^unknown:\\s*/i, "")), "the original failure text survives verbatim");
    }
  });
}

// ---------------------------------------------------------------------------------------------
// FT-94 — permanent failures must fail fast: malformed, config, cancellation
// ---------------------------------------------------------------------------------------------

const PERMANENT: Array<[string, string]> = [
  [
    "malformed request 400",
    '400: {"error":{"message":"invalid_request_error: the request body is malformed","type":"invalid_request_error"}}',
  ],
  ["malformed json", '400: {"error":{"message":"malformed request: unexpected token in JSON"}}'],
  ["validation failure", '422: {"error":{"message":"validation failed for field temperature"}}'],
  ["unknown model", '404: {"error":{"message":"model not found: gpt-nonexistent"}}'],
  [
    "invalid model id",
    '400: {"error":{"message":"\'not-a-model\' is not a valid model id for this provider"}}',
  ],
  ["invalid configuration", '400: {"error":{"message":"invalid configuration: api key and oauth are mutually exclusive"}}'],
  ["context overflow", '400: {"error":{"message":"context length exceeded: 210000 tokens > 200000"}}'],
  ["user cancellation", "aborted by user"],
  ["user cancellation (provider wording)", '400: {"error":{"message":"operation was cancelled by the user"}}'],
];

for (const [name, text] of PERMANENT) {
  test(`permanent failure stays unretryable: ${name}`, () => {
    const message = errorMessage(text);
    assert.equal(rewriteTransientError(message as never), undefined, `${name} must not be rewritten`);
    assert.equal(isRetryableAssistantError(message), false, `${name} must not be retried by pi either`);
  });
}

test("a malformed-request status wins even when the body carries transient vocabulary", () => {
  // A 400 that quotes a transient phrase is still a client bug; the permanent guard must win.
  const text =
    '400: {"error":{"message":"routing retry budget expired while the request was malformed"}}';
  assert.equal(rewriteTransientError(errorMessage(text) as never), undefined);
});

test("a 5xx-wrapped user cancellation is retried by pi's status rule; the hook neither promotes nor alters it", () => {
  // Known upstream limitation, recorded here rather than papered over: pi's classifier matches
  // the 500 status digit before any wording, so a gateway that wraps an upstream-side user
  // cancellation in a 500 is retried by pi whatever this hook does. Suppressing that would
  // require falsifying the error text (the only lever a message replacement has), which is
  // worse than the retry. Real user cancellations surface as stopReason "aborted" and never
  // reach the rewriter at all.
  const text = '500: {"error":{"message":"operation was cancelled by the user"}}';
  const message = errorMessage(text);
  assert.equal(isRetryableAssistantError(message), true, "pi's status-digit rule retries the 500");
  assert.equal(rewriteTransientError(message as never), undefined, "the hook leaves it untouched");
});

test("the request-id extractor handles the recorded gateway shapes", () => {
  assert.equal(
    extractRequestId(
      '403: {"message":"routing retry budget expired before first protocol event (request id: 20261119095112854781304HZXFss7T)"}',
    ),
    "20261119095112854781304HZXFss7T",
  );
  assert.equal(
    extractRequestId(
      "unknown: The upstream response stream ended unexpectedly before completion. Retry the request; (request id: 3f9c-abc123)",
    ),
    "3f9c-abc123",
  );
  assert.equal(extractRequestId("503: overloaded"), undefined);
});

test("the diagnostics path honours PI_FLEET_RETRY_LOG and defaults to fleet state", () => {
  assert.equal(diagnosticLogPath(), path.join(DIAGNOSTICS_TMP, "retry-events.jsonl"));
  const saved = process.env.PI_FLEET_RETRY_LOG;
  delete process.env.PI_FLEET_RETRY_LOG;
  try {
    assert.match(
      diagnosticLogPath(),
      /[\\/]\.local[\\/]state[\\/]pi-fleet-retry[\\/]retry-events\.jsonl$/,
      "default path is the durable state directory",
    );
  } finally {
    if (saved === undefined) delete process.env.PI_FLEET_RETRY_LOG;
    else process.env.PI_FLEET_RETRY_LOG = saved;
  }
});

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

test("extension entry registers the durable hooks and rewrites only the gateway 403", () => {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const pi = {
    on(event: string, handler: (event: unknown) => unknown) {
      handlers[event] = handler;
    },
    // The diagnostics reader: one settings read per failed attempt, one name per record.
    getSettings: () => ({ retry: { enabled: true, maxRetries: 1_000_000_000, baseDelayMs: 10, maxAgentDelayMs: 40 } }),
    getSessionName: () => "test-session",
  };
  transientErrorRetry(pi as never);
  assert.deepEqual(
    Object.keys(handlers),
    ["session_start", "message_end", "agent_settled"],
    "three durable registrations, no timers",
  );

  const handler = handlers.message_end!;
  const promoted = handler({ message: errorMessage(RECORDED_403) }) as
    | { message: { errorMessage: string } }
    | undefined;
  assert.equal(promoted?.message.errorMessage, `server_error: ${RECORDED_403}`);

  assert.equal(handler({ message: errorMessage('403: {"message":"invalid api key"}') }), undefined);
  assert.equal(handler({ message: errorMessage(RECORDED_502) }), undefined);
  assert.equal(handler({ message: errorMessage(RECORDED_403, { stopReason: "stop" }) }), undefined);
});

// ---------------------------------------------------------------------------------------------
// swarm-0wg — a permanent provider answer must not be retried, and the demotion must be visible
// ---------------------------------------------------------------------------------------------

// The real bodies: the 503 is the one that spun the herdr-pi-update-check cron for a day, the
// 403 is relay.fast's source_disabled, and the 404 is the same class for a removed endpoint.
const PERMANENT_503_MODEL =
  '503: {"error":{"code":"model_not_found","message":"分组 provider:fxpayback 下模型 gpt-6.1-terra 无可用渠道 (request id: 202611252151112454798543OtorBmp)","type":"api_error"}}';
const PERMANENT_403_SOURCE =
  '403: {"error":{"code":"source_disabled","message":"The Kiro Pro source is turned off. Choose another source for this model, for your account or for this key."}}';
const PERMANENT_404_MODEL = '404: {"error":{"code":"not_found","message":"model gpt-6.1-terra does not exist"}}';
const TRANSIENT_503 = '503: {"error":{"code":"upstream_unavailable","message":"service temporarily unavailable"}}';
const TRANSIENT_429 = '429: {"error":{"code":"rate_limit_exceeded","message":"too many requests"}}';

const { classifyPermanentProviderError, terminalProviderErrorMessage } = (await import(
  "../src/transient-error-retry.ts"
)) as {
  classifyPermanentProviderError: (errorMessage: string) => string | undefined;
  terminalProviderErrorMessage: (errorClass: string, errorMessage: string) => string;
};

test("the permanent classes are recognised, and a plain throttle is not", () => {
  assert.equal(classifyPermanentProviderError(PERMANENT_503_MODEL), "model_not_found");
  assert.equal(classifyPermanentProviderError(PERMANENT_404_MODEL), "endpoint_not_found");
  assert.equal(classifyPermanentProviderError(PERMANENT_403_SOURCE), "source_disabled");
  assert.equal(classifyPermanentProviderError('401: {"error":{"message":"invalid api key"}}'), "credentials_rejected");
  assert.equal(classifyPermanentProviderError(TRANSIENT_429), undefined);
  assert.equal(classifyPermanentProviderError(TRANSIENT_503), undefined);
});

test("the terminal rendering carries none of the tokens pi reads as retryable", () => {
  for (const [errorClass, body] of [
    ["model_not_found", PERMANENT_503_MODEL],
    ["source_disabled", PERMANENT_403_SOURCE],
    ["endpoint_not_found", PERMANENT_404_MODEL],
    ["credentials_rejected", '401: {"error":{"message":"invalid api key"}}'],
  ] as const) {
    const terminal = terminalProviderErrorMessage(errorClass, body);
    assert.equal(
      isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: terminal, content: [] }),
      false,
      `${errorClass}: the terminal message must not be retryable: ${terminal}`,
    );
    assert.match(terminal, /terminal_provider_error/);
    if (extractRequestId(body)) assert.ok(terminal.includes(extractRequestId(body)!), "request id survives");
  }
});

test("a permanent answer is demoted by the handler, and the provider text is kept", () => {
  // The defect, proven on the installed classifier: pi WOULD retry this body forever.
  assert.equal(
    isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: PERMANENT_503_MODEL, content: [] }),
    true,
    "precondition: the dead-model body is retryable before the hook acts",
  );

  const handlers: Record<string, (event: unknown) => unknown> = {};
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: unknown) => unknown) {
      handlers[event] = handler;
    },
    getSettings: () => ({ retry: { enabled: true, maxRetries: 1_000_000_000, baseDelayMs: 10, maxAgentDelayMs: 40 } }),
    getSessionName: () => "test-session",
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  };
  transientErrorRetry(pi as never);
  const handler = handlers.message_end!;

  const demoted = handler({ message: errorMessage(PERMANENT_503_MODEL) }) as
    | { message: { errorMessage: string } }
    | undefined;
  assert.ok(demoted, "the handler must replace a permanent error");
  assert.match(demoted!.message.errorMessage, /^terminal_provider_error: model_not_found/);
  assert.equal(
    isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: demoted!.message.errorMessage, content: [] }),
    false,
    "the replacement must settle the turn",
  );
  assert.deepEqual(entries.map((entry) => entry.type), ["fleet-terminal-provider-error"]);
  assert.equal((entries[0].data as { providerText: string }).providerText, PERMANENT_503_MODEL);
  assert.equal((entries[0].data as { class: string }).class, "model_not_found");

  // A throttle and a plain upstream 503 keep retrying: the demotion is not a blanket "any 5xx".
  assert.equal(handler({ message: errorMessage(TRANSIENT_429) }), undefined);
  assert.equal(handler({ message: errorMessage(TRANSIENT_503) }), undefined);
  assert.equal(entries.length, 1, "no terminal entry for the retryable families");
});

