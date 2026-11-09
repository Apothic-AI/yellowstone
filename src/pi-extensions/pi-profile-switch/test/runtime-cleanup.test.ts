import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	mustKeepByContentScan,
	NO_PID_GRACE_MS,
	SCAN_MAX_FILES,
	sweepStaleInstances,
} from "../src/launcher/runtime-cleanup.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function instancesRoot(): string {
	return path.join(fixture.profileSwitchDir, "instances");
}

async function makeInstanceDir(
	name: string,
	options: { pid?: number; mtimeAgeMs?: number } = {},
): Promise<string> {
	const dir = path.join(instancesRoot(), name);
	await mkdir(dir, { recursive: true });
	if (options.pid !== undefined) {
		await writeFile(path.join(dir, "pid"), String(options.pid));
	}
	if (options.mtimeAgeMs !== undefined) {
		const past = new Date(Date.now() - options.mtimeAgeMs);
		await utimes(dir, past, past);
	}
	return dir;
}

/** Spawns a child that exits immediately and returns its (now dead) pid. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""]);
	await new Promise<void>((resolve) => child.on("exit", () => resolve()));
	if (child.pid === undefined) throw new Error("child pid missing");
	return child.pid;
}

describe("mustKeepByContentScan", () => {
	it("keeps content that references the instance dir path", async () => {
		const dir = await makeInstanceDir("launch-scan", { pid: await deadPid() });
		const entry = path.join(dir, "ledger.json");
		await writeFile(entry, JSON.stringify({ recordPath: entry, ownerSessionId: `${dir}/sessions/x` }));

		await expect(mustKeepByContentScan(entry, dir)).resolves.toBe(true);
	});

	it("clears content that does not reference the instance dir path", async () => {
		const dir = await makeInstanceDir("launch-scan-clear", { pid: await deadPid() });
		const entry = path.join(dir, "mcp-cache.json");
		await writeFile(entry, JSON.stringify({ cache: "no path inside" }));

		await expect(mustKeepByContentScan(entry, dir)).resolves.toBe(false);
	});

	it("treats a directory over the scan budget as undecidable and keeps it", async () => {
		const dir = await makeInstanceDir("launch-scan-big", { pid: await deadPid() });
		const entry = path.join(dir, "blob");
		await mkdir(entry, { recursive: true });
		for (let i = 0; i < SCAN_MAX_FILES + 1; i++) {
			await writeFile(path.join(entry, `part-${i}`), "x");
		}

		await expect(mustKeepByContentScan(entry, dir)).resolves.toBe(true);
	});

	it("keeps non-regular entries such as sockets or fifos", async () => {
		const dir = await makeInstanceDir("launch-scan-type", { pid: await deadPid() });
		try {
			execFileSync("mkfifo", [path.join(dir, "pipe")]);
		} catch {
			return; // No mkfifo on this platform: nothing to assert against.
		}

		await expect(mustKeepByContentScan(path.join(dir, "pipe"), dir)).resolves.toBe(true);
	});
});

describe("sweepStaleInstances", () => {
	it("reclaims an instance dir whose pid is dead", async () => {
		const stale = await makeInstanceDir("launch-dead", { pid: await deadPid() });

		const result = await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(stale)).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(result.notices).toEqual([]);
	});

	it("reclaims an instance whose extensions entry is a symlink without touching its target", async () => {
		const dir = await makeInstanceDir("launch-extlink", { pid: await deadPid() });
		await mkdir(path.join(fixture.agentDir, "extensions"), { recursive: true });
		const real = path.join(fixture.agentDir, "extensions", "keep.ts");
		await writeFile(real, "real bytes");
		await symlink(path.join(fixture.agentDir, "extensions"), path.join(dir, "extensions"), "dir");

		const result = await sweepStaleInstances(fixture.agentDir);

		// The link is unlinked with the instance; the real target is never traversed.
		expect(existsSync(dir)).toBe(false);
		expect(await readFile(real, "utf8")).toBe("real bytes");
		expect(result.warnings).toEqual([]);
	});

	it("keeps an instance dir whose pid is alive", async () => {
		const live = await makeInstanceDir("launch-live", { pid: process.pid });

		await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(live)).toBe(true);
	});

	it("reclaims an instance dir without a pid file once past the grace window", async () => {
		const old = await makeInstanceDir("launch-old", { mtimeAgeMs: NO_PID_GRACE_MS + 60_000 });

		await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(old)).toBe(false);
	});

	it("keeps an instance dir without a pid file inside the grace window (concurrent-launch race)", async () => {
		const fresh = await makeInstanceDir("launch-fresh");

		await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(fresh)).toBe(true);
	});

	it("reclaims an instance dir whose pid file is unparseable once past the grace window", async () => {
		// Write the pid file before backdating: writing into a dir refreshes its mtime.
		const dir = path.join(instancesRoot(), "launch-garbage");
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "pid"), "not-a-pid");
		const past = new Date(Date.now() - NO_PID_GRACE_MS - 60_000);
		await utimes(dir, past, past);

		await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(dir)).toBe(false);
	});

	it("resolves to no warnings when the instances root does not exist", async () => {
		await rm(instancesRoot(), { recursive: true, force: true });

		await expect(sweepStaleInstances(fixture.agentDir)).resolves.toEqual({ warnings: [], notices: [] });
	});

	it("ignores entries that are not launch dirs", async () => {
		const keep = await makeInstanceDir(path.join("impl", "agent"), { pid: await deadPid() });
		const other = await makeInstanceDir("notes", { pid: await deadPid() });

		const result = await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(keep)).toBe(true);
		expect(existsSync(other)).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("keeps an instance dir whose unrecognized state references the instance path, and warns", async () => {
		const dir = await makeInstanceDir("launch-wild", { pid: await deadPid() });
		const record = path.join(dir, "missions", "projects", "record.json");
		await mkdir(path.dirname(record), { recursive: true });
		await writeFile(record, JSON.stringify({ recordPath: record }));

		const result = await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(dir)).toBe(true);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain(dir);
		expect(result.warnings[0]).toContain("missions");
		expect(result.notices).toEqual([]);
	});

	it("adopts an unrecognized entry into the real agent dir, then reclaims the dir", async () => {
		const dir = await makeInstanceDir("launch-adopt", { pid: await deadPid() });
		await writeFile(path.join(dir, "mcp-cache.json"), JSON.stringify({ cache: "no path inside" }));

		const result = await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(dir)).toBe(false);
		expect(JSON.parse(await readFile(path.join(fixture.agentDir, "mcp-cache.json"), "utf8"))).toEqual({
			cache: "no path inside",
		});
		expect(result.warnings).toEqual([]);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toContain("mcp-cache.json");
		expect(result.notices[0]).toContain(fixture.agentDir);
	});

	it("deletes an instance-local copy when the real agent dir already holds the name (real wins), and notices", async () => {
		// The seed creates <agentDir>/missions, so this instance-local real dir
		// is a same-name conflict: deleted, not compared, not kept (ADR-0012).
		await mkdir(path.join(fixture.agentDir, "missions"), { recursive: true });
		const dir = await makeInstanceDir("launch-local", { pid: await deadPid() });
		await mkdir(path.join(dir, "missions"), { recursive: true });

		const result = await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(dir)).toBe(false);
		expect(result.warnings).toEqual([]);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0]).toContain("missions");
	});

	it("reports state written inside a managed directory without adopting or deleting it", async () => {
		const dir = await makeInstanceDir("launch-managed", { pid: await deadPid() });
		await mkdir(path.join(dir, "extensions", "subagent"), { recursive: true });
		await writeFile(path.join(dir, "extensions", "subagent", "config.json"), "{}");

		const result = await sweepStaleInstances(fixture.agentDir);

		expect(existsSync(dir)).toBe(true);
		expect(existsSync(path.join(dir, "extensions", "subagent", "config.json"))).toBe(true);
		// The unrecognized entry is reported at the boundary of what pi-profile
		// generated, not per file inside it.
		expect(result.warnings[0]).toContain(path.join("extensions", "subagent"));
		expect(result.notices).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)("keeps a dir it cannot inspect and still reclaims the others", async () => {
		const unreadable = await makeInstanceDir("launch-unreadable", {
			mtimeAgeMs: NO_PID_GRACE_MS + 60_000,
		});
		const dead = await makeInstanceDir("launch-other-dead", { pid: await deadPid() });
		await chmod(unreadable, 0o000);

		try {
			const result = await sweepStaleInstances(fixture.agentDir);

			expect(existsSync(unreadable)).toBe(true);
			expect(existsSync(dead)).toBe(false);
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain(unreadable);
		} finally {
			await chmod(unreadable, 0o700);
		}
	});
});
