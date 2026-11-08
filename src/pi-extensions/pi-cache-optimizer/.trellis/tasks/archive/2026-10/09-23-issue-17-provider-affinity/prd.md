# Issue #17: provider affinity warning and confirmed repair

## Goal

Reduce repeated OpenAI-compatible proxy affinity warnings and let one confirmed `/cache-optimizer fix` repair a provider shared by multiple models, including API-login models absent from `models[]` where safe.

## Requirements

- For an affinity-only missing flag, deduplicate warnings by effective provider, not model; retain per-model warnings for distinct/model-specific issues. Point warnings to `/cache-optimizer fix` rather than just manual edits.
- For an existing provider with a missing target model entry, prefer a provider-level `compat.sendSessionAffinityHeaders: true` edit only if this is the sole proposed change and no explicit model/runtime override prevents safe, effective provider placement. Otherwise retain model-scoped repair or fail closed.
- Keep explicit `false` as opt-out; no automatic writing or switch-triggered confirmation. Preserve existing confirmed preview, backup, receipt, self-check, and rollback contracts.
- Keep README English/Chinese and compatibility spec synchronized.

## Acceptance Criteria

- Multi-model same-provider missing affinity warns once, while distinct providers and model-specific diagnostics remain distinguishable.
- Single confirmed provider-level fix covers applicable sibling models absent from `models[]`; explicit per-model false remains unaffected; fallback cases stay model-scoped.
- Provider-level fix can be rolled back under existing safety guards; errors/declines make no changes.
- `npm run check` and task validation pass.

## Decision

Use existing interactive `/fix` transactions, not silent auto-apply. Extend safe provider placement to missing-model entries and scope warning deduplication to affinity-only advice. Maintain model-scoped fallback when provenance/precedence is uncertain.

## Out of Scope

Automatic config writes on model selection, an auto-apply environment switch, extension version bump, package publish, push, or PR.

## Evidence

Issue: https://github.com/jiangge/pi-cache-optimizer/issues/17. Read-only two-model fixture reproduced two warnings; existing listed-model `/fix` already previews provider-level placement. API-login/missing-model path currently creates `modelOverrides`, requiring one fix per model.
