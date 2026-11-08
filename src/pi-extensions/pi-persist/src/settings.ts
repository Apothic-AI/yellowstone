import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Settings for this extension, read from pi's own `settings.json`.
 *
 * Pi's settings schema declares `additionalProperties: true`, so a namespaced key survives
 * validation and is visible through `pi.getSettings()`. That keeps configuration in one file
 * rather than inventing another, at the cost of not appearing in `/settings` — pi 1.4 offers no
 * way for an extension to contribute a row there.
 *
 * The `piPersist` namespace holds the on/off switch. It is written back to the same file, so the
 * state survives a `/reload` and the next session.
 */
export const SETTINGS_KEY = "piPersist";

export interface PersistSettings {
	/**
	 * Whether the extension injects context into requests. On unless a switch says otherwise.
	 */
	readonly enabled: boolean;
}

export const DEFAULT_SETTINGS: PersistSettings = { enabled: true };

/**
 * Pi's `Settings` type declares no index signature for extension keys, so the value is cast at the
 * boundary rather than widening our own signature to accept anything.
 */
type SettingsSource = object | undefined;

/** Coerce the namespaced block. Unknown keys are ignored; a malformed block degrades to defaults. */
export function readPersistSettings(settings: SettingsSource): PersistSettings {
	const raw = settings ? (settings as Record<string, unknown>)[SETTINGS_KEY] : undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
	const enabled = (raw as Record<string, unknown>).enabled;
	// A value that is not a boolean is ignored rather than coerced: "off" is not a switch.
	return { enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SETTINGS.enabled };
}

/**
 * Fallback settings reader for callers that have no `pi` handle — the CLI, tests, and any future
 * non-pi host. Mirrors what pi's settings manager does: read `<agent-dir>/settings.json`.
 */
export function readSettingsFromDisk(agentDir = getAgentDir()): PersistSettings {
	try {
		const parsed: unknown = JSON.parse(readFileSync(resolve(agentDir, "settings.json"), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS };
		return readPersistSettings(parsed as Record<string, unknown>);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** Pi's own settings file. The extension's settings live in it, under the `piPersist` namespace. */
export function settingsFilePath(agentDir = getAgentDir()): string {
	return resolve(agentDir, "settings.json");
}

/**
 * Write the switch into pi's settings file.
 *
 * The file belongs to pi: it merges the global and project layers, and rewrites the global one
 * whenever a setting changes. So this is a read-modify-write under the lock pi uses — a
 * `<file>.lock` directory created with `mkdir` — and it touches nothing outside the `piPersist`
 * namespace. Pi re-reads the file under that lock and merges only the fields it changed, so the
 * two writers do not overwrite each other.
 *
 * The write itself is atomic: a temporary file next to the target, renamed into place, so a
 * reader never sees half a settings file.
 *
 * A settings file that cannot be parsed is left alone. Replacing it would drop every other
 * setting the operator has, which is a far worse failure than a switch that does not save.
 */
export async function setPersistEnabled(enabled: boolean, agentDir = getAgentDir()): Promise<PersistSettings> {
	const path = settingsFilePath(agentDir);
	await withSettingsLock(path, async () => {
		const current = await readSettingsObject(path);
		const namespace = current[SETTINGS_KEY];
		const merged: Record<string, unknown> =
			namespace && typeof namespace === "object" && !Array.isArray(namespace)
				? { ...(namespace as Record<string, unknown>) }
				: {};
		merged.enabled = enabled;
		current[SETTINGS_KEY] = merged;
		await writeSettingsObject(path, current);
	});
	return { enabled };
}

/** Read the settings object, or fail loudly rather than clobbering a file that cannot be parsed. */
async function readSettingsObject(path: string): Promise<Record<string, unknown>> {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${path}: ${describe(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${describe(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path} does not hold a settings object`);
	}
	return parsed as Record<string, unknown>;
}

/** Write the settings object atomically: a temporary file next to the target, renamed into place. */
async function writeSettingsObject(path: string, settings: Record<string, unknown>): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${basename(path)}.pi-persist-${process.pid}.tmp`);
	try {
		await writeFile(temp, JSON.stringify(settings, null, 2), "utf8");
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
}

/** How long a lock stays fresh. Pi's own settings lock uses the same window. */
const LOCK_STALE_MS = 10_000;
/** How long to wait for the lock before giving up. */
const LOCK_WAIT_MS = 2_000;
/** How long to wait between attempts. */
const LOCK_RETRY_MS = 20;

/**
 * Run `fn` while holding the lock on a settings file.
 *
 * Pi locks a settings file by creating a `<file>.lock` directory with `mkdir`, which is atomic:
 * the writer whose `mkdir` succeeds owns the file. The lock goes stale after ten seconds without
 * a touch, so a crashed writer cannot block the file forever — the same rule pi's own writer
 * applies when it finds a lock directory in the way.
 */
async function withSettingsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true });
	await acquireLock(lockPath);
	try {
		return await fn();
	} finally {
		await releaseLock(lockPath);
	}
}

async function acquireLock(lockPath: string): Promise<void> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			await mkdir(lockPath);
			return;
		} catch (error) {
			if (!isEexist(error)) throw error;
			if (await isStaleLock(lockPath)) {
				// The holder is gone. Take the lock over, exactly as pi's own writer does.
				await releaseLock(lockPath);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`${lockPath} is held by another writer`);
			await sleep(LOCK_RETRY_MS);
		}
	}
}

async function releaseLock(lockPath: string): Promise<void> {
	try {
		await rmdir(lockPath);
	} catch {
		// Already released, or taken over after a stale steal. Nothing to undo.
	}
}

async function isStaleLock(lockPath: string): Promise<boolean> {
	try {
		const info = await stat(lockPath);
		return info.mtime.getTime() < Date.now() - LOCK_STALE_MS;
	} catch {
		// The lock vanished between the mkdir and the stat; the next attempt wins it.
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEexist(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
