/**
 * ApplyLaunchPlan: applies the launch plan inside a running Pi after every
 * session start (startup, reload, new/resume/fork) — the post-reload half of
 * switching (ticket 05).
 *
 * The freshly re-executed pi-profile extension calls this from its
 * `session_start` handler. It is dependency-injected against a narrow pi
 * surface so unit tests never need a real Pi.
 *
 * Steps:
 *   1. tools: re-expand the profile's raw references against Pi's LIVE
 *      non-MCP tool registry and call setActiveTools while retaining
 *      MCP-owned registrations. Settings `defaultTools` provides only
 *      the boot baseline for built-ins. Literals that no Pi tool provides
 *      are dropped with a warning — Pi silently ignores unknown names, so
 *      the warning is the only signal.
 *      When the plan carries overlay disabled tool entries, the active set
 *      is the base expansion — the profile references, or the whole live
 *      registry when the profile declares none — minus the entries' live
 *      matches, re-expanded at this moment so registry drift re-applies
 *      correctly after reload.
 *   2. persistence: when the plan is marked `persistSelection` and this is a
 *      reload, save the selection (activeProfile = plan.profile) to the
 *      profile's scope state file. Launch-transient selections never write.
 *   3. change summary: a `switchedFrom` marker produces a one-shot summary
 *      for the next agent turn and is cleared from the plan file.
 *
 * Pi's reload re-executes extension modules, so no stale handler or command
 *  context survives; this module is the only place post-reload state is
 *  established.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "../json-file.ts";
import { mergeResolutionDiagnostics, type ResolutionDiagnostic } from "../profile-resolver.ts";
import { RuntimeStateStore } from "../runtime-state-store.ts";
import { getGlobalStateDir } from "../workspace.ts";
import type { ProfileSubagentSettings } from "../subagent-settings.ts";
import { expandToolReferences } from "./tool-references.ts";
import { observeSubagentExtension, type SubagentExtensionObservation, type SubagentRegistrationSource } from "./subagent-observation.ts";

export interface LaunchPlanFile {
	profile: string;
	source: string;
	agentDir?: string;
	tools?: string[];
	toolReferences?: string[];
	/** Overlay tool disable entries (names or globs, verbatim); subtracted
	 *  from the base expansion at session start. */
	disabledTools?: string[];
	mcps?: string[];
	mcpTools?: Record<string, string[]>;
	subagents?: ProfileSubagentSettings;
	/** Marks a narrowed `tools` profile whose effective MCP set still has an
	 *  enabled server; session start must retain Pi's native MCP discovery
	 *  entry points (codemode / tool_search) if they were natively
	 *  registered (D4). */
	mcpGateways?: boolean;
	switchedFrom?: string;
	persistSelection?: boolean;
	clearOverlay?: boolean;
	resolved?: {
		skills: Array<{ name: string; filePath: string }>;
		extensions: Array<{ id: string; entry: string; origin?: "package" | "local" | "path" }>;
	};
	/** Glob references that matched nothing at resolution (ADR-0009). */
	unmatched?: string[];
	diagnostics?: ResolutionDiagnostic[];
	previousResolved?: {
		skills: string[];
		extensions: string[];
		tools?: string[];
		mcps?: string[];
	};
}

/** The narrow slice of ExtensionAPI/Context the application needs. */
export interface PlanApplicationSurface {
	getAllTools(): Array<{
		name: string;
		sourceInfo?: { path?: string; source?: string; origin?: string; baseDir?: string };
	}>;
	getCommands?(): Array<{
		name: string;
		sourceInfo?: { path?: string; source?: string; origin?: string; baseDir?: string };
	}>;
	setActiveTools(names: string[]): void;
	notify?(message: string, level: "info" | "warning" | "error"): void;
	observeSubagents?(): Promise<SubagentExtensionObservation>;
	notifySubagentWarning?(message: string): void;
}

export interface ApplyResult {
	/** One-shot profile-change summary for the next agent turn, if any. */
	summary?: string;
	warnings: string[];
}

export async function readLaunchPlanFile(runtimeDir: string): Promise<LaunchPlanFile | undefined> {
	const result = await readJsonFile(path.join(runtimeDir, "pi-profile.json"));
	if (!result.ok || !isRecord(result.value) || typeof result.value.profile !== "string") {
		return undefined;
	}
	return result.value as unknown as LaunchPlanFile;
}

export function isMcpOwnedTool(tool: {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}): boolean {
	const info = tool.sourceInfo;
	if (!info) return false;
	return info.path === "builtin:mcp";
}

/** Pi's native MCP discovery entry points and their built-in source paths
 *  (see installed Pi `dist/extensions/index.js`). A same-named tool from any
 *  other source is never treated as an MCP gateway. */
const MCP_GATEWAYS = [
	{ name: "codemode", sourcePath: "builtin:codemode" },
	{ name: "tool_search", sourcePath: "builtin:tool-search" },
] as const;

/** Applies the plan carried by the runtime dir's pi-profile.json. */
export async function applyLaunchPlan(input: {
	runtimeDir: string;
	cwd: string;
	/** The session_start reason ("startup" | "reload" | "new" | ...). */
	reason: string;
	surface: PlanApplicationSurface;
}): Promise<ApplyResult> {
	const { surface } = input;
	const plan = await readLaunchPlanFile(input.runtimeDir);
	if (plan === undefined) {
		return { warnings: [] };
	}
	const warnings: string[] = input.reason === "reload"
		? mergeResolutionDiagnostics(plan.diagnostics).map((issue) => issue.message)
		: [];
	const subagentWarnings = new Set<string>();

	if (plan.subagents !== undefined) {
		let observation: SubagentExtensionObservation = "unconfirmed";
		try {
			observation = surface.observeSubagents
				? await surface.observeSubagents()
				: await observeSubagentExtension([
						...surface.getAllTools(),
						...(surface.getCommands?.() ?? []),
					] as SubagentRegistrationSource[]);
		} catch {
			observation = "unconfirmed";
		}
		if (observation === "unconfirmed") {
			const warning = `profile "${plan.profile}": pi-subagents registration could not be confirmed, so declared subagent overrides might be inactive; check that the native extension is loaded and inspect live roles with /subagents-models`;
			warnings.push(warning);
			subagentWarnings.add(warning);
			try {
				surface.notifySubagentWarning?.(warning);
			} catch {
				// The optional diagnostic surface must not block activation.
			}
		}
	}

	// --- tools ---
	const hasOverlayDisables = plan.disabledTools !== undefined && plan.disabledTools.length > 0;
	if (plan.toolReferences !== undefined || hasOverlayDisables || plan.mcpGateways === true) {
		const allTools = surface.getAllTools();
		const mcpToolNames: string[] = [];
		const nonMcpToolNames: string[] = [];

		for (const tool of allTools) {
			if (isMcpOwnedTool(tool)) {
				mcpToolNames.push(tool.name);
			} else {
				nonMcpToolNames.push(tool.name);
			}
		}

		let active: string[];
		if (plan.toolReferences !== undefined) {
			const { expanded, droppedLiterals, legacyMcpReferences } = expandToolReferences(
				plan.toolReferences,
				nonMcpToolNames,
				mcpToolNames,
			);
			if (droppedLiterals.length > 0) {
				warnings.push(
					`profile "${plan.profile}": tools ${droppedLiterals.map((name) => JSON.stringify(name)).join(", ")} match nothing in Pi's live registry`,
				);
			}
			if (legacyMcpReferences.length > 0) {
				for (const ref of legacyMcpReferences) {
					warnings.push(
						`profile "${plan.profile}": tool reference ${JSON.stringify(ref)} matched only MCP tools; migrate MCP tool configuration to "mcp_tools"`,
					);
				}
			}
			// Retain MCP-owned tools in the live registry alongside selected Pi tools
			active = [...expanded, ...mcpToolNames];
		} else {
			// No declared tools: the base is the whole live registry.
			active = allTools.map((tool) => tool.name);
		}

		const disabledSet = new Set<string>();
		if (hasOverlayDisables) {
			const allLiveNames = allTools.map((tool) => tool.name);
			const { expanded: disabled, droppedLiterals: vanishedEntries } = expandToolReferences(
				plan.disabledTools!,
				allLiveNames,
				mcpToolNames,
			);
			if (vanishedEntries.length > 0) {
				warnings.push(
					`profile "${plan.profile}": overlay tool entries ${vanishedEntries.map((name) => JSON.stringify(name)).join(", ")} match nothing in Pi's live registry`,
				);
			}
			for (const name of disabled) disabledSet.add(name);
			active = active.filter((name) => !disabledSet.has(name));
		}

		// Native MCP discovery entry points stay reachable for narrowed `tools`
		// profiles when the plan marked them (D4). Only the built-in
		// registration counts; an explicit overlay disable still wins.
		if (plan.mcpGateways === true) {
			for (const gateway of MCP_GATEWAYS) {
				if (disabledSet.has(gateway.name)) continue;
				const registered = allTools.find((tool) => tool.name === gateway.name);
				if (registered === undefined) {
					warnings.push(
						`profile "${plan.profile}": MCP entry point ${JSON.stringify(gateway.name)} is unavailable because its built-in extension did not register it`,
					);
					continue;
				}
				if (registered.sourceInfo?.path === gateway.sourcePath) {
					if (!active.includes(gateway.name)) active.push(gateway.name);
				} else {
					warnings.push(
						`profile "${plan.profile}": MCP entry point ${JSON.stringify(gateway.name)} is registered by ${registered.sourceInfo?.path ?? "an unknown source"}, not the built-in extension; it was not used as an MCP gateway`,
					);
				}
			}
		}

		surface.setActiveTools(active);
	}

	// --- persistence (post-reload only) ---
	if (plan.persistSelection === true && input.reason === "reload" && plan.agentDir !== undefined) {
		const stateDir = plan.source === "project" ? path.join(input.cwd, ".pi") : getGlobalStateDir(plan.agentDir);
		// Merge: the overlay belongs to the overlay commands, not to this
		// write. A switch (clearOverlay) explicitly drops it.
		await new RuntimeStateStore(stateDir).update({
			activeProfile: plan.profile,
			...(plan.clearOverlay === true ? { overlay: undefined } : {}),
		});
	}

	// --- one-shot change summary ---
	let summary: string | undefined;
	if (typeof plan.switchedFrom === "string" && plan.switchedFrom.length > 0) {
		summary = buildSwitchSummary(plan);
		surface.notify?.(summary, "info");
		await clearSwitchMarker(input.runtimeDir);
	}

	for (const warning of new Set(warnings)) {
		if (!subagentWarnings.has(warning)) surface.notify?.(warning, "warning");
	}
	return { summary, warnings: [...new Set(warnings)] };
}

function buildSwitchSummary(plan: LaunchPlanFile): string {
	const parts = [
		`profile switched: ${plan.switchedFrom} → ${plan.profile}`,
		plan.tools !== undefined ? `tools: [${plan.tools.join(", ")}]` : undefined,
		plan.mcps !== undefined && plan.mcps.length > 0 ? `mcp: [${plan.mcps.join(", ")}]` : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.join("; ");
}

/** Clears the one-shot marker so the summary fires exactly once, even
 *  across later reloads. */
async function clearSwitchMarker(runtimeDir: string): Promise<void> {
	const plan = await readLaunchPlanFile(runtimeDir);
	if (plan === undefined) return;
	delete plan.switchedFrom;
	await writeFile(path.join(runtimeDir, "pi-profile.json"), `${JSON.stringify(plan, null, 2)}\n`);
}
