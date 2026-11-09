# Tasks

## 1. Skill content

- [x] 1.1 Add `skills/profile-config/SKILL.md`: the frontmatter `name` must be `profile-config` (matching the reference name of the default injection; a mismatch fails named-profile activation), and `description` states the trigger scenarios (when creating/modifying/deleting profiles). Content: guide the agent to create/modify/delete profiles from vague or explicit requirements. Covers: the name charset `^[A-Za-z0-9][A-Za-z0-9._-]*$`, the bare-definition format and all field semantics, global `$PI_PROFILE_SWITCH_DIR/profiles/` (default `~/.pi-profile-switch/profiles/`) vs project `<projectDir>/.pi/profiles/` storage locations, discovery locations of referenceable resources (`<agentDir>/skills/`, `~/.agents/skills/`, installed packages declared in `<agentDir>/settings.json`, loose files under `<agentDir>/extensions/`, `<agentDir>/mcp.json`; tool reference identity is the tool name in Pi's tool registry; project-level resource visibility does not narrow with profiles — do not guide declaring them), the default injection rule at authoring time (profiles generated with a `skills` array include `"profile-config"` by default unless the user explicitly opts out; no duplicate injection when `skills` already contains a covering glob like `"*"`; no action when `skills` is undeclared), degradation to outputting JSON when no `write` tool is available, prompting `/trust` + restart before writing project scope in untrusted projects, and a notice that the content is package-owned and must not be hand-edited. Verification: check the format and discovery-fact descriptions item by item against the main specs `openspec/specs/profile-catalog/spec.md` and `openspec/specs/resource-reference/spec.md` for consistency

## 2. Distribution

- [x] 2.1 `bin/postinstall.js`: write the shipped skill into the user agentDir's `skills/profile-config/` at install time. This file is plain JS (npm postinstall environment constraints), and the existing mirror only covers profile-switch directory resolution; a new agentDir-resolution mirror is needed (`PI_CODING_AGENT_DIR` supports `~` expansion, default `~/.pi/agent`), honoring the file header's "keep in sync" comment convention. Always overwrite; failure degrades to a warning and does not block install. Verification: unit tests cover every scenario of "Distributing the profile-config skill at install"
- [x] 2.2 `package.json`: add `skills` to the `files` array. Verification: `npm pack --dry-run` output contains `skills/profile-config/SKILL.md`

## 3. Regression and docs

- [x] 3.1 `npm run check` and `npm test` all pass
- [x] 3.2 `README.md` and `README.zh-CN.md`: mention the shipped `profile-config` skill, its purpose, and the default-injection convention
