import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ActivationPlan } from "../src/profile-resolver.ts";
import { generateRuntimeDir, type DiscoveryContext } from "../src/settings-generator.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

/**
 * The generated settings' `packages` entry is a rewrite of the USER's global
 * declaration, not a fresh decision: a package the user configured must keep
 * its entry filters. These tests pin the emitted signature for a package that
 * declares extensions and prompts in the global form.
 *
 * They exist because the failure they guard was invisible from the outside: a
 * lane whose beads package reached settings.json as
 *   { extensions: [], prompts: ["./prompts/*.md"] }
 * started with no beads tools at all, while a lane with
 *   { extensions: ["src/index.ts"], prompts: ["prompts/*.md"] }
 * started correctly. Both are valid JSON, both load, and only one works — a
 * signature with no error attached to it. Twenty-six live instances carried the
 * broken pair; the correct pair was measured on every instance generated after
 * the authored settings were corrected.
 *
 * Those two symptoms have ONE cause and only one of them is this code's fault.
 * prompts/themes are unmanaged (UNMANAGED_DIR_KINDS), so a "./" in a generated
 * instance is an authored value carried through verbatim — the generator never
 * invents it. The generator's own share is the silent empty allowlist: a
 * declared entry that matches no discovered package yields extensions: [],
 * with no diagnostic. That is why the assertions below check the allowlist is
 * non-empty AND that nothing is rewritten into "./" — the first is this code's
 * obligation, the second is fidelity to authored config.
 */

const PACKAGE_SOURCE = "npm:pi-beads-extension";
const DECLARED_ENTRY = "src/index.ts";
const DECLARED_PROMPTS = "prompts/*.md";

let fixture: PiFixture;
let packageRoot: string;
let savedHome: string | undefined;
let savedSwitchDir: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	savedSwitchDir = process.env.PI_PROFILE_SWITCH_DIR;
	process.env.HOME = fixture.root;
	// The fixture points this at its own temp dir; the generator resolves the
	// instances root from it, so it must stay pointed at the fixture and must
	// never be left resolving to the developer's real profile dir.
	process.env.PI_PROFILE_SWITCH_DIR = fixture.profileSwitchDir;

	packageRoot = path.join(fixture.root, "packages", "pi-beads-extension");
	await mkdir(path.join(packageRoot, "src"), { recursive: true });
	await mkdir(path.join(packageRoot, "prompts"), { recursive: true });
	await writeFile(path.join(packageRoot, "src", "index.ts"), "export default function () {}\n");
	await writeFile(path.join(packageRoot, "prompts", "beads.md"), "# beads\n");

	// The user's global settings: the package in global form, no "./" prefix.
	await writeFile(
		path.join(fixture.agentDir, "settings.json"),
		JSON.stringify(
			{
				packages: [
					{
						source: PACKAGE_SOURCE,
						extensions: [DECLARED_ENTRY],
						prompts: [DECLARED_PROMPTS],
					},
				],
			},
			null,
			"\t",
		),
	);
});

afterEach(async () => {
	process.env.HOME = savedHome;
	if (savedSwitchDir === undefined) delete process.env.PI_PROFILE_SWITCH_DIR;
	else process.env.PI_PROFILE_SWITCH_DIR = savedSwitchDir;
	await rm(fixture.root, { recursive: true, force: true });
});

function planWith(overrides: Partial<ActivationPlan>): ActivationPlan {
	return {
		profile: "review",
		source: "global",
		filter: "selection",
		skills: [],
		extensions: [],
		resourceSelection: { skills: false, extensions: true },
		...overrides,
	};
}

function discoveryWith(root: string | undefined): DiscoveryContext {
	return { skills: [], packages: [{ source: PACKAGE_SOURCE, root }] };
}

async function emittedPackage(runtimeDir: string): Promise<Record<string, unknown>> {
	const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8")) as {
		packages?: Record<string, unknown>[];
	};
	const entries = settings.packages ?? [];
	expect(entries).toHaveLength(1);
	return entries[0]!;
}

describe("generated settings: package entry signature", () => {
	it("keeps a declared package's extensions when the profile declares the kind", async () => {
		// A profile that declares `extensions` replaces each package's filter
		// with the resolved allowlist. The bug this guards against emitted `[]`
		// there — an empty allowlist, which silently loads nothing — even though
		// the user had declared an entry and the entry existed on disk.
		const plan = planWith({
			extensions: [{ id: PACKAGE_SOURCE, entry: path.join(packageRoot, DECLARED_ENTRY), origin: "package" }],
		});

		const { runtimeDir } = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: discoveryWith(packageRoot),
		});
		const pkg = await emittedPackage(runtimeDir);

		expect(pkg.extensions).toEqual([DECLARED_ENTRY]);
		expect(pkg.extensions).not.toEqual([]);
		// The declared prompts ride through verbatim. The broken signature
		// carried a "./" prefix here, which Pi's matcher does not accept.
		expect(pkg.prompts).toEqual([DECLARED_PROMPTS]);
		for (const value of [...(pkg.extensions as string[]), ...(pkg.prompts as string[])]) {
			expect(value.startsWith("./")).toBe(false);
		}
	});

	it("preserves the user's own filter verbatim when the profile does not declare the kind", async () => {
		// Undeclared kind: the package keeps its native filter, which is the
		// path that keeps the default profile's settings untouched.
		const plan = planWith({ resourceSelection: { skills: false, extensions: false } });

		const { runtimeDir } = await generateRuntimeDir(plan, {
			agentDir: fixture.agentDir,
			discovery: discoveryWith(packageRoot),
		});
		const pkg = await emittedPackage(runtimeDir);

		expect(pkg.extensions).toEqual([DECLARED_ENTRY]);
		expect(pkg.prompts).toEqual([DECLARED_PROMPTS]);
	});
});
