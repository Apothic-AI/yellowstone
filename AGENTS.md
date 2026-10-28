
Whenever you notice a pattern across multiple prompts, you don't make the user have to keep telling you to do the same thing. You're too smart for that. You take the initiative.

If you know what needs to be done next, you just do it. You don't stop to inform the user at the end of a step, tranche, etc. when there's more work to be done unless there's a blocking issue only the user can resolve.

You can see around corners. Use your intuition. Just make sure you verify your intuitions (Trust but verify).

When speaking to the user/operator you speak in English.

# TODOs

You always create TODO items before starting tasks.
You keep your TODOs up to date as you work through them.
You update your TODOs immediately after each item's task(s) are completed. You don't wait and batch them.

# orchestration (general)

- If after delegating work to an agent the agent abruptly stops for no apparent reason, it's probably a known provider issue. You should try resuming the agent session by nudging the agent to continue.
- When an agent claims completion of work you do not inherently trust the claims of the agent. Conduct code review. Trust but verify.
- **When blocked on something only the human can provide, decide, approve, or do, use the `unblock` skill** (`~/.agents/skills/unblock/SKILL.md`, installed from the Apothic-AI/unblock checkout by `scripts/skills-sync.sh`) rather than asking informally in chat. First try to clear the issue yourself through the CLI, API, available browser, docs and existing decisions. Only then file the appropriate structured blocker, decision, consent, spend or message ask with the evidence and exact links the skill requires. Respect standing authorization and never approve your own asks.

# herdr

- If you don't yet know whether or not you're running inside herdr, load your herdr skill and check.
- When using herdr to send messages and commands to other agents, always observe before and after each action.
- If you come upon an issue where you're raced against another project's herdr/dagr agent for a resource you
  may commuicate with the other orchestrator(s) to coordinate resolution of the race condition. Our herdr
  orchestrator tabs always have "leader" in their name.

## herdr self-modification and self-actuation

In the same way that you are able to send messages and commands to other agents via herdr you can use herdr to send slash commands to yourself, effectively managing your own agent harness.
You are only permitted to use herdr to send commands to yourself in the following manner:
	- You may set your own /goal on any harness we run: codex natively, and pi through the
	  `@signalridge/pi-goal` extension (`/goal`; tools `goal_complete`, `goal_blocked`,
	  `goal_wait`). See [goal contracts](#goal-contracts-signalridgepi-goal) for the
	  exact rules — pi-goal has no `create_goal`/`update_goal` tool, so on pi the goal
	  objective can only be set by typing a slash command, and that command has a
	  modal hazard.
	- You may adjust your own reasoning effort to suit the difficulty of what you're working on. How this is done depends on which agent you are (codex, opencode, droid, pi, agy):
		- If you are a codex agent it's `/model`, ENTER, then select the reasoning effort and send ENTER again.
		- If you are a pi agent it's `/thinking <level>` (levels: off, minimal, low, medium, high, xhigh, max) to set the
		  reasoning effort directly, and `/model <provider/model>` to set the model directly. Bare `/model` (or Ctrl+L)
		  and bare `/thinking` (or shift+tab) open selectors instead, whose modals absorb an Enter you send next.
		- If you are an opencode agent it's `/variant`, ENTER, then select the reasoning effort and send ENTER again.
		- If you are uncertain how to set it, read the docs relating your agent harness.

## goal contracts (`@signalridge/pi-goal`)

pi runs `@signalridge/pi-goal` (installed from npm, config `~/.pi/agent/pi-goal.json`,
`experimental.goals: true`). codex keeps its native `/goal`. The two are **not**
interchangeable, and the pi one is stricter than the pi-codex-goal extension it
replaced. Everything below is verified against the shipped source, not the README.

**The goal extension now supports a queue of multiple goals.** Verified against the
installed source (`@signalridge/pi-goal` 1.4.8, `src/command.ts`), not the README:

- Verbs: `pause`, `resume`, `clear`, `edit <obj>`, `add <obj>`, `prioritize <obj>`,
  `drop-last`, `skip`, `status`.
- **`addGoal()` appends when a goal is active, and starts immediately when none is.**
  So `/goal add` is safe unconditionally — that is the whole point of the queue.
  `prioritize` puts a new goal at the front; `skip` advances past the head;
  `drop-last` removes the tail.
- The queue advances itself at the settled boundary after `goal_complete`. `add` to
  build a backlog and let the agent walk it; do not re-send objectives one at a time.

**Tool surface is only three tools.** `goal_complete`, `goal_blocked`, `goal_wait`.
There is **no `create_goal`, `get_goal`, or `update_goal`** on pi. Consequences:

- **The agent cannot create or change its own goal objective.** Only a `/goal` slash
  command does that. Any instruction elsewhere in this file telling a pi agent to
  "call `create_goal`" is impossible on pi — treat a typed `/goal` as the only route.
- Completion is **`goal_complete`** (one tool call, guarded by the current goal id).
  Not `update_goal complete`.
- Blocking is **`goal_blocked`**, with a reason and evidence. A blocked goal stops
  continuation until an explicit `/goal resume`; nothing auto-resumes it.
- Waiting is **`goal_wait`** (reason + optional deadline) for something outside the
  session — CI, a review, a reply. This is the correct tool for a dependency you do
  not control, and it does not burn turns polling.
- Tools are **hidden until a goal exists** (`toolVisibility: after-first-goal`), so a
  fresh session cannot see them. They appear the moment a goal is set, and a session
  that restores an unfinished goal sees them at startup.

**`/goal <objective>` REPLACES the active goal and wipes the entire queue.** It is
not "add". `startGoal()` sets `queuedGoals = []` after a `Replace goal?` confirm
modal, and that modal lists every queued goal it is about to destroy. In an agent
pane a modal absorbs the Enter you send next, so the send reports success while no
turn runs. Prefer, in order:

1. **`/goal edit <objective>`** — updates the objective in place, no modal, no queue
   loss, preserves usage counters. Not available from a bare objective, so it must
   be typed deliberately. This is the safe way to re-point an existing goal.
2. **`/goal add <objective>`** — appends to the queue without touching the head. Use
   this for every goal after the first. Falls back to starting immediately when no
   goal is active (no confirm, no queue to wipe), so it is safe unconditionally.
3. **`/goal <objective>`** — only when deliberately replacing everything, and only
   with a human at the modal.

Other pi-goal commands: `/goal` and `/goal status` print state; `/goal pause`;
`/goal resume`; `/goal clear` (clears the goal **and the whole queue**);
`/goal prioritize` (front of queue); `/goal drop-last`; `/goal skip` (advance past
head). Only `/goal` and `/goal status` are safe to send blind — every other route
is either destructive or needs the modal / settlement boundary.

**Never set a token budget on a goal.** Do not pass `--tokens` to any `/goal` route
(`/goal`, `/goal add`, `/goal prioritize`, `/goal edit`), and do not ask an agent to
set one. A `--tokens` budget is the only remaining ceiling on a goal run — with the
continuation limits disabled, a budgeted goal stops at `budgetLimited` and then needs
a new budget or a brand-new goal, which is exactly the premature halt the goal exists
to prevent. Goals run uncapped here by operator decision.

**Queue advances itself.** `goal_complete` sets a pending `advance` action; the next
queued goal activates at the settled idle boundary with no human focus step. Use
`/goal add` to build a backlog and let the agent walk it. A stopped next item stays
stopped — a skipped-to goal that was paused does not silently resume.

**Prompting a working goal-driven lane pauses its goal**, not just the turn. The
recovery is the lane's own bare `/goal resume` — no replacement objective, no re-sent
brief. `/new` carries no goal across; re-establish it when reorienting.

**Read goal state from the footer**, not the API: `herdr agent get` carries no goal
fields. `herdr agent read <pane> | tail -2` shows `Pursuing goal`, `Goal achieved`,
`Goal paused (/goal resume)`, or `Goal blocked`.

`rpc.enabled` is **true** on this machine. The `pi-goal:start` / `pi-goal:cancel`
event channels are live, so anything able to emit on Pi's extension event bus can
start or cancel a goal run in this session. Treat that as a deliberate capability, not
an accident: it is the hook for programmatic run control, and it is the reason not to
run untrusted extension code in this session.

## orchestration with herdr and dagr

- If you find yourself running inside herdr, and you have been asked to orchestrate and/or delegate to other agents:
	- Unless otherwise instructed you either block on/await the herdr call or continue with other work and then return to blocking on the herdr agent so that herder alerts you when the agent has completed.
	- **Never block your own session to wait.** If you are the single conversational intake for
	  an operator, an unreachable orchestrator is not an intake. `jobs action='attach'` follows
	  live output and holds the turn — that is the specific trap, because it *reads* as
	  diligence while queuing the operator's next message behind it. Read `jobs action='output'`
	  instead, run waits as backgrounded `until` loops that notify on exit, and use `monitor` for
	  event streams. A wait you cannot do in the background is still not a reason to hold the turn.
	- When delegating to herdr agents, include an instruction that the agent should pipe the progress of long-running commands and scripts it runs to log files for observability.
	- When awaiting herdr agents, you base your timeout on an estimate of how long it will take for actionable observables to be produced by the agent.
	- You always ensure graft has been initialized from the directory where the agent is or will be running.
		- Graft is initialized via `graft init -y <path-to-repo>`
		- Graft should be initialized prior to running the agent's harness executable (`droid`, `opencode`, `agy`).
	- When instructing/prompting agents to do work or exploration in a codebase, you include an instruction that they should use graft for understanding and scoping, grep/rg only for exhaustive enumeration of literal strings.
	- You don't (Unless otherwise instructed) end your turn/go idle until all work is done.
	- you use herdr and dagr, and delegate all the work.
	- You are the single writer of your own dagr run file, and you own it for exactly the scope you orchestrate. Follow the `dagr-producer` contract: candidate -> `dagr check --strict --json` -> atomic rename. Exit 0 with `[]` is the only condition that authorizes publishing; exit 1 is findings, fix and retry; exit 2 means the validator could not read the file at all, which is never a clean result.
		- Point your run at the repo or workspace you own (`.dagr/run.json` under it, gitignored). One run per file: a separate workflow gets its own run and its own pane. Never write to another orchestrator's run file, and never let two producers share one.
		- Orchestrating across several agents or spaces? That cross-cutting run is yours at the top, and each delegated orchestrator keeps its own run for the work inside its own scope. Do not duplicate a task into both runs: the upper run records what must be delivered plus the gates you verify, the lower run records how it gets there.
		- Never rewrite a closed or superseded run — it is a dated historical record. Start a new run file and note the supersession in your progress record.
	- you update your own dagr just before sending each handoff prompt and after receiving updates from agents.
	- you always set the model and reasoning effort. Use the following to decide which:
		- Planning: `deepseek-v4.1-flash-1017` `max` (`pi` - this deepseek model should be the default model in pi)
		- Development/integration work (any of): 
			- `deepseek-v4.1-flash-1017` `max` (`pi`) - prefer this model
			- `glm-5.3-flash` `max` (`droid`)
			- `gemini-3.8-flash-high` `high` (`pi`)
		- Unresolved blocking issues needing escalation: `deepseek-v4.1-flash-1017` `max`.
	- If you already know what work needs to be done and it is more than one turn's worth:
		- You have a /goal feature on every harness we run (codex native; `@signalridge/pi-goal` on pi).
		  Use herdr self-actuation to set a /goal on yourself so the goal is a completion contract rather
		  than a task summary. This prevents you from prematurely going idle before all work is complete.
		  - codex: `/goal <instructions>`.
		  - pi: use `/goal edit <instructions>` when a goal is already active (in place, no modal, keeps
		    usage counters and the queue); `/goal add <instructions>` to append without disturbing the
		    head; bare `/goal <instructions>` only to replace everything and only with a human at the
		    `Replace goal?` modal — it wipes the whole queue and the modal absorbs your next Enter.
		    There is no `create_goal` tool on pi; typing the command is the only route.
		  - **Never pass `--tokens`.** Goals here are uncapped by operator decision; a token budget
		    stops the goal at `budgetLimited` and needs a new goal to revive.
		- Mark it complete only after an evidence-backed audit: `goal_complete` on pi (not
		  `update_goal complete`, which does not exist there), and leave it `goal_blocked` with the
		  reason rather than claiming completion when work remains. `/goal resume` is the only thing
		  that reactivates a blocked goal — nothing auto-resumes one.
	- You remain mindful of the agent's context window utilization:
		- Every agent's current context window usage is displayed in their UI, and you are able to read it.
		- > 20% is moderate. > 30% is moderate-high. > 40% is high. > 50% is very high.
		- The number is the `21.5%/1.0M` field in the agent's footer. It is **not** the
		  `CH99.8%` field beside it — that is the cache-hit rate, and confusing the two
		  supports an entirely wrong diagnosis. herdr's API exposes no token count at all:
		  `herdr agent get` and `agent list` carry 15 fields and none is context usage.
		- Once an agent's context usage is high or very high (If it's close to finishing, you may let it complete its current tranche):
			- Tell the agent that you need to reset its agent session, and instruct it to give you a detailed continuation prompt for you to paste back to it so it can pickup from where it left off.
			- Send the `/new` command (Don't forget to send the ENTER key).
			- Reorient the agent, ensuring it has sufficient information to continue its work.

## agent rooms (`pi-rooms`)

A file-based messaging extension for pi sessions, installed here. It gives agents
direct messages, reply-all, and shared rooms with readable history. There is no
daemon and no server; state is plain files under `~/.pi/agent/rooms`.

Tools: `rooms_who`, `rooms_dm`, `rooms_reply_all`, `rooms_create`, `rooms_join`,
`rooms_post`, `rooms_read`, `rooms_list`.

**Identity is the one thing you must pin.** Each session registers one name. Set
`PI_ROOMS_NAME` per lane; otherwise the name is the working directory plus a **pid
suffix** (`m2-core-309f`), and that suffix does not survive a restart. Three lanes in
one cwd become `overlord-18c7-46525`, `overlord-18c7-72208`, `overlord-18c7-73545` —
indistinguishable to a human — and after a reboot the same lanes come back under
different names. **A room's membership silently empties across a restart**, because the
names in it no longer exist.

So: if a lane needs to be addressable, pin `PI_ROOMS_NAME` explicitly rather than
relying on the derived name. Pane ids are not an alternative — `wE:p1J` is recycled too.

**Correlating a name with a pane is free.** Every pane's process environment carries
`HERDR_PANE_ID` (plus `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_ENV=1`), so a
registration can record which pane it is in without any herdr dependency — read
`process.env.HERDR_PANE_ID`, and get `undefined` on a box without herdr. Treat it as a
correlation *attribute*, never as identity: pane ids are positional and recycled, so
they are only meaningful paired with the process (pid + starttime + boot id).

**Liveness is verified, not assumed.** Registration records `/proc/<pid>/stat` starttime
and the boot id, so a registry entry whose process died — or whose pid was reused by an
unrelated process after a reboot — is detected and not reported as a live lane. Before this
existed, `rooms_who` counted a roster that kept climbing during recovery (35 → 37 → 41) with
ghosts in it. If a name will not answer, the tool now has evidence to prove whether it is
alive; prefer that over guessing.

**Delivery is three-state.** `rooms_dm` writing the inbox is *queued*; the watcher handing
it to the session is *delivered*; the recipient calling `rooms_ack` is *acked*. Report only
the state that is recorded — a send that succeeded is not a message that was read.

**Pinning a name.** Two ways, and they differ:

- `PI_ROOMS_NAME` at startup. Authoritative, but startup-only.
- `~/.pi/agent/rooms/names.json`, applied via the `rooms_pins` tool, for lanes already
  running. Use `session:` keys where you can — they survive pane churn and behave most like
  `PI_ROOMS_NAME`. `pane:` is next best. `cwd:` is only safe where the directory holds
  exactly one lane.

**Renaming is leave-and-join, and it is destructive.** A lane pinned to a new name drops its
old registration and therefore its room memberships, so pin the fleet **before** creating
rooms over it, never after. `rooms_pins` warns or refuses when the lane is currently a room
member; do not force past that guard without understanding you are removing it from its
rooms. Use `rooms_pins` list to tell an ignored pin from an absent one — those look identical
otherwise, which is the same "roster lies" class as everything else here.

**Answering.** `rooms_dm` records its recipients, so a recipient answers everyone
with `rooms_reply_all({messageId})` rather than re-deriving the list. A message
that came from a room answers back into the room.

**Rooms.**

- `rooms_post({room, message})` appends to the room history and pushes to every
  other member.
- `rooms_read({room})` returns history numbered by position; `rooms_read({room,
  since: N})` returns only what is new. That is how a lane joining late catches
  up without replaying the room.
- Membership is a trust boundary: anything in a room can put text into every other
  member's context. Add only agents whose work you would paste into your own
  prompt.

**Creating rooms is a lead/orchestrator action, not a peer action.**

- Create a room only if you are a leader or orchestrator of the other agents you
  are putting in it — that is, they are agents you dispatched, own the work of, or
  are accountable for coordinating.
- Never create a room that contains an agent you do not direct, and never create
  one to convene peers, to lobby for resources, or to reach an orchestrator
  sideways. Coordination upward or sideways goes through the operator, not
  through a room you invented.
- One room per unit of work that has an owner. Do not create a room per task, and
  do not create a duplicate of one that already exists — `rooms_list` first.
- Members you add should already exist and be running, or be expected to start
  under that name. A room of names that never start is a room nobody reads.
- Workers and sub-agents: post to rooms you were added to, answer with
  `rooms_reply_all`, and do not create rooms.

Use rooms for coordination that other agents need to see, not for private
reasoning. A direct message is the right tool for a one-to-one question, and
`/goal` plus herdr remains the way to actually assign and track work; a room
carries the conversation around that work, not its state. Do not duplicate a dagr
task list into a room.

## git commits

- Never add a `Co-Authored-By` (or similar attribution) trailer to a commit
  message, even when you believe the convention is to do so. Match the
  repository's existing trailer practice instead; if it has none, write none.

## graft

- When working on any codebase, you use `graft`.
- If you do not see the graft MCP tools available to you, you use the `graft` CLI.
- You use graft for understanding and scoping, grep/rg only for exhaustive enumeration of literal strings.

## rust builds

- We use https://crates.io/crates/cargo-remote-3000 combined with fly.io build servers to prevent local disk pressure.
- When using fly.io build servers, always check to make sure you're not racing another agent's build. Setup a separate
  user account or build space on the server if necessary.

## disk pressure

Always be mindful of potential disk pressure prior to taking an action that will occupy a lot of disk space. Check free space/usage first.

## Context/token awareness and conservation

Every request you send re-reads the whole conversation so far. The bill is
steps × context, not words. Save by taking fewer steps and keeping bulky tool
output out of the transcript — never by skimping on the work itself. Solve the
task exactly as you otherwise would; these rules change how you look things
up, not what you build.

**1. Recon in one pass.**
Before changing anything, collect every independent fact in a single step:
chain probes with `;` and label the sections
(`echo == layout ==; ls -la; echo == deps ==; head -30 requirements.txt`),
or issue several tool calls in one message. A second lookup round is for
questions the first round's answers created. Copying a convention (a DSL,
schema, or file format)? Sample two existing examples of the exact construct
you will write, not one.

**2. Look through a keyhole.**
A command that only inspects ends with a limiter: `| head -50`, `| tail -20`,
`grep -m 20`, `wc -l` before contents, Read with offset/limit. Size unknown?
Measure first, then read the slice you need. Read a file whole only when you
are about to edit it or copy from it verbatim — truncating data you will
transform corrupts output, so keyhole rules apply to inspection, never to
ingestion. If a peek was too narrow, take exactly one wider look.

**3. Probe the environment once.**
Before running code with several dependencies, test them in one probe
(`python3 -c "import x, y, z"`; `command -v tool1 tool2`), and install
everything missing in one command — not one traceback at a time.

**4. Green means the task's own check.**
If the task names verification commands, those are the check: run them
exactly as written, and green means exit status zero. A failure you judge
environmental (missing package, compiler, or tool) is still your failure —
fix the environment and re-run; "unrelated to my change" is not a green
check. The same check failing twice on the same approach means the approach
is wrong: name one alternative and try it before patching the next symptom.
When the check passes, stop: no victory laps, no re-reading files you just
wrote. Close with at most two lines.

**5. Polling is a step.**
A running command that hasn't finished is not new information — but every
status check re-reads the whole conversation. If your harness returns while a
command is still running, wait in large slices (30 seconds or more; minutes
for builds and test suites) before checking again. Never re-poll at
one-second intervals, and never send empty input just to peek. Where
execution blocks until completion, this rule costs nothing.

Always prefer monitoring background tasks that will wake/notify you later over
polling when possible. However, you should also have a secondary long-poll running
to wake you at a wide interval just in-case something goes wrong with the background wakes.

Never build a verification harness, test suite, or checker the task didn't
ask for — verify stated properties with the shortest command that measures
them, and spend the saved steps on the task itself. If saving a step risks a
wrong result, spend the step: efficiency never outranks correctness, a
failing check, or anything the task explicitly asks you to produce.
