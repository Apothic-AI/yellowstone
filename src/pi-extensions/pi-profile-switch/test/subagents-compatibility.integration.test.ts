import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeParentLauncherEnv, runLauncherRpc } from "./helpers/launcher-runner.ts";
import { createPiFixture, soleInstanceDir, type PiFixture } from "./helpers/pi-fixture.ts";
import { addLocalProvider, installSubagentsFixture, type SubagentsFixture } from "./helpers/subagents-fixture.ts";
import type { RpcDriver } from "./helpers/rpc-driver.ts";

let fixture: PiFixture;
let native: SubagentsFixture;
let providerExtension: string;
let rpc: RpcDriver | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	native = await installSubagentsFixture(fixture);
	providerExtension = await addLocalProvider(fixture);
});

afterEach(async () => {
	await rpc?.close();
	await native.dispose();
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify({ extensions: ["pi-subagents", "local-provider"], ...(definition as Record<string, unknown>) }));
	}
}

async function start(profile: string, piArgs: string[] = []): Promise<void> {
	rpc = runLauncherRpc(fixture, [profile, "--", "--mode", "rpc", ...piArgs], nativeParentLauncherEnv(fixture));
	let commands: Array<{ name: string; source: string }>;
	try {
		commands = await rpc.commandNames();
	} catch (error) {
		throw new Error(`${String(error)}\n${rpc.stderr.join("")}`);
	}
	expect(commands.map((command) => command.name), `${rpc.stderr.join(" ")} ${JSON.stringify(commands)}`).toContain("subagents-models");
}

async function inspectAgentMetadata(agent: string): Promise<string> {
	if (!rpc) throw new Error("RPC session not started");
	const firstMessageIndex = rpc.messages.length;
	await rpc.send({ type: "prompt", message: `/subagents ${agent} info` }, 60_000);
	const result = await rpc.waitFor((candidate) => {
		const index = rpc!.messages.indexOf(candidate);
		const message = (candidate as { message?: { customType?: string; content?: string } }).message;
		return index >= firstMessageIndex && message?.customType === "subagents-admin" && message.content?.includes(`Agent: ${agent} `) === true;
	}, 60_000);
	return String((result as { message?: { content?: string } }).message?.content ?? "");
}

async function toolRequestEvents(file: string): Promise<Array<{ phase: string; toolName: string }>> {
	try {
		const contents = await readFile(file, "utf8");
		return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { phase: string; toolName: string });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function inspectModels(agent?: string): Promise<string> {
	if (!rpc) throw new Error("RPC session not started");
	const firstMessageIndex = rpc.messages.length;
	await rpc.send({ type: "prompt", message: `/subagents-models${agent ? ` ${agent}` : ""}` }, 60_000);
	const result = await rpc.waitFor((candidate) => {
		const index = rpc!.messages.indexOf(candidate);
		const message = (candidate as { message?: { customType?: string; content?: string } }).message;
		return index >= firstMessageIndex && message?.customType === "subagent-slash-result" && message.content?.includes("Subagent model") === true;
	}, 60_000);
	return String((result as { message?: { content?: string } }).message?.content ?? "");
}

async function writeRuntimeProbe(): Promise<{ outputPath: string; toolRequestPath: string; extensionPath: string }> {
	const outputPath = path.join(fixture.root, "native-probe.json");
	const toolRequestPath = path.join(fixture.root, "native-tool-requests.jsonl");
	const extensionPath = path.join(fixture.root, "native-probe.ts");
	await writeFile(extensionPath, [
		`import { appendFileSync, existsSync, writeFileSync } from "node:fs";`,
		`import path from "node:path";`,
		`export default function (pi) {`,
		`  const capture = (extra: Record<string, unknown> = {}) => writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ registered: pi.getAllTools().filter((tool) => tool.name === "subagent"), active: pi.getActiveTools(), ...extra }));`,
		`  const recordSubagentCall = (phase, event) => { if (event.toolName === "subagent") appendFileSync(${JSON.stringify(toolRequestPath)}, JSON.stringify({ phase, toolName: event.toolName, toolCallId: event.toolCallId }) + "\\n"); };`,
		`  pi.on("tool_call", (event) => recordSubagentCall("tool_call", event));`,
		`  pi.on("tool_execution_start", (event) => recordSubagentCall("tool_execution_start", event));`,
		`  pi.on("session_start", () => capture());`,
		`  pi.registerCommand("native-fixture-snapshot", { description: "Capture native test state", handler: (_args, ctx) => { const agentDir = process.env.PI_CODING_AGENT_DIR ?? ""; const configPath = path.join(agentDir, "extensions", "subagent", "config.json"); capture({ model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api, compat: ctx.model.compat } : null, agentDir, configPath, configExists: existsSync(configPath) }); } });`,
		`  pi.on("before_agent_start", (event) => setTimeout(() => capture({ systemPrompt: event.systemPrompt, sections: event.systemPromptOptions.sections }), 0));`,
		`}`,
		"",
	].join("\n"));
	return { outputPath, toolRequestPath, extensionPath };
}

async function nativeSnapshot(): Promise<Record<string, unknown>> {
	if (!rpc) throw new Error("RPC session not started");
	await rpc.send({ type: "prompt", message: "/native-fixture-snapshot" }, 60_000);
	return readRuntimeProbe(path.join(fixture.root, "native-probe.json"));
}

async function statusMessages(): Promise<string> {
	if (!rpc) throw new Error("RPC session not started");
	await rpc.send({ type: "prompt", message: "/profile status" }, 60_000);
	return JSON.stringify(rpc.messages.slice(-8));
}

async function readRuntimeProbe(file: string, requirePrompt = false): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
			if (!requirePrompt || value.sections !== undefined) return value;
		} catch {
			// The session-start probe may not have run yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`native runtime probe did not write ${requirePrompt ? "prompt data" : "session data"} to ${file}`);
}

describe("real pi-subagents compatibility", () => {
	it("proves native role selection, inheritance, defaults, pinned frontmatter, thinking and refresh", { timeout: 120_000 }, async () => {
		const agentsDir = path.join(fixture.agentDir, "agents");
		await mkdir(agentsDir, { recursive: true });
		const pinnedFile = path.join(agentsDir, "pinned-reviewer.md");
		const pinnedText = `---
name: pinned-reviewer
description: Pinned role
model: fixture/review-model
---
Pinned prompt.
`;
		await writeFile(pinnedFile, pinnedText);
		const defaultFile = path.join(agentsDir, "default-role.md");
		const defaultText = `---
name: default-role
description: Uses shared defaults
---
Default prompt.
`;
		await writeFile(defaultFile, defaultText);
		const qualifiedFile = path.join(agentsDir, "qualified-role.md");
		const qualifiedText = `---
name: qualified-role
description: Provider-qualified thinking suffix
model: fixture/review-model:high
---
Qualified prompt.
`;
		await writeFile(qualifiedFile, qualifiedText);

		const baseSettings = { packages: ["npm:pi-subagents"], defaultProvider: "fixture", defaultModel: "fixture/shared-model", subagents: { agentOverrides: { reviewer: { model: "inherit" } } } };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(baseSettings));
		await writeCatalog({
			alpha: { subagents: { defaultModel: "fixture/shared-model", defaultThinking: "medium", agentOverrides: { reviewer: { model: "fixture/review-model", thinking: "high" }, "ghost-role": { model: "fixture/project-model" }, "claude-code": { model: "claude-opus-4-5" } } } },
			plain: {},
		});
		await start("alpha");
		const instance = await soleInstanceDir(fixture);
		const generated = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(generated.subagents).toMatchObject({
			defaultModel: "fixture/shared-model",
			defaultThinking: "medium",
			agentOverrides: { reviewer: { model: "fixture/review-model", thinking: "high" }, "ghost-role": { model: "fixture/project-model" } },
		});

		const reviewerOverride = await inspectModels("reviewer");
		expect(reviewerOverride).toContain(`Effective model:
  fixture/review-model`);
		expect(reviewerOverride).toContain("Thinking: high");
		const inheritedByDefault = await inspectModels("default-role");
		expect(inheritedByDefault).toContain(`Effective model:
  fixture/shared-model`);
		expect(inheritedByDefault).toContain("Thinking: medium");
		const pinned = await inspectModels("pinned-reviewer");
		expect(pinned).toContain(`Effective model:
  fixture/review-model`);
		expect(pinned).toContain("Thinking: medium");
		const qualified = await inspectModels("qualified-role");
		expect(qualified).toContain(`Effective model:
  fixture/review-model`);
		expect(qualified).toContain("Thinking: high");
		expect(qualified).toContain("fixture/review-model:high");
		const cliAlias = await inspectModels("claude-code");
		expect(cliAlias).toContain(`Effective model:
  claude-opus-4-5`);
		const nativeCatalog = await inspectModels();
		expect(nativeCatalog).toContain("pinned-reviewer");
		expect(nativeCatalog).toContain("default-role");
		expect(nativeCatalog).toContain("scout");
		expect(nativeCatalog).not.toContain("ghost-role");

		await rpc!.send({ type: "prompt", message: "/profile use plain" }, 60_000);
		const afterSwitch = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(afterSwitch.subagents).toEqual(baseSettings.subagents);
		const inheritedReviewer = await inspectModels("reviewer");
		const state = await rpc!.send({ type: "get_state" });
		const sessionModel = state.data?.model as { provider?: string; id?: string } | undefined;
		expect(sessionModel).toBeDefined();
		expect(inheritedReviewer).toContain(`Effective model:
  ${sessionModel?.provider}/${sessionModel?.id}`);
		expect(inheritedReviewer).toContain(`Requested model setting:
  inherit`);

		const editedBase = { ...baseSettings, subagents: { agentOverrides: { reviewer: { model: "fixture/project-model", thinking: "low" } } } };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(editedBase));
		await rpc!.send({ type: "prompt", message: "/profile reload" }, 60_000);
		const afterReload = JSON.parse(await readFile(path.join(instance, "settings.json"), "utf8"));
		expect(afterReload.subagents).toEqual(editedBase.subagents);
		const refreshedReviewer = await inspectModels("reviewer");
		expect(refreshedReviewer).toContain(`Effective model:
  fixture/project-model`);
		expect(refreshedReviewer).toContain("Thinking: low");
		expect(await readFile(pinnedFile, "utf8")).toBe(pinnedText);
		expect(await readFile(defaultFile, "utf8")).toBe(defaultText);
		expect(await readFile(qualifiedFile, "utf8")).toBe(qualifiedText);
	});

	it("keeps provider/project precedence and only updates fields accepted by native role type", { timeout: 120_000 }, async () => {
		const userSettings = { defaultProvider: "fixture", defaultModel: "fixture/shared-model", subagents: { defaultModel: "fixture/shared-model", agentOverrides: { reviewer: { model: "fixture/review-model", description: "User description" } } } };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ ...userSettings, packages: ["npm:pi-subagents"] }));
		const projectSettingsPath = path.join(fixture.cwd, ".pi", "settings.json");
		const projectSettings = { subagents: { defaultModel: "fixture/review-model", agentOverrides: { reviewer: { model: "inherit", description: "Project description" } }, agentOverridesByProvider: { fixture: { reviewer: { model: "fixture/project-model" } } } } };
		await writeFile(projectSettingsPath, JSON.stringify(projectSettings));
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await writeCatalog({ review: { subagents: { defaultModel: "fixture/shared-model", agentOverrides: { reviewer: { model: "fixture/shared-model", description: "Profile description", advertise: true } } } } });
		await start("review");
		const models = await inspectModels("reviewer");
		expect(models).toContain(`Effective model:
  fixture/project-model`);
		expect(models).toContain("Source: project override");
		const generated = JSON.parse(await readFile(path.join(await soleInstanceDir(fixture), "settings.json"), "utf8"));
		expect(generated.subagents.agentOverrides.reviewer).toEqual({ model: "fixture/shared-model", description: "Profile description", advertise: true });
		expect(await readFile(projectSettingsPath, "utf8")).toBe(JSON.stringify(projectSettings));
	});

	it("uses actual file metadata, preserves pinned and unadvertised roles, and respects runtime-role limits", { timeout: 120_000 }, async () => {
		const agentsDir = path.join(fixture.agentDir, "agents");
		await mkdir(agentsDir, { recursive: true });
		const roleFile = path.join(agentsDir, "custom-reviewer.md");
		const originalPrompt = "---\nname: custom-reviewer\ndescription: File role\nmodel: fixture/review-model\n---\nOriginal system prompt.\n";
		await writeFile(roleFile, originalPrompt);
		const quietRole = path.join(agentsDir, "quiet-role.md");
		const quietPrompt = "---\nname: quiet-role\ndescription: Not advertised\nmodel: fixture/shared-model\n---\nQuiet role prompt.\n";
		await writeFile(quietRole, quietPrompt);
		const runtimeExtension = path.join(fixture.agentDir, "extensions", "runtime-role.ts");
		await writeFile(runtimeExtension, `import { writeFileSync } from "node:fs";\nexport default (pi) => { pi.on("session_start", () => { const request = { version: 1, name: "runtime-reviewer", definition: { description: "Runtime-owned description", systemPrompt: "Runtime prompt", model: "fixture/shared-model", tools: [] } }; pi.events.emit("pi-subagents:runtime-agent-register:v1", request); writeFileSync(${JSON.stringify(path.join(fixture.root, "runtime-registration.json"))}, JSON.stringify(request.result)); }); };\n`);
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents"], defaultProvider: "fixture", defaultModel: "fixture/shared-model", retry: { enabled: false } }));
		await writeCatalog({ review: { extensions: ["pi-subagents", "local-provider"], subagents: { defaultModel: "fixture/shared-model", agentOverrides: { "custom-reviewer": { description: "Profile reviewer description", advertise: true }, "quiet-role": { description: "Must stay hidden", advertise: false }, "runtime-reviewer": { model: "fixture/review-model", thinking: "high", description: "Must remain extension-owned", advertise: true }, "not-yet-registered": { model: "fixture/review-model" } } } } });
		const probe = await writeRuntimeProbe();
		await start("review", ["-e", runtimeExtension, "-e", probe.extensionPath]);
		expect(await toolRequestEvents(probe.toolRequestPath)).toEqual([]);
		const registration = JSON.parse(await readFile(path.join(fixture.root, "runtime-registration.json"), "utf8"));
		expect(registration).toMatchObject({ ok: true });
		const fileMapping = await inspectModels("custom-reviewer");
		expect(fileMapping).toContain("fixture/review-model");
		const allMappings = await inspectModels();
		for (const role of ["custom-reviewer", "quiet-role", "runtime-reviewer", "scout"]) expect(allMappings).toContain(role);
		expect(allMappings).not.toContain("not-yet-registered");
		expect(allMappings).toContain("fixture/shared-model");
		const runtimeMapping = await inspectModels("runtime-reviewer");
		expect(runtimeMapping).toContain("fixture/review-model");
		expect(runtimeMapping).toContain("high");
		const customMetadata = await inspectAgentMetadata("custom-reviewer");
		expect(customMetadata).toContain("Description: Profile reviewer description");
		expect(customMetadata).toContain(`System Prompt:
Original system prompt.`);
		expect(customMetadata).not.toContain(`System Prompt:
Profile reviewer description`);
		const quietMetadata = await inspectAgentMetadata("quiet-role");
		expect(quietMetadata).toContain("Agent: quiet-role (");
		expect(quietMetadata).toContain("Description: Must stay hidden");
		const runtimeMetadata = await inspectAgentMetadata("runtime-reviewer");
		expect(runtimeMetadata).toContain("Description: Runtime-owned description");
		expect(runtimeMetadata).toContain(`System Prompt:
Runtime prompt`);
		expect(runtimeMetadata).not.toContain("Must remain extension-owned");

		await rpc!.send({ type: "prompt", message: "Capture the current session prompt." }, 15_000).catch(() => undefined);
		const captured = await readRuntimeProbe(probe.outputPath, true);
		const promptSections = JSON.stringify(captured.sections ?? {});
		expect(promptSections).toContain("custom-reviewer");
		expect(promptSections).toContain("Profile reviewer description");
		expect(promptSections).not.toContain("quiet-role");
		expect(promptSections).not.toContain("Must stay hidden");
		expect(promptSections).not.toContain("runtime-reviewer");
		const registered = captured.registered as Array<{ name: string }>;
		expect(registered.some((tool) => tool.name === "subagent")).toBe(true);
		expect(captured.active).toContain("subagent");
		expect(await readFile(roleFile, "utf8")).toBe(originalPrompt);
		expect(await readFile(quietRole, "utf8")).toBe(quietPrompt);
		expect(await toolRequestEvents(probe.toolRequestPath)).toEqual([]);
	});

	it("recognizes CLI-loaded ownership when delegation is registered but inactive", { timeout: 120_000 }, async () => {
		await native.dispose();
		providerExtension = await addLocalProvider(fixture, { compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } });
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({}));
		await writeCatalog({ review: { extensions: [], subagents: { agentOverrides: { reviewer: { model: "fixture/review-model" } } } } });
		const probe = await writeRuntimeProbe();
		await start("review", ["-e", native.extensionPath, "-e", providerExtension, "-e", probe.extensionPath, "--model", "fixture/shared-model"]);

		const beforeStatus = await nativeSnapshot();
		expect(beforeStatus.model).toMatchObject({ provider: "fixture", id: "shared-model", api: "openai-completions", compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } });
		expect(beforeStatus.configPath).toBe(path.join(beforeStatus.agentDir as string, "extensions", "subagent", "config.json"));
		expect(beforeStatus.configExists).toBe(false);
		const initialTools = beforeStatus.registered as Array<{ name: string; sourceInfo?: { path?: string } }>;
		expect(initialTools.some((tool) => tool.name === "subagent" && tool.sourceInfo?.path?.startsWith(native.packageRoot))).toBe(true);
		expect(beforeStatus.active).toContain("subagents_enable");
		expect(beforeStatus.active).not.toContain("subagent");

		const status = await statusMessages();
		expect(status).toContain('"extension":"detected"');
		expect(status).not.toContain("registration could not be confirmed");
		const afterStatus = await nativeSnapshot();
		expect(afterStatus.active).toEqual(beforeStatus.active);
		expect((afterStatus.registered as Array<{ name: string }>).map((tool) => tool.name)).toEqual(initialTools.map((tool) => tool.name));
		expect(JSON.stringify(rpc!.messages)).not.toContain('"mode":"single"');
	});

	it("recognizes trusted project-loaded ownership without reselecting it", { timeout: 120_000 }, async () => {
		await native.dispose();
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture/shared-model" }));
		const projectPackage = path.join(fixture.cwd, ".pi", "npm", "node_modules", "pi-subagents");
		await mkdir(path.dirname(projectPackage), { recursive: true });
		await (await import("node:fs/promises")).symlink(native.packageRoot, projectPackage, "dir");
		await writeFile(path.join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents"] }));
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));
		await writeCatalog({ review: { extensions: [], subagents: { defaultModel: "fixture/shared-model" } } });
		const probe = await writeRuntimeProbe();
		await start("review", ["-e", probe.extensionPath]);
		const registered = await rpc!.commandNames();
		expect(registered.some((command) => command.name === "subagents-models")).toBe(true);
		const status = await statusMessages();
		expect(status).toContain('"extension":"detected"');
		expect(status).not.toContain("registration could not be confirmed");
		expect(status).not.toContain('"mode":"single"');
		const probeData = await readRuntimeProbe(probe.outputPath);
		const owned = (probeData.registered as Array<{ sourceInfo?: { path?: string } }>).some((tool) => tool.sourceInfo?.path?.includes(".pi/npm/node_modules/pi-subagents"));
		expect(owned).toBe(true);
	});
});
