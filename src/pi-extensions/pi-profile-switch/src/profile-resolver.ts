/**
 * ProfileResolver: a pure function from profile + registries to an immutable
 * ActivationPlan.
 *
 * Rules:
 * - Glob references (`*`, `?`) expand against the full registry at every
 *   resolution; zero matches is fine (new matches join on the next start) and
 *   is reported in the plan's `unmatched` list so typos are visible.
 * - Missing profile skill and extension references produce diagnostics.
 *   Extension references resolve through ExtensionDiscovery.select (ADR-0007):
 *   package name/alias, loose-file stem, or an on-disk path — no
 *   pre-registration required.
 * - Undeclared model/thinking/instructions never enter the plan, so Pi's
 *   current state stays untouched.
 * - MCP references (`mcps`) expand against the merged user-level MCP
 *   configuration snapshot: misses are diagnosed and usable selections
 *   remain restrictive (consistent with skills/extensions).
 * - Tool globs expand against Pi's built-in tool names for settings
 *   `defaultTools`; raw tool references are also carried into the launch
 *   plan so the in-session extension can expand them against Pi's live
 *   registry (including extension and MCP tools) via setActiveTools for
 *   strict allowlisting.
 */

import { minimatch } from "minimatch";

import type { DiscoveredExtensions } from "./extension-discovery.ts";
import { isRecord } from "./json-file.ts";
import type { MergedMcpResult } from "./mcp-config.ts";
import type { ProfileDefinition, ProfileModel, ProfileSource, ResolvedProfile } from "./profile-catalog.ts";
import type { ProfileSubagentSettings } from "./subagent-settings.ts";

/** Extracts a ProfileModel from flat definition keys, if declared. */
function extractModel(definition: ProfileDefinition): ProfileModel | undefined {
	if (definition.defaultProvider === undefined || definition.defaultModel === undefined) return undefined;
	return {
		provider: definition.defaultProvider,
		id: definition.defaultModel,
		...(definition.defaultThinkingLevel !== undefined ? { thinkingLevel: definition.defaultThinkingLevel } : {}),
	};
}
import type { RuntimeOverlay } from "./runtime-state-store.ts";
import type { SkillEntry } from "./skill-registry.ts";

export interface ResolutionDiagnostic {
	kind: string;
	code: string;
	message: string;
	reference?: string;
	filePath?: string;
}

/** One issue per kind/reference/source/code, retaining the first message. */
export function mergeResolutionDiagnostics(...groups: Array<readonly ResolutionDiagnostic[] | undefined>): ResolutionDiagnostic[] {
	const issues = new Map<string, ResolutionDiagnostic>();
	for (const group of groups) {
		for (const issue of group ?? []) {
			const key = JSON.stringify([issue.kind, issue.reference, issue.filePath, issue.code]);
			if (!issues.has(key)) issues.set(key, issue);
		}
	}
	return [...issues.values()];
}

export function mcpSourceDiagnostics(profile: string, messages?: readonly string[]): ResolutionDiagnostic[] {
	return (messages ?? []).map((message) => {
		const separator = message.indexOf(": ");
		return { kind: "mcp-source", code: "invalid-source", message: `profile "${profile}": ${message}; source skipped; fix the configuration at that path`, ...(separator >= 0 ? { filePath: message.slice(separator + 2) } : {}) };
	});
}

/** Normalize legacy unmatched notices, including overlay globs, for storage. */
export function resolutionDiagnostics(plan: Pick<ActivationPlan, "profile" | "diagnostics" | "unmatched">): ResolutionDiagnostic[] {
	return mergeResolutionDiagnostics(plan.diagnostics, (plan.unmatched ?? []).map((entry) => {
		const separator = entry.indexOf(":");
		return { kind: entry.slice(0, separator), code: "zero-match", reference: entry.slice(separator + 1), message: `profile "${plan.profile}": "${entry}" matched nothing this resolution` };
	}));
}

/** Inspect declaration intent against this snapshot without validating tools. */
export function mcpReferenceDiagnostics(profile: string, discovery: MergedMcpResult, mcps?: readonly string[], mcpTools?: Record<string, string[]>): ResolutionDiagnostic[] {
	const diagnostics: ResolutionDiagnostic[] = [];
	const candidates = userLevelMcpCandidates(discovery);
	const candidateMessage = (names: string[]): string => names.length > 0 ? ` (usable candidates: ${names.join(", ")})` : " (no user-level servers are discovered)";
	const add = (kind: string, code: string, reference: string, message: string): void => {
		diagnostics.push({ kind, code, reference, message: `profile "${profile}": ${message}` });
	};
	for (const name of mcps ?? []) {
		if (!Object.hasOwn(discovery.servers, name)) {
			add("mcp", "unknown-reference", name, `unknown MCP server: "${name}"${candidateMessage(candidates)}; not loaded; correct the reference or configure the server`);
		} else if (discovery.serverOwners[name] === "project" || discovery.projectServers.has(name)) {
			add("mcp", "project-boundary", name, `cannot select project-level MCP server "${name}"; not loaded through user-level selection; project-level servers are outside profile selection and remain governed by Pi`);
		} else if (discovery.servers[name]?.enabled === false) {
			add("mcp", "source-disabled", name, `selected MCP server "${name}" is disabled in its source configuration; remains disabled; enable it there or remove it from "mcps"`);
		}
	}
	const usable = candidates.filter((name) => mcps === undefined || mcps.includes(name));
	for (const name of Object.keys(mcpTools ?? {})) {
		if (!Object.hasOwn(discovery.servers, name)) {
			add("mcp-tools", "unknown-reference", name, `unknown MCP server "${name}"${candidateMessage(usable)}; policy retained without creating a connection; correct the server name or configure it`);
		} else if (discovery.serverOwners[name] === "project" || discovery.projectServers.has(name)) {
			add("mcp-tools", "project-boundary", name, `cannot narrow project-level MCP server "${name}"; policy retained but not applied; project-level servers are outside profile narrowing and remain governed by Pi`);
		} else if (discovery.servers[name]?.enabled === false || (mcps !== undefined && !mcps.includes(name))) {
			add("mcp-tools", "disabled-server", name, `MCP server "${name}" is disabled${candidateMessage(usable)}; remains disabled with policy retained; enable it in its source and select it through "mcps", or remove the policy`);
		}
	}
	return mergeResolutionDiagnostics(diagnostics);
}

export class ActivationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivationError";
	}
}

/** Pi's built-in tool names (pi 0.99.2 `allToolNames`; not exported by the
 *  SDK). The integration suite guards drift. Literal tool names pass through
 *  regardless — extension-provided tools are unknowable before spawn. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

/** User-level, enabled MCP server names, sorted — the set a profile can
 *  actually select via `mcps` or narrow via `mcp_tools`. Project-owned and
 *  source-disabled servers are not usable candidates. */
function userLevelMcpCandidates(mcpDiscovery: MergedMcpResult): string[] {
	return Object.keys(mcpDiscovery.servers)
		.filter((s) => {
			const isUser =
				Object.hasOwn(mcpDiscovery.serverOwners, s) &&
				mcpDiscovery.serverOwners[s] === "user" &&
				!mcpDiscovery.projectServers.has(s);
			const isEnabled = mcpDiscovery.servers[s]?.enabled !== false;
			return isUser && isEnabled;
		})
		.sort();
}

/** Immutable, fully resolved activation set. */
export interface ActivationPlan {
	profile: string;
	source: ProfileSource;
	/** "none" exposes everything Pi can discover (the default profile). */
	filter: "none" | "selection";
	/** Selected skills with their resolved SKILL.md paths: the declared
	 *  selection for a declared kind, or the full referenceable discovery
	 *  result for an undeclared kind (overlay/status vocabulary). Empty for
	 *  default. */
	skills: SkillEntry[];
	/** Selected extensions, same declared/undeclared distinction as `skills`. */
	extensions: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }>;
	/** Per-kind declaration intent: true exactly when the profile declared the
	 *  field, including an explicitly empty array. An undeclared kind keeps
	 *  Pi's native visibility and must not be materialized as a selection. */
	resourceSelection: { skills: boolean; extensions: boolean };
	/** Concrete skill entries the overlay disabled on an undeclared kind.
	 *  Set only when the kind is undeclared; a declared kind already carries
	 *  the narrowed selection in `skills`. */
	disabledSkills?: SkillEntry[];
	/** Concrete extension entries the overlay disabled on an undeclared kind. */
	disabledExtensions?: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }>;
	/** Expanded tool allowlist; undefined when the profile declares no tools. */
	tools?: string[];
	/** Overlay tool disable entries (names or globs, verbatim); undefined
	 *  when the overlay disables no tools. The session-start application
	 *  subtracts their live matches from the base expansion. */
	disabledTools?: string[];
	/** The raw tool references (globs included) for extension-side expansion
	 *  against Pi's live tool registry, which includes extension-provided
	 *  tools the pre-spawn expansion cannot know. Set iff `tools` is set. */
	toolReferences?: string[];
	/** Declared model; undefined leaves Pi's current model untouched. */
	model?: ProfileModel;
	/** Declared instructions; written to the generated APPEND_SYSTEM.md,
	 *  which Pi natively appends to the system prompt. */
	instructions?: string;
	/** Bounded native subagent settings declaration, passed through untouched. */
	subagents?: ProfileSubagentSettings;
	/** Expanded MCP server allowlist: written by SettingsGenerator into the
	 *  instance `mcp.json` snapshot and surfaced in `/profile status`;
	 *  undefined when the profile declares no `mcps` (no restriction). */
	mcps?: string[];
	/** Per-server MCP tool policy: literal tool names per server. */
	mcpTools?: Record<string, string[]>;
	/** Prepared in-memory instance mcp.json config; never written to pi-profile.json */
	instanceMcpConfig?: Record<string, unknown>;
	/** Glob references (skills/extensions/MCP) that matched nothing this
	 *  resolution — surfaced as warnings so zero-match typos are never silent.
	 *  Tool globs are excluded: extension-contributed tools are unknowable
	 *  before spawn, so a pre-spawn zero-match proves nothing. */
	unmatched?: string[];
	diagnostics?: ResolutionDiagnostic[];
}

export interface ResolveInput {
	profile: ResolvedProfile;
	/** The full SkillRegistry result (not just selected skills). */
	skills: SkillEntry[];
	extensions: DiscoveredExtensions;
	/**
	 * Server names discovered from the merged user-level MCP configuration
	 * snapshot (see mcp-config.ts). Required when the profile declares `mcps`
	 * or `mcp_tools`: without the discovered names a reference cannot be
	 * validated, so activation fails rather than passing references through
	 * unchecked.
	 */
	discoveredMcpServers?: string[];
	/**
	 * Merged MCP configuration result. Carries server definitions, ownership,
	 * and base settings.
	 */
	mcpDiscovery?: MergedMcpResult;
	/**
	 * The runtime overlay (ticket 06): temporary narrowing applied on top of
	 * the profile definition at every resolution. Overlay references must
	 * name resources the profile actually resolves (typos fail loudly), and
	 * any resolved reference may be narrowed or disabled.
	 */
	overlay?: RuntimeOverlay;
	/**
	 * Pi's live tool names (`pi.getAllTools()`), supplied by the in-session
	 * switch path. Required when the overlay disables tools on a profile
	 * without declared `tools` — the live registry is then the base set the
	 * entries disable from. The launcher never passes an overlay, so it never
	 * needs this.
	 */
	liveToolNames?: string[];
}

function isGlob(reference: string): boolean {
	return reference.includes("*") || reference.includes("?");
}

/** Expands overlay disable entries against the names the profile resolved.
 *  Entries are names or globs stored as written and
 *  re-expanded at every resolution; unmatched literals fail and identify
 *  the entry, zero-match globs join `unmatched` with an `overlay ` prefix.
 *  Overlays can disable any resolved extension. */
function expandDisableEntries(
	entries: string[],
	activeNames: readonly string[],
	kind: string,
	profileName: string,
	onZeroMatch: (entry: string) => void,
): Set<string> {
	const disabled = new Set<string>();
	for (const entry of entries) {
		if (isGlob(entry)) {
			let matched = 0;
			for (const name of activeNames) {
				if (minimatch(name, entry)) {
					disabled.add(name);
					matched += 1;
				}
			}
			if (matched === 0) onZeroMatch(entry);
			continue;
		}
		if (!activeNames.includes(entry)) {
			throw new ActivationError(`profile "${profileName}": overlay disables unknown ${kind} "${entry}"`);
		}
		disabled.add(entry);
	}
	return disabled;
}

/** Expands one reference list against a named universe. Literal misses fail
 *  when `literalMustExist`; globs expand to zero or more matches, and a
 *  zero-match glob is reported through `onZeroMatch`. */
function expandReferences<T>(
	references: string[],
	universe: readonly T[],
	nameOf: (item: T) => string,
	kind: string,
	options?: {
		literalMustExist?: boolean;
		onZeroMatch?: (reference: string) => void;
		onLiteralMiss?: (reference: string) => void;
		/** Custom literal-miss failure (e.g. with near-miss candidates). Throws. */
		literalMissError?: (reference: string) => never;
	},
): T[] {
	const selected = new Map<string, T>();
	for (const reference of references) {
		if (isGlob(reference)) {
			let matched = 0;
			for (const item of universe) {
				if (minimatch(nameOf(item), reference)) {
					selected.set(nameOf(item), item);
					matched += 1;
				}
			}
			if (matched === 0) options?.onZeroMatch?.(reference);
			continue;
		}
		const item = universe.find((candidate) => nameOf(candidate) === reference);
		if (item === undefined) {
			if (options?.literalMustExist === false) {
				// Pass-through (e.g. extension-provided tool names).
				selected.set(reference, reference as T);
				continue;
			}
			if (options?.onLiteralMiss !== undefined) {
				options.onLiteralMiss(reference);
				continue;
			}
			const missError = options?.literalMissError;
			if (missError !== undefined) {
				missError(reference);
			}
			throw new ActivationError(`unknown ${kind}: "${reference}" does not match any discovered ${kind}`);
		}
		selected.set(reference, item);
	}
	return [...selected.values()];
}

/** The built-in default profile: everything Pi can discover, no filtering. */
export function defaultPlan(): ActivationPlan {
	return {
		profile: "default",
		source: "builtin",
		filter: "none",
		skills: [],
		extensions: [],
		resourceSelection: { skills: false, extensions: false },
	};
}

export async function resolveProfile(input: ResolveInput): Promise<ActivationPlan> {
	const { profile, skills, extensions, overlay } = input;
	const definition: ProfileDefinition = profile.definition;
	const unmatched: string[] = [];
	const diagnostics: ResolutionDiagnostic[] = [];
	const zeroMatch = (kind: string, reference: string): void => {
		unmatched.push(`${kind}:${reference}`);
		diagnostics.push({ kind, code: "zero-match", reference, message: `profile "${profile.name}": "${kind}:${reference}" matched nothing this resolution; not loaded` });
	};

	if (input.mcpDiscovery !== undefined && input.discoveredMcpServers === undefined) {
		input.discoveredMcpServers = Object.keys(input.mcpDiscovery.servers).sort();
	}

	// Declaration intent is preserved separately from the resolved array: an
	// omitted field keeps Pi's native visibility, an explicit empty array is a
	// restrictive selection, and the two must not be confused.
	const skillsDeclared = definition.skills !== undefined;
	const extensionsDeclared = definition.extensions !== undefined;

	// A declared kind expands its references; an undeclared kind carries the
	// full referenceable discovery result as overlay/status vocabulary.
	let selectedSkills = skillsDeclared
		? expandReferences(definition.skills ?? [], skills, (skill) => skill.name, "skill", {
				onZeroMatch: (reference) => zeroMatch("skill", reference),
				onLiteralMiss: (reference) => {
					const candidates = skills.map((entry) => entry.name).sort();
					diagnostics.push({ kind: "skill", code: "unknown-reference", reference, message: `profile "${profile.name}": unknown skill "${reference}"; not loaded. ${candidates.length > 0 ? `Discovered candidates: ${candidates.join(", ")}; correct the reference or install the skill.` : "No skills discovered; install the skill or remove the reference."}` });
				},
			})
		: [...skills];

	// Extension references resolve directly against discovered extensions.
	let planExtensions: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }>;
	if (extensionsDeclared) {
		const selection = await extensions.select(definition.extensions ?? []);
		for (const reference of selection.unmatched) unmatched.push(`extension:${reference}`);
		for (const issue of selection.diagnostics ?? []) {
			diagnostics.push({ ...issue, message: `profile "${profile.name}": ${issue.message}` });
		}
		planExtensions = selection.entries.map((entry) => ({
			id: entry.id,
			entry: entry.entry,
			...(entry.origin ? { origin: entry.origin } : {}),
		}));
	} else {
		planExtensions = extensions.list().map((entry) => ({
			id: entry.id,
			entry: entry.entry,
			...(entry.origin ? { origin: entry.origin } : {}),
		}));
	}

	const mcpDiscovery = input.mcpDiscovery;
	diagnostics.push(...mcpSourceDiagnostics(profile.name, mcpDiscovery?.diagnostics));

	const candidates = mcpDiscovery !== undefined
		? userLevelMcpCandidates(mcpDiscovery)
		: [...(input.discoveredMcpServers ?? [])].sort();
	const candidateMessage = (usable: string[]): string => usable.length > 0
		? ` (usable candidates: ${usable.join(", ")})`
		: " (no user-level servers are discovered)";
	const diagnoseMcp = (kind: string, code: string, reference: string, message: string): void => {
		diagnostics.push({ kind, code, reference, message: `profile "${profile.name}": ${message}` });
	};

	let mcps: string[] | undefined;
	if (definition.mcps !== undefined) {
		if (input.discoveredMcpServers === undefined && (definition.mcps.length > 0 || mcpDiscovery === undefined)) {
			throw new ActivationError(`profile "${profile.name}" declares ${definition.mcps.length === 0 ? "an empty MCP server selection" : "MCP servers"} but no MCP server discovery is available`);
		}
		mcps = expandReferences(definition.mcps, input.discoveredMcpServers ?? [], (name) => name, "MCP server", {
			onZeroMatch: (reference) => zeroMatch("mcp", reference),
			onLiteralMiss: (reference) => diagnoseMcp("mcp", "unknown-reference", reference, `unknown MCP server: "${reference}"${candidateMessage(candidates)}; not loaded; correct the reference or configure the server`),
		});
		if (mcpDiscovery !== undefined) {
			diagnostics.push(...mcpReferenceDiagnostics(profile.name, mcpDiscovery, mcps));
			mcps = mcps.filter((name) => !mcpDiscovery.projectServers.has(name) && mcpDiscovery.serverOwners[name] === "user" && mcpDiscovery.servers[name]?.enabled !== false);
		}
	}

	// --- overlay narrowing (ticket 06) ---
	// An undeclared kind's overlay base is its native referenceable discovery
	// result; the concrete removed entries are carried separately so the
	// generator can emit native-base force-exclusions without converting the
	// kind into an allowlist.
	let disabledSkills: SkillEntry[] | undefined;
	let disabledExtensions: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }> | undefined;
	if (overlay !== undefined) {
		if (overlay.disabledSkills !== undefined && overlay.disabledSkills.length > 0) {
			const disabled = expandDisableEntries(
				overlay.disabledSkills,
				selectedSkills.map((skill) => skill.name),
				"skill",
				profile.name,
				(entry) => unmatched.push(`overlay skill:${entry}`),
			);
			const removed = selectedSkills.filter((skill) => disabled.has(skill.name));
			selectedSkills = selectedSkills.filter((skill) => !disabled.has(skill.name));
			if (!skillsDeclared && removed.length > 0) disabledSkills = removed;
		}
		if (overlay.disabledExtensions !== undefined && overlay.disabledExtensions.length > 0) {
			const disabled = expandDisableEntries(
				overlay.disabledExtensions,
				planExtensions.map((entry) => entry.id),
				"extension",
				profile.name,
				(entry) => unmatched.push(`overlay extension:${entry}`),
			);
			const removed = planExtensions.filter((entry) => disabled.has(entry.id));
			planExtensions = planExtensions.filter((entry) => !disabled.has(entry.id));
			if (!extensionsDeclared && removed.length > 0) disabledExtensions = removed;
		}
		if (overlay.disabledMcps !== undefined && overlay.disabledMcps.length > 0) {
			const active = mcps ?? [];
			const disabled = expandDisableEntries(
				overlay.disabledMcps,
				active,
				"MCP server",
				profile.name,
				(entry) => unmatched.push(`overlay mcp:${entry}`),
			);
			// A profile that declared no `mcps` has no MCP restriction; overlay
			// narrowing must not turn that into an empty whitelist. Literals
			// still fail and zero-match globs still warn — the expansion above
			// runs either way — only the reassignment is guarded.
			if (mcps !== undefined) {
				mcps = active.filter((name) => !disabled.has(name));
			}
		}
	}

	const mcpToolsDef = (definition as ProfileDefinition & { mcp_tools?: Record<string, string[]> }).mcp_tools;
	const mcpToolKeys = mcpToolsDef !== undefined ? Object.keys(mcpToolsDef) : [];

	let mcpTools: Record<string, string[]> | undefined;
	if (mcpToolKeys.length > 0) {
		if (input.mcpDiscovery === undefined) {
			throw new ActivationError(
				`profile "${profile.name}" declares MCP tools but no MCP server discovery is available`,
			);
		}

		mcpTools = Object.fromEntries(Object.entries(mcpToolsDef ?? {}).map(([server, selectors]) => [server, [...selectors]]));
		diagnostics.push(...mcpReferenceDiagnostics(profile.name, input.mcpDiscovery, mcps, mcpTools));
	}

	const toolReferences = definition.tools;

	let instanceMcpConfig: Record<string, unknown> | undefined;
	if (input.mcpDiscovery !== undefined && (mcps !== undefined || mcpToolKeys.length > 0)) {
		instanceMcpConfig = buildInstanceMcpConfig(profile.name, input.mcpDiscovery, mcps, mcpTools);
	}

	let tools: string[] | undefined;
	if (toolReferences !== undefined) {
		tools = expandReferences(toolReferences, BUILTIN_TOOL_NAMES, (name) => name, "tool", {
			literalMustExist: false,
		});
	}

	// Tool disable entries join the uniform grammar: the base set is the
	// profile's resolved tool references when declared (expanded against the
	// live registry, which the in-session switch path always supplies) and
	// the live registry itself when the profile declares no tools. The
	// plan carries the entries verbatim; session-start application subtracts
	// their live matches from the base expansion at that moment.
	let disabledTools: string[] | undefined;
	if (overlay?.disabledTools !== undefined && overlay.disabledTools.length > 0) {
		if (input.liveToolNames === undefined) {
			throw new ActivationError(
				`profile "${profile.name}": overlay disables tools but no live tool registry is available`,
			);
		}
		const base =
			toolReferences !== undefined
				? expandReferences(toolReferences, input.liveToolNames, (name) => name, "tool", {
						literalMustExist: false,
					})
				: input.liveToolNames;
		const disabled = expandDisableEntries(
			overlay.disabledTools,
			base,
			"tool",
			profile.name,
			(entry) => unmatched.push(`overlay tool:${entry}`),
		);
		disabledTools = [...overlay.disabledTools];
		// The pre-computed boot baseline additionally subtracts the disabled
		// matches (a no-op for tools only the live registry knows).
		if (tools !== undefined) {
			tools = tools.filter((name) => !disabled.has(name));
		}
	}

	const model = extractModel(definition);
	if (model?.thinkingLevel !== undefined) {
		// Pi does not export this predicate through its SDK. Resolve its
		// installed CLI module rather than copy a second accepted-value set.
		const nativeThinking: { isValidThinkingLevel: (level: string) => boolean } = await import(
			new URL("./cli/args.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
		);
		if (!nativeThinking.isValidThinkingLevel(model.thinkingLevel)) {
			diagnostics.push({ kind: "thinking", code: "unsupported-thinking", reference: model.thinkingLevel, message: `profile "${profile.name}": invalid thinkingLevel ${JSON.stringify(model.thinkingLevel)}; ignored; choose a thinking value supported by Pi or remove "defaultThinkingLevel"` });
			delete model.thinkingLevel;
		}
	}

	return {
		profile: profile.name,
		source: profile.source,
		filter: "selection",
		skills: selectedSkills,
		extensions: planExtensions.map((entry) => ({ id: entry.id, entry: entry.entry })),
		resourceSelection: { skills: skillsDeclared, extensions: extensionsDeclared },
		...(disabledSkills !== undefined ? { disabledSkills } : {}),
		...(disabledExtensions !== undefined ? { disabledExtensions } : {}),
		...(tools !== undefined && toolReferences !== undefined ? { tools, toolReferences: [...toolReferences] } : {}),
		...(disabledTools !== undefined ? { disabledTools } : {}),
		...(model !== undefined ? { model } : {}),
		...(definition.instructions !== undefined ? { instructions: definition.instructions } : {}),
		...(definition.subagents !== undefined ? { subagents: definition.subagents } : {}),
		...(mcps !== undefined ? { mcps } : {}),
		...(mcpTools !== undefined ? { mcpTools } : {}),
		...(instanceMcpConfig !== undefined ? { instanceMcpConfig } : {}),
		...(unmatched.length > 0 ? { unmatched } : {}),
		...(diagnostics.length > 0 ? { diagnostics: mergeResolutionDiagnostics(diagnostics) } : {}),
	};
}

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

export function buildInstanceMcpConfig(
	profileName: string,
	mcpDiscovery: MergedMcpResult,
	mcps?: string[],
	mcpTools?: Record<string, string[]>,
): Record<string, unknown> {
	const filteredServers: Record<string, Record<string, unknown>> = {};
	const userServers = Object.keys(mcpDiscovery.servers).filter(
		(s) =>
			Object.hasOwn(mcpDiscovery.serverOwners, s) &&
			mcpDiscovery.serverOwners[s] === "user" &&
			!mcpDiscovery.projectServers.has(s),
	);

	const serversToInclude = mcps !== undefined ? mcps : userServers;
	for (const serverName of serversToInclude) {
		const originalDef = Object.hasOwn(mcpDiscovery.servers, serverName)
			? mcpDiscovery.servers[serverName]
			: undefined;
		if (originalDef === undefined) continue;

		// Project-owned servers are never materialized into the snapshot;
		// Pi reads the trusted project's .pi/mcp.json itself.
		const isProjectOwned =
			mcpDiscovery.serverOwners[serverName] === "project" || mcpDiscovery.projectServers.has(serverName);
		if (isProjectOwned) continue;


		const def = { ...originalDef };

		if (originalDef.enabled !== false && mcpTools && Object.hasOwn(mcpTools, serverName)) {
			// Profile policy replaces the merged toolExposure wholesale.
			const requested = mcpTools[serverName];
			const exposure: Record<string, string> = { "*": "hidden" };
			for (const selector of requested) {
				exposure[selector] = "direct";
			}
			def.toolExposure = exposure;
		}

		setOwnRecordValue(filteredServers, serverName, def);
	}

	// Unselected user-level servers keep their complete winning definition and
	// are explicitly disabled. Pi validates the transport before `enabled`, so
	// a transport-less placeholder would warn on every valid disabled server.
	if (mcps !== undefined) {
		for (const userName of userServers) {
			if (mcps.includes(userName)) continue;
			const unselectedDef = mcpDiscovery.servers[userName] ?? {};
			setOwnRecordValue(filteredServers, userName, { ...unselectedDef, enabled: false });
		}
	}

	return isRecord(mcpDiscovery.baseConfig)
		? { ...mcpDiscovery.baseConfig, mcpServers: filteredServers }
		: { mcpServers: filteredServers };
}
