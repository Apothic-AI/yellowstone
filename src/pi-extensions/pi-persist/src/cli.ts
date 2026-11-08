#!/usr/bin/env bun
/**
 * `pi-persist` — manage declarative items.
 *
 * Deliberately a thin layer over the same functions the extension uses at load
 * (`readItemsFile`, `updateItemsFile`, `parseItemsFile`), so the CLI cannot drift from the runtime
 * representation. It talks to files only: no pi process, no session, no registry. Items take effect
 * on the next `/reload` or session start.
 */
import { existsSync } from "node:fs";
import {
	type DeclarativeItem,
	type ItemChannel,
	itemKey,
	itemsFilePath,
	loadLayeredItems,
	PRESET_ITEMS,
	projectItemsFilePath,
	readItemsFile,
	updateItemsFile,
} from "./items.ts";
import { readSettingsFromDisk, settingsFilePath } from "./settings.ts";
import { expandTemplate } from "./template.ts";

const USAGE = `pi-persist — declarative context items

Usage:
  pi-persist list
  pi-persist add <id> <content> [--channel trailing|section] [--priority <n>]
                                 [--providers <a,b>] [--tools <x,y>] [--project]
  pi-persist remove <id> [--channel trailing|section] [--project]
  pi-persist preset            write the shipped preset items (current_datetime)

Options:
  --project    Target <cwd>/.pi/pi-persist.json instead of the global items file.
               Project items load only when the project is trusted, and they
               override a global item with the same channel:id.
  --channel    Where the item is injected. Default: trailing.
               trailing = appended to every request (uncached, always visible)
               section  = cached in the leading system prompt (cheap, changes rarely)
  --priority   Lower sorts first. Default: 0.
  --providers  Comma-separated provider ids; the item is skipped for any other provider.
  --tools      Comma-separated tool names; the item is skipped unless all are active.

Templates available in <content>:
  {{datetime}}          local date and time with zone (default)
  {{datetime:iso}}       ISO 8601
  {{datetime:date}}      local date only
  {{datetime:time}}      local time only
  {{datetime:unix}}      seconds since the epoch
  {{exec:<command>}}     trimmed stdout of a shell command, run per request

  Example: --content '{{datetime}} on {{exec:git rev-parse --abbrev-ref HEAD}}'
  Unresolved placeholders are left verbatim so a typo stays visible.

Files:
  items     ${itemsFilePath()}
  project   ${projectItemsFilePath(process.cwd())}
            written with --project, read when the project is trusted
  settings  ${settingsFilePath()}
            holds the on/off switch; /pi-persist-toggle flips it
`;

class UsageError extends Error {}

interface Args {
	positional: string[];
	flags: Map<string, string>;
}

/** Flags that stand alone, so `--project` does not swallow the next argument. */
const BOOLEAN_FLAGS = new Set(["project"]);

function parseArgs(argv: readonly string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (BOOLEAN_FLAGS.has(name)) {
			flags.set(name, "true");
			continue;
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
		flags.set(name, value);
		index++;
	}
	return { positional, flags };
}

/**
 * Which items file a mutating command writes to.
 *
 * The CLI writes files, not registry entries, so it does not need to know whether the project is
 * trusted: an untrusted project's file simply sits there unread until trust is granted.
 */
function targetPath(flags: Map<string, string>): string {
	return flags.has("project") ? projectItemsFilePath(process.cwd()) : itemsFilePath();
}

function splitList(value: string | undefined): string[] | undefined {
	if (!value) return;
	const list = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return list.length > 0 ? list : undefined;
}

function readChannel(flags: Map<string, string>, fallback: ItemChannel = "trailing"): ItemChannel {
	const channel = flags.get("channel") ?? fallback;
	if (channel !== "trailing" && channel !== "section") {
		throw new UsageError(`--channel must be "trailing" or "section", got "${channel}"`);
	}
	return channel;
}

async function add(argv: readonly string[]): Promise<void> {
	const { positional, flags } = parseArgs(argv);
	const [id, ...rest] = positional;
	if (!id) throw new UsageError("add needs an <id>");
	const content = rest.join(" ");
	if (!content) throw new UsageError("add needs <content>");
	const channel = readChannel(flags);
	const priority = flags.get("priority");
	if (priority !== undefined && !Number.isFinite(Number(priority))) {
		throw new UsageError(`--priority must be a number, got "${priority}"`);
	}

	const item: DeclarativeItem = { id, channel, content };
	if (priority !== undefined) item.priority = Number(priority);
	const providers = splitList(flags.get("providers"));
	if (providers) item.providers = providers;
	const activeTools = splitList(flags.get("tools"));
	if (activeTools) item.activeTools = activeTools;

	let replaced = false;
	const path = targetPath(flags);
	await updateItemsFile((file) => {
		const index = file.items.findIndex((entry) => entry.id === id && entry.channel === channel);
		if (index >= 0) {
			replaced = true;
			file.items[index] = item;
		} else {
			file.items.push(item);
		}
		return file;
	}, path);
	console.log(`${replaced ? "replaced" : "added"} ${channel} item "${id}" in ${path}`);
	if (flags.has("project")) console.log("Project items load only when the project is trusted.");
	console.log("Takes effect on the next /reload or session start.");
}

async function remove(argv: readonly string[]): Promise<void> {
	const { positional, flags } = parseArgs(argv);
	const [id] = positional;
	if (!id) throw new UsageError("remove needs an <id>");
	const only = flags.has("channel") ? readChannel(flags) : undefined;

	let removed = 0;
	const path = targetPath(flags);
	await updateItemsFile((file) => {
		file.items = file.items.filter((entry) => {
			const match = entry.id === id && (only === undefined || entry.channel === only);
			if (match) removed++;
			return !match;
		});
		return file;
	}, path);
	if (removed === 0) {
		const scope = only ? ` in channel "${only}"` : "";
		throw new UsageError(`no item "${id}"${scope} in ${path}`);
	}
	console.log(`removed ${removed} item(s) named "${id}" from ${path}`);
	console.log("Takes effect on the next /reload or session start.");
}

function list(argv: readonly string[]): void {
	parseArgs(argv);
	const path = itemsFilePath();
	const projectPath = projectItemsFilePath(process.cwd());
	// The effective set, i.e. what a trusted session would register.
	const layered = loadLayeredItems({ cwd: process.cwd(), projectTrusted: true });
	const projectKeys = new Set(readItemsFile(projectPath).items.map(itemKey));
	console.log(`items file: ${path}`);
	// The switch decides whether any of this is injected at all, so it belongs next to the list.
	const enabled = readSettingsFromDisk().enabled;
	console.log(
		enabled
			? "state: on — the items below are injected"
			: "state: off — nothing is injected; run /pi-persist-toggle to turn it back on",
	);
	if (existsSync(projectPath)) {
		console.log(`project file: ${projectPath}`);
		console.log(
			"  (project items load only when the project is trusted, and override a global item with the same channel:id)",
		);
	}
	console.log("");

	if (layered.items.length === 0) {
		console.log("no declarative items");
	} else {
		const rows = layered.items.map((item) => {
			const policy: string[] = [];
			if (item.priority !== undefined) policy.push(`priority=${item.priority}`);
			if (item.providers) policy.push(`providers=${item.providers.join(",")}`);
			if (item.activeTools) policy.push(`tools=${item.activeTools.join(",")}`);
			// Show what the template expands to for this machine, so `add` mistakes are visible.
			const preview = expandTemplate(item.content, { cwd: process.cwd() });
			return [
				item.id,
				item.channel,
				projectKeys.has(itemKey(item)) ? "project" : "global",
				policy.join(" ") || "-",
				preview,
			];
		});
		const header = ["ID", "CHANNEL", "SOURCE", "POLICY", "CONTENT"];
		const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index]!.length)));
		const format = (row: string[]) =>
			row
				.map((cell, index) => cell.padEnd(widths[index]!))
				.join("  ")
				.trimEnd();
		console.log(format(header));
		console.log(format(widths.map((width) => "-".repeat(width))));
		for (const row of rows) console.log(format(row));
	}

	if (layered.overridden.length > 0) {
		console.log("");
		console.log(`overriding global: ${layered.overridden.join(", ")}`);
	}

	if (layered.errors.length > 0) {
		console.log("");
		console.log(`${layered.errors.length} problem(s) in the items files:`);
		for (const error of layered.errors) console.log(`  ${error}`);
	}
}

async function preset(argv: readonly string[]): Promise<void> {
	parseArgs(argv);
	const existing = readItemsFile().items;
	let added = 0;
	await updateItemsFile((file) => {
		for (const item of PRESET_ITEMS) {
			const index = file.items.findIndex((entry) => entry.id === item.id && entry.channel === item.channel);
			if (index >= 0) file.items[index] = { ...item };
			else {
				file.items.push({ ...item });
				added++;
			}
		}
		return file;
	});
	console.log(`preset written: ${PRESET_ITEMS.map((item) => item.id).join(", ")}`);
	if (existing.length > 0) console.log(`${added} added, rest updated in place; your other items are untouched.`);
	console.log("Takes effect on the next /reload or session start.");
}

/** Re-exported so tests can exercise the parser without spawning a process. */
export { parseArgs, USAGE };

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	try {
		switch (command) {
			case "list":
			case "ls":
				list(rest);
				return 0;
			case "add":
				await add(rest);
				return 0;
			case "remove":
			case "rm":
				await remove(rest);
				return 0;
			case "preset": {
				await preset(rest);
				return 0;
			}
			case "help":
			case "--help":
			case "-h":
			case undefined:
				process.stdout.write(USAGE);
				return command === undefined ? 1 : 0;
			default:
				throw new UsageError(`unknown command "${command}"`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`error: ${error.message}`);
			console.error("");
			process.stderr.write(USAGE);
			return 2;
		}
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
