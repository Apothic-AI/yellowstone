---
name: hotshot
description: Complete a goal as a two-phase one-shot job in a new Herdr pane running the pi agent. A cheap context model reads every relevant file, doc, and source into one session, then that same session switches to a strong executor model that performs all writes and tool calls in a single response. Use when the user says "hotshot", asks for one-shot execution, or wants a goal completed in one pass with a separate read-only context phase and an execution phase.
---

# Hotshot

Hotshot turns a goal into one long-lived `pi` session inside a Herdr pane, with two phases:

1. **Gather** — a cheap context model reads everything relevant into the transcript. Read-only.
2. **Execute** — the same session switches to a strong executor model and completes the goal in a single response.

Never fork, restart, or run `/new` between the phases. The entire value of the skill is that the executor inherits the gathered context.

## Preconditions

Run all four checks before creating anything.

1. **Herdr** — `test "${HERDR_ENV:-}" = 1`. If it fails, say you are not running inside Herdr and stop.
2. **Goal** — Step 1.
3. **Config** — Step 2.
4. **Target** — the directory the work happens in. Default `$PWD` of the calling pane; ask if the goal points at another project.

## Step 1: Confirm the goal

Establish the user's current goal before touching the pane.

- If the request states a goal, restate it in one or two sentences and continue.
- If it is missing, ambiguous, or only a topic ("make it faster", "clean this up"), ask the user what the goal is and wait for the answer. Do not guess, do not create a pane, and do not substitute a goal from earlier in the conversation.
- Capture the objective, the deliverable, constraints and exclusions, the target directory, and any verification command the user expects.

## Step 2: Load or create the config

Config lives beside this file at `<skill-dir>/.env` (resolve the absolute path from the location of this `SKILL.md`).

| Variable | Meaning | Typical choice |
| --- | --- | --- |
| `HOTSHOT_CONTEXT_MODEL` | Model that reads context | Cheap, fast, long-context (e.g. `relayfast/gpt-6-luna`) |
| `HOTSHOT_CONTEXT_REASONING_EFFORT` | Thinking level for that model | `high` or `max` |
| `HOTSHOT_EXECUTOR_MODEL` | Model that does the work | Strongest available (e.g. `relayfast/gpt-6-sol`) |
| `HOTSHOT_EXECUTOR_REASONING_EFFORT` | Thinking level for the executor | `high`, `xhigh`, or `max` |

Rules:

1. If `.env` is missing, create it with the four keys and empty quoted values.
2. Load it: `set -a; . "<skill-dir>/.env"; set +a`.
3. If any of the four is unset or empty, ask the user for the missing ones in a single question (offer the suggestions above), then write the values into `.env`. Keep the file's comments, one assignment per key, values double-quoted. Never silently default and never invent a model. If the user names a model or effort in the request, that explicit choice wins: use it and write it back to `.env`.
4. Validate each reasoning effort against `off minimal low medium high xhigh max`.
5. Validate each model id and require an exact `provider/model` match, because `--model` also accepts fuzzy patterns:
   ```bash
   pi --list-models "$HOTSHOT_CONTEXT_MODEL" | awk 'NR>1 {print $1"/"$2}' | grep -Fx "$HOTSHOT_CONTEXT_MODEL"
   ```
   `pi --list-models` exits 0 even when nothing matches, so check the output, not the status. On a miss, show the closest rows and ask the user again.
6. `.env` holds no secrets. Leave it committed unless the user says otherwise.

## Step 3: Create the pane and start pi

```bash
herdr pane layout --pane "$HERDR_PANE_ID"        # wide pane -> right, tall/narrow -> down
herdr pane split --current --direction right --cwd "$TARGET" --no-focus
# read .result.pane.pane_id from the JSON response

herdr agent start hotshot --kind pi --pane "$PANE" -- \
  --model "$HOTSHOT_CONTEXT_MODEL" \
  --thinking "$HOTSHOT_CONTEXT_REASONING_EFFORT"
```

- Keep focus in the calling pane; do not create a workspace, tab, or worktree unless the user asked for one.
- Agent names must be unique among live agents. If `herdr agent list` already shows `hotshot`, use `hotshot-2`, `hotshot-3`, and target that name everywhere below.
- `agent start` returns only once pi is ready. If it returns `agent_not_ready` (for example a project-trust prompt), inspect with `herdr agent read`, resolve it with the user, then wait for idle.
- If the target project uses graft, run `graft init -y "$TARGET"` before starting pi, and tell the gathering agent to use graft for scoping and `rg` only for exhaustive literal enumeration.

Confirm the live model before prompting:

```bash
herdr agent read hotshot --source recent-unwrapped --lines 8
```

The status bar must end with a line like `(relayfast) gpt-6-luna • max` — provider, model, thinking level. That line is the source of truth, not the startup arguments. If it shows the wrong model, a picker, or an error, fix the config and restart the agent (`herdr agent send-keys hotshot ctrl+c`, then `agent start` again) instead of prompting.

## Step 4: Phase 1 — gather context (read-only)

Send one multi-line prompt. `herdr agent prompt` preserves newlines; put the prompt text before the options.

```bash
read -r -d '' PROMPT <<EOF || true
HOTSHOT PHASE 1 — CONTEXT GATHERING ONLY.

Goal: $GOAL
Target directory: $TARGET

Your only job in this turn is to load everything that could be needed to complete the goal into this session's context. Read; do not act.

Read:
- Every file that could plausibly be relevant: source, entry points, definitions and call sites, tests, configuration, schemas, migrations, scripts, build and CI files, and project instructions (AGENTS.md, README, docs/).
- Whole files, all lines, for any file that is not tens of thousands of lines. Use offset/limit or grep only for genuinely huge files, generated files, lockfiles, or vendored trees.
- Documentation for the libraries, APIs, services, and versions the goal depends on. Do the web searches needed to get current, authoritative behavior. Prefer primary sources.
- Any other exploration the goal requires: git history and blame, logs, running read-only commands, inspecting data.

Do not:
- Write, edit, create, or delete any file. Do not run commands that change state, install packages, or commit.
- Plan, design, review, recommend, rank options, or implement anything.
- Ask questions. Do not produce a plan, analysis, or deliverable.

Stop when further reading has low expected value, and prefer depth on relevant material over volume.

Then reply with a terse inventory only:
- files read, with paths
- external sources consulted, with URLs
- anything relevant you could not read, and why
No analysis, no plan, no recommendations.
EOF

herdr agent prompt hotshot "$PROMPT" --wait --timeout 3600000
```

`--wait` returns on the first settled `idle`, `done`, or `blocked` state. Then verify; the wait result alone is not evidence:

```bash
herdr agent read hotshot --source recent-unwrapped --lines 60
```

- The turn must be finished and the inventory present.
- There must be no `✕ Error`, `Retry failed after`, or `⚠ Stopped after` banner. `--wait` reports `done` even when pi gave up on a provider error.
- The agent must not be `blocked` on a dialog.

If the turn died on a provider error, resend the same prompt once. If it fails again, change the context model with the user instead of looping.

## Step 5: Phase 2 — switch to the executor

Same session, same pane. Two slash commands:

```bash
herdr agent prompt hotshot "/model $HOTSHOT_EXECUTOR_MODEL" || true
herdr agent prompt hotshot "/thinking $HOTSHOT_EXECUTOR_REASONING_EFFORT" || true
```

- Both commands return `{"error":{"code":"agent_prompt_stalled"}}` even when they succeed, because a slash command settles faster than Herdr's five-second working-state check. The `|| true` keeps a `set -e` script alive; do not treat the error as a failure.
- Verify each one by reading the status bar. It must show the executor model, then the executor effort. Switching the model can reset the thinking level to that model's saved default, so always set `/thinking` after `/model` and verify again.
- If the status bar does not change and the pane shows `No matching models` or a model picker, send `esc`, fix the config value, and retry. Never start execution on the wrong model.

## Step 6: Phase 2 — execute in a single response

```bash
read -r -d '' PROMPT <<EOF || true
HOTSHOT PHASE 2 — EXECUTION.

Goal: $GOAL
Target directory: $TARGET

Everything needed is already in this session's context from the gathering phase. Re-read only what is missing or stale.

Carry out every action required to complete the goal in this single response: all file writes, edits, creations, and deletions, and all tool calls (commands, tests, installs, git operations). Do not end your turn until the goal is fully implemented and verified.

Do not ask questions. Do not produce an intermediate answer, a plan-only response, or a progress report. Do not stop after the first file. One response means one uninterrupted turn with as many tool calls as the work needs.

Run the project's verification commands and fix what fails. Pipe long-running command output to a log file so progress stays observable.

Finish with one concise report: files changed, verification results, and anything still incomplete with the reason.
EOF

herdr agent prompt hotshot "$PROMPT" --wait --timeout 7200000
```

Then verify independently:

```bash
herdr agent read hotshot --source recent-unwrapped --lines 120
herdr agent get hotshot            # status, session path
git status --short && git diff --stat
```

Read the final report, inspect the changed files, and run the stated verification command yourself. Do not report success on the agent's word alone. If pi is still working after the wait returns, use `herdr agent wait hotshot --timeout <ms>`; if it stopped early, send "Continue and finish the goal" in the same session.

## Step 7: Report and clean up

- Leave the pane open so the user can inspect the session. Close it only when asked.
- Report: agent name and pane id, session path (from `herdr agent get`), context model and effort, executor model and effort, files changed, verification results, and anything incomplete.

## Failure handling

| Symptom | Action |
| --- | --- |
| `agent_prompt_stalled` on a slash command | Expected. Verify through the status bar. |
| `agent_not_ready` from `agent start` | Read the pane: project-trust or startup dialog. Resolve with the user, then `herdr agent wait <name>`. |
| `agent_prompt_stalled` on a real prompt | `herdr agent read`; usually a modal or trust dialog. Clear it, resend. |
| `blocked` | Read the dialog. Answer only routine approvals the user already authorized; otherwise ask the user. |
| `timeout` | Read the pane. Still working: `herdr agent wait <name> --timeout <ms>`. Stalled: resend "Continue". |
| Provider errors or retry loops | Retry once, then change the model with the user. |
| pi exited | Start a new agent in the same pane and re-run the failed phase. Resume the old session with `pi --session <path>` only if the pane is unrecoverable. |

## Guardrails

- One pane, one session, two phases. No forks, no `/new`, no second pi for execution.
- Never run the execution phase while the gathering phase is still working.
- Do not prompt or close panes you did not create.
- Keep the goal out of unquoted shell syntax. Compose prompts with a heredoc; if the goal text contains backticks or `$`, write it to a temp file and load it with `GOAL=$(cat file)`.
- If the gathering phase nearly fills the context window, tell the user before executing: compaction loses detail the executor may need.
