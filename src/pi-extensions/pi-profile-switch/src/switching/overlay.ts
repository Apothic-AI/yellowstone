/**
 * Overlay command orchestration (ticket 06; module renamed with the
 * `/profile overlay` subcommand).
 *
 * The overlay narrows the ACTIVE profile for this runtime only. It is
 * written to the scope state file (never a catalog) purely as the
 * persistence/status surface — the runtime effect flows through
 * re-resolution with the overlay, exactly like a switch. The launcher
 * ignores stored overlays, so an overlay never outlives its runtime.
 *
 * Ordering invariants:
 * - disable|enable: re-resolve with the candidate overlay FIRST
 *   (validation: unknown references and enable misses fail here, before
 *   anything is written), then switch+reload, then persist the overlay to
 *   state. A failed switch leaves the stored overlay untouched, consistent
 *   with the rolled-back runtime.
 * - clear: switch+reload WITHOUT the overlay first, then delete it from
 *   state. If the switch rolls back, the stored overlay still matches the
 *   restored runtime.
 */

import path from "node:path";

import { RuntimeStateStore, type RuntimeOverlay, type RuntimeState } from "../runtime-state-store.ts";
import { getGlobalStateDir } from "../workspace.ts";
import { readLaunchPlanFile } from "./apply-plan.ts";
import { SwitchError, switchProfile, type SwitchDeps, type SwitchResult } from "./switch-profile.ts";

/** The scope state file for the currently active profile. */
async function currentStateTarget(
	deps: SwitchDeps,
): Promise<{ profile: string; store: RuntimeStateStore; state: RuntimeState }> {
	const plan = await readLaunchPlanFile(deps.runtimeDir);
	if (plan === undefined) {
		throw new SwitchError("no active profile — nothing to overlay");
	}
	const stateDir = plan.source === "project" ? path.join(deps.cwd, ".pi") : getGlobalStateDir(plan.agentDir);
	if (stateDir === undefined) {
		throw new SwitchError("the launch plan carries no real agent dir — cannot locate the state file");
	}
	const store = new RuntimeStateStore(stateDir);
	return { profile: plan.profile, store, state: await store.read() };
}

/** Applies a mutation to the active profile's overlay and re-activates. */
export async function applyOverlayMutation(
	deps: SwitchDeps,
	mutate: (overlay: RuntimeOverlay) => RuntimeOverlay,
): Promise<SwitchResult> {
	const { profile, store, state } = await currentStateTarget(deps);
	const candidate = mutate(state.overlay ?? {});

	// switchProfile re-resolves with the candidate overlay; resolution-time
	// validation (unknown references) fails before any
	// write. persistSelection is preserved by the reload-current path.
	const result = await switchProfile(profile, deps, { reloadCurrent: true, overlay: candidate });

	await store.update({ overlay: candidate });
	return result;
}

/** Discards the overlay and reactivates the profile exactly as declared. */
export async function clearOverlay(deps: SwitchDeps): Promise<SwitchResult> {
	const { profile, store } = await currentStateTarget(deps);

	// overlay: null — explicit "none"; without it the reload path would
	// re-apply the stored overlay we're discarding.
	const result = await switchProfile(profile, deps, { reloadCurrent: true, overlay: null });

	await store.update({ overlay: undefined });
	return result;
}

export const OVERLAY_USAGE =
	"/profile overlay disable|enable skill|extension|mcp|tool <name-or-glob> · /profile overlay clear" as const;

/** The parsed form of `/profile overlay` arguments: either a mutation to
 *  validate and apply against the stored overlay, or `clear`. */
export type OverlayCommand =
	| { kind: "mutate"; mutate: (overlay: RuntimeOverlay) => RuntimeOverlay }
	| { kind: "clear" };

const DISABLED_FIELDS = {
	skill: "disabledSkills",
	extension: "disabledExtensions",
	mcp: "disabledMcps",
	tool: "disabledTools",
} as const;

/** Parses `/profile overlay` arguments into an overlay command.
 *  Grammar:
 *    overlay disable skill|extension|mcp|tool <name-or-glob>
 *    overlay enable  skill|extension|mcp|tool <name-or-glob>   (remove a stored entry)
 *    overlay clear                                              (discard the overlay)
 *
 *  One uniform grammar for all four resource kinds (the tools-only
 *  replace-form is gone — tools are disabled like the other kinds). The
 *  removed `tools` action falls through to the usage error above.
 *
 *  `enable` removes a stored entry by exact string match — no hole-punching
 *  through globs — and fails when nothing equals the given name, listing the
 *  current entries of that kind.
 */
export function parseOverlayArgs(args: string): OverlayCommand {
	const [action, kind, ...rest] = args.trim().split(/\s+/).filter(Boolean);

	if (action === "clear") {
		if (rest.length > 0 || kind !== undefined) throw new SwitchError(`usage: ${OVERLAY_USAGE}`);
		return { kind: "clear" };
	}

	const field = DISABLED_FIELDS[kind as keyof typeof DISABLED_FIELDS];
	if ((action !== "disable" && action !== "enable") || field === undefined || rest.length !== 1) {
		throw new SwitchError(`usage: ${OVERLAY_USAGE}`);
	}
	const [name] = rest;

	if (action === "disable") {
		return {
			kind: "mutate",
			mutate: (overlay) => {
				const current = overlay[field] ?? [];
				// `name` is always appended, so the list never empties here (the
			// enable closure below owns the delete-when-empty branch).
				return { ...overlay, [field]: [...new Set([...current, name])] };
			},
		};
	}

	return {
		kind: "mutate",
		mutate: (overlay) => {
			const current = overlay[field] ?? [];
			if (!current.includes(name)) {
				throw new SwitchError(
					`no stored ${kind} disable entry equals "${name}" — current entries: ${
						current.length > 0 ? current.join(", ") : "(none)"
					}`,
				);
			}
			const nextList = current.filter((entry) => entry !== name);
			const next = { ...overlay };
			if (nextList.length === 0) delete next[field];
			else next[field] = nextList;
			return next;
		},
	};
}
