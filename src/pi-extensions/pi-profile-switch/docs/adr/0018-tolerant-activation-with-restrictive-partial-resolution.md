# Tolerant activation with restrictive partial resolution

## Scope

This supersedes [ADR-0009](0009-reference-resolution-failure-tiering.md) and only Decision 4 (launcher-side transport rejection) of ADR-0016. ADR-0016 Decisions 1–3 remain in effect by reference to [ADR-0016](0016-drop-pi-mcp-adapter.md); its historical body is retained.

## Context

A catalog can contain unused or shadowed definitions that are broken. Resource references can outlive an installation, and a provider can become available only when Pi loads an extension. Making startup depend on an eager catalog parse or a pre-extension model registry couples otherwise usable profiles to inputs they did not select.

Relaxing validation by removing failing declarations would lose the user's narrowing intent. Retaining declarations is also necessary for later resolution after resources or sources change.

## Decision

Prefer usable activation without discarding declared control. Resolve winning definitions and usable references locally, retaining diagnostics and original declarations rather than restoring unrestricted access after a miss.

Keep structural validation and execution failures distinct from expected discovery misses. Runtime overlay mutations retain their own validation boundary rather than inheriting tolerant profile-reference expansion.

Delegate model availability, authentication, precedence, fallback, and MCP transport usability to native Pi. Importing extensions or recreating a provider registry in the launcher would create a second lifecycle authority. Native value and transport sets defer to Pi's installed contracts.

The behavior contracts are [selected-definition validation](../../openspec/specs/profile-catalog/spec.md#requirement-catalog-file-format-validation), [field diagnostics](../../openspec/specs/profile-catalog/spec.md#requirement-profile-definition-fields), [reference failure tiering](../../openspec/specs/resource-reference/spec.md#requirement-unified-failure-tiering-for-references), [restrictive partial materialization](../../openspec/specs/launcher/spec.md#requirement-restrictive-partial-materialization), and [native model declaration handoff](../../openspec/specs/launcher/spec.md#requirement-native-model-declaration-handoff).

## Rejected alternatives

**Eager parsing with caught errors.** It still reads unrelated and shadowed definition contents before selection, making source precedence depend on content availability.

**Hard-failing every missing literal.** It prevents activation of the usable portion of a declared selection and cannot account for resources that will appear on a later reload.

**Erasing missing references or dropping a failed policy.** It confuses failed resolution with omission and can widen user-level access.

**Warning-only standalone model preflight.** It still consults an incomplete provider environment and can falsely warn about valid extension registrations.

**A launcher-maintained transport gate.** It duplicates a native contract whose supported set changes independently of profiles.

## Consequences

Users must inspect diagnostics when a profile resolves fewer resources than requested. Keeping source definitions unchanged allows re-resolution without rewriting the user's intent.

Diagnostic data remains additive instance state rather than a catalog or runtime-state migration. Native failures remain observable instead of being replaced by a profile-layer validation claim.

The [architecture](../architecture/overview.md#activation-diagnostics) owns indexing, diagnostic transport, and materialization mechanisms. [Observability](../../openspec/specs/in-session-switch/spec.md#requirement-observability-surface) and [switching](../../openspec/specs/in-session-switch/spec.md#requirement-in-session-switching) own user-visible outcomes and recovery boundaries.
