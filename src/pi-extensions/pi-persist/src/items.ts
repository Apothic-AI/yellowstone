import { accessSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Declarative items, stored on disk so they can be edited by hand or by the CLI.
 *
 * The programmatic `registerEnvContribution` / `registerEnvMessage` path stays the primary API for
 * extensions: a contribution's `content` can be any function of the live request, which no file can
 * express. This store covers the other case — a static value with a policy, added without writing
 * code. Both paths feed the same registries, so downstream rendering cannot tell them apart.
 *
 * Items are recorded with the channel they target, because the two channels are not
 * interchangeable: a value that changes every request belongs in the trailing message, and a value
 * that never changes is cheaper in the section, where it is cached with the prompt prefix.
 */
export const ITEMS_FILENAME = "pi-persist.json";

export type ItemChannel = "trailing" | "section";

export interface DeclarativeItem {
	/** Unique per channel. Registering the same id again replaces the earlier item. */
	id: string;
	channel: ItemChannel;
	/** Body text. `{{…}}` templates are expanded per request. */
	content: string;
	/** Lower renders first; ties break on id. */
	priority?: number;
	providers?: string[];
	activeTools?: string[];
}

export interface ItemsFile {
	version: 1;
	items: DeclarativeItem[];
}

export const EMPTY_ITEMS_FILE: ItemsFile = { version: 1, items: [] };

/**
 * Shipped preset, written on first run when there is no items file.
 *
 * This replaces a built-in clock contribution that used to live in code. One implementation instead
 * of two: the datetime behaviour is the `{{datetime}}` template, and the preset is just an item that
 * uses it. Deleting the item removes the clock; nothing else has to know about it.
 */
export const PRESET_ITEMS: readonly DeclarativeItem[] = [
	{
		id: "current_datetime",
		channel: "trailing",
		content: "{{datetime}}",
		priority: -100,
	},
];

export function itemsFilePath(agentDir = getAgentDir()): string {
	return join(agentDir, ITEMS_FILENAME);
}

/**
 * Project-local items, beside pi's other project configuration (`<cwd>/.pi/`).
 *
 * Read only when the project is trusted, and merged over the global file — see `loadLayeredItems`.
 */
export function projectItemsFilePath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, ITEMS_FILENAME);
}

/** Registry key for an item. Two files can hold the same id as long as the channel differs. */
export function itemKey(item: Pick<DeclarativeItem, "id" | "channel">): string {
	return `${item.channel}:${item.id}`;
}

const ITEM_ID = /^[A-Za-z][\w.:-]*$/;

export interface ValidationResult {
	items: DeclarativeItem[];
	/** Problems that caused an item to be skipped. Surfaced by `list` rather than thrown, so one bad */
	/** entry cannot take down a session. */
	errors: string[];
}

/** Coerce one untrusted entry, or explain why it was skipped. */
function normalizeItem(raw: unknown, index: number, seen: Set<string>): { item?: DeclarativeItem; error?: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `item ${index}: not an object` };
	const entry = raw as Record<string, unknown>;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return { error: `item ${index}: missing id` };
	if (!ITEM_ID.test(id)) return { error: `item ${index} (${id}): id must match ${ITEM_ID}` };
	const channel = entry.channel === "section" ? "section" : entry.channel === "trailing" ? "trailing" : undefined;
	if (!channel) return { error: `item ${index} (${id}): channel must be "trailing" or "section"` };
	if (typeof entry.content !== "string") return { error: `item ${index} (${id}): content must be a string` };
	const key = `${channel}:${id}`;
	if (seen.has(key)) return { error: `item ${index} (${id}): duplicate ${channel} id` };
	seen.add(key);
	const item: DeclarativeItem = { id, channel, content: entry.content };
	if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) item.priority = entry.priority;
	const providers = stringList(entry.providers);
	if (providers) item.providers = providers;
	const activeTools = stringList(entry.activeTools);
	if (activeTools) item.activeTools = activeTools;
	return { item };
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return;
	const list = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return list.length > 0 ? list : undefined;
}

/** Parse a file body. Never throws: a malformed file degrades to zero items plus an error. */
export function parseItemsFile(raw: string): ValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { items: [], errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { items: [], errors: ["top level must be an object"] };
	}
	const entries = (parsed as { items?: unknown }).items;
	if (entries === undefined) return { items: [], errors: [] };
	if (!Array.isArray(entries)) return { items: [], errors: ["items must be an array"] };
	const items: DeclarativeItem[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	entries.forEach((entry, index) => {
		const { item, error } = normalizeItem(entry, index, seen);
		if (item) items.push(item);
		if (error) errors.push(error);
	});
	return { items, errors };
}

/**
 * Ensure the items file exists, seeding the preset when it does not.
 *
 * Only on a missing file: an existing file — even an empty one — is the user's decision and is left
 * alone. Deleting every item must not resurrect the preset on the next start.
 */
export function ensureItemsFile(path = itemsFilePath()): void {
	try {
		accessSync(path);
		return;
	} catch {
		// fall through to seed
	}
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ version: 1, items: [...PRESET_ITEMS] }, null, 2)}\n`);
	} catch {
		// A read-only agent dir is not a reason to fail a session; the extension works without items.
	}
}

/** Read the items file. A missing file is an empty list, not an error. */
export function readItemsFile(path = itemsFilePath()): ValidationResult {
	try {
		return parseItemsFile(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], errors: [] };
		return { items: [], errors: [`could not read ${path}: ${String(error)}`] };
	}
}

export interface LayeredItems extends ValidationResult {
	/** Keys (`channel:id`) where a project entry replaced a global one. */
	overridden: string[];
	/** How many items the project file contributed. Zero unless it was read. */
	projectCount: number;
	globalPath: string;
	projectPath: string;
	/** A project file exists but was not read because the project is not trusted. */
	skippedUntrusted: boolean;
}

export interface LayeredItemsOptions {
	cwd: string;
	/** Pi's answer for this project. Untrusted projects contribute nothing. */
	projectTrusted: boolean;
	agentDir?: string;
}

/**
 * Global items with the trusted project's items merged over them, project winning on `channel:id`.
 *
 * Layering rather than choosing one file: the global file carries machine-wide defaults, the
 * project file carries what only makes sense in that repository, and a project entry that names an
 * existing global id is how you override a default without deleting it. Both files feed the same
 * registries, so rendering cannot tell which file an item came from.
 *
 * Errors carry the path they came from; a broken project file must not discard the global items.
 */
export function loadLayeredItems(options: LayeredItemsOptions): LayeredItems {
	const globalPath = itemsFilePath(options.agentDir);
	const projectPath = projectItemsFilePath(options.cwd);
	const global = readItemsFile(globalPath);
	const errors = global.errors.map((error) => `${globalPath}: ${error}`);

	// Map keeps insertion order: an override replaces in place, a project-only item appends.
	const merged = new Map<string, DeclarativeItem>();
	for (const item of global.items) merged.set(itemKey(item), item);

	const overridden: string[] = [];
	let skippedUntrusted = false;
	let projectCount = 0;
	if (existsSync(projectPath)) {
		if (!options.projectTrusted) {
			skippedUntrusted = true;
		} else {
			const project = readItemsFile(projectPath);
			errors.push(...project.errors.map((error) => `${projectPath}: ${error}`));
			for (const item of project.items) {
				const key = itemKey(item);
				if (merged.has(key)) overridden.push(key);
				merged.set(key, item);
			}
			projectCount = project.items.length;
		}
	}

	return {
		items: [...merged.values()],
		errors,
		overridden,
		projectCount,
		globalPath,
		projectPath,
		skippedUntrusted,
	};
}

let writeQueue: Promise<unknown> = Promise.resolve();

/** Serialize writes so a concurrent CLI invocation cannot interleave with a rename. */
export function writeItemsFile(file: ItemsFile, path = itemsFilePath()): Promise<void> {
	const write = writeQueue.then(async () => {
		mkdirSync(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
	});
	writeQueue = write.catch(() => {});
	return write;
}

/** Read-modify-write. Every mutation goes through this so unrelated items survive an edit. */
export async function updateItemsFile(
	mutate: (file: ItemsFile) => ItemsFile | undefined,
	path = itemsFilePath(),
): Promise<ItemsFile> {
	const { items } = readItemsFile(path);
	const next = mutate({ version: 1, items }) ?? { version: 1, items };
	await writeItemsFile(next, path);
	return next;
}

/** Register-time guard: reject text that cannot become a tag, before it reaches a registry. */
export function isValidItemId(id: string): boolean {
	return ITEM_ID.test(id);
}
