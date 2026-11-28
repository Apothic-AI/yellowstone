---
name: fleet-maintenance-pause
description: Stop a fleet lane mid-turn for harness work that cannot land otherwise — a changed mode file that has to be re-approved, a reload that must be one motion with its edit, a restart for a package set or an environment — then restore the lane exactly. Snapshot before, verify after, coordinate with overlord. Use when a mode edit, reload, or relaunch needs a working lane stopped first, or when restoring lanes after maintenance.
---

# Fleet maintenance pause — stopping a lane mid-turn

This space owns the harness, and some harness work cannot land without
stopping a lane mid-turn: a changed mode file that has to be re-approved, a
reload that must be one motion with its edit, a restart for a package set or
an environment. The standing grant from the operator is: pause **any or all
eligible lanes the work actually needs, without asking the operator first**,
and put every one of them back afterwards. Prefer a lane's own stop boundary
when it is already at hand; when the work needs the lane stopped, do not wait
indefinitely for idle.

The mandate to pause a lane is shared with overlord. This procedure is the
harness lane's — snapshot before, verify after, coordinate with overlord —
and it is not in `AGENTS.md`, not in `worker.json`, and not in another
space's mode, so no worker and no other leader inherits the procedure.

## A pause is a control action, not a message

An ordinary prose prompt is not a pause: it queues as a user message and the
lane acts on it after its next tool call; on a goal lane it pauses the goal
as a side effect. A necessary interruption uses the maintenance controls
already validated for this fleet — the worked path is
`~/.overlord/tools/reload-fleet --interrupt-working` (Esc, wait for idle,
act, resume; see the `overlord-operations` skill), with `keepalive-hold`
pausing lane supervision for the window so the timer does not resume a lane
between your stop and your start. The procedures and receipts for those
controls belong in the maintenance artifacts, not in this rule.

## Coordinate the window with overlord first

Coordinate the window with overlord by room message or queued note before
the first pause: it drives fleet lanes too. That is coordination, not a
second approval.

## Snapshot before, verify after — per lane

Before the first pause, record every affected lane's identity, its currently
selected session, its objective, goal queue and pause state, whether it is
active or settled, its profile and model, and the launch and config
provenance it runs under.

Afterwards verify that every affected lane is restored and every previously
active lane has resumed, with a per-lane receipt naming what actually
happened — a failure or an unrestored lane is part of the record, not a
footnote. A settled pane or a queued helper is not restoration.

Restore the selected session explicitly whenever a restart was needed, and
put back the objective and goal queue the lane held.

## The lines that do not move

- No `/new`, no replaced objective, no wiped queue, no profile or model
  change dressed up as maintenance, and no restart where a reload or a
  re-approval will carry the change.
- Reserved tabs stay excluded until the operator releases them.
- Paid resources, accounts, credentials, consents and authorization are
  exactly as untouchable as before.
- The maintenance gets no configuration authority beyond what it needs to
  land.
