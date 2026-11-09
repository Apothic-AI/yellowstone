/**
 * Tests for runtime ensure of starter assets (src/starter-assets.ts).
 * Validates spec delta scenarios for "Seeding the starter profile" and "Distributing the profile-config skill".
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureStarterAssets } from "../src/starter-assets.ts";

let root: string;
let globalProfilesDir: string;
let agentDir: string;

const SHIPPED_ASK_PATH = path.resolve("examples/ask.json");
const SHIPPED_SKILL_PATH = path.resolve("skills/profile-config/SKILL.md");

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-starter-assets-"));
	globalProfilesDir = path.join(root, "switch", "profiles");
	agentDir = path.join(root, "agent");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("ensureStarterAssets - Seeding the starter profile", () => {
	it("Scenario: Backfill at startup - writes starter profile ask.json when profiles directory is missing", async () => {
		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.profile.written).toBe(true);
		expect(result.profile.path).toBe(path.join(globalProfilesDir, "ask.json"));

		const writtenContent = await readFile(result.profile.path, "utf8");
		const templateContent = await readFile(SHIPPED_ASK_PATH, "utf8");
		expect(writtenContent).toBe(templateContent);
		expect(result.warnings).toEqual([]);
	});

	it("Scenario: Backfill at startup - writes starter profile when profiles directory has no .json files", async () => {
		await mkdir(globalProfilesDir, { recursive: true });
		await writeFile(path.join(globalProfilesDir, "notes.txt"), "no profiles yet");

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.profile.written).toBe(true);
		expect(result.profile.path).toBe(path.join(globalProfilesDir, "ask.json"));
		const writtenContent = await readFile(result.profile.path, "utf8");
		const templateContent = await readFile(SHIPPED_ASK_PATH, "utf8");
		expect(writtenContent).toBe(templateContent);
	});

	it("Scenario: No overwrite at startup - does not write when a .json profile already exists", async () => {
		await mkdir(globalProfilesDir, { recursive: true });
		const customProfile = path.join(globalProfilesDir, "custom.json");
		await writeFile(customProfile, JSON.stringify({ tools: ["read"] }));

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.profile.written).toBe(false);
		expect(result.profile.path).toBe(path.join(globalProfilesDir, "ask.json"));
		// Custom profile untouched, ask.json not created
		expect(await readFile(customProfile, "utf8")).toBe(JSON.stringify({ tools: ["read"] }));
		await expect(readFile(path.join(globalProfilesDir, "ask.json"))).rejects.toThrow();
	});

	it("Scenario: No overwrite at startup - idempotent across multiple runs", async () => {
		const first = await ensureStarterAssets({ globalProfilesDir, agentDir });
		expect(first.profile.written).toBe(true);

		const second = await ensureStarterAssets({ globalProfilesDir, agentDir });
		expect(second.profile.written).toBe(false);
	});

	it("Scenario: Startup seeding failure degrades to a warning - downgrades write failure to warning and does not throw", async () => {
		await mkdir(path.dirname(globalProfilesDir), { recursive: true });
		// Block profiles directory creation with a regular file
		await writeFile(globalProfilesDir, "blocking file");

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.profile.written).toBe(false);
		expect(result.profile.path).toBe(path.join(globalProfilesDir, "ask.json"));
		expect(result.warnings.length).toBeGreaterThanOrEqual(1);
		expect(result.warnings.some((w) => w.includes("starter profile"))).toBe(true);
	});
});

describe("ensureStarterAssets - Distributing the profile-config skill", () => {
	it("Scenario: Backfill or sync at startup (backfill) - writes shipped skill when SKILL.md does not exist", async () => {
		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.skill.written).toBe(true);
		expect(result.skill.path).toBe(path.join(agentDir, "skills", "profile-config", "SKILL.md"));

		const writtenContent = await readFile(result.skill.path, "utf8");
		const templateContent = await readFile(SHIPPED_SKILL_PATH, "utf8");
		expect(writtenContent).toBe(templateContent);
		expect(result.warnings).toEqual([]);
	});

	it("Scenario: Backfill or sync at startup (sync) - overwrites existing skill when content differs", async () => {
		const skillDir = path.join(agentDir, "skills", "profile-config");
		await mkdir(skillDir, { recursive: true });
		const targetFile = path.join(skillDir, "SKILL.md");
		await writeFile(targetFile, "outdated skill content");

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.skill.written).toBe(true);
		expect(result.skill.path).toBe(targetFile);

		const writtenContent = await readFile(targetFile, "utf8");
		const templateContent = await readFile(SHIPPED_SKILL_PATH, "utf8");
		expect(writtenContent).toBe(templateContent);
	});

	it("Scenario: Content already in sync at startup - does not write when content is already identical", async () => {
		const skillDir = path.join(agentDir, "skills", "profile-config");
		await mkdir(skillDir, { recursive: true });
		const targetFile = path.join(skillDir, "SKILL.md");
		const templateContent = await readFile(SHIPPED_SKILL_PATH, "utf8");
		await writeFile(targetFile, templateContent);

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.skill.written).toBe(false);
		expect(result.skill.path).toBe(targetFile);
	});

	it("Scenario: Startup distribution failure degrades to a warning - downgrades write failure to warning and does not throw", async () => {
		await mkdir(agentDir, { recursive: true });
		// Block skills directory with a regular file
		await writeFile(path.join(agentDir, "skills"), "blocking file");

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.skill.written).toBe(false);
		expect(result.skill.path).toBe(path.join(agentDir, "skills", "profile-config", "SKILL.md"));
		expect(result.warnings.length).toBeGreaterThanOrEqual(1);
		expect(result.warnings.some((w) => w.includes("profile-config skill"))).toBe(true);
	});
});

describe("ensureStarterAssets - independent outcomes", () => {
	it("profile failure does not prevent skill distribution from succeeding", async () => {
		await mkdir(path.dirname(globalProfilesDir), { recursive: true });
		await writeFile(globalProfilesDir, "blocking file");

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.profile.written).toBe(false);
		expect(result.skill.written).toBe(true);
		expect(await readFile(result.skill.path, "utf8")).toBe(await readFile(SHIPPED_SKILL_PATH, "utf8"));
		expect(result.warnings.some((w) => w.includes("starter profile"))).toBe(true);
	});

	it("skill failure does not prevent profile seeding from succeeding", async () => {
		await mkdir(agentDir, { recursive: true });
		await writeFile(path.join(agentDir, "skills"), "blocking file");

		const result = await ensureStarterAssets({ globalProfilesDir, agentDir });

		expect(result.profile.written).toBe(true);
		expect(result.skill.written).toBe(false);
		expect(await readFile(result.profile.path, "utf8")).toBe(await readFile(SHIPPED_ASK_PATH, "utf8"));
		expect(result.warnings.some((w) => w.includes("profile-config skill"))).toBe(true);
	});
});
