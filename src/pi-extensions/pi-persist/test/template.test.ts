import { describe, expect, test } from "bun:test";
import { builtinNames, formatDatetime, isBuiltin, isDatetimeVariant } from "../src/builtins.ts";
import { expandTemplate, expandTemplateWithReport } from "../src/template.ts";

/** Never spawn a process in a test: record the command and return a canned answer. */
function fakeExec(answers: Record<string, string | undefined>) {
	const calls: string[] = [];
	return {
		calls,
		exec: (command: string) => {
			calls.push(command);
			const output = answers[command];
			return output === undefined ? { error: "command failed" } : { output };
		},
	};
}

const context = (overrides: Partial<Parameters<typeof expandTemplate>[1]> = {}) => ({
	cwd: "/tmp/project",
	now: new Date("2026-10-28T00:52:00Z"),
	exec: fakeExec({}).exec,
	...overrides,
});

describe("datetime built-in", () => {
	test("local carries a weekday, date, time and zone", () => {
		const text = formatDatetime(new Date("2026-10-28T00:52:00Z"), "local");
		// The weekday is the part a model most often gets wrong from a bare timestamp.
		expect(text).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /);
		expect(text).toMatch(/\d{2}\/\d{2}\/\d{4}/);
		expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
		expect(text).toMatch(/[A-Z]{2,5}|GMT|UTC/);
	});

	test("variants are distinct and well formed", () => {
		const at = new Date("2026-10-28T00:52:00Z");
		expect(formatDatetime(at, "iso")).toBe("2026-10-28T00:52:00.000Z");
		expect(formatDatetime(at, "unix")).toBe(String(Math.floor(at.getTime() / 1000)));
		expect(formatDatetime(at, "date")).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
		expect(formatDatetime(at, "time")).toMatch(/^\d{2}:\d{2}:\d{2}/);
	});

	test("an unknown variant falls back to local rather than throwing", () => {
		const at = new Date("2026-10-28T00:52:00Z");
		expect(formatDatetime(at, "nonsense" as never)).toBe(formatDatetime(at, "local"));
		expect(isDatetimeVariant("nonsense")).toBe(false);
	});

	test("datetime is the registry's only built-in for now", () => {
		expect(builtinNames()).toEqual(["datetime"]);
		expect(isBuiltin("datetime")).toBe(true);
		expect(isBuiltin("env")).toBe(false);
	});
});

describe("template expansion", () => {
	test("expands the default datetime, weekday included", () => {
		const text = expandTemplate("{{datetime}}", context());
		expect(text).toContain("28/10/2026");
		expect(text).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /);
	});

	test("expands a variant argument", () => {
		expect(expandTemplate("{{datetime:iso}}", context())).toBe("2026-10-28T00:52:00.000Z");
	});

	test("tolerates inner whitespace", () => {
		expect(expandTemplate("{{ datetime:iso }}", context())).toBe("2026-10-28T00:52:00.000Z");
	});

	test("exec runs the command and substitutes trimmed stdout", () => {
		const exec = fakeExec({ "echo $HOME": "/home/u", date: "now" });
		const text = expandTemplate("{{exec:echo $HOME}} at {{exec:date}}", context({ exec: exec.exec }));
		expect(text).toBe("/home/u at now");
		expect(exec.calls).toEqual(["echo $HOME", "date"]);
	});

	test("exec receives the cwd so commands run in the project", () => {
		const seen: string[] = [];
		expandTemplate("{{exec:pwd}}", {
			cwd: "/tmp/project",
			exec: (_command, options) => {
				seen.push(options.cwd);
				return { output: options.cwd };
			},
		});
		expect(seen).toEqual(["/tmp/project"]);
	});

	test("a failed command leaves its placeholder verbatim and reports it", () => {
		const exec = fakeExec({});
		const { text, unresolved } = expandTemplateWithReport("a {{exec:false}} b", context({ exec: exec.exec }));
		expect(text).toBe("a {{exec:false}} b");
		expect(unresolved).toEqual(["{{exec:false}}"]);
	});

	test("an empty exec argument never spawns anything", () => {
		const exec = fakeExec({});
		expandTemplateWithReport("{{exec:}}", context({ exec: exec.exec }));
		expect(exec.calls).toEqual([]);
	});

	test("unknown names are preserved and reported, with no env fallback", () => {
		// A bare {{NAME}} typo must not silently read an environment variable.
		const { text, unresolved } = expandTemplateWithReport("{{HOME}} {{nope:a}}", context());
		expect(text).toBe("{{HOME}} {{nope:a}}");
		expect(unresolved).toEqual(["{{HOME}}", "{{nope:a}}"]);
	});

	test("a later built-in cannot be shadowed by an exec of the same name", () => {
		const exec = fakeExec({ "echo builtin-collision": "collided" });
		const { text } = expandTemplateWithReport("{{exec:echo builtin-collision}}", context({ exec: exec.exec }));
		expect(text).toBe("collided");
	});

	test("expands several placeholders in one string in order", () => {
		const exec = fakeExec({ "git rev-parse --abbrev-ref HEAD": "main" });
		const text = expandTemplate(
			"{{datetime:date}} on {{exec:git rev-parse --abbrev-ref HEAD}}",
			context({ exec: exec.exec }),
		);
		expect(text).toBe("28/10/2026 on main");
	});

	test("leaves text with no placeholders untouched", () => {
		expect(expandTemplate("plain text", context())).toBe("plain text");
	});

	test("does not treat single braces as templates", () => {
		expect(expandTemplate("{ not a template }", context())).toBe("{ not a template }");
	});
});
