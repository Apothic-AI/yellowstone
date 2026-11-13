/**
 * Composition unit suite — the pure merge, with no I/O stub beyond the module
 * under test.
 *
 * Case numbers (§1.x) refer to
 * `openspec/changes/2026-11-11-project-profile-append-composition/test-plan.md`;
 * the rows asserted here are `matrices.md` §1–§3 and §7. Identity-level
 * contributor union (a glob and a literal naming the same discovered
 * resource) is the resolver's job and is pinned by the resolver suite; here
 * the assertion is on the raw declaration map the resolver consumes.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CatalogError } from "../src/catalog-error.ts";
import type { ProfileDefinition } from "../src/profile-catalog.ts";
import {
	composeProfileDefinitions,
	PROMPT_STRATEGIES,
	resolvePromptStrategy,
	type CompositionResult,
	type ReferenceListKind,
} from "../src/profile-composition.ts";

const PROJECT_PATH = "/work/.pi/profiles/review.json";
const GLOBAL_PATH = "/home/user/.pi-profile-switch/profiles/review.json";
const KINDS: readonly ReferenceListKind[] = ["skills", "extensions", "mcps", "tools"];

/** A project half that declares the append strategy, plus whatever the case needs. */
function appendDefinition(definition: ProfileDefinition = {}): ProfileDefinition {
	return { ...definition, promptStrategy: "append" };
}

function compose(global: ProfileDefinition | undefined, project: ProfileDefinition): CompositionResult {
	return composeProfileDefinitions(global, project, { globalPath: GLOBAL_PATH, projectPath: PROJECT_PATH });
}

/** Composes one list kind: `undefined` means the field is absent from that half. */
function composeKind(kind: ReferenceListKind, globalList: string[] | undefined, projectList: string[] | undefined): CompositionResult {
	const global: ProfileDefinition = globalList === undefined ? {} : { [kind]: globalList };
	const project = appendDefinition(projectList === undefined ? {} : { [kind]: projectList });
	return compose(global, project);
}

function codes(result: CompositionResult): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

describe("matrix §1: omitted and empty declarations (existing base)", () => {
	for (const kind of KINDS) {
		it(`applies every omitted/empty row for ${kind}`, () => {
			const globalRefs = [`${kind}-global-1`, `${kind}-global-2`];
			const projectRefs = [`${kind}-project-1`];

			// — / — : kind undeclared; native visibility; nothing requested.
			const neither = composeKind(kind, undefined, undefined);
			expect(neither.definition[kind]).toBeUndefined();
			expect(neither.unapplied).toEqual([]);

			// — / [] : still undeclared, and nothing was requested so nothing is unapplied.
			const emptyProjectOnly = composeKind(kind, undefined, []);
			expect(emptyProjectOnly.definition[kind]).toBeUndefined();
			expect(emptyProjectOnly.unapplied).toEqual([]);
			expect(codes(emptyProjectOnly)).toEqual([]);

			// — / refs : undeclared; the project references are NOT applied and are unapplied.
			const unrestricted = composeKind(kind, undefined, projectRefs);
			expect(unrestricted.definition[kind]).toBeUndefined();
			expect(unrestricted.unapplied).toEqual([{ kind, reference: projectRefs[0], scope: "project" }]);

			// [] / — : the base declares an empty selection, so the composite is [].
			expect(composeKind(kind, [], undefined).definition[kind]).toEqual([]);

			// [] / [] : [].
			expect(composeKind(kind, [], []).definition[kind]).toEqual([]);

			// [] / refs : the project references widen the declared empty base.
			expect(composeKind(kind, [], projectRefs).definition[kind]).toEqual(projectRefs);

			// refs / — : the base's declarations survive.
			expect(composeKind(kind, globalRefs, undefined).definition[kind]).toEqual(globalRefs);

			// refs / [] : an empty project list contributes nothing.
			expect(composeKind(kind, globalRefs, []).definition[kind]).toEqual(globalRefs);

			// refs / refs : global-then-project order, one expansion later.
			expect(composeKind(kind, globalRefs, projectRefs).definition[kind]).toEqual([...globalRefs, ...projectRefs]);
		});
	}

	it("deduplicates raw tool references by exact string, and keeps duplicate non-tool references for identity dedupe", () => {
		const tools = compose({ tools: ["read", "grep"] }, appendDefinition({ tools: ["read", "edit"] }));
		expect(tools.definition.tools).toEqual(["read", "grep", "edit"]);

		// Skills dedupe by resolved identity at expansion time, so both halves'
		// identical literal is retained; its contributor is the union.
		const skills = compose({ skills: ["review"] }, appendDefinition({ skills: ["review"] }));
		expect(skills.definition.skills).toEqual(["review", "review"]);
		expect(skills.referenceContributors.skills).toEqual({ review: "both" });
	});
});

describe("matrix §1b: standalone append (no global file at all)", () => {
	it("applies the project lists in full with only the missing-base diagnostic", () => {
		const project = appendDefinition({ skills: ["a", "b"], tools: ["read", "edit"] });
		const result = compose(undefined, project);

		expect(result.branch).toBe("standalone");
		expect(result.definition).toEqual(project);
		expect(result.definition.skills).toEqual(["a", "b"]);
		expect(result.definition.tools).toEqual(["read", "edit"]);
		expect(result.unapplied).toEqual([]);
		expect(codes(result)).toEqual(["append-standalone"]);
		expect(result.referenceContributors.skills).toEqual({ a: "project", b: "project" });
		expect(result.referenceContributors.tools).toEqual({ read: "project", edit: "project" });
	});

	it("keeps a declared empty list as a declared empty selection", () => {
		const result = compose(undefined, appendDefinition({ skills: [] }));

		expect(result.definition.skills).toEqual([]);
		expect(result.unapplied).toEqual([]);
		expect(codes(result)).toEqual(["append-standalone"]);
	});

	it("leaves an omitted kind native and reports nothing as unapplied", () => {
		const result = compose(undefined, appendDefinition({ label: "Project" }));

		expect(result.definition.skills).toBeUndefined();
		expect(result.definition.extensions).toBeUndefined();
		expect(result.definition.mcps).toBeUndefined();
		expect(result.definition.tools).toBeUndefined();
		expect(result.definition.mcp_tools).toBeUndefined();
		expect(result.unapplied).toEqual([]);
		expect(result.diagnostics.map((entry) => entry.code)).not.toContain("append-unapplied-reference");
	});

	it("keeps scalars, instructions, child roles and mcp_tools as declared, with no merge step", () => {
		const project = appendDefinition({
			instructions: "Project only.",
			defaultThinkingLevel: "low",
			defaultProvider: "anthropic",
			defaultModel: "claude-x",
			subagents: { defaultModel: "openai/gpt-5.4" },
			mcp_tools: { github: ["search"] },
		});
		const result = compose(undefined, project);

		expect(result.definition).toEqual(project);
		expect(result.diagnostics.map((entry) => entry.code)).toEqual(["append-standalone"]);
	});

	it("never attributes a standalone selection to a global contributor", () => {
		const result = compose(undefined, appendDefinition({ skills: ["review"], extensions: ["pkg"] }));

		const contributors = Object.values(result.referenceContributors).flatMap((entries) => Object.values(entries));
		expect(contributors.length).toBe(2);
		expect(contributors.every((entry) => entry === "project")).toBe(true);

	});
});

describe("matrix §2: per-server mcp_tools", () => {
	it("drops a project entry for a server the base does not name and diagnoses it", () => {
		const result = compose({ mcp_tools: { linear: ["list"] } }, appendDefinition({ mcp_tools: { github: ["search"] } }));

		expect(result.definition.mcp_tools).toEqual({ linear: ["list"] });
		expect(result.definition.mcp_tools).not.toHaveProperty("github");
		expect(result.unapplied).toEqual([{ kind: "mcp_tools", reference: "github", scope: "project" }]);
		const diagnostic = result.diagnostics.find((entry) => entry.code === "append-cannot-narrow");
		expect(diagnostic?.reference).toBe("github");
		expect(diagnostic?.message).toContain('"github"');
		expect(diagnostic).toBeDefined();
	});

	it("drops a project deny-all entry for an unnamed server as a restriction too", () => {
		const result = compose({ mcp_tools: {} }, appendDefinition({ mcp_tools: { github: [] } }));

		expect(result.definition.mcp_tools).toEqual({});
		expect(result.diagnostics.map((entry) => entry.code)).toEqual(["append-cannot-narrow"]);
	});

	it("leaves both halves' unnamed servers unnamed", () => {
		const result = compose({}, appendDefinition({}));

		expect(result.definition.mcp_tools).toBeUndefined();
		expect(result.diagnostics).toEqual([]);
	});

	it("keeps the base policy when the project names no tools for a named server", () => {
		expect(compose({ mcp_tools: { github: ["a"] } }, appendDefinition({})).definition.mcp_tools).toEqual({ github: ["a"] });
		expect(compose({ mcp_tools: { github: ["a"] } }, appendDefinition({ mcp_tools: { github: [] } })).definition.mcp_tools).toEqual({ github: ["a"] });
	});

	it("widens a deny-all base", () => {
		expect(compose({ mcp_tools: { github: [] } }, appendDefinition({ mcp_tools: { github: ["search"] } })).definition.mcp_tools).toEqual({ github: ["search"] });
	});

	it("keeps an explicit deny-all when both halves deny all", () => {
		expect(compose({ mcp_tools: { github: [] } }, appendDefinition({ mcp_tools: { github: [] } })).definition.mcp_tools).toEqual({ github: [] });
	});

	it("unions a named server in global-then-project order with exact-string dedupe", () => {
		const result = compose({ mcp_tools: { github: ["a", "b"] } }, appendDefinition({ mcp_tools: { github: ["b", "c"] } }));

		expect(result.definition.mcp_tools).toEqual({ github: ["a", "b", "c"] });
		expect(result.diagnostics).toEqual([]);
	});

	it("never creates a server, enables one, or alters a server the base omits", () => {
		const result = compose({ mcp_tools: { github: ["a"] } }, appendDefinition({ mcp_tools: { github: ["b"], gitlab: ["x"] } }));

		expect(Object.keys(result.definition.mcp_tools ?? {})).toEqual(["github"]);
		expect(result.definition.mcp_tools).toEqual({ github: ["a", "b"] });
	});
});

describe("matrix §3: scalar and non-list fields", () => {
	it("inherits and overrides the model and thinking fields per field", () => {
		const inherited = compose({ defaultProvider: "openai", defaultModel: "gpt-5.4" }, appendDefinition({}));
		expect(inherited.definition.defaultProvider).toBe("openai");
		expect(inherited.definition.defaultModel).toBe("gpt-5.4");
		expect(inherited.definition.defaultThinkingLevel).toBeUndefined();

		const overridden = compose({ defaultProvider: "openai", defaultModel: "gpt-5.4" }, appendDefinition({ defaultProvider: "anthropic", defaultModel: "claude-x" }));
		expect(overridden.definition.defaultProvider).toBe("anthropic");
		expect(overridden.definition.defaultModel).toBe("claude-x");

		// A partial pair inherits the other half's field; the model pair is only
		// complete when both fields are present, evaluated by the existing path.
		const partial = compose({ defaultProvider: "openai", defaultModel: "gpt-5.4" }, appendDefinition({ defaultProvider: "anthropic" }));
		expect(partial.definition.defaultProvider).toBe("anthropic");
		expect(partial.definition.defaultModel).toBe("gpt-5.4");

		const thinking = compose({ defaultThinkingLevel: "high" }, appendDefinition({ defaultThinkingLevel: "medium" }));
		expect(thinking.definition.defaultThinkingLevel).toBe("medium");
	});

	it("concatenates instructions global-first and drops a byte-identical duplicate", () => {
		expect(compose({ instructions: "A" }, appendDefinition({ instructions: "B" })).definition.instructions).toBe("A\n\nB");
		expect(compose({ instructions: "A" }, appendDefinition({ instructions: "A" })).definition.instructions).toBe("A");
		expect(compose({ instructions: "A" }, appendDefinition({})).definition.instructions).toBe("A");
		expect(compose({}, appendDefinition({ instructions: "B" })).definition.instructions).toBe("B");
		// An absent or empty half adds no separator and no invented content.
		expect(compose({ instructions: "" }, appendDefinition({ instructions: "B" })).definition.instructions).toBe("B");
		expect(compose({ instructions: "A" }, appendDefinition({ instructions: "" })).definition.instructions).toBe("A");
	});

	it("replaces native child-role settings as a whole field without merging keys", () => {
		const result = compose(
			{ subagents: { defaultModel: "model-a", agentOverrides: { reviewer: { thinking: "high" } } } },
			appendDefinition({ subagents: { agentOverrides: { reviewer: { model: "inherit" } } } }),
		);

		expect(result.definition.subagents).toEqual({ agentOverrides: { reviewer: { model: "inherit" } } });
		expect(result.definition.subagents).not.toHaveProperty("defaultModel");
	});

	it("does not inherit an undeclared child-role declaration", () => {
		const result = compose({ subagents: { defaultModel: "model-a" } }, appendDefinition({}));

		expect(result.definition.subagents).toBeUndefined();
	});

	it("inherits presentation fields", () => {
		const result = compose({ label: "Base", description: "Base description" }, appendDefinition({}));

		expect(result.definition.label).toBe("Base");
		expect(result.definition.description).toBe("Base description");
	});
});

describe("diagnostics (§1.5)", () => {
	it("names the file and the verbatim reference for an unapplied reference, and says it was not validated", () => {
		const result = compose({}, appendDefinition({ skills: ["review", "internal-*"] }));

		expect(codes(result)).toEqual(["append-unapplied-reference", "append-unapplied-reference"]);
		expect(result.unapplied).toEqual([
			{ kind: "skills", reference: "review", scope: "project" },
			{ kind: "skills", reference: "internal-*", scope: "project" },
		]);
		const [first, second] = result.diagnostics;
		expect(first?.reference).toBe("review");
		expect(first?.message).toContain(PROJECT_PATH);
		expect(first?.message).toContain('"review"');
		expect(first?.message).toContain('"skills"');
		expect(first?.message).toContain("not validated against discovery");
		expect(second?.reference).toBe("internal-*");
		// An unapplied reference is never a warning about an unknown or zero-match reference.
		expect(first?.message).not.toContain("unknown");
		expect(first?.message).not.toContain("matched nothing");
	});

	it("names the absent base for the standalone diagnostic", () => {
		const withPath = compose(undefined, appendDefinition({}));
		expect(withPath.diagnostics).toHaveLength(1);
		expect(withPath.diagnostics[0]?.code).toBe("append-standalone");
		expect(withPath.diagnostics[0]?.reference).toBeUndefined();
		expect(withPath.diagnostics[0]?.message).toContain(PROJECT_PATH);
		expect(withPath.diagnostics[0]?.message).toContain(GLOBAL_PATH);

		const withoutPath = composeProfileDefinitions(undefined, appendDefinition({}), { projectPath: PROJECT_PATH });
		expect(withoutPath.diagnostics[0]?.message).toContain(PROJECT_PATH);
		expect(withoutPath.diagnostics[0]?.message).not.toContain(" at ");
	});

	it("reports an unapplied per-server entry with its server key", () => {
		const result = compose({ mcp_tools: { linear: [] } }, appendDefinition({ mcp_tools: { github: ["search"] } }));
		const diagnostic = result.diagnostics.find((entry) => entry.code === "append-cannot-narrow");

		expect(diagnostic?.reference).toBe("github");
		expect(diagnostic?.message).toContain(PROJECT_PATH);
		expect(diagnostic?.message).toContain("cannot introduce a restriction");
		expect(diagnostic?.message).toContain("replacement strategy");
	});
});

describe("contributor sets (§1.6)", () => {
	it("reports both scopes for an identical literal, and unions duplicate declarations idempotently", () => {
		const result = compose({ skills: ["review", "review"] }, appendDefinition({ skills: ["review", "review"] }));

		expect(result.referenceContributors.skills).toEqual({ review: "both" });
	});

	it("retains both halves' raw declarations so an overlapping glob and literal can union later", () => {
		const result = compose({ skills: ["internal-*"] }, appendDefinition({ skills: ["internal-a"] }));

		expect(result.referenceContributors.skills).toEqual({ "internal-*": "global", "internal-a": "project" });
		// The union on the resolved identity is performed by the single expansion,
		// which is pinned by the resolver suite; the composer's obligation is that
		// neither declaration is collapsed or dropped here.
		expect(result.definition.skills).toEqual(["internal-*", "internal-a"]);
	});

	it("retains both halves' raw declarations for an extension alias and an entry name", () => {
		const result = compose({ extensions: ["pi-subagents"] }, appendDefinition({ extensions: ["pi-subagents:review"] }));

		expect(result.referenceContributors.extensions).toEqual({ "pi-subagents": "global", "pi-subagents:review": "project" });
	});

	it("keeps prototype-shaped references and server keys as own data", () => {
		const result = compose({ skills: ["__proto__"] }, appendDefinition({ skills: ["__proto__", "toString"] }));
		expect(Object.keys(result.referenceContributors.skills).sort()).toEqual(["__proto__", "toString"]);
		expect(Object.hasOwn(result.referenceContributors.skills, "__proto__")).toBe(true);
		expect(result.referenceContributors.skills["__proto__"]).toBe("both");
		expect(result.referenceContributors.skills["toString"]).toBe("project");

		const mcp = compose(
			JSON.parse('{"mcp_tools":{"__proto__":["a"]}}'),
			JSON.parse('{"promptStrategy":"append","mcp_tools":{"__proto__":["b"]}}'),
		);
		expect(Object.hasOwn(mcp.definition.mcp_tools!, "__proto__")).toBe(true);
		expect(mcp.definition.mcp_tools?.["__proto__"]).toEqual(["a", "b"]);
	});

	it("records each kind independently", () => {
		const result = compose(
			{ skills: ["a"], extensions: ["pkg"], mcps: ["github"], tools: ["read"] },
			appendDefinition({ skills: ["b"], extensions: ["other"], mcps: ["linear"], tools: ["edit"] }),
		);

		expect(result.referenceContributors).toEqual({
			skills: { a: "global", b: "project" },
			extensions: { pkg: "global", other: "project" },
			mcps: { github: "global", linear: "project" },
			tools: { read: "global", edit: "project" },
		});
	});
});

describe("negated glob guard (§1.7)", () => {
	for (const kind of KINDS) {
		it(`rejects a !-glob in the project append half for ${kind}`, () => {
			const reference = "!internal-*";

			expect(() => compose({ [kind]: ["internal-a"] }, appendDefinition({ [kind]: [reference] }))).toThrow(CatalogError);
			let error: unknown;
			try {
				compose({ [kind]: ["internal-a"] }, appendDefinition({ [kind]: [reference] }));
			} catch (caught) {
				error = caught;
			}
			const message = (error as Error).message;
			expect(message).toContain(PROJECT_PATH);
			expect(message).toContain(`"${reference}"`);
			expect(message).toContain("negation");
			expect(message).toContain("everything except");
		});
	}

	it("rejects it on the standalone branch too, because the inversion belongs to the project glob", () => {
		expect(() => compose(undefined, appendDefinition({ skills: ["!internal-*"] }))).toThrow(/everything except/);
	});

	it("leaves a global half's !-glob, a replacement value and a bare literal untouched", () => {
		// The global half keeps today's reading.
		const composedWithGlobalNegation = compose({ skills: ["!internal-*"] }, appendDefinition({}));
		expect(composedWithGlobalNegation.definition.skills).toEqual(["!internal-*"]);

		// A bare `!name` has no glob characters, so the resolver treats it as a
		// literal miss and the guard must not tighten that into a new rejection.
		const bareBang = compose({ skills: ["a"] }, appendDefinition({ skills: ["!internal"] }));
		expect(bareBang.definition.skills).toEqual(["a", "!internal"]);

		// A `!`-prefixed reference with only bracket punctuation is a literal to the
		// resolver's `*`/`?` glob reading, so it is not rejected here either.
		const bracket = compose({ skills: ["a"] }, appendDefinition({ skills: ["![ab]"] }));
		expect(bracket.definition.skills).toEqual(["a", "![ab]"]);
	});
});

describe("strategy contract (§1.8, §1.10)", () => {
	it("enumerates exactly append and replace", () => {
		expect(PROMPT_STRATEGIES).toEqual(["append", "replace"]);
		for (const strategy of PROMPT_STRATEGIES) {
			expect(resolvePromptStrategy(strategy, "project", { filePath: PROJECT_PATH })).toBe(strategy);
		}
	});

	it("treats an omitted project strategy as replace, and an explicit replace identically", () => {
		expect(resolvePromptStrategy(undefined, "project", {})).toBe("replace");
		expect(resolvePromptStrategy("replace", "project", {})).toBe("replace");
	});

	it("rejects any other value with the file, the profile and the accepted values", () => {
		for (const value of ["merge", "APPEND", "", 1, null, {}]) {
			let error: unknown;
			try {
				resolvePromptStrategy(value, "project", { profile: "review", filePath: PROJECT_PATH });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(CatalogError);
			const message = (error as Error).message;
			expect(message).toContain(PROJECT_PATH);
			expect(message).toContain('profile "review"');
			expect(message).toContain('"append" and "replace"');
			expect(message).not.toContain("unknown field");
		}
	});

	it("rejects append in a global definition and accepts replace there inertly", () => {
		expect(() => resolvePromptStrategy("append", "global", { profile: "review", filePath: GLOBAL_PATH })).toThrow(/no base to compose with/);
		expect(resolvePromptStrategy("replace", "global", { profile: "review", filePath: GLOBAL_PATH })).toBe("replace");
		expect(resolvePromptStrategy(undefined, "global", {})).toBe("replace");
	});

	it("refuses to compose a project half that is not append", () => {
		expect(() => compose({ skills: ["a"] }, { skills: ["b"] })).toThrow(/composition requires an append project definition/);
		expect(() => compose({ skills: ["a"] }, { skills: ["b"], promptStrategy: "replace" })).toThrow(/composition requires an append project definition/);
	});
});

describe("purity (§1.9)", () => {
	it("imports no filesystem, discovery, or clock surface", async () => {
		const source = await readFile(path.resolve("src/profile-composition.ts"), "utf8");
		const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]!);

		expect(imports.length).toBeGreaterThan(0);
		for (const specifier of imports) {
			expect(specifier, "composition must not read the filesystem").not.toMatch(/^node:/);
			expect(specifier, "composition must not import discovery or resolution").not.toMatch(/extension-discovery|profile-resolver|mcp-config|skill-registry/);
		}
		expect(imports).toContain("./catalog-error.ts");
		// The definition type is the only catalog coupling, and it is type-only.
		for (const specifier of imports.filter((entry) => entry === "./profile-catalog.ts")) {
			expect(source).toMatch(/import type \{[^}]*\} from "\.\/profile-catalog\.ts";/);
		}
		for (const clock of ["Date.now(", "new Date(", "performance.now(", "setTimeout(", "process.hrtime("]) {
			expect(source, `composition must not read a clock: ${clock}`).not.toContain(clock);
		}
	});
});
