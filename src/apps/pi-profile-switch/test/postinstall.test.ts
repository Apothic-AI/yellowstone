/**
 * Starter profile seeding (install time): bin/postinstall.js writes the
 * shipped `examples/ask.json` starter to the profiles dir ONLY
 * when no .json profile exists — never overwriting user data,
 * never failing the install.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installDefaultProfiles, installProfileConfigSkill } from "../bin/postinstall.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-postinstall-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function envFor(dir: string): NodeJS.ProcessEnv {
	return { PI_PROFILE_SWITCH_DIR: dir };
}

describe("installDefaultProfiles", () => {
	it("writes the shipped starter profile when profiles directory is missing", async () => {
		const dir = path.join(root, "switch");

		const result = await installDefaultProfiles({ env: envFor(dir) });

		expect(result.written).toBe(true);
		const written = await readFile(path.join(dir, "profiles", "ask.json"), "utf8");
		const template = await readFile(path.resolve("examples/ask.json"), "utf8");
		expect(written).toBe(template);

		// The seeded profile is the read-only "ask" starter.
		const parsed = JSON.parse(written);
		expect(parsed.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(parsed.skills).toEqual([]);
		expect(parsed.extensions).toEqual([]);
	});

	it("writes starter profile when profiles directory exists but contains no .json files", async () => {
		const dir = path.join(root, "switch");
		await mkdir(path.join(dir, "profiles"), { recursive: true });
		await writeFile(path.join(dir, "profiles", "README.txt"), "some notes");

		const result = await installDefaultProfiles({ env: envFor(dir) });

		expect(result.written).toBe(true);
		expect(await readFile(path.join(dir, "profiles", "ask.json"), "utf8")).toBe(
			await readFile(path.resolve("examples/ask.json"), "utf8"),
		);
	});

	it("never overwrites an existing catalog (directory has at least one .json file)", async () => {
		const dir = path.join(root, "switch");
		await mkdir(path.join(dir, "profiles"), { recursive: true });
		const existingFile = path.join(dir, "profiles", "mine.json");
		await writeFile(existingFile, JSON.stringify({ tools: ["read"] }));

		const result = await installDefaultProfiles({ env: envFor(dir) });

		expect(result.written).toBe(false);
		expect(await readFile(existingFile, "utf8")).toBe(JSON.stringify({ tools: ["read"] }));
	});

	it("is idempotent: a second run writes nothing", async () => {
		const dir = path.join(root, "switch");

		const first = await installDefaultProfiles({ env: envFor(dir) });
		const second = await installDefaultProfiles({ env: envFor(dir) });

		expect(first.written).toBe(true);
		expect(second.written).toBe(false);
	});
});

describe("installProfileConfigSkill", () => {
	it("Scenario: First install - writes shipped skill when skills/profile-config does not exist", async () => {
		const agentDir = path.join(root, "agent");
		const shippedSkill = await readFile(path.resolve("skills/profile-config/SKILL.md"), "utf8");

		const result = await installProfileConfigSkill({ env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(result.written).toBe(true);
		expect(result.path).toBe(path.join(agentDir, "skills", "profile-config", "SKILL.md"));
		const installed = await readFile(result.path, "utf8");
		expect(installed).toBe(shippedSkill);
	});

	it("Scenario: Upgrade overwrite - overwrites existing skill when content differs", async () => {
		const agentDir = path.join(root, "agent");
		const targetDir = path.join(agentDir, "skills", "profile-config");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.join(targetDir, "SKILL.md"), "custom outdated content");

		const shippedSkill = await readFile(path.resolve("skills/profile-config/SKILL.md"), "utf8");

		const result = await installProfileConfigSkill({ env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(result.written).toBe(true);
		expect(result.path).toBe(path.join(targetDir, "SKILL.md"));
		const installed = await readFile(result.path, "utf8");
		expect(installed).toBe(shippedSkill);
	});

	it("Scenario: Distribution failure degrades to a warning - downgrades write failure to warning and does not throw", async () => {
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		// Create a regular file where the "skills" directory would be created, causing ENOTDIR
		await writeFile(path.join(agentDir, "skills"), "blocking file");

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await installProfileConfigSkill({ env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(result.written).toBe(false);
		expect(warnSpy).toHaveBeenCalled();
		expect(warnSpy.mock.calls.some((args) => args.some((arg) => String(arg).includes("pi-profile")))).toBe(true);
		warnSpy.mockRestore();
	});

	it("resolves PI_CODING_AGENT_DIR with ~ expansion", async () => {
		const tildeDir = await mkdtemp(path.join(homedir(), ".pi-profile-test-tilde-"));
		try {
			const subRel = path.relative(homedir(), tildeDir);
			const tildePath = `~/${subRel}`;
			const result = await installProfileConfigSkill({ env: { PI_CODING_AGENT_DIR: tildePath } });

			expect(result.written).toBe(true);
			expect(result.path).toBe(path.join(tildeDir, "skills", "profile-config", "SKILL.md"));
			expect(await readFile(result.path, "utf8")).toBe(
				await readFile(path.resolve("skills/profile-config/SKILL.md"), "utf8"),
			);
		} finally {
			await rm(tildeDir, { recursive: true, force: true });
		}
	});

	it("defaults agentDir to ~/.pi/agent when PI_CODING_AGENT_DIR is unset", async () => {
		const expectedTarget = path.join(homedir(), ".pi", "agent", "skills", "profile-config", "SKILL.md");
		const targetDir = path.dirname(expectedTarget);

		let previousContent: string | null = null;
		let targetExisted = false;
		let targetDirExisted = false;

		try {
			previousContent = await readFile(expectedTarget, "utf8");
			targetExisted = true;
			targetDirExisted = true;
		} catch {
			targetExisted = false;
			try {
				await stat(targetDir);
				targetDirExisted = true;
			} catch {
				targetDirExisted = false;
			}
		}

		try {
			const result = await installProfileConfigSkill({ env: {} });

			expect(result.written).toBe(true);
			expect(result.path).toBe(expectedTarget);
			expect(await readFile(result.path, "utf8")).toBe(
				await readFile(path.resolve("skills/profile-config/SKILL.md"), "utf8"),
			);
		} finally {
			if (targetExisted && previousContent !== null) {
				await writeFile(expectedTarget, previousContent, "utf8");
			} else if (targetDirExisted) {
				await rm(expectedTarget, { force: true });
			} else {
				await rm(targetDir, { recursive: true, force: true });
			}
		}
	});
});
