import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverLauncherResources } from "../src/launcher/discovery.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

describe("discoverLauncherResources", () => {
	it("returns the full skill set and resolves local package roots", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		const packageRoot = path.join(fixture.root, "my-package");
		await mkdir(packageRoot, { recursive: true });
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));

		const discovery = await discoverLauncherResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: false });

		expect(discovery.skills.map((skill) => skill.name)).toContain("alpha-skill");
		expect(discovery.packages).toEqual([{ source: packageRoot, root: packageRoot }]);
	});

	it("resolves npm package roots to the agent dir's npm install path", async () => {
		const installed = path.join(fixture.agentDir, "npm", "node_modules", "pi-tools");
		await mkdir(installed, { recursive: true });
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-tools"] }));

		const discovery = await discoverLauncherResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: false });

		expect(discovery.packages).toEqual([{ source: "npm:pi-tools", root: installed }]);
	});

	it("leaves uninstalled npm package roots undefined rather than hitting the network", async () => {
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:not-installed"] }));

		const discovery = await discoverLauncherResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: false });

		expect(discovery.packages).toEqual([{ source: "npm:not-installed", root: undefined }]);
	});

	it("enumerates a compiled package's directory entry through Pi's own resolver", async () => {
		// Regression: pi-web-access declares "pi": { "extensions": ["./dist"] },
		// and the real entry is dist/index.js.
		const root = path.join(fixture.agentDir, "npm", "node_modules", "pi-web-access");
		const entry = path.join(root, "dist", "index.js");
		await mkdir(path.dirname(entry), { recursive: true });
		await writeFile(entry, "export default function () {}\n");
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ name: "pi-web-access", version: "1.0.0", pi: { extensions: ["./dist"] } }),
		);
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));

		const discovery = await discoverLauncherResources({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: false,
		});
		const selection = await discovery.extensions.select(["pi-web-access"]);

		expect(discovery.packages).toEqual([{ source: "npm:pi-web-access", root }]);
		expect(selection.entries.map((e) => ({ id: e.id, entry: e.entry, origin: e.origin }))).toEqual([
			{ id: "pi-web-access", entry, origin: "package" },
		]);
	});
});
