# Proposal

## Why

An OpenSpec change can have complete artifacts and passing checks while its task instructions contradict its intended output. In the recent overlay change, an incompatible README search gate caused migration rows to disappear; the worker recorded failures caused by test fixtures, and team review did not settle whether it fulfilled the project's `/opsx-verify` step. The project needs a clear boundary between a plan ready to implement, a worker's completion claim, and final acceptance.

## What Changes

- Require a plan-readiness check before apply: reconcile the proposed behavior, task acceptance checks, and documentation obligations. A conflict pauses apply for `/opsx-update`; file-existence status and strict syntax validation do not settle it.
- Make unresolved contract or planning contradictions block acceptance. Keep optional review notes separate from defects that need a fix or a user decision.
- Clarify that team review does not silently replace the project's `/opsx-verify` step. Run independent mechanical checks on the final edited tree before recommending archive, rather than treating intermediate checks as final evidence.
- Keep the project's hot-path escalation rule. A separately owned update to the shared skill defines valid red/green evidence, reviewer disposition, final-tree gate ordering, and risk-based entry criteria outside this repo-local change.

## Capabilities

### New Capabilities

(none — this change alters agent workflow instructions, not product behavior)

### Modified Capabilities

(none — no product requirement changes; `.openspec.yaml` sets `skip_specs: true`)

## Impact

- Repository instructions: `AGENTS.md` and `openspec/config.yaml` own project-specific readiness and acceptance rules. No source code, generated OpenSpec skill/prompt files, runtime dependencies, or product specs change.
- Shared workflow: `/Users/v1fanchao/.agents/skills/team-workflow/SKILL.md` is updated separately in its own repository, outside this repo-local change's allowed edit root. It owns general entry criteria, evidence quality, reviewer disposition, and final-tree gate ordering; project rules must not duplicate those details.

## Doc Impact

- `docs/prd.md`: none — product goals, non-goals, and profile behavior are unchanged.
- `docs/architecture/overview.md`: none — no runtime module boundary or mechanism changes.
- `CONTEXT.md`: none — terminology remains unchanged.
- `docs/adr/`: none — no hard-to-reverse product or process architecture decision is introduced.
