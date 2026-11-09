import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseProfileDefinition } from "../src/profile-catalog.ts";

const Ajv2020 = Ajv2020Module.default;
const read = (file: string) => readFile(path.resolve(file), "utf8");

function localLinks(markdown: string): string[] {
	return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
		.map((match) => match[1]!)
		.filter((target) => !/^[a-z]+:\/\//i.test(target) && !target.startsWith("#"));
}

describe("subagent authoring documentation", () => {
	it("links install and authoring guidance to the schema and native inspection", async () => {
		const readme = await read("README.md");
		for (const phrase of ["schemas/profiles.schema.json", "/subagents-models", "does not load pi-subagents", "not child prompts", "not whether a role can run"]) {
			expect(readme).toContain(phrase);
		}
		const translated = await read("README.zh-CN.md");
		for (const phrase of ["schemas/profiles.schema.json", "/subagents-models", "不会加载 pi-subagents", "不是子 agent prompt", "不控制角色能否运行"]) {
			expect(translated).toContain(phrase);
		}

		const skill = await read("skills/profile-config/SKILL.md");
		for (const phrase of ["exact role overrides", "does not replace its system prompt", "does not disable the role", "not an availability list", "/profile status", "/subagents-models"]) {
			expect(skill).toContain(phrase);
		}
	});

	it.each(["README.md", "README.zh-CN.md"])("%s profile examples are valid for the schema and runtime parser", async (document) => {
		const schema = JSON.parse(await read("schemas/profiles.schema.json"));
		const validate = new Ajv2020({ strict: true }).compile(schema);
		const body = await read(document);
		const examples = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)];
		expect(examples.length).toBeGreaterThan(0);
		for (const [index, match] of examples.entries()) {
			const example = JSON.parse(match[1]!);
			expect(validate(example), `example ${index + 1}: ${JSON.stringify(validate.errors)}`).toBe(true);
			expect(() => parseProfileDefinition(`readme-${index + 1}`, example)).not.toThrow();
		}
	});

	it("keeps README JSON examples synchronized between languages", async () => {
		const examples = async (document: string) => [...(await read(document)).matchAll(/```json\n([\s\S]*?)\n```/g)]
			.map((match) => JSON.parse(match[1]!));
		const english = await examples("README.md");
		expect(english.length).toBeGreaterThan(0);
		expect(english).toEqual(await examples("README.zh-CN.md"));
	});

	it("keeps the example valid, linked targets present, and starter free of child declarations", async () => {
		const schema = JSON.parse(await read("schemas/profiles.schema.json"));
		const example = JSON.parse(await read("examples/example.json"));
		const validate = new Ajv2020({ strict: true }).compile(schema);
		expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
		expect(() => parseProfileDefinition("example", example)).not.toThrow();
		const starter = JSON.parse(await read("examples/ask.json"));
		expect(starter.subagents).toBeUndefined();

		for (const document of ["README.md", "README.zh-CN.md", "skills/profile-config/SKILL.md", "docs/prd.md", "docs/architecture/overview.md", "CONTEXT.md", "docs/adr/0017-native-subagent-settings-overrides.md"]) {
			const body = await read(document);
			for (const target of localLinks(body)) {
				const resolved = path.resolve(path.dirname(document), target.split("#", 1)[0]!);
				await expect(stat(resolved), `${document} -> ${target}`).resolves.toBeDefined();
			}
		}
	});

	it("keeps role overrides out of the selectable Resource glossary and links the ADR", async () => {
		const context = await read("CONTEXT.md");
		expect(context).toContain("Anything a profile can reference: a skill, extension, MCP server, or tool.");
		const resourceLine = context.split("\n").find((line) => line.startsWith("| **Resource**")) ?? "";
		expect(resourceLine).not.toMatch(/agent/i);
		const architecture = await read("docs/architecture/overview.md");
		expect(architecture).toContain("ADR-0017");
		expect(architecture).toContain("0017-native-subagent-settings-overrides.md");
		expect(architecture).toContain("same settings/plan snapshot boundary");
		expect(architecture).toContain("../../openspec/specs/in-session-switch/spec.md");
		const adr = await read("docs/adr/0017-native-subagent-settings-overrides.md");
		for (const decision of ["native-shaped subset", "sparsely patches", "Rejected alternatives", "availability list or disable policy"]) {
			expect(adr).toContain(decision);
		}
	});
});
