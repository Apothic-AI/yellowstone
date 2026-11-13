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
import type { ProfileComposition } from "../profile-composition.ts";

export interface ProfileListEntry {
	name: string;
	/** The source of the winning definition. */
	source: ProfileSource;
	label?: string;
	description?: string;
	/** True when a global definition of the same name is shadowed by the
	 *  project one. */
	shadowsGlobal: boolean;
	/** Composition metadata of a winner that declares `promptStrategy`. It is
	 *  taken from the already-resolved entry; listing never reads another
	 *  profile's definition to decide it. */
	composition?: ProfileComposition;
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
		...(profile.composition !== undefined ? { composition: profile.composition } : {}),
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
			// A composing append consumes the global definition as its base: it never
			// shadows or replaces it, even if a caller supplies a hand-built entry
			// that still sets the flag. A replacement winner keeps the claim.
			const composes = entry.composition?.branch === "composed";
			const shadowed = entry.shadowsGlobal && !composes ? " (shadows global)" : "";
			// A composing winner is marked from its own resolved metadata: the
			// standalone branch is stated as such, never as a failure.
			const composition = entry.composition !== undefined
				? composes
					? " (append composition)"
					: " (append, standalone)"
				: "";
			const label = entry.label ?? entry.description;
			const unavailable = !entry.available ? ` — unavailable: ${entry.error ?? "retry reading the profile definition"}` : "";
			return [`${entry.name} [${entry.source}]${shadowed}${composition}${label !== undefined ? ` — ${label}` : ""}${unavailable}${active}`, ...(entry.warnings ?? []).map((warning) => `  warning: ${warning}`)].join("\n");
		})
		.join("\n");
}
