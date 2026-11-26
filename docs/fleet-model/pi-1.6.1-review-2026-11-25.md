# pi 1.6.1 candidate review — 2026-11-25

**Status: review complete. Candidate FLIPPED to the fleet per Overlord (2026-11-26T00:05Z); the
proof legs in §7 pass and the post-flip identity sweep is 29/29 MATCH.** No security blocker was found: the diff
adds no telemetry, no new endpoint, no new credential store, and no new install script.

Reviewer: `self-improvement-leader` (Overlord's #50). Read-only against `~/Code/pi-ft94-upstream`
and a detached scratch worktree that has since been removed. Nothing was applied, pushed, or
pinned, and no lane was restarted or reloaded.

## 1. What "1.6.1" is relative to what we run

| | value |
|---|---|
| deployed build | `~/.pi/pi-bin` → `~/.local/lib/pi-apothic-7b2756bdc/node_modules/.bin/pi`, `pi --version` = 1.6.0 |
| pinned fork commit | `7b2756bdc` on `Apothic-AI/pi`, `git describe` = `v1.6.0-86-g7b2756bdc` |
| candidate | upstream tag `v1.6.1` = `ef4a1cfcc`; npm `@earendil-works/pi-coding-agent@1.6.1` |
| review set | `git diff 7b2756bdc v1.6.1` — **35 commits, 160 files, +2999 / −1334** (56 src files, +872 / −690) |

The review set is **not** `v1.6.0 → v1.6.1` (115 commits, 591 files): the fork already carries
most of that range. The fleet delta onto 1.6.1 is only **5 commits / 10 files / +308 −9** — the
FT-94 symmetric jitter, its settings plumbing, the FT-96 compaction fix, and `7b2756bdc`.

## 2. Diff by package (src and package dirs, from `git diff --numstat 7b2756bdc v1.6.1`)

| package | files | +/− | substance |
|---|---|---|---|
| `ai` | 62 | +1386 / −518 | SSE/line-reader rewrite (`utils/sse.ts` new), OpenRouter `native_finish_reason` + empty-stop retry, `onResponse` on error responses, Gemini `xhigh`, classifier rename, Copilot decision models, `@google/genai` 3.6.1 |
| `coding-agent` | 46 | +993 / −576 | settings `notices` migration, session-manager linear read, RPC `jsonl` linear read, first-time-setup simplification, OSC 7501 blocked statuses, project-trust/permission dialogs |
| `tui` | 9 | +88 / −6 | OSC 8 hyperlink cap, stdin buffer, terminal-image, markdown fixes |
| `mcp` | 4 | +65 / −17 | streamable-http SSE linear read |
| `durable`, `env` | 6 | +78 / −58 | `NodeTextLineReader` / `RemoteTextLineReader` linear reads, Git-for-Windows Bash discovery |
| `chord` | 4 | +21 / −12 | JSONL store linear reads, backup-marker contract |
| `agent`, `codemode`, `schema`, `telemetry`, `evals` | 1–3 each | version/dep bumps only | |

## 3. Security-relevant surfaces

- **Telemetry — none.** `packages/telemetry` and `packages/schema` change only `CHANGELOG.md` and
  `package.json`. No code path was added or changed. Verified by diffing the package itself.
- **Auth/credentials — benign, no new surface.** `auth-storage.ts` gains one line: saving an
  `api_key` credential clears the process cache for that `!command`, so re-entering a failing
  secrets-manager command re-runs it. Copilot OAuth now records the account's decision-model ids
  (`availableClassifierModelIds`) and filters classifier models by account. No new credential
  location, no new auth endpoint. `@aws-sdk/credential-provider-node` is **already in the pin**
  (it was added before 1.6.0), so the AWS chain (env/shared config/SSO/IMDS) is not a new capability.
- **Dependencies — one major bump.** `@google/genai` 2.32.0 → 3.6.1. It is imported by
  `google-generative-ai.ts`, `google-vertex.ts`, `google-shared.ts`; the fleet has a
  `google-ai-studio` provider configured with `api: google-generative-ai` and `gemini-4-neon`.
  No other new package; the lockfile delta is that bump plus the 1.6.1 version pins. **No
  `postinstall`/`preinstall`/`prepare` script changes anywhere in the range** (checked
  `packages/*/package.json`).
- **Network — no new endpoint.** No new URL literal in non-test source. The behavioural change is
  `after_provider_response`: it now also fires for HTTP 4xx/5xx and for **each retried attempt** in
  `openai-completions`, `openai-responses`, `azure-openai-responses`, `anthropic-messages`,
  `google-generative-ai`, `google-vertex`, OpenRouter images and classifiers
  (`provider-retry.ts:130`). Google reports error responses with empty headers.
- **Subprocess / filesystem — nothing new for Linux.** The only added `spawn` is `taskkill` on
  Windows for job-tree kill; the temp-file crash fix and `full_output_error` are already in the
  pin (`8209929fb`, `943a99e3c`). No new write target.

## 4. Load-bearing surface (checked against the fleet's extensions)

| surface | finding |
|---|---|
| `pi-fleet-hooks` retry policy | reads `pi.getSettings().retry.jitterRatio` (`transient-error-retry.ts:173`), not `SettingsManager`; the rebased candidate keeps `jitterRatio` (schema 2, defaults 1, `retry.ts` 6 occurrences). No break. |
| `after_provider_response` | now fires for error responses and every retried attempt. The hooks must be proven not to double-count under this; it is the one behavioural change that reaches our code. |
| `session-manager` | upstream rewrote `loadEntriesFromFile` (linear read) and, being upstream, **does not contain `7b2756bdc`**. The existing candidate branch was created before that fix (below). |
| `pi-goal` RPC reader | `modes/rpc/jsonl.ts` rewritten (linear read); goal tests must run in the proof. |
| breaking change: `showCacheMissNotices` | `SettingsManager.getShowCacheMissNotices()` / `setShowCacheMissNotices()` removed. No extension in `~/Code/yellowstone/src/pi-extensions` or `~/.pi/agent/npm` calls them (only the host's own `dist`). Config `showCacheMissNotices` migrates to `notices.*`; our `settings.json` does not set it. |
| classifier rename `pi-classifier` → `pi-decision` | no reference to either API id in `~/.pi/agent`, `~/Documents/Fleet`, or `~/.overlord/tools`. Nothing to migrate. |
| FT-93 (blank reasoning) | `flagOpenRouterEmptyStop` turns an output-less OpenRouter `stop` whose `native_finish_reason` is not a clean stop into a retryable error. This changes what the FT-93 investigation observes; not a defect, but re-measure after any upgrade. |

## 5. Candidate branch that already exists, and what was proven on it

`apothic/pi-1.6.1` @ `40421c155` in `~/Code/pi-ft961-upgrade-20261125` (worktree created 12:30,
compat commit 13:25 on 2026-11-25):

- merges tag `v1.6.1` and carries FT-94 jitter + FT-96 compaction fix;
- `npx tsc --noEmit` in its own worktree: **0 errors**;
- **missing `7b2756bdc`** — it was created from `8b9f62b2a`, the commit before the session fix
  (`git merge-base == 8b9f62b2a`, `grep sessionIdFromSessionFile` = 0). Using it as-is would
  regress the 2026-11-25 session-identity fix.

Proof performed in a throwaway detached worktree (removed afterwards):

- `git cherry-pick -n 7b2756bdc` onto `apothic/pi-1.6.1`: **clean**, auto-merging
  `session-manager.ts`, adding `explicit-session-path.test.ts`; fix present (3 occurrences).
- targeted `vitest run` on the patched tree: **135/135 passed** across
  `explicit-session-path`, `settings-manager`, and `ai/test/retry`.
- limitation recorded honestly: a full `tsc --noEmit` on that scratch tree was not trustworthy
  because its dependencies were symlinked from the candidate worktree (25 test-only model-id
  errors, none in `src`; the candidate's own worktree is 0). The gate's typecheck must be run on
  the real release worktree, not this scratch one.
- the merge needed a 12-file "catalog compatibility" fix (`40421c155`) — model-catalog defaults
  and tests moved. That is the real cost of the upgrade; budget for it.

## 6. Decision

**HOLD APPLY.** Static review passes; the gate does not.

1. Gate step 4 (proof on one throwaway lane) is not done. Lane launches are Overlord's
   (`AGENTS.md`), so this is an Overlord-scheduled step, not a worker's.
2. The only existing candidate predates `7b2756bdc`; it must not be deployed unchanged.
3. Nothing here is urgent: the pin is healthy, and the fleet step for `swarm-0wg` is already
   Overlord-sequenced. There is no reason to take two fleet changes in one window.

## 7. Required before any apply

1. **Candidate:** `apothic/pi-1.6.1` + `7b2756bdc` (cherry-pick verified clean), or a fresh
   rebase of the five fork commits onto `v1.6.1`. Build with `scripts/local-release.mjs`; install
   to a **new** `~/.local/lib/pi-apothic-<sha>`; do **not** flip `~/.pi/pi-bin` yet.
2. **Throwaway-lane proof** (Overlord launches the lane; checks below):
   - footer/`pi --version` shows the new build; lane idles; rooms name registers; DM round-trip;
   - skills resolve (global + project), the leader mode composes, `pi-goal` tools appear after a
     `/goal add` and `goal_complete` succeeds;
   - a **nonexistent explicit `--session` path** adopts its filename id (header id == filename),
     and resume-by-id selects that row — the `7b2756bdc` behaviour;
   - `retry.jitterRatio: 0.2` is still read; the notices migration does not lose or duplicate
     config; `/settings` shows one toggle per notice;
   - a forced `503 model_not_found` with the FT-94 hook installed settles after **one** request
     (`swarm-0wg`), and the expanded `after_provider_response` does not cause a second retry;
   - one real turn on the fleet default (`subrouter-gpt` / `gpt-6.1-terra`) and, if a classifier
     model is in use, one `models.classify()` call;
   - herdr reports `blocked`/`idle` correctly with the new OSC 7501 dialog statuses.
3. **Rollback ready:** `~/.local/lib/pi-apothic-7b2756bdc` and
   `~/.pi/pi-bin.bak-20261125T214410Z` remain; flip back and restart.
4. **Record** the proof result here and in `EXECUTION-RECORD.md` before any fleet-wide adoption.

### Proof results on the candidate (2026-11-25, candidate `89306ca8e`)

Installed at `~/.local/lib/pi-apothic-89306ca8e`; global pin still `7b2756bdc`. All runs used an
isolated agent dir, a local provider stub and no model spend.

1. **Nonexistent explicit `--session` A/B.** Same isolated agent dir, two binaries:

   | build | filename uuid | header id | match | resume by filename id |
   |---|---|---|---|---|
   | 1.6.1 `89306ca8e` | `5e4f1cf1-…` | `5e4f1cf1-…` | **yes** | opens the same row: 1 file, 6742→7483 B, 1→2 assistant entries |
   | pre-fix `8b9f62b2` | `3f2a22e2-…` | `01a21527-…` | no | `No session found matching '3f2a22e2-…'`, no growth; resume by the **header** id appends to the file whose name says `3f2a22e2-…` |

   The 1.6.1 turn itself was a normal turn (1 assistant entry, 0 error entries), so the header was
   adopted by opening the path, not by a failed request.

2. **Forced 503 `model_not_found` with `pi-fleet-hooks` loaded** and FT-94 settings
   (`maxRetries 1e9`, `baseDelayMs 2000`, `maxAgentDelayMs 300000`, `jitterRatio 0.2`), body = the
   real provider text: **1 request, settles immediately** (`wall 0s`) with assistant
   `stopReason: error` and message `terminal_provider_error: model_not_found … (request id
   2026112521511…OtorBmp)`; session entry `fleet-terminal-provider-error` carries the class and the
   verbatim provider text; the retry JSONL records `attempts: 0`. Control, identical stub and
   settings but **without** the hook: **4 requests in 20 s and still looping** when the timeout
   killed it (2 s, 4.4 s, 7.1 s gaps).

   `after_provider_response` expansion does not re-arm it: the hook sources subscribe to none of
   the provider-response event spellings, and no second request was observed after the settle.

3. **OSC 7501 blocked status (optional): not run.** It needs an extension dialog in a live pane;
   Overlord observed the `idle→working` transitions, and the dialog-statuses change is additive
   (`blockedKind` optional) with no fleet extension calling it.

**Status:** the two hard legs pass on the candidate, and Overlord flipped the global pin to
`89306ca8e` on 2026-11-26T00:05Z (canary `neti-leader` five gates, then a 21/21 sweep).

### Flip outcome and the reboot lesson (2026-11-26)

- **Post-flip identity sweep (read-only, all live pi processes): 29/29 MATCH** — filename uuid ==
  first-line `id`; zero mismatches. Includes the canary and this lane.
- **The machine rebooted at 01:00:12Z** (uptime 1027 s at the 01:13Z check). Every lane process
  started at 01:01:55–01:02:00Z — after the reboot — so the six deliberately excluded
  "never-touch" lanes (overlord, yellowstone-leader, assistant-leader, psy-journal,
  gemini-accts-leader, vpn2proxy-leader) **came back on the candidate anyway**: their PATH head is
  the new build. A never-touch exclusion is a relaunch policy, not a reboot property — lane
  autostart resolves the current global pin. If the exclusion must survive a reboot it needs a
  per-lane pin mechanism; Overlord owns that decision.
- `sibyl-worker2` is a dead pane (`restore_error`, deleted cwd), not a non-pi lane — it should not
  be counted as one.
- The cause of the 01:00Z reboot is not established here; flagged to Overlord to ask sysops.

## 8. UNKNOWN (stated, not guessed)

- Who created `apothic/pi-1.6.1` and whether it is meant as the release candidate: not in the
  continuation, and the commit author is the fleet's shared git identity. I did not alter or push it.
- Whether any lane currently runs the `google-ai-studio` / `gemini-4-neon` provider path (the
  config exists; the session default is `gpt-6.1-terra`), so the runtime effect of the
  `@google/genai` 3.6.1 major bump is unproven for the fleet.
- The runtime effect of the `after_provider_response` expansion on `pi-fleet-hooks` — needs the
  lane proof.
- Whether 1.6.1's empty-stop retry changes the FT-93 blank-reasoning symptom — needs a re-measure.

**No-go respected:** the Neon escalation tier and the Neon cache fix are operator-deferred; the
1.6.1 `xhigh` Gemini fix is noted here only, not acted on.
