# Tasks

## 1. AGENTS.md governance edits

- [x] 1.1 In `AGENTS.md`, reword the "Final acceptance" bullet to remove the team-workflow mention: "Complete `/opsx-verify` for every change" (drop "for both solo and team-workflow changes" and the "team review and" phrase).
  Verification: `rg -n "team-workflow|team review" AGENTS.md` exits 1 (no matches).

- [x] 1.2 In `AGENTS.md`, replace the "Critical paths and team-workflow escalation" bullet with a workflow-neutral "High-risk paths" note keeping the same three per-session hot paths and their file references, with no workflow requirement.
  Verification: `rg -n "High-risk paths" AGENTS.md` exits 0 AND `rg -n "escalat|team-workflow" AGENTS.md` exits 1.

## 2. Change validation

- [x] 2.1 Run `npx openspec validate decouple-team-workflow-governance --strict`; it must pass.
  Verification: command exits 0. Docs-only change: no source edits, so `npm run check` and `npm test` are not required by the apply rule.
