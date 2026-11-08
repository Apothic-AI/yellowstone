/**
 * The on/off switch.
 *
 * pi-persist injects two things: a cached prompt section and a trailing developer message. The
 * switch turns both off together, so "off" means the extension contributes nothing to the prompt —
 * not "the clock stopped" and not "the items file is empty".
 *
 * The durable state is `piPersist.enabled` in pi's own global settings file. It is global on
 * purpose: a project must not be able to turn the operator's context on or off.
 *
 * The live state lives on `globalThis` for the same reason the registries do: a session can load
 * this package twice (an npm cache and a local path), and both copies must agree on whether the
 * extension is on. One copy that thinks it is off while the other thinks it is on would inject
 * half of what the operator asked to have injected.
 */
import { readSettingsFromDisk, setPersistEnabled } from "./settings.ts";

/** The command pi exposes as `/pi-persist-toggle`. */
export const TOGGLE_COMMAND = "pi-persist-toggle";

const STATE_SYMBOL = Symbol.for("pi-persist/enabled/v1");
const STATE_PROTOCOL = "pi-persist/enabled";
const STATE_VERSION = 1;

interface SharedState {
	protocol: typeof STATE_PROTOCOL;
	version: typeof STATE_VERSION;
	/** `undefined` until the first read resolves it from the settings file. */
	enabled?: boolean;
}

type Globals = typeof globalThis & { [STATE_SYMBOL]?: unknown };

/**
 * The live state, shared by every copy of this package in the process. A value that occupies the
 * symbol with a different protocol or version is replaced rather than trusted.
 */
function sharedState(): SharedState {
	const globals = globalThis as Globals;
	const existing = globals[STATE_SYMBOL];
	if (
		existing &&
		typeof existing === "object" &&
		(existing as SharedState).protocol === STATE_PROTOCOL &&
		(existing as SharedState).version === STATE_VERSION
	) {
		return existing as SharedState;
	}
	const state: SharedState = { protocol: STATE_PROTOCOL, version: STATE_VERSION };
	globals[STATE_SYMBOL] = state;
	return state;
}

/**
 * Whether the extension is on. The first call reads the settings file; later calls reuse the
 * answer, so the request path costs nothing.
 */
export function isEnabled(): boolean {
	const state = sharedState();
	if (state.enabled === undefined) state.enabled = readSettingsFromDisk().enabled;
	return state.enabled;
}

/** Forget the live state, so the next read comes from the settings file again. */
export function resetEnabled(): void {
	sharedState().enabled = undefined;
}

/** What the command accepts: a bare toggle, or an explicit state. */
export type ToggleArgument = "toggle" | "on" | "off" | "status";

/** Parse the command argument. `undefined` means the argument is not understood. */
export function parseToggleArgument(args: string): ToggleArgument | undefined {
	const value = args.trim().toLowerCase();
	if (value === "") return "toggle";
	if (value === "on" || value === "off" || value === "status") return value;
	return undefined;
}

export interface ToggleResult {
	/** The state the extension is in now. */
	enabled: boolean;
	/** Whether the state was written to the settings file. */
	persisted: boolean;
	/** Why the write failed, when it did. */
	error?: string;
}

/**
 * Turn the extension on or off.
 *
 * The live state changes first: the switch was asked for now, and a settings file that is busy or
 * unreadable must not stop it from taking effect. The durable write follows, and a failure is
 * reported rather than swallowed — a switch that does not survive a reload is not what was asked
 * for.
 */
export async function toggleEnabled(target?: boolean, agentDir?: string): Promise<ToggleResult> {
	const next = target ?? !isEnabled();
	sharedState().enabled = next;
	try {
		await setPersistEnabled(next, agentDir);
		return { enabled: next, persisted: true };
	} catch (error) {
		return { enabled: next, persisted: false, error: error instanceof Error ? error.message : String(error) };
	}
}
