/**
 * Tool reference expansion against Pi's LIVE tool registry.
 *
 * Pre-spawn, the resolver expands tool globs against built-in names only
 * (extension tools are unknowable before extension code runs). Post session
 * start, the extension re-expands the raw references against
 * `pi.getAllTools()`, which includes extension- and MCP-provided names.
 * Literal references that match nothing are reported, not silently dropped
 * (Pi's setActiveTools ignores unknown names).
 */

import { minimatch } from "minimatch";

export interface ToolExpansion {
	expanded: string[];
	/** Literal references no live tool provides. */
	droppedLiterals: string[];
	/** References that matched only MCP-owned tools in the live registry. */
	legacyMcpReferences: string[];
}

export function expandToolReferences(
	references: string[],
	liveToolNames: string[],
	mcpToolNames: string[] = [],
): ToolExpansion {
	const liveNonMcp = new Set(liveToolNames);
	const liveMcp = new Set(mcpToolNames);
	const expanded = new Set<string>();
	const droppedLiterals: string[] = [];
	const legacyMcpReferences: string[] = [];

	for (const reference of references) {
		if (reference.includes("*") || reference.includes("?")) {
			let matchedNonMcp = false;
			for (const name of liveToolNames) {
				if (minimatch(name, reference)) {
					expanded.add(name);
					matchedNonMcp = true;
				}
			}
			if (!matchedNonMcp && mcpToolNames.length > 0) {
				for (const name of mcpToolNames) {
					if (minimatch(name, reference)) {
						legacyMcpReferences.push(reference);
						break;
					}
				}
			}
			continue;
		}

		if (liveNonMcp.has(reference)) {
			expanded.add(reference);
		} else if (liveMcp.has(reference)) {
			legacyMcpReferences.push(reference);
		} else {
			droppedLiterals.push(reference);
		}
	}
	return { expanded: [...expanded], droppedLiterals, legacyMcpReferences };
}
