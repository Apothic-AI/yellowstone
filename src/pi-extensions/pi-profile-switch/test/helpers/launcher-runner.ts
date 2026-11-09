import { execFile } from "node:child_process";
import path from "node:path";

import type { PiFixture } from "./pi-fixture.ts";
import { RpcDriver } from "./rpc-driver.ts";

/** Absolute path to the launcher entrypoint (vitest runs from the repo root). */
export const LAUNCHER_BIN = path.resolve("bin/pi-profile.ts");

/** Environment for a launcher subprocess: every real-Pi side effect stays
 *  inside the fixture (the launcher resolves the real agent dir through pi's
 *  own override), and offline mode keeps model calls from leaking. */
export function launcherEnv(fixture: PiFixture, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...inherited,
		HOME: fixture.root,
		PI_CODING_AGENT_DIR: fixture.agentDir,
		PI_OFFLINE: "1",
	};
	delete env.MCP_DIRECT_TOOLS;
	return env;
}

/** Parent-session fixture environment for tests of the real optional extension.
 *  Worker/child identity must not leak into Pi's native extension loader. */
export function nativeParentLauncherEnv(fixture: PiFixture, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = launcherEnv(fixture, inherited);
	delete env.PI_SUBAGENT_CHILD;
	delete env.PI_SUBAGENTS_HERDR_BRIDGE;
	return env;
}

export interface LauncherRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs the launcher end-to-end and resolves with its exit code and output.
 *  stdin is closed immediately: pi reads stdin until EOF, so an open pipe
 *  keeps pi (and the launcher) alive past the test timeout. */
export function runLauncher(fixture: PiFixture, args: string[], env: NodeJS.ProcessEnv = launcherEnv(fixture)): Promise<LauncherRun> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"node",
			[LAUNCHER_BIN, ...args],
			{ cwd: fixture.cwd, env },
			(error, stdout, stderr) => {
				clearTimeout(timer);
				resolve({ code: (error as { code?: number })?.code ?? 0, stdout, stderr });
			},
		);
		child.stdin?.end();
		const timer = setTimeout(
			() => reject(new Error("launcher did not exit after pi reached EOF on stdin")),
			30_000,
		);
		timer.unref();
	});
}

/** Starts the launcher in RPC mode for scripted input (get_state, prompt,
 *  waitFor). This is the sanctioned interactive counterpart to `runLauncher`:
 *  integration tests must construct their RPC driver here, not spawn the
 *  launcher directly. Callers MUST `await driver.close()` in a finally block. */
export function runLauncherRpc(fixture: PiFixture, args: string[], env: NodeJS.ProcessEnv = launcherEnv(fixture)): RpcDriver {
	return new RpcDriver("node", [LAUNCHER_BIN, ...args], {
		cwd: fixture.cwd,
		env,
	});
}
