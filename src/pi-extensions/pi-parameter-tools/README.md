# pi-parameter-tools

Set the model and the thinking level of a pi session.

Four tools:

| Tool | What it changes |
|---|---|
| `set_own_thinking` | the calling agent's thinking/reasoning effort |
| `set_own_model` | the calling agent's provider/model |
| `set_session_thinking` | the thinking/reasoning effort of an explicitly identified pi session |
| `set_session_model` | the provider/model of an explicitly identified pi session |

The own tools act on the caller's own session, in the caller's own process, through pi's own
session-control methods (`pi.setModel`, `pi.setThinkingLevel`).

The session-targeted tools act on a session the caller **names**: a session id **and** one
unambiguous binding — a session file path, or a herdr lane. A session id alone is never
enough (ids can repeat across session files), and two bindings at once are a conflict, not
a preference.

## How a session-targeted change reaches its target

This is the part to read before using the session-targeted tools.

**pi exposes session control to the process that owns the session.** The ExtensionAPI's
`setModel` / `getThinkingLevel` / `setThinkingLevel` act on the session the extension is
running in. The RPC mode (`pi --mode rpc`) has the same commands — `set_model`,
`set_thinking_level`, `get_state` — but its channel is the **parent's**: the parent of an
RPC-mode child talks to it over that child's stdin. There is no attach path, no socket, no
listener and no cross-process session control in pi.

So this package brings its own, small, local one:

* the **receiver** — this same package, loaded in the target lane. It listens on a local
  socket, checks that the request really names *its* session, and applies the change with
  **its own** pi setters. The target session is written by the process that owns it.
* the **channel** — a UNIX socket whose path is derived from the target's session id
  **and** its session file (`sha256(id \0 normalised file)`, first 16 hex characters),
  under `$XDG_RUNTIME_DIR/pi-parameter-tools` (or the temporary directory), in a `0700`
  directory, with the socket itself `0600`. Both sides derive the same path from the
  same pair: there is no registry, no token, no grant file, and no directory to
  enumerate.

The request carries the caller's binding — the session id and the session file — and the
target checks both against its own identity before it changes anything.

### Who owns the socket

The socket's name is the pair (id, file), and the pair is the session: a copied session
file keeps the header's id, so two different sessions can carry the same id, and one id
is not an identity.

The receiver listens on a **private** path and publishes the shared name as a symlink to
it. Node removes the socket it created when the server closes — by name, and
unconditionally — so a receiver that listened on the shared name itself would remove
whatever was at that name, including a socket another owner had taken over. On a private
path the close removes the receiver's own socket and nothing else, and the shared name is
removed only while it still points at that receiver.

* A name that already has a listener is **taken over**: the pair names one session, and
  the process that most recently took that session file is the one that answers for it.
  The previous owner keeps its own socket, and its later shutdown cannot take the name
  back.
* A name left behind by a process that died — a file with no listener — is **replaced**.
* A request that arrives while the receiver is closing is **answered**: closing stops
  new connections, it does not cut off the one that is already running.

The receiver follows the session. It starts with the session and closes with it: `/new`
and `/resume` give the session a new id and file, the receiver moves to the new pair,
and the old name goes with the old session. `/reload` runs the extension again, so the
receiver behind the name is a new one, at the same name.

| Target | What happens |
|---|---|
| the caller's own session, addressed explicitly by id and file | changed in this process, by pi's own setter |
| a session running in **another** process, with this extension loaded | changed by **that** process, over the local socket; the answer is that process's own |
| a session running in another process **without** this extension | **refused** with `receiver_unavailable`; nothing is written |
| a session that is not running at all | **refused** with `receiver_unavailable`; nothing is written |

The refusal names the session that was identified and the reason. It is not a policy
decision, and it is not a quiet no-op.

**What this package deliberately does not do.** It does not open a second pi process on the
target's session file and call that a change to the target: that process is not the
target, and writing to a session file that a running lane owns makes two writers of one
session. It does not type into another pane's terminal, relay a slash command, edit
settings, or restart anything. The records are created by pi's own setter, inside a pi
process, for one named session.

## The order of operations for a session-targeted change

1. **Shape** — exactly one of `sessionPath` / `lane`. Both is `identity_binding_conflict`,
   neither is `identity_binding_required`.
2. **Grammar** — the session id, the path and the lane must look like what they claim to
   be, or the request is `invalid_identifier`.
3. **Resolution** — a lane is resolved to a session file with one herdr query
   (`herdr agent get <lane>`). A lane that is not a pi lane, is unknown, is ambiguous, or
   that herdr cannot answer for, is refused with its own code. A lane in a held or
   reserved place is refused (`held_lane`).
4. **Identity** — the named session file's own header must name that session id. A file
   that holds a different session is `session_id_mismatch`, and the duplicate-id case is
   closed here.
5. **Delivery** — the request goes to the target's receiver over the local socket. The
   target checks the binding again, against its own live identity: another session id is
   `session_id_mismatch`, another session file is `session_identity_mismatch`. A target
   that is not listening is `receiver_unavailable`; a target that does not answer in time
   is `target_timeout`.
6. **The change** — pi's own setter runs, in the process that owns the session.
7. **The report** — the before and after state, the records the session gained, and
   whether the change landed. The report is the target's own, not the caller's guess.

## What the result says

Every call returns the same envelope, whether it changed something or refused:

```jsonc
{
  "ok": true,
  "tool": "set_session_thinking",
  "target": {
    "kind": "session",
    "sessionId": "…", "sessionPath": "…",
    "requested": { "sessionId": "…", "sessionPath": "…" },
    "resolution": { "source": "receiver" }
  },
  "model":    { "before": {…}, "requested": null, "after": {…} },
  "thinking": { "before": "off", "requested": "high", "after": "high", "supported": ["off","low","medium","high"] },
  "applied": "thinking",        // model | thinking | both | none | unknown
  "changed": true,
  "records": { "modelChangeEntryId": null, "thinkingLevelEntryId": "a1b2c3d4" },
  "disk": { "state": "unknown" },
  "effective": "next_request",
  "partial": false,
  "warnings": []
}
```

`resolution.source` says how the target was reached: `in_memory` for the caller's own
session, `session_file` or `lane` for the binding that was resolved, and `receiver` when
the target's own process made the change.

**Records, disk and durability are three different things.** `records` is the id of the
session entry pi wrote (observed, or null when no entry was seen). `disk.state` is
`unknown` or `not_applicable` and is never `written`: an extension cannot prove that a
session file reached the disk. **Durability is never claimed.** A change takes effect on
the **next request**, not in the middle of the current one.

`applied` is a comparison of the values before and after the attempt, never a count of
records. `partial` is true when the memory changed but the expected record was not seen.

## Refusal codes

`invalid_identifier`, `invalid_level`, `level_unsupported`, `no_model_selected`,
`model_unknown`, `auth_missing`, `identity_binding_required`, `identity_binding_conflict`,
`no_session_file`, `session_id_mismatch`, `session_identity_mismatch`, `held_lane`,
`receiver_unavailable`, `target_timeout`, `target_unreachable`, `target_protocol_error`,
`target_session_unresolvable`, `target_lane_unknown`, `target_not_pi`, `target_ambiguous`,
`lane_targets_other_session`, `herdr_absent`, `herdr_not_managed`, `herdr_unavailable`,
`herdr_api_failure`, `apply_failed`, `partial_apply`.

The delivery codes, and what they mean:

| Code | Meaning |
|---|---|
| `receiver_unavailable` | nothing is listening on the target's socket: the target is not running, or it runs without this extension |
| `target_timeout` | the target accepted the request and did not answer within the deadline |
| `target_unreachable` | the target could not be reached, or closed the connection |
| `target_protocol_error` | the target answered with something this build cannot read |
| `held_lane` | the target is in a held or reserved place |

## The fleet's holds

Behold holds a workspace and reserves a tab and a pane. Those ids are in this package too
(`src/holds.ts`): a lane in a held place does not change its own parameters, a request
that names a held lane is refused, and the **receiver** refuses a request for a session
that lives in a held place — whoever asks.

## What this package does not do

* **No pty, no keystrokes, no slash-command relay.** A target is never driven by typing
  into its terminal.
* **No second writer on a session file.** No process is started on a target's session
  file, and no session file is written by hand. The target's own process writes it.
* **No settings edits, no restarts, no relaunch commands.** The tool changes the
  parameter; it does not change the process.
* **No separate daemon, no mailbox, no watcher, no timer.** The receiver lives inside the
  target's pi process and goes with it; every call is one operation.
* **No provider calls.** Setting a model is not a completion; nothing here talks to a
  provider beyond the local credential check pi itself performs.

## Known limitations

* **The target must be running, with this extension loaded.** Otherwise the request is
  refused (`receiver_unavailable`) and nothing is written. This package cannot start a
  lane, and will not.
* **The channel is per-user.** A session belonging to another user's account is not
  reachable, and is not attempted.
* **The channel is unauthenticated.** Any process running as the same user that knows a
  session's id and file can ask that session to change its parameters: the request is
  checked against the *target's* identity, not against the caller's. There is no token
  and no grant file, because this package was asked for no security tier, and a token
  would be a second secret to keep. The boundary that **is** enforced is the fleet's
  holds — a session in a held place refuses every request, whoever asks.
* **The map of lanes is only as fresh as herdr.** A lane binding resolves through
  `herdr agent get`; a lane that has just been renamed may not resolve.
* **Handler errors are not observable.** pi routes a throwing `model_select` or
  `thinking_level_select` handler to a host-only channel; the ExtensionAPI exposes no
  subscription for it. A successful change is reported as successful.
* **Durability is not proven**, only observed as a session record.
* **The change lands on the next request**, not in the middle of the current one.

## Tests

```bash
npm run check        # typecheck + lint + tests
bun test             # the tests alone
```

The unit tests drive injected collaborators — no process, no provider, no network. They
cover the channel (where the socket is, what the request carries, what the caller is
told when the other end is gone, busy, or speaks nonsense, and **which** session a
request reaches) and the receiver (what it applies, and what it refuses).

The integration test opens **real disposable pi sessions** in a temporary directory, each
with this extension loaded, so each one runs its own receiver. Among them are two
sessions that carry the **same id** on **different files**, and a session that is put
through `/new`, `/resume` and `/reload`: a change aimed at one of the two is checked to
land in the process that holds that file — the running session's own state, and the
file's own bytes — and not in the other one, and the receiver is checked to follow the
session through the three. The caller is a real pi as
well: a temporary driver extension registers a command that calls the same function the
tool calls, and the test drives that command over pi's own control channel. A slash
command runs in-process, so no provider is called. The test then checks the property that
matters: a change aimed at one session changes that session and leaves the caller's and
the unrelated session's state and files untouched — and a change that cannot be made is
refused, with nothing written anywhere.

**The fixture is hermetic, and it has to be.** Each child pi gets its own home, its own
pi configuration directory (`PI_CODING_AGENT_DIR`), its own session store and its own
runtime directory, and it inherits nothing but `PATH` from the test process: no operator
settings, no operator model catalog, no ambient credential. The configuration holds one
**fake** provider with two fake models and a literal key that is not a credential, and the
provider's base url points at a local server that records every request.

That is not decoration. A fixture that inherits the machine's configuration inherits the
machine's *baseline*: pi maps a session's saved thinking level through the current
model's thinking-level map, so a session that saved `off` starts at whatever level that
model supports — `low` on one machine, `off` on another. The test then asserts a value
it does not control. With the isolated configuration the model is the fixture's, the
baseline is the fixture's, and the assertion is about the fixture.

It also means **a real model change can be proven without a live credential and without
a provider call**. pi's own `setModel` refuses a provider it has no credential for, but
the credential check is a *local* one: a provider configured with a literal key counts as
configured, and selecting a model is not a completion. So the model change in the test is
a real change, made by the target's own process, recorded in the target's own session
file — with a key that is not a key, and with a base url that was never called. The test
asserts that the base url received no request at all.

## Install

```bash
pi -e npm:@arhen/pi-add-parameter-tools      # try it
pi install npm:@arhen/pi-add-parameter-tools  # keep it
```

## License

MIT
