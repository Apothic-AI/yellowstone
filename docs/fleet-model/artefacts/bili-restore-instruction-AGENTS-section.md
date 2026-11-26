# Context compression — restore before you guess

> **Where this belongs — read this before filing it anywhere.** An `AGENTS.md` section only reaches a
> lane that *loads* that file. The run that produced this artefact had `sections.preamble` of **169
> characters** and **no `project_context` section at all** — no `AGENTS.md` was loaded in that
> directory, so these instructions would not have reached that lane even if they had existed.
>
> Put this section in the `AGENTS.md` of the **cwd the bili-wrapped lane actually runs in** — i.e.
> next to that space's `.pi/launch.env`. That is the only reliable placement.
>
> **`~/AGENTS.md` is NOT a cwd-independent fallback, and this artefact previously said it was.**
> It loads only for lanes whose cwd is under `/home/bitnom`. A lane running in `/tmp/…`, another
> mount, or any directory outside that tree gets **no `project_context` at all** — which is exactly
> what happened in the recall run: its cwd was `/tmp/bc-coexist` and the transcript has no
> `project_context` section. Do not rely on it for those lanes.
>
> **The only cwd-independent path is `<agent-dir>/AGENTS.md`** — normally `~/.pi/agent/AGENTS.md`.
> **It does not exist on this machine today** (verified), and it is the one file that would reach
> every lane regardless of cwd. Creating it is a fleet decision with fleet-wide blast radius: it
> would load into every lane including workers and throwaway probes. If you want that, do it
> deliberately and reload; do not add it as a side effect of filing this section.
>
> Verify it arrived: the lane's own session transcript should show a `project_context` section, and
> the preamble should be the composed mode (thousands of characters), not the 169-character native
> fallback.

This space runs bili (`billion-context`). It compresses old conversation into summary blocks. **Your
input does not always contain what you think it contains.** This section is the mitigation, and it
was measured, not guessed: a run on this machine lost 29.2 % of exact-answer facts to folds that
covered 91–99 % of the live context (`[warn: degenerate-fold]`), and the agent in that run never
called a restore tool once.

## The rule

**If you are about to state an exact identifier, and it is not visible in this turn's context, call
`search_context` then `decompress` before answering. Do not reconstruct it from memory and do not
reconstruct it from pattern.**

An identifier means anything where being one character wrong is being wrong:

- bead ids (`swarm-abc`), session ids, uuids
- file paths, and path:line references
- version strings, commit hashes
- counts and token numbers you were given exactly
- error text you are quoting

## Why this rule exists

bili's fold replaces mid-history ranges with a model-written summary. The summary is lossy by design
— the design paper's own words are that tier-1 blocks *"retain ~1/8 on median"* and that this is
*"block-level text retention, **not information fidelity**"*. The paper also scopes verbatim-identifier
work out of support: *"verbatim-history task classes — audits, compliance, forensics … lie outside
the support range of a lossy fold that generates no restore traffic."*

**Restore traffic is what turns an out-of-scope task into a supported one.** The tool is there. The
paper says explicitly that *"restore works when instructed, but models at this scale will not
spontaneously reach for it"*. You are the model. Reach for it.

## How

```
search_context   keyword search across compressed block summaries — use it FIRST to find the block
decompress       restores that block; full:true restores all the way to original messages
decompress       use toFile:true to write to a file instead of inflating your context
acp_status       shows context usage and which ranges are compressible
```

`search_context` before `decompress`: the search tells you which block to restore, so you restore
one block instead of everything.

## Treat a schema-shaped answer with suspicion

If you produce an identifier that *looks* right — correct prefix, correct length, correct character
class — and you cannot point at where in this context you read it, **you are guessing.** In the
measured run, 34 of 42 wrong answers were invented values that matched the expected shape exactly
(`^swarm-[a-z0-9]{3}$` and well-formed 36-character uuids) and appeared nowhere in the source. A
confidently-shaped wrong value is worse than an admitted gap, because nothing downstream prompts a
re-read.

So: when an exact value is missing, say it is missing and restore it. Do not fill the shape.

## When NOT to bother

Do not call `decompress` for prose, reasoning, or the gist of what was decided — summaries carry
those adequately, and restoring them wastes the context you just saved. This rule is for **exact
strings**, not for understanding.
