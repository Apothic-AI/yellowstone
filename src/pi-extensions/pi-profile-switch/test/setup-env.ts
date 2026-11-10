import { afterAll } from "vitest";

/**
 * The suite is not hermetic against a lane environment.
 *
 * `resolveInitialProfile` reads `PI_PROFILE` in-process, and `launcherEnv()`
 * spreads `process.env` into spawned launcher/pi subprocesses, so a lane that
 * runs this suite hands it that lane's identity: profiles the fixtures never
 * defined ("unknown profile: worker"), the lane's agent dir and session dir.
 *
 * Snapshot the ambient launch identity, clear it for the whole file, and put it
 * back afterwards so a test that inspects `process.env` sees the environment it
 * was given. Tests that need a launch identity set it themselves.
 */
const LANE_ENV = [
	"PI_PROFILE",
	"PI_MODE",
	"PI_MODE_CONFIRM_PROJECT",
	"PI_ROOMS_NAME",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
] as const;

const snapshot = new Map<string, string | undefined>();
for (const key of LANE_ENV) {
	snapshot.set(key, process.env[key]);
	delete process.env[key];
}

afterAll(() => {
	for (const [key, value] of snapshot) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
