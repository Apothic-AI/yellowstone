# pi-fleet-hooks

Two hooks that make fleet rules structural instead of advisory. They enforce
contract clauses that otherwise live only as prose in an `AGENTS.md`, where a
model has to remember them under pressure.

## `nonblock` — deflect the blocking form of a wait

A single-conversational-intake orchestrator must be reachable at every instant: a
call that holds the turn queues the operator's next message behind it. The
blocking forms are the *diligent-sounding* ones — `jobs action='attach'` reads as
"I will wait for the report" — which is why they get used at all.

`tool_call` may mutate `event.input` in place, so the fix is a rewrite rather
than a lecture:

| Blocking form | Rewritten to |
| --- | --- |
| `jobs attach` | `jobs output` (read the tail, come back later) |

The one case that cannot be rewritten into something useful is refused outright.

## `transient-error-retry` — recover runs from unmapped stream drops

Pi auto-retries assistant errors its own classifier accepts, but some gateways
report transient stream drops with a code that matches nothing in Pi's patterns.
The run then settles immediately and the agent appears to die until a human
nudges it.

This hook reclassifies only that family of messages as `server_error:` — a code
Pi already retries — so the normal retry machinery handles it: configured
backoff, retry spinners, `auto_retry` events, and omission of failed attempts
from the model projection.

## Install

From a local checkout, so the source of truth is the working tree:

```sh
pi install /path/to/pi-fleet-hooks
```

Each hook loads independently. Both are best-effort: a failure to classify or
rewrite leaves the original call untouched rather than blocking the turn.

## Not here

`herdr-agent-state.ts` deliberately stays a loose file in the agent's
`extensions/` directory. It is installed and overwritten by herdr's own
integration, gated on `HERDR_INTEGRATION_VERSION`, so vendoring it here would
desynchronise it from the integration that owns it.