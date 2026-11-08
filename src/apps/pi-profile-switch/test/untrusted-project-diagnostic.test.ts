import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { untrustedProjectDiagnostic } from "../src/launcher/untrusted-project-diagnostic.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("untrustedProjectDiagnostic", () => {
	it("fires when the project is untrusted and trust-requiring content exists", () => {
		mkdirSync(path.join(fixture.cwd, ".pi", "profiles"), { recursive: true });
		mkdirSync(path.join(fixture.cwd, ".pi", "extensions"), { recursive: true });

		const message = untrustedProjectDiagnostic(fixture.cwd, false);

		expect(message).toBeDefined();
		expect(message).toContain("project is untrusted");
		expect(message).toContain(".pi/profiles");
		expect(message).toContain(".pi/extensions");
		expect(message).toContain("invisible");
	});

	it("states how to authorize: /trust persists (next launch), -- --approve is one-shot", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "settings.json"), "{}");

		const message = untrustedProjectDiagnostic(fixture.cwd, false);

		expect(message).toContain("/trust");
		expect(message).toContain("persist");
		expect(message).toContain("next launch");
		expect(message).toContain("-- --approve");
		expect(message).toContain("one-shot");
	});

	it("names pi-profile project files and project MCP configuration", () => {
		writeFileSync(path.join(fixture.cwd, ".pi", "pi-profile-state.json"), "{}");
		writeFileSync(path.join(fixture.cwd, ".mcp.json"), "{}");
		writeFileSync(path.join(fixture.cwd, ".pi", "mcp.json"), "{}");

		const message = untrustedProjectDiagnostic(fixture.cwd, false);

		expect(message).toContain(".pi/pi-profile-state.json");
		expect(message).toContain(".mcp.json");
		expect(message).toContain(".pi/mcp.json");
	});

	it("prints no diagnostic when the project is trusted", () => {
		mkdirSync(path.join(fixture.cwd, ".pi", "profiles"), { recursive: true });

		expect(untrustedProjectDiagnostic(fixture.cwd, true)).toBeUndefined();
	});

	it("prints no diagnostic for an untrusted project with no trust-requiring content (--no-approve case)", () => {
		expect(untrustedProjectDiagnostic(fixture.cwd, false)).toBeUndefined();
	});

	it("names a cwd-local .agents/skills directory as skipped content", () => {
		mkdirSync(path.join(fixture.cwd, ".agents", "skills"), { recursive: true });

		const message = untrustedProjectDiagnostic(fixture.cwd, false);

		expect(message).toContain(".agents/skills");
		expect(message).not.toContain("parent directory");
	});

	it("reports Pi project resources in a parent directory when only an ancestor triggers the fallback", () => {
		mkdirSync(path.join(fixture.root, ".agents", "skills"), { recursive: true });

		const message = untrustedProjectDiagnostic(fixture.cwd, false);

		expect(message).toContain("parent directory");
	});
});
