/**
 * SwitchProfile: the in-session switching orchestrator (ticket 05).
 *
 * Runs inside Pi (the extension's `/profile use` / `/profile reload`), but
 * is written dependency-injected so unit tests never need a real Pi.
 *
 * Flow (`/profile use <name>`):
 *   1. wait for the agent to be idle (Pi's native `ctx.waitForIdle()`) — a
 *      running turn is never torn down
 *   2. snapshot ALL pi-profile-managed runtime files in memory
 *      (settings.json, pi-profile.json, mcp.json, APPEND_SYSTEM.md, and the
 *      trust.json link state — each as absent | symlink | file)
 *   3. re-resolve through the full launcher path (trust check, catalogs,
 *      discovery, model/MCP validation) against the REAL agent
 *      dir — any failure here leaves the runtime untouched
 *   4. rewrite the runtime files in place (the running process's
 *      PI_CODING_AGENT_DIR cannot move) and mark the plan
 *      `persistSelection` so the post-reload extension instance saves the
 *      selection
 *   5. `ctx.reload()` — Pi re-reads settings from disk, re-executes
 *      extensions, preserves the session
 *   6. VERIFY the reload ran: interactive Pi swallows reload refusals and
 *      errors (showError) instead of rejecting, so a resolved promise is
 *      not proof. A real reload invalidates this extension context — the
 *      `assertStale` probe throws iff that happened. A silent skip rolls
 *      back exactly like a rejection: restore the snapshot, reload again.
 *      The runtime never sits half-switched.
 *
 * `/profile reload` is the same path minus the `switchedFrom` marker (no
 * change summary) and preserving however the current profile became active
 * (transient launch selections stay transient).
 */

import { chmod, lstat, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveInitialProfile } from "../launcher/initial-profile.ts";
import { RuntimeStateStore, type RuntimeOverlay } from "../runtime-state-store.ts";
import { getGlobalStateDir } from "../workspace.ts";
import { writeRuntimeFiles } from "../settings-generator.ts";
import { readLaunchPlanFile } from "./apply-plan.ts";

export class SwitchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SwitchError";
	}
}

export interface SwitchDeps {
	/** The active generated runtime dir (the running Pi's agent dir). */
	runtimeDir: string;
	/** The user's real agent dir (from the launch plan; trust, catalogs,
	 *  registries, and state all live there). */
	realAgentDir: string;
	/** The project working directory. */
	cwd: string;
	/** Pi's live tool registry (pi.getAllTools()): the base set overlay tool
	 *  disable entries narrow when the profile declares no tools, and the
	 *  in-session expansion universe for declared references. */
	getAllTools(): Array<{ name: string }>;
	/** Pi's native idle wait (ctx.waitForIdle): resolves when the current
	 *  turn/compaction finishes. */
	waitForIdle(): Promise<void>;
	reload(): Promise<void>;
	/** Throws iff this extension context has been invalidated — proof the
	 *  reload actually re-executed extensions. Interactive Pi swallows reload
	 *  refusals/failures instead of rejecting, so without this probe a
	 *  skipped reload would be misreported as a successful switch. Optional
	 *  for tests; always provided by the extension. */
	assertStale?(): void;
	/** Reports the actionable rollback cause before the rollback reload. The
	 *  caller owns presentation; a reporter failure must not interrupt
	 *  restoration or reload. Optional — without it the caller only sees the
	 *  rejected `SwitchError`. */
	reportFailure?(message: string): void;
}

export interface SwitchResult {
	profile: string;
	warnings: string[];
}

/** The pre-switch state of one pi-profile-managed runtime file. Absence is
 *  a real state (the switch may create the file); a symlink keeps its raw
 *  target so restore can rebuild it exactly; a file keeps content AND
 *  permission bits so restore doesn't widen a user-tightened mode. */
type FileSnapshot =
	| { kind: "absent" }
	| { kind: "symlink"; target: string }
	| { kind: "file"; content: string; mode: number }
	/** Unsafe non-symlink content (a real file or directory) that must never be
	 *  deleted or rewritten on restore. */
	| { kind: "opaque" };

interface RuntimeSnapshot {
	settings: FileSnapshot;
	plan: FileSnapshot;
	mcp: FileSnapshot;
	appendSystem: FileSnapshot;
	trust: FileSnapshot;
	/** The conditional managed extension link: absent or its raw symlink target. */
	extensions: FileSnapshot;
}

/** Snapshots one managed runtime file. lstat (never stat) detects symlinks
 *  without following them; ENOENT is the only tolerated error — absence is
 *  expected (first launch), while anything else (permissions, unreadable
 *  dir) must not silently disable rollback protection. */
async function snapshotFile(filePath: string): Promise<FileSnapshot> {
	const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
		// ENOENT is the only tolerated error — absence is expected (first
		// launch); anything else (permissions, unreadable dir) must not
		// silently disable rollback protection.
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (info === null) return { kind: "absent" };
	if (info.isSymbolicLink()) {
		return { kind: "symlink", target: await readlink(filePath) };
	}
	return { kind: "file", content: await readFile(filePath, "utf8"), mode: info.mode & 0o777 };
}

/** Snapshots the managed extension path as absence or a raw symlink target.
 *  Real non-symlink content (a file or directory) at that path is unsafe and is
 *  recorded as opaque: restore must never delete or rewrite it, and activation
 *  refuses to replace it with the generated link. Reading it as a file would
 *  surface an obscure EISDIR for directories. */
async function snapshotExtensionPath(filePath: string): Promise<FileSnapshot> {
	const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (info === null) return { kind: "absent" };
	if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(filePath) };
	return { kind: "opaque" };
}

async function snapshotRuntimeFiles(runtimeDir: string): Promise<RuntimeSnapshot> {
	return {
		settings: await snapshotFile(path.join(runtimeDir, "settings.json")),
		plan: await snapshotFile(path.join(runtimeDir, "pi-profile.json")),
		mcp: await snapshotFile(path.join(runtimeDir, "mcp.json")),
		appendSystem: await snapshotFile(path.join(runtimeDir, "APPEND_SYSTEM.md")),
		trust: await snapshotFile(path.join(runtimeDir, "trust.json")),
		extensions: await snapshotExtensionPath(path.join(runtimeDir, "extensions")),
	};
}

async function restoreFile(filePath: string, snapshot: FileSnapshot): Promise<void> {
	// Opaque (real, unsafe) content is never deleted or rewritten on restore.
	if (snapshot.kind === "opaque") return;
	// rm first, always: restoring a snapshotted FILE must never writeFile
	// through a symlink the failed switch left on disk — that would write
	// THROUGH to the link target (the user's real ~/.pi/agent/mcp.json)
	// instead of replacing the link.
	await rm(filePath, { force: true });
	if (snapshot.kind === "symlink") {
		await symlink(snapshot.target, filePath);
	} else if (snapshot.kind === "file") {
		await writeFile(filePath, snapshot.content);
		await chmod(filePath, snapshot.mode);
	}
}

async function restoreRuntimeFiles(runtimeDir: string, snapshot: RuntimeSnapshot): Promise<void> {
	await restoreFile(path.join(runtimeDir, "settings.json"), snapshot.settings);
	await restoreFile(path.join(runtimeDir, "pi-profile.json"), snapshot.plan);
	await restoreFile(path.join(runtimeDir, "mcp.json"), snapshot.mcp);
	await restoreFile(path.join(runtimeDir, "APPEND_SYSTEM.md"), snapshot.appendSystem);
	await restoreFile(path.join(runtimeDir, "trust.json"), snapshot.trust);
	// Restore the extension-path representation (absence or raw link target)
	// before the rollback reload; the real resource directory is never touched.
	await restoreFile(path.join(runtimeDir, "extensions"), snapshot.extensions);
}

/** Waits are delegated to Pi's native `ctx.waitForIdle()` (see SwitchDeps);
 *  no polling loop lives here. */

/** Reads the current plan file for `switchedFrom`/persistence. A missing or
 *  malformed plan means the session is not profile-managed: switching still
 *  works, with no prior name to report. */
async function readCurrentPlan(runtimeDir: string): Promise<{ profile?: string; persistSelection: boolean }> {
	const plan = await readLaunchPlanFile(runtimeDir);
	return { profile: plan?.profile, persistSelection: plan?.persistSelection === true };
}

export async function switchProfile(
	name: string | undefined,
	deps: SwitchDeps,
	options?: { reloadCurrent?: boolean; overlay?: RuntimeOverlay | null; clearOverlay?: boolean },
): Promise<SwitchResult> {
	const current = await readCurrentPlan(deps.runtimeDir);
	const target = options?.reloadCurrent === true ? (current.profile ?? name) : name;
	if (target === undefined) {
		throw new SwitchError("no active profile to reload");
	}

	// Overlay resolution: explicit `overlay` wins (overlay mutation),
	// explicit `null` suppresses (clear/switch), and a plain `/profile reload`
	// re-applies the stored overlay so runtime and state never diverge.
	let overlay = options?.overlay;
	if (overlay === undefined && options?.reloadCurrent === true && current.profile !== undefined) {
		const currentPlan = await readLaunchPlanFile(deps.runtimeDir);
		if (currentPlan?.agentDir !== undefined) {
			const stateDir = currentPlan.source === "project" ? path.join(deps.cwd, ".pi") : getGlobalStateDir(currentPlan.agentDir);
			overlay = (await new RuntimeStateStore(stateDir).read()).overlay ?? null;
		}
	}

	await deps.waitForIdle();

	// Snapshot before resolving so the rollback target always exists.
	const snapshot = await snapshotRuntimeFiles(deps.runtimeDir);

	// Full launcher resolution: trust gate, catalogs, discovery, model +
	// MCP validation. Failures here leave the runtime
	// untouched — nothing was written yet.
	const resolved = await resolveInitialProfile(
		target,
		{ agentDir: deps.realAgentDir, cwd: deps.cwd },
		{ overlay: overlay ?? undefined, liveToolNames: deps.getAllTools().map((tool) => tool.name) },
	);

	const isSwitch = !options?.reloadCurrent && target !== current.profile;
	// Carry the pre-switch resolved sets into the new plan for status deltas.
	const previousPlan = await readLaunchPlanFile(deps.runtimeDir);
	const previousResolved =
		previousPlan?.resolved !== undefined
			? {
					skills: previousPlan.resolved.skills.map((skill) => skill.name),
					extensions: previousPlan.resolved.extensions.map((entry) => entry.id),
					...(previousPlan.tools !== undefined ? { tools: previousPlan.tools } : {}),
					...(previousPlan.mcps !== undefined ? { mcps: previousPlan.mcps } : {}),
				}
			: undefined;
	// Generation owns the final structured diagnostic snapshot. Keep only
	// plain resolution warnings here; otherwise refreshed or cleared MCP
	// diagnostics would resurrect earlier candidate messages after reload.
	const structuredResolutionWarnings = new Set((resolved.plan.diagnostics ?? []).map((issue) => issue.message));
	const warnings = resolved.warnings.filter((message) => !structuredResolutionWarnings.has(message));

	const rollback = async (cause: string): Promise<never> => {
		const message = `activation of profile "${target}" failed; restored the previous settings. Cause: ${cause}`;
		// Report the actionable cause before the rollback reload invalidates the
		// caller's command context; a reporter failure must never prevent
		// restoration or reload.
		try {
			deps.reportFailure?.(message);
		} catch {
			// Presentation must not block rollback.
		}
		// Restore the verified snapshot and reload again — the runtime must
		// never sit half-switched. State files were not written yet (the
		// post-reload extension instance owns them), so nothing else moved.
		await restoreRuntimeFiles(deps.runtimeDir, snapshot);
		try {
			await deps.reload();
		} catch {
			// The restore reload failing too is reported through the original error.
		}
		throw new SwitchError(message);
	};

	// The write-and-reload interval is one rollback boundary: a failure in any
	// write after the first, or in reload, restores every managed file (D3).
	try {
		const written = await writeRuntimeFiles(deps.runtimeDir, resolved.plan, {
			agentDir: deps.realAgentDir,
			projectDir: resolved.projectDir,
			discovery: resolved.discovery,
			planExtras: {
				...(isSwitch && current.profile !== undefined ? { switchedFrom: current.profile } : {}),
				// `/profile use` persists; `/profile reload` keeps the current
				// profile's existing persistence (launch selections stay transient).
				persistSelection: options?.reloadCurrent === true ? current.persistSelection : true,
				// A switch discards the previous profile's overlay; the post-reload
				// instance drops it from the state file. Customize/reset manage the
				// overlay directly and never set this.
				...(options?.clearOverlay === true ? { clearOverlay: true } : {}),
				...(previousResolved !== undefined ? { previousResolved } : {}),
			},
		});
		warnings.push(...written.warnings);
		await deps.reload();
	} catch (error) {
		await rollback(error instanceof Error ? error.message : String(error));
	}

	// Interactive Pi reports reload refusals/failures via the UI instead of
	// rejecting — verify the reload actually re-executed extensions (which
	// invalidates this context) before calling the switch a success.
	if (deps.assertStale !== undefined) {
		let stale = false;
		try {
			deps.assertStale();
		} catch {
			stale = true;
		}
		if (!stale) {
			await rollback("Pi did not run the reload (refused or failed silently)");
		}
	}

	return { profile: resolved.plan.profile, warnings: [...new Set(warnings)] };
}
