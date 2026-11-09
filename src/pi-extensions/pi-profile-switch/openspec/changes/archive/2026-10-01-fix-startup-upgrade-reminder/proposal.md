# Proposal

## Why

The startup notifier reads the npm registry's full package metadata, which can exceed its response-size limit before `latest` is parsed. With no valid cached version, a launch can miss an available upgrade reminder even though npm publishes an installable newer version.

## What Changes

- Obtain npm's installable `latest` from its compact dist-tags response instead of requiring full package metadata; keep the existing response limit rather than raising it.
- Accept a valid top-level `latest` tag as the upgrade target. Preserve version ordering, cache and retry behavior, reminder history, announcement precedence, and best-effort delivery.
- Update the notifier tests to check the requested source and response shape, reminder delivery, and invalid-response fallback.
- Keep the separate `Unknown thinking level` warning outside this change; its path into Pi's thinking-level setting has not been established.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `launcher`: The startup upgrade reminder must remain available when full package metadata exceeds the remote-response limit but the registry's installable `latest` tag is available in a bounded response.

## Impact

- `src/startup-notifier.ts` and `test/startup-notifier.test.ts`; no public API, cache-format, configuration, or dependency changes.
- No change to Pi arguments, settings, profile activation, or announcement fetching.

## Doc Impact

- `docs/prd.md`: none: the existing upgrade-notification goal and package-manager non-goal remain accurate.
- `docs/architecture/overview.md`: link the notifier's npm lookup to this change's compact dist-tag source decision; ownership and cache layout stay unchanged.
- `CONTEXT.md`: none: no terminology changes.
- `docs/adr/`: none: no new hard-to-reverse commitment; the existing announcement-feed address decision is unchanged.
