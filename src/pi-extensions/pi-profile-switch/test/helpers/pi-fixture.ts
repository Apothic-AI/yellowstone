import { mkdtemp, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Fixture layout convention for pi-profile tests (established by ticket 01):
 * one temp root per test holding an isolated Pi agent dir (skills, settings,
 * models, auth) and a project cwd, so no test ever touches the real
 * ~/.pi/agent or the developer's project directory.
 */

export interface PiFixture {
	root: string;
	/** Project working directory. */
	cwd: string;
	/** Isolated global agent dir (stands in for ~/.pi/agent). */
	agentDir: string;
	/** Isolated profile switch dir. */
	profileSwitchDir: string;
}

export async function createPiFixture(): Promise<PiFixture> {
	const rawRoot = await mkdtemp(path.join(tmpdir(), "pi-profile-"));
	const root = await realpath(rawRoot);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	const profileSwitchDir = path.join(root, ".pi-profile-switch");
	await mkdir(path.join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(profileSwitchDir, { recursive: true });
	
	// Set the environment variable so all code picks up the test workspace.
	process.env.PI_PROFILE_SWITCH_DIR = profileSwitchDir;

	return { root, cwd, agentDir, profileSwitchDir };
}

/** Absolute paths of the per-launch instance dirs under the fixture's
 *  instances root, sorted. */
export async function launchInstanceDirs(fixture: PiFixture): Promise<string[]> {
	const root = path.join(fixture.profileSwitchDir, "instances");
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith("launch-"))
			.map((entry) => path.join(root, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/** The single per-launch instance dir a fixture run produced. */
export async function soleInstanceDir(fixture: PiFixture): Promise<string> {
	const dirs = await launchInstanceDirs(fixture);
	if (dirs.length !== 1) {
		throw new Error(`expected exactly one instance dir, found ${dirs.length}: ${dirs.join(", ")}`);
	}
	return dirs[0]!;
}

/** Registers a skill in the fixture agent dir's global skills directory. */
export async function addGlobalSkill(fixture: PiFixture, name: string): Promise<void> {
	const dir = path.join(fixture.agentDir, "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n\nFixture body.\n`,
	);
}

/** Registers an extension in the fixture agent dir's global extensions
 *  directory. The extension registers one command named `<name>` so tests can
 *  observe its loaded-ness through RPC get_commands. */
export async function addGlobalExtension(fixture: PiFixture, name: string): Promise<void> {
	const dir = path.join(fixture.agentDir, "extensions");
	await mkdir(dir, { recursive: true });
	await writeFile(
		path.join(dir, `${name}.ts`),
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n\tpi.registerCommand("${name}", {\n\t\tdescription: "Fixture extension command ${name}",\n\t\thandler: async () => {},\n\t});\n}\n`,
	);
}

/** Recursively lists all files under dir (used to prove a run writes nothing). */
export async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(full)));
		else files.push(full);
	}
	return files;
}
