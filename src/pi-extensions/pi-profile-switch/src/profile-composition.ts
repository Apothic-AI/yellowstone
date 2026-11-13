/**
 * ProfileComposition: the pure merge of one project definition that declares
 * `"promptStrategy": "append"` with its same-named global base.
 *
 * Purity is the reason this module exists: it imports no filesystem, no
 * discovery, and no clock surface, so the merge rules cannot observe the
 * environment and a merged definition can never be cached, materialized, or
 * written back. Everything it needs — including both file paths — arrives as
 * an argument.
 *
 * Behavior is owned by `openspec/specs/profile-catalog/spec.md` "Profile
 * composition strategy" and `openspec/specs/resource-reference/spec.md`
 * "Composed reference declarations", "Standalone append declaration intent",
 * "Composite declaration intent and unapplied references", and "Negated glob
 * reference guard in a composed project half". The truth tables are
 * `openspec/changes/2026-11-11-project-profile-append-composition/matrices.md`
 * §1–§3 and §7.
 *
 * Two inputs, two branches:
 * - `global === undefined` is the standalone branch: no base exists, so the
 *   project definition's own declarations apply as written. The
 *   unrestricted-kind rule does not apply, because there is no base
 *   declaration whose omission could make a project reference a widening
 *   attempt.
 * - a base that exists (even one that omits a kind) is the composed branch.
 */

import { CatalogError } from "./catalog-error.ts";
import type { ProfileDefinition } from "./profile-catalog.ts";

/** Which half declared a raw reference. */
export type ContributorScope = "global" | "project";
/** The union of the scopes that declared one raw reference. */
export type ContributorSet = "global" | "project" | "both";
/** Disjoint kind for an identity selected because its kind is undeclared. */
export type ProvenanceKind = ContributorSet | "native";

/** The resource lists whose raw references carry contributors. */
export type ReferenceListKind = "skills" | "extensions" | "mcps" | "tools";
/** An unapplied declaration can also be a per-server MCP tool policy. */
export type UnappliedReferenceKind = ReferenceListKind | "mcp_tools";

export type PromptStrategy = "append" | "replace";
/** The accepted strategy set, enumerated by the governing contract. */
export const PROMPT_STRATEGIES: readonly PromptStrategy[] = ["append", "replace"];

/** A catalog scope a definition is read from; decides which strategies are valid. */
export type ProfileScope = "global" | "project";

export interface UnappliedReference {
	kind: UnappliedReferenceKind;
	/** Verbatim as declared: the raw reference, or the MCP server key. */
	reference: string;
	/** Only a project half can be unapplied. */
	scope: "project";
}

export interface CompositionDiagnostic {
	code: "append-unapplied-reference" | "append-cannot-narrow" | "append-standalone";
	/** Verbatim reference or server key, when the diagnostic is about one. */
	reference?: string;
	/** Actionable; names the file and the fix, and states what was not validated. */
	message: string;
}

/** A raw tool reference the boot expansion could not resolve. Never keyed as a
 *  tool name: presence in the boot plan proves nothing about a runtime tool,
 *  because boot expansion passes unknown literals through. The persisted plan
 *  is written before session start, so it carries only this boot-snapshot
 *  state; the session-start outcome is in-process and is not rewritten into
 *  the plan. */
export interface PendingToolReference {
	/** Verbatim as declared. */
	reference: string;
	contributors: ContributorSet;
	resolvesAt: "session-start";
}

export interface CompositionResult {
	definition: ProfileDefinition;
	/** Per raw reference: the scopes that declared this exact literal. It is
	 *  keyed by the raw declaration, not by a resolved identity: the composer
	 *  has no discovery, so it cannot know which identity a glob yields. Only
	 *  applied declarations appear — an unapplied reference is reported in
	 *  `unapplied` instead, because nothing expands it. */
	referenceContributors: Record<ReferenceListKind, Record<string, ContributorSet>>;
	/** Always empty on the standalone branch: there is no base whose
	 *  declaration could be widened. */
	unapplied: UnappliedReference[];
	diagnostics: CompositionDiagnostic[];
	/** `"standalone"` when no base was read; `"composed"` otherwise. */
	branch: "composed" | "standalone";
}

/** Composition metadata retained on the resolved profile for the surfaces that
 *  report a composition later (status, list). Informational only: it never
 *  influences selection. */
export interface ProfileComposition {
	strategy: "append";
	branch: "composed" | "standalone";
	/** The global base that was read. Absent on the standalone branch. */
	globalPath?: string;
	projectPath: string;
	referenceContributors: Record<ReferenceListKind, Record<string, ContributorSet>>;
	unapplied: UnappliedReference[];
	diagnostics: CompositionDiagnostic[];
}

const LIST_KINDS: readonly ReferenceListKind[] = ["skills", "extensions", "mcps", "tools"];

/**
 * Reads one `promptStrategy` value. The accepted set is exactly `append` and
 * `replace`; a project definition may omit the field (meaning `replace`) or
 * declare either value, and a global definition may declare `replace` (inert)
 * but never `append`, because no definition composes a global one.
 *
 * This is the single validator for both halves: the catalog parser assigns
 * its result into a `ProfileDefinition`, so a declared strategy is retained as
 * a parsed field rather than merely tolerated by the schema.
 */
export function resolvePromptStrategy(
	value: unknown,
	scope: ProfileScope,
	context: { profile?: string; filePath?: string },
): PromptStrategy {
	const prefix = context.filePath !== undefined ? `${context.filePath}: ` : "";
	const subject = context.profile !== undefined ? `profile "${context.profile}": ` : "";
	const accepted = PROMPT_STRATEGIES.map((strategy) => `"${strategy}"`).join(" and ");
	if (value === undefined) return "replace";
	if (typeof value !== "string" || !PROMPT_STRATEGIES.includes(value as PromptStrategy)) {
		throw new CatalogError(
			`${prefix}${subject}"promptStrategy" must be one of ${accepted}; got ${JSON.stringify(value)}`,
		);
	}
	if (value === "append" && scope === "global") {
		throw new CatalogError(
			`${prefix}${subject}"promptStrategy": "append" is only valid in a project definition; a global definition has no base to compose with; accepted values are ${accepted}, and only "replace" is valid here`,
		);
	}
	return value as PromptStrategy;
}

/** The resolver's own glob reading: `*` and `?` are the only glob characters
 *  it expands, so the guard below rejects exactly the references whose glob
 *  expansion would consume a leading `!` as negation. A broader reading here
 *  would reject a reference the resolver treats as a literal miss. */
function isGlobReference(reference: string): boolean {
	return reference.includes("*") || reference.includes("?");
}

/**
 * Rejects a `!`-prefixed glob in the project half of an `append` definition.
 * The current glob semantics read a leading `!` as a negation gate, so such a
 * reference would select every resource except its own pattern instead of
 * adding to the selection. The guard is scoped to the append project half:
 * global halves and every replacing definition keep today's behavior.
 */
function assertNoNegatedGlobs(project: ProfileDefinition, projectPath: string): void {
	for (const kind of LIST_KINDS) {
		for (const reference of project[kind] ?? []) {
			if (reference.startsWith("!") && isGlobReference(reference)) {
				throw new CatalogError(
					`${projectPath}: profile declares ${kind} reference "${reference}" in an append definition; a leading "!" is read as glob negation, so it would select everything except "${reference}" instead of adding to the selection; remove the "!" or use the replacement strategy`,
				);
			}
		}
	}
}

/** Defines an own data property, so a reference or server key that shadows an
 *  Object prototype member ("__proto__", "toString") stays data rather than
 *  mutating the map's prototype or disappearing from it. */
function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function addContributor(
	contributors: Record<string, ContributorSet>,
	reference: string,
	scope: ContributorScope,
): void {
	const existing = Object.hasOwn(contributors, reference) ? contributors[reference] : undefined;
	// Union, never first-writer: an identical literal, an overlapping
	// glob/literal pair, and an alias/name pair all report both halves.
	setOwnRecordValue(contributors, reference, existing === undefined ? scope : existing === scope ? scope : "both");
}

function emptyContributors(): Record<ReferenceListKind, Record<string, ContributorSet>> {
	return { skills: {}, extensions: {}, mcps: {}, tools: {} };
}

/** Composes one list kind. Returns the composite value (`undefined` keeps the
 *  kind undeclared) plus the references the composite could not apply. */
function composeListKind(
	kind: ReferenceListKind,
	global: ProfileDefinition | undefined,
	project: ProfileDefinition,
	contributors: Record<string, ContributorSet>,
): { value: string[] | undefined; unapplied: UnappliedReference[] } {
	const globalList = global?.[kind];
	const projectList = project[kind];
	if (globalList === undefined) {
		// The base exists but leaves this kind undeclared (or there is no base):
		// native visibility stands and project references for it cannot be
		// applied. A declared empty project list requests nothing, so it is not
		// an unapplied reference either — the kind simply stays undeclared.
		if (projectList === undefined || projectList.length === 0) return { value: undefined, unapplied: [] };
		return {
			value: undefined,
			unapplied: projectList.map((reference) => ({ kind, reference, scope: "project" as const })),
		};
	}
	const merged = kind === "tools"
		// Raw tool references are additionally deduplicated by exact string
		// before expansion; the other kinds dedupe by resolved identity.
		? [...new Set([...globalList, ...(projectList ?? [])])]
		: [...globalList, ...(projectList ?? [])];
	for (const reference of globalList) addContributor(contributors, reference, "global");
	for (const reference of projectList ?? []) addContributor(contributors, reference, "project");
	return { value: merged, unapplied: [] };
}

/** Composes `mcp_tools` per server key: the additive-only rule evaluated
 *  against what the base already allows. */
function composeMcpTools(
	global: ProfileDefinition | undefined,
	project: ProfileDefinition,
	projectPath: string,
): {
	value: Record<string, string[]> | undefined;
	unapplied: UnappliedReference[];
	diagnostics: CompositionDiagnostic[];
} {
	const globalTools = global?.mcp_tools;
	const projectTools = project.mcp_tools;
	const unapplied: UnappliedReference[] = [];
	const diagnostics: CompositionDiagnostic[] = [];
	for (const server of Object.keys(projectTools ?? {})) {
		if (globalTools !== undefined && Object.hasOwn(globalTools, server)) continue;
		// A composed definition cannot introduce a restriction the base does not
		// have. The entry is dropped and diagnosed, never applied.
		unapplied.push({ kind: "mcp_tools", reference: server, scope: "project" });
		diagnostics.push({
			code: "append-cannot-narrow",
			reference: server,
			message: `${projectPath}: profile declares "mcp_tools" for server "${server}" in an append definition, but the global definition does not restrict that server, so the entry was not applied and was not validated against discovery; a composed definition cannot introduce a restriction — use the replacement strategy or /profile overlay to narrow`,
		});
	}
	if (globalTools === undefined) {
		return { value: undefined, unapplied, diagnostics };
	}
	const composed: Array<[string, string[]]> = [];
	for (const [server, selectors] of Object.entries(globalTools)) {
		const added = projectTools !== undefined && Object.hasOwn(projectTools, server) ? projectTools[server] ?? [] : [];
		composed.push([server, [...new Set([...selectors, ...added])]]);
	}
	return { value: Object.fromEntries(composed), unapplied, diagnostics };
}

/** Project instructions are appended to the base's text; a byte-identical
 *  duplicate is not repeated and an absent or empty half adds no separator. */
function composeInstructions(global: string | undefined, project: string | undefined): string | undefined {
	if (global === undefined || global === "") return project;
	if (project === undefined || project === "") return global;
	if (project === global) return global;
	return `${global}\n\n${project}`;
}

function standalone(project: ProfileDefinition, projectPath: string, globalPath?: string): CompositionResult {
	const referenceContributors = emptyContributors();
	for (const kind of LIST_KINDS) {
		for (const reference of project[kind] ?? []) addContributor(referenceContributors[kind], reference, "project");
	}
	return {
		definition: project,
		referenceContributors,
		unapplied: [],
		diagnostics: [
			{
				code: "append-standalone",
				message: `${projectPath}: profile declares "promptStrategy": "append" and no same-named global definition exists${globalPath !== undefined ? ` at ${globalPath}` : ""}; the project definition applies on its own and nothing is composed`,
			},
		],
		branch: "standalone",
	};
}

/**
 * Composes a project `append` definition with its global base (`undefined`
 * when no same-named global definition exists).
 *
 * Fail-closed inputs handled here: a non-`append` project half (an internal
 * precondition — the catalog only composes appended winners) and a
 * `!`-prefixed glob in the append project half. The accepted strategy set and
 * the global-`append` rule are enforced by `resolvePromptStrategy`, which the
 * catalog parser applies to each half under its own scope before this function
 * sees it.
 */
export function composeProfileDefinitions(
	global: ProfileDefinition | undefined,
	project: ProfileDefinition,
	options: { globalPath?: string; projectPath: string },
): CompositionResult {
	const projectStrategy = resolvePromptStrategy(project.promptStrategy, "project", { filePath: options.projectPath });
	if (projectStrategy !== "append") {
		throw new CatalogError(
			`${options.projectPath}: "promptStrategy" is ${JSON.stringify(projectStrategy)}; composition requires an append project definition`,
		);
	}
	assertNoNegatedGlobs(project, options.projectPath);
	if (global === undefined) return standalone(project, options.projectPath, options.globalPath);

	const referenceContributors = emptyContributors();
	const unapplied: UnappliedReference[] = [];
	const diagnostics: CompositionDiagnostic[] = [];

	const lists: Partial<Record<ReferenceListKind, string[]>> = {};
	for (const kind of LIST_KINDS) {
		const composed = composeListKind(kind, global, project, referenceContributors[kind]);
		if (composed.value !== undefined) lists[kind] = composed.value;
		for (const entry of composed.unapplied) {
			unapplied.push(entry);
			diagnostics.push({
				code: "append-unapplied-reference",
				reference: entry.reference,
				message: `${options.projectPath}: profile declares ${kind} reference "${entry.reference}" in an append definition, but the global definition leaves "${kind}" unrestricted, so the reference was not applied and was not validated against discovery; declare "${kind}" in the global definition (even as []) to widen it from the project definition`,
			});
		}
	}

	const mcpTools = composeMcpTools(global, project, options.projectPath);
	unapplied.push(...mcpTools.unapplied);
	diagnostics.push(...mcpTools.diagnostics);

	// Field order follows the schema. Scalars are overridden per field; an
	// undeclared project scalar inherits the base value. Subagent settings are a
	// whole-field override: the project declaration replaces the base one and
	// its keys are never merged, and an undeclared project value does not
	// inherit (replacement semantics, not inheritance of the declaration).
	const instructions = composeInstructions(global.instructions, project.instructions);
	const definition: ProfileDefinition = { promptStrategy: "append" };
	const assign = <K extends keyof ProfileDefinition>(field: K, value: ProfileDefinition[K] | undefined): void => {
		if (value !== undefined) definition[field] = value;
	};
	assign("label", project.label ?? global.label);
	assign("description", project.description ?? global.description);
	assign("skills", lists.skills);
	assign("extensions", lists.extensions);
	assign("mcps", lists.mcps);
	assign("tools", lists.tools);
	assign("mcp_tools", mcpTools.value);
	assign("defaultProvider", project.defaultProvider ?? global.defaultProvider);
	assign("defaultModel", project.defaultModel ?? global.defaultModel);
	assign("defaultThinkingLevel", project.defaultThinkingLevel ?? global.defaultThinkingLevel);
	assign("instructions", instructions);
	// Whole-field override, never a per-key merge: an undeclared project value
	// leaves the composite undeclared rather than inheriting the base's map.
	assign("subagents", project.subagents);

	return {
		definition,
		referenceContributors,
		unapplied,
		diagnostics,
		branch: "composed",
	};
}

/** Composition metadata for a resolved profile: the strategy, the branch, both
 *  paths, and both contributor sets, retained for the surfaces that report a
 *  composition. */
export function compositionMetadata(
	result: CompositionResult,
	options: { globalPath?: string; projectPath: string },
): ProfileComposition {
	return {
		strategy: "append",
		branch: result.branch,
		...(result.branch === "composed" && options.globalPath !== undefined ? { globalPath: options.globalPath } : {}),
		projectPath: options.projectPath,
		referenceContributors: result.referenceContributors,
		unapplied: result.unapplied,
		diagnostics: result.diagnostics,
	};
}
