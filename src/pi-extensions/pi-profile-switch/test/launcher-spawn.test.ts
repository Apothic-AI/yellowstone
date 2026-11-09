import { describe, expect, it } from "vitest";

import { buildPiArgs } from "../src/launcher/spawn.ts";
import type { GeneratedRuntime } from "../src/settings-generator.ts";

const generated: GeneratedRuntime = {
	runtimeDir: "/tmp/runtime",
	env: { PI_CODING_AGENT_DIR: "/tmp/runtime" },
	warnings: [],
};

describe("buildPiArgs", () => {
	it("loads the pi-profile extension and forwards user args verbatim", () => {
		const args = buildPiArgs({ generated, piArgs: ["--mode", "rpc", "--continue"], trustOverride: undefined });
		expect(args[0]).toBe("-e");
		expect(args[1]).toContain("extensions/pi-profile/index.ts");
		expect(args.slice(2)).toEqual(["--mode", "rpc", "--continue"]);
	});

	it("re-applies a recorded --approve to the spawned pi", () => {
		const args = buildPiArgs({ generated, piArgs: [], trustOverride: true });
		expect(args).toContain("--approve");
	});

	it("re-applies a recorded --no-approve", () => {
		const args = buildPiArgs({ generated, piArgs: ["--mode", "rpc"], trustOverride: false });
		expect(args).toEqual(["-e", expect.any(String), "--no-approve", "--mode", "rpc"]);
	});
});
