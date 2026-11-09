# Profiles reference resources, never copy them

## Context

Profiles need to reference skills, extensions, MCP servers, and tools. These resources already have implementations and names in Pi.

## Decision

Profiles reference resources by name and never copy them. A `SKILL.md`, extension, or MCP server has exactly one implementation, shared by every profile that references it. After the implementation is modified, referrers pick up the new content on the next launch or reload without any profile definition changing.

## Rejected alternatives

**Self-contained profiles with resource copies inside the profile directory.** Rejected because it would fork implementations into N variants — fixing one skill would mean editing N copies — and it breaks the premise that users directly own and maintain their resources.

## Consequences

- Deleting or renaming a resource affects every profile that references it at the same time.
