import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	discoverExtensions,
	discoverImplicitExtensions,
	packageNameFromSource,
	type ImplicitExtensionDiscovery,
} from "../src/extension-discovery.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function settingsPath(): Promise<string> {
	return path.join(fixture.agentDir, "settings.json");
}

async function readSettings(): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(await settingsPath(), "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Registers package entries in the global settings, the way a user configures
 *  them: discovery reads Pi's settings, not a list handed to it. */
async function addConfiguredPackages(entries: unknown[]): Promise<void> {
	const settings = await readSettings();
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	await writeFile(await settingsPath(), JSON.stringify({ ...settings, packages: [...packages, ...entries] }));
}

/** Overwrites the configured package entries (used for object-form filters). */
async function setConfiguredPackages(entries: unknown[]): Promise<void> {
	const settings = await readSettings();
	await writeFile(await settingsPath(), JSON.stringify({ ...settings, packages: entries }));
}

/** Creates a fake installed npm package under the fixture's npm root and
 *  configures it, so Pi's own resolver finds it. Declared entries without a
 *  .ts/.js suffix are created as directories holding index.js — the shape a
 *  compiled extension package such as pi-web-access uses. */
async function addPackage(
	name: string,
	options: { extensions?: string[]; version?: string },
): Promise<{ source: string; root: string }> {
	const root = path.join(fixture.agentDir, "npm", "node_modules", ...name.split("/"));
	await mkdir(root, { recursive: true });
	const manifest: Record<string, unknown> = { name, version: options.version ?? "1.0.0" };
	if (options.extensions !== undefined) {
		manifest.pi = { extensions: options.extensions };
		for (const rel of options.extensions) {
			const target = path.join(root, rel);
			await mkdir(path.dirname(target), { recursive: true });
			if (/\.(ts|js)$/.test(rel)) {
				await writeFile(target, "export default function () {}\n");
			} else {
				await mkdir(target, { recursive: true });
				await writeFile(path.join(target, "index.js"), "export default function () {}\n");
			}
		}
	}
	await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
	const source = `npm:${name}`;
	await addConfiguredPackages([source]);
	return { source, root };
}

async function addLoose(dir: string, name: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await writeFile(file, "export default function () {}\n");
	return file;
}

const EMPTY: ImplicitExtensionDiscovery = { packages: [], local: [], warnings: [] };

describe("packageNameFromSource", () => {
	it("strips prefixes and version specs", () => {
		expect(packageNameFromSource("npm:pi-web-access")).toBe("pi-web-access");
		expect(packageNameFromSource("npm:@janvitos/pi-plan-build")).toBe("@janvitos/pi-plan-build");
		expect(packageNameFromSource("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(packageNameFromSource("npm:pkg@^2.0.0")).toBe("pkg");
		expect(packageNameFromSource("git:https://example.com/x.git")).toBe("https://example.com/x.git");
	});
});

describe("discoverImplicitExtensions", () => {
	it("discovers a package's declared pi.extensions entries", async () => {
		const pkg = await addPackage("pi-web-access", { extensions: ["./index.ts"] });

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.warnings).toEqual([]);
		expect(result.packages).toEqual([
			{
				name: "pi-web-access",
				source: "npm:pi-web-access",
				root: pkg.root,
				entries: [path.join(pkg.root, "index.ts")],
			},
		]);
	});

	it("discovers a directory entry, the shape compiled extension packages declare", async () => {
		// pi-web-access declares "pi": { "extensions": ["./dist"] }; entry
		// enumeration is Pi's, so the built file is what becomes selectable.
		const pkg = await addPackage("pi-web-access", { extensions: ["./dist"] });

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages).toEqual([
			{
				name: "pi-web-access",
				source: "npm:pi-web-access",
				root: pkg.root,
				entries: [path.join(pkg.root, "dist", "index.js")],
			},
		]);
	});

	it("lists every entry of a multi-entry package", async () => {
		const pkg = await addPackage("pi-multi", { extensions: ["./index.ts", "./panel.ts"] });

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages[0]?.entries).toEqual([
			path.join(pkg.root, "index.ts"),
			path.join(pkg.root, "panel.ts"),
		]);
	});

	it("honors the object form of a settings package entry", async () => {
		const pkg = await addPackage("pi-multi", { extensions: ["./a.ts", "./b.ts"] });
		await setConfiguredPackages([{ source: "npm:pi-multi", extensions: ["a.ts"] }]);

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages[0]?.entries).toEqual([path.join(pkg.root, "a.ts")]);
	});

	it("keeps a package whose entries are all filtered out, without entries", async () => {
		await addPackage("pi-multi", { extensions: ["./a.ts"] });
		await setConfiguredPackages([{ source: "npm:pi-multi", extensions: [] }]);

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages.map((pkg) => ({ name: pkg.name, entries: pkg.entries }))).toEqual([
			{ name: "pi-multi", entries: [] },
		]);
	});

	it("skips skills-only packages and packages that are not installed", async () => {
		await addPackage("pi-skills", {});
		await addConfiguredPackages(["npm:pi-ghost", path.join(fixture.root, "absent")]);

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages).toEqual([]);
	});

	it("skips declared entries missing on disk", async () => {
		const pkg = await addPackage("pi-partial", { extensions: ["./index.ts"] });
		await rm(path.join(pkg.root, "index.ts"));

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages).toEqual([]);
	});

	it("falls back to the source-derived name when the manifest has none", async () => {
		const root = path.join(fixture.agentDir, "npm", "node_modules", "pi-noname");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "index.ts"), "export default function () {}\n");
		await writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
		);
		await addConfiguredPackages(["npm:pi-noname"]);

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages[0]?.name).toBe("pi-noname");
	});

	it("does not advertise a local source that resolves to a bare directory", async () => {
		const dir = path.join(fixture.root, "not-a-package");
		await mkdir(dir, { recursive: true });
		await addConfiguredPackages([dir]);

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.packages).toEqual([]);
	});

	it("discovers loose files by filename stem, .ts preferred over a .js sibling", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		const tsFile = await addLoose(dir, "conventions.ts");
		await addLoose(dir, "conventions.js");
		const other = await addLoose(dir, "review-guard.js");

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.local).toEqual([
			{ id: "conventions", entry: tsFile },
			{ id: "review-guard", entry: other },
		]);
		expect(result.warnings.some((warning) => warning.includes("conventions"))).toBe(true);
	});

	it("names a directory-style loose extension after its directory", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		const entry = await addLoose(path.join(dir, "guards"), "index.ts");

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.local).toEqual([{ id: "guards", entry }]);
	});

	it("leaves dot-files and gitignored files unselectable", async () => {
		const dir = path.join(fixture.agentDir, "extensions");
		const kept = await addLoose(dir, "kept.ts");
		await addLoose(dir, ".hidden.ts");
		await addLoose(dir, "ignored.ts");
		await writeFile(path.join(dir, ".gitignore"), "ignored.ts\n");

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.local).toEqual([{ id: "kept", entry: kept }]);
	});

	it("project loose files override same-stem global ones for trusted projects", async () => {
		await addLoose(path.join(fixture.agentDir, "extensions"), "shared.ts");
		const projectFile = await addLoose(path.join(fixture.cwd, ".pi", "extensions"), "shared.ts");

		const result = await discoverImplicitExtensions({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		});

		expect(result.local).toEqual([{ id: "shared", entry: projectFile }]);
	});

	it("never scans the project when it is not trusted", async () => {
		await addLoose(path.join(fixture.cwd, ".pi", "extensions"), "secret.ts");
		const projectRoot = path.join(fixture.cwd, ".pi", "npm", "node_modules", "pi-project");
		await mkdir(projectRoot, { recursive: true });
		await writeFile(path.join(projectRoot, "index.ts"), "export default function () {}\n");
		await writeFile(
			path.join(projectRoot, "package.json"),
			JSON.stringify({ name: "pi-project", version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
		);
		await writeFile(
			path.join(fixture.cwd, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:pi-project"] }),
		);

		const result = await discoverImplicitExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(result.local).toEqual([]);
		expect(result.packages).toEqual([]);
	});

	it("excludes trusted project packages, which global-scope settings cannot reference", async () => {
		const pkg = await addPackage("pi-user", { extensions: ["./index.ts"] });
		const projectRoot = path.join(fixture.cwd, ".pi", "npm", "node_modules", "pi-project");
		await mkdir(projectRoot, { recursive: true });
		await writeFile(path.join(projectRoot, "index.ts"), "export default function () {}\n");
		await writeFile(
			path.join(projectRoot, "package.json"),
			JSON.stringify({ name: "pi-project", version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
		);
		await writeFile(
			path.join(fixture.cwd, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:pi-project"] }),
		);

		const result = await discoverImplicitExtensions({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			projectTrusted: true,
		});

		expect(result.packages.map((entry) => entry.name)).toEqual(["pi-user"]);
		expect(result.packages[0]?.root).toBe(pkg.root);
	});

	it("an empty discovery result is a valid input", () => {
		expect(EMPTY.packages).toEqual([]);
	});
});

describe("DiscoveredExtensions (pure discovery & selection)", () => {
	it("selects extensions by package name, alias, and loose file stem", async () => {
		await addPackage("pi-web-access", { extensions: ["./index.ts"] });
		await addLoose(path.join(fixture.agentDir, "extensions"), "conventions.ts");

		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const selection = await extensions.select(["pi-web-access", "conventions"]);
		expect(selection.unmatched).toEqual([]);
		expect(selection.entries.map((e) => e.id).sort()).toEqual(["conventions", "pi-web-access"]);

		// Also selectable by source alias
		const aliasSelection = await extensions.select(["npm:pi-web-access"]);
		expect(aliasSelection.entries.map((e) => e.id)).toEqual(["pi-web-access"]);
	});

	it("selects a directory-declared package entry", async () => {
		const pkg = await addPackage("pi-web-access", { extensions: ["./dist"] });
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const selection = await extensions.select(["pi-web-access"]);

		expect(selection.entries).toEqual([
			{
				id: "pi-web-access",
				entry: path.join(pkg.root, "dist", "index.js"),
				packageName: "pi-web-access",
				origin: "package",
			},
		]);
	});

	it("reports a package whose settings filter disables every entry", async () => {
		await addPackage("pi-multi", { extensions: ["./a.ts"] });
		await setConfiguredPackages([{ source: "npm:pi-multi", extensions: [] }]);
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const result = await extensions.select(["pi-multi"]);
		expect(result.entries).toEqual([]);
		expect(result.diagnostics?.[0].message).toMatch(/declares no extension entries/);
	});

	it("selects multi-entry packages as a whole and by individual entry", async () => {
		await addPackage("multi-ext", { extensions: ["./a.ts", "./b.ts"] });
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const all = await extensions.select(["multi-ext"]);
		expect(all.entries.map((e) => e.id).sort()).toEqual(["multi-ext:a.ts", "multi-ext:b.ts"]);

		const single = await extensions.select(["multi-ext:a.ts"]);
		expect(single.entries.map((e) => e.id)).toEqual(["multi-ext:a.ts"]);
	});

	it("expands glob patterns and records unmatched globs", async () => {
		await addPackage("pi-web-access", { extensions: ["./index.ts"] });
		await addLoose(path.join(fixture.agentDir, "extensions"), "pi-guard.ts");
		await addLoose(path.join(fixture.agentDir, "extensions"), "other.ts");

		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const selection = await extensions.select(["pi-*", "nonexistent-*"]);
		expect(selection.entries.map((e) => e.id).sort()).toEqual(["pi-guard", "pi-web-access"]);
		expect(selection.unmatched).toEqual(["nonexistent-*"]);
	});

	it("resolves absolute paths directly, diagnosing relative and missing ones", async () => {
		const absFile = await addLoose(path.join(fixture.root, "external"), "custom.ts");
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const selection = await extensions.select([absFile]);
		expect(selection.entries).toEqual([{ id: absFile, entry: absFile, origin: "path" }]);

		const relative = await extensions.select(["./relative/path.ts"]);
		expect(relative.entries).toEqual([]);
		expect(relative.diagnostics?.[0].message).toContain("relative path");
		const missing = await extensions.select(["/nonexistent/ext.ts"]);
		expect(missing.entries).toEqual([]);
		expect(missing.diagnostics?.[0].message).toContain("extension path not found");
	});

	it("diagnoses unknown literals with candidates and available near-miss hints", async () => {
		await addPackage("pi-web-access", { extensions: ["./index.ts"] });
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const result = await extensions.select(["web-access"]);
		expect(result.entries).toEqual([]);
		const message = result.diagnostics?.[0].message;
		expect(message).toContain("unknown extension");
		expect(message).toContain("pi-web-access");
		expect(message).toContain('did you mean "pi-web-access"');
		expect(message).not.toContain("resources.json");
	});

	it("resolves local file over package name collision, keeping package selectable by source", async () => {
		await addPackage("my-tool", { extensions: ["./index.ts"] });
		const localFile = await addLoose(path.join(fixture.agentDir, "extensions"), "my-tool.ts");

		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		expect(extensions.warnings().some((w) => w.includes("my-tool"))).toBe(true);

		const localSelection = await extensions.select(["my-tool"]);
		expect(localSelection.entries).toEqual([{ id: "my-tool", entry: localFile, origin: "local" }]);

		const pkgSelection = await extensions.select(["npm:my-tool"]);
		expect(pkgSelection.entries[0]?.entry).toContain("node_modules");
	});
});


describe("local extension reference diagnostics", () => {
	it("continues past every expected reference failure without guessing a relative base", async () => {
		await addPackage("empty-package", { extensions: ["./a.ts"] });
		await setConfiguredPackages([{ source: "npm:empty-package", extensions: [] }]);
		const file = await addLoose(path.join(fixture.root, "external"), "kept.ts");
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const missing = path.join(fixture.root, "absent.ts");
		const result = await extensions.select(["ghost", "relative.ts", "relative/path.ts", "../relative.ts", missing, "empty-package", "zero-*", file]);
		expect(result.entries).toEqual([{ id: file, entry: file, origin: "path" }]);
		expect(result.unmatched).toEqual(["zero-*"]);
		expect(result.diagnostics?.map((issue) => issue.reference)).toEqual(["ghost", "relative.ts", "relative/path.ts", "../relative.ts", missing, "empty-package", "zero-*"]);
		for (const issue of result.diagnostics ?? []) {
			expect(issue.kind).toBe("extension");
			expect(issue.message).toContain("not loaded");
		}
		expect(result.diagnostics?.find((issue) => issue.reference === missing)?.filePath).toBe(missing);
	});

	it("retries a missing path without mutating its references", async () => {
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const file = path.join(fixture.root, "future.ts");
		const refs = [file];
		expect((await extensions.select(refs)).entries).toEqual([]);
		await writeFile(file, 'throw new Error("must not execute")');
		expect((await extensions.select(refs)).entries).toEqual([{ id: file, entry: file, origin: "path" }]);
		expect(refs).toEqual([file]);
	});

	it("diagnoses glob-selected packages with no usable entries while retaining usable matches", async () => {
		await addPackage("pi-empty", { extensions: ["./a.ts"] });
		await addPackage("pi-usable", { extensions: ["./b.ts"] });
		await setConfiguredPackages([{ source: "npm:pi-empty", extensions: [] }, "npm:pi-usable"]);
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const result = await extensions.select(["pi-*"]);
		expect(result.entries.map((entry) => entry.id)).toEqual(["pi-usable"]);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "empty-package", reference: "pi-*", message: expect.stringContaining("pi-empty") }));
	});

	it("does not hide unexpected stat failures as missing references", async () => {
		const extensions = await discoverExtensions({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const file = path.join(fixture.root, "loop.ts");
		await symlink(file, file);
		await expect(extensions.select([file])).rejects.toMatchObject({ code: "ELOOP" });
	});
});
