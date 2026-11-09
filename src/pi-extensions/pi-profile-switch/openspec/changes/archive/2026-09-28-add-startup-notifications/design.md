# Design

## Context

See [proposal.md](proposal.md) for motivation and [launcher delta](specs/launcher/spec.md) for behavior. The launcher hands Pi a unique instance directory, and the bundled extension runs on each `session_start`. Pre-spawn stderr is not a reliable TUI notification surface. Existing runtime state is selection/overlay data; it is not a suitable place for global reminder history. Tests of non-interactive modes already assert native stdout and prompt exit with closed stdin.

## Goals / Non-Goals

**Goals:** Keep remote IO off the profile resolution and Pi startup critical path. Reuse the already-loaded extension for in-session display, share one global record across profiles, and make network/format failures recoverable.

**Non-Goals:** Add a background daemon, a server, a profile setting, a new command, rich remote Markdown, or an installation mechanism.

## Decisions

### 1. Repository-hosted structured feed

Publish a reviewed `announcements.json` at `https://raw.githubusercontent.com/VincentFF/pi-profile-switch/main/announcements.json` (repository identity from `package.json`, publishing branch from `.github/workflows/release.yml`). Keep one checked-in source; a change to it is reviewed like code and can publish without an npm release. The envelope is `{ "schemaVersion": 1, "announcements": [...] }`; each entry has `id`, `message`, `action`, `expiresAt`, optional `minInstalledVersion` (inclusive) and `maxInstalledVersionExclusive`, and `requiresUpgrade` (boolean). Missing bounds apply to all installed versions. Validate the entire response before replacing the previous good response; reject duplicate IDs, invalid ranges/dates, control characters, oversized bodies or responses, and unknown format versions. For changes that materially alter an announcement's action, publish a new ID. No remote links are required.

ADR required: github-announcement-feed

A Markdown-only feed would need fragile heading parsing or metadata front matter; npm metadata and GitHub Releases cannot carry independently published urgent notices to existing installations. A hosted service adds operational and credential costs. The fixed repository URL is an external compatibility commitment: previously installed clients cannot follow a moved endpoint without upgrading.

### 2. Authority and cache

Read the running package version from its installed package metadata, not Pi's version or the repository checkout. Fetch npm's package metadata to read `dist-tags.latest`, following npm's installable stable tag rather than the largest published version. Use SemVer comparison including prerelease ordering; reject malformed version data rather than lexically comparing strings. Do not mirror the latest version into the announcement feed.

Store separate validated per-source responses with their last-success and last-attempt timestamps under `getProfileSwitchDir()`, plus separate display claims keyed by target version or announcement ID. Use a daily refresh interval per source; unsuccessful network checks use a short backoff rather than repeated requests on every start. Disk writes are atomic and do not reuse `RuntimeStateStore`, project `.pi` content, or per-launch instances. Cache expiry for refresh does not override an individual announcement's expiry. Use exclusive per-key claims around synchronous presentation to prevent concurrent launches duplicating a reminder; release a failed presentation claim. History survives profile changes and package upgrades. Remote responses have byte-size and time limits, a fixed HTTPS origin, and no redirects to a different origin. Respect explicit `PI_OFFLINE` without making a request.

The alternative of placing state in the instance loses history at sweep; adding it to profile runtime state would make a cross-profile concern dependent on source scope and trust. No new runtime dependency is planned: Node's fetch/filesystem APIs and a focused version comparator cover the required operations; the comparator is tested against SemVer ordering relevant to npm versions.

### 3. Session-start ownership and delivery

After applying the launch plan, the extension starts one cancellable notification job only on the initial `session_start` reason. It does not await the remote fetch in the session-start callback. Evaluate already cached information first; if refresh completes while the process remains active, evaluate the newly validated information. On reload/new/resume/fork, do not start or repeat a job. TUI uses `ctx.ui.notify`; other Pi modes use stderr directly, not `pi.sendMessage` or stdout. The renderer never passes remote text to `before_agent_start`. Coalesce notices so an applicable upgrade-action announcement suppresses the routine version message on that launch, without marking the suppressed target as shown. Cancel pending IO when the process ends; the launcher and Pi MUST NOT wait for network work to exit. A short-lived non-interactive process can therefore display cached information immediately and leave an unfinished check for a later launch. A test with a never-settling fetch must prove normal exit.

The alternative of reporting from `bin/pi-profile.ts` before spawn would be hidden by Pi's TUI. Adding a notification artifact to generated settings or the activation plan would couple this feature to the filtering and rollback paths. The extension reads its package metadata and the real workspace independently instead.

### Export surface

| File | Cross-module export | Error behavior |
| --- | --- | --- |
| `src/startup-notifier.ts` | `runStartupNotifications(options: { installedVersion: string; workspaceDir: string; offline: boolean; surface: NoticeSurface; fetcher?: typeof fetch; now?: () => Date; signal?: AbortSignal }): Promise<void>`; `NoticeSurface` exposes `display(message: string, level: "info" | "warning"): void` | Expected network/offline failures return normally; invalid response gives one bounded source-specific diagnostic through `surface`; programmer errors propagate to a top-level notifier catch that reports without changing Pi's exit code. |
| `extensions/pi-profile/index.ts` | No new export; create `NoticeSurface` after the initial session-start plan application and call `runStartupNotifications` without awaiting it. | Catch notifier rejection in an isolated handler, never in the activation/switch error path. |
| `src/workspace.ts` | Reuse `getProfileSwitchDir(): string`; no changed signature. | Existing workspace behavior unchanged. |

The feed file is owned by this repository; its validator is authoritative for the accepted shape. The local cache/claim format is private and versioned for safe replacement of corrupt or old files, with no migration of profile state.

## Risks / Trade-offs

- Raw-file URL changes or repository moves break older clients → keep the URL stable, document it in the ADR, and publish urgent corrective guidance on the existing URL before any migration.
- A deleted remote notice may remain in a cache until its next successful refresh → each entry carries an expiry; refresh invalid or unavailable responses never replace known-good data.
- Remote content or a compromised publisher could carry hostile text → require repository review, bound/validate text, display it only as text, and never send it to the agent or execution path.
- Very short non-interactive runs may end before first network response → cancel unfinished work without delaying exit; validated cached responses remain usable on later launches. Acceptance tests cover this rather than promising first-launch delivery in every mode.
- Concurrent cache updates can race → write per-source snapshots atomically and keep display claims independent; test two simultaneous instances against the same workspace.

## Migration Plan

Ship the notifier with an initially empty `announcements.json`. On upgrade, existing profiles and state files remain unchanged; the global notification cache/history is created on demand. Rollback to a version without the notifier leaves inert global files and does not change Pi settings or catalogs. Older releases that lack the notifier cannot receive the feed.
