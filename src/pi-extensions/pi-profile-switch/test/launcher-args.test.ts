import { describe, expect, it } from "vitest";

import { parseLauncherArgs } from "../src/launcher/args.ts";

describe("parseLauncherArgs", () => {
	it("defaults to the default profile with no args", () => {
		expect(parseLauncherArgs([])).toEqual({ profile: undefined, piArgs: [], trustOverride: undefined });
	});

	it("takes an optional positional profile name", () => {
		expect(parseLauncherArgs(["review"]).profile).toBe("review");
		expect(parseLauncherArgs(["review"]).piArgs).toEqual([]);
	});

	it("consumes one -- separator after the profile name", () => {
		expect(parseLauncherArgs(["review", "--", "--mode", "rpc"])).toEqual({
			profile: "review",
			piArgs: ["--mode", "rpc"],
			trustOverride: undefined,
		});
	});

	it("consumes a leading -- when no profile is given", () => {
		expect(parseLauncherArgs(["--", "--mode", "rpc"])).toEqual({
			profile: undefined,
			piArgs: ["--mode", "rpc"],
			trustOverride: undefined,
		});
	});

	it("passes arbitrary pi flags through verbatim, unknown ones included", () => {
		const parsed = parseLauncherArgs(["--", "--continue", "--no-session", "--model", "openai/gpt-5.4"]);
		expect(parsed.piArgs).toEqual(["--continue", "--no-session", "--model", "openai/gpt-5.4"]);
	});

	it("treats flags without a separator as pi args too", () => {
		expect(parseLauncherArgs(["review", "--mode", "rpc"]).piArgs).toEqual(["--mode", "rpc"]);
		expect(parseLauncherArgs(["--mode", "rpc"])).toEqual({
			profile: undefined,
			piArgs: ["--mode", "rpc"],
			trustOverride: undefined,
		});
	});

	it("keeps pi's own -- separator beyond the first one verbatim", () => {
		expect(parseLauncherArgs(["review", "--", "--mode", "rpc", "--", "@file.ts"]).piArgs).toEqual([
			"--mode",
			"rpc",
			"--",
			"@file.ts",
		]);
	});

	it("records --approve as a trust override input without forwarding it blindly", () => {
		expect(parseLauncherArgs(["--", "--approve", "--mode", "rpc"])).toEqual({
			profile: undefined,
			piArgs: ["--mode", "rpc"],
			trustOverride: true,
		});
	});

	it("records --no-approve and its short forms", () => {
		expect(parseLauncherArgs(["-a"]).trustOverride).toBe(true);
		expect(parseLauncherArgs(["-na"]).trustOverride).toBe(false);
		expect(parseLauncherArgs(["--no-approve"]).trustOverride).toBe(false);
	});
});
