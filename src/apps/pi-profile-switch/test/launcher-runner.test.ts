import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { launcherEnv, nativeParentLauncherEnv } from "./helpers/launcher-runner.ts";

/**
 * Harness convention guard: integration tests never spawn the launcher
 * directly. Raw spawns reintroduce the stdin-EOF pitfall (pi reads stdin
 * until EOF; an open pipe keeps the launcher alive past the test timeout),
 * which the helpers in test/helpers/launcher-runner.ts solve exactly once:
 * `runLauncher` closes child stdin; `runLauncherRpc` wraps RpcDriver with
 * the fixture environment. */
describe("launcher-runner convention", () => {
	it("scopes native-parent mode-flag removal to an explicit cloned spawn environment", () => {
		const fixture = { root: "/fixture", cwd: "/fixture/project", agentDir: "/fixture/agent", profileSwitchDir: "/fixture/state" };
		const inherited: NodeJS.ProcessEnv = {
			HOME: "/original-home",
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENTS_HERDR_BRIDGE: "1",
			CUSTOM_RUNTIME_SETTING: "keep",
		};
		const original = { ...inherited };

		const defaultEnv = launcherEnv(fixture, inherited);
		const nativeParentEnv = nativeParentLauncherEnv(fixture, inherited);

		expect(defaultEnv.PI_SUBAGENT_CHILD).toBe("1");
		expect(defaultEnv.PI_SUBAGENTS_HERDR_BRIDGE).toBe("1");
		expect(nativeParentEnv.PI_SUBAGENT_CHILD).toBeUndefined();
		expect(nativeParentEnv.PI_SUBAGENTS_HERDR_BRIDGE).toBeUndefined();
		expect(nativeParentEnv).toMatchObject({
			HOME: fixture.root,
			PI_CODING_AGENT_DIR: fixture.agentDir,
			PI_OFFLINE: "1",
			CUSTOM_RUNTIME_SETTING: "keep",
		});
		expect(inherited).toEqual(original);
		expect(nativeParentEnv).not.toBe(inherited);
	});

	it("integration tests spawn the launcher only through runLauncher/runLauncherRpc", () => {
		const dir = path.resolve("test");
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".integration.test.ts"))
			.filter((name) => readFileSync(path.join(dir, name), "utf8").includes("execFile("));
		expect(
			offenders,
			"spawn the launcher via runLauncher/runLauncherRpc from test/helpers/launcher-runner.ts — runLauncher closes child stdin and runLauncherRpc wraps RpcDriver with the fixture environment",
		).toEqual([]);
	});
});
