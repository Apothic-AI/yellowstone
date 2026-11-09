# Assistant space

What is in this file is true for **every** lane in this directory — the leader and every worker
it spawns. Anything that belongs to one role is not here: it lives in `.pi/modes/`, which is
cwd-scoped, and a lane receives only the definitions it was launched with.

| Lane | Launch | Gets |
|---|---|---|
| leader | `PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `leader` contract **composed with** `.pi/modes/leader.json` |
| worker | `PI_MODE=worker PI_PROFILE=worker PI_MODE_CONFIRM_PROJECT=1 pil` | the fleet `worker` contract **composed with** `.pi/modes/worker.json` |

A file in `.pi/modes/` whose key matches a fleet mode and whose `promptStrategy` is `append`
**composes** with it: the fleet text first, then the space text, resolved as one definition. A
`replace` shadows deliberately, which is the wrong tool here — it drops the fleet contract the
lane is supposed to keep. The project half is used only once confirmed, so the confirmation flag
is part of the launch, not an option.

## Degraded start

The space half of a lane's prompt comes from `.pi/modes/`, and it opens with these exact
sentences:

> You are the leader lane of this space, and the only lane here that exists for the operator.
>
> You are a worker in the operator's assistant space.

If your prompt lacks the sentence for your role, the space half was dropped: you are running on
the **native** prompt with no role contract at all, not on the fleet half alone. Confirm it from
artifacts before reporting it — the launch's stderr, and the session's **system record**, whose
`sections` object (`preamble`, `addendum`, `project_context`, `skills`, `cwd`) either carries the
sentence or does not. **Do not grep the session file for it:** that matches your own brief, your own
greps and any summary, so it reports hits even when the composition dropped. The recorded digest is
stronger and needs no reading at all — `pi-modes state <session> --json` → `verdict: match`. Then say
so in your first turn and ask for a relaunch carrying `PI_MODE_CONFIRM_PROJECT=1`.

## Verification

Never report unverified success. A lane's report is `reported`; only a file, a commit, a test
count or a live read makes it `verified`.

The `verify-space-split.py` gate's preservation check is exact substring **by design**: an
original sentence whose wording changed, even when the rule survives in a mode file, is reported
as an ORPHAN. Its orphan count therefore measures wording drift, not lost rules — this space
carries eight, all accounted for, several of them deliberately reworded.