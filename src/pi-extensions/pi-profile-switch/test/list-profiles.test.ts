import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as jsonFile from "../src/json-file.ts";
import { ProfileCatalog } from "../src/profile-catalog.ts";
import { formatProfileList, listProfiles } from "../src/switching/list-profiles.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const input = () => ({ realAgentDir: fixture.agentDir, cwd: fixture.cwd });

async function writeGlobal(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function writeProject(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.cwd, ".pi", "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function trustProject(): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
}

describe("listProfiles", () => {
	it("lists the built-in default plus global profiles with their sources", async () => {
		await writeGlobal({ review: { label: "Code review" }, impl: { description: "Implementation" } });

		const entries = await listProfiles(input());

		expect(entries.map((entry) => `${entry.name}:${entry.source}`)).toContain("default:builtin");
		expect(entries.find((entry) => entry.name === "review")?.label).toBe("Code review");
	});

	it("shows project profiles only when trusted, with the winning source", async () => {
		await writeGlobal({ review: {}, shared: { label: "global shared" } });
		await writeProject({ proj: {}, shared: { label: "project shared" } });

		// Untrusted: only the global shared definition is visible.
		expect((await listProfiles(input())).map((entry) => entry.name).sort()).toEqual([
			"default",
			"review",
			"shared",
		]);

		await trustProject();
		const entries = await listProfiles(input());
		const shared = entries.find((entry) => entry.name === "shared");
		expect(shared?.source).toBe("project");
		expect(shared?.shadowsGlobal).toBe(true);
		expect(shared?.label).toBe("project shared");
	});
});

describe("formatProfileList", () => {
	it("marks the active profile and shadowing", () => {
		const text = formatProfileList(
			[
				{ name: "default", source: "builtin", shadowsGlobal: false, available: true },
				{ name: "shared", source: "project", label: "project shared", shadowsGlobal: true, available: true },
			],
			"shared",
		);

		expect(text).toContain("shared [project] (shadows global) — project shared ← active");
	});
});


describe("tolerant profile listing", () => {
	it("exposes unavailable errors and unknown-field warnings while preserving valid entries", async () => {
		await writeGlobal({ bad: { skills: 1 }, valid: { label: "Valid", unknownField: true } });
		const entries = await listProfiles(input());
		const file = path.join(fixture.profileSwitchDir, "profiles", "bad.json");
		expect(entries.find((entry) => entry.name === "bad")).toMatchObject({ available: false, error: expect.stringContaining(file) });
		expect(entries.find((entry) => entry.name === "valid")).toMatchObject({ available: true, warnings: [expect.stringContaining("unknownField")] });
		expect(formatProfileList(entries)).toContain(`unavailable: ${file}`);
		expect(formatProfileList(entries)).toContain("unknownField");
	});
	it("reports filename diagnostics through the callback without reading or attaching them to default", async () => {
		await writeGlobal({ default: {}, "bad name": {}, valid: {} });
		const diagnostics: string[] = [];
		const entries = await listProfiles({ ...input(), onDiagnostic: (message) => diagnostics.push(message) });
		expect(entries.map((entry) => entry.name)).toEqual(["default", "valid"]);
		expect(entries[0]?.warnings).toBeUndefined();
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics.join("\n")).toContain("default.json");
		expect(diagnostics.join("\n")).toContain("bad name.json");
	});
	it("loads once and never reads shadowed global contents", async () => {
		await writeGlobal({ shared: {} });
		await writeFile(path.join(fixture.profileSwitchDir, "profiles", "shared.json"), "{ bad");
		await writeProject({ shared: { label: "Winner" } });
		await trustProject();
		const load = vi.spyOn(ProfileCatalog, "load");
		const read = vi.spyOn(jsonFile, "readJsonFile");
		const entries = await listProfiles(input());
		expect(load).toHaveBeenCalledTimes(1);
		expect(entries.find((entry) => entry.name === "shared")).toMatchObject({ available: true, source: "project", shadowsGlobal: true });
		expect(read.mock.calls.map(([file]) => file)).not.toContain(path.join(fixture.profileSwitchDir, "profiles", "shared.json"));
	});
});
