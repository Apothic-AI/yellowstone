import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFile(path.resolve(file), "utf8");

function localLinks(markdown: string): string[] {
	return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
		.map((match) => match[1]!)
		.filter((target) => !/^[a-z]+:\/\//i.test(target) && !target.startsWith("#"));
}

/** The body of the first matching level-2 section, up to the next one. */
function section(markdown: string, heading: RegExp): string {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line));
	if (start === -1) return "";
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s/.test(line)) break;
		body.push(line);
	}
	return body.join("\n");
}

function fieldRows(markdown: string): Map<string, string> {
	return new Map([...markdown.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)]
		.map((match) => [match[1]!, match[2]!]));
}

function readmeScopeIssues(markdown: string, headings: readonly string[]): string[] {
	const prose = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
	const actual = [...prose.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1]!);
	const issues: string[] = [];
	if (JSON.stringify(actual) !== JSON.stringify(headings)) issues.push("unexpected top-level sections");
	if (/^#{2,6}[ \t]+(?:Migration\b|迁移|Architecture\b|架构|Design\b|设计|Release (?:history|notes)\b|Changelog\b|版本历史|发布说明|Implementation details\b|实现机制)/im.test(prose)) {
		issues.push("migration, release, or internal-design section");
	}
	for (const target of localLinks(prose)) {
		const normalized = path.posix.normalize(target.split("#", 1)[0]!);
		if (/^(?:docs\/(?:adr|architecture)|openspec\/specs)(?:\/|$)/.test(normalized)) {
			issues.push(`internal-document link: ${target}`);
		}
	}
	return issues;
}

function readmeRuleReferenceIssues(rules: string, config: string): string[] {
	const issues: string[] = [];
	if ([...rules.matchAll(/^### README authoring[ \t]*$/gm)].length !== 1) {
		issues.push("expected one canonical README authoring section");
	}
	if (!config.includes("AGENTS.md#readme-authoring")) issues.push("missing config reference to README authoring");
	return issues;
}

describe("resource-selection documentation", () => {
	it("architecture overview describes the per-kind control and native-base exclusions", async () => {
		const overview = await read("docs/architecture/overview.md");
		expect(overview).toContain("resourceSelection");
		expect(overview).toContain("disabledSkills");
		expect(overview).toContain("disabledExtensions");
		expect(overview).toMatch(/omitted field keeps Pi's native visibility/);
		expect(overview).toMatch(/Declared kind: whitelist/);
	});

	it("architecture overview documents the conditional extension mirror and rejects the superseded additive mechanism", async () => {
		const overview = await read("docs/architecture/overview.md");
		const model = section(overview, /^##\s+Filtering model$/);
		expect(model.length).toBeGreaterThan(0);
		expect(model).toMatch(/conditional symlink/i);
		expect(model).toMatch(/never deleted, adopted, or overwritten/i);
		expect(model).toMatch(/sweep skips the link without traversing/);
		// The default profile's own representation is retained while any generated
		// mirror from the session is removed, and a declared selection is refused
		// only via the same safety check.
		expect(model).toMatch(/default` profile removes only a mirror this session generated/i);
		expect(model).toMatch(/declared selection keeps the restrictive allowlist/i);
		// The superseded additive-directory mechanism must not remain in scope;
		// ordinary default additive wording elsewhere is not banned.
		expect(model).not.toMatch(/directory re-added because the instance's is profile-managed/i);
		expect(model).not.toMatch(/additively because the instance/i);
	});

	it("architecture overview documents the reload-safe failure presentation", async () => {
		const overview = await read("docs/architecture/overview.md");
		expect(overview).toContain("SwitchDeps.reportFailure");
		expect(overview).toMatch(/stderr/);
		expect(overview).toMatch(/stale/);
		expect(overview).toMatch(/before the rollback reload/i);
	});

	it("PRD success criterion 1 links to the resource-reference contract", async () => {
		const prd = await read("docs/prd.md");
		const criteria = section(prd, /^##\s+Success criteria$/);
		expect(criteria.length).toBeGreaterThan(0);
		const firstCriterion = criteria.split("\n").find((line) => /^1\./.test(line.trim())) ?? "";
		expect(firstCriterion).toContain("openspec/specs/resource-reference/spec.md");
		expect(firstCriterion).toMatch(/declared kind is a selection/);
	});

	it("keeps every relative link in the touched documents resolvable", async () => {
		for (const document of [
			"README.md",
			"README.zh-CN.md",
			"AGENTS.md",
			"docs/prd.md",
			"docs/architecture/overview.md",
		]) {
			const body = await read(document);
			for (const target of localLinks(body)) {
				const resolved = path.resolve(path.dirname(document), target.split("#", 1)[0]!);
				await expect(stat(resolved), `${document} -> ${target}`).resolves.toBeDefined();
			}
		}
	});

	it.each([
		["README.md", ["About", "Installation and usage", "Configuration"]],
		["README.zh-CN.md", ["工具介绍", "安装与使用", "配置详解"]],
	])("%s stays within the accepted user-guide scope", async (document, headings) => {
		expect(readmeScopeIssues(await read(document), headings)).toEqual([]);
	});

	it("scope checks reject unrelated sections and internal links without banning code examples", () => {
		const headings = ["About", "Installation and usage", "Configuration"];
		const base = headings.map((heading) => `## ${heading}\n`).join("\n");
		for (const extra of [
			"## Other content\n",
			"### Migration notes\n",
			"### 迁移说明\n",
			"### Architecture\n",
			"### Design decisions\n",
			"### Release history\n",
			"[Decision](./docs/adr/0001.md)\n",
			"[Architecture](docs/architecture/overview.md)\n",
			"[Contract](openspec/specs/profile-catalog/spec.md#requirements)\n",
		]) {
			expect(readmeScopeIssues(`${base}\n${extra}`, headings), extra).not.toEqual([]);
		}
		expect(readmeScopeIssues(`${base}\n[Schema](schemas/profiles.schema.json)\n`, headings)).toEqual([]);
		expect(readmeScopeIssues(`${base}\n\`\`\`text\n## Migration\n[Contract](openspec/specs/example/spec.md)\n\`\`\`\n`, headings)).toEqual([]);
	});

	it("config references the canonical README authoring rules", async () => {
		expect(readmeRuleReferenceIssues(await read("AGENTS.md"), await read("openspec/config.yaml"))).toEqual([]);
	});

	it("rule-reference checks reject a missing, duplicate, or unreferenced rule section", () => {
		const rules = "### README authoring\n";
		const config = "README authoring principles are defined in AGENTS.md#readme-authoring.\n";
		expect(readmeRuleReferenceIssues(rules, config)).toEqual([]);
		expect(readmeRuleReferenceIssues("", config)).not.toEqual([]);
		expect(readmeRuleReferenceIssues(`${rules}\n${rules}`, config)).not.toEqual([]);
		expect(readmeRuleReferenceIssues(rules, "")).not.toEqual([]);
	});

	it.each([
		["README.md", /^##\s+Configuration$/],
		["README.zh-CN.md", /^##\s+配置详解$/],
	])("%s documents explicit empty selections in its configuration guide", async (document, heading) => {
		const guidance = section(await read(document), heading);
		expect(guidance.length).toBeGreaterThan(0);
		expect(guidance).toContain('"skills": []');
		expect(guidance).toContain('"extensions": []');
		expect(guidance).toContain("schemas/profiles.schema.json");
	});

	it.each([
		["README.md", /^##\s+Configuration$/],
		["README.zh-CN.md", /^##\s+配置详解$/],
	])("%s configuration covers schema fields regardless of table alignment", async (document, heading) => {
		const schema = JSON.parse(await read("schemas/profiles.schema.json"));
		const fields = fieldRows(section(await read(document), heading));
		for (const field of Object.keys(schema.properties)) {
			expect(fields.has(field), `${document}: missing field ${field}`).toBe(true);
		}
		for (const field of Object.keys(schema.properties.subagents.properties)) {
			expect(fields.has(`subagents.${field}`), `${document}: missing subagent field ${field}`).toBe(true);
		}
		const roleFields = schema.properties.subagents.properties.agentOverrides.additionalProperties.properties;
		for (const field of Object.keys(roleFields)) {
			expect(fields.has(`subagents.agentOverrides.<name>.${field}`), `${document}: missing role field ${field}`).toBe(true);
		}
	});

	it("keeps field types and runnable command examples synchronized between READMEs", async () => {
		const english = await read("README.md");
		const chinese = await read("README.zh-CN.md");
		expect(fieldRows(english)).toEqual(fieldRows(chinese));
		const commands = (markdown: string) => [...markdown.matchAll(/```(?:bash|text)\n([\s\S]*?)\n```/g)]
			.flatMap((match) => match[1]!.split("\n"))
			.map((line) => line.trim())
			.filter((line) => /^(?:npm |pi-profile(?: |$)|\/profile(?: |$))/.test(line));
		expect(commands(english).length).toBeGreaterThan(0);
		expect(commands(english)).toEqual(commands(chinese));
	});
});
