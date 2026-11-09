/**
 * The shipped JSON schemas validate the shipped examples, and the
 * validator agrees with the runtime parsers on the loadable surface
 * (schema-valid files parse; the parser's rejections are schema-invalid).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseProfileDefinition, ProfileCatalog } from "../src/profile-catalog.ts";
import { createPiFixture } from "./helpers/pi-fixture.ts";

const Ajv2020 = Ajv2020Module.default;

// ajv/dist/2020: draft 2020-12 support (propertyNames + const).
// Fresh instance per use — compile() registers $id and refuses duplicates.
const newAjv = () => new Ajv2020({ strict: true });

async function loadSchema(name: string) {
	return JSON.parse(await readFile(path.resolve("schemas", name), "utf8"));
}

describe("shipped JSON schemas", () => {
	it("profiles schema validates the shipped install-time starter", async () => {
		const profiles = await loadSchema("profiles.schema.json");
		const starter = JSON.parse(await readFile(path.resolve("examples/ask.json"), "utf8"));

		const ajv = newAjv();
		expect(ajv.validate(profiles, starter), JSON.stringify(ajv.errors)).toBe(true);
	});

	it("profiles schema validates the shipped complete example", async () => {
		const profiles = await loadSchema("profiles.schema.json");
		const example = JSON.parse(await readFile(path.resolve("examples/example.json"), "utf8"));

		const ajv = newAjv();
		expect(ajv.validate(profiles, example), JSON.stringify(ajv.errors)).toBe(true);
	});

	it("the profiles schema rejects inheritance keys and wrong types", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ extends: "base" })).toBe(false);
		expect(validate({ skills: "oops" })).toBe(false);
		expect(validate({ defaultProvider: 123 })).toBe(false);
	});

	it("documents tools as non-MCP built-in and extension tools", async () => {
		const schema = await loadSchema("profiles.schema.json");
		const description = schema.properties.tools.description as string;

		expect(description).toContain("non-MCP Pi built-ins");
		expect(description).toContain("non-MCP extension tools");
		expect(description).toContain("mcp_tools");
	});

	it("the profiles schema accepts valid mcp_tools declarations", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({})).toBe(true);
		expect(validate({ mcp_tools: {} })).toBe(true);
		expect(validate({ mcp_tools: { github: [] } })).toBe(true);
		expect(validate({ mcp_tools: { github: ["search", "github_search", "create_issue"], linear: [] } })).toBe(true);
	});

	it("the profiles schema and catalog parser agree on managed subagent declarations", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));
		const valid = [
			{}, { subagents: {} }, { subagents: { agentOverrides: { reviewer: {} } } },
			... ["reviewer role", "reviewer\trole"].map((name) => ({ subagents: { agentOverrides: { [name]: { model: "x" } } } })),
			JSON.parse('{"subagents":{"defaultModel":"inherit","defaultThinking":"high","agentOverrides":{"reviewer":{"model":false,"thinking":false,"description":"Review","advertise":false},"toString":{"advertise":true},"__proto__":{"model":"native"}}}}'),
		];
		const invalid = [
			{ subagents: null }, { subagents: { tools: [] } },
			{ subagents: { defaultModel: " " } }, { subagents: { defaultThinking: "invalid" } },
			{ subagents: { agentOverrides: { " reviewer": { model: "x" } } } },
			{ subagents: { agentOverrides: { "review*": { model: "x" } } } },
			... ["reviewer\nrole", "reviewer\rrole", "reviewer\u2028role", "reviewer\u2029role"].map((name) => ({ subagents: { agentOverrides: { [name]: { model: "x" } } } })),
			{ subagents: { agentOverrides: { reviewer: { tools: [] } } } },
			{ subagents: { agentOverrides: { reviewer: { advertise: "false" } } } },
		];
		for (const candidate of valid) {
			expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
			expect(() => parseProfileDefinition("schema-case", candidate)).not.toThrow();
		}
		for (const candidate of invalid) {
			expect(validate(candidate)).toBe(false);
			expect(() => parseProfileDefinition("schema-case", candidate)).toThrow();
		}
	});

	it("the profiles schema accepts an empty mcps array", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ mcps: [] })).toBe(true);
	});

	it("the profiles schema accepts literal tool names and prototype-looking server names as JSON data", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));
		const profile = JSON.parse('{"mcp_tools":{"toString":["search"],"__proto__":["fixture_search"]}}');

		expect(validate(profile), JSON.stringify(validate.errors)).toBe(true);
	});

	it("the profiles schema rejects invalid mcp_tools shapes and glob patterns", async () => {
		const validate = newAjv().compile(await loadSchema("profiles.schema.json"));

		expect(validate({ mcp_tools: "github" })).toBe(false);
		expect(validate({ mcp_tools: ["github"] })).toBe(false);
		expect(validate({ mcp_tools: { github: "search" } })).toBe(false);
		expect(validate({ mcp_tools: { github: [123] } })).toBe(false);
		expect(validate({ mcp_tools: { github: ["*"] } })).toBe(false);
		expect(validate({ mcp_tools: { github: ["search*"] } })).toBe(false);
		expect(validate({ mcp_tools: { github: ["search?"] } })).toBe(false);
		expect(validate({ mcp_tools: { github: ["search[0]"] } })).toBe(false);
		expect(validate({ mcp_tools: { "git*": ["search"] } })).toBe(false);
	});

	it("schema-valid catalogs load through the runtime parsers", async () => {
		const fixture = await createPiFixture();
		try {
			const profilesDir = path.join(fixture.profileSwitchDir, "profiles");
			await mkdir(profilesDir, { recursive: true });
			await writeFile(
				path.join(profilesDir, "impl.json"),
				await readFile(path.resolve("examples/example.json"), "utf8"),
			);
			const catalog = await ProfileCatalog.load(fixture.agentDir);
			expect((await catalog.resolve("impl"))?.definition.label).toBe("Implementation");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});
