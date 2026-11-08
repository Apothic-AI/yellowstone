/**
 * InstanceCleanup: sweeps stale per-launch instance directories at startup.
 *
 * Every launch materializes its own instance dir under
 * `<PI_PROFILE_SWITCH_DIR>/instances/launch-*` (ADR-0010), which would
 * otherwise accumulate forever. Startup sweep is the ONLY cleanup mechanism by
 * design: any exit — graceful, signal, SIGKILL, power loss — kills the child
 * pid, so the next launch's sweep converges. There is no exit-time deletion; it
 * would only buy immediacy at the cost of deletion logic on the signal path.
 *
 * Liveness token: a `pid` file written by spawnPi into the instance dir.
 * (Naming the dir after the pid is impossible — the pid does not exist before
 * spawn, and the running process's PI_CODING_AGENT_DIR path is frozen.) Rules
 * per instance dir:
 * - pid file parses and the process is alive (or EPERM) → keep;
 *   ESRCH → candidate.
 * - no/unparsable pid file → candidate only when the dir mtime is older than
 *   NO_PID_GRACE_MS. The grace window guards the concurrent-launch race (a
 *   second launcher between mkdir and its pid write must not be reaped); it
 *   also covers post-mkdir crashes.
 * PID reuse needs no /proc check: a wrong keep only delays cleanup and
 * self-heals once the reused pid dies.
 *
 * A candidate is reclaimed only when every entry in it is pi-profile's own
 * or has been dispositioned away. Unrecognized entries (state an extension
 * created at runtime) get one of three dispositions per entry (ADR-0012):
 * content that references the instance dir's own path, exceeds the scan
 * budget, or is not a regular file/dir is kept and reported; position-
 * independent content is renamed into the real agent dir (adopted), or
 * deleted when the real agent dir already holds that name (real wins — the
 * conflict window means the instance copy is never the authority). The sweep
 * never destroys data it cannot attribute.
 *
 * Everything is best-effort: sweep errors never block a launch.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { MANAGED_INSTANCE_FILES, isCopiedResourceDir } from "../settings-generator.ts";
import { getInstancesRootDir } from "../workspace.ts";

/** Prefix of the directories this module owns under the instances root. */
const INSTANCE_DIR_PREFIX = "launch-";

/** Grace period for instance dirs without a (parseable) pid file. */
export const NO_PID_GRACE_MS = 10 * 60 * 1000;

/** Managed directories whose contents are not necessarily generated: a package
 *  may write its own files inside them (e.g. an extension's own config). */
const MANAGED_DIRS_WITH_RUNTIME_CONTENT = new Set(["extensions"]);

/** Content-scan budget for deciding whether an unrecognized entry is safe to
 *  adopt (ADR-0012). Over budget → undecidable → keep and warn. The values
 *  are implementation constants: the contract only fixes "over budget means
 *  keep". Exported for the tests that pin the over-budget behavior. */
export const SCAN_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const SCAN_MAX_FILES = 1024;

/** What the sweep does with one unrecognized entry in a candidate dir. */
type Disposition = "adopt" | "delete" | "keep-warn";

interface EntryDecision {
	/** Entry name relative to the instance dir. */
	name: string;
	disposition: Disposition;
}

export interface SweepResult {
	/** Warnings for directories intentionally kept. */
	warnings: string[];
	/** One-line notices for entries adopted into or deleted from a candidate. */
	notices: string[];
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is not signal-able by us: keep.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Scan budget shared across one entry's recursive content scan. */
interface ScanBudget {
	bytes: number;
	files: number;
	/** Set when a limit is hit or a member cannot be read: undecidable. */
	exceeded: boolean;
	/** Set when a member's bytes contain the instance dir's absolute path. */
	found: boolean;
}

async function scanContent(entryPath: string, instanceDir: string, budget: ScanBudget): Promise<void> {
	if (budget.exceeded || budget.found) return;
	let info;
	try {
		info = await lstat(entryPath);
	} catch {
		budget.exceeded = true; // Vanished or unreadable mid-scan: undecidable.
		return;
	}
	if (info.isDirectory()) {
		let members: string[];
		try {
			members = await readdir(entryPath);
		} catch {
			budget.exceeded = true;
			return;
		}
		for (const member of members) {
			await scanContent(path.join(entryPath, member), instanceDir, budget);
			if (budget.exceeded || budget.found) return;
		}
		return;
	}
	if (!info.isFile()) {
		// A socket/fifo/device member cannot be read: undecidable.
		budget.exceeded = true;
		return;
	}
	budget.files += 1;
	budget.bytes += info.size;
	if (budget.files > SCAN_MAX_FILES || budget.bytes > SCAN_MAX_TOTAL_BYTES) {
		budget.exceeded = true;
		return;
	}
	let content: Buffer;
	try {
		content = await readFile(entryPath);
	} catch {
		budget.exceeded = true;
		return;
	}
	if (content.includes(instanceDir)) budget.found = true;
}

/** Whether an unrecognized entry must be kept because its content scan says
 *  so: the content references the instance dir's own path (records like
 *  pi-subagents ledgers would break if moved), the scan could not finish
 *  within the budget, or the entry is not a regular file/dir. Only a clean
 *  negative scan makes the entry eligible for adoption (ADR-0012). */
export async function mustKeepByContentScan(entryPath: string, instanceDir: string): Promise<boolean> {
	let info;
	try {
		info = await lstat(entryPath);
	} catch {
		return true; // Vanished or unreadable: nothing to adopt.
	}
	if (!info.isFile() && !info.isDirectory()) return true; // socket/fifo etc.
	const budget: ScanBudget = { bytes: 0, files: 0, exceeded: false, found: false };
	await scanContent(entryPath, instanceDir, budget);
	// Keep unless the scan finished within budget and never saw the path.
	return budget.exceeded || budget.found;
}

/** Decides one top-level unrecognized entry: keep when the content scan is
 *  not a clean negative; otherwise real-wins on a name conflict, adopt when
 *  the real agent dir is free. A name lookup that fails for reasons other
 *  than absence is undecidable → keep. */
async function decideEntry(name: string, entryPath: string, instanceDir: string, agentDir: string): Promise<EntryDecision> {
	if (await mustKeepByContentScan(entryPath, instanceDir)) return { name, disposition: "keep-warn" };
	try {
		await lstat(path.join(agentDir, name));
		return { name, disposition: "delete" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { name, disposition: "adopt" };
		return { name, disposition: "keep-warn" };
	}
}

/** Unrecognized entry names inside a managed runtime-content directory
 *  (`extensions/`): reported at pi-profile's boundary, never adopted or
 *  deleted. `undefined` means the directory could not be inspected. */
async function unrecognizedNames(dir: string): Promise<string[] | undefined> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	const found: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		let linkStat;
		try {
			linkStat = await lstat(entryPath);
		} catch {
			continue; // Vanished under us: nothing to protect.
		}
		if (linkStat.isSymbolicLink()) continue;
		if (MANAGED_DIRS_WITH_RUNTIME_CONTENT.has(entry.name) && linkStat.isDirectory()) {
			const nested = await unrecognizedNames(entryPath);
			if (nested === undefined) {
				found.push(entry.name);
				continue;
			}
			found.push(...nested.map((name) => path.join(entry.name, name)));
			continue;
		}
		found.push(entry.name);
	}
	return found;
}

/** Decides every unrecognized entry in `dir`. `undefined` means the directory
 *  could not be inspected — the caller must treat that as unrecognized rather
 *  than as empty. */
async function classifyUnrecognized(dir: string, agentDir: string): Promise<EntryDecision[] | undefined> {
	let entries: Dirent<string>[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	const decisions: EntryDecision[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		let linkStat;
		try {
			linkStat = await lstat(entryPath);
		} catch {
			continue; // Vanished under us: nothing to protect.
		}
		// Symlinks only point at the real agent dir and hold no data of their own.
		if (linkStat.isSymbolicLink()) continue;
		// Materials this module copies in fresh on every launch: regenerated, never
		// adopted, so they are not third-party state to protect.
		if (isCopiedResourceDir(entry.name)) continue;
		if (!MANAGED_INSTANCE_FILES.has(entry.name)) {
			decisions.push(await decideEntry(entry.name, entryPath, dir, agentDir));
			continue;
		}
		if (MANAGED_DIRS_WITH_RUNTIME_CONTENT.has(entry.name) && linkStat.isDirectory()) {
			const nested = await unrecognizedNames(entryPath);
			if (nested === undefined) {
				decisions.push({ name: entry.name, disposition: "keep-warn" });
				continue;
			}
			for (const name of nested) decisions.push({ name: path.join(entry.name, name), disposition: "keep-warn" });
		}
	}
	return decisions;
}

/** Reclaims `dir` if it is both dead and free of unrecognized entries, after
 *  dispositioning those entries (ADR-0012). Appends notices for adopted and
 *  deleted entries to `notices`; returns the warnings for the cases where the
 *  directory was intentionally kept. */
async function sweepEntry(dir: string, agentDir: string, notices: string[]): Promise<string[]> {
	let pid: number | undefined;
	try {
		const raw = await readFile(path.join(dir, "pid"), "utf8");
		const parsed = Number.parseInt(raw.trim(), 10);
		if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
	} catch {
		// No pid file (or unreadable): fall through to the mtime guard.
	}

	if (pid !== undefined) {
		if (isProcessAlive(pid)) return [];
	} else {
		const info = await stat(dir);
		if (Date.now() - info.mtimeMs <= NO_PID_GRACE_MS) return [];
	}

	const decisions = await classifyUnrecognized(dir, agentDir);
	if (decisions === undefined) {
		return [
			`${dir} was not reclaimed: it could not be inspected (permissions?). Check its contents and delete it manually.`,
		];
	}

	const kept: string[] = [];
	for (const decision of decisions) {
		if (decision.disposition === "keep-warn") {
			kept.push(decision.name);
			continue;
		}
		const entryPath = path.join(dir, decision.name);
		if (decision.disposition === "adopt") {
			try {
				await rename(entryPath, path.join(agentDir, decision.name));
				notices.push(`adopted ${decision.name} from ${dir} into the real agent dir (${agentDir}); it is mirrored on the next launch`);
				continue;
			} catch {
				kept.push(decision.name); // Best-effort: keep rather than destroy.
				continue;
			}
		}
		// delete: the real agent dir already holds this name (real wins, no
		// content comparison — ADR-0012).
		try {
			await rm(entryPath, { recursive: true, force: true });
			notices.push(`deleted ${decision.name} from ${dir}: the real agent dir already holds that name`);
		} catch {
			kept.push(decision.name);
		}
	}

	if (kept.length > 0) {
		return [
			`${dir} was not reclaimed: it holds state pi-profile did not generate (${kept.join(", ")}). ` +
				`Move that state into the real agent dir (it is mirrored on the next launch), or point the extension that ` +
				`created it at a fixed path via that extension's own configuration, then delete ${dir}.`,
		];
	}

	await rm(dir, { recursive: true, force: true });
	return [];
}

/** Deletes stale instance dirs under the instances root and returns the
 *  warnings for directories it deliberately kept plus the notices for entries
 *  it adopted or deleted. `agentDir` is the real agent dir that adopted
 *  entries move into and name conflicts resolve against. Never throws. */
export async function sweepStaleInstances(agentDir: string): Promise<SweepResult> {
	const warnings: string[] = [];
	const notices: string[] = [];
	const root = getInstancesRootDir();

	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		entries = []; // No instances root yet: nothing to sweep.
	}

	for (const entry of entries) {
		// Only directories this module generated are candidates. Anything else
		// under the root — 0.4.x's per-profile dirs included — is not ours to
		// delete, and is left alone without a warning.
		if (!entry.startsWith(INSTANCE_DIR_PREFIX)) continue;
		const dir = path.join(root, entry);
		try {
			if (!(await stat(dir)).isDirectory()) continue;
			warnings.push(...(await sweepEntry(dir, agentDir, notices)));
		} catch {
			// Best-effort: one bad entry must not stop the sweep or the launch.
		}
	}

	return { warnings, notices };
}
