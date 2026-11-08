import { describe, expect, test } from "bun:test";
import {
	detectEnvironment,
	detectShell,
	type EnvironmentFacts,
	escapeXml,
	renderEnvironment,
	sanitizeEnvValue,
} from "../src/environment.ts";

const facts: EnvironmentFacts = {
	cwd: "/home/u/project",
	shell: "/bin/bash",
	platform: "linux",
	arch: "x64",
};

describe("escaping", () => {
	test("escapes the five XML metacharacters", () => {
		expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
	});

	test("collapses whitespace so a multi-line value stays on one element", () => {
		expect(sanitizeEnvValue("a\n\tb   c")).toBe("a b c");
	});

	test("escapes after collapsing, so injected markup cannot survive", () => {
		expect(sanitizeEnvValue("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
	});
});

describe("shell detection", () => {
	test("reports the shell pi spawns, not the user's login shell", () => {
		const previous = process.env.SHELL;
		process.env.SHELL = "/usr/bin/zsh";
		try {
			// Pi resolves /bin/bash (or bash on PATH, or sh); $SHELL is the interactive shell and
			// describes a different program than the one commands actually run in.
			expect(detectShell().shell).not.toBe("/usr/bin/zsh");
			expect(detectShell().shell).toMatch(/bash|sh$/);
		} finally {
			if (previous === undefined) delete process.env.SHELL;
			else process.env.SHELL = previous;
		}
	});
});

describe("renderEnvironment", () => {
	test("renders the body only, because pi supplies the outer tag", () => {
		const section = renderEnvironment(facts);
		// Emitting our own wrapper would nest <environment_context> inside pi's identical one.
		expect(section).not.toContain("<environment_context>");
		expect(section.startsWith("  <cwd>")).toBe(true);
		expect(section).toContain("  <shell>/bin/bash</shell>");
		// Volatile values are deliberately absent: they belong in a per-turn message, where a change
		// does not re-render the cached prompt prefix.
		expect(section).not.toContain("current_date");
		expect(section).not.toContain("timezone");
	});

	test("omits requested fields and skips contributions that render empty", () => {
		const section = renderEnvironment(facts, {
			omit: ["cwd", "arch"],
			blocks: [
				{ id: "empty", content: "   " },
				{ id: "kept", content: "value" },
			],
		});
		expect(section).not.toContain("<cwd>");
		expect(section).not.toContain("<arch>");
		expect(section).not.toContain("<empty>");
		expect(section).toContain("  <kept>value</kept>");
	});

	test("sorts blocks by id regardless of input order", () => {
		const blocks = [
			{ id: "zulu", content: "z" },
			{ id: "alpha", content: "a" },
			{ id: "mike", content: "m" },
		];
		const first = renderEnvironment(facts, { blocks });
		const reversed = renderEnvironment(facts, { blocks: [...blocks].reverse() });
		expect(first).toBe(reversed);
		expect(first.indexOf("<alpha>")).toBeLessThan(first.indexOf("<mike>"));
		expect(first.indexOf("<mike>")).toBeLessThan(first.indexOf("<zulu>"));
	});

	test("renders block attributes, escaped", () => {
		const section = renderEnvironment(facts, {
			blocks: [{ id: "mode", attributes: { name: 'a"b<c' }, content: "x" }],
		});
		expect(section).toContain('<mode name="a&quot;b&lt;c">x</mode>');
	});

	test("drops blocks whose id is not a valid tag name", () => {
		const section = renderEnvironment(facts, {
			blocks: [
				{ id: "bad id", content: "nope" },
				{ id: "9leading", content: "nope" },
				{ id: "good", content: "yep" },
			],
		});
		expect(section).not.toContain("bad id");
		expect(section).not.toContain("9leading");
		expect(section).toContain("<good>yep</good>");
	});

	test("is byte-identical across calls, which is what keeps the prompt cache warm", () => {
		const build = () => renderEnvironment(detectEnvironment("/tmp/x"));
		expect(build()).toBe(build());
	});

	test("returns empty string when every field is omitted and no blocks remain", () => {
		const section = renderEnvironment(facts, {
			omit: ["cwd", "shell", "platform", "arch"],
		});
		expect(section).toBe("");
	});
});
