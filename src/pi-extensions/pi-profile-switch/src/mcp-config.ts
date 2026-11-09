/**
 * McpConfigDiscovery: reads MCP server names and configurations from the
 * user-level sources Pi's built-in MCP extension reads, without ever
 * managing them.
 *
 * pi-profile never stores MCP connection parameters or credentials
 * (ADR-0016); this module reads definitions for reference discovery and
 * the instance `mcp.json` snapshot.
 *
 * Discovery scope: standard user-global configs (~/.config/mcp/mcp.json,
 * ~/.agents/mcp.json, ~/.agents/mcp/mcp.json), the Pi-global
 * `<agentDir>/mcp.json`, and, when trusted, the project's `.pi/mcp.json`
 * (read for ownership classification only — Pi reads the file itself).
 * The legacy project-root `.mcp.json` source is not read.
 *
 * Malformed config files follow the discovery tier: strict mode throws
 * `McpConfigError`; activation uses diagnostic mode, which skips malformed
 * sources with path-bearing diagnostics so valid sources still merge.
 * Unexpected filesystem failures propagate in either mode.
 */

import { homedir } from "node:os";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";

export class McpConfigError extends Error {
	readonly filePath: string;

	constructor(message: string, filePath: string) {
		super(message);
		this.name = "McpConfigError";
		this.filePath = filePath;
	}
}

export interface McpDiscoveryOptions {
	homeDir?: string;
	/** How an unreadable or malformed source is handled. "throw" (default)
	 *  fails discovery with `McpConfigError`; "diagnose" skips the source and
	 *  records a path-bearing diagnostic so valid sources still merge. */
	invalidSource?: "throw" | "diagnose";
}

export interface MergedMcpResult {
	servers: Record<string, Record<string, unknown>>;
	sharedServers: Set<string>;
	/** Servers defined in a trusted project's own `.pi/mcp.json`. They are
	 *  not the profile's to narrow. */
	projectServers: Set<string>;
	/** Winning origin of each discovered server: "project" if defined or
	 *  shadowed by project-level configuration, "user" otherwise. */
	serverOwners: Record<string, "user" | "project">;
	/** The merged user-level configuration object, with later sources
	 *  overriding earlier ones per server name. */
	baseConfig?: Record<string, unknown>;
	/** Path-bearing diagnostics for sources skipped in "diagnose" mode.
	 *  Always populated by `loadMergedMcpServers`; absent from hand-built
	 *  discovery fixtures. */
	diagnostics?: string[];
}

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

export interface McpConfigSource {
	path: string;
	isShared: boolean;
	isAgentDir?: boolean;
	/** Project-scope source: only read for a trusted project, and its servers
	 *  stay enabled regardless of a profile's `mcps` declaration. */
	isProject?: boolean;
}

/**
 * Standard MCP configuration sources for Pi's built-in MCP extension, in
 * precedence order. Project scope is classification-only: the trusted
 * project's `.pi/mcp.json` is read so its servers can be reported as
 * project-owned, but Pi reads that file itself.
 *
 * 1. ~/.config/mcp/mcp.json (user-global standard MCP)
 * 2. ~/.agents/mcp.json (user-global .agents MCP)
 * 3. ~/.agents/mcp/mcp.json (user-global .agents nested MCP)
 * 4. <agentDir>/mcp.json (Pi global override)
 * 5. <projectDir>/.pi/mcp.json (project Pi override, when project is trusted)
 */
export function getStandardMcpConfigSources(
	agentDir: string,
	projectDir?: string,
	options?: McpDiscoveryOptions,
): McpConfigSource[] {
	const home = options?.homeDir ?? process.env.HOME ?? homedir();
	const sources: McpConfigSource[] = [
		{ path: path.join(home, ".config", "mcp", "mcp.json"), isShared: true },
		{ path: path.join(home, ".agents", "mcp.json"), isShared: true },
		{ path: path.join(home, ".agents", "mcp", "mcp.json"), isShared: true },
		{ path: path.join(agentDir, "mcp.json"), isShared: false, isAgentDir: true },
	];
	if (projectDir !== undefined) {
		sources.push({ path: path.join(projectDir, ".pi", "mcp.json"), isShared: false, isProject: true });
	}
	return sources;
}

export async function loadMergedMcpServers(
	agentDir: string,
	projectDir?: string,
	options?: McpDiscoveryOptions,
): Promise<MergedMcpResult> {
	const invalidSource = options?.invalidSource ?? "throw";
	const sources = getStandardMcpConfigSources(agentDir, projectDir, options);
	const seenPaths = new Set<string>();
	const servers: Record<string, Record<string, unknown>> = {};
	const sharedServers = new Set<string>();
	const projectServers = new Set<string>();
	const serverOwners: Record<string, "user" | "project"> = {};
	const diagnostics: string[] = [];
	let baseConfig: Record<string, unknown> | undefined;

	/** Strict mode fails discovery; diagnostic mode records the path and
	 *  skips only that source, leaving valid sources available. */

	for (const source of sources) {
		const resolvedPath = path.resolve(source.path);
		if (seenPaths.has(resolvedPath)) continue;
		seenPaths.add(resolvedPath);

		const result = await readJsonFile(resolvedPath);
		if (!result.ok) {
			if (result.reason === "missing") continue;
			if (invalidSource === "diagnose") {
				diagnostics.push(`MCP config is not valid JSON: ${resolvedPath}`);
				continue;
			}
			throw new McpConfigError(`MCP config is not valid JSON: ${resolvedPath}`, resolvedPath);
		}
		if (!isRecord(result.value)) {
			if (invalidSource === "diagnose") {
				diagnostics.push(`MCP config must be a JSON object: ${resolvedPath}`);
				continue;
			}
			throw new McpConfigError(`MCP config must be a JSON object: ${resolvedPath}`, resolvedPath);
		}
		if (result.value.mcpServers !== undefined && !isRecord(result.value.mcpServers)) {
			if (invalidSource === "diagnose") {
				diagnostics.push(`"mcpServers" must be a JSON object: ${resolvedPath}`);
				continue;
			}
			throw new McpConfigError(`"mcpServers" must be a JSON object: ${resolvedPath}`, resolvedPath);
		}

		if (!source.isProject) {
			// Merge user-level base configuration: later sources override
			// earlier ones, with the agentDir file as the final user-level
			// source. Project sources do not participate in the snapshot.
			baseConfig = baseConfig === undefined ? { ...result.value } : { ...baseConfig, ...result.value };
		}

		if (result.value.mcpServers === undefined) continue;
		for (const [name, def] of Object.entries(result.value.mcpServers)) {
			// Align discovery with JSON semantics: inherited prototype keys are
			// never treated as discoverable server names.
			if (name === "__proto__") continue;
			if (source.isShared) {
				sharedServers.add(name);
			}
			if (source.isProject === true) projectServers.add(name);
			setOwnRecordValue(serverOwners, name, source.isProject === true ? "project" : "user");
			// Whole-definition precedence: a later definition replaces the same-named
			// server entirely. Connection, credential, and exposure fields are never
			// inherited from an earlier source, so a later URL cannot pick up an
			// earlier authorization header (D1).
			setOwnRecordValue(servers, name, isRecord(def) ? { ...def } : {});
		}
	}

	return { servers, sharedServers, projectServers, serverOwners, baseConfig, diagnostics };
}
