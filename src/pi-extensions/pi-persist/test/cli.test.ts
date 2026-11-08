import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, USAGE } from "../src/cli.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A temp agent dir and a temp working directory, so no test touches the real config. */
function fixture(): { agentDir: string; cwd: string } {
	return {
		agentDir: mkdtempSync(join(tmpdir(), "pi-persist-cli-agent-")),
		cwd: mkdtempSync(join(tmpdir(), "pi-persist-cli-cwd-")),
	};
}

function run(args: string[], options: { cwd: string; agentDir: string }) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		cwd: options.cwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
		encoding: "utf8",
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

describe("argument parsing", () => {
	test("treats --project as a standalone flag", () => {
		const { positional, flags } = parseArgs(["add", "clock", "12:00", "--project"]);
		expect(positional).toEqual(["add", "clock", "12:00"]);
		expect(flags.get("project")).toBe("true");
	});

	test("--project does not swallow the argument that follows it", () => {
		const { positional, flags } = parseArgs(["--project", "add", "clock"]);
		expect(positional).toEqual(["add", "clock"]);
		expect(flags.get("project")).toBe("true");
	});

	test("value flags still require a value", () => {
		expect(() => parseArgs(["add", "clock", "--channel"])).toThrow();
		expect(() => parseArgs(["add", "clock", "--channel", "--project"])).toThrow();
	});

	test("documents the project target", () => {
		expect(USAGE).toContain("--project");
		expect(USAGE).toContain(".pi/pi-persist.json");
	});
});

describe("project file commands", () => {
	test("add --project writes the project items file, not the global one", () => {
		const options = fixture();
		const result = run(["add", "repo_notes", "project only", "--project"], options);

		expect(result.code).toBe(0);
		expect(result.out).toContain(join(options.cwd, ".pi", "pi-persist.json"));
		const written = JSON.parse(readFileSync(join(options.cwd, ".pi", "pi-persist.json"), "utf8"));
		expect(written.items).toEqual([{ id: "repo_notes", channel: "trailing", content: "project only" }]);
	});

	test("list shows both layers and marks the override", () => {
		const options = fixture();
		run(["add", "clock", "global clock"], options);
		run(["add", "clock", "project clock", "--project"], options);
		run(["add", "repo_notes", "project only", "--project"], options);

		const result = run(["list"], options);

		expect(result.code).toBe(0);
		expect(result.out).toContain("project file:");
		expect(result.out).toContain("project clock");
		expect(result.out).toContain("overriding global: trailing:clock");
		// The global value is replaced, not listed alongside.
		expect(result.out).not.toContain("global clock");
	});

	test("remove --project only touches the project file", () => {
		const options = fixture();
		run(["add", "clock", "global clock"], options);
		run(["add", "clock", "project clock", "--project"], options);

		const result = run(["remove", "clock", "--project"], options);

		expect(result.code).toBe(0);
		expect(JSON.parse(readFileSync(join(options.cwd, ".pi", "pi-persist.json"), "utf8")).items).toEqual([]);
		const global = JSON.parse(readFileSync(join(options.agentDir, "pi-persist.json"), "utf8"));
		expect(global.items).toEqual([{ id: "clock", channel: "trailing", content: "global clock" }]);
	});

	test("remove --project reports the file it searched", () => {
		const options = fixture();
		const result = run(["remove", "missing", "--project"], options);

		expect(result.code).toBe(2);
		expect(result.err).toContain(join(options.cwd, ".pi", "pi-persist.json"));
	});
});
