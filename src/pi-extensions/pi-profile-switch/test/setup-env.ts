import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/**
 * The suite is not hermetic against the machine it runs on.
 *
 * Two leaks, both measured:
 *
 * 1. Launch identity. `resolveInitialProfile` reads `PI_PROFILE` in-process and
 *    `launcherEnv()` spreads `process.env` into spawned launcher/pi
 *    subprocesses, so a lane running the suite hands it that lane's identity:
 *    profiles the fixtures never defined ("unknown profile: worker"), the lane's
 *    agent dir and session dir.
 * 2. Credentials and home. Ambient provider credentials make otherwise
 *    unconfigured providers "available" to Pi, which changes fallback model
 *    selection (`findInitialModel` picks the first available model when the
 *    declared default does not resolve) — measured: `AWS_*` made
 *    `amazon-bedrock` available and a fixture session started on a real Bedrock
 *    model. A real `HOME` additionally lets `postinstall` tests write
 *    `~/.pi/agent/skills/...`.
 *
 * So: snapshot the ambient environment, replace `HOME` with a scratch dir, clear
 * the launch identity and provider credentials for the whole file, and restore
 * everything afterwards. Fixtures already isolate what they need; nothing here
 * may reach the operator's config.
 */
const SCRUBBED = [
	// Launch identity.
	"PI_PROFILE",
	"PI_MODE",
	"PI_MODE_CONFIRM_PROJECT",
	"PI_ROOMS_NAME",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	// Provider credentials: presence alone changes model availability.
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"HF_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"OPENROUTER_API_KEY",
	"DEEPSEEK_API_KEY",
	"XAI_API_KEY",
	"MISTRAL_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"MOONSHOT_API_KEY",
	"ZAI_API_KEY",
	"MINIMAX_API_KEY",
	"GITHUB_TOKEN",
	"COPILOT_TOKEN",
] as const;

const snapshot = new Map<string, string | undefined>();
for (const key of SCRUBBED) {
	snapshot.set(key, process.env[key]);
	delete process.env[key];
}

const scratchHome = mkdtempSync(path.join(tmpdir(), "pi-profile-home-"));
snapshot.set("HOME", process.env.HOME);
process.env.HOME = scratchHome;

afterAll(() => {
	for (const [key, value] of snapshot) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scratchHome, { recursive: true, force: true });
});
