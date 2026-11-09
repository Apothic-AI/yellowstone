---
name: profile-config
description: Guides the creation, modification, and deletion of pi-profile-switch profiles. Trigger when the user wants to create, modify, configure, or delete a profile.
---

# profile-config

This skill guides the agent in understanding the user's vague requirements or explicit instructions, and assists in creating, modifying, or deleting `pi-profile-switch` profile files.

> **Notice**: This skill file is distributed by the `pi-profile-switch` package install and is automatically overwritten on package upgrades. Do not modify this file manually.

---

## 1. Core concepts and constraints

### 1.1 Profiles and catalogs
- **Profile**: a named capability definition referencing skills, extensions, MCP servers, and tools, optionally declaring model, thinking level, and instructions.
- **Catalog**: the `profiles/` directory holding profile definitions. Each profile corresponds to one standalone JSON file in the directory: `<name>.json`.
- **default profile**: provided by Pi; cannot be deleted or edited; loads every resource Pi can discover. **Strictly forbidden** to create `default.json` in any profiles directory.

### 1.2 Name charset rules
A profile name must fully match the regex:
```regex
^[A-Za-z0-9][A-Za-z0-9._-]*$
```
- Must start with an ASCII letter or digit.
- Only ASCII letters, digits, dots (`.`), underscores (`_`), and hyphens (`-`) are allowed.
- Spaces, CJK characters, and special symbols are not allowed.

### 1.3 Scopes (source scope) and storage locations
Profile files live in one of two locations:

| Scope | Path | Notes |
| --- | --- | --- |
| **Global** | `$PI_PROFILE_SWITCH_DIR/profiles/<name>.json`<br>(default `~/.pi-profile-switch/profiles/<name>.json`) | Applies to all projects. If the `PI_PROFILE_SWITCH_DIR` environment variable exists and is non-empty, the `profiles/` directory under it is authoritative. |
| **Project** | `<projectDir>/.pi/profiles/<name>.json` | Effective only in the current project, and only when the project is trusted. |

- **Override rule**: a same-named profile in project scope completely replaces the global entry; fields are **not** merged with the global configuration.
- **Project trust gate**: if the current project is untrusted, profiles in project scope cannot resolve, and writes to project scope fail. Before writing to project scope while the project is untrusted, you must tell the user to run `/trust` in the session and restart Pi.

---

## 2. Profile file format and fields

The file content must be formatted JSON, with **the bare definition object at the top level** — strictly no `schemaVersion`, `profiles`, or other outer envelope fields.

Use the authoritative [profile schema](../../schemas/profiles.schema.json) for supported fields and shapes, and the [field contract](../../openspec/specs/profile-catalog/spec.md#requirement-profile-definition-fields) for read/write diagnostics. When working from an installed copy of this skill, locate `schemas/profiles.schema.json` in the installed `pi-profile-switch` package before validating edits.

All fields are optional. Undeclared fields keep native Pi behavior or current state and produce no side effects.

### Field semantics

| Field | Type | Semantics and constraints |
| --- | --- | --- |
| `label` | `string` | Human-readable display name (e.g. `"Code Review"`). |
| `description` | `string` | Short description of the profile (e.g. `"Read-only review profile"`). |
| `skills` | `string[]` | Skill names or globs to reference. When undeclared, available skills are not narrowed. |
| `extensions` | `string[]` | Extension identifiers or globs to reference. When undeclared, available extensions are not narrowed. |
| `mcps` | `string[]` | MCP server names or globs to reference. When undeclared, all discovered user-level servers keep their normal availability. An explicit `mcps: []` disables every discovered user-level server. Project-level servers are never narrowed. |
| `tools` | `string[]` | Whitelisted non-MCP tool names or globs (built-in and extension tools only). Live MCP tools remain usable independently of `tools`. When undeclared, tools are not narrowed and Pi's native tool set is kept. |
| `mcp_tools` | `Record<string, string[]>` | Per-server MCP tool selection: literal server names mapped to literal MCP tool names as exposed by Pi's built-in MCP extension. Globs are rejected. An omitted server allows all tools; a nonempty array allows only matches; an empty array (`[]`) denies all tools while keeping the server enabled. An empty object (`{}`) behaves like omission. |
| `defaultProvider` | `string` | Default model provider (e.g. `"anthropic"`, `"openai"`). Effective only when declared together with `defaultModel`. |
| `defaultModel` | `string` | Default model name (e.g. `"claude-sonnet-4-5"`). Effective only when declared together with `defaultProvider`. |
| `defaultThinkingLevel` | `string` | Parent thinking contribution; accepted values defer to Pi's authoritative thinking-level contract. See [profile-level settings](../../openspec/specs/resource-reference/spec.md#requirement-resolution-and-validation-of-profile-level-settings-fields). |
| `instructions` | `string` | Instruction text appended to the system prompt when this profile is active. |
| `subagents` | `object` | Optional native pi-subagents defaults and exact role overrides. Use only the subset in the [profile schema](../../schemas/profiles.schema.json). It neither loads pi-subagents nor selects or disables roles. |

### Validation workflow

- **Fatal shapes**: validate the selected file's JSON object and supported-field types before writing. Follow [selected-definition validation](../../openspec/specs/profile-catalog/spec.md#requirement-catalog-file-format-validation); remove unsupported keys according to the field contract above.
- **Reference warnings**: inspect discovery and `/profile status`, then correct names or install resources. Preserve explicit empty selections and dormant MCP policies rather than replacing them with omission. Follow [reference failure tiering](../../openspec/specs/resource-reference/spec.md#requirement-unified-failure-tiering-for-references).
- **Native model handoff**: use native Pi to check models after extension loading; do not add a separate existence or credential preflight. Follow [native model declaration handoff](../../openspec/specs/launcher/spec.md#requirement-native-model-declaration-handoff).
- After activation or reload, review [listing and status diagnostics](../../openspec/specs/in-session-switch/spec.md#requirement-observability-surface). Resource overlay mutations retain their [separate validation contract](../../openspec/specs/in-session-switch/spec.md#requirement-runtime-overlay).

### Example
```json
{
  "label": "Review Mode",
  "description": "Read-only code review with linting and analysis tools",
  "skills": [
    "profile-config"
  ],
  "mcps": [],
  "tools": [
    "read",
    "grep",
    "find",
    "ls"
  ],
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high",
  "instructions": "Focus on code quality, security, and edge cases. Do not edit files.",
  "subagents": {
    "defaultModel": "anthropic/claude-sonnet-4-5",
    "agentOverrides": {
      "reviewer": {
        "model": "inherit",
        "thinking": "high",
        "description": "Independent review of this project",
        "advertise": true
      }
    }
  }
}
```

---

A role `description` is metadata and does not replace its system prompt. `advertise: true` lists a role in the parent prompt; `false` only omits that listing and does not disable the role. Role keys are exact names, not an availability list. Profile declarations can be superseded by pi-subagents' native project/provider/per-run precedence, so use `/profile status` for declared inputs and `/subagents-models` for live mappings. See the [launcher contract](../../openspec/specs/launcher/spec.md) and [native model reference](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md).

## 3. Discovering referenceable resources

When helping the user configure a profile, check or consult the following locations to discover the resources the user currently has:

1. **Skills**:
   - Discovery locations: `<agentDir>/skills/` and the global `~/.agents/skills/`.
   - Reference identity: Pi's skill name (the `name` declared in the frontmatter of the skill directory's `SKILL.md`, or the directory name).
   - Globs supported (e.g. `"git-*"`).
2. **Extensions**:
   - Discovery locations: installed packages declared in `<agentDir>/settings.json`, and loose files (`.ts` or `.js`) under `<agentDir>/extensions/`.
   - Reference forms:
     - An installed package's package name or source alias.
     - Entry ID of a multi-entry package: `<package>:<relative path>`.
     - Loose-file ID: the path relative to the extension directory minus the `.ts`/`.js` suffix (e.g. `sub/index.ts` is referenced as `sub`).
     - Absolute paths or `~/` paths.
     - Glob matching.
3. **MCP servers**:
   - Discovery locations: Pi's user-level MCP configuration files — on the global side `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `<agentDir>/mcp.json`; trusted projects additionally have `<projectDir>/.pi/mcp.json`.
   - Reference identity: the server key names under the `mcpServers` object in those configuration files.
   - Use Pi to check connection usability; follow the [MCP reference contract](../../openspec/specs/resource-reference/spec.md#requirement-mcp-server-reference-resolution) for skipped sources, server diagnostics, and transport ownership.
4. **Tools**:
   - Reference identity: non-MCP tool names in Pi's live tool registry.
   - Includes built-in tools (`read`, `write`, `edit`, `bash`, etc.) and extension-contributed tools.
   - MCP-owned tools are **not** controlled by `tools`; legacy references such as `"mcp__*"` or `"github_*"` in `tools` must be migrated to `mcp_tools`.
5. **MCP Tools (`mcp_tools`)**:
   - Reference identity: keys are literal configured MCP server names; values are literal MCP tool names as exposed by Pi's built-in MCP extension. Globs are not accepted.
   - Selectors are not checked against a live tool catalog. A selector matching no tool stays restrictive and produces no name diagnostic; verify selector forms with the MCP server before writing the profile.
   - Prefixed selectors from previous MCP integrations (e.g. `<server>_<tool>`) no longer apply; replace them with the literal tool names from Pi's built-in MCP extension.
   - Omitting a server key preserves unrestricted access to that server's tools.
   - An empty list (`[]`) denies all tools for that server while keeping the server enabled.
   - A nonempty list (e.g. `["search", "get_issue"]`) allows only those tools across direct tools, gateway proxies, and scripts.
   - Narrowing applies only to user-level MCP servers; project-level MCP servers cannot be narrowed by profiles.
6. **Narrowing boundary of project-level resources (important)**:
   - A profile's resource selection (`skills`, `extensions`) **applies only to user-level resources** (the real agentDir and `~/.agents/skills`).
   - The visibility of project-level resources (project `.pi/skills`, project `.pi/extensions`, ancestor `.agents/skills`) is decided by Pi's project-trust determination: in a trusted project they are always visible under **any** profile; in an untrusted project they are never visible.
   - Therefore project-level resource visibility **does not narrow with profiles** — there is no need, and no guidance, to declare project-level resources in a profile.

---

## 4. Default injection rule at authoring time

When creating or generating a new profile that declares `skills` for the user, follow these conventions:

1. **Inject `"profile-config"` by default**:
   - If the generated profile declares a `skills` array, include `"profile-config"` in the `skills` list by default, so that after switching into the profile the user can still configure profiles through this skill.
   - **Exception 1**: the user explicitly asks not to include `"profile-config"`.
   - **Exception 2**: the `skills` list already contains a covering glob (e.g. `"*"`), so there is no need to add `"profile-config"` explicitly again.
2. **Do nothing when `skills` is undeclared**:
   - If the profile does not declare the `skills` field, skills are not narrowed and every skill (including `profile-config`) is naturally available — never proactively add a `skills` field in that case.

---

## 5. Interaction and execution flows

### 5.1 Create
1. **Clarify requirements**: from the user's natural-language description (e.g. "set up a read-only profile for security auditing"), determine:
   - The target name (validate against `^[A-Za-z0-9][A-Za-z0-9._-]*$`, and not `default`).
   - The target scope (global or project).
   - The tools, skills, extensions, MCP servers, or specific model settings to narrow.
2. **Check resources and environment**: construct a legal JSON definition per the rules above, applying the default injection rule.
3. **Write the file**:
   - Global path: `$PI_PROFILE_SWITCH_DIR/profiles/<name>.json` (default `~/.pi-profile-switch/profiles/<name>.json`).
   - Project path: `<projectDir>/.pi/profiles/<name>.json`.
   - Ensure the directory exists and write formatted JSON.
4. **Tell the user how to take effect**: the new profile is immediately usable via `/profile reload` or `/profile use <name>`.

### 5.2 Edit
1. Read the existing content of the target profile file.
2. Adjust the requested fields per the user's requirements, keeping all other fields intact.
3. Apply the validation workflow above and write back only supported fields as formatted JSON.
4. Tell the user to run `/profile reload`.

### 5.3 Delete
1. Confirm the profile to delete exists in the specified scope.
2. Never attempt to delete the `default` profile.
3. Delete the corresponding `<name>.json` file. If the profile is currently in use, remind the user to switch to another profile first (e.g. `/profile use default`).

---

## 6. Boundaries and degradation

1. **Read-only / no `write` tool environments**:
   - If the current session is in a profile with narrowed tools (e.g. a read-only mode without the `write` tool):
   - Degrade to outputting the complete formatted JSON content in the reply along with the suggested absolute file path, and suggest the user save it manually or switch to a profile with file-write capability (e.g. `/profile use default`) before saving.
2. **Untrusted projects**:
   - If a write to project scope (`<projectDir>/.pi/profiles/`) is needed while the current project is not yet trusted:
   - You must explain to the user that an untrusted project cannot take effect, and suggest running `/trust` and restarting Pi, or saving the profile to global scope instead.
