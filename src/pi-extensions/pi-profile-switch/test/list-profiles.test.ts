import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as jsonFile from "../src/json-file.ts";
import { ProfileCatalog } from "../src/profile-catalog.ts";
import type { ProfileComposition } from "../src/profile-composition.ts";
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


describe("formatProfileList composed guard", () => {
	const composed: ProfileComposition = {
		strategy: "append",
		branch: "composed",
		projectPath: "/project/.pi/profiles/leader.json",
		referenceContributors: { skills: {}, extensions: {}, mcps: {}, tools: {} },
		unapplied: [],
		diagnostics: [],
	};

	it("never renders the shadow claim for a composed entry, even if a caller sets it", () => {
		const text = formatProfileList([
			{ name: "leader", source: "project", shadowsGlobal: true, available: true, composition: composed },
		]);
		expect(text).toContain("leader [project] (append composition)");
		expect(text).not.toContain("shadows global");
	});

	it("still renders the shadow claim for a replacement entry with no composition", () => {
		const text = formatProfileList([
			{ name: "leader", source: "project", shadowsGlobal: true, available: true },
		]);
		expect(text).toContain("leader [project] (shadows global)");
		expect(text).not.toContain("append");
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

describe("composition marking (FT54 S2 §3.4)", () => {
	it("marks a composing winner from its own resolved metadata, reading no unrelated definition", async () => {
		await writeGlobal({ leader: { skills: ["alpha"] }, other: { label: "other" } });
		await writeProject({ leader: { promptStrategy: "append", skills: ["beta"] } });
		await trustProject();
		const read = vi.spyOn(jsonFile, "readJsonFile");
		const entries = await listProfiles(input());
		const leader = entries.find((entry) => entry.name === "leader");

		expect(leader?.composition).toMatchObject({ strategy: "append", branch: "composed" });
		// A composed append composes with the base; it does not shadow it.
		expect(leader?.shadowsGlobal).toBe(false);
		expect(formatProfileList(entries)).toContain("leader [project] (append composition)");
		expect(formatProfileList(entries)).not.toContain("shadows global");

		const count = (file: string) => read.mock.calls.filter(([called]) => called === file).length;
		// One read per listed profile plus the one append base: the mark never
		// opens another profile's definition.
		expect(count(path.join(fixture.profileSwitchDir, "profiles", "leader.json"))).toBe(1);
		expect(count(path.join(fixture.cwd, ".pi", "profiles", "leader.json"))).toBe(1);
		expect(count(path.join(fixture.profileSwitchDir, "profiles", "other.json"))).toBe(1);
	});

	it("marks a standalone append as its own branch without reading a missing base", async () => {
		await writeProject({ solo: { promptStrategy: "append", skills: ["alpha"] } });
		await trustProject();
		const read = vi.spyOn(jsonFile, "readJsonFile");
		const entries = await listProfiles(input());
		const solo = entries.find((entry) => entry.name === "solo");

		expect(solo?.composition).toMatchObject({ strategy: "append", branch: "standalone" });
		expect(solo?.composition?.globalPath).toBeUndefined();
		expect(formatProfileList(entries)).toContain("solo [project] (append, standalone)");
		expect(read.mock.calls.map(([file]) => file)).not.toContain(
			path.join(fixture.profileSwitchDir, "profiles", "solo.json"),
		);
	});
});

/**
 * SI S2 review finding — list semantics for a composed `append`.
 *
 * Every case below loads a real `ProfileCatalog` from fixture files and asserts
 * the rendered list, so the set (`shadowsGlobal`) and the render are proven
 * together rather than through hand-built entries.
 */
describe("composed append list semantics (SI S2 finding)", () => {
	it("does not claim a composing append shadows its global base", async () => {
		await writeGlobal({ leader: { skills: ["alpha"], label: "global leader" } });
		await writeProject({ leader: { promptStrategy: "append", skills: ["beta"] } });
		await trustProject();

		const entries = await listProfiles(input());
		const leader = entries.find((entry) => entry.name === "leader");
		const text = formatProfileList(entries);

		expect(leader).toMatchObject({ source: "project", available: true, shadowsGlobal: false });
		expect(leader?.composition?.branch).toBe("composed");
		// The composed label proves the entry came from the global base, i.e. a
		// real composition, not a standalone or a replacement.
		expect(leader?.label).toBe("global leader");
		expect(text).toContain("leader [project] (append composition) — global leader");
		expect(text).not.toContain("shadows global");
	});

	it("keeps the shadowing claim for a replacement project winner", async () => {
		await writeGlobal({ leader: { skills: ["alpha"], label: "global leader" } });
		await writeProject({ leader: { skills: ["beta"] } });
		await trustProject();

		const entries = await listProfiles(input());
		const leader = entries.find((entry) => entry.name === "leader");
		const text = formatProfileList(entries);

		expect(leader).toMatchObject({ source: "project", available: true, shadowsGlobal: true });
		expect(leader?.composition).toBeUndefined();
		// A replacement winner replaces the entry: the global label is not inherited.
		expect(leader?.label).toBeUndefined();
		expect(text).toContain("leader [project] (shadows global)");
		expect(text).not.toContain("append composition");
	});

	it("keeps an unavailable composed pair unavailable and shadowing, never rendered as composing", async () => {
		const globalDir = path.join(fixture.profileSwitchDir, "profiles");
		await mkdir(globalDir, { recursive: true });
		await writeFile(path.join(globalDir, "leader.json"), "{ corrupt");
		await writeProject({ leader: { promptStrategy: "append", skills: ["beta"] } });
		await trustProject();
		const baseFile = path.join(fixture.profileSwitchDir, "profiles", "leader.json");

		const entries = await listProfiles(input());
		const leader = entries.find((entry) => entry.name === "leader");
		const text = formatProfileList(entries);

		// Nothing resolved, so nothing proves composition: prior unavailable
		// semantics are preserved.
		expect(leader).toMatchObject({ available: false, shadowsGlobal: true, error: expect.stringContaining(baseFile) });
		expect(leader?.composition).toBeUndefined();
		expect(text).toContain("(shadows global)");
		expect(text).toContain(`unavailable: invalid JSON in ${baseFile}`);
		expect(text).not.toContain("append composition");
	});

	it("does not open an untrusted project append and claims no composition on the global entry", async () => {
		await writeGlobal({ leader: { skills: ["alpha"] } });
		await writeProject({ leader: { promptStrategy: "append", skills: ["beta"] } });

		const entries = await listProfiles(input());
		const leader = entries.find((entry) => entry.name === "leader");
		const text = formatProfileList(entries);

		expect(leader).toMatchObject({ source: "global", available: true, shadowsGlobal: false });
		expect(leader?.composition).toBeUndefined();
		expect(leader?.label).toBeUndefined();
		expect(text).not.toContain("shadows global");
		expect(text).not.toContain("append");
	});
});
