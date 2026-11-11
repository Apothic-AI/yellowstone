# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

## About

pi-profile-switch adds named profiles to [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), letting you configure Pi's resources for a task or scenario:

- Filter skills, extensions, tools, MCP servers, and individual MCP server tools.
- Set a profile's default model, thinking level, and additional instructions.
- Configure pi-subagents child-agent role settings.
- Switch profiles within the same session without restarting or losing history.
- Use global and project-level profiles.
- Temporarily disable resources in a profile session with an overlay.

## Installation and usage

### Install

```bash
npm install -g pi-profile-switch
```

Requires Pi 0.99.1 or newer, which npm installs as a peer dependency. This package provides the `pi-profile` launcher; use `npm install -g`, not `pi install`.

### Launch

```bash
# Use the remembered profile, or default if none is saved
pi-profile

# Explicitly use default, keeping native Pi behavior
pi-profile default

# Use the starter ask profile for Q&A and code reading
pi-profile ask

# Pass Pi arguments after -- unchanged
pi-profile ask -- --model openai/gpt-5.4
```

Without a profile name, the launcher tries the trusted project's saved selection, then the global saved selection, then `default`. A profile specified on the command line applies only to that launch.

`PI_PROFILE` names a profile for that launch. It ranks below a command-line name and above both saved selections:

```sh
PI_PROFILE=worker pi-profile
```

Use it when the spawner already knows the role and the working directory cannot imply it — a worker that runs beside its leader shares the leader's directory, so a saved selection cannot tell the two apart. An empty value is the same as unset, and an unknown name fails the launch rather than falling back, so a mistyped role cannot silently start an unfiltered lane. Like a command-line name, it is not remembered for the next launch.

When the global profile directory is empty, installation or startup writes the starter [`ask`](examples/ask.json). It disables user-level skills and extensions and keeps only read-only file tools; MCP servers remain available according to Pi's configuration. You can edit or delete it.

### Create and edit profiles

Save a JSON file directly; see [Configuration](#configuration) below for its format and location. You can also use the shipped [`profile-config`](skills/profile-config/SKILL.md) skill to create, edit, and delete profiles conversationally:

```text
Create a global profile named review that keeps only read-only file tools and disables user-level MCP servers.
```

Conversational configuration requires the active profile to allow the `profile-config` skill and file-writing tools. You can switch to `default` first.

When `profile-config` creates a profile with a `skills` list, it includes itself unless you explicitly exclude it or a glob already covers it. Editing JSON manually does not add the skill automatically.

### In-session commands

| Command | Action |
| --- | --- |
| `/profile` | View and select profiles; prints the list in non-interactive modes. |
| `/profile use <name>` | Switch profiles and remember the selection for the next launch; restores the previous profile if switching fails. |
| `/profile reload` | Re-read the current profile and apply file edits. |
| `/profile status` | Inspect the current profile, resolved resources, paths, overlay, MCP state, and diagnostics. |
| `/profile overlay disable\|enable skill\|extension\|mcp\|tool <name-or-glob>` | Add or remove resource-disable entries for the current session. |
| `/profile overlay clear` | Clear every overlay entry and restore the profile's resource selection. |

These commands also work in Pi's non-interactive modes, including `--mode text`, `--mode json`, and `--mode rpc`.

### Temporarily disable resources

```text
/profile overlay disable tool bash
/profile overlay enable tool bash
/profile overlay clear
```

An overlay affects only the current runtime, does not edit profile files, and expires on restart. `enable` must match the stored disable entry exactly; to undo a glob disable, use the same glob.

Overlays only narrow resources; they cannot add resources the profile did not select. The `default` profile does not support disabling MCP servers through an overlay.

## Configuration

### File locations and names

Each profile is a `<name>.json` file. The filename supplies the name used when launching or switching profiles.

| Path | Scope |
| --- | --- |
| `~/.pi-profile-switch/profiles/<name>.json` | Global. With `PI_PROFILE_SWITCH_DIR` set, use `profiles/<name>.json` under that directory instead. |
| `<project>/.pi/profiles/<name>.json` | The current project; read only when the project is trusted. |

A project-level profile completely replaces a same-named global profile without merging fields. Deleting the project file makes the global definition available again.

Names must start with an ASCII letter or digit and may then contain ASCII letters, digits, dots, underscores, and hyphens. `default` is reserved: you cannot create `default.json`, or edit or delete the `default` profile.

For an untrusted project, run `/trust` in Pi and restart, or trust only this launch:

```bash
pi-profile review -- --approve
```

### Complete example

Save the following as `review.json`. Replace the resource names with ones you have installed or configured, and use a provider and model you can access.

```json
{
  "label": "Code Review",
  "description": "Review code with selected resources",
  "skills": ["profile-config", "code-review"],
  "extensions": ["pi-subagents"],
  "mcps": ["github", "linear"],
  "tools": ["read", "grep", "find", "ls"],
  "mcp_tools": {
    "github": ["search", "get_issue"],
    "linear": []
  },
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high",
  "instructions": "Focus on correctness and security. Do not modify files.",
  "subagents": {
    "defaultModel": "openai/gpt-5.4",
    "defaultThinking": "medium",
    "agentOverrides": {
      "reviewer": {
        "model": "inherit",
        "thinking": "high",
        "description": "Independent code review",
        "advertise": true
      }
    }
  }
}
```

The profile object is the JSON top-level value. Every field is optional; omitted fields add no profile control and keep native Pi behavior. Validate field types with [`schemas/profiles.schema.json`](schemas/profiles.schema.json).

### Field reference

| Field | Type | Purpose |
| --- | --- | --- |
| `label` | `string` | Display name in the selector; does not change the profile's filename. |
| `description` | `string` | Description in the selector. |
| `skills` | `string[]` | Select skills by name or glob. |
| `extensions` | `string[]` | Select extensions by identifier, glob, or specified path. |
| `mcps` | `string[]` | Select user-level MCP servers by name or glob. |
| `tools` | `string[]` | Select non-MCP tools by name or glob, including built-in and extension-contributed tools. |
| `mcp_tools` | `Record<string, string[]>` | Select tools per MCP server; see MCP configuration below. |
| `defaultProvider` | `string` | Default model provider; declare together with `defaultModel`. |
| `defaultModel` | `string` | Model ID within the provider; declare together with `defaultProvider`. |
| `defaultThinkingLevel` | `string` | Startup thinking level for the model above; takes effect only when both model fields are declared. A declared level governs startup even when the user has pinned the same model globally, for the life of that launch (returning to the model later in the same launch also uses this level). It never rewrites the user's settings or their pins for other models. Use a value supported by Pi. |
| `instructions` | `string` | Text appended to the system prompt without replacing it. |
| `subagents` | `object` | pi-subagents defaults and role-specific settings; see Child-agent configuration below. |

Pi handles model availability, authentication, and command-line precedence. Declaring only `defaultProvider` or `defaultModel` does not set a profile default model. When both model fields are declared, an invalid `defaultThinkingLevel` string produces a warning and is ignored without removing the model declaration.

For when a declared model actually takes effect, how the configured model scope decides whether it is used at all, what happens when it cannot be used, and what a profile does not control (cost, authorization, in-session changes), see [Model and thinking-level selection](docs/model-selection.md).

### Resource selection

Profiles reference existing resources without installing or copying them. Use these reference forms:

| Resource field | Reference forms and examples |
| --- | --- |
| `skills` | Skill names such as `"profile-config"`, or globs such as `"review-*"`. |
| `extensions` | Installed package names or source aliases; `<package>:<relative path>` for multi-entry packages; loose-file identifiers; globs; absolute or `~/` paths. |
| `mcps` | Server names from MCP configuration such as `"github"`, or globs such as `"internal-*"`. |
| `tools` | Non-MCP tool names in Pi such as `"read"` and `"bash"`, or globs such as `"test_*"`. |

A loose extension file's identifier is its path relative to the extensions directory without the `.ts` or `.js` suffix. For example, `conventions.ts` is `conventions`, and `sub/index.ts` is `sub`. Extension paths must be absolute or start with `~/`; relative paths are not accepted.

For resource lists, omitting a field leaves that resource kind unrestricted by the profile; `[]` selects none; a nonempty array selects only matching resources. For example:

```json
{
  "skills": [],
  "extensions": [],
  "mcps": [],
  "tools": ["read", "grep", "find", "ls"]
}
```

Skill, extension, and MCP server selections narrow only user-level resources. Pi's project-trust decision governs project-level visibility; profiles do not hide those resources. Pi's existing resource exclusions remain effective.

`tools` does not restrict MCP tools or disable the entry points Pi needs to invoke them. Use `mcp_tools` to restrict MCP tools; a read-only file-tool list does not automatically prevent MCP write operations.

### MCP configuration

MCP server addresses, start commands, and credentials stay in Pi's MCP configuration. Profiles only select servers and tools.

User-level configuration is read in this order. A later source completely replaces an earlier same-named server definition without merging fields:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `<agentDir>/mcp.json`, where `<agentDir>` is Pi's user directory, usually `~/.pi/agent`

Pi reads a trusted project's `.pi/mcp.json`; its servers are not narrowed by `mcps` or `mcp_tools`. Selecting a server does not force-enable it if its source configuration disables it.

Each `mcp_tools` key must be a server name. Array entries must be tool names shown by Pi's native MCP interface. Neither accepts globs.

| Declaration | Effect |
| --- | --- |
| Omit `mcp_tools`, or use `{}` | Keep each server's existing tool configuration. |
| Omit a server from `mcp_tools` | Keep that server's existing tool configuration. |
| `"github": ["search", "get_issue"]` | Replace that server's existing tool selection, allowing only matches. |
| `"github": []` | Deny all tools from that server without disabling the server itself. |

MCP tool names are not validated in advance. A misspelled name stays restrictive but produces no tool-name diagnostic; inspect the actual names exposed by the server in Pi before configuring them.

For lasting MCP connection changes, edit the user-level files above. Changes made through `pi mcp add` in a `pi-profile` session are overwritten on the next profile switch or reload.

### Child-agent configuration

`subagents` does not load pi-subagents, automatically add extensions, authorize delegation tools, or create roles. Install and load pi-subagents normally through Pi and allow the relevant tools before using these settings.

| Field | Type | Purpose |
| --- | --- | --- |
| `subagents.defaultModel` | `string` | Default model for child agents without a specified model. Uses native pi-subagents model syntax, such as `openai/gpt-5.4`. |
| `subagents.defaultThinking` | `string` | Default thinking level for child agents without a specified level. |
| `subagents.agentOverrides` | `object` | Overrides keyed by exact, case-sensitive role names; globs and surrounding whitespace are not allowed. |
| `subagents.agentOverrides.<name>.model` | `string \| false` | Set the role model; `"inherit"` uses the current parent session model, and `false` clears the role's explicit model setting. |
| `subagents.agentOverrides.<name>.thinking` | `string \| false` | Set the role thinking level; `false` clears the role's explicit thinking setting. |
| `subagents.agentOverrides.<name>.description` | `string` | Role-description metadata, not child prompts. |
| `subagents.agentOverrides.<name>.advertise` | `boolean` | Controls listing in the parent prompt, not whether a role can run; `false` hides the listing. |

Child-agent thinking levels use the schema's supported `thinkingLevel` values. Every child-agent text field must be nonempty.

Omitting `subagents`, using `{}`, or supplying only empty role objects adds no child-agent control. Declaring one role does not exclude others. Undeclared role fields retain native settings; explicit `false` is not equivalent to omission.

Native pi-subagents project, provider, and per-run settings can still override these declarations. `/profile status` shows profile declarations; `/subagents-models` shows live model mappings. See the [pi-subagents model documentation](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md) for model syntax and native precedence.

### Apply edits and diagnose problems

After editing the active profile file, run these in the session:

```text
/profile reload
/profile status
```

| Condition | Action |
| --- | --- |
| Invalid JSON, a non-object top-level value, or a field-type error | Activation fails; fix the file and field named in the error, then retry. |
| Unknown top-level field | The field is ignored with a warning; use a supported field from the diagnostic. |
| Unsupported nested field in `subagents` | Activation fails; remove or correct the field as directed. |
| Unmatched skill, extension, MCP server, or non-MCP tool reference | Activation continues with warnings and usable matches; correct the name or install the resource, then reload. If every reference misses, the selection stays empty rather than restoring all resources. |
| An MCP server is unknown, disabled, or project-owned only | A warning is reported without creating or force-enabling servers or changing project-owned servers; check user-level MCP configuration and names. |
| Malformed user-level MCP configuration | Its path is reported and the source is skipped while valid sources remain usable; fix the file and reload. |
| Model or authentication error | Follow Pi's native diagnostic to check the provider, model, and credentials. |
