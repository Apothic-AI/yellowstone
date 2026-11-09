/**
 * ProfileCatalog: reads profile definitions from the global catalog
 * (`~/.pi-profile-switch/profiles/`, or `PI_PROFILE_SWITCH_DIR/profiles/`)
 * and, for trusted projects, the project catalog (`<projectDir>/.pi/profiles/`).
 *
 * Invariants:
 * - Each profile is stored in a separate `<name>.json` file.
 * - Filename indexing decides project precedence before definition reads.
 * - Only selected winners are parsed; listing isolates definition errors.
 * - The caller supplies projectDir only after its trust check passes.
 */

import { readFileSync, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { getGlobalProfilesDir } from "./workspace.ts";
import { isRecord, readJsonFile } from "./json-file.ts";
import { parseSubagentSettings, SubagentSettingsError, type ProfileSubagentSettings } from "./subagent-settings.ts";

const supportedFields = Object.keys(
	(JSON.parse(readFileSync(new URL("../schemas/profiles.schema.json", import.meta.url), "utf8")) as {
		properties: Record<string, unknown>;
	}).properties,
);

export const DEFAULT_PROFILE_NAME = "default";
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ProfileModel {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

/** A profile definition as stored in a catalog file. All fields optional:
 *  undeclared fields leave Pi's behavior untouched (PRD default-first rule).
 *  Model fields mirror Pi's settings.json keys (defaultProvider/defaultModel/
 *  defaultThinkingLevel) for direct compatibility. */
export interface ProfileDefinition {
	label?: string;
	description?: string;
	skills?: string[];
	extensions?: string[];
	mcps?: string[];
	tools?: string[];
	/** Literal MCP tool names per server; globs are rejected. */
	mcp_tools?: Record<string, string[]>;
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	instructions?: string;
	subagents?: ProfileSubagentSettings;
}

/** Where a profile's definition came from. */
export type ProfileSource = "builtin" | "global" | "project";

interface CatalogEntry {
	source: "global" | "project";
	filePath: string;
}

export interface ResolvedProfile {
	name: string;
	source: ProfileSource;
	definition: ProfileDefinition;
	warnings?: string[];
}

export interface CatalogListItem {
	name: string;
	source: ProfileSource;
	shadowsGlobal: boolean;
	available: boolean;
	definition?: ProfileDefinition;
	error?: string;
	warnings?: string[];
}

export class CatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogError";
	}
}

function readStringArray(value: unknown, field: string, profileName: string, filePath?: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		const prefix = filePath ? `${filePath}: ` : "";
		throw new CatalogError(`${prefix}profile "${profileName}": "${field}" must be an array of strings`);
	}
	return value as string[];
}

function readOptionalString(value: unknown, field: string, profileName: string, filePath?: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		const prefix = filePath ? `${filePath}: ` : "";
		throw new CatalogError(`${prefix}profile "${profileName}": "${field}" must be a string`);
	}
	return value;
}

function isGlobPattern(value: string): boolean {
	return (
		value.includes("*") ||
		value.includes("?") ||
		value.includes("[") ||
		value.includes("]") ||
		value.includes("{") ||
		value.includes("}")
	);
}

function readMcpTools(
	value: unknown,
	profileName: string,
	filePath?: string,
): Record<string, string[]> | undefined {
	if (value === undefined) return undefined;
	const prefix = filePath ? `${filePath}: ` : "";
	if (!isRecord(value)) {
		throw new CatalogError(`${prefix}profile "${profileName}": "mcp_tools" must be an object of string arrays`);
	}
	const entries: Array<[string, string[]]> = [];
	for (const [server, tools] of Object.entries(value)) {
		if (isGlobPattern(server)) {
			throw new CatalogError(
				`${prefix}profile "${profileName}": "mcp_tools" server "${server}" is a glob pattern; literal MCP server names are required`,
			);
		}
		if (!Array.isArray(tools) || tools.some((entry) => typeof entry !== "string")) {
			throw new CatalogError(`${prefix}profile "${profileName}": "mcp_tools" must be an object of string arrays`);
		}
		for (const tool of tools) {
			if (isGlobPattern(tool)) {
				throw new CatalogError(
					`${prefix}profile "${profileName}": "mcp_tools" entry "${tool}" in server "${server}" is a glob pattern; literal MCP tool names are required`,
				);
			}
		}
		entries.push([server, [...tools]]);
	}
	return Object.fromEntries(entries);
}

/** Parses one raw profile definition; the single read-time validator so
 *  catalog files and any external writer stay loadable. */
export function parseProfileDefinition(
	name: string,
	raw: unknown,
	filePath?: string,
	onWarning?: (message: string) => void,
): ProfileDefinition {
	if (!isRecord(raw)) {
		const prefix = filePath ? `${filePath}: ` : "";
		throw new CatalogError(`${prefix}profile "${name}" must be an object`);
	}
	for (const key of Object.keys(raw)) {
		if (!supportedFields.includes(key)) {
			onWarning?.(`${filePath ? `${filePath}: ` : ""}profile "${name}": unknown field "${key}" ignored; supported fields: ${supportedFields.join(", ")}`);
		}
	}
	const definition: ProfileDefinition = {};
	const label = readOptionalString(raw.label, "label", name, filePath);
	if (label !== undefined) definition.label = label;
	const description = readOptionalString(raw.description, "description", name, filePath);
	if (description !== undefined) definition.description = description;
	for (const field of ["skills", "extensions", "mcps", "tools"] as const) {
		const entries = readStringArray(raw[field], field, name, filePath);
		if (entries !== undefined) definition[field] = entries;
	}
	const mcpTools = readMcpTools(raw.mcp_tools, name, filePath);
	if (mcpTools !== undefined) definition.mcp_tools = mcpTools;
	const defaultProvider = readOptionalString(raw.defaultProvider, "defaultProvider", name, filePath);
	if (defaultProvider !== undefined) definition.defaultProvider = defaultProvider;
	const defaultModel = readOptionalString(raw.defaultModel, "defaultModel", name, filePath);
	if (defaultModel !== undefined) definition.defaultModel = defaultModel;
	const defaultThinkingLevel = readOptionalString(raw.defaultThinkingLevel, "defaultThinkingLevel", name, filePath);
	if (defaultThinkingLevel !== undefined) definition.defaultThinkingLevel = defaultThinkingLevel;
	const instructions = readOptionalString(raw.instructions, "instructions", name, filePath);
	if (instructions !== undefined) definition.instructions = instructions;
	try {
		const subagents = parseSubagentSettings(raw.subagents, { profile: name, ...(filePath !== undefined ? { filePath } : {}) });
		if (subagents !== undefined) definition.subagents = subagents;
	} catch (error) {
		if (error instanceof SubagentSettingsError) throw new CatalogError(error.message);
		throw error;
	}
	return definition;
}

/** Indexes regular JSON files without reading their definitions. */
async function indexCatalogDirectory(dirPath: string, diagnostics: string[]): Promise<Map<string, string>> {
	let entries: Dirent[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return new Map();
		}
		throw error;
	}

	// Filter to .json files and sort alphabetically by file name
	const jsonEntries = entries.filter((entry) => entry.name.endsWith(".json"));
	jsonEntries.sort((a, b) => a.name.localeCompare(b.name));

	const profiles = new Map<string, string>();
	for (const entry of jsonEntries) {
		const fullPath = path.join(dirPath, entry.name);
		let isFile = entry.isFile();
		if (!isFile && entry.isSymbolicLink()) {
			try {
				const st = await stat(fullPath);
				isFile = st.isFile();
			} catch {
				continue;
			}
		}
		if (!isFile) continue;

		const profileName = entry.name.slice(0, -".json".length);
		if (profileName === DEFAULT_PROFILE_NAME) {
			diagnostics.push(`${fullPath}: "${DEFAULT_PROFILE_NAME}" is built in and must not be defined in the catalog`);
			continue;
		}
		if (!PROFILE_NAME_PATTERN.test(profileName)) {
			diagnostics.push(`${fullPath}: invalid profile name "${profileName}" (must match ${PROFILE_NAME_PATTERN})`);
			continue;
		}

		profiles.set(profileName, fullPath);
	}
	return profiles;
}

export class ProfileCatalog {
	readonly #profiles: ReadonlyMap<string, CatalogEntry>;
	readonly #globalNames: ReadonlySet<string>;
	readonly #diagnostics: readonly string[];

	private constructor(profiles: ReadonlyMap<string, CatalogEntry>, globalNames: ReadonlySet<string>, diagnostics: string[]) {
		this.#profiles = profiles;
		this.#globalNames = globalNames;
		this.#diagnostics = diagnostics;
	}

	/** Indexes global and trusted-project filenames. Project winners keep the
	 *  global position; project-only names follow in alphabetical order. */
	static async load(_agentDir: string, options?: { projectDir?: string }): Promise<ProfileCatalog> {
		const diagnostics: string[] = [];
		const globalProfiles = await indexCatalogDirectory(getGlobalProfilesDir(), diagnostics);
		const profiles = new Map<string, CatalogEntry>();
		for (const [name, filePath] of globalProfiles) {
			profiles.set(name, { source: "global", filePath });
		}
		if (options?.projectDir !== undefined) {
			const projectProfiles = await indexCatalogDirectory(path.join(options.projectDir, ".pi", "profiles"), diagnostics);
			for (const [name, filePath] of projectProfiles) {
				profiles.set(name, { source: "project", filePath });
			}
		}
		return new ProfileCatalog(profiles, new Set(globalProfiles.keys()), diagnostics);
	}

	hasGlobal(name: string): boolean {
		return this.#globalNames.has(name);
	}

	diagnostics(): string[] {
		return [...this.#diagnostics];
	}

	/** Reads only the winning definition, freshly on every resolution. */
	async resolve(name: string): Promise<ResolvedProfile | undefined> {
		if (!PROFILE_NAME_PATTERN.test(name)) {
			throw new CatalogError(`invalid profile name "${name}" (must match ${PROFILE_NAME_PATTERN})`);
		}
		if (name === DEFAULT_PROFILE_NAME) {
			return { name: DEFAULT_PROFILE_NAME, source: "builtin", definition: {} };
		}
		const entry = this.#profiles.get(name);
		if (entry === undefined) return undefined;
		const result = await readJsonFile(entry.filePath);
		if (!result.ok) {
			throw new CatalogError(result.reason === "missing"
				? `${entry.filePath}: profile "${name}" disappeared; retry resolution`
				: `invalid JSON in ${entry.filePath}`);
		}
		const warnings: string[] = [];
		const definition = parseProfileDefinition(name, result.value, entry.filePath, (warning) => warnings.push(warning));
		return { name, source: entry.source, definition, ...(warnings.length > 0 ? { warnings } : {}) };
	}

	/** Lists only winners, retaining expected definition errors per entry. */
	async list(): Promise<CatalogListItem[]> {
		const items: CatalogListItem[] = [{ name: DEFAULT_PROFILE_NAME, source: "builtin", definition: {}, available: true, shadowsGlobal: false }];
		for (const [name, entry] of this.#profiles) {
			const metadata = { name, source: entry.source, shadowsGlobal: entry.source === "project" && this.hasGlobal(name) };
			try {
				const profile = (await this.resolve(name))!;
				items.push({ ...profile, ...metadata, available: true });
			} catch (error) {
				if (!(error instanceof CatalogError)) throw error;
				items.push({ ...metadata, available: false, error: error.message });
			}
		}
		return items;
	}
}
