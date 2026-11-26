## 1. What the operator asked, and what this file is

The operator reported that `dxdb-leader` and `open-surrealdb-leader` (= `ds-leader`) were
"accidentally sent a slash command as text/prompt", and asked for both leaders' full accounts
and then a factual record. Both were asked for a complete report. This file records what was
found, with sources, and separates what is established from what is not.

---

## 2. The finding: two fused slash tokens, one per lane

Both lanes received a **bare slash-prefixed token as plain text in a user-role turn** — not
executed, not expanded. Both are verbatim in their session transcripts:

| lane | pane | token received | timestamp | transcript |
|---|---|---|---|---|
| `ds-leader` (open-surrealdb-ds) | `wX:p1` | `/reload/modereload` | `2026-11-07T21:52:42.857Z` | `2026-11-03T00-55-17-596Z_01a19ee7-...jsonl` line 607 |
| `dxdb-leader` | `w1C:p1` | `/profilereload` | `2026-11-07T22:07:30.355Z` | `2026-11-01T05-32-38-548Z_01a19598-...jsonl` line 890 |

Both raw lines have the same shape — `role: "user"`, a single text part, no command expansion:

```json
{"type":"message","id":"c1cc8397","parentId":"077f3a37","timestamp":"2026-11-07T21:52:42.857Z",
 "message":{"role":"user","content":[{"type":"text","text":"/reload/modereload"}],"timestamp":1794088362843}}

{"type":"message","id":"28303760","parentId":"e76dc153","timestamp":"2026-11-07T22:07:30.355Z",
 "message":{"role":"user","content":[{"type":"text","text":"/profilereload"}],"timestamp":1794089250343}}
```

**These are the only two such tokens in the fleet's session history.** A scan of every `.jsonl`
under `~/.pi/agent/sessions/` for a user turn that is a bare slash token returns exactly
`/reload/modereload` (1), `/profilereload` (1), and `/exit` (2, ordinary). The two anomalous ones
are the two lanes in scope. No other lane received anything similar.

### 2.1 Neither token is a pi command — verified

`/profilereload` and `/reload/modereload` are not slash commands. The string `profilereload`
appears **nowhere** in the installed pi package (`@earendil-works/pi-coding-agent`), and neither
form is in `docs/slash-commands.md`. The documented built-ins are `/changelog /clone /copy /fork
/hotkeys /llama /logout /mcp /new /quit /reload /resume /scoped-models /session /settings /share
/tree /trust`.

What they plainly are: **`/reload` and something else, fused with no separator.** The
`ds-leader` form is `/reload` + `modereload`; the `dxdb-leader` form is `/profile` + `reload`.
Both look like a slash command concatenated with adjacent text at a point where a separator was
lost.

### 2.2 The two tokens are NOT the same shape — an earlier claim of mine was wrong

An earlier version of this file asserted "both tokens are session-start artifacts". **That is
wrong**, and `ds-leader` caught it by pulling the actual predecessor records rather than trusting
the summary:

| lane | token | immediate predecessor | session boundary? |
|---|---|---|---|
| `ds-leader` | `/reload/modereload` | `system` turn, **4 ms** earlier | **yes** |
| `dxdb-leader` | `/profilereload` | `pretty-tui-response-footer` from a normal turn **13 min** earlier | **no** |

`dxdb-leader`'s token arrived at `22:07:30.355Z`, mid-session, after ordinary Q&A at
`21:54:23.981Z`. Only `ds-leader`'s sits at a boundary. Same emitter, different circumstances.
The "session-start artifact" reading came from checking the *immediate* predecessor of one token
and generalising — the same error this record has already had to correct once (§7).

---

## 2A. The mechanism: a space character dropped by a keystroke-driving tool

**The cause is confirmed and reproducible in the emitter's own code.**

`~/.overlord/tools/broadcast-to-fleet.py` drives the pi command palette by typing a slash command
**character by character**, because `send-keys` rejects a multi-character argument. Its docstring
records the trap:

```python
# LITERAL " " argument is silently dropped, though: it does not error and does not
# type anything, so `list('/profile reload')` produced `/profilereload` — the
# palette matched no such command and the text was submitted as a user message
# instead (observed 2026-11-07). The bare word `space` is the key that types
# a real space.
return ["space" if ch == " " else ch for ch in text]
```

A bare `" "` is a valid key name that **types nothing and does not error**. So a command with a
space in it loses that space when sent this way: `/profile reload` becomes `/profilereload`, the
palette matches no command, and **the text is submitted as a user turn** — which is exactly the
artifact both lanes received.

### 2A.1 The emitters, identified from transcripts

| lane affected | token | emitter | when | how |
|---|---|---|---|---|
| `dxdb-leader` (`w1C:p1`) | `/profilereload` | self-improvement lane (`w1K`, cwd `~/Documents/Fleet`) | `2026-11-07T22:07:29.165Z` | `for ch in "/profile reload": send-keys "$p" "$ch"` — the space dropped |
| `ds-leader` (`wX:p1`) | `/reload/modereload` | self-improvement lane | `2026-11-07T21:52:35.984Z` | `for pane in w1Z:p1 w1T:p1 w1C:p1 wX:p1: send-keys "$pane" "/" "m" "o" "d" "e" "-" "s" "t" "a" "t" "u" "s" enter` |

The `dxdb-leader` case is closed: the token arrived **1.2 seconds** after the self-improvement lane
typed `/profile reload` into its pane, and the string reconstruction is exact.

The `ds-leader` case is **not** closed. The broadcast at `21:52:35.984Z` addressed `wX:p1`
seven seconds before the token, but it sent the letters of **`mode-status`**, and
`/reload/modereload` is not derivable from `mode-status` by space loss. `ds-leader` identified
this gap itself and refused to paper over it:

> They sent the letters of `mode-status`; my transcript records `/reload/modereload`. `/reload` is
> not a subsequence of `mode-status`, and no `reload`-shaped broadcast to my pane appears anywhere
> in the fleet transcripts I can read.

Its two remaining hypotheses, preserved:

1. A `reload`-shaped broadcast to its pane was issued from a **shell**, not an agent tool call, so
   it never entered any transcript. The `.overlord` lane drives panes from `bash` heredocs, and
   `~/.overlord/tools/reload-fleet` is exactly such a tool.
2. The two events are **coincidental**, and its token came from a resume path replaying a composer
   buffer.

**Checked for this record**: `~/.local/state/pil/reload-results/` contains **no** artifact for
`w1C:p1` or `wX:p1` at any time — only `w1K:p1` entries, the most recent at `02:58` same day. The
detached self-reload helper therefore did not run for either lane at `21:52`/`22:07`, which
weakens hypothesis 2 slightly and leaves hypothesis 1 (a shell-issued broadcast, unlogged) the
better-supported of the two.

### 2A.2 The tool was fixed during this same window

The self-improvement lane found and fixed the space-drop itself at `22:09:12.172Z`, replacing the
character map with `["space" if ch == " " else ch for ch in text]` — the code quoted above, which
carries the `observed 2026-11-07` note. Both tokens in scope arrived **before** that fix.

---

### 2.3 What each lane did — the handling differed, and both were safe

**`ds-leader`** took it as a reload notice. Its own thinking at `21:53:08.735Z` reads:

> The user has issued `/reload` — a reload command. Actually the message says "/reload/modereload"
> which looks like a command. Hmm, this might be a system-generated command. Let me think about
> what's happening.

It acknowledged ("Reload noted"), then ran `todo list` and a `git log`/`git status`/bead-state check
to re-establish position. It **did not attempt to execute the token**, did not treat the fused form
as a second command, and did not ask for clarification. If a real `/reload` was intended, it did
not take effect — the session ran on uninterrupted. Its own assessment: the handling was safe, but
it *did* act on an assumption rather than asking, which it reports plainly.

**`dxdb-leader`** treated it as an unresolvable command and refused it:

> I don't recognize `/profilereload` as a command, and it isn't in the pi docs I have access to …
> Two things worth separating: 1. As a slash command — unknown to me. … 2. If you meant a profile
> reload — that's a real thing in this environment, and it's a step I'm deliberately careful about.
> … A self-`/reload` must not be sent inline from a coordinating turn: it goes through
> `~/.overlord/tools/reload-fleet --dry-run / --verify`.

It then asked which was meant, and named the correct protocol for the thing it suspected was
intended. It executed nothing.

**Neither lane ran the token.** Both outcomes were safe. The difference is that `dxdb-leader` asked
and `ds-leader` inferred — and the concrete risk in the inferred path is real: a lane that reads
`/reload/modereload` as "execute `/reload`" fires a self-reload from a coordinating turn, which is
the precise failure the fleet rules forbid (`reload-fleet --dry-run` first, never a self-`/reload`
inline).

---

## 3. The 2026-11-01 sweep was NOT the vector

The obvious candidate cause was the stuck-draft recovery sweep of **2026-11-01**, logged at
`~/.local/state/overlord/stuck-drafts-20261101T061747Z.log`. **It is refuted as the vector**, on
three independent grounds:

1. **The log says so.** `06:17:55Z SUBMITTED w1C:p1 -> status=working` and
   `06:17:49Z SKIP wX:p1 (no reorientation draft in the composer)`.
2. **The sweep injects no text.** `submit-stuck-drafts.sh` only presses Enter on a draft already
   present in the composer, and only one carrying its own marker
   (`MARKER='Your pane was relaunched through'`). It cannot introduce a slash token.
3. **The timestamps do not match.** Both tokens arrived on **2026-11-07**, six days after the
   sweep.

`dxdb-leader` had already said it had no memory of the sweep, and noted it could not corroborate
it. That was correct. The sweep did submit a reorientation prompt to `w1C:p1`, but that is a
different event from the slash token.

---

## 4. `dxdb-leader`'s report — summary

From its own account (`w1C:p1` pane, 2026-11-07), *as reported*; its own unverified marks preserved.

**Scope**: `/home/bitnom/Code/dxdb`, master. 68 commits published (`git push` exit 0,
`origin/master == HEAD`).

**Substantive engineering**:

- Found and fixed a **deadlock** — `make … test` hung at 127 suites with the box at load 0.00.
  Diagnosed as deadlock, not slowness, by reading `supervision.rs` and `/proc/<pid>/wchan` (5
  threads in `futex_wait_queue`), reproduced single-threaded on
  `a_dead_worker_fails_reads_rather_than_returning_nothing`. Mechanism: `pump()` owns death +
  deadline. After the fix, merged master ran `test --workspace` → exit 0, **181 suites, 0 failed**.
- Corrected two false claims in `docs/VERIFICATION-STATUS.md`, notably "127 suites, exit 124 =
  4-CPU sizing", which was the deadlock.
- Found a sixth unrun gate (`make fmt-check`) and two merges that landed red because of it.
- Diagnosed box-wide stalls: a local timeout kills `cargo-remote-3000` but not the underlying
  process, leaving orphaned remote test binaries holding the builder.
- Repaired the build box by hand: killed four orphaned remote test binaries (three `wrapper` at
  20m12s / 32m07s / 38m00s, one `storage_matrix` at 21m42s), each with a live remote cargo parent,
  seven lanes queued behind them at load 0.00; selected by `ps comm` prefix and `kill -9`;
  `make remote-repair` twice; started the box once via `xtask/ensure-box.sh`.

**Beads**: created `.4` (KB-2), `.5` (harness holes); closed `.3` (box, with evidence), `.4` (KB-2,
with verification); re-scoped `.2` (KB-1); ran `git config beads.role maintainer`. **No direct SQL,
no direct database writes — bd CLI subcommands only.**

**Lanes touched**: prompted `browser`, `query`, `testkit`, `core`, `clean`, `repl` — 6 lanes, ~15 prompts.

**Outside its space**: edited nothing outside `/home/bitnom/Code/dxdb` and its own continuation
file (rewritten twice); killed processes on a **shared** Fly box (shared with `starla`), confirming
args first; DMs with `starla-leader`.

**Its verified-vs-told table** (as it stated it):

| conclusion | how established |
|---|---|
| deadlock mechanism | live read of `supervision.rs` + `/proc/pid/wchan` |
| deadlock fixed | `test --workspace` exit 0, 181 suites, 0 failed |
| master green on six gates | own runs on `e37f374`, exit status captured directly |
| 68 commits published | `git push` exit 0, `origin/master == HEAD` |
| `dxdb-memory` clear on KB-1 | **lane-reported by core; re-scoped, not re-run** |
| Browser Chromium 48/48 | **lane-reported only — unverified** |
| `make audit` unmet = artefact | own runs: clippy 0, wasm 0; audit said "box busy" |
| `make remote-orphans` works | ran it; exit 0, empty output |

**Its stated uncertainties**: the stuck-draft sweep (no evidence); whether `storage_matrix`'s 21m42s
hang is testkit's code or a stale artifact (unknown, and why 6 commits stay held); two clippy
failures from its own residue (fixed lane-owned code on master instead of delegating); a 120s
timeout it set itself that killed the audit's first attempt; a file edit + `git add` in one tool
call that raced twice, once losing a docs update from a merge commit.

---

## 5. `ds-leader`'s report — summary

**The initial event**: `/reload/modereload` at `2026-11-07T21:52:42.857Z` (§2). Handled by
inference, not execution; acknowledged, then re-established position via `todo list` + git/bead
state.

**Gate work** (`2026-11-07 21:56–22:40Z`): `swarm-7uh` created 22:05:03 (the misroute);
`swarm-cdy` 21:58:11 (probe, closed); `swarm-94e` 22:00:56 (live gate); SQL repoint + delete +
`is_blocked` recompute at 22:05:18 (`odp1ebek`); `swarm-d9p`/`swarm-zyw` probes and cleanup
(`pgi31ced`).

**Other work**: `2f8c1f8` (`2026-11-02 20:59:57 -0500`) — the goal-doc correction, 4 files,
+137/−26, markdown only (reported in full previously).

**Messages**: 3 `rooms_reply_all`; **no** `rooms_dm`, **no** rooms opened.

**Beads**: 4 gates, all its own, all closed except the live `swarm-94e`. Claimed, closed and
modified **no other bead**.

**Concurrent lane, not its own**: `DECISIONS.md`, `PROVENANCE.md` (ADR-0024 mutual TLS, R-0165) and
`crates/surrealdb-ds/tests/fixtures/tls/` were dirty in the tree — mtimes `2026-11-04T01:45–01:56`,
three days before its work; it touched none of them.

---

## 6. Errors made in this investigation, and corrected

An earlier version of `pi-fleet-model/EXECUTION-RECORD.md` §30 concluded the malformed gate row was
**self-inflicted by the repair** — inferred from `ds-leader`'s own account of a broader-than-intended
`UPDATE`. **That inference was wrong**, and it was wrong in a specific way worth recording:

- The Dolt commit history shows the malformed row was written by `bd gate create` on **2026-11-04**,
  three days *before* the repair.
- Three control beads showing the correct column disproved the *proposed trigger*; they did not
  show the row was hand-written. The second step was inference, presented as a finding.
- The generalisable lesson: **an absence of reproduction does not license a causal story, even a
  flattering one.** §30 has been rewritten to record the defect, the correction, and the error.

The correct outcome was reached only because `ds-leader` had the exact command line and ran the
controlled probe. Its diagnosis was right from the start.

---

## 7. What remains open

1. **The mechanism is found (§2A) — a space character silently dropped by
   `broadcast-to-fleet.py`'s character-by-character keystroke sender, fixed the same evening.**
   What remains open is narrower: the exact emitter for `ds-leader`'s token, since the only
   broadcast addressed to its pane in the right window carried a different command's letters.
2. **The `ds-leader` emitter.** Two live hypotheses (§2A.1): a shell-issued broadcast that
   bypassed the transcripts, or coincidence. The reload-results directory is clean for both panes,
   which argues against the resume-buffer replay.
3. **Whether the prefix hypothesis generalises** beyond the two probes — i.e. whether any
   cross-prefix `bd gate create` misroutes, or only some. Two probes is a strong correlation and a
   small sample.
4. **Whether the `bd` defect is upstream** and reportable. Not investigated.

---

## Sources

- `~/.pi/agent/sessions/--home-bitnom-Code-open-surrealdb-ds--/2026-11-03T00-55-17-596Z_01a19ee7-3f5b-761b-88be-23064a5b45f6.jsonl` — line 607, the `/reload/modereload` turn
- `~/.pi/agent/sessions/--home-bitnom-Code-dxdb--/2026-11-01T05-32-38-548Z_01a19598-7312-75f4-88b9-ba2e61890e70.jsonl` — line 890, the `/profilereload` turn; line 889, its predecessor
- `~/.overlord/tools/broadcast-to-fleet.py` — `type_keys()` docstring and the character-map fix
- `~/.pi/agent/sessions/--home-bitnom-Documents-Fleet--/*.jsonl` — the two emitters (`22:07:29.165Z`, `21:52:35.984Z`)
- Fleet-wide scan of `~/.pi/agent/sessions/**/*.jsonl` for bare-slash user turns and for `send-keys` targeting `wX:p1` / `w1C:p1`
- `~/.local/state/pil/reload-results/` — no artifact for either pane
- `pi-fleet-model/EXECUTION-RECORD.md` §30 — the gate-misroute entry
- `pi-fleet-model/BD-GATE-MISROUTE-2026-11-04.md` — the gate misroute, full detail
- Rooms receipts `fa2525b8`, `394d04ae`, `77a055cd`, `24126231`, `331aeec9`

