# Prevention: canonical session paths from launch

2026-11-03. Companion to the incident record in `~/.pi/recovery/2026-11-03-post-boot/`.

## The defect

`pi` resolves `sessionDir` in this order: `--session-dir`, then the parent of a
`--session` file, then `<agentDir>/sessions/<encoded-cwd>`. In a lane `<agentDir>` is
a per-launch instance dir (`~/.pi-profile-switch/instances/launch-*`) that
`runtime-cleanup.ts` sweeps. So the path pi reports to herdr (`getSessionFile()`)
names an instance, herdr persists it, and the next restore replays it into a
directory that no longer exists. pi resolves lexically, mkdirs the path, and starts a
new session under the old filename with no warning — which is why 31 lanes came back
fresh on 2026-11-03.

## The fix

`~/.overlord/bin/pil` now passes pi its **own default session dir for this cwd** on
every launch, unless the caller already passed `--session-dir`:

```
session_dir_for_cwd()  ->  $SESSION_STORE/--<cwd with / \ : -> ---
```

The encoder is pi's verbatim (`dist/core/session-manager.js:290-295`). The result is
the same physical directory the instance `sessions` symlink already resolved to, so
**the store layout is unchanged** — only the path pi reports becomes durable.

`pi-profile-switch/src` was deliberately not touched: it is jiti-loaded live into
every lane, so a save goes fleet-wide with no canary.

## Proof 1 — container test (deterministic)

`docker compose run --rm test` in `~/.overlord/tools/session-path-test`, running
pi's real `session-manager.js` against production session files, read-only,
offline. 15 assertions, exit 0:

```
ok   bare launch: first flag is --session-dir
ok   bare launch: dir == pi's own default for this cwd
ok   bare launch: no --session invented
ok   explicit --session-dir preserved
ok   dead instance pin: remapped to the durable copy
ok   dead instance pin without a copy: --session dropped
ok   listing alpha returns only alpha sessions
ok   listing beta returns only beta sessions
ok   the two listings do not overlap
ok   listing is non-empty (fixtures actually loaded)
ok   opened file is the canonical one
ok   --session-dir overrides the file's parent for /new
ok   without --session-dir the parent IS the dir (the 2026-11-03 bug)
ok   dead pin resolves to the dead parent (not the store)
ok   dead pin does not magically find the durable copy
all container assertions passed
```

## Proof 2 — the outage reproduced, on the host

```
# lane launched bare, pin names the instance (today's state)
getSessionFile() -> /tmp/pt4/inst6/sessions/--tmp-pt4-work--/2026-11-04T00-08-48Z_...jsonl   EPHEMERAL
# same lane with the canonical --session-dir
getSessionFile() -> /tmp/pt4/store2/--tmp-pt4-work--/2026-11-04T00-08-32Z_...jsonl           CANONICAL

# instance reclaimed, then herdr replays the pinned instance path
did pi recreate the dead path as a BARE dir? YES
  orphan: 2026-11-04T00-07-42-402Z_01a1a3e2-0a41-7580-a2db-d7b8cac451e9.jsonl   (old filename, fresh session)
  store untouched: 2 file(s), 12 lines
```

## Proof 3 — one live lane, then a restart

Scratch lane `prevention-test` (`wE:t23` / `wE:p2N`), cwd `/tmp/prevention-lane`,
launched with plain `pil` — no `--session`, no manual pin:

| step | herdr's persisted `agent_session.value` |
|---|---|
| plain `pil` | `~/.pi/agent/sessions/--tmp-prevention-lane--/2026-11-04T00-11-51Z_....jsonl` — **canonical** |
| one real turn (`pong`) | same file; `pong` present in it |
| quit, relaunch `pil -c` | **same file**; conversation intact |

An earlier attempt was inconclusive because the first launch had no conversation and
`-c` skips empty sessions (`_hasConversation`). Recorded rather than hidden.

## Proof 4 — a defective lane repaired

`herdr-leader` (`w26:p1`) was instance-pinned before. After quit + plain `pil -c`:

```
pin: /home/bitnom/.pi/agent/sessions/--home-bitnom-Code-herdr--/2026-11-04T00-14-14-971Z_....jsonl
VERDICT: CANONICAL
mode:leader  rooms: herdr-leader  profile: fleet        (identity preserved)
```


## Second defect, found while verifying: `--continue` can hijack another lane

`-c` / `--continue` means "the newest session in this session dir". In a shared cwd
that dir holds every lane's sessions — `~/.overlord` had 19, `~/Documents/Fleet` 10 —
so `-c` can silently resume a *different* lane's conversation. It did, during this
work: a scratch lane launched with `pil -c` in `~/.overlord` picked the live overlord
session and would have appended to the same file from a second process. Caught by
reading herdr's persisted pin rather than the pane.

`pil` now refuses when the directory holds more than one session (exit 2, listing the
candidates) and points at `--session <path>`. Single-session directories are
unaffected, and a bare launch is unchanged. Verified four ways: empty dir allows `-c`,
two sessions refuse with exit 2, explicit `--session` still passes, bare `pil` still
produces only `--session-dir`; `--selftest` stays green.

Sessions carry no lane identity of their own (`header keys: cwd, id, timestamp, type,
version`), so a launcher cannot tell whose file is whose. Naming the conversation is
the only correct answer, which is why the fleet convention is explicit `--session`.

## Cost, measured

With a non-default session dir, `/resume`'s **"all projects"** tab lists this cwd's
directory instead of the whole store (`interactive-mode.js:4726`). In-lane
cross-project browsing is therefore narrower. Cross-project recovery still has
`pi --session <path>` and `~/.overlord/bin/pi-session-rescue`.

## Rollout

`pil` is the carrier, so every launch from now on is canonical. Lanes already running
keep their current pin until relaunched; relaunching with `pil -c` resumes the same
conversation and rewrites the pin canonically (Proof 4). Remaining at time of writing:
`self-improvement-leader` (busy), `fleet-config-analyst` (busy), `overlord` (last, by
operator ordering), `seeker-leader` and `sibyl-worker2` (waived by the operator).

## Files

- `~/.overlord/bin/pil` — `session_dir_for_cwd()`, injection, selftest (7 cases)
- `~/.overlord/tools/session-path-test/` — container test, stub `pi`, this record
- backup: `~/.overlord/bin/pil.bak-20261103-1910`
