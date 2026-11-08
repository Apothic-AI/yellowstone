# pi-profile-switch Product Requirements

## Problem

Pi discovers resources globally: whichever skills, extensions, MCP servers, and tools are installed are all available in every session. As the number of resources grows, three things get worse at the same time.

- Context fills up. Every skill's name and description lives permanently in the system prompt; skills irrelevant to the current task occupy space just the same.
- Dangerous capabilities stay resident. File writes, command execution, and write access to external systems remain in the tool list once installed.
- Boundaries can only exist in prompts. Switching between "read-only review" and "full implementation" means switching the capability set itself — a prompt cannot constrain whether a tool exists.

Profiles turn resource selection into an explicit, switchable object, optionally accompanied by a declared model, thinking level, extra system-prompt instructions, and native child-role settings. Child-role declarations are an opt-in profile behavior, described by the [profile-catalog contract](../openspec/specs/profile-catalog/spec.md). A profile does not copy resources: a `SKILL.md`, extension, or MCP server has exactly one implementation, referenced by any number of profiles.

```text
SkillRegistry
  git-commit ──► ~/.pi/agent/skills/git-commit/SKILL.md
       ▲                 ▲
       │                 │
  review profile     implement profile
```

## Scenarios

- **Switch by task**: `review` carries only review skills and read-only tools; `implement` carries full editing and testing capability.
- **Switch by project**: the project catalog replaces same-named global definitions, narrowing user-level resources to what the project needs while inside the project directory; the global definitions return after leaving the project.
- **Narrow by permission**: read-only Q&A, restricted environments, and external demos use profiles to shrink the capability surface.
- **Shared implementations**: fix one skill and every profile referencing it picks up the new content on the next launch or reload.

## Target users

The primary user is an individual developer who already uses Pi across multiple projects and has multiple skills, extensions, and MCP servers installed.

The secondary user is anyone who needs to draw a capability boundary for the agent — read-only review, restricted environments, and the like.

Both presuppose familiarity with Pi's resource discovery and settings concepts. Profiles reference Pi's own resource names; you cannot define a profile without knowing which resources exist in Pi.

## Design principles

### Pi compatibility first

A profile changes only what it explicitly declares control over; everything else goes through Pi's native mechanisms.

Rationale: a user's expectations of Pi's behavior should not change because they installed a profile package, and other Pi packages should not be disrupted. The cost is that a profile cannot "opportunistically" fix Pi's behavior: when Pi imposes a limit, the profile can only report it, not work around it.

### Minimalism consistent with Pi

Keep the configuration surface as small as possible: prefer discovery over registration, defaults over required fields, actionable errors over silent failures.

Rationale: Pi itself is minimal, and the profile layer should not become a new learning burden. The cost is that some more convenient designs get rejected — anything requiring an extra configuration file or a registration step is not adopted, even if it feels nicer.

## Product goals

- Organize how Pi works through named profiles, covering all three switching motivations: by task, by project, by permission.
- Switch profiles within the same running Pi session, without restarting the process.
- Reference existing resources instead of copying them, so resource maintenance happens in exactly one place.
- Let project-level definitions override global definitions, and automatically return to the global definitions after leaving the project.
- Leave Pi behavior that no profile has declared control over untouched.
- Be useful immediately after install — capability isolation without writing any configuration first.
- Send a startup notification, best-effort, when the installed package is behind npm's installable `latest` version or when a maintainer-reviewed announcement applies — with a concise action and no routine release details (see [Architecture](architecture/overview.md) for ownership and boundaries).

## Non-goals

- **No profile inheritance or composition.** No `extends`, no deep merge, no array appending; a same-named profile is a complete replacement. Once users depend on inheritance there is no going back, and only self-contained definitions can be understood without resolving a parent chain.
- **No resource copies.** A profile references skills, extensions, MCP servers, and tools by name and never stores copies. Copying would fork implementations into N variants and violates the premise that users directly own their resources.
- **No extension dependency graph.** No dependency declarations, no dependency closure, no always-on extension concept. Pi itself has none of these; introducing them at the profile layer would turn the switcher into half a package manager.
- **Not a package manager.** Does not install, upgrade, or uninstall extensions; only discovers what is already installed and filters from it. Startup upgrade reminders and announcements likewise never install or upgrade anything: they only name the global-install command for the user to run.
- **No MCP connection parameters or credentials.** Server addresses, start commands, OAuth, and tokens all stay in Pi's user-level MCP configuration (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, and `<agentDir>/mcp.json`); a profile only declares which servers are enabled and, optionally via `mcp_tools`, which MCP tool selections apply per server. Pi tool selection (`tools`) and per-server MCP tool selection (`mcp_tools`) are independent; omitting `mcp_tools` preserves full native tool availability for enabled servers.
- **No narrowing of project-level resources.** A profile's selection applies only to user-level resources (the real agentDir and `~/.agents/skills`). The visibility of project-level skills, extensions, prompts, themes, settings, and MCP servers is decided by Pi's project-trust determination; no profile may hide any of them. Rationale: Pi's project-level switch is all-or-nothing, and the scope in which "selected means effective" must stay within what a profile is entitled to dispose of; forced narrowing would additionally block project content that is not part of the isolation surface and would break in-session switching (see the filtering model in [Architecture](architecture/overview.md)).
- **No changes to Pi defaults.** Settings, discovery, and session behavior that no profile has declared control over work according to Pi's native rules.

## Success criteria

1. A launched profile's user-level resource visibility follows the [sparse skill and extension selection contract](../openspec/specs/resource-reference/spec.md): a declared kind is a selection, an omitted kind keeps Pi's native visibility. Project-level visibility follows the trust determination, per the [project boundary](../openspec/specs/resource-reference/spec.md#requirement-narrowing-boundary-of-project-level-resources).
2. Switching profiles does not restart the Pi process; the current session's sessionId and history remain unchanged.
3. After modifying a skill or extension referenced by multiple profiles, those profiles pick up the new content on the next launch or reload without touching any profile definition.
4. When a profile declares no model, thinking level, or instructions, Pi's model, thinking level, and system prompt after activation match a native launch.
5. Without any MCP server configuration, every profile that declares no MCP servers and no MCP tool restrictions remains fully functional.
6. A failed profile activation leaves no half-activated state behind and reports an actionable cause.

## Related documents

[CONTEXT.md](../CONTEXT.md) · [openspec/specs/](../openspec/specs/) · [Architecture](architecture/overview.md) · [ADRs](adr/) · [README](../README.md)
