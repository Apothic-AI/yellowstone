/**
 * Per-request contributions, appended as a trailing developer message.
 *
 * The section channel (`registry.ts`) covers text that holds for the whole session. This channel
 * covers everything else, and the two differ in more than frequency:
 *
 * - A section is folded into the leading system prompt. Changing it re-renders the cached prefix.
 * - A trailing message is appended to the request's message list. It never re-renders the prefix,
 *   but it is never cacheable either: it is fresh input on every request.
 * - `before_agent_start` fires once per run, and a run with tool calls issues several requests. A
 *   contribution injected there is absent from most requests in a tool-using turn.
 *
 * So the trailing message is appended in `before_provider_request`, once per request, after the
 * final tool result. That is the last thing the model reads before choosing its next action, and
 * losing it mid-run is exactly the failure this avoids.
 *
 * Verified by measurement against four provider configurations (see the README): all accept a
 * trailing `developer` item appended to the payload's message array. `openai-completions` payloads
 * carry `messages`; `openai-responses` payloads carry `input`. Both are handled.
 */
import { sanitizeEnvValue } from "./environment.ts";

export const MESSAGE_REGISTRY_SYMBOL = Symbol.for("pi-persist/messages/v1");
export const MESSAGE_REGISTRY_PROTOCOL = "pi-persist/messages";
export const MESSAGE_REGISTRY_VERSION = 1;

/** Prefixed onto `customType` style ids so a reader can tell where content came from. */
export const MESSAGE_TYPE_PREFIX = "pi-persist/";

export interface MessageContribution {
	/** Unique. Registering the same id again replaces the earlier contribution. */
	id: string;
	/** Lower renders first; ties break on id, so output never depends on registration order. */
	priority?: number;
	/** Skip unless the agent is the given provider ids. Omitted means every provider. */
	providers?: readonly string[];
	/** Skip unless every listed tool is active. */
	activeTools?: readonly string[];
	/** Body text, or a function returning one. Empty results are dropped for that request. */
	content: string | ((context: MessageContext) => string | undefined);
}

export interface ResolvedMessage {
	id: string;
	content: string;
}

export interface MessageContext {
	provider?: string;
	activeTools: readonly string[];
	cwd: string;
	mode: string;
}

interface Registry {
	protocol: typeof MESSAGE_REGISTRY_PROTOCOL;
	version: typeof MESSAGE_REGISTRY_VERSION;
	contributions: Map<string, MessageContribution>;
}

type Globals = typeof globalThis & { [MESSAGE_REGISTRY_SYMBOL]?: unknown };

function isRegistry(value: unknown): value is Registry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Registry>;
	return (
		candidate.protocol === MESSAGE_REGISTRY_PROTOCOL &&
		candidate.version === MESSAGE_REGISTRY_VERSION &&
		candidate.contributions instanceof Map
	);
}

/** The live registry, created on first use. Undefined when a foreign value occupies the symbol. */
export function getMessageRegistry(): Registry | undefined {
	const globals = globalThis as Globals;
	const existing = globals[MESSAGE_REGISTRY_SYMBOL];
	if (existing === undefined) {
		const registry: Registry = {
			protocol: MESSAGE_REGISTRY_PROTOCOL,
			version: MESSAGE_REGISTRY_VERSION,
			contributions: new Map(),
		};
		globals[MESSAGE_REGISTRY_SYMBOL] = registry;
		return registry;
	}
	return isRegistry(existing) ? existing : undefined;
}

/** Register a per-request trailing message. Returns an unregister function. */
export function registerEnvMessage(contribution: MessageContribution): () => void {
	const registry = getMessageRegistry();
	if (!registry)
		throw new Error(`${MESSAGE_REGISTRY_SYMBOL.description ?? "registry"} is occupied by an incompatible value`);
	if (typeof contribution.id !== "string" || contribution.id.length === 0) {
		throw new Error("environment message contribution requires a non-empty id");
	}
	registry.contributions.set(contribution.id, contribution);
	return () => {
		if (registry.contributions.get(contribution.id) === contribution) {
			registry.contributions.delete(contribution.id);
		}
	};
}

export function clearEnvMessages(): void {
	getMessageRegistry()?.contributions.clear();
}

/**
 * Resolve every accepted contribution for this request, ordered by priority then id.
 *
 * A throwing body is skipped: one broken contributor must not fail the request.
 */
export function collectMessages(context: MessageContext, registry = getMessageRegistry()): ResolvedMessage[] {
	if (!registry) return [];
	const resolved: Array<{ id: string; priority: number; content: string }> = [];
	for (const contribution of registry.contributions.values()) {
		if (contribution.providers && contribution.providers.length > 0) {
			if (!context.provider || !contribution.providers.includes(context.provider)) continue;
		}
		if (contribution.activeTools && contribution.activeTools.length > 0) {
			const active = new Set(context.activeTools);
			if (!contribution.activeTools.every((tool) => active.has(tool))) continue;
		}
		let content: string | undefined;
		try {
			content = typeof contribution.content === "function" ? contribution.content(context) : contribution.content;
		} catch {
			continue;
		}
		const trimmed = typeof content === "string" ? content.trim() : "";
		if (!trimmed) continue;
		resolved.push({ id: contribution.id, priority: contribution.priority ?? 0, content: trimmed });
	}
	resolved.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
	return resolved.map(({ id, content }) => ({ id, content }));
}

/** An id usable as an XML tag name. Contributions are free to use `/` and other separators. */
export function tagNameFor(id: string): string {
	const normalized = id
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return /^[A-Za-z]/.test(normalized) ? normalized : `item-${normalized || "unnamed"}`;
}

/**
 * The envelope around the trailing message.
 *
 * The message is appended after the user's turn and after any tool results, so without a container
 * it reads as a continuation of the conversation — a second instruction competing with the one the
 * user actually gave. The wrapper and the sentence inside it say plainly what this is: ambient
 * context supplied by the harness, not a request, and not a change of task.
 */
export const ENVELOPE_TAG = "pi_context";

/**
 * The framing line.
 *
 * An earlier version said "not a new instruction", which was meant to stop the model treating the
 * envelope as the user's request — but it also told the model to ignore items whose whole purpose is
 * to carry an instruction. Models correctly reported the contradiction and discarded the content.
 *
 * The line now separates two things that were conflated: the envelope is not a *user turn* and does
 * not change the task, but its contents are authoritative configuration and must be followed.
 */
export const ENVELOPE_PREAMBLE =
	"Context configured for this session by the operator. This is not a user message and does not\n" +
	"replace the task you were given, but the contents below are authoritative: follow any\n" +
	"instruction they contain. Environment facts are for reference.";

export function renderTrailingMessage(messages: readonly ResolvedMessage[]): string {
	if (messages.length === 0) return "";
	const items = messages.map(
		(message) => `  <${tagNameFor(message.id)}>${sanitizeEnvValue(message.content)}</${tagNameFor(message.id)}>`,
	);
	return [`<${ENVELOPE_TAG}>`, ENVELOPE_PREAMBLE, ...items, `</${ENVELOPE_TAG}>`].join("\n");
}

/** The message-array key for a provider payload: `messages` for completions, `input` for responses. */
export function payloadArrayKey(payload: unknown): "messages" | "input" | undefined {
	if (!payload || typeof payload !== "object") return;
	const candidate = payload as { messages?: unknown; input?: unknown };
	if (Array.isArray(candidate.messages)) return "messages";
	if (Array.isArray(candidate.input)) return "input";
	return;
}

/**
 * Whether this request can carry a trailing message.
 *
 * The responses API rejects a bare string as message content, so its items are built from
 * `input_text` blocks. A payload with neither key is left untouched rather than guessed at.
 */
export function supportsTrailingMessage(payload: unknown): boolean {
	return payloadArrayKey(payload) !== undefined;
}

export interface TrailingMessageOptions {
	activeTools: readonly string[];
	cwd: string;
	mode: string;
}

/**
 * Append the composed contribution text to the end of a provider payload, in place.
 *
 * Returns the payload for convenience. Appends nothing when no contribution resolves, so a payload
 * is never mutated for an empty result.
 */
export function appendTrailingMessage(
	payload: unknown,
	options: TrailingMessageOptions,
	provider: string | undefined,
): unknown {
	const key = payloadArrayKey(payload);
	if (!key) return payload;
	const text = renderTrailingMessage(
		collectMessages({ provider, activeTools: options.activeTools, cwd: options.cwd, mode: options.mode }),
	);
	if (!text) return payload;
	const array = (payload as Record<typeof key, unknown[]>)[key];
	// `input_text` for the responses API; completions accepts a plain string.
	array.push(
		key === "input"
			? { role: "developer", content: [{ type: "input_text", text }] }
			: { role: "developer", content: text },
	);
	return payload;
}
