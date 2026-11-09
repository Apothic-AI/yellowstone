/**
 * Initial profile resolution for the launcher.
 *
 * Flow: trust check (gatekeeper for everything project-scoped) → positional
 * name or saved state (project state wins when trusted) → catalog lookup →
 * discovery (skills, extensions, MCP server names) → resolver (glob
 * expansion, overlay, native model handoff) → ActivationPlan + full discovery
 * results for the settings generator. Normal default activation bypasses
 * the catalog; named activation reads only its winning definition.
 *
 * The CLI's initial selection is transient: no runtime state is written here.
 */

import path from "node:path";

import { isRecord, readJsonFile } from "../json-file.ts";
import { loadMergedMcpServers } from "../mcp-config.ts";
import { ProfileCatalog, type ResolvedProfile } from "../profile-catalog.ts";
import { ActivationError, defaultPlan, mergeResolutionDiagnostics, resolutionDiagnostics, resolveProfile, type ActivationPlan } from "../profile-resolver.ts";
import { resolveProjectTrust } from "../project-trust.ts";
import { RuntimeStateStore, type RuntimeOverlay } from "../runtime-state-store.ts";
import { getGlobalStateDir } from "../workspace.ts";
import { discoverLauncherResources, type LauncherDiscovery } from "./discovery.ts";

export class UnknownProfileError extends Error {
	constructor(name: string) {
		super(`unknown profile: ${name}`);
		this.name = "UnknownProfileError";
	}
}

function collectPlanDiagnostics(plan: ActivationPlan, discovery: LauncherDiscovery, profile?: ResolvedProfile): string[] {
	const diagnostics = mergeResolutionDiagnostics(
		resolutionDiagnostics(plan),
		discovery.extensions.warnings().map((message) => ({ kind: "extension-discovery", code: "discovery-warning", reference: message, message: `profile "${plan.profile}": ${message}` })),
		(profile?.warnings ?? []).map((message) => {
			const separator = message.indexOf(': profile "');
			return { kind: "catalog", code: "unknown-field", reference: message.match(/unknown field "([^"]*)"/)?.[1] ?? message, message, ...(separator >= 0 ? { filePath: message.slice(0, separator) } : {}) };
		}),
	);
	if (diagnostics.length > 0) plan.diagnostics = diagnostics;
	return diagnostics.map((issue) => issue.message);
}

export interface LauncherContext {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** The project working directory Pi will run in. */
	cwd: string;
	/** One-run trust input from --approve / --no-approve (never forwarded to Pi). */
	trustOverride?: boolean;
}

export interface InitialProfile {
	plan: ActivationPlan;
	/** Full discovery results for the settings generator. Undefined for the
	 *  default profile (which applies no filtering). */
	discovery?: LauncherDiscovery;
	/** The trusted project directory, when trusted. */
	projectDir?: string;
	/** The launcher's project-trust determination. Drives the untrusted-
	 *  project diagnostic; not inferable from projectDir, which the dangling
	 *  saved-profile fallback returns unset while the project is trusted. */
	projectTrusted: boolean;
	/** Non-fatal notices for the user (e.g. a dangling restored profile that
	 *  fell back to default). The launcher prints them. */
	warnings: string[];
}

/** Reads the real global `defaultProjectTrust` setting (a trust input) and
 *  resolves the project trust decision from Pi's own trust store. Exported
 *  for the session-side surfaces (selector/list/status) that need the same
 *  trust gate the launcher uses. */
export async function readTrustInputs(context: LauncherContext): Promise<{
	projectTrusted: boolean;
}> {
	const globalSettingsPath = path.join(context.agentDir, "settings.json");
	const globalSettings = await readJsonFile(globalSettingsPath);
	const userDefaultProjectTrust =
		globalSettings.ok && isRecord(globalSettings.value) && typeof globalSettings.value.defaultProjectTrust === "string"
			? globalSettings.value.defaultProjectTrust
			: undefined;
	const projectTrusted = resolveProjectTrust({
		cwd: context.cwd,
		agentDir: context.agentDir,
		trustOverride: context.trustOverride,
		userDefaultProjectTrust,
	});
	if (!projectTrusted) {
		return { projectTrusted };
	}
	// The project's own `.pi/settings.json` is Pi's to read (natively, for the
	// same trust decision): pi-profile neither merges nor narrows it.
	return { projectTrusted };
}

export async function resolveInitialProfile(
	name: string | undefined,
	context: LauncherContext,
	options?: { overlay?: RuntimeOverlay; liveToolNames?: string[] },
): Promise<InitialProfile> {
	const { projectTrusted } = await readTrustInputs(context);
	const projectDir = projectTrusted ? context.cwd : undefined;
	// PI_PROFILE is an explicit launch selection supplied by a spawner. Profile
	// resolution is otherwise cwd-scoped, so a lane that shares its parent's
	// working directory — a worker beside its leader — cannot be told apart from
	// that parent by the saved selections. It ranks below a positional name and
	// above every saved selection, and an unknown value fails loudly like a
	// positional name does, because a spawner that mistypes should learn now
	// rather than get a silently unfiltered lane.
	const envProfile = process.env.PI_PROFILE?.trim() || undefined;
	const explicitName = name ?? envProfile;
	let selected = explicitName;
	const warnings: string[] = [];
	if (selected === undefined) {
		// No positional name and no PI_PROFILE: the trusted project's saved
		// selection is the more specific one and wins; otherwise the global state,
		// then default.
		if (projectTrusted) {
			selected = (await new RuntimeStateStore(path.join(context.cwd, ".pi")).read()).activeProfile;
		}
		selected ??= (await new RuntimeStateStore(getGlobalStateDir(context.agentDir)).read()).activeProfile ?? "default";
	}

	// Default activation needs no catalog enumeration or definition reads.
	const profile = selected === "default"
		? { name: "default", source: "builtin" as const, definition: {} }
		: await (await ProfileCatalog.load(context.agentDir, { projectDir })).resolve(selected);
	if (profile === undefined) {
		// Explicit positional selection fails loudly; a restored selection that
		// no longer exists falls back to default with a warning instead of
		// blocking the launch (restore is a convenience, not a commitment).
		if (explicitName !== undefined) {
			throw new UnknownProfileError(selected);
		}
		warnings.push(`saved profile "${selected}" no longer exists; starting the default profile`);
		return { plan: defaultPlan(), projectTrusted, warnings };
	}
	if (profile.source === "builtin") {
		// The default profile is normally unfiltered. With an overlay it becomes
		// a synthetic "everything minus disabled" selection (PRD: overlays may
		// temporarily narrow default's scope). MCP narrowing on default is
		// rejected — the default profile declares no MCP server selection.
		const overlay = options?.overlay;
		const narrowed =
			overlay !== undefined &&
			((overlay.disabledSkills?.length ?? 0) > 0 ||
				(overlay.disabledExtensions?.length ?? 0) > 0 ||
				(overlay.disabledMcps?.length ?? 0) > 0 ||
				(overlay.disabledTools?.length ?? 0) > 0);
		if (!narrowed) {
			return { plan: defaultPlan(), projectTrusted, warnings };
		}
		if ((overlay.disabledMcps?.length ?? 0) > 0) {
			throw new ActivationError(
				"the default profile has no MCP allowlist to narrow",
			);
		}
		// The synthetic definition declares no skills/extensions so the shared
		// resolver supplies each kind's native referenceable base and concrete
		// overlay exclusions, instead of inventing cross-kind wildcards.
		const synthetic: ResolvedProfile = {
			name: "default",
			source: "builtin",
			definition: {},
		};
		const discovery = await discoverLauncherResources({ ...context, projectTrusted });
		const plan = await resolveProfile({
			profile: synthetic,
			skills: discovery.skills,
			extensions: discovery.extensions,
			overlay,
			liveToolNames: options?.liveToolNames,
		});
		warnings.push(...collectPlanDiagnostics(plan, discovery));
		return { plan, discovery, projectDir, projectTrusted, warnings };
	}

	const discovery = await discoverLauncherResources({ ...context, projectTrusted });

	// Diagnose source content regardless of whether the profile declares an
	// MCP policy; unexpected filesystem failures still propagate.
	const mcpDiscovery = await loadMergedMcpServers(context.agentDir, projectDir, { invalidSource: "diagnose" });

	const plan = await resolveProfile({
		profile,
		skills: discovery.skills,
		extensions: discovery.extensions,
		discoveredMcpServers: mcpDiscovery ? Object.keys(mcpDiscovery.servers).sort() : undefined,
		mcpDiscovery,
		overlay: options?.overlay,
		liveToolNames: options?.liveToolNames,
	});
	warnings.push(...collectPlanDiagnostics(plan, discovery, profile));
	return { plan, discovery, projectDir, projectTrusted, warnings };
}
