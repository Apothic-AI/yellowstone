/**
 * Template expansion for declarative items.
 *
 * Syntax is `{{name}}` or `{{name:argument}}`, with optional inner whitespace. Names resolve in
 * this order:
 *
 * 1. **`exec:`** — `{{exec:date}}` runs a shell command and uses its trimmed stdout.
 * 2. **Built-ins** — `{{datetime}}`, `{{datetime:iso}}`, `{{datetime:date}}`.
 *
 * There is no environment-variable syntax. One mechanism covers both: `{{exec:echo $HOME}}` reads
 * an env var, `{{exec:git rev-parse --abbrev-ref HEAD}}` reads the branch, `{{exec:date}}` reads the
 * clock. A bespoke placeholder per source would grow the syntax forever.
 *
 * Why hand-rolled instead of a template engine: the input comes from a config file, so expansion
 * must not evaluate expressions, reach the network, or traverse objects. A two-branch `replace`
 * over a closed set of built-ins plus an explicit `exec:` prefix is auditable at a glance.
 *
 * `{{…}}` was chosen over `${…}` because these strings sit inside XML-ish prompts and `${…}` appears
 * in real shell and JS content people paste into them.
 *
 * Unresolved placeholders are left verbatim and reported, so a typo is visible rather than silently
 * becoming an empty string.
 */
import { BUILTINS, type BuiltinContext, isBuiltin } from "./builtins.ts";
import { type ExecOptions, execTemplateCommand } from "./exec.ts";

export interface TemplateContext extends BuiltinContext {
	/** Working directory for `exec:` commands. */
	cwd: string;
	/** Injectable command runner, so tests never spawn a process. */
	exec?: (command: string, options: ExecOptions) => { output?: string; error?: string };
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface Expansion {
	text: string;
	/** Placeholders that could not resolve, reported rather than swallowed. */
	unresolved: string[];
}

/**
 * Expand one template string. Never throws: a failed command leaves its placeholder in place and
 * lands in `unresolved`.
 */
export function expandTemplateWithReport(content: string, context: TemplateContext): Expansion {
	const unresolved: string[] = [];
	const run = context.exec ?? execTemplateCommand;

	const text = content.replace(TEMPLATE, (match, token: string) => {
		const separator = token.indexOf(":");
		const name = separator === -1 ? token : token.slice(0, separator);
		const argument = separator === -1 ? undefined : token.slice(separator + 1);

		if (name === "exec") {
			if (argument === undefined || argument.trim().length === 0) {
				unresolved.push(match);
				return match;
			}
			const result = run(argument, { cwd: context.cwd });
			if (result.output === undefined) {
				unresolved.push(match);
				return match;
			}
			return result.output;
		}

		if (isBuiltin(name)) return BUILTINS[name](context, argument);

		// No implicit environment fallback: a bare `{{NAME}}` typo must not become anything at all.
		unresolved.push(match);
		return match;
	});

	return { text, unresolved };
}

/** Convenience form for callers that only want the text. */
export function expandTemplate(content: string, context: TemplateContext): string {
	return expandTemplateWithReport(content, context).text;
}
