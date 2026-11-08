#!/usr/bin/env node
/**
 * pi-profile launcher (ADR-0005).
 *
 * Resolves the initial profile, materializes it as a generated runtime
 * directory (settings + symlinks + env), and spawns the real `pi`
 * binary with user arguments passed through verbatim.
 *
 * Usage:
 *   pi-profile                          # default profile
 *   pi-profile review                   # named profile (once catalogs land)
 *   pi-profile review -- --mode rpc --model openai/gpt-5.4
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { getInstancesRootDir } from "../src/workspace.ts";

import { ExtensionError } from "../src/extension-discovery.ts";
import { parseLauncherArgs } from "../src/launcher/args.ts";
import { UnknownProfileError, resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { untrustedProjectDiagnostic } from "../src/launcher/untrusted-project-diagnostic.ts";
import { sweepStaleInstances } from "../src/launcher/runtime-cleanup.ts";
import { spawnPi } from "../src/launcher/spawn.ts";
import { McpConfigError } from "../src/mcp-config.ts";
import { CatalogError } from "../src/profile-catalog.ts";
import { ActivationError, mergeResolutionDiagnostics, type ResolutionDiagnostic } from "../src/profile-resolver.ts";
import { readLaunchPlanFile } from "../src/switching/apply-plan.ts";
import { ensureStarterAssets } from "../src/starter-assets.ts";
import { generateRuntimeDir } from "../src/settings-generator.ts";

const emittedWarnings = new Set<string>();
let emittedDiagnostics: ResolutionDiagnostic[] = [];
function warn(message: string, diagnostic?: ResolutionDiagnostic): void {
	if (diagnostic !== undefined) {
		const merged = mergeResolutionDiagnostics(emittedDiagnostics, [diagnostic]);
		if (merged.length === emittedDiagnostics.length) return;
		emittedDiagnostics = merged;
	} else {
		if (emittedWarnings.has(message)) return;
		emittedWarnings.add(message);
	}
	console.error(`pi-profile: warning: ${message}`);
}

/** Whether a path is pi-profile's own per-launch instance directory.
 *  Trailing separator so a sibling such as `instances-old` does not match. */
function isInsideInstancesRoot(dir: string): boolean {
	const root = getInstancesRootDir();
	return dir === root || dir.startsWith(root + path.sep);
}

/** Resolve the real agent directory, ignoring an inherited per-launch instance.
 *
 *  A launcher started from inside an existing lane inherits that lane's
 *  `PI_CODING_AGENT_DIR`, and pi's `getAgentDir()` honours it. The new instance
 *  would then be built by mirroring the *parent's* instance instead of the real
 *  agent dir: stale settings, stale modes, and state links into a directory the
 *  sweep reclaims when the parent exits. A worker spawned from a leader inherits
 *  the leader's snapshot. Values under the instances root are therefore dropped
 *  before resolution; a genuine agent dir from anywhere else is still honoured. */
function resolveAgentDir(): string {
	const inherited = process.env.PI_CODING_AGENT_DIR;
	if (inherited !== undefined && isInsideInstancesRoot(inherited)) {
		delete process.env.PI_CODING_AGENT_DIR;
	}
	return getAgentDir();
}

try {
	const args = parseLauncherArgs(process.argv.slice(2));
	const agentDir = resolveAgentDir();
	// Starter assets (seed profile + profile-config skill) are ensured before
	// initial profile resolution so the seed is visible to this launch's
	// resolution and /profile list. Best-effort: ensure failures never block
	// the launch (same pattern as the sweep below).
	const starterAssets = await ensureStarterAssets({ agentDir });
	for (const warning of starterAssets.warnings) {
		warn(warning);
	}
	// Fails before spawning when the profile is unknown or cannot activate.
	// --approve/--no-approve are consumed here as a one-run trust input.
	const { plan, discovery, projectDir, projectTrusted, warnings } = await resolveInitialProfile(args.profile, {
		agentDir,
		cwd: process.cwd(),
		trustOverride: args.trustOverride,
	});
	for (const warning of warnings) {
		warn(warning, plan.diagnostics?.find((issue) => issue.message === warning));
	}
	// Untrusted-project notice: fires identically for every profile (default
	// included) because it is driven by the trust determination, not by which
	// profile branch resolution took. Startup continues either way.
	const untrustedNotice = untrustedProjectDiagnostic(process.cwd(), projectTrusted);
	if (untrustedNotice) {
		warn(untrustedNotice);
	}
	// Stale per-launch instance dirs (dead pid, or no pid past the grace
	// window) are swept before this launch materializes its own. Unrecognized
	// entries are dispositioned per content scan: kept + reported when they
	// reference the instance path or cannot be cleared, adopted into the real
	// agent dir, or deleted on a name conflict (real wins) — all with a stderr
	// notice (ADR-0012). Best-effort: sweep errors never block the launch.
	const sweep = await sweepStaleInstances(agentDir);
	for (const notice of sweep.notices) {
		console.error(`pi-profile: notice: ${notice}`);
	}
	for (const warning of sweep.warnings) {
		warn(warning);
	}
	const generated = await generateRuntimeDir(plan, { agentDir, discovery, projectDir });
	const materialized = await readLaunchPlanFile(generated.runtimeDir);
	for (const warning of generated.warnings) {
		warn(warning, materialized?.diagnostics?.find((issue) => issue.message === warning));
	}
	process.exitCode = await spawnPi({
		generated,
		piArgs: args.piArgs,
		// Re-applied for every profile: the one-run trust input must decide both
		// the resolver's project reads and Pi's project-scope visibility — two
		// different answers in one launch would be a divergence, not a policy.
		trustOverride: args.trustOverride,
	});
} catch (error) {
	// Launcher input/selection failures (unknown profile, unresolvable
	// references, malformed catalogs, illegal MCP config) are usage errors:
	// exit 2. Unexpected failures: exit 1.
	const isUsageError =
		error instanceof UnknownProfileError ||
		error instanceof ActivationError ||
		error instanceof ExtensionError ||

		error instanceof McpConfigError ||
		error instanceof CatalogError;
	console.error(error instanceof Error ? `pi-profile: ${error.message}` : error);
	process.exitCode = isUsageError ? 2 : 1;
}
