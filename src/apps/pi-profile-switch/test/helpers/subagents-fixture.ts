import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import type { PiFixture } from "./pi-fixture.ts";

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("pi-subagents"));
const packageJsonPath = path.join(packageRoot, "package.json");

export interface SubagentsFixture {
	packageRoot: string;
	version: string;
	readonly extensionPath: string;
	readonly dispose: () => Promise<void>;
}

/** Makes the actual development dependency discoverable inside an isolated Pi fixture. */
export async function installSubagentsFixture(fixture: PiFixture): Promise<SubagentsFixture> {
	await access(path.join(packageRoot, "index.js"));
	const installedPackagePath = path.join(fixture.agentDir, "npm", "node_modules", "pi-subagents");
	await mkdir(path.dirname(installedPackagePath), { recursive: true });
	await symlink(packageRoot, installedPackagePath, "dir");
	await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents"] }));
	const extensionPath = path.join(packageRoot, "index.js");
	const metadata = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version: string };
	let disposed = false;

	return {
		packageRoot,
		version: metadata.version,
		extensionPath,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await rm(installedPackagePath, { force: true });
		},
	};
}

export interface LocalProviderOptions {
	compat?: {
		supportsMidConvoSystemMessages: boolean;
		supportsMidConvoToolAdditions: boolean;
	};
}

/** Test-only provider config: model metadata is local and no completion endpoint is used. */
export async function addLocalProvider(fixture: PiFixture, options: LocalProviderOptions = {}): Promise<string> {
	const extensionDir = path.join(fixture.agentDir, "extensions");
	await mkdir(extensionDir, { recursive: true });
	const models = [
		{ id: "review-model", name: "Review model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
		{ id: "shared-model", name: "Shared model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
		{ id: "project-model", name: "Project model", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
	].map((model) => options.compat ? { ...model, compat: options.compat } : model);
	const extensionPath = path.join(extensionDir, "local-provider.ts");
	await writeFile(
		extensionPath,
		`export default function (pi) {\n  pi.registerProvider("fixture", { baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", api: "openai-completions", models: ${JSON.stringify(models)} });\n}\n`,
	);
	return extensionPath;
}
