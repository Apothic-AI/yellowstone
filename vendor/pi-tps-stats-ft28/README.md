# FT-28 TPS/TTFT candidate (isolated, not installed)

Stats-only fork of the metric definitions in `@arhen/pi-core-tps-stats` 1.3.4.
MIT attribution is retained in `LICENSE` and `UPSTREAM.md`. This directory is not
wired into any live config, installer, or canonical extension path.

## Measurements and controls

Effective TPS = assistant output tokens / seconds from `turn_start` to assistant
`message_end` (includes queue/prefill/TTFT, excludes subsequent tool execution).
TTFT = first `text_start`, `thinking_start`, or `toolcall_start` minus turn start.
Only the first content-start event counts. No start event means TTFT unavailable,
not zero. Zero-output/invalid-duration responses are excluded, as upstream does.

- `/tps-stats`: show current view, sample count, median effective TPS and TTFT.
- `/tps-stats reset`: clear measurements and any pending turn. Keeps controls and
  existing log files. Model selection and session start also clear measurements.
- `/tps-stats mode` or `mode toggle`: toggle period/latest.
- `/tps-stats mode period` / `mode latest`: choose directly.
- `/tps-stats period 300`: set trailing wall-clock period, integer seconds 1–86400.
  Changes the period setting without switching modes.
- `/tps-stats log` or `log toggle`: toggle disk logging.
- `/tps-stats log on` / `log off`: explicit control. Off waits for pending writes.
- `/tps-stats save`: explicitly save current mode, period and logging as global
  defaults. Other commands change only this extension instance, not global files.

Defaults: **period**, **300 seconds**, **logging off**. Period mode selects
completed responses whose end time is inside `[now - period, now]`, capped at the
newest 200 measurements to bound memory (upstream's cap). It reports per-response
medians, not a token/time-weighted aggregate. Latest mode selects exactly the
newest response regardless of age, including its own TTFT or unavailable state.
No previous-session history is reconstructed. The footer refreshes on completed
measurements, resets and commands, not on a background idle timer; querying stats
always reevaluates the time window. Shortening/re-expanding a period can reselect
retained measurements, but never measurements older than the 200-sample cap.

## Global config (no project config)

Location: `${PI_CODING_AGENT_DIR}/tps-stats/config.json`, or
`~/.pi/agent/tps-stats/config.json` when that environment variable is unset.
Missing config is not created until explicit `save`. Invalid/unreadable config
warns and falls back to defaults with logging off. Unknown fields are ignored.
Saving is atomic and writes only these three validated fields, mode 0600.

```json
{
  "mode": "period",
  "periodSeconds": 300,
  "logging": false
}
```

Saving `logging: true` explicitly opts future sessions into logging. A runtime
write failure disables logging in the current instance and reports a generic
error; it does not silently rewrite the user's saved defaults.

## JSONL privacy and lifecycle

Only when enabled, one line per valid completed measurement is appended to
`tps-stats/logs/<sessionId>.jsonl`. The ID comes from
`ctx.sessionManager.getSessionId()`, never the session display name or cwd.
Normal UUID IDs are preserved exactly. Unsafe IDs fail closed, not sanitized
into colliding filenames. Log files are created 0600, directories 0700; symlink
file targets are refused (Linux). Existing directory/file permissions are not
changed. The global parent path is user-controlled/trusted; this is not a
sandbox against another process that can replace its parent directories.

```json
{"timestamp":"2026-11-10T12:00:04.000Z","sessionId":"synthetic-session-001","outputTokens":100,"durationMs":2000,"tps":50,"ttftMs":200}
```

The serializer constructs an explicit allowlist: ISO-8601 completion timestamp,
session ID and five scalar metrics (TTFT may be null). It never serializes events,
message bodies, prompts, model outputs, credentials, model/provider names,
provider payloads, costs, or error details. No model/provider calls or tools are
registered. Logging does not backfill samples collected while off. Reset does
not truncate logs. Session shutdown drains pending writes; a new session uses
its own ID/file. No log rotation/retention policy is added.

## Offline checks (zero providers)

Node 22 with TypeScript stripping and an existing TypeScript 5.9 compiler:

```sh
npm run check
```

`npm test` injects a fake API/clock and uses per-test temporary directories. It
imports no Pi runtime/provider code, contacts no network, and never reads/writes
live config. `typecheck` resolves the installed host declarations and Node types
read-only. If the host is not resolvable locally or next to the Node executable,
set `PI_TPS_HOST_PACKAGE` to its existing package directory. No install is needed.

Independent acceptance should review this candidate without loading it alongside
the installed upstream extension: both use `/tps-stats` and status key `tps`.
Pi can suffix duplicate command names, but their footer states would conflict.
No live load, install, reload, canonical integration, or provider smoke test was
performed or authorized here.
