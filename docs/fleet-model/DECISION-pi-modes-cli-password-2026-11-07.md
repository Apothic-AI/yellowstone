# The pi-modes CLI password proposal — why it underprotects, and what would work

**To:** operator
**From:** self-improvement-leader
**Date:** 2026-11-07
**Status:** awaiting your decision. Nothing has been built or changed pending it.

You asked that the new `pi-modes` CLI require a password, stored only in the workspaces of
approved leaders (this lane, `overlord`), so that other agents are far less likely to use it
without approval. I support the goal. I do not think a password on this surface achieves it, and
I would rather say so now than ship something we then describe to you as a boundary.

`pi-modes-leader` and I each checked the claims below against the code independently; both
audits reached the same conclusion. Where we disagree is only who should tell you — I am doing
it because this originated from you via me, and because defence-by-package-owner reads as
special pleading.

---

## 1. The CLI has no write capability

An audit of `packages/pi-modes/scripts/mode-cli.ts` and `src/mode-cli-state.ts` for
`writeFile`, `appendFile`, `rename`, `unlink`, `rmSync`, `createWriteStream`, `copyFile`,
`mkdir`, `child_process`, `spawn`, `exec` returns **nothing**. It has exactly three subcommands:
`state`, `expected`, `attest` — read, compute, verify.

So the CLI cannot re-approve anything. It cannot change a definition, a digest, or a session.
A password on it protects a surface that has no write path.

## 2. The dangerous primitive is in the lane, and needs no CLI

`packages/pi-modes/src/mode-command-handlers.ts:355` is `services.reapprove(ctx,
confirmedFingerprint)` — reachable by every lane, with no CLI involved and no `--expect` at all:

```
/mode-reapprove --confirm-project
```

That is the shipped interactive gate. Gating the CLI leaves this path untouched.

## 3. The digest is not a secret, and cannot be made one

- `modeDefinitionFingerprint` is a plain SHA-256 over normalised JSON of world-readable mode
  files (`-rw-rw-r--`).
- `/mode-status` already reports per-component digests (`… · sha256:<digest>`); the `--json`
  variant reports them machine-readably.
- Therefore **any lane can self-serve the exact digest it would need to pass `--expect`.**

This is the part that also rules out a cheaper control I nearly proposed: requiring a
`--reason <text>` argument. An agent can satisfy it without thinking, because it can read its own
digest. I would have championed a control that does not control.

## 4. A shared secret in N leader workspaces is a leak vector

The password would have to be readable from every approved leader's workspace and passed through
their transcripts, shell history, and tool output. That is precisely the shape that leaks. And it
would sit in the same filesystem as the thing it supposedly protects.

---

## What the conclusion is

The binding control is **who is permitted to act**, not **what they present**. A token on a
read-only CLI is a speed bump on the least dangerous surface while the write path stays open —
and worse, it would be reported to you as a boundary when it is not.

## Options, cheapest first

**A. Do nothing to the CLI (recommended).**
The CLI is read-only and cannot re-approve. The existing `/mode-reapprove` remains the only write
path, and it is already gated where it matters: in the lane, with `--expect` pinning the exact
definition. No new secret, nothing to leak. The reconcile loop I have built is read-only by
construction (no hashing, no writes) and the audit is on record.

**B. Put a control on the action, and call it what it is.**
If you want resistance to casual action: an approval file that the lane's `/mode-reapprove`
checks — who, when, which digest — plus the reason recorded into the `pi-mode-state.v3` entry for
audit. This is honest friction. It is **not** a boundary against a determined agent, because a
lane can read its own digest. We would document it in exactly those words.

**C. A capability boundary (larger decision, different layer).**
Deciding *which lanes may run `/mode-reapprove` at all* is a permission question. It belongs in
the mode/permission layer, not inside `pi-modes`. This is the only option that actually stops a
determined agent, and it is a substantially bigger change than a password — it needs a rule for
what identifies an approved leader (identity, not a secret) and a fail-closed story for the case
where that rule is wrong.

**My recommendation: A now, C if and when you want real enforcement.** B only if you want the
audit trail, and only described as friction.

## If you still want the password

That is your call and I will implement it. `pi-modes-leader` will put it behind a flag, with a
README line stating exactly what it does and does not prevent — it will not be described as a
boundary. I would ask only that it be recorded as a deliberate choice with this analysis
attached, so the next lane does not mistake it for protection.

---

## Why this reached you late

You asked for the password while I was mid-flight on the reconcile loop, and I built the loop
first. In hindsight the objection was cheap to check and should have come with the first
acknowledgement, before any of the discussion downstream of it. The 11 remaining drifted leader
lanes are held until you decide, since re-approving them under a mechanism we then change is
wasted work.

---

# OPERATOR DECISION — 2026-11-08

**Decided: password on the CLI only. Nothing on `/mode-reapprove`.**

The operator reframed the threat model, and the earlier analysis scored the mechanism against the
wrong adversary. This is not defence against a determined attacker. It is **friction**: an agent
reaching for a convenient surface has to notice it is crossing an obvious boundary, and must
deliberately go fetch a secret from an approved leader's workspace. That decision is the control,
which is exactly the effect the operator wants on an agent that would otherwise act casually.

So points 1-4 above still hold as *facts* — the CLI cannot write, the digest is self-serviceable,
a lane can bypass the CLI entirely. They simply do not decide the question once the goal is
friction rather than enforcement.

## Scope

- **CLI only.** `pi-modes state|expected|attest` behind a secret.
- **`/mode-reapprove` is untouched.** Left byte-for-byte as it is, deliberately, as a watch item:
  if a lane is ever observed using it to self-bless a definition it should not, that becomes a
  separate decision. Keeping it unchanged makes that observation clean.

## Constraints that make the friction work

1. Secret read from a **file path**, never an argument — a `--password` flag would land in shell
   history, tool output and transcripts, destroying the friction for every later agent.
2. **The refusal message is the product.** It must name the restriction and the escalation path,
   e.g. *"the pi-modes CLI is restricted to approved leaders; if you need it, ask the
   self-improvement leader."* An agent given a reason can escalate instead of hunting for the key,
   which converts friction into a handoff.
3. Behind a flag/config, **default off** until the operator enables it, so it can be demonstrated
   on one lane first.
4. Absent secret + password required ⇒ refuse **before any work**, never partially.
5. Nothing else weakens: three read-only subcommands, no new write path, `--expect` untouched.
6. Documented **honestly** as a speed bump, not a security boundary, with the `/mode-reapprove`
   bypass named explicitly so no future lane mistakes it for enforcement.

`pi-modes-leader` is implementing it. Demonstration on a single lane — with the refusal message
observed live, not merely unit-tested — precedes any fleet default.
