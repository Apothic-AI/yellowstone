import { defineConfig } from "vitest/config";

/**
 * The suite must not run on a lane's ambient launch identity. `setup-env.ts`
 * snapshots and clears it before every test file, so in-process resolvers and
 * spawned launcher/pi subprocesses both start from a neutral environment.
 *
 * No other option is set: paths, pool and include patterns stay at Vitest's
 * defaults so this file cannot change which tests run.
 */
export default defineConfig({
	test: {
		setupFiles: ["./test/setup-env.ts"],
	},
});
