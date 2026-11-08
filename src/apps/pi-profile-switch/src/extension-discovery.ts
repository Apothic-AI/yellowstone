/**
 * ExtensionDiscovery: implicit, read-only discovery of selectable extensions
 * (ADR-0007/0008), so profiles can reference extensions without any
 * registration step.
 *
 * Two implicit sources, both resolved by Pi itself:
 * - Configured packages: `DefaultPackageManager.resolve()` expands each
 *   package's `package.json#pi.extensions` (files, directories, globs, the
 *   package's own `+`/`-`/`!` filters, `.gitignore` rules) exactly like the
 *   spawned pi does at startup. The package name — or an alias such as the
 *   `npm:` source string — is the profile-facing reference.
 * - Loose extension files: `<agentDir>/extensions/**` and, for trusted
 *   projects, `<projectDir>/.pi/extensions/**`, referenced by a path-derived
 *   ID ("conventions", "guards/review").
 *
 * This module owns naming, merging, selection, and glob expansion only. Entry
 * enumeration is Pi's own, so a new Pi convention (or a fix to one) cannot
 * silently diverge from what the spawned pi actually loads.
 *
 * Discovery stays side-effect free: `resolve()` is called with
 * `onMissing: "skip"`, which never installs and never touches the network,
 * and extension code is never imported.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { DefaultPackageManager, SettingsManager, type PackageManager } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

import { isRecord } from "./json-file.ts";
import type { ResolutionDiagnostic } from "./profile-resolver.ts";

export interface DiscoveredPackage {
	/** Selectable package name: package.json "name", or the source minus its
	 *  npm:/git:/github: prefix (and any version spec) when unreadable. */
	name: string;
	/** The source string exactly as configured in the user's settings
	 *  (e.g. "npm:pi-web-access"); accepted as a reference alias. */
	source: string;
	/** Absolute install/local root of the package. */
	root: string;
	/** Absolute paths of the package's enabled extension entries. */
	entries: string[];
}

export interface DiscoveredLocalExtension {
	/** Selectable ID: the path under the extensions dir, without the file
	 *  extension and with a trailing "/index" collapsed ("conventions",
	 *  "guards/review"). */
	id: string;
	entry: string;
}

export interface ImplicitExtensionDiscovery {
	packages: DiscoveredPackage[];
	/** Loose files, project entries already merged over same-ID global ones. */
	local: DiscoveredLocalExtension[];
	/** Non-fatal notices (skipped packages, shadowed duplicates). */
	warnings: string[];
}

export class ExtensionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtensionError";
	}
}

export interface SelectedExtension {
	id: string;
	entry: string;
	origin?: "package" | "local" | "path";
}

export interface SelectExtensionsResult {
	entries: SelectedExtension[];
	unmatched: string[];
	diagnostics?: ResolutionDiagnostic[];
}

function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

function looksLikePath(reference: string): boolean {
	return (
		reference.startsWith("/") ||
		reference.startsWith("~/") ||
		reference.startsWith("./") ||
		reference.startsWith("../") ||
		/\.(ts|js)$/.test(reference)
	);
}

export class DiscoveredExtensions {
	readonly #packages: readonly DiscoveredPackage[];
	readonly #local: readonly DiscoveredLocalExtension[];
	readonly #warnings: string[];
	readonly #entries: ReadonlyMap<string, { id: string; entry: string; packageName?: string; origin: "package" | "local" }>;

	constructor(packages: readonly DiscoveredPackage[], local: readonly DiscoveredLocalExtension[], warnings: string[]) {
		this.#packages = packages;
		this.#local = local;
		this.#warnings = [...warnings];

		const entries = new Map<string, { id: string; entry: string; packageName?: string; origin: "package" | "local" }>();
		for (const loc of local) {
			entries.set(loc.id, { id: loc.id, entry: loc.entry, origin: "local" });
		}
		for (const pkg of packages) {
			for (const entryPath of pkg.entries) {
				const id = pkg.entries.length === 1 ? pkg.name : `${pkg.name}:${toPosix(path.relative(pkg.root, entryPath))}`;
				if (entries.has(id)) {
					this.#warnings.push(
						`extension id "${id}" is provided by both a local file and package "${pkg.source}"; the local file wins — reference the package as "${pkg.source}"`,
					);
					continue;
				}
				entries.set(id, { id, entry: entryPath, packageName: pkg.name, origin: "package" });
			}
		}
		this.#entries = entries;
	}

	get(id: string): { id: string; entry: string; origin: "package" | "local" } | undefined {
		return this.#entries.get(id);
	}

	list(): SelectedExtension[] {
		return [...this.#entries.values()].map((e) => ({ id: e.id, entry: e.entry, origin: e.origin }));
	}

	warnings(): string[] {
		return [...this.#warnings];
	}

	selectableNames(): string[] {
		const names = new Set(this.#entries.keys());
		for (const pkg of this.#packages) names.add(pkg.name);
		return [...names].sort();
	}

	#packageByNameOrAlias(reference: string): DiscoveredPackage | undefined {
		return this.#packages.find((pkg) => pkg.name === reference || pkg.source === reference);
	}

	#packageEntries(pkg: DiscoveredPackage): SelectedExtension[] {
		return pkg.entries.map((entryPath) => {
			const id = pkg.entries.length === 1 ? pkg.name : `${pkg.name}:${toPosix(path.relative(pkg.root, entryPath))}`;
			const existing = this.#entries.get(id);
			if (existing !== undefined && existing.entry === entryPath) return existing;
			return { id, entry: entryPath, origin: "package" };
		});
	}

	#unknownMessage(reference: string, names: string[]): string {
		const lines = [
			`unknown extension: "${reference}" — no installed package, extension file, or path matches it.`,
		];
		if (names.length > 0) {
			const shown = names.slice(0, 10);
			lines.push(`discovered: ${shown.join(", ")}${names.length > shown.length ? ` (+${names.length - shown.length} more)` : ""}`);
		}
		const suggestion = names.find(
			(name) =>
				name.toLowerCase().includes(reference.toLowerCase()) || reference.toLowerCase().includes(name.toLowerCase()),
		);
		if (suggestion !== undefined) {
			lines.push(`did you mean "${suggestion}"?`);
		}
		return lines.join("\n");
	}

	async select(references: string[]): Promise<SelectExtensionsResult> {
		const byPath = new Map<string, SelectedExtension>();
		const unmatched: string[] = [];
		const diagnostics: ResolutionDiagnostic[] = [];
		const diagnose = (reference: string, code: string, cause: string, filePath?: string): void => {
			diagnostics.push({ kind: "extension", code, reference, message: `${cause}; not loaded`, ...(filePath !== undefined ? { filePath } : {}) });
		};
		const names = this.selectableNames();

		const add = (entry: SelectedExtension): void => {
			if (!byPath.has(entry.entry)) byPath.set(entry.entry, entry);
		};

		for (const reference of references) {
			if (reference.includes("*") || reference.includes("?")) {
				let matched = 0;
				for (const name of names) {
					if (!minimatch(name, reference)) continue;
					matched += 1;
					const pkg = this.#packageByNameOrAlias(name);
					const entry = this.#entries.get(name);
					if (pkg !== undefined && pkg.name === name) {
						const pkgEntries = this.#packageEntries(pkg);
						if (pkgEntries.length === 0) {
							diagnose(reference, "empty-package", `package "${pkg.name}" declares no extension entries; restore an entry or remove the reference`, pkg.root);
						}
						for (const pkgEntry of pkgEntries) add(pkgEntry);
					}
					if (entry !== undefined) add(entry);
				}
				if (matched === 0) {
					unmatched.push(reference);
					diagnose(reference, "zero-match", `"extension:${reference}" matched nothing this resolution`);
				}
				continue;
			}

			const entry = this.#entries.get(reference);
			if (entry !== undefined) {
				add(entry);
				continue;
			}
			const pkg = this.#packageByNameOrAlias(reference);
			if (pkg !== undefined) {
				const pkgEntries = this.#packageEntries(pkg);
				if (pkgEntries.length === 0) {
					diagnose(reference, "empty-package", `package "${reference}" declares no extension entries (missing on disk or filtered out by its settings package entry); restore an entry or remove the reference`);
					continue;
				}
				for (const pkgEntry of pkgEntries) add(pkgEntry);
				continue;
			}
			if (looksLikePath(reference)) {
				if (!path.isAbsolute(reference) && !reference.startsWith("~/")) {
					diagnose(reference, "relative-path", `extension reference "${reference}" is a relative path; profiles take absolute paths (or ~/...) — catalogs live in both global and project scope, so a relative base would be ambiguous`);
					continue;
				}
				const resolved = reference.startsWith("~/")
					? path.join(process.env.HOME ?? "", reference.slice(1))
					: path.resolve(reference);
				if (!(await isFile(resolved))) {
					diagnose(reference, "missing-path", `extension path not found: ${resolved}; restore the file or remove the reference`, resolved);
					continue;
				}
				add({ id: resolved, entry: resolved, origin: "path" });
				continue;
			}
			diagnose(reference, "unknown-reference", `${this.#unknownMessage(reference, names)} Install the extension or correct the reference`);
		}

		return { entries: [...byPath.values()], unmatched, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
	}
}

/** Derives a package name from its source string when package.json is
 *  unreadable: strips the npm:/git:/github: prefix and any version spec
 *  (scoped names keep their "@scope/" prefix). */
export function packageNameFromSource(source: string): string {
	let name = source.replace(/^(npm|git|github):/, "");
	if (name.startsWith("@")) {
		// @scope/pkg[@version] — cut a version spec only after the scope path.
		const slash = name.indexOf("/");
		const versionAt = slash === -1 ? -1 : name.indexOf("@", slash);
		if (versionAt !== -1) name = name.slice(0, versionAt);
	} else {
		const versionAt = name.indexOf("@");
		if (versionAt !== -1) name = name.slice(0, versionAt);
	}
	return name;
}

/** Selectable ID for a loose extension file: its path under the extensions
 *  dir without the file extension, with a trailing "/index" collapsed so a
 *  directory-style extension is referenced by its directory name. */
function looseId(filePath: string, extensionsDir: string): string {
	const rel = toPosix(path.relative(extensionsDir, filePath));
	const collapsed = rel.replace(/(?:^|\/)index\.(ts|js)$/, "");
	const base = collapsed === "" ? rel : collapsed;
	return base.replace(/\.(ts|js)$/, "");
}

/** Reads a package's display name from its manifest, falling back to the
 *  source string when the manifest is missing or has no name. */
async function readPackageName(root: string, source: string): Promise<string> {
	try {
		const manifest: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
		if (isRecord(manifest) && typeof manifest.name === "string" && manifest.name.length > 0) return manifest.name;
	} catch {
		// Not installed (a skipped source) or unreadable — derive from source.
	}
	return packageNameFromSource(source);
}

export interface DiscoverExtensionsOptions {
	/** Project working directory (Pi's cwd). */
	cwd: string;
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/**
	 * Whether the project at `cwd` is trusted (the launcher's trust check).
	 * Untrusted projects contribute nothing: no project settings packages, no
	 * `.pi/extensions` files. Defaults to false.
	 */
	projectTrusted?: boolean;
}

/** Builds the Pi package manager that owns discovery for one cwd/agentDir. */
function createPackageManager(options: DiscoverExtensionsOptions): PackageManager {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: options.projectTrusted ?? false,
	});
	return new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	});
}

interface PackageGroup {
	source: string;
	root: string;
	entries: string[];
	/** Some declared entry exists on disk, even if all are disabled — keeps
	 *  "package is filtered out" distinguishable from "package has no
	 *  extensions". */
	known: boolean;
}

/** Runs Pi's own resolution once and classifies the result into pi-profile's
 *  selectable model. */
async function resolveImplicit(packageManager: PackageManager, agentDir: string): Promise<ImplicitExtensionDiscovery> {
	const warnings: string[] = [];
	// `skip` is the API's read-only mode: missing sources are reported as
	// absent instead of triggering an install (no network, no mutation).
	const resolved = await packageManager.resolve(async () => "skip");
	// Sort for deterministic IDs and ordering: Pi preserves directory read
	// order, which varies by filesystem.
	const resources = [...resolved.extensions].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const groups = new Map<string, PackageGroup>();
	const userLoose = new Map<string, DiscoveredLocalExtension>();
	const projectLoose = new Map<string, DiscoveredLocalExtension>();

	for (const resource of resources) {
		const { source, scope, origin, baseDir } = resource.metadata;
		if (origin === "package") {
			// Project-scope packages install under the project's .pi/npm, which
			// generated global-scope settings cannot reference.
			if (scope === "project") continue;
			if (baseDir === undefined) continue;
			const group = groups.get(source) ?? { source, root: baseDir, entries: [], known: false };
			// A local source with no manifest and no convention dir resolves to
			// the directory itself; the loader imports paths verbatim, so it is
			// not selectable and must not be advertised.
			if (await isFile(resource.path)) {
				group.known = true;
				if (resource.enabled && !group.entries.includes(resource.path)) group.entries.push(resource.path);
			}
			groups.set(source, group);
			continue;
		}
		// Settings-declared paths (`extensions: [...]`) are already concrete
		// files, so profiles reference them directly instead of through a
		// derived ID; only auto-discovered directory contents become IDs.
		if (!resource.enabled || source !== "auto") continue;
		const extensionsDir = path.join(baseDir ?? agentDir, "extensions");
		const id = looseId(resource.path, extensionsDir);
		const target = scope === "project" ? projectLoose : userLoose;
		const existing = target.get(id);
		if (existing === undefined) {
			target.set(id, { id, entry: resource.path });
			continue;
		}
		// Pi reports a `.ts`/`.js` stem pair as two entries; keep its
		// TypeScript-first convention, but say so instead of silently
		// shadowing the file the loader would pick.
		if (!existing.entry.endsWith(".ts") && resource.path.endsWith(".ts")) {
			warnings.push(`extension "${id}" exists as both .ts and .js in ${extensionsDir}; the .ts file is used`);
			target.set(id, { id, entry: resource.path });
		}
	}

	const packages: DiscoveredPackage[] = [];
	for (const group of groups.values()) {
		if (!group.known) continue;
		packages.push({
			name: await readPackageName(group.root, group.source),
			source: group.source,
			root: group.root,
			entries: group.entries,
		});
	}

	// Project loose files override same-ID global ones, mirroring the
	// project-over-global catalog override convention.
	const merged = new Map(userLoose);
	for (const [id, entry] of projectLoose) merged.set(id, entry);

	return { packages, local: [...merged.values()], warnings };
}

export async function discoverImplicitExtensions(options: DiscoverExtensionsOptions): Promise<ImplicitExtensionDiscovery> {
	return await resolveImplicit(createPackageManager(options), options.agentDir);
}

export async function discoverExtensions(options: DiscoverExtensionsOptions): Promise<DiscoveredExtensions> {
	const raw = await discoverImplicitExtensions(options);
	return new DiscoveredExtensions(raw.packages, raw.local, raw.warnings);
}
