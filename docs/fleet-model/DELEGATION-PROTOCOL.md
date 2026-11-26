# Delegation protocol — fleet progress, space work, and the handoff

Settles FT-72. Written 2026-11-17 by the worker `si-ft72-prompt`, against the operator's notes of
2026-11-16/17, which are newer than the item body and override it where they differ.

**What this governs.** Any request that crosses a space boundary: the fleet-progress lane (the
"overlord" — the `overlord` lane at
`~/.overlord`) asking another space to do something, a leader handing work to another leader,
and the sender's question of whether it landed.

**Where the rule is enforced, as opposed to recorded.** The prose that actually reaches a lane is
in the mode files, not here:

| File | Scope | Carries |
|---|---|---|
| `~/.pi/agent/modes/leader.json` (§ *Work that belongs to another space*) | every leader lane | remit line, routing cases, record rule, verification ladder |
| `~/.pi/agent/modes/worker.json` | every worker lane | the worker's no-crossing line |
| `~/Documents/Fleet/.pi/modes/leader.json` (§ *What you do not do*) | this space's leader | reach-in boundary: fleet fault yes, a role in the space's work no |
| `~/Documents/Fleet/AGENTS.md` (§ Conventions) | every lane in this space | pointer to this document |

This file is the reasoning, the evidence and the audit; the mode files are the contract.

## The operator's rulings (settled — do not re-litigate)

1. **Cross-space work is delegated leader-to-leader, as intent plus requirements.** No method
   attached. One message is the handoff. Settled 2026-11-16; already encoded.
2. **The handoff stays a DM.** It may *also* be a bead, depending on what is being handed off
   (below).
3. **No agent reads another agent's screen to verify receipt.** Receivers reply; check pi-rooms for
   a read-receipt capability (result in §4 — the capability is half there, and FT-79 asks the
   operator what to do about the missing half).
4. **The fleet-progress lane may reach into any space to resolve a fleet operational issue, but
   must not assume a leadership or worker role in the space's work.**

## 1. The line: whose work is it, and where does a fleet-progress lane stop

The dividing fact is **pipeline versus content**. A lane whose remit is that lanes keep moving owns
whether work is moving; the space that owns the work owns what the work is.

| Question | In the fleet-progress lane's remit | Out of it |
|---|---|---|
| Did the handoff arrive? | queue age, `deliveredAt`, a re-send | — |
| Is the lane moving? | alive / wedged / held, status transitions, whether its session recorded a turn since the handoff | whether the turns are any good |
| Did a fleet change reach every lane it touches? | reload, relaunch, mode composition, package set, reapproval | the code the change touches |
| Is a shared resource healthy? | Dolt, herdr, disk, provider and credential *routing* | the space's deploy, its data model, its paid actions |
| What should the space do next? | — | anything the space's leader has not reported itself |

**Chasing a stalled handoff is in remit. Reviewing its content is not.** The two questions are
separable and the separation is mechanical: the first is answered by a receipt file and a lane
state, the second only by reading the work.

### Two failure signatures, both readable from records

**A stalled lane** — any one of:

- a handoff whose receipt has `queuedAt` and no `deliveredAt`, while the recipient lane is live
  (§4 has the read); the common cause is the recipient's session not running the pi-rooms watcher,
  not a lost message;
- a lane `DOWN` **with** a recorded session — supervision's job, not a human's, and not a reason to
  do the work yourself;
- a lane holding an accepted handoff whose `state_change_seq` has not advanced across successive
  reads, with no `blocked` note.

The response to all three is **recovery or re-send**: restart the lane through the sanctioned path,
fix the name or the watcher, or send the handoff again. It is never "so I did it".

**An over-reaching fleet-progress lane** — any one of:

- it can state the other space's next step in more detail than that space's own report did;
- its session record contains a tool call whose target is inside the other space's root — a write
  to its repo, a `herdr agent prompt` or spawn in its workspace, an edit to its config or beads —
  that is not a fleet operational repair;
- its handoff carries a method the receiver did not ask for: numbered steps, a file to keep, a
  sequence to follow.

The third is checkable without reading anything of the receiver's: it is a property of the message
the sender wrote.

### What "reach in for a fleet operational issue" means exactly

Allowed, in any space, without asking: reload a lane; relaunch or migrate a lane through the
sanctioned tools; repair a mode composition or reapprove a mode file it changed; recover a wedged
process by targeted pid; fix a name, a pin, a session pointer; restore a shared resource (Dolt,
herdr server, disk, provider routing); read state with `behold roster` or the session files.

Forbidden, in every space: taking the space's work; seating an agent of yours in its panes; writing
its repo; choosing its sequence; closing or restructuring its beads; giving its leader a plan.

The distinction is the verb: **repairing the machinery a space runs on is not deciding what the
space builds.** Where a repair needs a decision that is the space's (which branch to keep, what to
ship), it stops being operational and goes back to that space's leader as intent.

## 2. Leader-to-leader is the norm; when routing through the fleet-progress lane is correct

Default: **leader → leader, one message, intent plus requirements.** The receiving leader owns
lanes, worktrees, tooling and sequence, and reports a disposition — not a plan for approval.

Route through the fleet-progress lane **only** when a fleet-wide reason exists, and then the routed
message *is* the handoff: do not also send your own copy (that is the duplication the settled rule
forbids).

| Case | Why the hop is correct | What the router adds |
|---|---|---|
| **Fleet-wide conflict** — two spaces' changes touch one shared surface where order matters (the herdr binary, the pi version and its package set, a provider config, the Dolt server, a mirrored skill) | the two leaders cannot see each other's ordering constraint | one agreed order, published to both |
| **A resource two spaces share** — a port, a paid account or quota, one build server, a lock, a worktree root | the conflict is real and neither space can grant it alone | the allocation, and who holds it |
| **An operator hold or a human gate** — a lane excluded from supervision, a reserved tab, a pending ask | the hold is fleet state that neither leader owns | the hold's scope, and its release |
| **An address that cannot be resolved** — nobody can name the receiving space's leader, or the lane is retired | the sender cannot deliver | the address, then it is leader-to-leader again, one hop |

Explicitly **not** reasons: visibility or a cc; the router asked first; a technical disagreement
two leaders can settle themselves; a handoff the router already made; a deliverable the sender
wants to watch.

## 3. The record: the DM is the handoff; a bead when the handoff is work

**The DM is the record of the handoff, and it survives a lane being down.** pi-rooms queues a direct
message without expiry, bounce or deletion, and the recipient's session drains its inbox on
`session_start` (`~/. pi/agent/rooms/inbox` → `pi.sendMessage`, `index.ts:634-638`, flush at
`index.ts:425-479`). So the concern in the item — *a resumed leader cannot find work it was given
while it was down* — is answered for the message itself: the queue is the store, and a lane that
comes back receives it.

**A bead when the handoff asks for durable work.** The DM is a message; it is not a work item. It
does not appear in `bd ready`, carries no dependency, no owner and no close reason. So:

| Handoff | Record |
|---|---|
| a question, an FYI, a status change, a one-turn ask | the DM, and nothing else |
| work that survives the session — a change to land, something another lane may need to see, anything with a blocker | the DM **plus** a bead |
| a handoff whose whole record is an artifact (a mapping, a report) | the DM plus the artifact path; a bead only if follow-up work remains |

**Who creates it: the receiver, in the receiver's own epic.** This is forced by the fleet's beads
layout, not a preference: one shared database, one epic per space, and each space's leader is that
epic's only writer. A sender creating a bead in another space's epic breaks single-writer
ownership; a sender creating one in its *own* epic makes a bead whose work it does not do. So the
sender sends intent, the receiver creates the bead and replies with the id, and the id travels back
in the DM. That also matches beads' own coordination guidance — assign or claim so every issue has
one owner, document handoffs in comments, and carry the `bead_id` in coordination messages
(`beads.gascity.com/multi-agent/coordination`, read 2026-11-17).

**Not a record:** a bead in the sender's epic for the receiver's work; a file under
`~/.local/state/<space>/` as the only trace (nobody's `bd ready` reads it); a leader's private task
list; a note in a conversation that no lane will resume.

## 4. Verification: receipt and disposition, never a screen

The sender's ladder, in order, and it stops at the first rung that answers:

1. **Send.** `rooms_dm` reports `queued` — the recipient's inbox accepted it. That is the handoff's
   state and it needs no follow-up.
2. **Delivery, if the question is "did it land".** Read the receipt:
   `~/.pi/agent/rooms/receipts/<message-id>/<recipient>.json`. Observed on this machine
   (`06ad3161-dbb8-4f70-aee6-ee2007e37654` → `self-improvement-leader.json`):
   `queuedAt 13:11:43.139Z`, `injectedAt 13:11:43.195Z`, `deliveredAt 13:11:43.269Z` — the handoff
   took 130 ms and the receipt says so. `deliveredAt` means *the recipient's session was handed the
   message*. It does not mean read, and it does not mean understood.
3. **Disposition, for "did it land and what happened".** The receiver's own reply, carrying an
   artifact: a bead id, a commit, a path, a test count. That is the only evidence the work exists.
4. **Escalate a rung-2 failure as an operational fault.** No `deliveredAt` with a live lane, or a
   lane `DOWN` with a session id, goes to the sanctioned recovery path (§1). Do not re-send in a
   loop, and do not take the work.
5. **Never**: `herdr agent read` on the receiver (a screen read is not read-only — it scrolls the
   pane), re-deriving the receiver's work to check it, or asking the receiver for a plan to approve.

### What pi-rooms actually has (the operator's question, investigated)

The operator's memory was half right, and the halves matter:

- **Exists:** per-recipient delivery receipts with `queuedAt`, `deliveredAt`, `injectedAt`, written
  under a lock so a delivered message cannot read as forever-queued
  (`src/pi-extensions/pi-rooms/src/store.ts:100-110,514-546`, `index.ts:465-472`).
- **Exists:** the sender is told the receipt **path** in the `rooms_dm` reply
  (`index.ts:872`), so the fact is reachable by reading a file.
- **Does not exist:** any tool that *reads* a receipt by message id. `rooms_receipts` has one
  action, `consolidate`, and it is maintenance only (`index.ts:813-836`; README §Delivery status).
- **Does not exist, deliberately:** a read or acknowledged state. The extension cannot see what a
  model does with a message after handoff, and its README says a receipt claiming more than it
  observed would be worse than no receipt.

So the useful gap is narrow and real: **delivery status is recorded but not exposed**, and an agent
checking a handoff has to know a filesystem path to see it. FT-79 (filed with this work) asks the
operator whether to add a read-only `rooms_receipts({action:"status", id})`, and argues that "read"
must stay out regardless.

## 5. Prompt consistency audit

Every mode file and `AGENTS.md` on the machine that a fleet lane can load, checked for text that
implies the fleet-progress lane may reach into a space, or a leader may seat agents in another
space's panes. Read-only where the file belongs to another space.

| File | Finding | Action |
|---|---|---|
| `~/.pi/agent/modes/leader.json` | the cross-space section was correct but silent on remit, routing, record and verification | **edited** (§1–§4 folded in) |
| `~/Documents/Fleet/.pi/modes/leader.json` | "do not do a project space's work … do not put workers into it" — no statement of what reach-in *is* allowed | **edited** (reach-in boundary added) |
| `~/.pi/agent/modes/worker.json` | no cross-space rule at all; a worker could be briefed into one | **edited** (one line) |
| `~/Documents/Fleet/.pi/modes/worker.json` | already forbids messaging another space's lane and creating lanes | no change |
| `~/AGENTS.md` | role-neutral by design; the only cross-space sentence is "if you race another project's agent for a resource, message that orchestrator" — compatible | no change |
| `~/Documents/Fleet/AGENTS.md` | conventions cover reload, supervision and backchannels; no reach language | **edited** (pointer to this document) |
| `~/.overlord/AGENTS.md` | "Never write a project repo, run infrastructure, or act on a paid resource by hand" — the sentence reads wider than the rule: running *fleet* infrastructure is exactly what this lane does | **not edited** (another space's contract); the intended reading is recorded in §1, and its owner may add a pointer |
| `~/.overlord/.pi/modes/leader.json`, `worker.json` | no reach language beyond the above | no change |
| `~/Documents/Assistant`, `Comms`, `Personal`, `ChatGPT Accounts`, `Gemini-Accounts`, `Articles`, `sub2api`, `Clothes-For-Sterling`, `Code/yellowstone` `AGENTS.md` | no text about reaching into spaces or seating agents in them | no change |
| `~/.agents/skills/pi-rooms-protocol/SKILL.md` | already states the two delivery states and that there is no ack | no change |
| `~/.agents/skills/lane-identity/SKILL.md` | naming only | no change |

**The edit cost is stated, not hidden.** A mode-file edit changes the definition digest, and under
`driftPolicy: block` a lane whose digest changed loses its whole composition (including its space
half) until it re-approves. Measured before the edit with
`~/.overlord/tools/mode-composed-digest.mjs`: global leader `0733ae97…a8ff4d`, Fleet leader
`1c7a61ab…e9fb30`, Fleet worker `f4212325…974dd6`. After the edit the leader digest changes and the
worker digest does not — see `EXECUTION-RECORD.md` for the after values and the reapproval sweep
this implies (21 leader lanes live at the time of writing, from `behold roster` `L-1=leader`).

## Worked example: FT-70 read back against this protocol

**What happened.** Delegating FT-70 (behold coverage for the TUI scrapers), the fleet-progress lane
spawned a worker directly into the yellowstone space. The operator stopped it and said the work
belongs to that space's leader as intent plus requirements. Delegated that way, `yellowstone-leader`
produced its own 37,078-byte mapping (`~/.local/state/yellowstone/ft70/mapping.md`, 2026-11-16
22:25) and chose its own sequence — which is the evidence that the route, not just the outcome,
was the thing that mattered.

**The gate this protocol puts in front of that spawn**, in order:

1. *Whose work is it?* The repo is `~/Code/yellowstone`, the lane is in workspace `w17`, the release
   is that space's. Not the sender's.
2. *Is it mine?* No. → hand off intent and requirements, one DM. **Never spawn there.** This is
   where the stopped spawn dies: a lane in another space's workspace is that space's topology and
   that space's seats, regardless of who types the `herdr` command.
3. *Is a fleet-wide reason present?* No — no shared-surface ordering conflict, no shared resource,
   no hold, and `yellowstone-leader` is addressable and alive. → direct, leader-to-leader. Routing
   it through the fleet-progress lane anyway would be the duplication §2 forbids.
4. *Does it ask for durable work?* Yes — a multi-part deliverable with follow-ups. → the receiving
   leader creates the bead in its own epic and replies with the id.
5. *How is it verified?* Receipt `deliveredAt` for "it landed", `yellowstone-leader`'s disposition
   plus the mapping path for "it exists". Never a screen read, never a re-derivation of the mapping.

The rule would have prevented the stopped spawn at step 2, which is the cheapest place to prevent
it: before any `herdr` call exists.

## What this protocol does not settle

- Whether pi-rooms should expose delivery status as a tool (FT-79, operator's call).
- Whether the fleet-progress lane's own contract should be split from the leader contract. This
  document assumes the same lane, as the item does.
