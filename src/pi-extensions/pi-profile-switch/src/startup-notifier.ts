/**
 * Startup notifier: best-effort startup notices for the pi-profile launcher.
 *
 * Two independent sources, checked once per Pi process launch and presented
 * through a caller-supplied NoticeSurface:
 *
 * - npm dist-tags: compare the running package version against the
 *   registry's installable `latest` dist-tag and remind once per target
 *   version (design decision 2: authority and cache).
 * - a single maintainer-reviewed `announcements.json` feed (design decision
 *   1: repository-hosted structured feed): show only applicable, unexpired,
 *   not-yet-shown announcements; an announcement requiring an upgrade
 *   replaces the ordinary reminder on that launch.
 *
 * Everything here is best-effort: expected network/offline failures return
 * normally, invalid remote content produces one bounded source-specific
 * diagnostic and never replaces a valid cache, and unexpected errors are
 * caught by the top-level `runStartupNotifications` and reported without
 * changing Pi's exit code. Remote checks are time- and size-bounded, honor
 * an external AbortSignal, and never write outside the global workspace
 * (`workspaceDir`, i.e. `getProfileSwitchDir()`).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./json-file.ts";

/** The single reviewed announcement feed (ADR-0014; fixed external address). */
export const ANNOUNCEMENTS_URL =
	"https://raw.githubusercontent.com/VincentFF/pi-profile-switch/main/announcements.json";

/** npm registry dist-tags; the installable stable version is read from
 *  top-level `latest`, never from the largest published version. */
const NPM_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/pi-profile-switch/dist-tags";

/** Hard ceiling on one remote check; the timer is unref'd so a pending
 *  check never keeps a short-lived Pi process alive. */
export const FETCH_TIMEOUT_MS = 5_000;

/** Remote results are refreshed at most once per day per source during
 *  normal operation; unsuccessful checks back off instead of requesting on
 *  every start. */
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 1;

/** One validated per-source response with its bookkeeping timestamps. The
 *  format is private and versioned: a corrupt or old file is safely
 *  replaced, never migrated. */
interface SourceCache<T> {
	schemaVersion: number;
	data?: T;
	lastSuccess: number;
	lastAttempt: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ANNOUNCEMENTS = 50;
const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 400;
const MAX_ACTION_LENGTH = 200;
const HISTORY_SCHEMA_VERSION = 1;

export interface NoticeSurface {
	display(message: string, level: "info" | "warning"): void;
}

export interface StartupNotifierOptions {
	/** The running package version, read from installed package metadata. */
	installedVersion: string;
	/** The global profile-switch dir; all state lives in its `notifications/`
	 *  subdirectory, shared across profiles and projects. */
	workspaceDir: string;
	/** Explicit offline mode (PI_OFFLINE): no remote request is initiated. */
	offline: boolean;
	surface: NoticeSurface;
	fetcher?: typeof fetch;
	now?: () => Date;
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// SemVer comparison (npm version semantics; no runtime dependency)
// ---------------------------------------------------------------------------

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | undefined {
	const match = SEMVER_PATTERN.exec(version);
	if (match === null) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split("."),
	};
}

/** SemVer precedence after npm's `latest` tag. Returns undefined when
 *  either version is malformed — callers must reject the data rather than
 *  fall back to lexical comparison. */
function compareVersions(a: string, b: string): number | undefined {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (left === undefined || right === undefined) return undefined;
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
	}
	const preA = left.prerelease;
	const preB = right.prerelease;
	if (preA.length === 0 && preB.length === 0) return 0;
	// A release outranks any of its prereleases.
	if (preA.length === 0) return 1;
	if (preB.length === 0) return -1;
	for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
		const x = preA[i];
		const y = preB[i];
		// A shorter prerelease list loses when it is a prefix of the longer.
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric && yNumeric) {
			if (x.length !== y.length) return x.length < y.length ? -1 : 1;
			if (x !== y) return x < y ? -1 : 1;
		} else if (xNumeric !== yNumeric) {
			// Numeric identifiers sort below alphanumeric ones.
			return xNumeric ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Remote content validation (the validator is authoritative for the shape)
// ---------------------------------------------------------------------------

/** Remote content was malformed or violates the feed limits. Distinct from
 *  network failures, which are expected offline and stay silent. */
class InvalidContentError extends Error {}

interface Announcement {
	id: string;
	message: string;
	action: string;
	expiresAt: string;
	requiresUpgrade: boolean;
	minInstalledVersion?: string;
	maxInstalledVersionExclusive?: string;
}

const ANNOUNCEMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function assertCleanText(value: unknown, field: string, maxLength: number): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new InvalidContentError(`${field} must be a non-empty string of at most ${maxLength} characters`);
	}
	for (const char of value) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) {
			throw new InvalidContentError(`${field} must not contain control characters`);
		}
	}
}

function parseAnnouncement(raw: unknown): Announcement {
	if (!isRecord(raw)) {
		throw new InvalidContentError("announcement entries must be objects");
	}
	assertCleanText(raw.id, "id", MAX_ID_LENGTH);
	if (!ANNOUNCEMENT_ID_PATTERN.test(raw.id)) {
		throw new InvalidContentError(`id must match ${ANNOUNCEMENT_ID_PATTERN}`);
	}
	assertCleanText(raw.message, "message", MAX_MESSAGE_LENGTH);
	assertCleanText(raw.action, "action", MAX_ACTION_LENGTH);
	if (typeof raw.expiresAt !== "string" || !EXPIRY_PATTERN.test(raw.expiresAt)) {
		throw new InvalidContentError("expiresAt must be an ISO 8601 date or timestamp");
	}
	if (!Number.isFinite(Date.parse(raw.expiresAt))) {
		throw new InvalidContentError(`expiresAt is not a real date: ${JSON.stringify(raw.expiresAt)}`);
	}
	const requiresUpgrade = raw.requiresUpgrade ?? false;
	if (typeof requiresUpgrade !== "boolean") {
		throw new InvalidContentError("requiresUpgrade must be a boolean");
	}
	const announcement: Announcement = {
		id: raw.id,
		message: raw.message,
		action: raw.action,
		expiresAt: raw.expiresAt,
		requiresUpgrade,
	};
	for (const field of ["minInstalledVersion", "maxInstalledVersionExclusive"] as const) {
		const bound = raw[field];
		if (bound === undefined) continue;
		if (typeof bound !== "string" || parseVersion(bound) === undefined) {
			throw new InvalidContentError(`${field} must be a valid SemVer version`);
		}
		announcement[field] = bound;
	}
	if (announcement.minInstalledVersion !== undefined && announcement.maxInstalledVersionExclusive !== undefined) {
		const order = compareVersions(announcement.minInstalledVersion, announcement.maxInstalledVersionExclusive);
		if (order === undefined || order >= 0) {
			throw new InvalidContentError("minInstalledVersion must be less than maxInstalledVersionExclusive");
		}
	}
	return announcement;
}

/** Validates the entire response before any of it is used; the whole feed is
 *  rejected on the first violation (duplicate ids, bad ranges/dates, control
 *  characters, oversized bodies, unknown schema versions). */
function parseFeed(text: string): Announcement[] {
	if (text.length > MAX_RESPONSE_BYTES) {
		throw new InvalidContentError(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new InvalidContentError("response is not valid JSON");
	}
	if (!isRecord(raw)) {
		throw new InvalidContentError("response must be a JSON object");
	}
	if (raw.schemaVersion !== 1) {
		throw new InvalidContentError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
	}
	if (!Array.isArray(raw.announcements) || raw.announcements.length > MAX_ANNOUNCEMENTS) {
		throw new InvalidContentError(`announcements must be an array of at most ${MAX_ANNOUNCEMENTS} entries`);
	}
	const seen = new Set<string>();
	return raw.announcements.map((entry) => {
		const announcement = parseAnnouncement(entry);
		if (seen.has(announcement.id)) {
			throw new InvalidContentError(`duplicate announcement id: ${announcement.id}`);
		}
		seen.add(announcement.id);
		return announcement;
	});
}

function parseNpmLatest(text: string): string {
	if (text.length > MAX_RESPONSE_BYTES) {
		throw new InvalidContentError(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new InvalidContentError("response is not valid JSON");
	}
	if (!isRecord(raw) || typeof raw.latest !== "string") {
		throw new InvalidContentError("missing latest");
	}
	const latest = raw.latest;
	if (parseVersion(latest) === undefined) {
		throw new InvalidContentError(`malformed latest version: ${JSON.stringify(latest)}`);
	}
	return latest;
}

// ---------------------------------------------------------------------------
// Global history
// ---------------------------------------------------------------------------

function notificationsDir(workspaceDir: string): string {
	return path.join(workspaceDir, "notifications");
}

async function readJsonQuiet(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
	await rename(tmp, file);
}

/** Displayed-history keys (`upgrade:<version>` / `announcement:<id>`),
 *  shared across profiles and projects. A missing or corrupt file means
 *  "nothing shown yet". */
async function readDisplayedKeys(dir: string): Promise<Set<string>> {
	const raw = await readJsonQuiet(path.join(dir, "displayed.json"));
	if (isRecord(raw) && raw.schemaVersion === HISTORY_SCHEMA_VERSION && Array.isArray(raw.keys)) {
		return new Set(raw.keys.filter((key): key is string => typeof key === "string"));
	}
	return new Set();
}

async function recordDisplayed(dir: string, key: string): Promise<void> {
	const keys = await readDisplayedKeys(dir);
	keys.add(key);
	await atomicWriteJson(path.join(dir, "displayed.json"), { schemaVersion: HISTORY_SCHEMA_VERSION, keys: [...keys] });
}

// ---------------------------------------------------------------------------
// Candidate evaluation and presentation
// ---------------------------------------------------------------------------

interface Candidate {
	key: string;
	message: string;
	level: "info" | "warning";
	requiresUpgrade: boolean;
}

function appliesToInstalledVersion(announcement: Announcement, installedVersion: string): boolean {
	// Missing bounds apply to all installed versions; a bound that cannot be
	// evaluated against the installed version excludes the announcement.
	if (announcement.minInstalledVersion !== undefined) {
		const comparison = compareVersions(installedVersion, announcement.minInstalledVersion);
		if (comparison === undefined || comparison < 0) return false;
	}
	if (announcement.maxInstalledVersionExclusive !== undefined) {
		const comparison = compareVersions(installedVersion, announcement.maxInstalledVersionExclusive);
		if (comparison === undefined || comparison >= 0) return false;
	}
	return true;
}

function collectCandidates(input: {
	announcements: Announcement[] | undefined;
	latest: string | undefined;
	installedVersion: string;
	nowMs: number;
	displayed: Set<string>;
}): Candidate[] {
	const candidates: Candidate[] = [];
	for (const announcement of input.announcements ?? []) {
		if (input.displayed.has(`announcement:${announcement.id}`)) continue;
		if (Date.parse(announcement.expiresAt) <= input.nowMs) continue;
		if (!appliesToInstalledVersion(announcement, input.installedVersion)) continue;
		candidates.push({
			key: `announcement:${announcement.id}`,
			message: `${announcement.message} — ${announcement.action}`,
			level: "info",
			requiresUpgrade: announcement.requiresUpgrade,
		});
	}
	let reminder: Candidate | undefined;
	if (input.latest !== undefined) {
		const comparison = compareVersions(input.latest, input.installedVersion);
		if (comparison !== undefined && comparison > 0 && !input.displayed.has(`upgrade:${input.latest}`)) {
			reminder = {
				key: `upgrade:${input.latest}`,
				message: `pi-profile-switch ${input.installedVersion} → ${input.latest}: upgrade with npm install -g pi-profile-switch`,
				level: "info",
				requiresUpgrade: false,
			};
		}
	}
	// An applicable upgrade-requiring announcement replaces the ordinary
	// reminder on this launch — and the suppressed target is NOT marked as
	// shown, so the reminder can fire on a later launch.
	if (reminder !== undefined && candidates.some((candidate) => candidate.requiresUpgrade)) {
		reminder = undefined;
	}
	return reminder === undefined ? candidates : [...candidates, reminder];
}

function report(surface: NoticeSurface, message: string): void {
	try {
		surface.display(message, "warning");
	} catch {
		// A broken surface must not break startup.
	}
}

async function present(dir: string, candidate: Candidate, surface: NoticeSurface, nowMs: number): Promise<void> {
	surface.display(candidate.message, candidate.level);
	await recordDisplayed(dir, candidate.key);
}

// ---------------------------------------------------------------------------
// Remote checks (bounded, cancellable, silent on expected failures)
// ---------------------------------------------------------------------------

async function fetchText(url: string, fetcher: typeof fetch, externalSignal: AbortSignal | undefined): Promise<string> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (externalSignal !== undefined) {
		if (externalSignal.aborted) controller.abort();
		else externalSignal.addEventListener("abort", onAbort, { once: true });
	}
	// Unref'd: a pending check never keeps a short-lived Pi process alive.
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	(timer as unknown as { unref?: () => void }).unref?.();
	try {
		const response = await fetcher(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		if (response.url) {
			const finalOrigin = new URL(response.url).origin;
			if (finalOrigin !== new URL(url).origin) {
				throw new Error(`redirected to a different origin: ${finalOrigin}`);
			}
		}
		return await response.text();
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onAbort);
	}
}

/** Fetch one source when its daily refresh interval or failure backoff
 *  allows. Invalid content and expected network/abort failures keep the
 *  previously validated cache — invalid content additionally yields exactly
 *  one bounded source-specific diagnostic; unexpected errors propagate to
 *  the top-level catch. */
async function refreshSource<T>(input: {
	dir: string;
	name: string;
	url: string;
	label: string;
	cache: SourceCache<T> | undefined;
	parse: (text: string) => T;
	fetcher: typeof fetch;
	surface: NoticeSurface;
	signal: AbortSignal | undefined;
	nowMs: number;
}): Promise<SourceCache<T> | undefined> {
	const { cache } = input;
	if (cache?.data !== undefined && input.nowMs - cache.lastSuccess < DAILY_REFRESH_MS) return cache;
	if (cache !== undefined && input.nowMs - cache.lastAttempt < FAILURE_BACKOFF_MS) return cache;
	const next: SourceCache<T> = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		data: cache?.data,
		lastSuccess: cache?.lastSuccess ?? 0,
		lastAttempt: input.nowMs,
	};
	const recordAttempt = async (): Promise<void> => {
		await atomicWriteJson(path.join(input.dir, `${input.name}.json`), next);
	};
	let text: string;
	try {
		text = await fetchText(input.url, input.fetcher, input.signal);
	} catch {
		// Offline, timeouts, aborts: expected failures stay silent.
		await recordAttempt();
		return cache;
	}
	try {
		next.data = input.parse(text);
		next.lastSuccess = input.nowMs;
		await recordAttempt();
		return next;
	} catch (error) {
		if (error instanceof InvalidContentError) {
			report(input.surface, `pi-profile: ${input.label} response invalid (${error.message}); keeping the last valid copy`);
			await recordAttempt();
			return cache;
		}
		throw error;
	}
}

function validateFeedData(data: unknown): { announcements: Announcement[] } | undefined {
	if (!isRecord(data) || !Array.isArray(data.announcements)) return undefined;
	try {
		return { announcements: data.announcements.map(parseAnnouncement) };
	} catch {
		return undefined;
	}
}

function validateNpmData(data: unknown): { latest: string } | undefined {
	if (!isRecord(data) || typeof data.latest !== "string" || parseVersion(data.latest) === undefined) return undefined;
	return { latest: data.latest };
}

async function readSourceCache<T>(
	dir: string,
	name: string,
	validate: (data: unknown) => T | undefined,
): Promise<SourceCache<T> | undefined> {
	const raw = await readJsonQuiet(path.join(dir, `${name}.json`));
	if (!isRecord(raw) || raw.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
	if (typeof raw.lastSuccess !== "number" || typeof raw.lastAttempt !== "number") return undefined;
	const cache: SourceCache<T> = {
		schemaVersion: CACHE_SCHEMA_VERSION,
		lastSuccess: raw.lastSuccess,
		lastAttempt: raw.lastAttempt,
	};
	if (raw.data !== undefined) {
		const data = validate(raw.data);
		if (data === undefined) return undefined;
		cache.data = data;
	}
	return cache;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the startup notification check exactly as specified by the launcher
 * delta: best-effort, never throwing, never blocking Pi's exit. Eligible
 * cached information is evaluated before remote checks complete.
 */
export async function runStartupNotifications(options: StartupNotifierOptions): Promise<void> {
	try {
		await run(options);
	} catch (error) {
		report(
			options.surface,
			`pi-profile: startup notification check failed (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

async function run(options: StartupNotifierOptions): Promise<void> {
	const fetcher = options.fetcher ?? fetch;
	const now = options.now ?? (() => new Date());
	const dir = notificationsDir(options.workspaceDir);
	const nowMs = now().getTime();
	const displayed = await readDisplayedKeys(dir);
	const feedCache = await readSourceCache<{ announcements: Announcement[] }>(dir, "announcements-feed", validateFeedData);
	const npmCache = await readSourceCache<{ latest: string }>(dir, "npm-latest", validateNpmData);

	let announcements = feedCache?.data;
	let latest = npmCache?.data;
	const evaluate = async (): Promise<void> => {
		const candidates = collectCandidates({
			announcements: announcements?.announcements,
			latest: latest?.latest,
			installedVersion: options.installedVersion,
			nowMs,
			displayed,
		});
		for (const candidate of candidates) {
			await present(dir, candidate, options.surface, nowMs);
			displayed.add(candidate.key);
		}
	};

	// Previously validated cached information is evaluated first, so a
	// short-lived process can display it without waiting for the network.
	await evaluate();

	if (!options.offline) {
		const refreshedFeed = await refreshSource<{ announcements: Announcement[] }>({
			dir,
			name: "announcements-feed",
			url: ANNOUNCEMENTS_URL,
			label: "announcements",
			cache: feedCache,
			parse: (text) => ({ announcements: parseFeed(text) }),
			fetcher,
			surface: options.surface,
			signal: options.signal,
			nowMs,
		});
		announcements = refreshedFeed?.data;
		await evaluate();
		const refreshedNpm = await refreshSource<{ latest: string }>({
			dir,
			name: "npm-latest",
			url: NPM_DIST_TAGS_URL,
			label: "npm registry",
			cache: npmCache,
			parse: (text) => ({ latest: parseNpmLatest(text) }),
			fetcher,
			surface: options.surface,
			signal: options.signal,
			nowMs,
		});
		latest = refreshedNpm?.data;
		await evaluate();
	}
}
