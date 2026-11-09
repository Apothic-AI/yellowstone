**Superseded by ADR-0016.**

# MCP integration locked to pi-mcp-adapter

## Context

MCP server connection parameters, OAuth, and tokens are credentials, not profile resource configuration. pi-profile needs to limit the available servers per profile, but should not implement server management itself.

## Decision

MCP support is fully delegated to the optional `pi-mcp-adapter` package. A profile's `mcps` array only declares which servers are enabled and serves as that profile's persistent store; connection parameters, OAuth, and tokens all stay in the adapter's configuration, which pi-profile never writes.

pi-profile does not register an `/mcp` command and does not occupy that namespace.

## Rejected alternatives

**pi-profile manages MCP configuration itself.** Rejected because it would fork server management away from the adapter's single implementation and pull credentials into the profile catalog.

**The once-implemented `/mcp enable|disable` command has been withdrawn.** Registering `/mcp` would collide with `pi-mcp-adapter`'s native command namespace and hijack its TUI setup, status, tools, reconnect, and other subcommands. All `/mcp` commands return to the adapter.

## Consequences

- If a profile declares `mcps` while the adapter is not installed, that profile fails to activate. Profiles without `mcps` do not depend on the adapter.
- A profile can only declare which servers are enabled, not how a server connects; adding or modifying servers must go through the adapter's own configuration surface.
