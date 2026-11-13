/**
 * StatusReport: the `/profile status` observability surface (ticket 07).
 *
 * Pure report builder: combines the ACTIVE launch plan (what the runtime
 * was resolved to), the stored overlay, fresh MCP discovery from the merged
 * user-level snapshot, and Pi's actual command registrations (the winner
 * evidence for same-name conflicts). Markdown formatting is the only
 * presentation; the extension ships it via `pi.sendMessage`.
 *
 * Conflict semantics: Pi's load order is first-wins by scope/file order,
 * so the registered command IS the winner. A conflict is reported when the
 * plan resolved a skill whose command name is registered from a DIFFERENT
 * path (shadowed) or is absent (failed to load) — never blocked, always
 * visible.
 */

import type {
	ContributorSet,
	PendingToolReference,
	ProfileComposition,
	ProvenanceKind,
	ReferenceListKind,
	UnappliedReference,
} from "../profile-composition.ts";
import { mergeResolutionDiagnostics, type ResolutionDiagnostic } from "../profile-resolver.ts";
import type { RuntimeOverlay } from "../runtime-state-store.ts";
import type { ProfileSubagentSettings } from "../subagent-settings.ts";
import type { LaunchPlanFile } from "./apply-plan.ts";
import type { SubagentExtensionObservation } from "./subagent-observation.ts";

export interface StatusConflict {
	/** Command name as registered (e.g. `skill:review`). */
	name: string;
	/** The path the active plan resolved. */
	expectedPath: string;
	/** The path Pi actually registered (the winner), or "not loaded". */
	winnerPath: string;
}

export interface McpServerToolStatus {
	server: string;
	policy: "unrestricted" | "restricted" | "none";
	tools?: string[];
	/** Retained declaration not applied to an eligible user-level server. */
	state?: "disabled" | "missing" | "project";
}

export interface StatusReport {
	profile: string;
	source: string;
	overlay?: RuntimeOverlay;
	skills: Array<{ name: string; filePath: string }>;
	extensions: Array<{ id: string; entry: string; origin?: string }>;
	tools?: string[];
	mcp: { enabled: string[]; disabled: string[]; missing: string[] };
	mcpTools?: McpServerToolStatus[];
	/** Composition metadata of the active plan. Absent when the profile declares
	 *  no `promptStrategy`, which keeps the report (and its Markdown) identical
	 *  to a pre-change activation. */
	composition?: ProfileComposition;
	/** Per-kind declaration intent of the composed definition. */
	intent?: { skills: boolean; extensions: boolean; mcps: boolean; tools: boolean };
	/** Per-identity provenance carried by the active plan; `native` marks an
	 *  identity selected because its kind is undeclared. */
	origins?: Partial<Record<ReferenceListKind, Record<string, ProvenanceKind>>>;
	/** Extension provenance keyed by resolved entry path. */
	extensionOrigins?: Record<string, { id: string; contributors: ContributorSet }>;
	/** Raw tool references that were unresolved at boot. The plan is written
	 *  before session start, so no current pending/resolved/dropped outcome and
	 *  no resolved per-tool contributor is claimed here. */
	pendingToolReferences?: PendingToolReference[];
	/** Glob delta versus the previous activation (prefixed names). */
	delta?: { added: string[]; removed: string[] };
	/** Glob references that matched nothing at resolution (ADR-0009). */
	unmatched?: string[];
	diagnostics?: ResolutionDiagnostic[];
	conflicts: StatusConflict[];
	subagents?: {
		declared: ProfileSubagentSettings;
		extension: SubagentExtensionObservation;
	};
}

interface RegisteredCommand {
	name: string;
	sourceInfo?: { path: string };
}

interface RegisteredTool {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}

function currentNames(plan: LaunchPlanFile): string[] {
	const names = [
		...(plan.resolved?.skills ?? []).map((skill) => `skill:${skill.name}`),
		...(plan.resolved?.extensions ?? []).map((entry) => `extension:${entry.id}`),
		...(plan.tools ?? []).map((tool) => `tool:${tool}`),
		...(plan.mcps ?? []).map((server) => `mcp:${server}`),
	];
	return names.sort();
}

export function buildStatusReport(input: {
	plan: LaunchPlanFile;
	overlay?: RuntimeOverlay;
	discoveredMcpServers: string[];
	disabledMcpServers: string[];
	/** Project-owned server names from trust-gated MCP snapshot discovery;
	 *  kept enabled when the profile declares a defined `mcps` selection. */
	projectMcpServers?: string[];
	commands: RegisteredCommand[];
	tools: RegisteredTool[];
	subagentObservation?: SubagentExtensionObservation;
}): StatusReport {
	const { plan } = input;

	const discovered = new Set(input.discoveredMcpServers);
	const snapshotDisabled = new Set(input.disabledMcpServers);
	const project = new Set(input.projectMcpServers ?? []);
	const diagnostics = mergeResolutionDiagnostics(plan.diagnostics);
	const dormantPolicies = new Map<string, "missing" | "disabled">();
	for (const issue of diagnostics) {
		if (issue.kind !== "mcp-tools" || issue.reference === undefined || !Object.hasOwn(plan.mcpTools ?? {}, issue.reference)) continue;
		if (issue.code === "unknown-reference") dormantPolicies.set(issue.reference, "missing");
		if (issue.code === "disabled-server") dormantPolicies.set(issue.reference, "disabled");
	}
	// Fresh candidates do not make a skipped declared policy active before
	// reload. Unmentioned resources and native project ownership stay fresh.
	const enabled = input.discoveredMcpServers.filter((name) => !snapshotDisabled.has(name) && (project.has(name) || (!dormantPolicies.has(name) && (plan.mcps === undefined || plan.mcps.includes(name))))).sort();
	const disabled = input.discoveredMcpServers.filter((name) => !enabled.includes(name)).sort();
	const referenced = new Set([
		...(plan.mcps ?? []), ...Object.keys(plan.mcpTools ?? {}),
		...diagnostics.filter((issue) => (issue.kind === "mcp" || issue.kind === "mcp-tools") && issue.code !== "zero-match" && issue.reference !== undefined).map((issue) => issue.reference!),
	]);
	const missing = [...referenced].filter((name) => !discovered.has(name)).sort();

	const mcp = { enabled, disabled, missing };

	const policyState = (server: string): Pick<McpServerToolStatus, "state"> => {
		if (!discovered.has(server)) return { state: "missing" };
		if (project.has(server)) return { state: "project" };
		const retainedState = dormantPolicies.get(server);
		if (retainedState !== undefined) return { state: retainedState };
		if (!enabled.includes(server)) return { state: "disabled" };
		return {};
	};
	let mcpTools: McpServerToolStatus[] | undefined;
	const policyMap = plan.mcpTools;
	if (policyMap !== undefined || enabled.length > 0) {
		mcpTools = [];
		const allServers = Array.from(new Set([...enabled, ...Object.keys(policyMap ?? {})]));
		for (const server of allServers) {
			const hasPolicy = policyMap !== undefined && Object.prototype.hasOwnProperty.call(policyMap, server);
			if (!hasPolicy) {
				mcpTools.push({ server, policy: "unrestricted" });
			} else {
				const declaredTools = policyMap![server] ?? [];
				if (declaredTools.length === 0) {
					mcpTools.push({ server, policy: "none", tools: [], ...policyState(server) });
				} else {
					mcpTools.push({ server, policy: "restricted", tools: declaredTools, ...policyState(server) });
				}
			}
		}
	}

	let delta: StatusReport["delta"];
	if (plan.previousResolved !== undefined) {
		const before = new Set(
			[
				...plan.previousResolved.skills.map((name) => `skill:${name}`),
				...plan.previousResolved.extensions.map((id) => `extension:${id}`),
				...(plan.previousResolved.tools ?? []).map((name) => `tool:${name}`),
				...(plan.previousResolved.mcps ?? []).map((name) => `mcp:${name}`),
			].sort(),
		);
		const after = new Set(currentNames(plan));
		const added = [...after].filter((name) => !before.has(name));
		const removed = [...before].filter((name) => !after.has(name));
		if (added.length > 0 || removed.length > 0) {
			delta = { added, removed };
		}
	}

	const conflicts: StatusConflict[] = [];
	for (const skill of plan.resolved?.skills ?? []) {
		const command = input.commands.find((entry) => entry.name === `skill:${skill.name}`);
		const winnerPath = command?.sourceInfo?.path;
		if (winnerPath === undefined) {
			conflicts.push({ name: `skill:${skill.name}`, expectedPath: skill.filePath, winnerPath: "not loaded" });
		} else if (winnerPath !== skill.filePath) {
			conflicts.push({ name: `skill:${skill.name}`, expectedPath: skill.filePath, winnerPath });
		}
	}

	// Tool conflicts: a plan tool whose registered winner is neither a pi
	// builtin nor a tool from one of the plan's selected extensions was
	// shadowed by (or shadows) an unexpected source.
	const extensionDirs = (plan.resolved?.extensions ?? []).map((entry) =>
		entry.entry.endsWith(".ts") ? entry.entry.slice(0, entry.entry.lastIndexOf("/")) : entry.entry,
	);
	for (const toolName of plan.tools ?? []) {
		const winner = input.tools.find((entry) => entry.name === toolName);
		const info = winner?.sourceInfo;
		if (info === undefined) continue; // unknown names are dropped by pi.setActiveTools
		const expected =
			info.source === "builtin" ||
			(typeof info.path === "string" && extensionDirs.some((dir) => info.path!.startsWith(dir)));
		if (!expected) {
			conflicts.push({
				name: `tool:${toolName}`,
				expectedPath: "builtin or selected extension",
				winnerPath: info.path ?? "unknown",
			});
		}
	}

	return {
		profile: plan.profile,
		source: plan.source,
		overlay: input.overlay,
		skills: plan.resolved?.skills ?? [],
		extensions: plan.resolved?.extensions ?? [],
		...(plan.tools !== undefined ? { tools: plan.tools } : {}),
		mcp,
		...(mcpTools !== undefined ? { mcpTools } : {}),
		// Composition truth is read from the active plan only — no definition is
		// re-read and no state is re-resolved.
		...(plan.composition !== undefined
			? {
					composition: plan.composition,
					intent: {
						skills: plan.resourceSelection?.skills ?? false,
						extensions: plan.resourceSelection?.extensions ?? false,
						mcps: plan.mcps !== undefined,
						tools: plan.tools !== undefined,
					},
				}
			: {}),
		...(plan.origins !== undefined ? { origins: plan.origins } : {}),
		...(plan.extensionOrigins !== undefined ? { extensionOrigins: plan.extensionOrigins } : {}),
		...(plan.pendingToolReferences !== undefined && plan.pendingToolReferences.length > 0
			? { pendingToolReferences: plan.pendingToolReferences }
			: {}),
		...(delta !== undefined ? { delta } : {}),
		...(plan.unmatched !== undefined && plan.unmatched.length > 0 ? { unmatched: plan.unmatched } : {}),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		conflicts,
		...(plan.subagents !== undefined
			? {
					subagents: {
						declared: plan.subagents,
						extension: input.subagentObservation ?? "unconfirmed",
					},
				}
			: {}),
	};
}

/** Renders the composition block from the active plan's metadata only. A
 *  standalone `append` is informational: it has no base to widen, so it has no
 *  unapplied list and is not a failure. */
function compositionLines(report: StatusReport, unapplied: readonly UnappliedReference[]): string[] {
	const composition = report.composition;
	if (composition === undefined) return [];
	const lines = [`composition: ${composition.strategy} (${composition.branch})`];
	if (composition.branch === "composed") {
		if (composition.globalPath !== undefined) lines.push(`  base: ${composition.globalPath}`);
		lines.push(`  project: ${composition.projectPath}`);
	} else {
		lines.push(`  project: ${composition.projectPath}`);
		lines.push("  no global base: the project definition applies on its own (informational, not a failure)");
	}
	if (report.intent !== undefined) {
		const intent = report.intent;
		lines.push(
			`  intent: skills=${intent.skills ? "declared" : "native"} extensions=${intent.extensions ? "declared" : "native"} mcps=${intent.mcps ? "declared" : "native"} tools=${intent.tools ? "declared" : "native"}`,
		);
	}
	const contributors: string[] = [];
	for (const [kind, entries] of Object.entries(report.origins ?? {})) {
		const declared = Object.entries(entries ?? {}).filter(([, value]) => value !== "native");
		if (declared.length > 0) contributors.push(`${kind} ${declared.map(([name, value]) => `${name}=${value}`).join(", ")}`);
	}
	const extensionContributors = Object.values(report.extensionOrigins ?? {}).map(
		(entry) => `${entry.id}=${entry.contributors}`,
	);
	if (extensionContributors.length > 0) contributors.push(`extensions ${extensionContributors.join(", ")}`);
	if (contributors.length > 0) lines.push(`  contributors: ${contributors.join("; ")}`);
	const native = Object.entries(report.origins ?? {})
		.map(([kind, entries]) => ({ kind, names: Object.entries(entries ?? {}).filter(([, value]) => value === "native").map(([name]) => name) }))
		.filter((entry) => entry.names.length > 0)
		.map((entry) => `${entry.kind} [${entry.names.join(", ")}]`);
	if (native.length > 0) lines.push(`  native (selected through no declaration): ${native.join("; ")}`);
	if (unapplied.length > 0) {
		const byKind = new Map<string, UnappliedReference[]>();
		for (const entry of unapplied) {
			const list = byKind.get(entry.kind) ?? [];
			list.push(entry);
			byKind.set(entry.kind, list);
		}
		const groups = [...byKind].map(
			([kind, entries]) => `${kind} ${entries.map((entry) => JSON.stringify(entry.reference)).join(", ")} (declared by ${composition.projectPath}; not applied, not validated)`,
		);
		lines.push(`  unapplied: ${groups.join("; ")}`);
	}
	return lines;
}

export function formatStatusMarkdown(report: StatusReport): string {
	const lines: string[] = [];
	lines.push(`### profile: ${report.profile} (${report.source})`);
	// Composition rendering reads only the active plan's persisted metadata.
	lines.push(...compositionLines(report, report.composition?.unapplied ?? []));
	if (report.overlay !== undefined) {
		const parts = [
			...(report.overlay.disabledSkills ?? []).map((name) => `-skill:${name}`),
			...(report.overlay.disabledExtensions ?? []).map((id) => `-extension:${id}`),
			...(report.overlay.disabledMcps ?? []).map((name) => `-mcp:${name}`),
			...(report.overlay.disabledTools ?? []).map((name) => `-tool:${name}`),
		];
		lines.push(`overlay: ${parts.length > 0 ? parts.join(" ") : "(empty)"}`);
	}
	if (report.skills.length > 0) {
		lines.push("skills:");
		for (const skill of report.skills) {
			const provenance = report.origins?.skills !== undefined && Object.hasOwn(report.origins.skills, skill.name)
				? report.origins.skills[skill.name]
				: undefined;
			const contributor = provenance === undefined
				? ""
				// `native` is the disjoint kind, not a fabricated scope contributor.
				: provenance === "native"
					? " (native)"
					: ` (contributors: ${provenance})`;
			lines.push(`  ${skill.name} → ${skill.filePath}${contributor}`);
		}
	}
	if (report.extensions.length > 0) {
		lines.push("extensions:");
		for (const extension of report.extensions) {
			const originTag = extension.origin !== undefined ? ` [${extension.origin}]` : "";
			const contributor = report.extensionOrigins !== undefined && Object.hasOwn(report.extensionOrigins, extension.entry)
				? ` (contributors: ${report.extensionOrigins[extension.entry].contributors})`
				: "";
			lines.push(`  ${extension.id}${originTag} → ${extension.entry}${contributor}`);
		}
	}
	if (report.tools !== undefined) {
		lines.push(`tools: [${report.tools.join(", ")}]`);
	}
	if (report.pendingToolReferences !== undefined && report.pendingToolReferences.length > 0) {
		// Boot-snapshot truth only: the plan is written before session start, so no
		// current pending/resolved/dropped outcome is claimed.
		const pending = report.pendingToolReferences.map(
			(entry) => `${JSON.stringify(entry.reference)} (${entry.contributors})`,
		).join(", ");
		lines.push(
			`tools awaiting session start: ${pending} — boot-snapshot pending; current session outcome not recorded (UNKNOWN)`,
		);
	}
	if (report.subagents !== undefined) {
		lines.push("subagents (profile-declared overrides; not effective runtime mappings):");
		lines.push(`  extension registration: ${report.subagents.extension}`);
		lines.push(`  ${JSON.stringify(report.subagents.declared)}`);
		lines.push("  inspect the live mapping with /subagents-models");
	}
	lines.push(
		`mcp: enabled=[${report.mcp.enabled.join(", ")}] disabled=[${report.mcp.disabled.join(", ")}] missing=[${report.mcp.missing.join(", ")}]`,
	);
	if (report.mcpTools !== undefined && report.mcpTools.length > 0) {
		lines.push("mcp tools:");
		for (const item of report.mcpTools) {
			if (item.state !== undefined) {
				const state = item.state === "project" ? "project-owned" : item.state;
				lines.push(`  ${item.server}: declared policy [${(item.tools ?? []).join(", ")}] (${state}; not applied)`);
			} else if (item.policy === "unrestricted") {
				lines.push(`  ${item.server}: unrestricted`);
			} else if (item.policy === "none") {
				lines.push(`  ${item.server}: no enabled MCP tools`);
			} else {
				lines.push(`  ${item.server}: [${(item.tools ?? []).join(", ")}]`);
			}
		}
	}
	if (report.delta !== undefined) {
		lines.push(`delta: +[${report.delta.added.join(", ")}] -[${report.delta.removed.join(", ")}]`);
	}
	if (report.unmatched !== undefined) {
		lines.push(`unmatched (zero-match globs this resolution): [${report.unmatched.join(", ")}]`);
	}
	if (report.diagnostics !== undefined) {
		lines.push("diagnostics:");
		for (const issue of report.diagnostics) lines.push(`  ${issue.message}`);
	}
	for (const conflict of report.conflicts) {
		lines.push(
			`conflict: ${conflict.name} — plan resolved ${conflict.expectedPath}, Pi registered ${conflict.winnerPath} (Pi first-wins load order)`,
		);
	}
	return lines.join("\n");
}
