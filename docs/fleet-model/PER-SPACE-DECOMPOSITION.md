# Per-space `AGENTS.md` decomposition

**Status**: analysed, deliberately **not** executed in bulk. This document records why, and the recipe for when a space is activated.

---

## The measurement, and why it does not mean what it looks like

Every leader loads its space's `AGENTS.md` on top of the shared core. Across `~/Code`:

| | |
|---|---|
| Spaces with an `AGENTS.md` | **65** |
| Total lines | **11,946** |
| Largest | `buzz` 594, `camofox-browser` 571, `open-surrealdb-ds` 538, `oss-bounty-triad` 433 |
| **Spaces with a live agent right now** | **1** — `open-surrealdb-ds` |

That last row is the point. The per-space files are the largest remaining instruction cost **only for spaces that are actually running**. For a dormant directory the file costs nothing at all, because nothing loads it.

So "12k lines of project instruction" is not 12k lines of live cost. It is 538 lines of live cost, in `open-surrealdb-ds`, plus whatever a space costs the moment it is activated.

## Also: the pile is smaller than it looks

The `oss-bounty-triad*` family is **six directories sharing one 394-line file** — `oss-bounty-triad`, `-agent-vercel-lane`, `-agent-program-priority`, `-agent-nextcloud-h020`, `-agent-gitlab-hv-pass`, and others. That is one template to decompose, not six. Similarly the four `repo-codex-*` families at 394 lines each look like one template applied across pass-specific checkouts.

Counting files overstates the work. Counting *distinct templates* is the honest denominator.

## The rule

**Decompose a space when it is activated, not in bulk.**

- A dormant space's file is free. Editing 65 of them would be a large change across 65 repos with nobody to benefit today, and every edit is a change to a project repo — work that must be delegated per space, not done centrally.
- The moment a space is restarted through `pil` to gain a profile is exactly the moment it starts paying for its file. That is the natural trigger.
- Bulk mechanical edits also risk silently deleting a hard-won trap from a space's notes. Those files encode real troubleshooting; a rewrite needs the space's own context.

## The recipe, when a space is activated

The same decomposition as the global file, applied per space:

1. **Read the file first.** Identify the ~10 lines that are unrecoverable if missed — the traps, boundaries, and commands unique to that space.
2. **Keep the invariants.** Anything that would cause irreversible damage if an agent forgot it (wrong branch, a destructive command, a billing surface, a credential boundary) stays in `AGENTS.md`.
3. **Move procedure to `<project>/.pi/skills/<topic>/SKILL.md`.** Build steps, deploy sequences, troubleshooting flow, and reference material become skills that load on demand. Project-scope skills are **not narrowed by a profile**, so they work regardless of which profile the lane runs — and they are shared with that space's workers, which is correct: a worker in that space needs the space's rules.
4. **Point.** Leave a routing line in `AGENTS.md`: "build and deploy: load the `deploy` skill".
5. **Verify with the space's own questions.** A fresh lane in that space must still answer, without the removed text: how to build, how to deploy, what it must never touch, and who owns it.
6. **Measure.** `wc -l` before and after; record the delta in the space's progress record.

## Order of work

| Priority | Space | Why |
|---|---|---|
| 1 | `open-surrealdb-ds` | the only space with a live agent, and 538 lines |
| 2 | `buzz` (594), `camofox-browser` (571) | largest files; do them on activation |
| 3 | `oss-bounty-triad` template (394) | one template, six checkouts — one decomposition, copied deliberately |
| 4 | everything else | on activation, by the rule above |

## Delegation

This is project-repo work, so it is delegated per space, never done centrally by the orchestrator. A suitable brief:

> Reduce `<space>/AGENTS.md` from N lines to roughly 40–60 without losing any rule whose omission would be unrecoverable. Keep the invariants and the traps. Move build/deploy/troubleshooting procedure into `<space>/.pi/skills/<topic>/SKILL.md`, loaded on demand, and leave a routing line in `AGENTS.md`. Do not change code, configuration, or CI. Verify that a fresh lane in `<space>` can still answer: how to build, how to deploy, what not to touch, who owns it. Report the line count before and after, the skill files created, and the verification answers.

One lane per space. Do not batch several spaces into one lane: each file encodes a different machine reality, and a brief that covers two spaces is a brief that explains neither.