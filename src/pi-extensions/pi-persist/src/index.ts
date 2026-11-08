import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { detectEnvironment, type EnvBlock, renderEnvironment } from "./environment.ts";
import { ensureItemsFile, itemsFilePath, loadLayeredItems, readItemsFile } from "./items.ts";
import { appendTrailingMessage, type MessageContext, registerEnvMessage } from "./messages.ts";
import { type ContributionContext, collectContributions, registerEnvContribution } from "./registry.ts";
import { expandTemplate } from "./template.ts";
import { isEnabled, parseToggleArgument, resetEnabled, TOGGLE_COMMAND, toggleEnabled } from "./toggle.ts";

/** Prompt section name. Pi renders it as `<environment_context>…</environment_context>`. */
export const SECTION_NAME = "environment_context";

/**
 * Fields pi already renders elsewhere in its own prompt. `cwd` is its own `<cwd>` section
 * (`system-prompt.js`), so repeating it here would duplicate a value on every request.
 */
export const DEFAULT_OMIT: readonly string[] = ["cwd"];

export interface BuildSectionOptions {
	cwd: string;
	provider?: string;
	activeTools: readonly string[];
	mode: string;
	omit?: readonly string[];
}

/**
 * Build the section body for one request. Exported so tests and non-pi consumers can render the
 * same envelope without running the extension.
 */
export function buildEnvironmentSection(options: BuildSectionOptions): string {
	const facts = detectEnvironment(options.cwd);
	const context: ContributionContext = {
		provider: options.provider,
		activeTools: options.activeTools,
		cwd: options.cwd,
		mode: options.mode,
	};
	const blocks: EnvBlock[] = collectContributions(context);
	return renderEnvironment(facts, { omit: options.omit ?? DEFAULT_OMIT, blocks });
}

/**
 * Two injection channels with different economics.
 *
 * - `registry.ts` (section) for text that holds for the session: written once into the leading
 *   system prompt, then served from the prompt cache until it changes.
 * - `messages.ts` (trailing) for everything else: appended to every request after the final tool
 *   result, never cached, never lost mid-run.
 *
 * A contributor picks the channel by calling the matching register function. Neither channel is
 * persisted by this extension, so nothing accumulates in the transcript.
 */
/**
 * Register every item from the items file into the live registries.
 *
 * Declarative items take the same path as programmatic ones, so rendering cannot tell them apart.
 * Returns the unregister functions plus any validation errors, which are surfaced rather than
 * thrown: a bad entry must not prevent a session from starting.
 *
 * Pass a path to load one file, or `{ cwd, projectTrusted }` to layer the project file over the
 * global one. A string keeps the single-file behaviour the CLI and older callers rely on.
 */
export function loadDeclarativeItems(source: string | DeclarativeLoadOptions = itemsFilePath()): DeclarativeLoadResult {
	const layered =
		typeof source === "string"
			? {
					...readItemsFile(source),
					overridden: [] as string[],
					projectCount: 0,
					projectPath: source,
					skippedUntrusted: false,
				}
			: loadLayeredItems(source);
	const unregister: Array<() => void> = [];
	for (const item of layered.items) {
		const content = ({ cwd }: ContributionContext | MessageContext) =>
			expandTemplate(item.content, { cwd }) || undefined;
		if (item.channel === "section") {
			unregister.push(
				registerEnvContribution({
					id: item.id,
					priority: item.priority,
					providers: item.providers,
					activeTools: item.activeTools,
					content,
				}),
			);
		} else {
			unregister.push(
				registerEnvMessage({
					id: item.id,
					priority: item.priority,
					providers: item.providers,
					activeTools: item.activeTools,
					content,
				}),
			);
		}
	}
	return {
		unregister,
		errors: layered.errors,
		overridden: layered.overridden,
		projectCount: layered.projectCount,
		projectPath: layered.projectPath,
		skippedUntrusted: layered.skippedUntrusted,
	};
}

export interface DeclarativeLoadOptions {
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
}

export interface DeclarativeLoadResult {
	unregister: Array<() => void>;
	errors: string[];
	/** `channel:id` keys where a project item replaced a global one. */
	overridden: string[];
	/** How many items came from the project file. */
	projectCount: number;
	/** The project items file, or the single path when one file was loaded directly. */
	projectPath: string;
	skippedUntrusted: boolean;
}

/**
 * Declarative items registered by the current session, kept module-level because `/reload` builds a
 * new closure and the previous one must not leak a deleted item into the registry.
 */
let registered: Array<() => void> = [];
let registeredKey: string | undefined;

/**
 * Report a diagnostic the way pi does: through the UI when there is one, on stderr otherwise.
 *
 * `console.warn` under a full-screen TUI writes into the terminal the UI owns, which is why pi
 * itself only falls back to it when `hasUI()` is false.
 */
function report(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, type: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(`pi-persist: ${message}`, type);
	else console.warn(`pi-persist: ${message}`);
}

/**
 * Rebuild the declarative set when the trust answer or the working directory changes.
 *
 * Pi resolves project trust *after* extensions load, so this cannot happen in the factory: the
 * first hook carrying a context is the earliest point where `isProjectTrusted()` means anything.
 * The key makes repeated calls free, and unregistering first means an item deleted from a file — or
 * a project that lost trust — stops rendering instead of lingering for the rest of the session.
 */
function syncDeclarativeItems(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "hasUI" | "ui">): void {
	const trusted = ctx.isProjectTrusted();
	const key = `${ctx.cwd}\u0000${trusted}`;
	if (key === registeredKey) return;
	for (const unregister of registered) unregister();
	registered = [];
	registeredKey = key;

	const result = loadDeclarativeItems({ cwd: ctx.cwd, projectTrusted: trusted });
	registered = result.unregister;
	if (result.skippedUntrusted) {
		// Loud on purpose: a repository carrying prompt text is exactly what trust is meant to gate.
		report(ctx, `ignoring ${result.projectPath} — the project is not trusted`, "warning");
	} else if (result.projectCount > 0) {
		// Also loud: pi skips its trust prompt when a project holds no trust-requiring resources, so
		// a repository with only an items file is trusted without ever being asked about.
		report(ctx, `loaded ${result.projectCount} item(s) from ${result.projectPath}`, "info");
	}
	if (result.errors.length > 0) {
		report(ctx, `${result.errors.length} item(s) skipped: ${result.errors.join("; ")}`, "warning");
	}
}

export default function envContext(pi: ExtensionAPI) {
	// The switch lives in pi's settings file. Re-read it on every load, so a `/reload` picks up an
	// edit — or the state the last session left behind.
	resetEnabled();
	// Seed the preset on a first run. `/reload` re-runs this and picks up edits.
	ensureItemsFile();
	// Drop the previous run's items, then register the global layer straight away: it is user-owned
	// and never trust-gated, so the registry is usable before any hook has fired. The first hook
	// below replaces it with the layered set, because project trust is not known yet at this point.
	for (const unregister of registered) unregister();
	registeredKey = undefined;
	registered = loadDeclarativeItems().unregister;

	pi.on("session_start", (_event, ctx) => {
		syncDeclarativeItems(ctx);
		if (!isEnabled()) {
			// Say so once per session: a missing clock is otherwise indistinguishable from a bug.
			report(ctx, "is off — no context is injected. Run /pi-persist-toggle to turn it back on.", "info");
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Also here, not only on session_start: the section is built from the registry, so the
		// items have to be in place before the first render even if the event order ever changes.
		syncDeclarativeItems(ctx);
		if (!isEnabled()) {
			// Off: the extension contributes nothing, so there is no section to render. Removing the
			// key rather than leaving it empty also drops a section a previous run left behind.
			delete event.systemPromptOptions.sections[SECTION_NAME];
			return;
		}
		const section = buildEnvironmentSection({
			cwd: ctx.cwd,
			provider: ctx.model?.provider,
			activeTools: pi.getActiveTools(),
			mode: ctx.mode,
		});
		// Mutate the section in place so pi diffs it against the previous request and appends only
		// the delta, instead of replacing the whole system prompt.
		if (section) event.systemPromptOptions.sections[SECTION_NAME] = section;
		else delete event.systemPromptOptions.sections[SECTION_NAME];
	});

	// Per request, not per run: a tool-using run issues several requests, and a trailing message
	// injected in `before_agent_start` would be missing from all but the first.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isEnabled()) return;
		const options = { activeTools: pi.getActiveTools(), cwd: ctx.cwd, mode: ctx.mode };
		return appendTrailingMessage(event.payload, options, ctx.model?.provider);
	});

	pi.registerCommand(TOGGLE_COMMAND, {
		description: "Turn pi-persist context injection on or off",
		handler: async (args, ctx) => {
			const requested = parseToggleArgument(args);
			if (!requested) {
				report(ctx, `usage: /${TOGGLE_COMMAND} [on|off|status]`, "warning");
				return;
			}
			if (requested === "status") {
				report(ctx, `is ${isEnabled() ? "on" : "off"}`, "info");
				return;
			}
			const result = await toggleEnabled(requested === "toggle" ? undefined : requested === "on");
			if (!result.persisted) {
				report(
					ctx,
					`is ${result.enabled ? "on" : "off"} for this session only — not saved: ${result.error ?? "unknown error"}`,
					"warning",
				);
				return;
			}
			report(
				ctx,
				result.enabled
					? "is on — the section and the trailing message are injected again"
					: "is off — nothing is injected until it is turned back on",
				"info",
			);
		},
	});
}

export type { EnvBlock, EnvField, EnvironmentFacts, ShellFacts } from "./environment.ts";
export { detectEnvironment, detectShell, escapeXml, renderEnvironment } from "./environment.ts";
export type {
	DeclarativeItem,
	ItemChannel,
	ItemsFile,
	LayeredItems,
	LayeredItemsOptions,
} from "./items.ts";
export {
	itemKey,
	itemsFilePath,
	loadLayeredItems,
	parseItemsFile,
	projectItemsFilePath,
	readItemsFile,
} from "./items.ts";
export type { MessageContext, MessageContribution, ResolvedMessage, TrailingMessageOptions } from "./messages.ts";
export {
	appendTrailingMessage,
	collectMessages,
	ENVELOPE_TAG,
	MESSAGE_TYPE_PREFIX,
	payloadArrayKey,
	registerEnvMessage,
	renderTrailingMessage,
	supportsTrailingMessage,
	tagNameFor,
} from "./messages.ts";
export type { ContributionContext, EnvironmentContribution } from "./registry.ts";
export {
	REGISTRY_PROTOCOL,
	REGISTRY_SYMBOL,
	REGISTRY_VERSION,
	registerEnvContribution,
} from "./registry.ts";
export {
	DEFAULT_SETTINGS,
	type PersistSettings,
	readPersistSettings,
	readSettingsFromDisk,
	SETTINGS_KEY,
	setPersistEnabled,
	settingsFilePath,
} from "./settings.ts";
export type { ToggleArgument, ToggleResult } from "./toggle.ts";
export { isEnabled, parseToggleArgument, resetEnabled, TOGGLE_COMMAND, toggleEnabled } from "./toggle.ts";
