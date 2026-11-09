/**
 * Workspace management for pi-profile-switch.
 *
 * Rooted at `~/.pi-profile-switch` (or `PI_PROFILE_SWITCH_DIR` override).
 * Contains:
 * - `profiles/`: global profile definitions catalog
 * - `instances/`: instance runtime directories for forked pi processes
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function getProfileSwitchDir(): string {
	const env = process.env.PI_PROFILE_SWITCH_DIR;
	if (env && env.trim()) {
		return path.resolve(env.trim());
	}
	return path.join(homedir(), ".pi-profile-switch");
}

export function getGlobalProfilesDir(): string {
	return path.join(getProfileSwitchDir(), "profiles");
}

export function getInstancesRootDir(): string {
	return path.join(getProfileSwitchDir(), "instances");
}

export function getGlobalStateDir(agentDir?: string): string {
	const preferred = getProfileSwitchDir();
	const preferredState = path.join(preferred, "pi-profile-state.json");
	if (existsSync(preferredState)) {
		return preferred;
	}
	if (agentDir) {
		const fallbackState = path.join(agentDir, "pi-profile-state.json");
		if (existsSync(fallbackState)) {
			return agentDir;
		}
	}
	return agentDir ?? preferred;
}

