/**
 * SkillRegistry: mirrors Pi's native skill discovery result as a
 * name → final SKILL.md mapping.
 *
 * Implemented on top of the Pi SDK's DefaultResourceLoader pointed at the
 * real agent dir and cwd, so discovery rules and same-name priority stay
 * Pi's own — this module never re-implements directory scanning.
 *
 * Extensions are NOT loaded during discovery (`noExtensions`): extension code
 * must never execute as a side effect of resolving a profile. Skills that
 * extensions contribute at runtime are therefore absent here — they load with
 * their extension instead of being referenced by profiles.
 *
 * Discovery re-runs on every call, so newly added/removed skills are
 * reflected immediately (glob references re-expand at every start).
 */

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface SkillEntry {
	/** Pi skill name (the profile-facing identity). */
	name: string;
	/** Absolute path of the winning SKILL.md (or lone .md) file. */
	filePath: string;
	/** Discovery source, e.g. "auto", "local", or a package source string. */
	source: string;
	/** "user" | "project" | "temporary" (Pi's SourceScope). */
	scope: string;
	/** "package" when contributed by an installed package, else "top-level". */
	origin: string;
	/** Package install root for package-origin skills (patterns are relative to it). */
	baseDir?: string;
}

export interface DiscoverSkillsOptions {
	cwd: string;
	agentDir: string;
	/**
	 * Whether the project at `cwd` is trusted (the launcher's trust check).
	 * Untrusted projects are never scanned: no project skills, no project
	 * settings packages. Defaults to false.
	 */
	projectTrusted?: boolean;
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillEntry[]> {
	// Project trust comes from the caller's trust check: discovery is the only
	// place project resources enter a plan's reference vocabulary (their
	// visibility in the session is Pi's, not the plan's).
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: options.projectTrusted ?? false,
	});
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	// Pi installs missing configured packages during resolve(); discovery must
	// stay read-only (no network, no mutations), so offline mode is forced for
	// the duration of the load. The spawned pi decides on installs itself at
	// startup, with its own progress UI. Known limitation: skills of a
	// not-yet-installed package cannot be referenced until after a reload.
	const savedOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	try {
		await loader.reload();
	} finally {
		if (savedOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = savedOffline;
	}
	return loader.getSkills().skills.flatMap((skill) => {
		// Project-scoped package skills stay out of the reference vocabulary:
		// their packages live under the project's .pi/npm and Pi discovers their
		// skills natively, so a profile reference would add nothing. Project
		// .pi/skills and ancestor .agents/skills are referenceable.
		if (skill.sourceInfo.origin === "package" && skill.sourceInfo.scope === "project") {
			return [];
		}
		return [
			{
				name: skill.name,
				filePath: skill.filePath,
				source: skill.sourceInfo.source,
				scope: skill.sourceInfo.scope,
				origin: skill.sourceInfo.origin,
				baseDir: skill.sourceInfo.baseDir,
			},
		];
	});
}
