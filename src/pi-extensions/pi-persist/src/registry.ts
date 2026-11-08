/**
 * Cross-extension registration protocol.
 *
 * Pi's extension API has no way for one extension to hand data to another, so contributions travel
 * through a versioned slot on `globalThis`. The consequences drive every rule below:
 *
 * - Load order is unknown. A contributor may register before this package loads, so the registry is
 *   created on demand, adopted by whichever side arrives second, and read at render time rather
 *   than snapshotted.
 * - Duplicate package instances are possible (a session can load the same extension from an npm
 *   cache and a local path). The symbol and `protocol` string make two instances agree on the
 *   registry instead of each owning a private map.
 * - The shape is a published ABI consumed by extensions outside this repo. Changing `version`
 *   rather than the symbol keeps old and new writers from silently corrupting each other's entries.
 */

export const REGISTRY_SYMBOL = Symbol.for("pi-persist/contributors/v1");
export const REGISTRY_PROTOCOL = "pi-persist/contributors";
export const REGISTRY_VERSION = 1;

export interface EnvironmentContribution {
	/** Unique. Registering the same id again replaces the earlier contribution. */
	id: string;
	/** Lower renders first; ties break on id, so the output never depends on registration order. */
	priority?: number;
	/** Skip unless the agent is the given provider ids. Omitted means every provider. */
	providers?: readonly string[];
	/** Skip unless every listed tool is active. */
	activeTools?: readonly string[];
	/** Body text, or a function returning one. Empty and whitespace-only results are dropped. */
	content: string | ((context: ContributionContext) => string | undefined);
}

export interface ContributionContext {
	provider?: string;
	activeTools: readonly string[];
	cwd: string;
	mode: string;
}

interface Registry {
	protocol: typeof REGISTRY_PROTOCOL;
	version: typeof REGISTRY_VERSION;
	contributions: Map<string, EnvironmentContribution>;
}

type Globals = typeof globalThis & { [REGISTRY_SYMBOL]?: unknown };

function isRegistry(value: unknown): value is Registry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<Registry>;
	return (
		candidate.protocol === REGISTRY_PROTOCOL &&
		candidate.version === REGISTRY_VERSION &&
		candidate.contributions instanceof Map
	);
}

/**
 * The live registry, created on first use. Returns undefined only when a foreign value occupies the
 * symbol with a different protocol or version, in which case this package declines to write into it.
 */
export function getRegistry(): Registry | undefined {
	const globals = globalThis as Globals;
	const existing = globals[REGISTRY_SYMBOL];
	if (existing === undefined) {
		const registry: Registry = {
			protocol: REGISTRY_PROTOCOL,
			version: REGISTRY_VERSION,
			contributions: new Map(),
		};
		globals[REGISTRY_SYMBOL] = registry;
		return registry;
	}
	return isRegistry(existing) ? existing : undefined;
}

/**
 * Register a block of environment context. Returns an unregister function.
 *
 * Callers that do not import this package can build the registry object themselves — `protocol`,
 * `version`, and a `contributions` Map — and `set` into it directly.
 */
export function registerEnvContribution(contribution: EnvironmentContribution): () => void {
	const registry = getRegistry();
	if (!registry) throw new Error(`${REGISTRY_SYMBOL.description ?? "registry"} is occupied by an incompatible value`);
	if (typeof contribution.id !== "string" || contribution.id.length === 0) {
		throw new Error("environment contribution requires a non-empty id");
	}
	registry.contributions.set(contribution.id, contribution);
	return () => {
		// Only remove our own entry; a later registration under the same id must survive.
		if (registry.contributions.get(contribution.id) === contribution) registry.contributions.delete(contribution.id);
	};
}

/** Skip a contribution whose provider or tool requirements are unmet. Filtering runs before ordering. */
export function acceptsContribution(contribution: EnvironmentContribution, context: ContributionContext): boolean {
	if (contribution.providers && contribution.providers.length > 0) {
		if (!context.provider || !contribution.providers.includes(context.provider)) return false;
	}
	if (contribution.activeTools && contribution.activeTools.length > 0) {
		const active = new Set(context.activeTools);
		if (!contribution.activeTools.every((tool) => active.has(tool))) return false;
	}
	return true;
}

/**
 * Resolve every accepted contribution to text, ordered by priority then id.
 *
 * A throwing content callback is skipped rather than propagated: one broken contributor must not
 * take down the prompt for the whole session.
 */
export function collectContributions(
	context: ContributionContext,
	registry = getRegistry(),
): Array<{ id: string; content: string }> {
	if (!registry) return [];
	const resolved: Array<{ id: string; priority: number; content: string }> = [];
	for (const contribution of registry.contributions.values()) {
		if (!acceptsContribution(contribution, context)) continue;
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

/** Forget every contribution. Test hook; extensions should use the unregister function. */
export function clearContributions(): void {
	getRegistry()?.contributions.clear();
}
