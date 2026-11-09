/**
 * Project trust resolution for the launcher — pi-profile's gate for the
 * project-scope content it reads itself: the project catalog, the project
 * runtime state, and the project MCP config. Project-level resources
 * (skills, extensions, prompts, themes, settings) are Pi's own business: its
 * trust store decision, exposed through the linked `trust.json`, decides
 * their visibility (see ADR-0011).
 *
 * Mirrors Pi's own trust decision order (`resolveProjectTrusted`), with
 * pi-profile's catalog/state files added to the trust-requiring
 * resource set (they are pi-profile's project attack surface; Pi doesn't
 * know about them):
 *   1. one-run `--approve` / `--no-approve` override (consumed by the
 *      launcher and re-applied to the spawned pi for every profile)
 *   2. a project with no trust-requiring resources at all is trusted —
 *      there is nothing project-scoped to gate
 *   3. the stored decision in the real `trust.json` (nearest ancestor wins)
 *   4. the user's `defaultProjectTrust` setting — but only "always" grants;
 *      "ask" cannot prompt here (the launcher has no trust UI), so it falls
 *      through to untrusted
 *   5. otherwise untrusted: project catalogs, project state, and project MCP
 *      config are not read at all
 *
 * Known divergence from Pi: extension `project_trust` event handlers are not
 * consulted — that would require executing extension code in the launcher,
 * which pi-profile never does. A spawned Pi still runs those handlers with
 * its own settings, so an extension that answers yes/no can decide the
 * project scope of that session.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export interface ProjectTrustInput {
	cwd: string;
	agentDir: string;
	/** One-run override from --approve (true) / --no-approve (false). */
	trustOverride?: boolean;
	/** The user's real global `defaultProjectTrust` setting. */
	userDefaultProjectTrust?: string;
}

export function resolveProjectTrust(input: ProjectTrustInput): boolean {
	if (input.trustOverride !== undefined) {
		return input.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(input.cwd) && !hasPiProfileProjectFiles(input.cwd)) {
		return true;
	}
	let stored = new ProjectTrustStore(input.agentDir).get(input.cwd);
	if (stored === null) {
		// Defensive fallback for raw/symlinked entries in trust.json
		// that ProjectTrustStore's canonicalizePath missed.
		try {
			const trustFile = path.join(input.agentDir, "trust.json");
			if (existsSync(trustFile)) {
				const content = JSON.parse(readFileSync(trustFile, "utf8"));
				if (typeof content === "object" && content !== null) {
					let curr: string | undefined = path.resolve(input.cwd);
					while (curr && curr !== path.dirname(curr)) {
						if (content[curr] === true || content[curr] === false) {
							stored = content[curr];
							break;
						}
						curr = path.dirname(curr);
					}
				}
			}
		} catch {}
	}
	if (stored !== null) {
		return stored;
	}
	return input.userDefaultProjectTrust === "always";
}

/** pi-profile's own project files, relative to the project's `.pi`
 *  directory. They are trust-requiring even though Pi's native list doesn't
 *  know them: a committed catalog/state file would otherwise inject profile
 *  definitions (and instructions) unguarded. Exported so the launcher's
 *  untrusted-project diagnostic names exactly the files the trust gate
 *  skips — the two must never drift apart. */
export const PI_PROFILE_PROJECT_FILES = ["profiles", "pi-profile-state.json"] as const;

export function hasPiProfileProjectFiles(cwd: string): boolean {
	return PI_PROFILE_PROJECT_FILES.some((name) => existsSync(path.join(cwd, ".pi", name)));
}
