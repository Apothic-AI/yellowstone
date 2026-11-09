# Glossary

## Domain terms

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Profile** | A named capability definition: references skills, extensions, MCP servers, and tools; optionally declares model, thinking level, instructions, and native child-role settings. | preset, config, bundle, capability |
| **default profile** | The built-in profile: not deletable, absent from catalog files; loads every resource Pi can discover. | built-in |
| **Catalog** | The `profiles/` directory holding profile definitions: one global, one per project, one `<name>.json` file per profile. | — |
| **Source scope** | Where a profile comes from: `builtin`, `global`, or `project`. Determines which scope its runtime state and edits are written to. | — |
| **RuntimeOverlay** | A temporary narrowing of the active profile: disables resolved skills, extensions, MCP servers, or tools. Usually just "overlay". | session profile, temporary profile |
| **Runtime state** | The persisted active-profile selection and overlay. | — |
| **Resource** | Anything a profile can reference: a skill, extension, MCP server, or tool. | — |
| **Project trust** | Pi's trust decision about a project directory; determines whether the project-level catalog and project resources participate in resolution. | — |
| **pi-mcp-adapter** | Legacy optional Pi package that previously owned MCP server configuration, connections, and credentials. pi-profile-switch now targets Pi's built-in MCP extension and no longer depends on this package. | — |

## Internal terms

| Term | Meaning | Avoid |
| --- | --- | --- |
| **ActivationPlan** | The immutable resource and tool set resolved from one profile plus one overlay; produced by ProfileResolver. | — |
| **SkillRegistry** | Mapping from skill name to the winning `SKILL.md`; mirrors Pi's full discovery result. | — |
| **ExtensionDiscovery** | The referenceable view of extensions: installed packages and loose files in standard directories. Pure discovery, no registration layer. | — |
| **McpServerRegistry** | MCP server names and states as discovered from Pi's user-level MCP configuration and the trusted-project classification source. | — |
| **instance** | The runtime directory `pi-profile-switch` generates for one Pi process, handed to Pi via `PI_CODING_AGENT_DIR`. | — |
| **Generated settings** | The `settings.json` written into the instance; encodes the profile's resource selection as native Pi settings. | — |
| **Runtime reload** | Pi natively re-reads settings and rebuilds resources while preserving the current session. | — |
| **Adoption** | A sweep disposition: an unrecognized entry whose content scan confirms it does not reference its own instance path is moved into the real agentDir; after adoption, the next launch turns it into a symlink via mirroring (ADR-0012). | absorption |
