import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLauncher } from "./helpers/launcher-runner.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeGlobalCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

describe("launcher untrusted-project diagnostic", () => {
	it(
		"reports skipped content and authorization steps for default and named profiles",
		{ timeout: 45_000 },
		async () => {
			await mkdir(path.join(fixture.cwd, ".pi", "profiles"), { recursive: true });
			await mkdir(path.join(fixture.cwd, ".pi", "extensions"), { recursive: true });
			await writeGlobalCatalog({ review: { skills: [] } });

			const defaultLaunch = await runLauncher(fixture, ["--", "--mode", "text"]);
			const namedLaunch = await runLauncher(fixture, ["review", "--", "--mode", "text"]);

			for (const result of [defaultLaunch, namedLaunch]) {
				expect(result.code).toBe(0);
				expect(result.stderr).toContain("project is untrusted");
				expect(result.stderr).toContain(".pi/profiles");
				expect(result.stderr).toContain(".pi/extensions");
				expect(result.stderr).toContain("invisible");
				expect(result.stderr).toContain("/trust");
				expect(result.stderr).toContain("next launch");
				expect(result.stderr).toContain("-- --approve");
				expect(result.stderr.match(/project is untrusted/g)).toHaveLength(1);
			}
		},
	);

	it(
		"does not report the diagnostic for a trusted project",
		{ timeout: 45_000 },
		async () => {
			await writeFile(path.join(fixture.cwd, ".pi", "settings.json"), "{}");
			await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ [fixture.cwd]: true }));

			const result = await runLauncher(fixture, ["--", "--mode", "text"]);

			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("project is untrusted");
		},
	);

	it(
		"does not report the diagnostic for an empty project forced untrusted with --no-approve",
		{ timeout: 45_000 },
		async () => {
			const result = await runLauncher(fixture, ["--", "--mode", "text", "--no-approve"]);

			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("project is untrusted");
		},
	);
});
