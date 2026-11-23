/**
 * The on/off switch.
 *
 * pi-persist injects two things: a cached prompt section and a trailing developer message. The
 * switch turns both off together, so "off" means the extension contributes nothing to the prompt —
 * not "the clock stopped" and not "the items file is empty".
 *
 * Two different things are called "the switch", and mixing them is what made one lane's toggle
 * turn every other lane off:
 *
 * - `piPersist.enabled` in pi's own global settings file is the **operator-global default and
 *   authority ceiling**. It decides whether context injection is allowed at all; a project must
 *   not be able to raise it, which is why it is global and why nothing in this file writes it —
 *   not the slash command, not an event hook. The explicit operator-level writer is
 *   `setPersistEnabled` in `settings.ts`, which the CLI (or a hand edit of the file) uses.
 *
 *   Attenuation is separate from that authority and is voluntary per session: a session may turn
 *   itself OFF while the global default is ON (it declines context it was allowed), but it can
 *   never turn itself ON while the global default is OFF (it cannot grant itself what the
 *   operator withheld). So the global value is a default and a ceiling, not a permission a
 *   session can hand itself.
 * - This session's state is **session-local**: the set of sessions that turned themselves off,
 *   keyed by the session id `ctx.sessionManager.getSessionId()` reports. `/reload` keeps it,
 *   because the process and the session id are unchanged. A process restart drops it, because the
 *   state lives only in memory — the new process starts at the global default.
 *
 * Attenuation is structural, not a check that could be forgotten: the only thing a session can
 * record is "off". Effective state is `global && !sessionTurnedItselfOff`, so a session can turn
 * itself off while the global default is on, and can never turn itself on while the global default
 * is off. `toggleEnabled` still refuses that request explicitly, with a reason, so the operator is
 * told *why* nothing happened instead of seeing a silent no-op.
 *
 * The session state lives on `globalThis` for the same reason the registries do: a session can load
 * this package twice (an npm cache and a local path), and both copies must agree on whether the
 * extension is on. One copy that thinks it is off while the other thinks it is on would inject half
 * of what the operator asked to have injected. The symbol key and version are the guard: this is
 * `v2` because the payload changed shape, and a copy of an older package occupying its own symbol
 * cannot corrupt this one.
 */
import { readSettingsFromDisk } from "./settings.ts";

/** The command pi exposes as `/pi-persist-toggle`. */
export const TOGGLE_COMMAND = "pi-persist-toggle";

const STATE_SYMBOL = Symbol.for("pi-persist/toggle/v2");
const STATE_PROTOCOL = "pi-persist/toggle";
const STATE_VERSION = 2;

/**
 * How many sessions' "off" marks are remembered in one process.
 *
 * A long-lived pi process can start many sessions (`/new`, `/resume`); each id would be a few dozen
 * bytes held forever. The cap is far above any real number of concurrent sessions, and evicting the
 * oldest mark only means a session nobody has touched in a long time is back at the global default —
 * which is exactly where a fresh session starts anyway.
 */
const MAX_SESSIONS = 32;

interface SharedState {
	protocol: typeof STATE_PROTOCOL;
	version: typeof STATE_VERSION;
	/** The global default, `undefined` until the first read resolves it from the settings file. */
	globalDefault?: boolean;
	/** Sessions that turned themselves off. Membership is the whole session state. */
	offSessions: Set<string>;
}

type Globals = typeof globalThis & { [STATE_SYMBOL]?: unknown };

/**
 * The live state, shared by every copy of this package in the process. A value that occupies the
 * symbol with a different protocol, version, or shape is replaced rather than trusted.
 */
function sharedState(): SharedState {
	const globals = globalThis as Globals;
	const existing = globals[STATE_SYMBOL] as SharedState | undefined;
	if (
		existing &&
		typeof existing === "object" &&
		existing.protocol === STATE_PROTOCOL &&
		existing.version === STATE_VERSION &&
		existing.offSessions instanceof Set
	) {
		return existing;
	}
	const state: SharedState = { protocol: STATE_PROTOCOL, version: STATE_VERSION, offSessions: new Set() };
	globals[STATE_SYMBOL] = state;
	return state;
}

/**
 * The key a session's mark lives under.
 *
 * A host with no session id — the CLI, a test, an older pi — is a single anonymous bucket. It is
 * still session-shaped: it follows the global default, it can turn itself off, and it is forgotten
 * at restart.
 */
function sessionKey(sessionId?: string): string {
	return sessionId ?? "";
}

/**
 * The operator-global default from pi's settings file.
 *
 * Read once per process, so the request path costs nothing; `/reload` re-reads it through
 * `resetGlobalDefault`, which is how a hand edit of the file takes effect.
 */
export function globalEnabled(agentDir?: string): boolean {
	const state = sharedState();
	if (state.globalDefault === undefined) state.globalDefault = readSettingsFromDisk(agentDir).enabled;
	return state.globalDefault;
}

/** What the switch is doing for one session, and what it is doing for the operator. */
export interface ToggleState {
	/** Whether the extension contributes anything in this session now. */
	enabled: boolean;
	/** The operator-global default this session is judged against. */
	globalEnabled: boolean;
}

/**
 * The state for one session, without changing it.
 *
 * `enabled` is the session's effective state; `globalEnabled` is the default it started from. They
 * differ only when the session turned itself off: the global default never follows a session.
 */
export function readToggleState(sessionId?: string, agentDir?: string): ToggleState {
	const global = globalEnabled(agentDir);
	return {
		enabled: global && !sharedState().offSessions.has(sessionKey(sessionId)),
		globalEnabled: global,
	};
}

/** Whether the extension is on for this session. */
export function isEnabled(sessionId?: string, agentDir?: string): boolean {
	return readToggleState(sessionId, agentDir).enabled;
}

/**
 * Forget this session's mark, so it follows the global default again.
 *
 * Used by the extension factory, which runs again on `/reload`: a reload must keep the session's
 * state and may re-read the settings file, so it calls `resetGlobalDefault` instead. This is the
 * narrower operation, kept for hosts that end a session without ending the process.
 */
export function forgetSession(sessionId?: string): void {
	sharedState().offSessions.delete(sessionKey(sessionId));
}

/** Forget the global default, so the next read comes from the settings file again. */
export function resetGlobalDefault(): void {
	sharedState().globalDefault = undefined;
}

/**
 * Forget everything: the global default and every session's mark.
 *
 * This is the in-memory equivalent of a process restart — the state a fresh process would have. A
 * `/reload` must **not** use it: the same process and session id keep their state across a reload.
 */
export function resetEnabled(): void {
	const state = sharedState();
	state.globalDefault = undefined;
	state.offSessions.clear();
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

export interface ToggleRequest {
	/** `true` for `on`, `false` for `off`; omit it for a bare toggle, which flips. */
	target?: boolean;
	/** The session whose state to change. A session-less host omits it. */
	sessionId?: string;
	/** Directory holding pi's settings file, for a caller that is not inside pi. */
	agentDir?: string;
}

export interface ToggleResult {
	/** The state the extension is in for this session now. */
	enabled: boolean;
	/** The operator-global default the session was judged against. */
	globalEnabled: boolean;
	/** Whether this call changed the session's state. */
	changed: boolean;
	/** Why the request was refused, when it was. */
	refused?: "global-disabled";
}

/**
 * Turn the extension on or off for one session.
 *
 * Nothing is written to disk: the session's state is memory that a process restart discards, and
 * the global default belongs to the operator. When the global default is off, the request to turn
 * on is refused rather than obeyed and quietly lost — a switch that appears to work and changes
 * nothing is the defect this function exists to remove.
 */
export function toggleEnabled(request: ToggleRequest = {}): ToggleResult {
	const global = globalEnabled(request.agentDir);
	const current = global && !sharedState().offSessions.has(sessionKey(request.sessionId));
	const target = request.target ?? !current;

	if (!global) {
		// The operator turned it off everywhere. There is no session state to record: every session
		// is off, this one included, and only the operator can change that.
		return target
			? { enabled: false, globalEnabled: false, changed: false, refused: "global-disabled" }
			: { enabled: false, globalEnabled: false, changed: false };
	}

	if (target === current) return { enabled: current, globalEnabled: true, changed: false };

	remember(sessionKey(request.sessionId), !target);
	return { enabled: target, globalEnabled: true, changed: true };
}

/** Record or clear one session's "off" mark, keeping the set bounded. */
function remember(key: string, off: boolean): void {
	const state = sharedState();
	if (!off) {
		state.offSessions.delete(key);
		return;
	}
	state.offSessions.add(key);
	while (state.offSessions.size > MAX_SESSIONS) {
		const oldest = state.offSessions.values().next().value;
		if (oldest === undefined) break;
		state.offSessions.delete(oldest);
	}
}
