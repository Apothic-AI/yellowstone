import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverSkills } from "../src/skill-registry.ts";
import { addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;

beforeEach(async () => {
	fixture = await createPiFixture();
	// Pi discovers ~/.agents/skills via process.env.HOME — point it at the fixture.
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

async function addAgentsSkill(name: string): Promise<void> {
	const dir = path.join(fixture.root, ".agents", "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: agents skill ${name}\n---\n`);
}

/** A local-path package contributing one skill, registered in user settings. */
async function addLocalPackage(dirName: string, skillName: string): Promise<string> {
	const packageRoot = path.join(fixture.root, dirName);
	await mkdir(path.join(packageRoot, "skills", skillName), { recursive: true });
	await writeFile(
		path.join(packageRoot, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: package skill ${skillName}\n---\n`,
	);
	await writeFile(
		path.join(fixture.agentDir, "settings.json"),
		JSON.stringify({ packages: [packageRoot] }),
	);
	return packageRoot;
}

describe("discoverSkills (SkillRegistry)", () => {
	it("maps skill names to their final SKILL.md path for agent dir skills", async () => {
		await addGlobalSkill(fixture, "alpha-skill");

		const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(skills).toEqual([
			expect.objectContaining({
				name: "alpha-skill",
				filePath: path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md"),
				origin: "top-level",
			}),
		]);
	});

	it("discovers ~/.agents skills alongside agent dir skills", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addAgentsSkill("shared-skill");

		const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const byName = new Map(skills.map((skill) => [skill.name, skill]));

		expect(byName.get("alpha-skill")?.filePath).toContain(fixture.agentDir);
		expect(byName.get("shared-skill")?.filePath).toBe(
			path.join(fixture.root, ".agents", "skills", "shared-skill", "SKILL.md"),
		);
	});

	it("discovers package skills with their package origin and install root", async () => {
		const packageRoot = await addLocalPackage("my-package", "pkg-skill");

		const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const skill = skills.find((entry) => entry.name === "pkg-skill");

		expect(skill).toBeDefined();
		expect(skill?.origin).toBe("package");
		expect(skill?.baseDir).toBe(packageRoot);
		expect(skill?.source).toBe(packageRoot);
	});

	it("resolves same-name collisions by Pi's discovery priority (user beats package)", async () => {
		await addLocalPackage("my-package", "dup-skill");
		await addGlobalSkill(fixture, "dup-skill");

		const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });
		const dups = skills.filter((skill) => skill.name === "dup-skill");

		expect(dups).toHaveLength(1);
		expect(dups[0]!.filePath).toBe(path.join(fixture.agentDir, "skills", "dup-skill", "SKILL.md"));
	});

	it("re-resolves on every call so newly added skills appear", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		const before = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		await addGlobalSkill(fixture, "late-skill");
		const after = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		expect(before.map((skill) => skill.name)).not.toContain("late-skill");
		expect(after.map((skill) => skill.name)).toContain("late-skill");
	});

	it("never executes extension code while discovering skills", async () => {
		// An extension whose top-level side effect would be observable if run.
		const extensionsDir = path.join(fixture.agentDir, "extensions");
		await mkdir(extensionsDir, { recursive: true });
		await writeFile(
			path.join(extensionsDir, "side-effect.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(fixture.root, "EXECUTED"))}, "ran");\nexport default function () {}\n`,
		);
		await addGlobalSkill(fixture, "alpha-skill");

		await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir });

		const { existsSync } = await import("node:fs");
		expect(existsSync(path.join(fixture.root, "EXECUTED"))).toBe(false);
	});

	describe("project-trusted discovery", () => {
		async function addProjectSkill(name: string): Promise<void> {
			const dir = path.join(fixture.cwd, ".pi", "skills", name);
			await mkdir(dir, { recursive: true });
			await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: project skill ${name}\n---\n`);
		}

		it("discovers .pi/skills and ancestor .agents/skills when the project is trusted", async () => {
			await addProjectSkill("proj-skill");
			const ancestorAgents = path.join(fixture.cwd, ".agents", "skills", "proj-agents-skill");
			await mkdir(ancestorAgents, { recursive: true });
			await writeFile(
				path.join(ancestorAgents, "SKILL.md"),
				"---\nname: proj-agents-skill\ndescription: ancestor agents skill\n---\n",
			);

			const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: true });
			const byName = new Map(skills.map((skill) => [skill.name, skill]));

			expect(byName.get("proj-skill")?.filePath).toBe(
				path.join(fixture.cwd, ".pi", "skills", "proj-skill", "SKILL.md"),
			);
			expect(byName.get("proj-skill")?.scope).toBe("project");
			expect(byName.has("proj-agents-skill")).toBe(true);
		});

		it("project skills win same-name collisions over user skills", async () => {
			await addProjectSkill("dup-skill");
			await addGlobalSkill(fixture, "dup-skill");

			const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: true });
			const dups = skills.filter((skill) => skill.name === "dup-skill");

			expect(dups).toHaveLength(1);
			expect(dups[0]!.filePath).toBe(path.join(fixture.cwd, ".pi", "skills", "dup-skill", "SKILL.md"));
		});

		it("does not discover project resources when untrusted", async () => {
			await addProjectSkill("proj-skill");

			const skills = await discoverSkills({ cwd: fixture.cwd, agentDir: fixture.agentDir, projectTrusted: false });

			expect(skills.map((skill) => skill.name)).not.toContain("proj-skill");
		});
	});
});
