/**
 * Command execution for `{{exec:…}}` templates.
 *
 * Deliberately a sibling of the built-in resolver rather than part of it: running a command is a
 * different risk class from formatting a date, and keeping it in one small module makes the
 * boundary auditable.
 *
 * Why exec instead of `{{env:NAME}}` syntax: one mechanism covers both. `echo $HOME` reads an
 * environment variable, `git rev-parse --abbrev-ref HEAD` reads the branch, `date` reads the clock.
 * Adding a bespoke placeholder per source would grow the syntax forever.
 *
 * One guard, and it is about consent rather than cost: **explicit syntax only**. A command never
 * runs unless the item author wrote `{{exec:…}}`. A bare `{{NAME}}` is not an environment lookup —
 * a silent fallback would turn a typo into a shell invocation.
 *
 * No caching. A command runs on every request, because a stale clock is worse than a fresh one and
 * `echo`/`date` cost microseconds. A `timeout` still bounds a command that hangs, since that would
 * otherwise stall the request.
 */
import { execFileSync } from "node:child_process";

/** A command that runs longer than this is killed rather than stalling the request. */
export const DEFAULT_EXEC_TIMEOUT_MS = 3_000;

export interface ExecResult {
	/** Trimmed stdout, or undefined when the command failed or timed out. */
	output?: string;
	/** Present when the command did not produce usable output. */
	error?: string;
}

export interface ExecOptions {
	cwd: string;
	timeoutMs?: number;
}

/**
 * Run one shell command and return its trimmed stdout.
 *
 * The command is passed to `sh -c` as a single string, which is what the template author wrote —
 * splitting it ourselves would break quoting and pipelines for no benefit. Anyone who can edit the
 * items file can already run code as the user, so this is not a privilege boundary; the guard that
 * matters is that it never runs unless explicitly requested.
 */
export function execTemplateCommand(command: string, options: ExecOptions): ExecResult {
	let result: ExecResult;
	try {
		const stdout = execFileSync("sh", ["-c", command], {
			cwd: options.cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
		}).trim();
		result = stdout.length > 0 ? { output: stdout } : { error: "no output" };
	} catch (error) {
		// A non-zero exit is not automatically a failure — `git rev-parse` exits non-zero outside a
		// repo, and that is exactly the case where the placeholder should be left visible.
		const stdout = (error as { stdout?: unknown }).stdout;
		const text = typeof stdout === "string" ? stdout.trim() : "";
		if (text.length > 0) result = { output: text };
		else {
			const killed = (error as { signal?: string }).signal !== undefined;
			result = { error: killed ? "timed out" : "command failed" };
		}
	}

	return result;
}
