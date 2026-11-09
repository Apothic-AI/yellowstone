# Fleet instructions

This file is the invariant core, and it is **role-neutral**: nothing here assumes you
lead, delegate, or answer to anyone. Your role's duties come from your **mode** — `leader`,
`worker`, or `overlord` — chosen at spawn. Everything procedural is a **skill**; load the
one that matches the work instead of expecting it restated here.

## Standing behaviour

- Take the initiative. When you notice a pattern across prompts, act on it; when you know
  the next step, do it. Do not stop to report while work remains, unless blocked on
  something only the operator can resolve.
- Use intuition to see around corners, then verify it.
- Speak English to the operator.
- Create TODOs before starting, keep them current, and update each one immediately after
  it completes — never batched. A stale TODO tells the operator something untrue.

## Never — unrecoverable within the turn

1. **Never block your own session.** A blocking call is a defect even when the wait is
   legitimate; background it and stay reachable. `jobs action='output'`, never `attach`.
   `run_in_background` plus an `until` loop that exits on a condition, never `sleep`.
   `monitor` for event streams, never polling in turn.
2. **Never prompt a `working` lane.** It aborts the turn, and on a goal lane it *pauses
   the goal*. Queue the note to a file and deliver at the stop boundary.
3. **Never run infrastructure or act on a paid resource without authorization.** Report
   what you would have done instead.
4. **Never conclude a lane is fine from a status field.** `working` is not progress and
   `idle` is not done; read the footer, an artifact, or the lane's run.
5. **Never report unverified success.** A lane's report is `reported`; only a file,
   commit, test count, or live read makes it `verified`.
6. **Never add a `Co-Authored-By` or similar attribution trailer** to a commit. Match the
   repository's existing trailer practice; if it has none, write none.
7. **Never `pkill`/`killall` by a command-line pattern that a shared process name can match.**
   `pkill -f 'pi$'` matches every pi agent on the machine, because `pi` *is* their command
   line — it killed ~46 live lanes while the operator was away. Kill a specific pane's own
   foreground pid (`herdr pane process-info --pane <id>` → `ps -o pid,cmd -p <pid>`), or
   close the tab. A pattern that can match the harness, the shell running the command, or a
   sibling lane is not a selective kill; it is a fleet outage with a plausible-looking flag.
   **This includes matching yourself:** the pattern you typed is in *your own* `bash -c`
   command line, so `pkill -f '<anything you are acting on>'` kills the shell running it. Two
   lanes hit this in one night — one lost 46 lanes, the other lost three tool calls before
   noticing. Signal a pid you read from `ps`, never a string you just composed; bound test
   children with `timeout` instead of hunting them.

   **Do not hand-roll the safe version — use the tools, which enforce it:**

   - `~/.overlord/tools/proc-find.py` — find a process by an explicit *field* (`--exe`,
     `--argv0`, `--arg`, `--env KEY=VALUE`, `--name`), never by a whole-command-line
     pattern, and **always excluding this process and all of its ancestors**. Signalling
     additionally requires `--expect N` to match the count exactly, so a match broader than
     intended fails loudly instead of acting. Think `proc-find --argv0 sleeper --signal TERM
     --expect 1`, not `pkill -f sleeper`.
   - `~/.overlord/tools/pane-signal.sh <lane|pane>` — signal *only* that pane's own
     foreground process, with a refusal if the pid is this shell or one of its ancestors.
     This is the one-command form of the sanctioned route above.

   Measured contrast, same word, same moment: `pgrep -f proc-find` returned **3** processes
   (both shells and the tool itself); `proc-find --argv-contains proc-find` returned **none**.

## Working in a repo

- Use graft to understand and scope a codebase; `grep`/`rg` only for exhaustive
  enumeration of literal strings.
- Check free space and usage before any action that occupies a lot of disk.
- Rust builds go through `cargo-remote-3000` on fly.io build servers, and you check you
  are not racing another agent's build.
- When blocked on something only a human can provide, first clear it yourself via CLI,
  API, browser, docs and existing decisions within standing authorization. Then use the
  `unblock` skill rather than informal chat. Never approve your own ask.

## Acting on yourself

You may send slash commands to yourself only to set your own goal and to adjust your own
reasoning effort or model.

- pi: `/thinking <level>` and `/model <provider/model>` set them directly. **Bare `/model`
  and bare `/thinking` open selectors whose modal absorbs the next Enter.**
- `/goal edit` is safe and in place; `/goal add` appends. **Bare `/goal <objective>`
  wipes the whole queue** behind a modal. See `pi-goal-contracts`.
- A self `/reload` must not be sent inline from the coordinating turn. Use
  `~/.overlord/tools/reload-fleet --dry-run` / `--verify`; it defers self-reload to an idle
  helper and records the outcome under `~/.local/state/pil/reload-results/`.
- Setting your own goal is a completion contract, not a task summary.

## Skills — everything procedural

| Work | Skill |
|---|---|
| Goals, `/goal`, queue, blocked/wait | `pi-goal-contracts` |
| Naming, spawning, renaming a lane | `lane-identity` |
| Agent messaging, rooms | `pi-rooms-protocol` |
| Durable memory and notes | `pi-hermes-memory-usage` |
| Token and context cost, waits, polling | `context-economy` |
| Durable task graph (`bd`) | `beads` |
| Scheduled and recurring work | `agents-cron` |
| dagr runs | `dagr-producer` |
| herdr control | `herdr` |
| Asking the operator for something | `unblock` |
| Per-request injected context | `pi-persist-usage` |
| Profiles and modes | `profile-config` |

## herdr

If you do not know whether you are inside herdr, load the `herdr` skill and check. Observe
before and after every message or command you send to another agent. If you race another
project's agent for a resource, message that orchestrator; orchestrator tabs always carry
"leader" in their name.

## Session continuity and safe reloads

Pi `/new` and `/resume` are in-process session switches. Herdr's managed Pi reporter and `session-tracker.ts` keep the live pane pin and durable lane record aligned with the selected session; the retired duplicate canonical-path network reporter must remain inert. A fresh `/new` session applies the process-start `PI_MODE` selector to its empty branch; `/resume`, `/reload`, and `/fork` replay the selected session branch's mode. `pi-profile` reapplies its existing launch plan and does not re-resolve `PI_PROFILE` on session switches. Drift or unapproved project modes fail closed.

Use `~/.overlord/tools/reload-fleet --dry-run` before a fleet rollout. The wrapper includes its coordinating lane automatically and defers self-reload to a detached idle-waiting helper with a 24-hour bound. Verify the helper's atomic result under `~/.local/state/pil/reload-results/` (`waiting`, `reloading`, `confirmed`, `waking`, `woken`, `wake_failed`, or `failed`); it sends one provenance-labeled wake prompt after confirmed reload, and scheduling is not proof. Other working lanes are skipped by default. `--interrupt-working --verify` sends Esc only to observed working lanes, waits for idle, rechecks immediately before `/reload`, and fails closed on unknown or timed-out lanes. `--working-only` limits that sequence to initially working lanes. Linux is the fleet support target; Windows and macOS are outside compatibility scope.