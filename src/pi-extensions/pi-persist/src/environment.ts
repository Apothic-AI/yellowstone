import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * One value in the environment section. Rendered as `<name>value</name>`, so the name must be a
 * plain tag: no whitespace, angle brackets, or quotes.
 */
export interface EnvField {
	name: string;
	value: string;
}

/** A block another extension contributes, rendered inside its own tag after the base fields. */
export interface EnvBlock {
	id: string;
	/** Attributes appended verbatim inside the block tag. Escaped, but not otherwise validated. */
	attributes?: Record<string, string>;
	/** Body text. Empty or whitespace-only bodies are dropped. */
	content: string;
}

const ENV_FIELD_NAME = /^[A-Za-z][\w.:-]*$/;
const ENV_BLOCK_ID = /^[A-Za-z][\w.:-]*$/;

export function isValidEnvFieldName(name: string): boolean {
	return ENV_FIELD_NAME.test(name);
}

export function isValidEnvBlockId(id: string): boolean {
	return ENV_BLOCK_ID.test(id);
}

const XML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

/** Escape a value for use in element text or a quoted attribute. */
export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

/**
 * Collapse whitespace and escape. Contributors pass arbitrary strings — paths with spaces, subjects
 * with newlines, anything a tool produced — and a raw newline or angle bracket would break the
 * envelope the model parses.
 */
export function sanitizeEnvValue(value: string): string {
	return escapeXml(value.replace(/\s+/g, " ").trim());
}

export interface ShellFacts {
	/** The shell pi's own bash tool spawns, not the user's login shell. */
	shell: string;
}

/**
 * The shell command execution actually uses. Pi resolves this itself: a configured `shellPath`,
 * Git Bash on Windows, then `/bin/bash`, then `bash` on PATH, then `sh`. Reporting `$SHELL`
 * instead would describe the user's interactive shell while commands run under a different one.
 */
export function detectShell(): ShellFacts {
	try {
		const config = getShellConfig() as { shell?: string } | undefined;
		const shell = config?.shell;
		if (typeof shell === "string" && shell.length > 0) return { shell };
	} catch {
		// Fall through to a conservative description rather than losing the section.
	}
	return { shell: process.platform === "win32" ? "bash" : "sh" };
}

export interface EnvironmentFacts extends ShellFacts {
	cwd: string;
	platform: string;
	arch: string;
}

/**
 * Host facts that hold for the whole session.
 *
 * Deliberately no date or time: both change during a session, and a system-prompt section that
 * changes re-renders the prompt prefix and costs a cache miss. Anything volatile belongs in a
 * per-turn custom message, which does not disturb the cached prefix.
 */
export function detectEnvironment(cwd: string): EnvironmentFacts {
	return {
		cwd,
		...detectShell(),
		platform: process.platform,
		arch: process.arch,
	};
}

export interface RenderEnvironmentOptions {
	/** Fields to omit, e.g. a caller that already renders the working directory elsewhere. */
	omit?: readonly string[];
	blocks?: readonly EnvBlock[];
}

/**
 * Render the section body: base fields in a fixed order, then contributed blocks sorted by id.
 *
 * Returns the inner body only. Pi wraps every prompt section in `<name>…</name>` itself
 * (`system-prompt.js`, `buildSystemPromptSections`), so emitting the wrapper here would nest
 * `<environment_context>` inside an identical outer tag.
 *
 * Ordering is deterministic on purpose. Pi diffs prompt sections per request and appends a
 * transcript delta for what changed, so an unstable order (registration order, Map iteration,
 * a hash) would report a change on every turn and invalidate the cached prompt prefix.
 */
export function renderEnvironment(facts: EnvironmentFacts, options: RenderEnvironmentOptions = {}): string {
	const omit = new Set(options.omit ?? []);
	const lines: string[] = [];
	const field = (name: string, value: string) => {
		if (omit.has(name)) return;
		lines.push(`  <${name}>${sanitizeEnvValue(value)}</${name}>`);
	};
	field("cwd", facts.cwd);
	field("shell", facts.shell);
	field("platform", facts.platform);
	field("arch", facts.arch);

	for (const block of [...(options.blocks ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
		if (!isValidEnvBlockId(block.id)) continue;
		const content = sanitizeEnvValue(block.content);
		if (!content) continue;
		const attributes = Object.entries(block.attributes ?? {})
			.map(([key, value]) => ` ${key}="${sanitizeEnvValue(value)}"`)
			.join("");
		lines.push(`  <${block.id}${attributes}>${content}</${block.id}>`);
	}

	return lines.join("\n");
}
