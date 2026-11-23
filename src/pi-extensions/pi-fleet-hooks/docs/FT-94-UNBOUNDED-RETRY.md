# FT-94 — transient failures retry without a count cutoff

Operator observation (Fleet TODOs.md FT-94): lanes die on

```
✕ Error · upstream first stream event timeout ×2
✕ Error · shared upstream overload retry stopped: context deadline exceeded (request id: 2026…m6aRMLUA)
✕ Error · routing retry budget expired before first protocol event (request id: 2026…HZXFss7T)
```

Desired: transient provider/connection failures retry **indefinitely** — exponential backoff,
~5-minute maximum interval, no finite retry-count or retry-budget cutoff, cancellable at all
times, permanent failures still fail fast, and every retry observable in a durable diagnostic.

## Where the turn actually ends

`pi-coding-agent` 1.5.0 `dist/core/agent-session.js`:

- `_willRetryAfterAgentEnd` (line ~812): refuses when `!settings.enabled || _retryAttempt >= settings.maxRetries`.
- `_prepareRetry` (line ~3108): `_retryAttempt++`, refuses when `> settings.maxRetries`, then
  sleeps `retryDelayMs(settings, _retryAttempt)` on an abortable controller.
- `_isRetryableError` (line ~3058): context-overflow guard, then pi-ai's
  `isRetryableAssistantError` — the same function this package's hook delegates to.

So the turn-ending budget is the **settings** value `retry.maxRetries`, and the interval cap is
`retry.maxAgentDelayMs`. The provider-level knobs (`retry.provider.*`) govern server-suggested
in-request retries, not the turn loop.

## What the fleet sets

`home/.pi/agent/settings.json`:

```json
"retry": { "enabled": true, "maxRetries": 1000000000, "baseDelayMs": 2000, "maxAgentDelayMs": 300000 }
```

`retryDelayMs` is overflow-safe, so the sequence is `2s, 4s, … 256s`, then `300s` from attempt 9
onward, forever. 10^9 attempts at the cap is ≈9,500 years — past every observable horizon, but
honestly: pi's setting is an integer, so a *literally* unbounded loop would need an upstream
change (e.g. `maxRetries: -1` meaning unbounded).

## Classification

`src/transient-error-retry.ts` rewrites the router give-up families into `server_error:` so
pi's own machinery retries them (attempt omission, spinners, `auto_retry` events all come free):

- `shared upstream overload retry stopped: context deadline exceeded`
- `routing retry budget expired before first protocol event`
- `upstream first stream event timeout` (pi-ai 1.5.0 already retries this — the hint is a
  fallback in case a later release narrows the list)

Permanent failures fail fast; the guards run after pi's own logic and only ever block
promotion: malformed requests (400/404/405/422, `invalid_request_error`, `malformed`, …),
invalid configuration (`model not found`, `invalid configuration`, `context length exceed`, …),
quota/billing (FT-75's existing guard), refusals, and explicit user cancellation. Real user
cancellation arrives as `stopReason: "aborted"`, which the handler never touches; the text
guard is the second line of defense. A 400 that *quotes* transient vocabulary is still
permanent — the guard wins over the hint.

## Diagnostics

Every scheduled retry and every chain end is appended to
`~/.local/state/pi-fleet-retry/retry-events.jsonl` (`PI_FLEET_RETRY_LOG` overrides), one JSON
object per line:

```json
{"ts":"2026-11-22T10:36:04.003Z","event":"retry_scheduled","attempt":1,"maxAttempts":1000000000,"delayMs":10,"reason":"server_error: 403: {\"message\":\"routing retry budget expired before first protocol event (request id: 2026…HZXFss7T)\"}","requestId":"2026…HZXFss7T","session":null}
{"ts":"2026-11-22T10:36:04.234Z","event":"recovered","attempts":6,"session":null}
```

`delayMs` is computed with pi's own exported `retryDelayMs` and the session's effective
settings — the same function and inputs `_prepareRetry` uses — and `retry_scheduled` is only
written when the budget will actually take the retry (a budget-exhausted failure is reported by
the terminal `settled` record instead, matching pi's increment-then-decrement). Terminal
events: `recovered`, `settled`, `aborted`. Write failures print to stderr; they never break a
turn.

## Jitter: not reachable at a fleet-owned seam

pi's `retryDelayMs` is deterministic; `grep -in jitter` over `pi-ai/dist/utils/retry.js` and
`agent-session.js` finds nothing. No extension hook sits between the delay computation and the
sleep: `auto_retry_start` goes to session listeners via `_emit` (not the extension event union),
`ExtensionAPI.getSettings()` returns a copy with no setter, and the provider knobs add no
jitter. A fleet extension therefore cannot perturb the actual sleep without patching the
dependency — which is out of scope here.

Minimal upstream change, when someone picks it up: add `jitterRatio` to `RetryPolicy` and

```js
const ratio = policy.jitterRatio ?? 0;
if (ratio > 0) return Math.max(1, Math.round(capped * (1 - ratio + Math.random() * 2 * ratio)));
```

to `retryDelayMs`, plus `jitterRatio: 0.25` in `SETTINGS_DEFAULTS.retry` and
`getRetrySettings()`. Until then lanes retry in lockstep under a synchronized gateway failure —
the exact failure mode jitter exists to prevent.

## Proof

`test/transient-error-retry-unbounded.test.ts` drives a real `AgentSession` (installed adapter,
injected fetch, throwaway agent dir, short injected backoff): six 403 routing-budget failures
then recovery → 7 requests, delays 10/20/40/40/40/40 logged and slept, request id in every
record, `recovered` disposition; `maxRetries: 3` control → 4 requests then settle; 400
malformed → 1 request, no retries; abort mid-backoff → prompt ends in < 2 s, no further
request, `aborted` record. See the FT-94 receipt under `~/.local/state/yellowstone/ft94/retry/`.
