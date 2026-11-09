import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveProjectTrust } from "../src/project-trust.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

function writeTrustFile(entries: Record<string, boolean>): void {
	writeFileSync(path.join(fixture.agentDir, "trust.json"), JSON.stringify(entries));
}

const input = (overrides?: Partial<Parameters<typeof resolveProjectTrust>[0]>) => ({
	cwd: fixture.cwd,
	agentDir: fixture.agentDir,
	...overrides,
});

describe("resolveProjectTrust", () => {
	it("trusts a project with no trust-requiring resources (nothing to gate)", () => {
		expect(resolveProjectTrust(input())).toBe(true);
	});

	it("treats pi-profile's own project files as trust-requiring", () => {
		mkdirSync(path.join(fixture.cwd, ".pi", "profiles"));
		expect(resolveProjectTrust(input())).toBe(false);
	});

	it("treats Pi's project resources as trust-requiring", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
		expect(resolveProjectTrust(input())).toBe(false);
	});

	it("mirrors a stored trust decision for the project", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
		writeTrustFile({ [fixture.cwd]: true });
		expect(resolveProjectTrust(input())).toBe(true);
	});

	it("mirrors a stored distrust decision", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
		writeTrustFile({ [fixture.cwd]: false });
		expect(resolveProjectTrust(input())).toBe(false);
	});

	it("honors a nearest-ancestor trust entry", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
		writeTrustFile({ [fixture.root]: true });
		expect(resolveProjectTrust(input())).toBe(true);
	});

	it("the --approve override trusts for this run regardless of stored state", () => {
		expect(resolveProjectTrust(input({ trustOverride: true }))).toBe(true);
	});

	it("the --no-approve override distrusts for this run, beating a stored trust entry", () => {
		writeTrustFile({ [fixture.cwd]: true });
		expect(resolveProjectTrust(input({ trustOverride: false }))).toBe(false);
	});

	it("honors the user's defaultProjectTrust: always when something needs gating and nothing is stored", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
		expect(resolveProjectTrust(input({ userDefaultProjectTrust: "always" }))).toBe(true);
	});

	it("never auto-trusts for ask/never defaults (the launcher has no trust UI)", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
		expect(resolveProjectTrust(input({ userDefaultProjectTrust: "ask" }))).toBe(false);
		expect(resolveProjectTrust(input({ userDefaultProjectTrust: "never" }))).toBe(false);
	});
});
