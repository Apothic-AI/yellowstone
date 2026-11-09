/**
 * RuntimeStateStore: reads and writes a `pi-profile-state.json` runtime
 * state file.
 *
 * Constructed with the directory holding the state file: the real agent dir
 * for global state, the project's `.pi` dir for project state (project
 * state is only touched when the trust check passed). The launcher only
 * reads — the initial CLI selection is transient by design; `/profile use`
 * (ticket 05) writes the selection.
 *
 * `activeProfile` is the saved selection restored on launch.
 *
 * A missing or malformed state file is not an error on read — it simply
 * means "fall back to the default profile". Unexpected I/O errors
 * propagate. Writes replace the file wholesale.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord, readJsonFile } from "./json-file.ts";

export interface RuntimeState {
	activeProfile?: string;
	/** The runtime overlay: temporary narrowing of the active profile
	 *  (ticket 06). Never written to catalogs, never applied at launch —
	 *  only in-session switches/reloads read it. */
	overlay?: RuntimeOverlay;
}

export interface RuntimeOverlay {
	disabledSkills?: string[];
	disabledExtensions?: string[];
	disabledMcps?: string[];
	disabledTools?: string[];
}

function parseOverlay(value: unknown): RuntimeOverlay | undefined {
	if (!isRecord(value)) return undefined;
	const overlay: RuntimeOverlay = {};
	for (const key of ["disabledSkills", "disabledExtensions", "disabledMcps", "disabledTools"] as const) {
		const list = value[key];
		if (Array.isArray(list) && list.every((entry) => typeof entry === "string")) {
			overlay[key] = list;
		}
	}
	return Object.keys(overlay).length > 0 ? overlay : undefined;
}

export class RuntimeStateStore {
	readonly #statePath: string;

	/** @param stateDir Directory holding `pi-profile-state.json` (agent dir or
	 *  project `.pi` dir). */
	constructor(stateDir: string) {
		this.#statePath = path.join(stateDir, "pi-profile-state.json");
	}

	async read(): Promise<RuntimeState> {
		const result = await readJsonFile(this.#statePath);
		if (!result.ok || !isRecord(result.value)) return {};
		const state: RuntimeState = {};
		if (typeof result.value.activeProfile === "string") {
			state.activeProfile = result.value.activeProfile;
		}
		const overlay = parseOverlay(result.value.overlay);
		if (overlay !== undefined) {
			state.overlay = overlay;
		}
		return state;
	}

	async write(state: RuntimeState): Promise<void> {
		await mkdir(path.dirname(this.#statePath), { recursive: true });
		await writeFile(this.#statePath, `${JSON.stringify(state, null, 2)}\n`);
	}

	/** Read-modify-write merge. A field set to `undefined` is deleted; absent
	 *  fields keep their stored value. Used by the switch/overlay paths so
	 *  one concern (selection, anchor, overlay) never clobbers another. */
	async update(patch: Partial<RuntimeState>): Promise<RuntimeState> {
		const current = await this.read();
		const next: RuntimeState = { ...current };
		if ("activeProfile" in patch) {
			if (patch.activeProfile === undefined) delete next.activeProfile;
			else next.activeProfile = patch.activeProfile;
		}
		if ("overlay" in patch) {
			if (patch.overlay === undefined) delete next.overlay;
			else next.overlay = patch.overlay;
		}
		await this.write(next);
		return next;
	}
}
