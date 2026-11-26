import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActivationPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir, type DiscoveryContext } from "../src/settings-generator.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

/**
 * A lane whose resolved model is absent from the compaction overrides it
 * carries — and which has no base `reserveTokens` — silently falls back to
 * pi's default reserve of 16384 tokens instead of the fleet's configured
 * value. Measured 2026-11-26: two live lanes ran a 36x smaller compaction
 * margin than the other 26, with valid JSON, no error, and no diagnostic.
 *
 * The generator copies authored config faithfully and must keep doing so.
 * These tests pin only that it now SAYS SO when the copy leaves a lane with
 * no reserve at all, and that it stays quiet when a lane is actually covered.
 */

const PROVIDER = "subrouter-deepseek-flash";
const MODEL = "deepseek-v4.1-flash-1017";

let fixture: PiFixture;
let savedHome: string | undefined;
let savedSwitchDir: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	savedSwitchDir = process.env.PI_PROFILE_SWITCH_DIR;
	process.env.HOME = fixture.root;
	process.env.PI_PROFILE_SWITCH_DIR = fixture.profileSwitchDir;
	await mkdir(fixture.agentDir, { recursive: true });
});

afterEach(async () => {
	process.env.HOME = savedHome;
	if (savedSwitchDir === undefined) delete process.env.PI_PROFILE_SWITCH_DIR;
	else process.env.PI_PROFILE_SWITCH_DIR = savedSwitchDir;
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeAuthoredCompaction(compaction: unknown): Promise<void> {
	await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({ compaction }, null, "\t"));
}

function planFor(modelId: string): ActivationPlan {
	return {
		profile: "review",
		source: "global",
		filter: "selection",
		skills: [],
		extensions: [],
		resourceSelection: { skills: false, extensions: false },
		model: { provider: PROVIDER, id: modelId },
	};
}

const discovery: DiscoveryContext = { skills: [], packages: [] };

async function warningsFor(modelId: string): Promise<string[]> {
	const { warnings } = await generateRuntimeDir(planFor(modelId), { agentDir: fixture.agentDir, discovery });
	return warnings;
}

describe("generated settings: compaction reserve for the resolved model", () => {
	it("stays silent when the resolved model has an override entry", async () => {
		await writeAuthoredCompaction({ modelOverrides: { [`${PROVIDER}/${MODEL}`]: { reserveTokens: 600000 } } });

		const warnings = await warningsFor(MODEL);
		expect(warnings.filter((warning) => warning.includes("compaction.modelOverrides"))).toEqual([]);
	});

	it("names the model when neither an override entry nor a base reserve covers it", async () => {
		// The measured fault: a table that predates the model the lane runs, and
		// no base reserveTokens, so pi's 16384 default applies invisibly.
		await writeAuthoredCompaction({ modelOverrides: { "someone-else/older-model": { reserveTokens: 500000 } } });

		const warnings = await warningsFor(MODEL);
		const named = warnings.filter((warning) => warning.includes("compaction.modelOverrides"));
		expect(named).toHaveLength(1);
		expect(named[0]).toContain(`${PROVIDER}/${MODEL}`);
		expect(named[0]).toContain("16384");
	});

	it("stays silent when a base reserveTokens covers every model", async () => {
		await writeAuthoredCompaction({
			reserveTokens: 500000,
			modelOverrides: { "someone-else/older-model": { reserveTokens: 500000 } },
		});

		const warnings = await warningsFor(MODEL);
		expect(warnings.filter((warning) => warning.includes("compaction.modelOverrides"))).toEqual([]);
	});

	it("stays silent when the profile declares no compaction block at all", async () => {
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify({}, null, "\t"));

		const warnings = await warningsFor(MODEL);
		expect(warnings.filter((warning) => warning.includes("compaction"))).toEqual([]);
	});
});
