/**
 * Packaging contract: the npm tarball ships the runtime graph, while optional
 * native compatibility fixtures stay development-only.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const fullPath = `${root}/${entry.name}`;
		if (entry.isDirectory()) files.push(...(await sourceFiles(fullPath)));
		else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) files.push(fullPath);
	}
	return files;
}

function packList(): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"npm",
			["pack", "--dry-run", "--json"],
			{
				cwd: process.cwd(),
				env: { ...process.env, npm_config_progress: "false", npm_config_loglevel: "error" },
				maxBuffer: 16 * 1024 * 1024,
			},
			(error, stdout) => {
				if (error) return reject(error);
				const parsed = JSON.parse(stdout) as Record<string, { files: Array<{ path: string }> }>;
				const entry = parsed["pi-profile"] ?? Object.values(parsed)[0];
				resolve(entry?.files.map((file) => file.path) ?? []);
			},
		);
	});
}

describe("npm pack contents", () => {
	it("keeps pi-subagents optional and development-only without runtime imports", async () => {
		const manifest = JSON.parse(await readFile("package.json", "utf8")) as Record<string, Record<string, unknown>>;
		const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
			packages: Record<string, { version?: string; dev?: boolean }>;
		};
		const version = manifest.devDependencies?.["pi-subagents"];
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
			expect(manifest[section]?.["pi-subagents"], section).toBeUndefined();
		}
		expect(lock.packages["node_modules/pi-subagents"]).toMatchObject({ version, dev: true });

		const runtimeFiles = (await Promise.all(["src", "bin", "extensions"].map(sourceFiles))).flat();
		const optionalImport = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']pi-subagents(?:\/[^"']*)?["']/;
		for (const file of runtimeFiles) {
			expect(await readFile(file, "utf8"), `production import in ${file}`).not.toMatch(optionalImport);
		}
	});

	it("resolves the installed native fixture and scopes cleanup to its isolated path", async () => {
		const source = await readFile("test/helpers/subagents-fixture.ts", "utf8");
		expect(source).toContain('require.resolve("pi-subagents")');
		expect(source).toContain('fixture.agentDir, "npm", "node_modules", "pi-subagents"');
		expect(source).toContain("await rm(installedPackagePath, { force: true })");
		expect(source).toContain('JSON.stringify({ packages: ["npm:pi-subagents"] })');
		expect(source).toContain('await access(path.join(packageRoot, "index.js"))');
	});

	it("ships bin, extension, src, schemas, examples; excludes dev surfaces", async () => {
		const files = await packList();
		for (const required of [
			"bin/pi-profile.ts",
			"bin/postinstall.js",
			"extensions/pi-profile/index.ts",
			"skills/profile-config/SKILL.md",
			"src/profile-resolver.ts",
			"schemas/profiles.schema.json",
			"examples/ask.json",
			"examples/example.json",
			"README.md",
			"package.json",
		]) {
			expect(files, required).toContain(required);
		}
		expect(files.some((file) => file.startsWith("src/switching/"))).toBe(true);
		for (const excluded of ["test/", "docs/", "node_modules/", ".agents/"]) {
			expect(files.some((file) => file.startsWith(excluded)), excluded).toBe(false);
		}
	}, 60_000);
});
