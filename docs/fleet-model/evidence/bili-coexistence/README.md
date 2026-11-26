# billion-context coexistence + recall evidence

Preserved 2026-11-02 23:49 EST from `/tmp/bc-coexist` before that scratch directory was removed.
The full report is `~/Documents/Assistant/reviews/billion-context-coexistence-report.md`; this
note exists so the files below can be read without it.

## What was run

`billion-context@0.1.212` (`--save-exact`, isolated prefix, 93 packages) wrapping pi on the
operator's own configuration — `subrouter-deepseek-flash` / `deepseek-v4.1-flash-1017`, thinking
`max`, contextWindow 1,000,000. Nothing fleet-wide was touched; `~/.pi/agent/settings.json` and
`pi-auto-compact.json` were byte-identical before and after (md5 `bdab3ba9…`, `f5295a8d…`).

## Files and what each one proves

| File | What it is |
|---|---|
| `FINDINGS.md` | the run's own record: coexistence A/B/C, then the Q3 recall section with per-pass tables, fold evidence and the three instrument defects found before any number was trusted |
| `laneA-turns.tsv` | 24 rows, per-turn `usage.totalTokens` for the operator's real configuration. Peak **106,906** tokens = **13.7 %** of the 780,000 auto-compact trigger. Sawtooth, not ramp |
| `laneB2-turns.tsv` | the forced-collision lane (100k window, `threshold: 30`) — valid instrument |
| `q3-unconf-graded.json` | 36 graded rows, primary pass. **26 exact / 10 plausible-wrong**, each with `expected`, `produced`, `class` |
| `facts.json` | the 36 ground-truth facts (19 bead ids, 17 uuids) extracted from a real 3.1 MB transcript |
| `answers.json` | ground truth keyed Q1..Q36 |
| `questions-v2.txt` | the question set actually used, with **global** record numbering (see defect 3 below) |
| `sess-b.jsonl` | the forced-collision session transcript, 476 KB, containing the three `"type":"compaction"` entries |

Not preserved (deliberately): the 166 MB `node_modules` install, and ~40 MB of raw per-turn JSON
event streams. They are reproducible from the commands in `FINDINGS.md` §Reproduction.

## The numbers worth carrying

- **Coexistence is not a problem.** At the operator's configuration the two compressors never meet
  (780k trigger vs a meter bili holds at ≤27k). Forced together: 3 compactions, 3 bili
  reconciliations, 0 errors, 0 lost turns. The #1206 "corrupt message refs" warning is overstated
  for this pairing.
- **Recall is the blocker.** Over 4 confound-free folded passes (n=144): **exact 70.8 %,
  plausible-but-wrong 29.2 %, absent 0 %.** Ceiling control with compression OFF: 36/36 exact.
  So the loss is the compressor, and it never abstains — it invents.
- **34 of 42 wrong answers were values absent from the 367 KB corpus entirely**, while matching the
  expected shape (`^swarm-[a-z0-9]{3}$`, 36-char v4 uuid). Independently checked.

## Three instrument defects found before any number was trusted

Kept here because they are the reason the numbers are believable, and because they will recur:

1. **`read`-tool truncation at ~50 KB** would have faked a 3/36 loss — three facts sat past byte
   50,000 in their files. Caused every pass to use ≤300-line chunk reads with an 18/18 assertion.
2. **A pre-fold baseline is impossible at operator configuration** — the corpus is ~92k tokens and
   bili folds *during* ingestion, so a true ceiling needs `ACP_PASSTHROUGH=1` (0 folds).
3. **The first question set was wrong** — it asked for six records per file across files 1–6,
   pointing 31/36 questions at non-existent `(file, record)` pairs, because the corpus labels
   records globally. Regenerated; both labellings were proven to denote the same 36 values in the
   same order, so the fix cannot bias a result.

## Uncertainty, as recorded by the run

One model, one configuration, one day. n=144 is 36 questions across **4 correlated passes**, so the
effective independent sample is nearer 4 and the per-pass spread (5 to 19 wrong) is wide — 29.2 % is
a point estimate, not a rate. Under a stricter definition (the wrong value must be a real fact
elsewhere) plausible-but-wrong is 8/144 (5.6 %). A first folded pass whose prompt said "do not guess
a plausible value" scored 0 % plausible-but-wrong, and that 0 was an artifact of the wording — it is
retained as a negative control, not as a result.
