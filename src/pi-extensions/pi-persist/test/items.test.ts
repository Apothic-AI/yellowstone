import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isValidItemId, itemsFilePath, loadLayeredItems, parseItemsFile, projectItemsFilePath } from "../src/items.ts";

/** A fresh directory per test, so no two cases share a file. */
function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pi-persist-${prefix}-`));
}

function writeItemsFile(path: string, items: unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, items }));
}

describe("items file parsing", () => {
	test("accepts a well-formed file", () => {
		const { items, errors } = parseItemsFile(
			JSON.stringify({ version: 1, items: [{ id: "a", channel: "trailing", content: "x" }] }),
		);
		expect(errors).toEqual([]);
		expect(items).toEqual([{ id: "a", channel: "trailing", content: "x" }]);
	});

	test("preserves optional policy fields", () => {
		const { items } = parseItemsFile(
			JSON.stringify({
				items: [{ id: "a", channel: "section", content: "x", priority: 3, providers: ["p"], activeTools: ["t"] }],
			}),
		);
		expect(items[0]).toEqual({
			id: "a",
			channel: "section",
			content: "x",
			priority: 3,
			providers: ["p"],
			activeTools: ["t"],
		});
	});

	test("skips bad entries but keeps the good ones", () => {
		const { items, errors } = parseItemsFile(
			JSON.stringify({
				items: [
					{ id: "ok", channel: "trailing", content: "keep" },
					{ id: "no-channel", content: "x" },
					{ channel: "trailing", content: "x" },
					{ id: "bad id", channel: "trailing", content: "x" },
					{ id: "no-content", channel: "trailing" },
					{ id: "ok", channel: "trailing", content: "dup" },
				],
			}),
		);
		expect(items.map((item) => item.content)).toEqual(["keep"]);
		expect(errors).toHaveLength(5);
	});

	test("same id in different channels is not a duplicate", () => {
		const { items, errors } = parseItemsFile(
			JSON.stringify({
				items: [
					{ id: "x", channel: "trailing", content: "t" },
					{ id: "x", channel: "section", content: "s" },
				],
			}),
		);
		expect(errors).toEqual([]);
		expect(items).toHaveLength(2);
	});

	test("malformed JSON and wrong shapes degrade instead of throwing", () => {
		expect(parseItemsFile("{ nope").errors[0]).toContain("not valid JSON");
		expect(parseItemsFile("[]").errors[0]).toContain("top level must be an object");
		expect(parseItemsFile(JSON.stringify({ items: {} })).errors[0]).toContain("items must be an array");
		expect(parseItemsFile(JSON.stringify({})).items).toEqual([]);
	});

	test("ignores non-string entries in policy lists", () => {
		const { items } = parseItemsFile(
			JSON.stringify({ items: [{ id: "a", channel: "trailing", content: "x", providers: ["p", 1, null] }] }),
		);
		expect(items[0]?.providers).toEqual(["p"]);
	});
});

describe("isValidItemId", () => {
	test("requires a leading letter", () => {
		expect(isValidItemId("clock")).toBe(true);
		expect(isValidItemId("my.item-1")).toBe(true);
		expect(isValidItemId("9lead")).toBe(false);
		expect(isValidItemId("has space")).toBe(false);
	});
});

describe("layered items", () => {
	const globalItems = [
		{ id: "clock", channel: "trailing", content: "global clock" },
		{ id: "env", channel: "section", content: "global env" },
	];

	test("project items merge over global, winning on channel:id", () => {
		const agentDir = tempDir("global");
		const cwd = tempDir("project");
		writeItemsFile(itemsFilePath(agentDir), globalItems);
		writeItemsFile(projectItemsFilePath(cwd), [
			{ id: "clock", channel: "trailing", content: "project clock" },
			{ id: "repo", channel: "section", content: "project only" },
		]);

		const layered = loadLayeredItems({ cwd, projectTrusted: true, agentDir });

		expect(layered.errors).toEqual([]);
		expect(layered.items.map((item) => [item.channel, item.id, item.content])).toEqual([
			// The override keeps the global position; the project-only item appends.
			["trailing", "clock", "project clock"],
			["section", "env", "global env"],
			["section", "repo", "project only"],
		]);
		expect(layered.overridden).toEqual(["trailing:clock"]);
	});

	test("the same id in two channels is not an override", () => {
		const agentDir = tempDir("global");
		const cwd = tempDir("project");
		writeItemsFile(itemsFilePath(agentDir), globalItems);
		writeItemsFile(projectItemsFilePath(cwd), [{ id: "clock", channel: "section", content: "section clock" }]);

		const layered = loadLayeredItems({ cwd, projectTrusted: true, agentDir });

		expect(layered.overridden).toEqual([]);
		expect(layered.items).toHaveLength(3);
	});

	test("an untrusted project contributes nothing and is reported as skipped", () => {
		const agentDir = tempDir("global");
		const cwd = tempDir("project");
		writeItemsFile(itemsFilePath(agentDir), globalItems);
		writeItemsFile(projectItemsFilePath(cwd), [{ id: "clock", channel: "trailing", content: "project clock" }]);

		const layered = loadLayeredItems({ cwd, projectTrusted: false, agentDir });

		expect(layered.items.map((item) => item.content)).toEqual(["global clock", "global env"]);
		expect(layered.overridden).toEqual([]);
		expect(layered.skippedUntrusted).toBe(true);
	});

	test("a missing project file is not a trust problem", () => {
		const agentDir = tempDir("global");
		writeItemsFile(itemsFilePath(agentDir), globalItems);

		const layered = loadLayeredItems({ cwd: tempDir("empty"), projectTrusted: false, agentDir });

		expect(layered.items).toHaveLength(2);
		expect(layered.skippedUntrusted).toBe(false);
		expect(layered.errors).toEqual([]);
	});

	test("a broken project file keeps the global items and names the file", () => {
		const agentDir = tempDir("global");
		const cwd = tempDir("project");
		writeItemsFile(itemsFilePath(agentDir), globalItems);
		mkdirSync(dirname(projectItemsFilePath(cwd)), { recursive: true });
		writeFileSync(projectItemsFilePath(cwd), "{ not json");

		const layered = loadLayeredItems({ cwd, projectTrusted: true, agentDir });

		expect(layered.items.map((item) => item.id)).toEqual(["clock", "env"]);
		expect(layered.errors).toHaveLength(1);
		expect(layered.errors[0]).toContain(projectItemsFilePath(cwd));
	});
});
