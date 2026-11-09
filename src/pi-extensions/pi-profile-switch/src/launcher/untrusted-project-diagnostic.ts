/**
 * Untrusted-project launch diagnostic.
 *
 * After the launcher's project-trust determination judges the project
 * untrusted, the project catalog, project runtime state, project MCP
 * configuration, and Pi's own project resources are skipped silently
 * (ADR-0011). This module names the skipped content and how to authorize it
 * so the result of the determination is observable. Detection mirrors the
 * trust-requiring set: pi-profile's project files (see project-trust.ts) and
 * Pi's project resources (see pi-coding-agent's trust manager).
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";

import { PI_PROFILE_PROJECT_FILES } from "../project-trust.ts";

/** The project's MCP configuration files (the project sources recognized by
 *  mcp-config.ts). */
const PROJECT_MCP_CONFIGS = [".mcp.json", path.join(".pi", "mcp.json")] as const;

/** Pi's trust-requiring `.pi` entries (mirrors
 *  TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES in pi-coding-agent's trust
 *  manager, which doesn't export the list). */
const PI_PROJECT_RESOURCES = [
	"settings.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

/** Relative paths of project content skipped while the project is
 *  untrusted; empty when the project contains nothing trust-requiring. */
function skippedProjectContent(cwd: string): string[] {
	const skipped: string[] = [];
	for (const name of PI_PROFILE_PROJECT_FILES) {
		if (existsSync(path.join(cwd, ".pi", name))) {
			skipped.push(path.join(".pi", name));
		}
	}
	for (const mcpConfig of PROJECT_MCP_CONFIGS) {
		if (existsSync(path.join(cwd, mcpConfig))) {
			skipped.push(mcpConfig);
		}
	}
	for (const resource of PI_PROJECT_RESOURCES) {
		if (existsSync(path.join(cwd, ".pi", resource))) {
			skipped.push(path.join(".pi", resource));
		}
	}
	if (skipped.length === 0 && hasTrustRequiringProjectResources(cwd)) {
		// Pi gated something this list doesn't name: a cwd-local
		// .agents/skills, or one in a parent directory.
		skipped.push(
			existsSync(path.join(cwd, ".agents", "skills"))
				? path.join(".agents", "skills")
				: "Pi project resources in a parent directory",
		);
	}
	return skipped;
}

/** The untrusted-project diagnostic for this launch, or undefined when there
 *  is nothing to report (trusted project, or untrusted with no
 *  trust-requiring content). The launcher prints the result to stderr. */
export function untrustedProjectDiagnostic(cwd: string, projectTrusted: boolean): string | undefined {
	if (projectTrusted) {
		return undefined;
	}
	const skipped = skippedProjectContent(cwd);
	if (skipped.length === 0) {
		return undefined;
	}
	return (
		`project is untrusted; skipped project content is invisible to this launch: ${skipped.join(", ")}. ` +
		'To authorize it, run "/trust" in Pi to persist the decision (effective on the next launch), ' +
		'or relaunch with "-- --approve" to grant one-shot trust for this launch.'
	);
}
