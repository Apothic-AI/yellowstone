/**
 * Launcher argument parsing for the `pi-profile` binary.
 *
 * Grammar: `pi-profile [profile] [--] <pi args>...`
 * - The launcher consumes exactly two things: an optional leading positional
 *   profile name, and at most one `--` separator. Positional arguments after
 *   the profile name belong to pi (they are pi's message arguments).
 * - Everything else is passed through to Pi verbatim (ADR-0005): any pi flag,
 *   known or unknown, reaches the real pi binary unchanged.
 * - `--approve` / `-a` / `--no-approve` / `-na` are recognized and recorded as
 *   a trust override input; the caller decides whether to re-apply them
 *   (default profile: native passthrough) or feed them to the resolver
 *   (non-default profiles: one-run trust input, never forwarded, so Pi never
 *   auto-discovers unfiltered project resources). Contradictory repeats are
 *   last-wins, matching CLI convention.
 */

export interface LauncherArgs {
	/** Positional profile name; undefined means "use the default or saved profile". */
	profile: string | undefined;
	/** Arguments forwarded verbatim to the spawned pi process. */
	piArgs: string[];
	/** Trust override recorded from --approve/-a (true) or --no-approve/-na (false). */
	trustOverride: boolean | undefined;
}

const APPROVE_FLAGS = new Set(["--approve", "-a"]);
const NO_APPROVE_FLAGS = new Set(["--no-approve", "-na"]);

export function parseLauncherArgs(argv: string[]): LauncherArgs {
	const rest = [...argv];

	let profile: string | undefined;
	if (rest[0] !== undefined && !rest[0].startsWith("-")) {
		profile = rest.shift();
	}
	// Consume at most one separator (pi-profile's own); later `--` belong to pi.
	if (rest[0] === "--") {
		rest.shift();
	}

	let trustOverride: boolean | undefined;
	const piArgs: string[] = [];
	for (const arg of rest) {
		if (APPROVE_FLAGS.has(arg)) {
			trustOverride = true; // last-wins, like pi's own flag handling
			continue;
		}
		if (NO_APPROVE_FLAGS.has(arg)) {
			trustOverride = false;
			continue;
		}
		piArgs.push(arg);
	}

	return { profile, piArgs, trustOverride };
}
