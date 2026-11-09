# Design

## Context

See [proposal.md](proposal.md) for motivation and the [launcher delta](specs/launcher/spec.md) for the behavior contract. `src/startup-notifier.ts` currently obtains `dist-tags.latest` from a full npm package-metadata response. Its parser rejects a response above the existing size limit; the per-source cache stores only the validated `{ latest }` value and timestamps. A failed attempt without valid cached data leaves nothing to compare until the retry backoff elapses. The extension already starts the notifier after initial activation without awaiting it.

## Goals / Non-Goals

**Goals:** Keep the npm response small under ordinary registry behavior and restore reminders without changing notification state or timing.

**Non-Goals:** Raise the response limit, change announcement retrieval, add a setting, repair an unrelated Pi thinking-level warning, or guarantee that a short-lived process finishes an uncached network request.

## Decisions

### Use the registry's dist-tags response

Request `https://registry.npmjs.org/-/package/pi-profile-switch/dist-tags` for the npm source. The observed response is an object with a top-level `latest`; validate that it is a string accepted by the existing SemVer parser. Keep the current invalid-content path for missing or malformed tags, and leave comparison and candidate collection untouched. npm's [`latest` dist-tag documentation](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/) identifies it as the default install target; the registry response was checked separately at the selected URL.

Fetching full metadata with a larger response allowance would scale with package history and leave the failure mode in place. Parsing the whole response incrementally to find `dist-tags` adds complexity for data this source already serves directly. The announcement feed remains a separate source.

### Retain the validated-cache shape and refresh sequencing

The response envelope changes, but the persisted npm cache remains `{ latest }` with its current schema version and timestamps. Continue using the existing per-source refresh, failure backoff, previously validated cache, offline path, diagnostic routing, and display history. Keep npm after the announcement check so an upgrade-requiring announcement can still suppress the ordinary reminder in the same launch. Existing cache files need no migration.

Changing the cache format or bypassing backoff just to retry failed installations immediately would modify behavior beyond the failed lookup. Tests will assert that the new URL is requested and that a valid bounded response yields a reminder even if full metadata would be oversized; they will also exercise invalid top-level tags and previously validated-cache fallback. The existing oversized-response rejection remains in force for both remote sources.

## Risks / Trade-offs

- The compact registry endpoint could fail or return an unexpected shape -> reject it through the existing source-specific diagnostic, keep a validated cached version when present, and retry under existing backoff.
- An earlier failed attempt may already have set `lastAttempt` -> the fixed client still waits out the existing backoff before refreshing an uncached npm source; no manual cache reset is required.
- The response-size check occurs after `response.text()` -> choosing a normally small response avoids the observed oversize failure, but does not add a streaming byte cap; that separate hardening is outside this change.

## Migration Plan

Ship the notifier and tests with the new response source; leave existing npm cache and displayed-history files intact. A rollback to the previous code retains those files but again uses full package metadata on the next eligible refresh.
