import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The OpenSpec task list is the progress record of a change. Two rules from
// `openspec/config.yaml` govern it: every implementation task carries a
// "Verification:" clause, and a task may only stay unticked when its section
// declares the work as owned outside the change.
//
// The stale-progress failure this guards is real: stage S2 was implemented and
// accepted while its four boxes stayed empty, so the record read "15 of 19".
// A box is complete only when it holds nothing but x/X, ignoring spacing;
// every other marker (- [ ], - [], - [~], - [-]) is incomplete.

const CHANGES_DIR = path.resolve("openspec/changes");
const ARCHIVE_DIR = "archive";
const TASK_LINE = /^\s*-\s*\[([^\]]*)\]\s*(.*)$/;
const HEADING = /^##\s+(.*)$/;
const VERIFICATION_CLAUSE = /\bVerification\b[^:\n]*:/;
const OUT_OF_SCOPE = "outside this change";

type Task = { id: string; done: boolean; text: string; section: string };

async function activeChanges(): Promise<string[]> {
	const entries = await readdir(CHANGES_DIR, { withFileTypes: true });
	return entries.filter((entry) => entry.isDirectory() && entry.name !== ARCHIVE_DIR).map((entry) => entry.name);
}

function parseTasks(markdown: string): Task[] {
	const tasks: Task[] = [];
	let section = "";
	let current: Task | undefined;
	for (const line of markdown.split("\n")) {
		const heading = line.match(HEADING);
		if (heading) {
			section = heading[1];
			current = undefined;
			continue;
		}
		const task = line.match(TASK_LINE);
		if (!task) {
			if (current && line.trim()) current.text += ` ${line.trim()}`;
			continue;
		}
		current = { id: task[2].split(/\s+/)[0], done: task[1].trim().toLowerCase() === "x", text: task[2], section };
		tasks.push(current);
	}
	return tasks;
}

async function tasksOf(change: string): Promise<Task[] | undefined> {
	const file = path.join(CHANGES_DIR, change, "tasks.md");
	try {
		return parseTasks(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

describe("openspec change task traceability", () => {
	it("leaves no task unticked outside a section that declares itself out of scope", async () => {
		const violations: string[] = [];
		for (const change of await activeChanges()) {
			const tasks = await tasksOf(change);
			if (!tasks) continue;
			for (const task of tasks) {
				if (task.done) continue;
				if (task.section.toLowerCase().includes(OUT_OF_SCOPE)) continue;
				violations.push(`${change}/${task.id}: unticked task in the in-scope section "${task.section}"`);
			}
		}
		expect(violations, "unticked tasks outside a declared out-of-scope section").toEqual([]);
	});

	it("gives every task a Verification clause", async () => {
		const missing: string[] = [];
		for (const change of await activeChanges()) {
			const tasks = await tasksOf(change);
			if (!tasks) continue;
			for (const task of tasks) {
				if (!VERIFICATION_CLAUSE.test(task.text)) missing.push(`${change}/${task.id}`);
			}
		}
		expect(missing, "tasks without a Verification clause").toEqual([]);
	});
});
