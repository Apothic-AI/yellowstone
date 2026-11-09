**Superseded by ADR-0018.**

# Failure tiering for reference resolution

## Context

A profile's references can be literals (skill names, package names, loose-file names, MCP server names, tool names) or globs, and the two have completely different observability.

A misspelled literal is a definite error that can be pointed out immediately. A zero-match glob might be a typo, but might equally mean the resource simply is not installed yet — and a glob is a dynamic reference, re-expanded on every reload.

## Decision

Tier by error certainty rather than failing uniformly:

| Reference form | Outcome |
| --- | --- |
| Unmatched literal (skill, MCP server) | Hard failure, reports `unknown <kind>` |
| Unmatched literal (extension) | Hard failure; the error carries the discovered candidate list and near-miss hints |
| Zero-match glob (skill, extension, MCP) | Soft failure; collected into `plan.unmatched`, visible as launch warnings and in `/profile status`, does not block activation |
| Zero-match glob (tool) | Not recorded |
| Unmatched literal (tool) | Passed through, not validated |

Tools are the only exception because they are contributed by extensions and unknowable before spawn: a zero match before spawn is not evidence, and literals cannot be validated.

When a loose file and a package name produce the same ID, **the loose file wins**, a warning is logged, and the package remains selectable via its source alias.

## Rejected alternatives

**Hard-failing every reference failure**, symmetric with literals. Rejected for zero-match globs because a glob is a dynamic reference: treating zero matches as an error would turn the legitimate "reserve a glob for resources to be installed later" usage into a blocking failure.

## Consequences

- A misspelled glob does not block activation; it only appears in launch warnings and `/profile status`, and may be overlooked.
- An unmatched tool literal passes silently until the called tool turns out not to exist.
- The winner of an ID collision is decided by on-disk state; the actual meaning of a package-name reference depends on whether a loose file exists.
