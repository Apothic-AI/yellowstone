# Design

## Context

See [proposal.md](proposal.md). `openspec status` establishes artifact existence and task counts; `openspec validate` checks artifact syntax, but neither settles a contradiction between a required output and its verification command. This repo's `AGENTS.md` requires `/opsx-verify`, while the shared team-workflow skill ends with review and strict validation. The selected OpenSpec action is repo-local: its `allowedEditRoots` do not include the user-wide team-workflow skill.

## Goals / Non-Goals

**Goals:**

- Make plan readiness and final acceptance explicit for this project without adding another command, artifact, or configuration field.
- Preserve the project's existing hot-path escalation and the distinct jobs of worker evidence, independent review, `/opsx-verify`, and strict artifact validation.

**Non-Goals:**

- No new product requirement or capability domain, and no change to generated OpenSpec skills or prompts.
- No edit to the user-wide team-workflow skill as part of this repo-local change. Its complementary update is delivered separately in its own repository.

## Decisions

### 1. Separate plan-readiness from OpenSpec's CLI state

`openspec/config.yaml` gains a tasks rule requiring authors to compare required outputs, scenario coverage, and verification commands before declaring artifacts ready. A command that forbids required content must be scoped or revised. `AGENTS.md` makes the apply-side consequence explicit: before assigning work, inspect those contracts; a material conflict stops execution for `/opsx-update` or a user decision. The CLI's `ready` and `all_done` values remain unchanged.

**Rejected:** inventing a second readiness flag or treating `openspec validate --strict` as a semantic proof. Neither detects a requirement-versus-`rg` conflict without additional review.

### 2. Keep one project-owned acceptance rule

`AGENTS.md` states that checked tasks are a worker progress record, not acceptance. Any unresolved contradiction between the plan, implementation, and required documentation blocks completion even when a reviewer returns a positive verdict with notes. After the final edit, the parent checks the exact tree, runs `/opsx-verify`, and then permits archive. Team review provides independent challenge; strict validation verifies OpenSpec syntax; neither silently substitutes for `/opsx-verify`. `openspec/config.yaml` retains artifact-specific rules and advisory operation guidance, not a duplicate copy of this acceptance policy.

**Rejected:** changing generated `/opsx-verify` instructions or relying on advisory `operationGuidance` to override the project's mandatory change process.

### 3. Respect the repo-local boundary

The shared team-workflow skill owns general delegation triggers, valid red/green evidence, reviewer disposition, and final-tree gate sequencing. Those changes belong to `/Users/v1fanchao/.agents/skills/team-workflow/SKILL.md` in its own repository; no repo-local task or commit includes that path. This change documents only the project-specific readiness and `/opsx-verify` requirements.

**Rejected:** listing an out-of-root edit as an implementation task in a repo-local OpenSpec change, or copying the full team-workflow protocol into `AGENTS.md`.

## Risks / Trade-offs

- [Plan-readiness checks are judgment-based] → Use a concrete contradictory-task example during verification; do not claim CLI validation enforces the judgment.
- [The shared skill and project rule can change on different schedules] → Keep the project hot-path rule independent and review both delivery paths before claiming the combined workflow is updated.
