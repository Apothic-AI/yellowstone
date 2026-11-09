# Design

## Context

See "Why" in `proposal.md`. The design constraints come from three existing Pi facts (mechanism details in `docs/architecture/overview.md`, not restated here):

- Project-level auto-discovery (`.pi/skills`, `.pi/extensions`, `.pi/prompts`, `.pi/themes`, project `settings.json`) is decided once by Pi's `SettingsManager.projectTrusted`; `session.reload()` does not recompute it.
- Exclusion entries (`-<path>`) are scoped to each scope's own settings: the instance's settings are global scope, so its exclusions only filter user-scope discovery results and cannot touch project scope.
- In-session, extensions can only append resource paths; there is no API to remove discovered resources.

Conclusion: project-level narrowing has exactly one path — "shut the whole block off" — and "shutting the whole block off" is precisely what this change abandons.

## Goals / Non-Goals

**Goals:**

- Project-level resource visibility is decided solely by Pi's project-trust determination; a profile's narrowing surface is limited to user-level resources.
- In-session switching is equivalent to a direct launch in project-level visibility, without a process restart.
- Under a trusted project, the `default` profile's project-level behavior matches native Pi; local behavior keys still follow Pi's native merge order.

**Non-Goals:**

- No interactive trust prompt for named profiles: a named profile's generated settings keep `defaultProjectTrust: "never"`, i.e. "no stored decision means no prompt, and project-level resources stay invisible". To see project-level resources, trust once with native Pi first or pass `--approve`. Rationale: the launcher has already completed catalog and MCP validation under the same determination before spawn; letting the user flip the decision at runtime would produce an intra-session divergence of "the catalog contains no project definitions while resources are admitted as project's".
- No letting profile declarations override behavior keys of project `.pi/settings.json` (see Risks).
- No change to tools whitelist semantics (no tool discovery exists at project level).

## Decisions

### 1. `trust.json` becomes a link established under every profile

The instance establishes a `trust.json` link to the real agentDir; when the path is already occupied it is not overwritten (if Pi has written a real file within this session it is kept — and no longer occurs).

- Rationale: Pi's project-trust determination reads from that path; the link lets "stored decisions" take effect under named profiles too, and trust decisions Pi writes through the link land in the real agentDir (same class as `auth.json`, see `docs/adr/0010-per-launch-instance-lifecycle.md`).
- Rejected alternative: add exclusions for project-level resources. Exclusions do not cover project scope (see Context); impossible on the Pi side.
- Rejected alternative: keep the link unchanged at switch time and only change generated settings. Still cannot solve Pi determining trust only once.
- ADR required: project-scope-belongs-to-pi

### 2. Generated settings neither express project-level narrowing nor merge project settings

Project-level skills/extensions get neither exclusions nor attached paths; project `.pi/settings.json` is no longer merged into generated settings, and the "strip project `packages`" logic is deleted with it.

- Rationale one (correctness): project-level entries are discovered natively by Pi at runtime; attached paths would only produce duplicate resources and scope-ownership confusion.
- Rationale two (necessity): merging project settings would turn project `packages` into the instance's *global* packages, and Pi would install them into the global npm root — exactly why that key used to be stripped. With the gate open, project packages are handled natively by Pi (installed under the project `.pi/npm`); pi-profile can no longer strip them, and therefore should no longer merge either.
- Rejected alternative: keep merging but keep stripping `packages`. It would make generated settings inconsistent with the project settings Pi actually reads, and would need per-key maintenance of "which keys must not be merged" — unsustainable.

### 3. Project-level resources stay in the resolution vocabulary

A trusted project's project-level skills/extensions remain referenceable by profiles (literals and globs both resolve successfully); the selection result is simply not written into generated settings.

- Rationale: moving project-level resources out of the vocabulary would turn "referencing an in-project skill" from a resolution success into an activation failure — a worse behavior regression than the original problem; `/profile status` should also keep reporting them.

### 4. `mcps` narrowing does not apply to project-sourced servers

Servers defined by project `.mcp.json` and project `.pi/mcp.json` stay enabled; the ones still disabled are unselected servers in user-level shared locations.

- Rationale: the same boundary as skills/extensions — project-level resources are not narrowed by profiles. User-level shared locations needing explicit disable marks is caused by the adapter reading those locations directly, unrelated to projects.
- Rejected alternative: keep the status quo (project servers can be disabled by profiles). It contradicts this change's boundary statement.

### 5. One-shot trust input forwarded to all profiles

`--approve` / `--no-approve` are no longer forwarded only for `default`.

- Rationale: without forwarding, under a named profile the launcher judges untrusted per `--no-approve` (not reading the project catalog), while Pi still admits project-level resources per stored decisions — two diverging determinations within one launch.

## Risks / Trade-offs

- [Profiles lose all control over project-level resources] → a trusted project's skills/extensions enter the session under every profile, including read-only-style profiles. Mitigation: the trust determination itself is the only gate, consistent with native Pi; stated in writing in `docs/architecture/overview.md` and the PRD's boundary section rather than left as an implicit assumption.
- [Behavior keys of project `.pi/settings.json` override profile declarations] → per Pi's merge order (project over global), the project's `defaultProvider`/`defaultModel`/`defaultThinkingLevel` beat the profile's declarations; `defaultTools` only affects the boot baseline — the extension re-tightens tools per the profile's tool references at session start. Mitigation: recorded as a known boundary; if profile-priority model selection is needed, open a separate change to re-apply it at session start (not done here).
- [Project packages install on first launch, possibly hitting the network and slowing things down] → this is Pi's native behavior in a trusted project; untrusted projects and `--no-approve` do not trigger it.
- [Integration test expectations invert] → existing assertions in `test/project-scope.integration.test.ts` (unselected project resources invisible in a trusted project, project settings merged) conflict with this change and must be rewritten to the new semantics, with cases added for the trust link and MCP.

## Migration Plan

No persistent format changes, no migration needed. Rolling back means reverting this change's commits: the instance directory is rebuilt on every launch and carries no old state.
