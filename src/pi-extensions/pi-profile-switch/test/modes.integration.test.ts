/**
 * Integration: non-interactive modes and flag passthrough (ticket 11).
 *
 * Text and JSON modes launch the requested profile with complete
 * pre-start filtering (mode handling is entirely native Pi); both exit
 * cleanly offline with stdin closed. Unknown profiles fail with exit 2 in
 * every mode. Session flags pass through unchanged (unit-covered in
 * launcher-args/launcher-spawn; here end-to-end for text mode).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher } from "./helpers/launcher-runner.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "review");
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "review.json"),
		JSON.stringify({ skills: ["review"] }),
	);
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("startup notifications in non-interactive modes", () => {
	const ownVersion = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")).version as string;
	const newerTarget = "99.0.0";

	async function seedLatestCache(): Promise<void> {
		const dir = path.join(fixture.profileSwitchDir, "notifications");
		await mkdir(dir, { recursive: true });
		const fresh = Date.now();
		await writeFile(
			path.join(dir, "npm-latest.json"),
			JSON.stringify({ schemaVersion: 1, data: { latest: newerTarget }, lastSuccess: fresh, lastAttempt: fresh }),
		);
		await writeFile(path.join(dir, "displayed.json"), JSON.stringify({ schemaVersion: 1, keys: [] }));
	}

	it("text mode writes the reminder to stderr only, leaving stdout native", async () => {
		await seedLatestCache();
		const result = await runLauncher(fixture, ["review", "--", "--mode", "text"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain(ownVersion);
		expect(result.stderr).toContain(newerTarget);
		expect(result.stderr).toContain("npm install -g pi-profile-switch");
		expect(result.stdout).not.toContain(newerTarget);
	}, 60_000);

	it("json mode keeps stdout parseable while the notice goes to stderr", async () => {
		await seedLatestCache();
		const result = await runLauncher(fixture, ["review", "--", "--mode", "json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain(newerTarget);
		for (const line of result.stdout.trim().split("\n")) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(result.stdout).not.toContain(newerTarget);
	}, 60_000);

	it("shows the reminder only once across named and default profile launches", async () => {
		await seedLatestCache();
		const first = await runLauncher(fixture, ["review", "--", "--mode", "text"]);
		expect(first.code).toBe(0);
		expect(first.stderr).toContain(newerTarget);
		// Second launch (default profile, same global workspace): the target
		// was already shown — no second reminder, in any profile.
		const second = await runLauncher(fixture, ["--", "--mode", "text"]);
		expect(second.code).toBe(0);
		expect(second.stderr).not.toContain(newerTarget);
	}, 60_000);
});

describe("non-interactive modes", () => {
	it("text mode launches the profile and exits cleanly", async () => {
		const result = await runLauncher(fixture, ["review", "--", "--mode", "text"]);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toMatch(/pi-profile:|Error/);
	}, 60_000);

	it("json mode launches the profile and emits the session event", async () => {
		const result = await runLauncher(fixture, ["review", "--", "--mode", "json"]);
		expect(result.code).toBe(0);
		const firstLine = result.stdout.trim().split("\n")[0] ?? "";
		expect(JSON.parse(firstLine).type).toBe("session");
	}, 60_000);

	it("session flags pass through unchanged in text mode", async () => {
		// --no-session must reach pi (a consumed flag would error the spawn or
		// be swallowed); combined with --mode text the process still exits 0.
		const result = await runLauncher(fixture, ["review", "--", "--mode", "text", "--no-session"]);
		expect(result.code).toBe(0);
	}, 60_000);

	it("unknown profiles fail with exit 2 in text mode too", async () => {
		const result = await runLauncher(fixture, ["ghost", "--", "--mode", "text"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/pi-profile:.*ghost/);
	}, 60_000);
});
