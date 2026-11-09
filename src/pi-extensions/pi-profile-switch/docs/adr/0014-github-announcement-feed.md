# GitHub-hosted structured announcement feed; fixed long-lived address

## Context

Startup announcements need a maintainer-reviewed channel that can reach already-installed versions without an npm release: urgent notices must be publishable within minutes, and older installs must be able to receive them. The channel's address is an external compatibility commitment — clients that never upgrade can only be told about a moved endpoint through the old endpoint, so the address must stay stable for the life of the feature. The feed also needs machine-readable identity (dedup across launches), applicability (which installed versions), expiry, and action text; none of these can be inferred from installed packages or defaults.

Alternatives evaluated:

- **npm package metadata**: can carry the `latest` version (used for the upgrade reminder), but publishing urgent notices requires an npm release, and metadata cannot express applicability ranges or independent expiry.
- **GitHub Releases**: bound to release events; cannot publish an urgent notice to existing installations without shipping a new version, and release bodies are prose, not structured data.
- **Markdown-only file**: would need fragile heading parsing or ad-hoc front-matter conventions to recover id/expiry/applicability; every client would parse differently.
- **Hosted service**: adds operational ownership, credentials, uptime duties, and cost for a package whose notices are rare and short-lived.

## Decision

Publish one reviewed `announcements.json` — checked into this repository at the root of the default branch — and serve it at the fixed raw-file address `https://raw.githubusercontent.com/VincentFF/pi-profile-switch/main/announcements.json` (repository identity from `package.json`, publishing branch from `.github/workflows/release.yml`). The envelope is `{ "schemaVersion": 1, "announcements": [...] }`; each entry carries `id`, `message`, `action`, `expiresAt`, optional `minInstalledVersion` (inclusive), `maxInstalledVersionExclusive`, and `requiresUpgrade`. The in-repo validator (`src/startup-notifier.ts`) is authoritative for the accepted shape: the entire response is validated before use, and duplicate ids, invalid ranges or dates, control characters, oversized bodies or responses, and unknown schema versions reject the whole response. A change to the feed is reviewed like code and publishes without an npm release; materially changing an announcement's action means publishing a new id. The URL is frozen: corrective guidance for a future migration must first be published on this address.

## Rejected alternatives

**Markdown-only feed.** Rejected: prose parsing is fragile and metadata (id, expiry, version ranges) would live in unspecified front matter, forcing every client to reinvent the parser.

**npm metadata and GitHub Releases as the notice channel.** Rejected: both are bound to release events, so urgent notices cannot reach existing installations without shipping code, and neither carries structured applicability or expiry.

**A hosted announcement service.** Rejected: operational and credential costs for a low-volume, best-effort notice channel; the repository already provides review, versioning, and hosting.

## Consequences

- Installed clients validate the whole feed and keep the last valid response when a fetch fails or returns garbage; a deleted remote entry persists in caches only until its own expiry and the next successful refresh.
- The feed publisher must keep the address stable and treat `schemaVersion` bumps as a client-compatibility decision.
- Remote text is display-only: validation bounds it, and the renderer never passes it to the agent's prompts or any execution path.

## Related

Behavior contract: `openspec/specs/launcher/spec.md` (startup notification requirements); design: `openspec/changes/add-startup-notifications/design.md` (decision 1); mechanism and cache ownership: `docs/architecture/overview.md`.
