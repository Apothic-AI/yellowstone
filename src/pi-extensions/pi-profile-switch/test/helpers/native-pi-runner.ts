import { execFile } from "node:child_process";

import { launcherEnv } from "./launcher-runner.ts";
import type { PiFixture } from "./pi-fixture.ts";
import { RpcDriver } from "./rpc-driver.ts";

function nativeEnv(fixture: PiFixture): NodeJS.ProcessEnv {
	const env = launcherEnv(fixture);
	// Match the launcher's native child environment, not an ambient session root.
	delete env.PI_CODING_AGENT_SESSION_DIR;
	return env;
}

/** Native comparison only: the same executable the launcher starts. */
export function runNativePiRpc(fixture: PiFixture, args: string[]): RpcDriver {
	return new RpcDriver("pi", args, { cwd: fixture.cwd, env: nativeEnv(fixture) });
}

export interface NativePiRun {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** EOF permits native RPC to exit without requests. Timeout/spawn errors are
 *  harness failures; actual native exit codes/signals remain comparison data. */
export function runNativePi(fixture: PiFixture, args: string[]): Promise<NativePiRun> {
	return new Promise((resolve, reject) => {
		const child = execFile("pi", args, { cwd: fixture.cwd, env: nativeEnv(fixture), timeout: 30_000 }, (error, stdout, stderr) => {
			if (error !== null && (error.killed || (typeof error.code !== "number" && !error.signal))) {
				reject(new Error(`native Pi harness failed: ${error.message}\n${stderr}`));
				return;
			}
			resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, signal: error?.signal ?? null, stdout, stderr });
		});
		child.stdin?.end();
	});
}
