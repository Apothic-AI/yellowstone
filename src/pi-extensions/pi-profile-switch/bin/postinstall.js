#!/usr/bin/env node
/**
 * postinstall: best-effort early seeding of the global catalog with the
 * default starter profile, and distribution of the profile-config skill to
 * the agent skills directory.
 *
 * Runs at package install time (`npm install pi-profile-switch` / `pi install`).
 *
 * Role: this hook is an early optimization, NOT the sole distribution
 * channel. npm v12+ blocks dependency lifecycle scripts by default
 * (allowScripts), so installs that skip this hook are covered by the
 * launcher instead: `bin/pi-profile.ts` calls the runtime ensure
 * (src/starter-assets.ts) on every launch, before resolving the initial
 * profile. The authoritative behavior contract for both assets lives in
 * openspec/specs/profile-catalog/spec.md ("Seeding the starter profile" and
 * "Distributing the profile-config skill"); keep this script's rules in sync with
 * src/starter-assets.ts, which is the single TS implementation.
 *
 * Idempotent and conservative:
 * - Writes the shipped `examples/ask.json` starter profile to the
 *   profiles dir ONLY when no .json profile exists there yet
 *   (COPYFILE_EXCL; an existing file — including one written concurrently — is never touched).
 * - Distributes the shipped `skills/profile-config/SKILL.md` to
 *   `<agentDir>/skills/profile-config/SKILL.md`, always overwriting with
 *   the shipped version so the skill stays in sync with the package.
 * - Never fails the install: errors are downgraded to a warning.
 *
 * This module is plain Node ESM (no jiti/TS): npm may run postinstall in a
 * context where only plain JS is safe. The path rules intentionally mirror
 * src/workspace.ts and Pi's getAgentDir() (in @earendil-works/pi-coding-agent)
 * — keep them in sync.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TEMPLATE = fileURLToPath(new URL("../examples/ask.json", import.meta.url));
const SKILL_TEMPLATE = fileURLToPath(new URL("../skills/profile-config/SKILL.md", import.meta.url));

/** Mirrors getProfileSwitchDir() in src/workspace.ts.
 *  @param {NodeJS.ProcessEnv} env */
function profileSwitchDir(env) {
	const override = env.PI_PROFILE_SWITCH_DIR;
	if (override && override.trim()) return path.resolve(override.trim());
	return path.join(homedir(), ".pi-profile-switch");
}

/** Mirrors getGlobalProfilesDir() in src/workspace.ts.
 *  @param {NodeJS.ProcessEnv} env */
function globalProfilesDir(env) {
	return path.join(profileSwitchDir(env), "profiles");
}

/** Mirrors Pi's getAgentDir() in @earendil-works/pi-coding-agent.
 *  Keep in sync with Pi's config resolution.
 *  Deliberate divergence from Pi: trims whitespace and resolves relative
 *  paths via path.resolve() for safety during postinstall.
 *  @param {NodeJS.ProcessEnv} env */
function agentDir(env) {
	const override = env.PI_CODING_AGENT_DIR;
	if (override && override.trim()) {
		const trimmed = override.trim();
		if (trimmed === "~") return homedir();
		if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
			return path.join(homedir(), trimmed.slice(2));
		}
		return path.resolve(trimmed);
	}
	return path.join(homedir(), ".pi", "agent");
}

/** Checks whether the directory exists and contains any .json files.
 *  @param {string} dir */
async function hasAnyJsonProfiles(dir) {
	try {
		const entries = await readdir(dir);
		return entries.some((name) => name.endsWith(".json"));
	} catch {
		return false;
	}
}

/** @typedef {{ path: string, written: boolean }} InstallResult */

/**
 * Seeds the default starter profile. Safe to call repeatedly; only writes
 * if no .json files exist in the global profiles directory.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<InstallResult>}
 */
export async function installDefaultProfiles({ env = process.env } = {}) {
	const dir = globalProfilesDir(env);
	const target = path.join(dir, "ask.json");

	if (await hasAnyJsonProfiles(dir)) {
		return { path: target, written: false };
	}

	await mkdir(dir, { recursive: true });
	try {
		await copyFile(DEFAULT_TEMPLATE, target, constants.COPYFILE_EXCL);
	} catch (error) {
		// Lost a create race (e.g. two installs in parallel): the winner's
		// file stands; still not ours to overwrite.
		if (error.code === "EEXIST") return { path: target, written: false };
		throw error;
	}
	return { path: target, written: true };
}

/**
 * Distributes the shipped profile-config skill to the agent skills directory.
 * Always overwrites with the shipped version. Downgrades failures to a warning.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<InstallResult>}
 */
export async function installProfileConfigSkill({ env = process.env } = {}) {
	const dir = path.join(agentDir(env), "skills", "profile-config");
	const target = path.join(dir, "SKILL.md");

	try {
		await mkdir(dir, { recursive: true });
		await copyFile(SKILL_TEMPLATE, target);
		return { path: target, written: true };
	} catch (error) {
		console.warn(
			`pi-profile: could not distribute profile-config skill: ${error instanceof Error ? error.message : error}`,
		);
		return { path: target, written: false };
	}
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	installDefaultProfiles().then(
		(result) => {
			if (result.written) console.log(`pi-profile: seeded starter profile at ${result.path}`);
		},
		(error) => {
			console.warn(`pi-profile: could not seed starter profile: ${error instanceof Error ? error.message : error}`);
		},
	);
	installProfileConfigSkill().then(
		(result) => {
			if (result.written) console.log(`pi-profile: distributed profile-config skill at ${result.path}`);
		},
		(error) => {
			console.warn(`pi-profile: could not distribute profile-config skill: ${error instanceof Error ? error.message : error}`);
		},
	);
}
