/**
 * Launcher-side discovery: the full skill registry plus the configured
 * global package roots, both read-only, feeding the resolver and the
 * settings generator.
 */

import path from "node:path";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import {
	DiscoveredExtensions,
	discoverExtensions,
} from "../extension-discovery.ts";
import type { ConfiguredPackageRoot } from "../settings-generator.ts";
import { discoverSkills, type SkillEntry } from "../skill-registry.ts";
import type { LauncherContext } from "./initial-profile.ts";

export interface LauncherDiscovery {
	skills: SkillEntry[];
	packages: ConfiguredPackageRoot[];
	/** Discovered selectable extensions: package entries + loose files. */
	extensions: DiscoveredExtensions;
}

/** Resolves a configured package's local root without network access:
 *  the manager's installed path for npm/git sources, or the local source
 *  path resolved against the agent dir (Pi's base for user-scope entries). */
function resolvePackageRoot(source: string, installedPath: string | undefined, agentDir: string): string | undefined {
	if (installedPath !== undefined) return installedPath;
	if (source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("github:")) return undefined;
	const expanded = source.startsWith("~")
		? path.join(process.env.HOME ?? "", source.slice(1))
		: source;
	return path.resolve(agentDir, expanded);
}

export async function discoverLauncherResources(
	context: LauncherContext & { projectTrusted: boolean },
): Promise<LauncherDiscovery> {
	const settingsManager = SettingsManager.create(context.cwd, context.agentDir, {
		projectTrusted: context.projectTrusted,
	});
	const packageManager = new DefaultPackageManager({
		cwd: context.cwd,
		agentDir: context.agentDir,
		settingsManager,
	});
	// User-scope packages only: project-scope packages install under the
	// project's .pi/npm, which generated global-scope settings cannot reference.
	const configured = packageManager
		.listConfiguredPackages()
		.filter((pkg) => pkg.scope === "user")
		.map((pkg) => ({ source: pkg.source, root: resolvePackageRoot(pkg.source, pkg.installedPath, context.agentDir) }));
	const [skills, extensions] = await Promise.all([
		discoverSkills(context),
		// Extension discovery resolves through Pi's own package manager, so it
		// only needs the same cwd/agentDir/trust inputs as skill discovery.
		discoverExtensions({
			cwd: context.cwd,
			agentDir: context.agentDir,
			projectTrusted: context.projectTrusted,
		}),
	]);
	return { skills, packages: configured, extensions };
}
