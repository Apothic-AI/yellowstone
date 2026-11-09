/**
 * Startup notifier process contract: a pending remote check must never keep
 * a short-lived process alive (spec scenario "Slow network and short-lived
 * process"). A subprocess runs the real notifier with an injected fetch
 * that never completes; the cached notice must still be displayed from the
 * immediate evaluation, and the process must exit on its own.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOTIFIER_URL = pathToFileURL(path.resolve("src/startup-notifier.ts")).href;

let root: string;
let workspaceDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-notifier-proc-"));
	workspaceDir = path.join(root, "workspace");
	const dir = path.join(workspaceDir, "notifications");
	await mkdir(dir, { recursive: true });
	const now = Date.now();
	const stale = now - 25 * 60 * 60 * 1000;
	// A validated cached announcement (fresh: no refresh needed)…
	await writeFile(
		path.join(dir, "announcements-feed.json"),
		JSON.stringify({
			schemaVersion: 1,
			data: {
				announcements: [
					{
						id: "cached-notice",
						message: "Cached announcement from an earlier launch.",
						action: "No action needed.",
						expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
						requiresUpgrade: false,
					},
				],
			},
			lastSuccess: now,
			lastAttempt: now,
		}),
	);
	// …and a stale npm cache so the run initiates a remote check (the
	// injected never-completing fetch) after displaying the cache.
	await writeFile(
		path.join(dir, "npm-latest.json"),
		JSON.stringify({
			schemaVersion: 1,
			data: { latest: "99.0.0" },
			lastSuccess: stale,
			lastAttempt: stale,
		}),
	);
	await writeFile(path.join(dir, "displayed.json"), JSON.stringify({ schemaVersion: 1, keys: [] }));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface SubprocessResult {
	code: number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

/** Runs a short-lived node subprocess that starts the notifier with a
 *  never-completing fetch and deliberately does not await it. */
function runNotifierSubprocess(workspace: string): Promise<SubprocessResult> {
	const script = `
		import { runStartupNotifications } from ${JSON.stringify(NOTIFIER_URL)};
		runStartupNotifications({
			installedVersion: "0.0.1",
			workspaceDir: ${JSON.stringify(workspace)},
			offline: false,
			surface: { display: (message) => process.stderr.write(message + "\\n") },
			// Never completes and never observes abort: the worst case for
			// process exit. The notifier must not wait for it.
			fetcher: () => new Promise(() => {}),
		});
	`;
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("subprocess with a pending check did not exit")), 20_000);
		timer.unref();
		execFile(
			process.execPath,
			["--input-type=module", "--eval", script],
			{ cwd: path.resolve("."), timeout: 20_000 },
			(error, stdout, stderr) => {
				clearTimeout(timer);
				resolve({
					code: (error as { code?: number } | null)?.code ?? 0,
					stdout,
					stderr,
					elapsedMs: Date.now() - started,
				});
			},
		);
	});
}

describe("startup notifier process contract", () => {
	it("displays cached notices and exits without waiting for a pending check", async () => {
		const result = await runNotifierSubprocess(workspaceDir);
		expect(result.code).toBe(0);
		expect(result.elapsedMs).toBeLessThan(15_000);
		// Cached information was evaluated immediately: both the cached
		// announcement and the cached upgrade reminder are displayed…
		expect(result.stderr).toContain("Cached announcement from an earlier launch.");
		expect(result.stderr).toContain("0.0.1 → 99.0.0");
		// …and nothing leaked to stdout (notices are stderr-only outside the TUI).
		expect(result.stdout).not.toContain("Cached announcement");
		// The whole presentation path completed before exit: both notices are
		// recorded in the shared history.
		const history = JSON.parse(
			await readFile(path.join(workspaceDir, "notifications", "displayed.json"), "utf8"),
		) as { keys: string[] };
		expect(history.keys).toContain("announcement:cached-notice");
		expect(history.keys).toContain("upgrade:99.0.0");
		// The validated feed cache is untouched by the abandoned check.
		const feed = JSON.parse(
			await readFile(path.join(workspaceDir, "notifications", "announcements-feed.json"), "utf8"),
		) as { data: { announcements: Array<{ id: string }> } };
		expect(feed.data.announcements.map((entry) => entry.id)).toEqual(["cached-notice"]);
	});
});
