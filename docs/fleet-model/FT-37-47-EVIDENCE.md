# FT-37 / FT-47 — evidence corpus with attribution

**Snapshot:** `2026-11-10T08:03:25+00:00` · **839** session files · **110797** assistant messages · one traversal.

This is the **evidence half** only. It measures what is in the session record and says what cannot be measured. It does not propose or rank fixes; the mechanism half is owned elsewhere.

Everything here is read-only: nothing under `~/.pi/agent/` or the pi install was written, moved or deleted.

---

## 0. Answers to the four questions

1. **Vocabulary and frequency** — the operator's list is incomplete and unbounded in shape. Beyond `<thinking>` (raw substring in **95** files) and `<tool_answer>` (raw substring in **4** files; as a block-opener in assistant text in 2), the corpus carries `<analysis>`, `<summary>`, `<tool_call>`, `<tool_name>`, `<tool_result>`, `<result>`, `<output>`, `<COMMENTARY>`, `<invoke>`/`<parameter>`, `antml:invoke`/`antml:parameter`, `<think>`, and — the largest single family — **DeepSeek's own `｜｜DSML｜｜` markup tokens**. Full table in §2.
2. **Attribution** — 720 protocol-shaped messages across 61 sessions. Only **6 of 46** provider/model pairs leak any shape, and all 6 of them leak `<thinking>`. Per-message provider, model, api, timestamp and turn shape are in §3 and the appendix.
3. **Routing correlation** — **no.** Zero of the 720 protocol messages is preceded by a provider change, against a base rate of 114/109961 = 0.104%. More decisively, **45 (file, provider, model) groups contain both correctly parsed reasoning blocks and leaked `<thinking>` text** — the operator's "same session, both behaviours" observation, quantified. See §4, including what this does *not* rule out.
4. **Do the two shapes co-occur?** — **yes.** 18 sessions carry both `THINK` and `TOOLXML` leaks, 4 of those all three families. They share provider, model and turn shape. One defect, not two. §5.

---

## 1. Method — the traversal, stated with every count

```
root      ~/.pi/agent/sessions
walk      os.walk(root, followlinks=False), directory entries sorted, all depths
select    basename endswith ".jsonl"
parse     one JSON object per non-empty line; unparsable lines counted, not skipped silently
units     type=="message" and message.role=="assistant"
```

The corpus is **live**. Between my first count and the frozen pass it grew from 837 to 839 files; every fleet lane appends to it as it works. Therefore:

- All numbers in this report come from **one** traversal at `2026-11-10T08:03:25+00:00`. Earlier exploratory passes in the same session returned slightly smaller numbers (838 files, 110,620 messages) for exactly that reason and are not quoted here.
- A re-run will not reproduce these integers exactly. It will reproduce the ratios, the vocabulary and every per-file attribution.

### 1.1 Why a grep count and a corpus count differ

A raw substring search for `<thinking>` hits **95** files. It hits them because the string appears *anywhere*: in a tool result that grepped a file, in an agent's prose discussing the bug, in a report another lane wrote, in pi's own source pasted into a session. The operator's figure of 92 is a measurement of that layer, and it is reproducible — I measured 94 nine minutes earlier on a smaller corpus.

The defect, however, is a property of one container: a **`text` content block of an assistant message**. That is the only place the operator can see `<thinking>` rendered as prose. So this report separates three layers, and every table says which one it is:

| layer | what it counts | why it matters |
|---|---|---|
| **raw substring** | bytes anywhere in the file | what a `grep -l` gives you; inflated by discussion and tool output |
| **assistant text** | tag tokens inside assistant `text` blocks | the render surface; still includes quoted/code-fenced tags |
| **protocol-shaped** | assistant text blocks where the tag actually opens a block (§1.2) | the defect |

### 1.2 Classification rule (reproducible, and it has a known failure mode)

For each tag token in an assistant `text` block:

```
QUOTED    token lies inside a ``` fence or inside `inline code`
PROTOCOL  otherwise, and the token starts its block or its line,
          or it is a closing tag whose opening tag is absent from the same block,
          or it is a DeepSeek markup token
MENTION   otherwise (inline prose discussion of the tag)
```

Message-level level = PROTOCOL if any token in that block is PROTOCOL.

**Known failure mode.** The `line start` clause will misclassify a paragraph that begins a line with a quoted tag, e.g. a lane writing "`<thinking>` is leaking" with the tag at column 0 inside a bullet. I inspected samples from every file in the top of §3.3 by hand; the ones I checked were genuine — the block *is* the tag-delimited block and the body *is* reasoning prose. I did not hand-check all 720. Treat the PROTOCOL counts as an upper bound with a small, reviewed tail; treat the provider/model concentration in §3.1 as the robust finding, since it does not depend on that clause.

---

## 2. Vocabulary — every form that actually appears

### 2.1 Layer 1: raw substring, whole tree

| form | files | occurrences | note |
|---|---:|---:|---|
| `<thinking>` | 95 | 2075 | FT-37 shape; also quoted by agents |
| `</thinking>` | 75 | 3911 | close tag without match is the orphan fingerprint |
| `<think>` | 5 | 40 | short variant, present |
| `<tool_call>` | 7 | 75 | FT-47 shape |
| `<tool_answer>` | 4 | 70 | FT-47 shape, operator measured 1 |
| `<tool_result>` | 4 | 10 | FT-47 shape |
| `<tool_name>` | 2 | 7 | FT-47 shape (Anthropic-style XML) |
| `<invoke>` | 1 | 21 | Anthropic-style tool XML |
| `</invoke>` | 15 | 22026 | note the asymmetry with the open tag |
| `<parameter` | 16 | 7631 | Anthropic-style tool XML (attribute form) |
| `<analysis>` | 13 | 161 | foreign compaction format, not pi's |
| `<summary>` | 284 | 3070 | mostly pi's own replay wrapper, see §2.3 |
| `<result>` | 6 | 22 | tool-result-shaped prose |
| `<output>` | 5 | 25 | tool-result-shaped prose |
| `<COMMENTARY>` | 2 | 7 | DeepSeek channel tag |
| `<antml:invoke>` | 1 | 3 | Anthropic internal namespace verbatim |
| `<function_call>` | 2 | 6 | OpenAI-style function XML |
| `<｜｜DSML｜｜` | 3 | 12 | DeepSeek markup, open direction |
| `｜｜DSML｜｜` | 40 | 790 | DeepSeek markup, either direction |
| `<\|` | 27 | 202 | special-token prefix |

### 2.2 Layer 3: tag tokens inside assistant `text` blocks

Open/close asymmetry is itself evidence — a protocol the model half-emits, or one whose opening token was consumed before it reached `text`.

| family | tag | open | close | orphan closes | files (open) |
|---|---|---:|---:|---:|---:|
| TOOLXML | `parameter` | 1284 | 1551 | 267 | 7 |
| TOOLXML | `invoke` | 12 | 1110 | 1098 | 2 |
| THINK | `thinking` | 439 | 503 | 64 | 41 |
| COMPACT | `analysis` | 100 | 94 | 0 | 11 |
| COMPACT | `summary` | 101 | 90 | 0 | 11 |
| TOOLXML | `tool_call` | 10 | 5 | 0 | 4 |
| TOOLXML | `tool_answer` | 7 | 3 | 0 | 2 |
| TOOLXML | `result` | 2 | 4 | 2 | 1 |
| THINK | `think` | 1 | 4 | 3 | 1 |
| TOOLXML | `output` | 2 | 2 | 0 | 1 |
| TOOLXML | `COMMENTARY` | 2 | 1 | 0 | 2 |
| TOOLXML | `tool_result` | 2 | 1 | 0 | 2 |
| TOOLXML | `tool_name` | 1 | 1 | 0 | 1 |
| TOOLXML | `antml:invoke` | 1 | 1 | 0 | 1 |
| TOOLXML | `antml:parameter` | 1 | 1 | 0 | 1 |
| TOOLXML | `param` | 0 | 1 | 1 | 0 |
| TOOLXML | `commentary` | 0 | 1 | 1 | 0 |

### 2.3 DeepSeek markup tokens — the largest single family, and the strongest attribution clue

These appear **verbatim** in assistant `text` blocks, in the form DeepSeek itself emits:

| token form | occurrences |
|---|---:|
| `</｜｜DSML｜｜ parameter>` | 96 |
| `</｜｜DSML｜｜ invoke>` | 85 |
| `</｜｜DSML｜｜ calls>` | 65 |
| `<｜DSML｜ calls>` | 28 |
| `</｜DSML｜ parameter>` | 7 |
| `</｜DSML｜ invoke>` | 4 |
| `<｜｜DSML｜｜ invoke>` | 2 |
| `</｜DSML｜ calls>` | 1 |
| `</｜｜DSML｜｜parameter>` | 1 |
| `</｜｜DSML｜｜invoke>` | 1 |
| `</｜｜DSML｜｜function_calls>` | 1 |

Read the first three rows together: `</｜｜DSML｜｜ parameter>`, `</｜｜DSML｜｜ invoke>`, `</｜｜DSML｜｜ calls>` are **closing** forms of DeepSeek's native tool-call vocabulary. There are no corresponding opening forms in `text` at all. The model is emitting the *tail* of a tool-call protocol pi does not speak, and pi renders it as prose.

`<summary>` deserves the caveat: pi itself wraps every replayed compaction summary in `<summary>` … `</summary>` (`COMPACTION_SUMMARY_PREFIX` / `_SUFFIX` in `dist/core/messages.js`). Its 284-file raw count is therefore mostly pi's own furniture plus agents discussing it, which is why it does not appear in the protocol table as a leak of concern. `<analysis>` does not have that excuse — see §2.4.

### 2.4 `<analysis>` / `<summary>` are not pi's format

pi's summarization prompt (`dist/core/compaction/compaction.js:379`, `SUMMARIZATION_PROMPT`) demands markdown headings — `## Goal`, `## Constraints & Preferences`, `## Progress`. It does not ask for `<analysis>` or `<summary>`. A model that answers with `<analysis>…</analysis><summary>…</summary>` is following a **different harness's** compaction contract. That makes this family a genuine foreign-protocol emission, and it is the family that fires during compaction turns (97 messages, 11 sessions).

---

## 3. Attribution

### 3.1 By provider and model — only 6 of 46 pairs leak

`parsed-think` = messages that carried a proper `thinking` content block. `THINK leak` = protocol-shaped `<thinking>` in assistant text. The two columns existing side by side in one row is the whole of FT-37.

| provider | model | msgs | parsed-think | THINK leak | think leak % | TOOLXML leak | COMPACT leak |
|---|---|---:|---:|---:|---:|---:|---:|
| `subrouter-deepseek-flash` | `deepseek-v4.1-flash-1017` | 37210 | 31667 | 135 | 0.36% | 166 | 95 |
| `subtoken-gemini` | `gemini-3.8-flash-high` | 2937 | 331 | 269 | 9.16% | 0 | 0 |
| `subrouter` | `deepseek-v4.1-flash-1017` | 46543 | 25760 | 16 | 0.03% | 15 | 2 |
| `subrouter-argon` | `gemini-4-argon` | 194 | 63 | 11 | 5.67% | 0 | 0 |
| `relayfast` | `gpt-6.1-sol` | 8780 | 5557 | 9 | 0.10% | 0 | 0 |
| `subrouter` | `mimo-v2.6-flash` | 857 | 829 | 1 | 0.12% | 1 | 0 |
| `openrouter` | `xiaomi/mimo-v2.6-flash:nitro` | 1278 | 1251 | 0 | 0.00% | 0 | 0 |
| `subrouter-gpt` | `gpt-6.1-sol` | 4542 | 2034 | 0 | 0.00% | 0 | 0 |
| `opencode-go` | `space-bunny` | 3351 | 1471 | 0 | 0.00% | 0 | 0 |

The remaining **40** provider/model pairs recorded **zero** protocol leaks, across 14276 messages. The property is concentrated, not uniform — which is the opposite of what a random-rendering bug would look like.

Two pairs need naming plainly:

- `subtoken-gemini` / `gemini-3.8-flash-high` — **9.16%** of its messages leak `<thinking>`, and only 331 of its 2,937 messages even produce a parsed thinking block. This is the most broken surface in the fleet by rate.
- `subrouter-deepseek-flash` / `deepseek-v4.1-flash-1017` — the largest volume in the corpus (37,210 messages) and the source of 166 of the 182 `TOOLXML` leaks, but only 0.36% `<thinking>`.

Note `subrouter` and `subrouter-deepseek-flash` are **two different provider IDs carrying the same model**. Both leak. That detail matters in §4.

### 3.2 Turn shape — leaks are not only on tool turns

| family | protocol msgs | with a real thinking block | with a real toolCall | pure prose (no toolCall) |
|---|---:|---:|---:|---:|
| THINK | 441 | 93 | 373 | 68 |
| TOOLXML | 182 | 163 | 79 | 103 |
| COMPACT | 97 | 51 | 89 | 8 |

The "with a real thinking block" column for `THINK` is the operator's observation in one number: these are messages where pi **did** parse reasoning into a collapsible block *and* rendered a second reasoning payload as prose, in the same message.

### 3.3 Per-file attribution — `<thinking>`

Every file, every leaking provider/model in that file, first and last leak timestamp, and whether that file also contains correctly parsed reasoning.

| leak msgs | provider/model | first leak (UTC) | last leak (UTC) | parsed-think in file | file |
|---:|---|---|---|---:|---|
| 180 | subtoken-gemini/gemini-3.8-flash-high | 2026-10-12T22:17:16 | 2026-10-12T23:04:09 | 5 | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-12T21-56-49-063Z_01a1321e-4d27-7499-a110-322e2a41d380.jsonl` |
| 86 | subtoken-gemini/gemini-3.8-flash-high | 2026-10-12T21:15:35 | 2026-10-12T21:50:53 | 12 | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-12T10-36-41-978Z_01a12faf-a279-76d4-8826-9e9c37024ec1.jsonl` |
| 21 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-03T21:11:21 | 2026-11-05T01:43:41 | 1028 | `--home-bitnom-Documents-Fleet--/2026-11-03T19-59-41-643Z_01a1a2fe-fa4a-751a-b845-bbde78fbf067.jsonl` |
| 20 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-03T20:49:11 | 2026-11-05T01:04:33 | 1192 | `--home-bitnom-Documents-Assistant--/2026-11-03T19-59-42-650Z_01a1a2fe-fe39-7613-80bd-b47e9ef89eb2.jsonl` |
| 17 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T03:35:56 | 2026-11-10T06:48:17 | 2041 | `--home-bitnom-Documents-Fleet--/2026-11-08T22-47-52-177Z_01a1bd58-be71-7597-8409-ed3358812bc9.jsonl` |
| 14 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T03:14:39 | 2026-11-10T07:59:16 | 1475 | `--home-bitnom-.overlord--/2026-11-08T22-48-04-177Z_01a1bd58-ed51-70c2-97a7-79354c8745c6.jsonl` |
| 11 | subrouter-argon/gemini-4-argon | 2026-11-06T11:36:09 | 2026-11-06T11:42:30 | 63 | `--home-bitnom-Code-herdr--/2026-11-06T10-30-20-988Z_01a1b068-ce3c-7217-ba2f-ac2552fc77c4.jsonl` |
| 11 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T21:55:33 | 2026-11-07T01:39:07 | 249 | `--home-bitnom-Documents-Fleet--/2026-11-06T20-23-28-291Z_01a1b287-d323-7797-99f0-f2deb13673d2.jsonl` |
| 7 | relayfast/gpt-6.1-sol | 2026-10-11T21:31:16 | 2026-10-11T22:05:02 | 587 | `--home-bitnom-Code-apothic-monorepo-workspace-apps-autopod-solid-vastai--/2026-10-09T00-58-14-884Z_01a11e2a-f7e4-76a7-ae3b-3499d07c5f28.jsonl` |
| 6 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T06:34:03 | 2026-11-10T07:11:02 | 90 | `--home-bitnom-Code-yellowstone-src-herdr-plugins-unblock--/2026-11-10T06-30-12-536Z_01a1c426-6337-75b6-b63a-235b6606c97e.jsonl` |
| 5 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T18:45:54 | 2026-11-06T19:04:19 | 82 | `--home-bitnom-Documents-Fleet--/2026-11-06T10-44-38-632Z_01a1b075-e467-7797-99f0-f2dc7f05d333.jsonl` |
| 4 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T07:57:07 | 2026-11-09T23:05:11 | 65 | `--home-bitnom-.sysops--/2026-11-09T07-46-00-836Z_01a1bf45-6e03-7440-8e70-20cede8b2a03.jsonl` |
| 4 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-19T17:09:44 | 2026-10-19T17:22:28 | 72 | `--home-bitnom-Documents-7-OH-mgm-15--/2026-10-19T16-34-16-725Z_01a15503-8615-765d-8a74-94f52d419a8b.jsonl` |
| 4 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T07:54:47 | 2026-11-10T07:57:02 | 39 | `--home-bitnom-Documents-Fleet--/2026-11-10T07-48-44-737Z_01a1c46e-4a40-7251-a102-98f5778767f8.jsonl` |
| 3 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-07T19:51:44 | 2026-11-07T19:54:50 | 106 | `--home-bitnom-.overlord--/2026-11-07T09-41-38-540Z_01a1b562-926b-71a4-876a-189ae64dfc36.jsonl` |
| 3 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T07:16:50 | 2026-11-09T07:29:24 | 66 | `--home-bitnom-.sysops--/2026-11-02T05-59-17-920Z_01a19ad7-36a0-751c-a1f4-88a5fdb053fc.jsonl` |
| 3 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T23:05:44 | 2026-10-28T23:52:51 | 439 | `--home-bitnom-Code-herdr-voice-linux--/2026-10-27T15-00-14-628Z_01a17de0-4ea4-707a-8b78-102c7059f572.jsonl` |
| 3 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T07:04:56 | 2026-11-10T08:01:19 | 133 | `--home-bitnom-Code-yellowstone--/2026-11-10T05-38-54-226Z_01a1c3f7-6a91-755a-b8ce-2c1c382703eb.jsonl` |
| 3 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T07:53:10 | 2026-11-10T07:59:10 | 34 | `--home-bitnom-Documents-Fleet--/2026-11-10T07-48-44-739Z_01a1c46e-4a43-70df-ac1c-7f97b794acdb.jsonl` |
| 3 | subtoken-gemini/gemini-3.8-flash-high | 2026-10-13T07:31:47 | 2026-10-13T07:31:55 | 2 | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-13T07-27-57-124Z_01a13429-30c4-756a-a575-53f44696ec98.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-01T19:23:22 | 2026-11-01T20:44:04 | 768 | `--home-bitnom-.overlord--/2026-11-01T04-20-42-751Z_01a19556-987f-71a3-ad8d-305f05865280.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-03T21:18:27 | 2026-11-04T00:16:45 | 406 | `--home-bitnom-.overlord--/2026-11-03T19-59-42-792Z_01a1a2fe-febc-7603-8899-bc58ddd4da57.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017<br>subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T22:22:49 | 2026-10-29T06:04:14 | 343 | `--home-bitnom-.pi--/2026-10-28T22-17-15-682Z_01a18496-c4a2-71e2-8242-e0594d509cff.jsonl` |
| 2 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-24T09:13:57 | 2026-10-24T09:14:28 | 100 | `--home-bitnom-Code-apothic-monorepo-workspace-apps-autopod-solid-vastai--/2026-10-24T01-14-32-171Z_01a16b79-456a-70b9-886e-f9ea9d206359.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T06:38:46 | 2026-11-06T06:42:51 | 153 | `--home-bitnom-Code-herdr--/2026-11-06T06-03-55-353Z_01a1af74-e259-7300-97f3-fb1123b32327.jsonl` |
| 2 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-26T22:49:04 | 2026-10-26T22:49:43 | 64 | `--home-bitnom-Code-sibyl-work-sibyl-snap--/2026-10-26T21-30-31-667Z_01a17a1f-4372-742c-96c1-c15b5e6a9c06.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T03:32:10 | 2026-11-09T04:00:29 | 883 | `--home-bitnom-Code-yellowstone--/2026-11-08T13-11-01-943Z_01a1bb48-a236-7482-91d2-33bf165b0e02.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T00:29:22 | 2026-11-10T01:36:05 | 58 | `--home-bitnom-Documents-Assistant--/2026-11-10T00-25-39-937Z_01a1c2d8-a360-72f9-bb25-7efe13696944.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-10-29T20:49:18 | 2026-10-29T20:49:37 | 68 | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-23T23-01-01-345Z_01a16aff-0921-74c9-bb06-3925475ba62e.jsonl` |
| 1 | subrouter/mimo-v2.6-flash | 2026-10-12T22:11:50 | 2026-10-12T22:11:50 | 113 | `--home-bitnom--/2026-10-12T00-04-16-912Z_01a12d6c-a390-75b3-8362-5ce178dd1d56.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-10-29T08:27:53 | 2026-10-29T08:27:53 | 170 | `--home-bitnom-.overlord--/2026-10-29T07-03-16-085Z_01a18678-5774-7027-b31e-9c4022e308f9.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-04T23:29:00 | 2026-11-04T23:29:00 | 2316 | `--home-bitnom-.overlord--/2026-11-02T04-04-22-602Z_01a19a6d-ffc9-74a1-836b-bef3088abb0f.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T19:13:29 | 2026-11-06T19:13:29 | 48 | `--home-bitnom-.overlord--/2026-11-06T19-02-24-379Z_01a1b23d-9b7b-775a-8009-4e87191dbf64.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-27T00:53:42 | 2026-10-27T00:53:42 | 53 | `--home-bitnom-.pi--/2026-10-26T23-37-31-441Z_01a17a93-8830-72a4-8235-dd23b7ca75cc.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-27T00:52:19 | 2026-10-27T00:52:19 | 77 | `--home-bitnom-.pi--/2026-10-26T23-51-03-627Z_01a17a9f-ecca-7288-ba69-866ee643fc20.jsonl` |
| 1 | relayfast/gpt-6.1-sol | 2026-10-20T21:42:56 | 2026-10-20T21:42:56 | 1907 | `--home-bitnom-Code-apothic-monorepo-workspace-apps-autopod-solid-vastai--/2026-10-17T21-11-32-081Z_01a14bb4-a3f1-71f1-9888-0cf524462db8.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-04T22:28:26 | 2026-11-04T22:28:26 | 123 | `--home-bitnom-Code-pi-auto-translate--/2026-11-04T22-14-08-546Z_01a1a8a0-6da2-7568-87b3-fd54f5dc1a81.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-26T23:13:13 | 2026-10-26T23:13:13 | 79 | `--home-bitnom-Code-sibyl-work-sibyl-keys--/2026-10-26T21-32-28-249Z_01a17a21-0ad6-71a9-b6b1-0e283c325ed8.jsonl` |
| 1 | relayfast/gpt-6.1-sol | 2026-10-10T10:30:08 | 2026-10-10T10:30:08 | 591 | `--home-bitnom-Code-sub2api--/2026-10-09T16-05-21-492Z_01a12169-73d4-760b-9e29-8ba66630e4c8.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-19T17:15:15 | 2026-10-19T17:15:15 | 109 | `--home-bitnom-Documents-7-OH-7-oh-market-research--/2026-10-19T15-04-07-970Z_01a154b0-fe22-777d-9e07-879912ed5610.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T19:02:44 | 2026-11-06T19:02:44 | 55 | `--home-bitnom-Documents-Assistant--/2026-11-06T18-58-55-767Z_01a1b23a-6c96-7673-895d-4325ad791325.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-07T21:28:59 | 2026-11-07T21:28:59 | 181 | `--home-bitnom-Documents-Fleet--/2026-11-07T09-41-24-612Z_01a1b562-5c03-731c-b0dd-7dcfda6a915c.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-08T14:40:39 | 2026-11-08T14:40:39 | 295 | `--home-bitnom-Documents-Fleet--/2026-11-08T06-59-06-601Z_01a1b9f4-20e8-7597-8409-ed2c2afeb032.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T08:01:46 | 2026-11-10T08:01:46 | 14 | `--home-bitnom-Documents-Fleet--/2026-11-10T08-00-45-696Z_01a1c479-4a80-75d4-899e-7ff9d5d3489c.jsonl` |

**44 files.** Total 441 messages.

### 3.4 Per-file attribution — tool-protocol family

| leak msgs | provider/model | first leak (UTC) | last leak (UTC) | file |
|---:|---|---|---|---|
| 39 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T01:08:21 | 2026-11-10T06:32:52 | `--home-bitnom-.overlord--/2026-11-08T22-48-04-177Z_01a1bd58-ed51-70c2-97a7-79354c8745c6.jsonl` |
| 37 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T00:53:33 | 2026-11-10T07:00:24 | `--home-bitnom-Documents-Fleet--/2026-11-08T22-47-52-177Z_01a1bd58-be71-7597-8409-ed3358812bc9.jsonl` |
| 28 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-03T21:11:21 | 2026-11-05T01:43:41 | `--home-bitnom-Documents-Fleet--/2026-11-03T19-59-41-643Z_01a1a2fe-fa4a-751a-b845-bbde78fbf067.jsonl` |
| 17 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-04T22:55:57 | 2026-11-05T01:05:11 | `--home-bitnom-.overlord--/2026-11-02T04-04-22-602Z_01a19a6d-ffc9-74a1-836b-bef3088abb0f.jsonl` |
| 14 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-04T23:41:34 | 2026-11-05T01:04:33 | `--home-bitnom-Documents-Assistant--/2026-11-03T19-59-42-650Z_01a1a2fe-fe39-7613-80bd-b47e9ef89eb2.jsonl` |
| 8 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-07T22:50:54 | 2026-11-08T00:00:57 | `--home-bitnom-.overlord--/2026-11-07T22-00-34-218Z_01a1b807-14aa-71a4-876a-18a05090100f.jsonl` |
| 7 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-09T00:53:27 | 2026-11-09T04:00:29 | `--home-bitnom-Code-yellowstone--/2026-11-08T13-11-01-943Z_01a1bb48-a236-7482-91d2-33bf165b0e02.jsonl` |
| 3 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T16:11:38 | 2026-10-28T21:03:25 | `--home-bitnom-Code-herdr-voice-linux--/2026-10-27T15-00-14-628Z_01a17de0-4ea4-707a-8b78-102c7059f572.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-07T19:54:50 | 2026-11-07T20:09:17 | `--home-bitnom-.overlord--/2026-11-07T09-41-38-540Z_01a1b562-926b-71a4-876a-189ae64dfc36.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017<br>subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T23:04:36 | 2026-10-29T06:04:14 | `--home-bitnom-.pi--/2026-10-28T22-17-15-682Z_01a18496-c4a2-71e2-8242-e0594d509cff.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T06:25:41 | 2026-11-06T06:39:41 | `--home-bitnom-Code-herdr--/2026-11-06T06-03-55-353Z_01a1af74-e259-7300-97f3-fb1123b32327.jsonl` |
| 2 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T22:56:22 | 2026-11-06T22:58:54 | `--home-bitnom-Documents-Fleet--/2026-11-06T20-23-28-291Z_01a1b287-d323-7797-99f0-f2deb13673d2.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T13:03:22 | 2026-10-28T13:03:22 | `--home-bitnom--/2026-10-28T03-29-26-034Z_01a1808e-3611-77be-b6cc-1fe071605200.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-01T23:46:42 | 2026-11-01T23:46:42 | `--home-bitnom-.overlord--/2026-11-01T04-20-42-751Z_01a19556-987f-71a3-ad8d-305f05865280.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-27T00:52:19 | 2026-10-27T00:52:19 | `--home-bitnom-.pi--/2026-10-26T23-51-03-627Z_01a17a9f-ecca-7288-ba69-866ee643fc20.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T19:58:23 | 2026-10-28T19:58:23 | `--home-bitnom-.pi--/2026-10-28T17-51-45-518Z_01a183a3-b16e-7760-a3c4-7cf8d0f46d29.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-24T09:14:41 | 2026-10-24T09:14:41 | `--home-bitnom-Code-apothic-monorepo-workspace-apps-autopod-solid-vastai--/2026-10-24T01-14-32-171Z_01a16b79-456a-70b9-886e-f9ea9d206359.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-10-30T05:03:18 | 2026-10-30T05:03:18 | `--home-bitnom-Code-apothic-monorepo-workspace-tooling-pi-pretty-tui--/2026-10-30T02-33-02-225Z_01a18aa7-4c11-7324-be95-d943e11e8ff3.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T22:01:07 | 2026-10-28T22:01:07 | `--home-bitnom-Code-herdr-voice-linux--/2026-10-28T21-45-38-187Z_01a18479-d08a-7709-afb0-2c9c2829f511.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T22:55:29 | 2026-10-28T22:55:29 | `--home-bitnom-Code-herdr-voice-linux--/2026-10-28T22-07-15-537Z_01a1848d-9c51-74de-bc9b-de179d6eae9b.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T23:58:49 | 2026-10-28T23:58:49 | `--home-bitnom-Code-herdr-voice-linux--/2026-10-28T23-51-56-389Z_01a184ed-72e5-713b-a7e8-a6bb8d57db2a.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T18:33:09 | 2026-10-28T18:33:09 | `--home-bitnom-Code-herdr-voice-linux-lanes-orb--/2026-10-28T16-13-16-107Z_01a18349-85ca-7584-af18-5df445cf5e12.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T18:19:22 | 2026-10-28T18:19:22 | `--home-bitnom-Code-herdr-voice-linux-lanes-x11--/2026-10-28T16-13-19-105Z_01a18349-9181-7402-a8a6-2b937c22164e.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-06T21:56:57 | 2026-11-06T21:56:57 | `--home-bitnom-Code-lfm3--/2026-11-05T23-15-52-867Z_01a1adff-4fa3-75f7-9c1f-86bdb1486587.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-28T17:01:12 | 2026-10-28T17:01:12 | `--home-bitnom-Code-open-surrealdb-ds--/2026-10-24T21-13-30-449Z_01a16fc2-f650-73c8-9226-ce4879a22c47.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-10-29T08:50:22 | 2026-10-29T08:50:22 | `--home-bitnom-Code-sibyl-work--/2026-10-24T19-55-22-461Z_01a16f7b-6ddd-70cb-b46c-f8ef404ac841.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T08:01:19 | 2026-11-10T08:01:19 | `--home-bitnom-Code-yellowstone--/2026-11-10T05-38-54-226Z_01a1c3f7-6a91-755a-b8ce-2c1c382703eb.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-10T00:32:31 | 2026-11-10T00:32:31 | `--home-bitnom-Documents-Assistant--/2026-11-10T00-25-39-937Z_01a1c2d8-a360-72f9-bb25-7efe13696944.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-01T19:23:45 | 2026-11-01T19:23:45 | `--home-bitnom-Documents-Fleet--/2026-11-01T07-01-38-254Z_01a195e9-ed4c-7703-b991-fb995e7cd40d.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-07T20:38:15 | 2026-11-07T20:38:15 | `--home-bitnom-Documents-Fleet--/2026-11-07T09-41-24-612Z_01a1b562-5c03-731c-b0dd-7dcfda6a915c.jsonl` |
| 1 | subrouter-deepseek-flash/deepseek-v4.1-flash-1017 | 2026-11-08T21:04:02 | 2026-11-08T21:04:02 | `--home-bitnom-Documents-Fleet--/2026-11-08T14-50-16-128Z_01a1bba3-7cbf-7597-8409-ed30272cacc9.jsonl` |
| 1 | subrouter/mimo-v2.6-flash | 2026-10-11T20:18:48 | 2026-10-11T20:18:48 | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-11T15-24-18-334Z_01a12b90-961e-76c9-b637-3c72f01eb3e9.jsonl` |
| 1 | subrouter/deepseek-v4.1-flash-1017 | 2026-10-24T04:17:19 | 2026-10-24T04:17:19 | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-23T23-01-01-345Z_01a16aff-0921-74c9-bb06-3925475ba62e.jsonl` |

**33 files.** Total 182 messages. Note that this table is almost entirely one model: `deepseek-v4.1-flash-1017` under two provider IDs.

---

## 4. The routing question — the crux of FT-37

### 4.1 What the session record actually contains

Every assistant message records `provider`, `model`, `api` and usually `responseModel`. Per pi's `docs/virtual-models.md` §"Recorded in": *assistant messages name the physical model*, so these fields are the physical route that answered, not the virtual selection. Routing is therefore measurable **per message**, without inferring anything from `model_change` entries.

What the record does **not** contain: the upstream host or endpoint behind a `subrouter-*` provider ID. This is the crux, and §4.4 states it as a limit rather than papering over it.

### 4.2 Test A — is a leak adjacent to a provider change?

| | count |
|---|---:|
| assistant messages with a predecessor | 109961 |
| of those, provider differs from predecessor | 114 (0.104%) |
| protocol messages (all families) | 720 |
| protocol messages whose predecessor had a different provider | **0** |

**Result: no correlation.** Provider changes are rare in this corpus — 114 in 109,961 messages — and not one of them precedes a leak. Under the base rate you would expect ~0.7 of the 720 leak messages to follow a provider change; observing 0 is unremarkable, so the honest statement is *no signal*, not *anti-correlation*.

**This falsifies the stated mechanism, not the underlying suspicion.** If mid-session rerouting between pi provider IDs caused the leak, the leak would be concentrated immediately after the 114 provider changes. It is not: leaks occur deep inside runs of a single provider.

### 4.3 Test B — same provider, same model, both behaviours

This is the decisive one, because it is the operator's own observation made arithmetic.

| | count |
|---|---:|
| (file, provider, model) groups with any `<thinking>` leak | 45 |
| … of which **also** contain correctly parsed thinking blocks | **45** |
| distinct files involved | 44 |

Table, largest first — note the ratio column, which is why "concentrated" and "mixed" are both true:

| leak | parsed-think | msgs | provider/model | file |
|---:|---:|---:|---|---|
| 180 | 5 | 195 | `subtoken-gemini/gemini-3.8-flash-high` | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-12T21-56-49-063Z_01a1321e-4d27-7499-a110-322e2a41d380.jsonl` |
| 86 | 12 | 312 | `subtoken-gemini/gemini-3.8-flash-high` | `--home-bitnom-Documents-Gemini-Accounts--/2026-10-12T10-36-41-978Z_01a12faf-a279-76d4-8826-9e9c37024ec1.jsonl` |
| 21 | 1028 | 1067 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-Documents-Fleet--/2026-11-03T19-59-41-643Z_01a1a2fe-fa4a-751a-b845-bbde78fbf067.jsonl` |
| 20 | 1192 | 1268 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-Documents-Assistant--/2026-11-03T19-59-42-650Z_01a1a2fe-fe39-7613-80bd-b47e9ef89eb2.jsonl` |
| 17 | 2041 | 2373 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-Documents-Fleet--/2026-11-08T22-47-52-177Z_01a1bd58-be71-7597-8409-ed3358812bc9.jsonl` |
| 14 | 1475 | 1603 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-.overlord--/2026-11-08T22-48-04-177Z_01a1bd58-ed51-70c2-97a7-79354c8745c6.jsonl` |
| 11 | 63 | 185 | `subrouter-argon/gemini-4-argon` | `--home-bitnom-Code-herdr--/2026-11-06T10-30-20-988Z_01a1b068-ce3c-7217-ba2f-ac2552fc77c4.jsonl` |
| 11 | 249 | 461 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-Documents-Fleet--/2026-11-06T20-23-28-291Z_01a1b287-d323-7797-99f0-f2deb13673d2.jsonl` |
| 7 | 587 | 878 | `relayfast/gpt-6.1-sol` | `--home-bitnom-Code-apothic-monorepo-workspace-apps-autopod-solid-vastai--/2026-10-09T00-58-14-884Z_01a11e2a-f7e4-76a7-ae3b-3499d07c5f28.jsonl` |
| 6 | 90 | 156 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-Code-yellowstone-src-herdr-plugins-unblock--/2026-11-10T06-30-12-536Z_01a1c426-6337-75b6-b63a-235b6606c97e.jsonl` |
| 5 | 82 | 179 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-Documents-Fleet--/2026-11-06T10-44-38-632Z_01a1b075-e467-7797-99f0-f2dc7f05d333.jsonl` |
| 4 | 65 | 110 | `subrouter-deepseek-flash/deepseek-v4.1-flash-1017` | `--home-bitnom-.sysops--/2026-11-09T07-46-00-836Z_01a1bf45-6e03-7440-8e70-20cede8b2a03.jsonl` |

Read the two ends of that table. The first row is 180 leaks against only 5 parsed blocks — a surface that almost never produces a parseable response. The last rows are the opposite: hundreds or thousands of parsed blocks and still a leak. Both extremes sit inside a single (file, provider, model) group, so neither is explained by the provider label alone.

**All 45 groups that leak `<thinking>` also contain correctly parsed thinking blocks.** There is no group in this corpus where a provider/model only ever leaks. The mixed behaviour is universal, not an artefact of one broken session — which is precisely why a stable per-provider format difference cannot explain it, and why the variation must happen **faster than the provider label**.


### 4.4 What this does and does not establish

Established by the record:

- No leak is adjacent to a provider-ID change (§4.2).
- Leaks and clean parsing interleave under a constant provider ID and model (§4.3).
- The leak rate is provider-dependent, spanning 0.00% to 9.16% (§3.1) — so provider identity does matter at the level of *baseline propensity*.

**Not** established, and this is the honest boundary:

- A server-side upstream swap behind one `subrouter-*` provider ID is **invisible** in the session record. `subrouter` and `subrouter-deepseek-flash` are already two IDs for one model, which shows the naming layer is not a faithful map of upstreams. So "subrouter rotates upstreams per request" remains consistent with everything measured here — it just cannot be tested from the corpus.
- Distinguishing "upstream swap" from "the model itself intermittently emits markup" requires a signal the session does not store: an upstream identifier, a request ID that maps to a host, or response headers. None is present per message.

### 4.5 Signals I tested and that failed

Recording these so the mechanism half does not re-run them:

| signal | hypothesis | result |
|---|---|---|
| `provider_changed_from_prev` | routing change triggers leak | 0 of 720 (§4.2) — dead |
| `responseId` presence | leaking upstream omits an id | present in 100% of leaks vs 98.8% of clean — dead |
| `usage.reasoning > 0` | unparsed reasoning is still accounted | 0 for every gemini leak, nonzero for some deepseek leaks — **inconsistent, unusable as a detector** |
| `api` field | leak tracks a specific wire API | every leaking message is `openai-completions`; so is the clean majority — no discrimination |
| `responseModel` | concrete upstream model differs | equals `model` throughout the leaking groups — dead |
| `thinkingSignature` | parse path is visible on parsed blocks | `reasoning_content` (60,687), Anthropic-style arrays (1,537), `reasoning` (1,118) — describes *parsed* blocks only, silent on leaks |

---

## 5. Do the two shapes co-occur? — one defect or two

Session-level co-occurrence of protocol families:

| families present in session | sessions |
|---|---:|
| THINK | 21 |
| TOOLXML | 15 |
| THINK, TOOLXML | 14 |
| COMPACT, THINK | 5 |
| COMPACT, THINK, TOOLXML | 4 |
| COMPACT | 2 |

**18 sessions carry both `<thinking>` and tool-protocol leaks**, and 4 of those carry the compaction family too. The overlap is not incidental:

- The two shapes share provider and model. 181 of 182 `TOOLXML` leaks are `deepseek-v4.1-flash-1017` (the single exception is one `mimo-v2.6-flash` message); so are 151 of the 441 `<thinking>` leaks.
- They share turn shape. Both appear on turns that also carry a real `toolCall` (373 of 441 `THINK`, 79 of 182 `TOOLXML`) — the renderer produced the tool call correctly and still printed protocol markup as prose.
- The DeepSeek token family explains the link mechanically: `</｜｜DSML｜｜ calls>` is the *closing* token of the same native tool-call protocol whose opening half the model emits as `<tool_call>`/`<invoke>`/`<parameter>`. `<thinking>` is the reasoning half of that same protocol.

**Verdict for the mechanism half: one defect.** A model emits its own harness's full response protocol — reasoning channel, tool-call channel, result channel — and pi parses none of it. FT-37 and FT-47 are two tags from one vocabulary, not two bugs.

---

## 6. What I could not determine

Each item states what would settle it. These are limits of the record, not of effort.

1. **The upstream behind a `subrouter-*` provider ID.** Not recorded per message. Nothing in the JSONL distinguishes "one upstream, occasional markup" from "N upstreams, one of which emits markup". *Would be settled by:* a per-request header or host capture, e.g. a `before_provider_headers` hook logging the endpoint next to `message.id`.
2. **Whether a leaked `<thinking>` body was actually the reasoning channel.** `usage.reasoning` is 0 for all 269 gemini leaks but nonzero for some deepseek leaks, so token accounting does not identify it. *Would be settled by:* a raw wire capture of one leaking request showing whether the block arrived in `content` or in `reasoning_content` and was concatenated.
3. **Whether the tag vocabulary is complete.** It is complete *for these 839 files*. The corpus grows continuously and the models behind it change; a new tag form can appear without any code change on this machine. The measurement is a snapshot, and I did not attempt to bound future shapes. My curated family list also ignores incidental angle-bracket tokens (`<id>`, `<div>`, TypeScript generics) — they are counted in the raw layer only, and the assistant-text layer shows 132 `<name>` and 84 `<path>` occurrences that I deliberately did not chase.
4. **Which pi code path fails to parse them.** Out of scope by assignment — the mechanism half owns it. I did confirm two pi-side facts that bear on it: pi's compaction prompt asks for `## Goal` markdown and does not ask for `<analysis>`/`<summary>`; and `<summary>` is emitted *by* pi as a replay wrapper, so its presence in a transcript is not evidence of a model leak.
5. **Prevalence per operator-visible turn.** I count messages, not what was rendered. A message with a protocol-sized text block was almost certainly rendered, but I did not reconstruct TUI output, and I did not verify that every protocol message was visible rather than truncated.
6. **Causality.** Nothing here is an experiment. I cannot force a provider switch, and I did not write to any session. All of it is observational.
7. **Whether the 13 protocol messages in my own 3 lanes are representative.** They are in the corpus because those lanes are working on this defect right now, and their assistant text contains the tag names under discussion. I inspected them: they are genuine block-initial leaks, not quotations — e.g. one begins `<thinking>Confirmed definitively: streamAssistantResponse returns…`. They are counted in every table above and are flagged `self_session: true` in the appendix, so they can be subtracted.

---

## 7. Reproduction

Per-message attribution for all 720 protocol messages, with provider, model, api, `responseModel`, `stopReason`, content-block shape, predecessor provider, `usage.reasoning` and self-session flag:

```
FT-37-47-EVIDENCE-appendix.jsonl
```

The three-layer scheme reproduces with:

```python
TAG  = re.compile(r"<\s*(/?)\s*([A-Za-z_][A-Za-z0-9_.:\-]*)((?:\s[^<>]{0,200})?)\s*>")
DSML = re.compile(r"</?[｜|]{1,2}\s*[A-Za-z_▁ ]{1,24}?[｜|]{1,2}\s*[A-Za-z_]{0,16}\s*>")
FAM  = {"thinking":"THINK","think":"THINK",
        "tool_call":"TOOLXML","tool_answer":"TOOLXML","tool_result":"TOOLXML",
        "tool_name":"TOOLXML","invoke":"TOOLXML","parameter":"TOOLXML","param":"TOOLXML",
        "function_call":"TOOLXML","result":"TOOLXML","output":"TOOLXML",
        "COMMENTARY":"TOOLXML","commentary":"TOOLXML",
        "antml:invoke":"TOOLXML","antml:parameter":"TOOLXML",
        "analysis":"COMPACT","summary":"COMPACT"}
# unit = message.role == "assistant"; container = content block with type == "text"
```

Sanity check any claim with the raw layer first:

```bash
cd ~/.pi/agent/sessions
grep -c '<thinking>' <file>.jsonl        # raw substring, inflated by discussion
# then read the record, not the bytes, for attribution
```

---

## 8. Provenance

- **Snapshot:** `2026-11-10T08:03:25+00:00`, 839 files, 110797 assistant messages.
- **Traversal:** `os.walk`, all depths, symlinks not followed, `.jsonl` only, entries sorted.
- **Record types seen:** `session`, `message`, `model_change`, `thinking_level_change`, `custom`, `custom_message`, `context_edit`, `compaction`, `session_info`.
- **Read-only:** no file under `~/.pi/agent/` or the pi install was written, moved or deleted during this investigation.
- **Companion:** `FT-37-47-EVIDENCE-appendix.jsonl` (per-message rows).

