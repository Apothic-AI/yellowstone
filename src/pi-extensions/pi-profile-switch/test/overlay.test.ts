import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir } from "../src/settings-generator.ts";
import type { RuntimeOverlay } from "../src/runtime-state-store.ts";
import { applyOverlayMutation, clearOverlay, parseOverlayArgs } from "../src/switching/overlay.ts";
import { SwitchError, type SwitchDeps } from "../src/switching/switch-profile.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;
let runtimeDir: string;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
	runtimeDir = (await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir })).runtimeDir;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const deps = (): SwitchDeps => ({
	runtimeDir,
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	getAllTools: () => ["read", "bash", "grep"].map((name) => ({ name })),
	waitForIdle: async () => {},
	reload: async () => {},
	assertStale: () => {
		throw new Error("stale");
	},
});

/** Narrows a parsed command to its mutation, failing the test on `clear`. */
function mutate(args: string): (overlay: RuntimeOverlay) => RuntimeOverlay {
	const command = parseOverlayArgs(args);
	if (command.kind !== "mutate") throw new Error(`expected a mutate command, got ${command.kind}`);
	return command.mutate;
}

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	const fs = await import("node:fs/promises");
	await fs.mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function activate(name: string): Promise<void> {
	// Simulate a launched named profile: rewrite the runtime for it.
	const { switchProfile } = await import("../src/switching/switch-profile.ts");
	await switchProfile(name, deps(), { clearOverlay: true });
}

async function readState(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(fixture.agentDir, "pi-profile-state.json"), "utf8"));
}

async function readSettings(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
}

describe("parseOverlayArgs", () => {
	it("parses disable/enable mutations for every resource kind", () => {
		expect(mutate("disable skill noisy")({})).toEqual({ disabledSkills: ["noisy"] });
		expect(mutate("enable skill noisy")({ disabledSkills: ["noisy"] })).toEqual({});
		expect(mutate("disable tool read")({})).toEqual({ disabledTools: ["read"] });
		expect(mutate("enable tool read")({ disabledTools: ["read", "grep"] })).toEqual({ disabledTools: ["grep"] });
		expect(mutate("disable tool git-*")({ disabledTools: ["read"] })).toEqual({ disabledTools: ["read", "git-*"] });
	});

	it("rejects the removed tools replace-form with the usage note, writing nothing", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await activate("review");
		const before = await readSettings();

		let caught: unknown;
		try {
			parseOverlayArgs("tools read grep");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SwitchError);
		expect((caught as Error).message).toContain("usage");
		expect((caught as Error).message).toContain("skill|extension|mcp|tool");
		expect((caught as Error).message).not.toContain("[ref...]");

		expect(await readSettings()).toEqual(before);
		expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
	});

	it("parses clear as its own command kind", () => {
		expect(parseOverlayArgs("clear")).toEqual({ kind: "clear" });
	});

	it("rejects malformed invocations", () => {
		expect(() => parseOverlayArgs("disable")).toThrow(/usage/);
		expect(() => parseOverlayArgs("frobnicate skill x")).toThrow(/usage/);
		expect(() => parseOverlayArgs("clear extra")).toThrow(/usage/);
	});

	it("enable removes a stored entry by exact string match", () => {
		expect(mutate("enable skill noisy")({ disabledSkills: ["git-*", "noisy"] })).toEqual({ disabledSkills: ["git-*"] });
	});

	it("enable fails listing current entries when no stored entry equals the name", () => {
		expect(() => mutate("enable skill ghost")({ disabledSkills: ["git-*"] })).toThrow(/git-\*/);
		// Exact string match: a literal name never removes a stored glob.
		expect(() => mutate("enable skill git-commit")({ disabledSkills: ["git-*"] })).toThrow(/git-\*/);
		// No stored entries at all.
		expect(() => mutate("enable skill ghost")({})).toThrow(/current entries: \(none\)/);
	});

	it("enable fails listing current tool entries when no stored entry equals the name", () => {
		expect(() => mutate("enable tool ghost")({ disabledTools: ["git-*"] })).toThrow(/git-\*/);
		// Exact string match: a literal name never removes a stored glob.
		expect(() => mutate("enable tool git-commit")({ disabledTools: ["git-*"] })).toThrow(/git-\*/);
		// No stored entries at all.
		expect(() => mutate("enable tool ghost")({})).toThrow(/current entries: \(none\)/);
	});
});

describe("applyOverlayMutation / clearOverlay", () => {
	it("applies the overlay through re-resolution and persists it to state, never the catalog", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });
		await activate("review");

		await applyOverlayMutation(deps(), mutate("disable skill beta-skill"));

		const settings = await readSettings();
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"), `-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`, `-${path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md")}`]);
		expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });
		// The catalog file is untouched.
		const profile = JSON.parse(await readFile(path.join(fixture.profileSwitchDir, "profiles", "review.json"), "utf8"));
		expect(profile.skills).toEqual(["alpha-skill", "beta-skill"]);
	});

	it("rejects enabling without a matching stored entry, writing nothing", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await activate("review");
		await applyOverlayMutation(deps(), mutate("disable skill alpha-skill"));
		const before = await readSettings();

		await expect(applyOverlayMutation(deps(), mutate("enable skill ghost"))).rejects.toThrow(/git-\*|alpha-skill/);

		expect(await readSettings()).toEqual(before);
		expect((await readState()).overlay).toEqual({ disabledSkills: ["alpha-skill"] });
	});

	it("rejects disabling a resource the profile does not resolve, writing nothing", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await activate("review");
		const before = await readSettings();

		await expect(applyOverlayMutation(deps(), mutate("disable skill ghost"))).rejects.toThrow(
			/overlay disables unknown skill "ghost"/,
		);

		expect(await readSettings()).toEqual(before);
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
	});

	it("clear switches and reloads without the overlay before deleting it from state", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });
		await activate("review");
		await applyOverlayMutation(deps(), mutate("disable skill beta-skill"));

		// Ordering probe: the reload must run while the overlay is still
		// stored — clear deletes it from state only after the switch.
		const observed: unknown[] = [];
		const clearDeps: SwitchDeps = {
			...deps(),
			reload: async () => {
				observed.push((await readState()).overlay);
			},
		};
		await clearOverlay(clearDeps);

		expect(observed).toEqual([{ disabledSkills: ["beta-skill"] }]);
		const settings = await readSettings();
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
			path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md"),
		]);
		expect((await readState()).overlay).toBeUndefined();
	});

	it("a plain reload re-applies the stored overlay so runtime and state never diverge", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ review: { skills: ["alpha-skill", "beta-skill"] } });
		await activate("review");
		await applyOverlayMutation(deps(), mutate("disable skill beta-skill"));

		const { switchProfile } = await import("../src/switching/switch-profile.ts");
		await switchProfile(undefined, deps(), { reloadCurrent: true });

		const settings = await readSettings();
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"), `-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`, `-${path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md")}`]);
		expect((await readState()).overlay).toEqual({ disabledSkills: ["beta-skill"] });
	});

	it("stores a zero-match glob disable entry as written, succeeding with a warning", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ review: { skills: ["alpha-skill"] } });
		await activate("review");

		const result = await applyOverlayMutation(deps(), mutate("disable skill ghost-*"));

		expect(
			result.warnings.some(
				(warning) => warning.includes('"overlay skill:ghost-*" matched nothing this resolution'),
			),
		).toBe(true);
		// The entry is stored verbatim, exactly as written.
		expect((await readState()).overlay).toEqual({ disabledSkills: ["ghost-*"] });
		// Nothing matched, so the runtime is unchanged.
		const settings = await readSettings();
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
	});

	it("rejects disabling an MCP server on the default profile, writing nothing", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({});
		// The launch profile is default (the beforeEach generated it).
		const before = await readSettings();

		await expect(applyOverlayMutation(deps(), mutate("disable mcp github"))).rejects.toThrow(
			/no MCP allowlist to narrow/,
		);

		expect(await readSettings()).toEqual(before);
		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(fixture.agentDir, "pi-profile-state.json"))).toBe(false);
	});

	it("narrows the default profile via a synthetic everything-minus-disabled selection", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({});
		// The launch profile is default (the beforeEach generated it).

		await applyOverlayMutation(deps(), mutate("disable skill beta-skill"));

		// Undeclared skills: the agentDir mirror keeps the remaining native skills
		// discoverable, and only the disabled entry is force-excluded.
		const settings = await readSettings();
		expect(settings.skills).toEqual([
			`-${path.join(runtimeDir, "skills", "beta-skill", "SKILL.md")}`,
			`-${path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md")}`,
		]);
		expect(settings.defaultProjectTrust).toBe("never");
	});
});
