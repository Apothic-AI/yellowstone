# Project-level resources belong to Pi; profiles narrow user-level resources only

Supplementing ADR-0005's context: its claim that "project-level auto-discovery can be fully suppressed by `defaultProjectTrust: \"never\"`" remains a fact, but suppression is no longer used as a filtering means.

## Context

The isolation surface is four resource categories (skills, extensions, MCP servers, tools), while Pi's project-level switch is all-or-nothing and is read exactly once at startup:

- `SettingsManager.projectTrusted` is determined once per process, per cwd; `session.reload()` does not recompute it, and Pi's own documentation says trust changes require a process restart.
- Exclusion entries (`-<path>`) are scoped to each scope's own settings; the instance's `settings.json` is global scope, so it cannot filter project-scope discovery results nor govern resource arrays declared by the project `.pi/settings.json`.
- There is no in-session API to remove discovered resources: extensions can only append skill, prompt, and theme paths via `resources_discover`.

Therefore "narrowing project-level resources by profile" has exactly one implementation path: using the trust gate to suppress project-level discovery wholesale. It brings three costs: the isolation surface is wider than the positioning (project-level prompts, themes, and settings get blocked along); after switching back to `default` in-session, project-level resources remain invisible (the trust determination is frozen, so switching back requires a restart); and while the gate is open (started as `default`, then switched to a named profile) project-level resources leak, because exclusions are ineffective against project scope.

## Decision

The visibility of project-level resources is decided solely by Pi's project-trust determination:

- The instance's `trust.json` is a symlink to the real trust store, established for every profile (also when the target does not exist yet).
- One-shot trust input (`--approve` / `--no-approve`) is forwarded to the Pi process of any profile, keeping both sides of the determination consistent.
- Generated settings do not encode project-level resources: no whitelist entries, no exclusions, and no merging of project `.pi/settings.json`; project packages therefore follow Pi's native install path and never become an install side effect of the global npm root.
- A profile's narrowing surface is user-level resources: the real agentDir and `~/.agents/skills`.

Named profiles keep `defaultProjectTrust: "never"` in their generated settings, its role narrowed to "do not initiate a trust prompt".

## Rejected alternatives

**Adding exclusions for project-level resources** (keeping the gate while narrowing both sides with exclusions): exclusions apply only to their own scope's settings, cannot filter project-scope discovery results, and cannot stop resource arrays declared by project `.pi/settings.json`. This design is impossible on the Pi side.

**Re-applying the profile's properties at every session start** (pressing the influence of project settings back down): equivalent to fighting Pi's merge order, maintained key by key, and unable to cover arbitrary keys.

**Bringing Pi's interactive trust prompt into named profiles** (making trust decisions at runtime): the launcher has already completed catalog and MCP validation as "untrusted" before spawn; flipping the determination at runtime would produce an intra-session divergence of "the project catalog contains no project definitions while project resources are admitted".

## Consequences

- Profiles lose control over project-level resources: a trusted project's skills, extensions, and MCP servers are available under every profile, and even read-only-style profiles cannot hide them; project trust is the only gate.
- Behavior keys in project `.pi/settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`) override profile declarations per Pi's merge order; tools are unaffected (the extension re-tightens tools at session start).
- Named profiles do not initiate a prompt when the project is untrusted and no stored decision exists; project-level resources are invisible in that state.
- The coupling point with Pi shifts from "suppressing project discovery with `never`" to the trust store's location and merge order; integration tests with real Pi subprocesses stand guard.

## Related

Behavior contracts: `openspec/specs/launcher/spec.md`, `openspec/specs/resource-reference/spec.md`, `openspec/specs/in-session-switch/spec.md`; mechanism ownership: the filtering model in `docs/architecture/overview.md`.
