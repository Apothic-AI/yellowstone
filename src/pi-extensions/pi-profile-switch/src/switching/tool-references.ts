/**
 * Tool reference expansion against Pi's LIVE tool registry.
 *
 * Pre-spawn, the resolver expands tool globs against built-in names only
 * (extension tools are unknowable before extension code runs). Post session
 * start, the extension re-expands the raw references against
 * `pi.getAllTools()`, which includes extension- and MCP-provided names.
 * Literal references that match nothing are reported, not silently dropped
 * (Pi's setActiveTools ignores unknown names).
 *
 * Provenance rides the same expansion (ADR-0022): when the caller supplies the
 * plan's per-raw-reference contributor map, each expanded live tool name gets
 * the union of the contributors of every reference that produced it, and each
 * reference gets exactly one in-process outcome. This module reads nothing —
 * no filesystem, no backend, no registry of its own — and the existing session-
 * start caller stays the only consumer.
 */

import { minimatch } from "minimatch";

import type { ContributorSet } from "../profile-composition.ts";

/** The only two states a tool reference can reach at session start. Boot
 *  "pending" is not a state of this expansion: a reference the boot pass could
 *  not resolve is carried separately in the launch plan until this moment. */
export type ToolState = "resolved" | "dropped";

export interface ToolExpansion {
	expanded: string[];
	/** Literal references no live tool provides. */
	droppedLiterals: string[];
	/** References that matched only MCP-owned tools in the live registry. */
	legacyMcpReferences: string[];
	/** Per expanded live tool name: the union of the contributors of the raw
	 *  references that produced it. Present only when the caller supplied the
	 *  contributor map. */
	contributors?: Record<string, ContributorSet>;
	/** Exactly one in-process outcome per raw reference. A `dropped` entry has
	 *  the same facts as `droppedLiterals` / `legacyMcpReferences`, or is a
	 *  zero-match glob that neither list reports; no warning path is added.
	 *  Nothing stays pending in-process, and the persisted plan is not
	 *  rewritten. Present only when the caller supplied the contributor map. */
	outcomes?: Record<string, { state: ToolState; contributors: ContributorSet }>;
}

/** Defines an own data property so a reference or tool name that shadows an
 *  Object prototype member ("__proto__", "toString") stays data. */
function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

export function expandToolReferences(
	references: string[],
	liveToolNames: string[],
	mcpToolNames: string[] = [],
	referenceContributors?: Readonly<Record<string, ContributorSet>>,
): ToolExpansion {
	const liveNonMcp = new Set(liveToolNames);
	const liveMcp = new Set(mcpToolNames);
	const expanded = new Set<string>();
	const contributors: Record<string, ContributorSet> = {};
	const outcomes: Record<string, { state: ToolState; contributors: ContributorSet }> = {};
	const droppedLiterals: string[] = [];
	const legacyMcpReferences: string[] = [];
	const trace = referenceContributors !== undefined;

	for (const reference of references) {
		const referenceContributor = trace && Object.hasOwn(referenceContributors, reference)
			? referenceContributors[reference]
			: undefined;
		const produced: string[] = [];
		const contribute = (name: string): void => {
			expanded.add(name);
			produced.push(name);
			if (referenceContributor === undefined) return;
			const existing = Object.hasOwn(contributors, name) ? contributors[name] : undefined;
			// Union, never first-writer: overlapping references report both halves.
			setOwnRecordValue(contributors, name, existing === undefined || existing === referenceContributor ? referenceContributor : "both");
		};

		if (reference.includes("*") || reference.includes("?")) {
			let matchedNonMcp = false;
			for (const name of liveToolNames) {
				if (minimatch(name, reference)) {
					contribute(name);
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
		} else if (liveNonMcp.has(reference)) {
			contribute(reference);
		} else if (liveMcp.has(reference)) {
			legacyMcpReferences.push(reference);
		} else {
			droppedLiterals.push(reference);
		}

		if (referenceContributor !== undefined) {
			// Exactly one outcome per reference, in-process only.
			setOwnRecordValue(outcomes, reference, {
				state: produced.length > 0 ? "resolved" : "dropped",
				contributors: referenceContributor,
			});
		}
	}

	return {
		expanded: [...expanded],
		droppedLiterals,
		legacyMcpReferences,
		...(trace ? { contributors } : {}),
		...(trace ? { outcomes } : {}),
	};
}
