/**
 * ProfileListing: the profile selector's and the degraded bare `/profile`
 * list's data surface (ticket 07).
 *
 * Trust-gated exactly like activation: an untrusted project's profiles are
 * invisible. The listing reports each visible profile with the source of
 * the WINNING definition (a same-name project definition fully replaces
 * the global one — the shadowed global entry is reported as such).
 */

import { readTrustInputs } from "../launcher/initial-profile.ts";
import { ProfileCatalog, type ProfileSource } from "../profile-catalog.ts";

export interface ProfileListEntry {
	name: string;
	/** The source of the winning definition. */
	source: ProfileSource;
	label?: string;
	description?: string;
	/** True when a global definition of the same name is shadowed by the
	 *  project one. */
	shadowsGlobal: boolean;
	available: boolean;
	error?: string;
	warnings?: string[];
}

export async function listProfiles(input: {
	realAgentDir: string;
	cwd: string;
	onDiagnostic?: (message: string) => void;
}): Promise<ProfileListEntry[]> {
	const { projectTrusted } = await readTrustInputs({ agentDir: input.realAgentDir, cwd: input.cwd });
	const catalog = await ProfileCatalog.load(input.realAgentDir, {
		projectDir: projectTrusted ? input.cwd : undefined,
	});
	for (const diagnostic of catalog.diagnostics()) input.onDiagnostic?.(diagnostic);
	return (await catalog.list()).map((profile) => ({
		name: profile.name,
		source: profile.source,
		...(typeof profile.definition?.label === "string" ? { label: profile.definition.label } : {}),
		...(typeof profile.definition?.description === "string" ? { description: profile.definition.description } : {}),
		shadowsGlobal: profile.shadowsGlobal,
		available: profile.available,
		...(profile.error !== undefined ? { error: profile.error } : {}),
		...(profile.warnings !== undefined ? { warnings: profile.warnings } : {}),
	}));
}

export function formatProfileList(entries: ProfileListEntry[], activeProfile?: string): string {
	if (entries.length === 0) {
		return "no profiles found";
	}
	return entries
		.map((entry) => {
			const active = entry.name === activeProfile ? " ← active" : "";
			const shadowed = entry.shadowsGlobal ? " (shadows global)" : "";
			const label = entry.label ?? entry.description;
			const unavailable = !entry.available ? ` — unavailable: ${entry.error ?? "retry reading the profile definition"}` : "";
			return [`${entry.name} [${entry.source}]${shadowed}${label !== undefined ? ` — ${label}` : ""}${unavailable}${active}`, ...(entry.warnings ?? []).map((warning) => `  warning: ${warning}`)].join("\n");
		})
		.join("\n");
}
