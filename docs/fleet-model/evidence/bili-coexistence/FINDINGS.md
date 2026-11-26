# Coexistence run — bili 0.1.212 + pi-auto-compact, operator's configuration

**Run date:** 2026-11-02 21:44 → 22:44 local (2026-11-03T02:44–03:44Z)
**Runner:** `bc-coexist-run2` (worker lane), cwd `/tmp/bc-coexist`
**bili:** 0.1.212 (`daa082ea`), `/tmp/bc-coexist/node_modules/.bin/bili`
**Model:** `subrouter-deepseek-flash` / `deepseek-v4.1-flash-1017`, thinking `max`, baseUrl `https://usaeast.up.railway.app/v1`
**bili config:** `~/.config/billion-context/billion-context.json` = `{"autoUpdate": false, "advisoryCheck": false}` (unchanged, both top-level)
**Shared state:** `~/.pi/agent/settings.json` and `~/.pi/agent/pi-auto-compact.json` (`{"threshold":78,"alignPiThreshold":false,...}`) were **read only** — md5 before/after identical (`bdab3ba9…`, `f5295a8d…`). `instances/launch-*` was never hand-edited.

---

## 0. Pipeline verification (before trusting any number)

```
$ grep 'MITM domains' lane/turn-A-1.err
bili: started proxy at http://127.0.0.1:18787 (MITM domains: relay.fast,
      usaeast.up.railway.app, subtoken.net, api.inceptionlabs.ai, api.experientiallabs.ai)

$ curl -s http://127.0.0.1:18787/__bili/stats | jq .blindTunnels
{"total":19,"hosts":{"pi.dev":2,"registry.npmjs.org":16,"openrouter.ai":1}}
```

`usaeast.up.railway.app` **is** in `mitmDomains`; model traffic is **not** in `blindTunnels`
(the 19 blind tunnels are package/registry metadata fetches). Compression is really in the path.

**Correction to the brief's instruction:** `/__bili/stats` does **not** expose `mitmDomains` in 0.1.212.
Its payload is only `{sessions, blindTunnels, unrecognizedPaths, conflicts}`. I grepped every
`__bili/*` endpoint (`stats, overview, health, config, replicas, diagnostics, memory, packs, notices,
upstreams, upstream, status`) — `mitmDomains` appears in **none** of them. It is observable in the
launcher's stderr line quoted above and in the on-disk instance shape
(`entryShape()` carries `mitmDomains`, surfaced by `/__bili/replicas` only when replicas exist).

**What pi's number actually is** (`dist/bundle/chunks/chunk-MM3LKT73.js`):
```js
function calculateContextTokens(usage){return usage.totalTokens||usage.input+usage.output+usage.cacheRead+usage.cacheWrite}
function shouldCompact(t,w,s){return s.enabled?t>w-s.reserveTokens:!1}   // reserveTokens default 16384
```
pi's context meter is the **upstream-reported usage of the last assistant message** — i.e. it measures
the request *as bili actually sent it*, post-fold. This is the mechanism that decides question A.

**bili's own arithmetic for the same window** (bili.log, repeated every turn):
```
[headroom] model=deepseek-v4.1-flash-1017: effective window 1000000 -> 872000
           (reserved 128000 for max output 128000, cap 0.25 via compress.outputHeadroomMaxPct)
```

---

## A. Does pi's context usage ever approach 780,000 in a bili-wrapped lane?

**No. Peak observed 106,906 tokens — 13.7 % of the 780,000 trigger — after 24 turns and 3.69 MB of
corpus read.** At the operator's configuration the threshold is unreachable; the coexistence question
is moot here.

### Method
Lane A ran the operator's real config: real agent dir (`~/.pi/agent`), real `settings.json`, real
`pi-auto-compact.json` threshold **78**, model `deepseek-v4.1-flash-1017` contextWindow **1,000,000**.
Driver `/tmp/bc-coexist/drive.sh` issued 24 sequential turns through
`bili pi -p --mode json --session lane/sess-a.jsonl --thinking max`; each turn read **4 corpus files
(~161 KB)** via the `read` tool. Launch: `PI_MODE=worker PI_PROFILE=worker PI_LANE_NAME=bc-coexist-A
PI_BIN=/home/bitnom/.local/bin/pil`.

### Raw per-turn data — `evidence/laneA-turns.tsv`
`total` = `usage.totalTokens` of the final assistant message (pi's own meter); `acp_usage` = bili's
`[acp-usage] input=` for the same request; `folds` = `acp-compress-obs` lines; `compactions` =
`"type":"compaction"` entries in the session file.

```
turn  ts_start                   rc  bytes_read  inp    cacheRead  out   total   pct    acp_usage  folds  compactions
1     2026-11-02T21:55:58-05:00  0   161443      43771  14464      699   58934   5.89   58235      0      0
2     2026-11-02T21:56:21-05:00  0   161346      16478  0          906   17384   1.74   16478      3      0
3     2026-11-02T21:57:20-05:00  0   161445      46166  14592      666   61424   6.14   60758      0      0
4     2026-11-02T21:57:56-05:00  0   161443      45640  60928      338   106906  10.69  106568     0      0   <- PEAK
5     2026-11-02T21:58:34-05:00  0   161346      19303  0          1080  20383   2.04   19303      3      0
6     2026-11-02T21:59:24-05:00  0   161445      19494  0          299   19793   1.98   19494      0      0
7     2026-11-02T21:59:41-05:00  0   161443      19771  0          247   20018   2.00   19771      0      0
8     2026-11-02T21:59:55-05:00  0   161346      20048  0          385   20433   2.04   20048      0      0
9     2026-11-02T22:00:11-05:00  0   161445      20646  0          584   21230   2.12   20646      0      0
10    2026-11-02T22:00:42-05:00  0   161443      440    20608      306   21354   2.14   21048      0      0
11    2026-11-02T22:01:07-05:00  0   161346      547    21248      838   22633   2.26   21795      0      0
12    2026-11-02T22:01:52-05:00  0   161445      22289  0          48    22337   2.23   22289      0      0
13    2026-11-02T22:02:23-05:00  0   161443      593    21888      501   22982   2.30   22481      0      0
14    2026-11-02T22:02:39-05:00  0   161346      23116  0          332   23448   2.34   23116      0      0
15    2026-11-02T22:03:13-05:00  0   161445      23656  0          168   23824   2.38   23656      0      0
16    2026-11-02T22:03:36-05:00  0   161443      525    23552      210   24287   2.43   24077      0      0
17    2026-11-02T22:04:00-05:00  0   161346      561    23936      194   24691   2.47   24497      0      0
18    2026-11-02T22:04:24-05:00  0   161445      496    24192      212   24900   2.49   24688      0      0
19    2026-11-02T22:04:38-05:00  0   161443      560    24320      242   25122   2.51   24880      0      0
20    2026-11-02T22:04:53-05:00  0   161346      704    24704      575   25983   2.60   25408      0      0
21    2026-11-02T22:05:20-05:00  0   161445      733    25216      158   26107   2.61   25949      0      0
22    2026-11-02T22:05:42-05:00  0   161443      541    25600      193   26334   2.63   26141      0      0
23    2026-11-02T22:05:56-05:00  0   161346      577    25984      509   27070   2.71   26561      0      0
24    2026-11-02T22:06:19-05:00  0   161445      731    26368      48    27147   2.71   27099      0      0
```

```
turns_with_usage=24  max=106906 (turn 4)  min=17384 (turn 2)  mean=29780
total corpus read: 3,873,872 bytes (3.69 MB) over 24 turns
all 24 turns rc=0
```

### Arithmetic against the trigger
```
threshold 78% of 1,000,000          = 780,000
observed peak                       = 106,906   (13.7 % of the trigger; short by 673,094)
peak as share of the 1M model window= 10.69 %
mean growth, turns 6..24            = 408.6 tok/turn (18 intervals)
extrapolation from 27,147 @ 408.6   = ~1,843 further turns to reach 780,000
```

The curve is a **sawtooth, not a ramp**: bili folds when *growth* (not size) crosses its gate, which
drops the meter from 106,906 → 20,383 at turn 5 and from then on the session never exceeds 27,147.
Growth between folds is structural (one tool result per turn), not cumulative, because bili's fold
gate is measured against a moving reference (`growth=<n>/<gate> (ref=<n>, interval=50000)`).

### bili's fold evidence (lane A session `01a19f55-c3d4-7381-b5de-b69e77f406e8`)
```
2026-11-02T21:56:29.761 nudge idle: usage=7% (58235/872000), growth=43404/22500 (ref=14831, interval=50000)
2026-11-02T21:57:10.724 [acp-compress-obs] shrink 98% this-fold (~80765/82145 tok) · cumulative 98% ·
                        foldPoint=m00004 blocks=2 anchor≈639 tok postCtx≈1380 → next-request cache ceiling ≥46%
2026-11-02T21:57:10.724 [warn: degenerate-fold] covers 98% of the live context (~80765/82145 tok)
                        leaving 2 active block(s), anchor≈639 tok — the whole prefix rewrites and the
                        prefix cache restarts from scratch on the next request
2026-11-02T21:57:10.731 [plugin] tool compress executed via plugin (routed by native, #1685) (1074 chars, outcome=applied)
2026-11-02T21:57:46.243 nudge idle: usage=7% (60521/872000), growth=44043/22500 (ref=16478, interval=50000)
2026-11-02T21:59:02.815 [acp-compress-obs] shrink 91% this-fold (~80961/88630 tok) · cumulative 91% ·
                        foldPoint=m00040 blocks=2 anchor≈1087 tok postCtx≈7669 → next-request cache ceiling ≥14%
2026-11-02T21:59:02.831 [plugin] tool compress executed via plugin (routed by native, #1685) (1316 chars, outcome=applied)
```
Two folds over 24 turns; 3 `compress` tool calls in the session file; **0 `"type":"compaction"` entries**
— pi-auto-compact never fired, which is exactly what the arithmetic predicts.

**Side finding worth flagging (observed, not hypothesised):** bili's folds on this lane are
degenerate-by-its-own-warning. `shrink 98%` / `91%` leaves a 639–1,087 token anchor and bili itself
logs `[warn: degenerate-fold] … the whole prefix rewrites and the prefix cache restarts from scratch`.
Lane A's cache-read column shows the consequence (turns 2, 5, 6–9 have `cacheRead=0`). Cheap in
context but not free in prompt-cache cost.

### Not observed in lane A
- **No compaction** (`"type":"compaction"` count = 0 across all 24 turns).
- **No pid/ref mismatch, no 4xx, no "cannot be modified", no `EPIPE`, no session rebuild.** All 24
  stderr files clean apart from the two expected `bili:` banner lines. Note: `/tmp/bc-coexist/evidence/smoke.err`
  (pre-run, 19:14) *does* contain an `EPIPE` crash — that was a pre-existing probe whose stdout pipe
  closed, not a lane failure; no lane reproduced it.
- **780,000 itself was never approached**, so nothing can be said about behaviour *at* 780k in a
  1M lane — see §C.

---

## B. Forced collision: what happens when both compressors are live

**Reachable.** With the lane's own window at 100,000 and its own threshold at 30, pi-auto-compact fired
**three times**, bili logged a **native-compaction boundary for each one**, and **all six submitted
turns survived with correct answers**.

### Instrument (this took three attempts — the first two were invalid, and I am keeping them on record)

1. **Invalid — `PI_CODING_AGENT_DIR` does not reach pi.** `bili pi` builds the child env and sets
   `PI_CODING_AGENT_DIR: void 0` (`dist/index.js`, child-env construction). My first lane-B run
   (`driveB.sh`, `-p` mode, exported `PI_CODING_AGENT_DIR=/tmp/bc-coexist/agentB`) ran at **1.0M**:
   `<error>0.0%/1.0M</error>` in the footer, `instance ctx=1000000`, and bili logged
   `effective window 1000000` 37 times and `effective window 100000` **zero** times. Its null result is
   **discarded** — it was an instrument failure, not evidence. Raw data: `evidence/laneB-turns.tsv`.
2. **Invalid — `BILI_PI_BIN` is not the knob.** The pi binary comes from `const piBin=env.PI_BIN`.
   A first interactive attempt with `BILI_PI_BIN` also read `0.0%/1.0M`.
3. **Valid — `PI_BIN` wrapper.** `/tmp/bc-coexist/bin/pi-agentB` exports
   `PI_CODING_AGENT_DIR=/tmp/bc-coexist/agentB` *inside* the spawned process, then `exec pil`. Proof:

```
$ herdr pane read wE:p2J          # footer, lane B
0.0%/100k (auto)   (subrouter-deepseek-flash) deepseek-v4.1-flash-1017 • max
· DS cache 0/0·0M/0M 0.0% rooms: bc-coexist-instr profile: worker

$ newest instance launch-HDcFCO
pi-auto-compact.json -> /tmp/bc-coexist/agentB/pi-auto-compact.json   # {"threshold":30,...}
models ctx=100000 max=8192

bili.log:
[window] model=deepseek-v4.1-flash-1017 source=plugin native=100000 base=100000
         launcher=1048576 configured=none peek=1000000 fallback=false
```

Lane B's agent dir `/tmp/bc-coexist/agentB` symlinks every shared asset **except**
`settings.json`/`models.json` (copied, so they diverge) and owns
`pi-auto-compact.json = {"threshold":30,"alignPiThreshold":false}`. The shared
`~/.pi/agent/pi-auto-compact.json` was untouched (md5 verified).

### Who fired first, and what each side logged

pi-auto-compact's only trigger is the `input` hook (auto-compact.ts:583). Its status string and pi's
`[compaction]` block both appear verbatim in the pane:

```
projected 38.1% · compacting before send        <- auto-compact.ts input hook
──────────────── [compaction] ────────────────
Compacted from 48,489 tokens (ctrl+o to expand)
```
(captured in `evidence/laneB2-pane-snapshot.txt`)

Ordered transcript (session `01a19f6c-5606-714d-991d-923987068d17`):

```
03:22:29 USER   Read corpus/chunk01 …
03:22:47 ASSIST total=25707  chunk01.txt lines=276
03:26:29 USER   Read corpus/chunk02 …
03:26:51 ASSIST total=37119  chunk02.txt lines=275
03:30:40.253 COMPACTION tokensBefore=37119 fromHook=false     <- pi-auto-compact (projected >= 30%)
03:30:40.281 USER   Read corpus/chunk04 …
03:31:01 ASSIST total=48489  chunk04 lines=276 / chunk05 lines=275
03:35:05.032 COMPACTION tokensBefore=48489 fromHook=false     <- pi-auto-compact
03:35:05.042 USER   Read corpus/chunk07 …
03:35:27 ASSIST total=37983  chunk07 lines=275 / chunk08 lines=274
03:37:23.730 COMPACTION tokensBefore=37983 fromHook=false     <- pi-auto-compact (recall prompt, "projected 38.1%")
```

bili's mate for each one (`bili.log`, same session id):
```
2026-11-02T22:30:40.317 native compaction boundary: archived 0 pre-compaction block(s);
                     pruned ref maps to 17 live raw id(s); 10 ref(s) dropped
2026-11-02T22:35:05.070 native compaction boundary: archived 0 pre-compaction block(s);
                     pruned ref maps to  9 live raw id(s); 26 ref(s) dropped
2026-11-02T22:37:23.758 native compaction boundary: archived 0 pre-compaction block(s);
                     pruned ref maps to  8 live raw id(s); 18 ref(s) dropped
```

**Which fired first:** pi-auto-compact, every time — its `input` hook compacts *before send*, so the
prompt that triggered it is submitted immediately after the compaction entry (`.253` → `.281`,
`.032` → `.042`). bili then reconciles on the following request, ~60 ms after pi writes the entry.

**Did bili fold?** **No.** `acp-compress-obs` count in lane B's window = **0**; no
`tool compress executed via plugin` line for this session. Because pi-auto-compact kept resetting the
meter, bili's growth gate was repeatedly reset (`growth=-11397/22500 (ref=14791…)` right after the first
boundary; highest growth reached 44,959) and never produced a fold. So this run exercises
**pi-compacts-under-bili**, not **both-fold**.

**Did bili's own API surface fire?**
| symbol from the brief | observed |
|---|---|
| `markNativeCompactionBoundary` | **not a log string** — internal function, `session.metadata.nativeCompactionBoundary={at,pendingRebase:true}`. Its *effect* is the boundary line above. |
| `reconcileNativeCompactionBoundary` | internal; logs only its Responses-lane message `reconciled ACP state after native Responses compact boundary` — **0 occurrences** (that path is Responses-only). |
| `resetSessionCompression` | internal, called inside reconcile; **no log line**. Its effect is visible as `pruned ref maps to N live raw id(s); M ref(s) dropped`. |
| `native compaction boundary: archived …` | **3 occurrences** ✅ |
| `acp-compress-obs` | 0 for lane B (2 folds existed for lane A) |
| `tool compress executed via plugin` | 0 for lane B (4 in the whole log, 2 of them lane A) |
| `cannot be modified` | **0 occurrences, entire log** |
| 4xx from upstream | **0** — the only match for my error grep was the benign co-resident-plugin `[warn] [conflict]` banner present from session start |

**Was any turn lost or corrupted?** **No turn was lost to compaction.** Six prompts were submitted and
all six answered correctly:
```
session: chunk01 lines=276 | chunk02 lines=275 | chunk04 lines=276
         chunk05 lines=275 | chunk07 lines=275 | chunk08 lines=274
ground:  chunk01 276 | chunk02 275 | chunk04 276 | chunk05 275 | chunk07 275 | chunk08 274   ALL MATCH
```
Two prompts of my eight were **never submitted**, and that is my driver's fault, not compaction's —
pi refused them at submit and said so in the pane:
```
✕ Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the …
```
`chunk03`/`chunk06` therefore never entered the transcript (`grep` confirms zero user messages for
them). The summaries even record it honestly: *"the user sequence is chunk01 → chunk02 → chunk04;
chunk03 was never requested"*.

**Anchor recall after compaction — passed, with an important caveat:**
```
(1) ANCHOR-B-ZEBRA-4417
(2) 88-12-63
```
Both correct against `corpus/chunk01.txt` (`ANCHOR-B-ZEBRA-4417 :: the vault combination is 88-12-63.`).
**Caveat (uncertainty):** all three compaction summaries themselves contain `ZEBRA`/`88-12-63`
(`anchorInSummary=true`, summary lengths 1,452 / 3,562 / 4,320 chars). So the recall does **not** prove
raw pre-compaction context survived the boundary — it is equally consistent with the answer coming from
pi's own summary. What *is* proven is that nothing was corrupted and the fact survived. I could not
separate "survived in raw history" from "survived in the summary" non-invasively, and did not try to
manufacture a discriminator.

---

## C. Reachability verdict

- **At the operator's configuration (1M window, threshold 78): a collision is not reachable.** Peak
  106,906 = 13.7 % of the 780,000 trigger; the fold-driven sawtooth means growth is bounded, not
  cumulative, and extrapolation puts 780k ~1,843 turns away.
- **At a forced 100k window / threshold 30: a collision is reachable in 2 turns** and is benign —
  3 pi-auto-compact compactions, 3 bili reconciliation boundaries, 0 folds from bili, 0 errors,
  0 lost turns, correct anchor recall.
- Therefore the conflict is **theoretical at this operator's configuration and real but non-destructive
  below it**. I did not manufacture a both-fold collision; bili never folded in lane B because
  pi-auto-compact's resets kept its growth gate from accumulating.

### What this run does *not* establish
- **No both-compressors-folded-in-one-session observation.** Not reachable within the budget: it needs
  a window where bili's growth gate (~45k observed) trips *and* pi's threshold trips, with neither
  resetting the other first. Lane A folds but never reaches 780k; lane B compacts but never folds.
- **`markNativeCompactionBoundary` / `resetSessionCompression` are not observable as log strings** —
  only their effects (`native compaction boundary: … pruned ref maps … ref(s) dropped`). I did not
  instrument the process to confirm the call path, so that attribution is inference from source plus
  the log effect, not a direct observation.
- **One model/one config/one day.** `deepseek-v4.1-flash-1017` only; a 1M-window lane with a *smaller*
  per-turn footprint would take even longer to reach 780k.
- **Lane A's aggressive bili folds are a cost concern, not a correctness concern** — I did not measure
  the cache-restart cost in dollars.

### Reproduction
```
# Lane A (operator config, 24 turns x 4 files)
PI_MODE=worker PI_PROFILE=worker PI_LANE_NAME=bc-coexist-A PI_BIN=/home/bitnom/.local/bin/pil \
  ./drive.sh A /tmp/bc-coexist/lane/sess-a.jsonl /tmp/bc-coexist/evidence/laneA-turns.tsv 24 4

# Lane B (throwaway agent dir, threshold 30, window 100k) — interactive, because the
# footer is the only authoritative read of pi's own meter and the input hook needs submits
PI_BIN=/tmp/bc-coexist/bin/pi-agentB ./node_modules/.bin/bili pi --thinking max
./driveB2.sh wE:p2J 8
```

### Files
| path | contents |
|---|---|
| `evidence/laneA-turns.tsv` | 24 rows, per-turn usage/folds (question A) |
| `evidence/laneB2-turns.tsv` | lane B (valid instrument) |
| `evidence/laneB-turns.tsv` | lane B first attempt — **invalid, 1.0M window, kept as the negative control** |
| `evidence/laneB2-pane-snapshot.txt` | footer, `[compaction]`, `projected …% · compacting before send`, submit refusal |
| `evidence/laneB2-mark.txt`, `laneB2-session.txt` | log offset + session id |
| `lane/sess-a.jsonl`, `lane/raw-B/` | session transcripts and raw event streams |
| `agentB/`, `bin/pi-agentB`, `drive*.sh` | instrument |
| `~/.local/state/billion-context/bili.log` | all bili evidence quoted above |

---

## Cleanup and preservation (post-run)

```
# both experiment herdr tabs closed
herdr tab close w1Z:t5   # bc-coexist-a  (lane A driver)
herdr tab close wE:t10   # bc-coexist-b  (lane B interactive)
# remaining bc-coexist tab is this run's own lane (bc-coexist-run2) — not an experiment lane

$ ps -eo pid,cmd | grep -E 'bili pi --thinking|bc-coexist' | grep -v grep   -> (none)
$ ss -ltn | grep -c 18787                                                   -> 0
$ md5sum ~/.pi/agent/settings.json ~/.pi/agent/pi-auto-compact.json
bdab3ba9562b9ac43bfdc0ce49612528  ~/.pi/agent/settings.json         # unchanged
f5295a8d4bece1e0eb3630be6e6e74ef  ~/.pi/agent/pi-auto-compact.json  # unchanged (threshold still 78)
```

Lane B's transcript was copied out of its runtime instance before anything could sweep it:
`lane/sess-b.jsonl` (484,417 bytes, 3 `"type":"compaction"` entries). The instance directory
`~/.pi-profile-switch/instances/launch-HDcFCO` is left in place deliberately — it is
launcher-managed runtime state and the brief forbids hand-editing `instances/launch-*`; the normal
runtime-cleanup sweep reclaims it. No process references it.

`/tmp/bc-coexist` retains all evidence: `FINDINGS.md`, `evidence/*.tsv`, `evidence/laneB2-pane-snapshot.txt`,
`lane/sess-a.jsonl`, `lane/sess-b.jsonl`, `lane/raw-B/`, `agentB/`, `bin/pi-agentB`, `drive*.sh`.

---

## Q3 — recall at scale

### Setup, and three instrument defects caught before any number was trusted

Corpus: `corpus/files/file1..8.md`, 367,221 bytes, 36 facts (19 `swarm-xxx` bead ids, 17 uuids), each
present exactly once — re-verified independently (`facts located: 36, duplicates: 0, missing: []`).
Question order = global record order, so `Qn` ↔ record `n` (asserted, not assumed).

**Defect 1 — read-tool truncation would have faked a 3/36 loss.** Three facts live past byte 50,000 in
their files (`swarm-c0z` @50,987 in file2; `958a9090-…` @51,752 in file6; `swarm-6ji` @55,502 in file1),
and pi's `read` truncates at ~50KB. A whole-file read would never have loaded them, and their absence
would have scored as compression loss. Every pass therefore used ≤300-line chunk reads (largest slice
41,942 B) and an assertion confirmed 18/18 slices, 0 errors, 0 duplicates.

**Defect 2 — a pre-fold baseline is not possible at operator configuration.** The corpus is ~92k tokens
and bili folds on *growth* (~22.5k gate at this model), so compression fires **during** ingestion — the
same reason lane A folded at turn 2. A true ceiling therefore requires compression off. Pass P0 ran with
`ACP_PASSTHROUGH=1` (raw relay): `folds_in_pass=0`, `passthrough` in 26 log lines, 18/18 reads, 0 errors.

**Defect 3 — the question set did not match the corpus's own labels (reported to the operator
mid-run; they regenerated it).** The corpus labels records **globally** (`file1` = records 1–5, `file2`
= 6–10, … `file8` = record 36) but the first `questions.txt` asked for six records per file for files
1–6, pointing 31/36 questions at non-existent `(file, record)` pairs. I used my own regenerated set with
global record numbering (`questions-v2.txt`), and proved the two labellings denote the **same 36 values
in the same order** (`36/36`, 0 disagreements) so the choice cannot bias a result.

Grading: `exact` = character-for-character; `plausible-wrong` = correct shape (regex-conformant
`swarm-[a-z0-9]{3}` or 36-char uuid), wrong characters; `absent` = no answer or explicit `UNKNOWN`;
`unrelated` = wrong shape or prose. Grader validated by re-reading raw event streams after it first
returned 0/36 — a grader bug (answers live in `turn_end`/`message_end`, not `entry`), not a lane result.

### The four counts

**Ceiling (P0, compression off, 0 folds):**
| exact | plausible-but-wrong | absent | unrelated |
|---|---|---|---|
| **36/36** | **0/36** | 0/36 | 0/36 |

The lane reads and recalls all 36 perfectly when nothing folds. Any loss below is attributable to
compression, not to reading or task comprehension.

**Confound-free folded runs (compression ON, verified fold, 18/18 slices):**

| pass | exact | plausible-wrong | absent | unrelated | folds | growth peak |
|---|---|---|---|---|---|---|
| P2 · `unconf`  | 26/36 | 10/36 | 0/36 | 0/36 | 3 | 40,241 / 22,500 |
| P3 · `unconf2` | 31/36 | 5/36  | 0/36 | 0/36 | 3 | 50,982 / 22,500 |
| P4 · `unconf3` | 17/36 | 19/36 | 0/36 | 0/36 | 4 | 50,982 / 22,500 |
| P5 · `unconf4` | 28/36 | 8/36  | 0/36 | 0/36 | 4 | 50,982 / 22,500 |
| **aggregate**  | **102/144 (70.8 %)** | **42/144 (29.2 %)** | **0/144** | **0/144** | | |

**`plausible-but-wrong` is 29.2 % with a denominator of 144 — not an impression.** Absent is **0** in
every confound-free pass: after a fold this lane does not say "I don't know", it invents.

### Fold evidence (a fold provably happened in every scored pass)

```
P2 unconf   2026-11-02T23:24:38.553 [acp-compress-obs] shrink 98% this-fold (~54402/55428 tok)
            foldPoint=m00004 blocks=6 anchor≈2753 tok · [warn: degenerate-fold]
            2026-11-02T23:24:38.559 tool compress executed via plugin (2989 chars, outcome=applied)
P3 unconf2  2026-11-02T23:29:30.066 [acp-compress-obs] shrink 98% this-fold (~52217/53234 tok)
            2026-11-02T23:29:30.071 tool compress executed via plugin (3469 chars, outcome=applied)
P0 ceiling  folds_in_pass=0   (control: passthrough=1, no fold — this is the negative control)
```
`meta`: `passthrough=0`, `folds_in_pass=3–4`, `compress_exec=1–2` per scored pass; bili's own effective
window line reads `effective window 1000000 -> 872000`.

### Plausible-but-wrong, verbatim — two distinct failure modes

8 of 42 are **shifted to another real value** (the record-neighbour answer):
```
unconf  Q4  exp=swarm-nwv  got=swarm-6ji      unconf3 Q3  exp=swarm-3m6  got=swarm-nwv
unconf  Q5  exp=swarm-6ji  got=swarm-vwr      unconf3 Q4  exp=swarm-nwv  got=swarm-3m6
unconf  Q6  exp=swarm-vwr  got=swarm-l7o
unconf  Q9  exp=swarm-7p5  got=swarm-c4z
unconf  Q10 exp=swarm-c0z  got=swarm-fyd
unconf  Q11 exp=swarm-c4z  got=swarm-i9f
```
34 of 42 are **invented**: correct shape, **absent from the corpus entirely** (verified: 0 of 34 appear
anywhere in the 367 KB text). All 26 beads match `^swarm-[a-z0-9]{3}$`; all 8 uuids are well-formed
36-char v4-shaped strings. Examples:
```
unconf   Q12 exp=swarm-fyd  got=swarm-9df     unconf3 Q20 exp=07b8230e-d7cf-4f22-a338-ef727894a4c1
unconf   Q13 exp=swarm-i9f  got=swarm-2zr                got=3f1c9a2e-5b7d-4c81-9a03-6d2e8f4b1c7a
unconf   Q14 exp=swarm-l7o  got=swarm-7tx     unconf4 Q21 exp=0e73b068-6eff-49c8-b600-5826afd2c6ab
unconf   Q15 exp=swarm-lr2  got=swarm-1qm                got=4c9f0d72-8b31-4a6e-b5d4-17e8c2a9f306
```
This is the operator's worst case, and it is the dominant mode: **a confidently-shaped value that exists
nowhere in the source**.

**Primary pass (P2 `unconf`) full table** — `evidence/q3-unconf-graded.json`:
```
 Q1 exact            exp=swarm-kbn  got=swarm-kbn      Q19 exact  exp=swarm-04j  got=swarm-04j
 Q2 exact            exp=swarm-8bk  got=swarm-8bk      Q20 exact  exp=07b8230e-…  got=07b8230e-…
 Q3 exact            exp=swarm-3m6  got=swarm-3m6      Q21 exact  exp=0e73b068-…  got=0e73b068-…
 Q4 plausible-wrong  exp=swarm-nwv  got=swarm-6ji      Q22 exact  exp=8152933b-…  got=8152933b-…
 Q5 plausible-wrong  exp=swarm-6ji  got=swarm-vwr      Q23 exact  exp=85eab8fc-…  got=85eab8fc-…
 Q6 plausible-wrong  exp=swarm-vwr  got=swarm-l7o      Q24 exact  exp=67aefda7-…  got=67aefda7-…
 Q7 exact            exp=swarm-c0l  got=swarm-c0l      Q25 exact  exp=79d5ec60-…  got=79d5ec60-…
 Q8 exact            exp=swarm-3fc  got=swarm-3fc      Q26 exact  exp=9f726694-…  got=9f726694-…
 Q9 plausible-wrong  exp=swarm-7p5  got=swarm-c4z      Q27 exact  exp=56557a9a-…  got=56557a9a-…
Q10 plausible-wrong  exp=swarm-c0z  got=swarm-fyd      Q28 exact  exp=3ab52dfd-…  got=3ab52dfd-…
Q11 plausible-wrong  exp=swarm-c4z  got=swarm-i9f      Q29 exact  exp=2a4fbf85-…  got=2a4fbf85-…
Q12 plausible-wrong  exp=swarm-fyd  got=swarm-9df      Q30 exact  exp=958a9090-…  got=958a9090-…
Q13 plausible-wrong  exp=swarm-i9f  got=swarm-2zr      Q31 exact  exp=458da9e1-…  got=458da9e1-…
Q14 plausible-wrong  exp=swarm-l7o  got=swarm-7tx      Q32 exact  exp=2c6c247e-…  got=2c6c247e-…
Q15 plausible-wrong  exp=swarm-lr2  got=swarm-1qm      Q33 exact  exp=eadb0ff3-…  got=eadb0ff3-…
Q16 exact            exp=swarm-pbn  got=swarm-pbn      Q34 exact  exp=e1251921-…  got=e1251921-…
Q17 exact            exp=swarm-5mr  got=swarm-5mr      Q35 exact  exp=726b0c6d-…  got=726b0c6d-…
Q18 exact            exp=swarm-brl  got=swarm-brl      Q36 exact  exp=60b6d591-…  got=60b6d591-…
```
(uuids elided for width only; the full 36-character values are in the graded JSON and in the DM.)

### Mechanism: what the fold summary actually kept

bili's fold is a model-authored summary, not a lossless index. Measured retention of the 36 facts
across the compress-tool payloads in each session:

| pass | summary calls | summary chars | full uuids kept | full bead ids kept |
|---|---|---|---|---|
| P0 ceiling | 0 | 0 | — (no fold) | — |
| P2 unconf  | 1 | 11,445 | 6/17 | 15/19 |
| P3 unconf2 | 1 | 17,223 | 1/17 | 14/19 |
| P4 unconf3 | 2 | 19,080 | 0/17 | 6/19 |
| P5 unconf4 | 2 | 6,386  | 0/17 | 15/19 |

Two consequences, both observed rather than inferred: (a) values the summary **kept** are recalled
exactly — uuids are all-or-nothing and largely survived in P2; (b) values it **dropped** are not
reported as missing but regenerated in the correct shape. One lane stated the mechanism itself:
*"uuids only as 8-character prefixes (`0e73b068…`, `9f726694…`, `56557a9a…`)"* — matching the measured
prefix retention.

### The confound I created and then removed (kept on record)

Pass P1 (`folded`) used my first prompt, which said *"Do not guess a plausible value."* It scored
**13/36 exact, 0/36 plausible-but-wrong, 23/36 absent** — a clean contiguous boundary (records 1–23
absent, 24–36 exact) that looks reassuring and is **not** a measurement of the failure mode the operator
asked about: the instruction suppressed confabulation by construction. Its 0% is an artifact of my
wording. Passes P2–P5 dropped that clause ("never write UNKNOWN, never skip a line") and the real number
is 29.2 %. P1 is retained as a negative control, as is an earlier invalid attempt (`foldperm`) where the
lane read only 16/18 slices and then refused to answer at all.

### What this number is not

- **One model** (`deepseek-v4.1-flash-1017`), **one config** (operator's, 1M window / threshold 78),
  **one day** (2026-11-02), **one corpus** (367 KB of real transcript prose, 36 synthetic-injection
  facts). Not a general compression-quality figure.
- **Not comparable to any vendor figure.** Different corpus, different task, different scoring. I make
  no comparison.
- **The four passes disagree a lot** (exact 17–31 of 36). With n=4 the aggregate is a point estimate with
  visibly wide spread; 29.2 % ± a wide interval, not 29.2 % precisely. n=144 counts 36 questions × 4
  correlated passes, so the *effective* independent sample is closer to 4 than 144 — the denominator is
  honest, the confidence it buys is not.
- **`plausible-but-wrong` is definition-sensitive.** I counted "correct shape, wrong characters". Under a
  stricter rule (also requiring the value to be a real fact elsewhere) the number falls to **8/144
  (5.6 %)** and every other miss becomes `unrelated`. Both numbers are in this file; I report 29.2 % as
  primary because it is the more conservative reading for an agent that cannot tell them apart.
- **Absence of a fold is the control, not the result.** P0's 36/36 proves reading and question-answering
  are sound at this scale; it does not mean compression is harmless in general.

### Reproduction

```
# ceiling (compression off)          # folded (compression on)
ACP_PASSTHROUGH=1 ./q3.sh ceiling    ./q3-strict.sh unconf     # + unconf2/3/4
python3 grade_q3.py <pass>
```
Artifacts: `evidence/q3-<pass>-{turn1,turn2}.json`, `-bili.log`, `-meta.txt`, `-graded.json`,
`-answer.txt`; sessions `lane/sess-q3-<pass>.jsonl`; drivers `q3.sh`, `q3-strict.sh`, `grade_q3.py`;
corrected question set `questions-v2.txt` / `questions-permissive.txt`.
