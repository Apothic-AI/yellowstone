import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../src/json-file.ts";
import { readTrustInputs } from "../../src/launcher/initial-profile.ts";
import { loadMergedMcpServers } from "../../src/mcp-config.ts";
import { mergeResolutionDiagnostics, mcpSourceDiagnostics } from "../../src/profile-resolver.ts";
import { RuntimeStateStore } from "../../src/runtime-state-store.ts";
import { runStartupNotifications, type NoticeSurface } from "../../src/startup-notifier.ts";
import { applyLaunchPlan, readLaunchPlanFile } from "../../src/switching/apply-plan.ts";
import { OVERLAY_USAGE, applyOverlayMutation, clearOverlay, parseOverlayArgs } from "../../src/switching/overlay.ts";
import { formatProfileList, listProfiles } from "../../src/switching/list-profiles.ts";
import { buildStatusReport, formatStatusMarkdown } from "../../src/switching/status.ts";
import { observeSubagentExtension } from "../../src/switching/subagent-observation.ts";
import { switchProfile, type SwitchDeps } from "../../src/switching/switch-profile.ts";
import { getGlobalStateDir, getProfileSwitchDir } from "../../src/workspace.ts";

/**
 * pi-profile extension entry.
 *
 * Loaded into the spawned pi via `-e`. Responsibilities:
 * - After every session start (startup/reload/new/resume/fork), apply the
 *   launch plan: re-expand tool references against Pi's live registry
 *   (including extension- and MCP-provided tools) and call setActiveTools
 *   for strict allowlisting, persist the selection after switches, and
 *   produce the one-shot change summary injected into the next turn
 *   via `before_agent_start`.
 * - `/profile use <name>` / `/profile reload`: in-session switching without
 *   restarting the Pi process (src/switching/switch-profile.ts).
 * - `/profile overlay ...`: runtime overlay (ticket 06; renamed with the
 *   command word — disable/enable/tools/clear).
 * - `/profile` (selector; degrades to the list without dialog-capable UI)
 *   and `/profile status`: observability surface (ticket 07). Status
 *   combines the active launch plan, the stored overlay, fresh MCP
 *   discovery, and Pi's actual command registrations (the winner evidence
 *   for same-name conflicts).
 * - The degraded list and status ship structured `details` payloads
 *   (`{kind, profiles}` / `{kind, report}`) for RPC consumers (ticket 11).
 *
 * Pi re-executes this module on reload, so post-reload state is established
 * exclusively through `session_start` — nothing stale survives.
 */

/** The bundled package's own metadata: the notifier compares the RUNNING
 *  package version (never Pi's version or a repository checkout). */
const OWN_PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

async function readOwnVersion(): Promise<string | undefined> {
	try {
		const raw: unknown = JSON.parse(await readFile(OWN_PACKAGE_JSON, "utf8"));
		if (isRecord(raw) && typeof raw.version === "string") return raw.version;
	} catch {
		// Unresolvable package metadata: startup notices are skipped quietly.
	}
	return undefined;
}

/** Notice presentation surface: the TUI notification channel when available,
 *  stderr in every other mode (never stdout, never the agent's prompts). */
function createNoticeSurface(ctx: unknown): NoticeSurface {
	const context = ctx as {
		hasUI?: boolean;
		mode?: string;
		ui?: { notify?: (message: string, level: "info" | "warning" | "error") => void };
	};
	if (context.hasUI === true && context.mode === "tui" && typeof context.ui?.notify === "function") {
		return { display: (message, level) => context.ui!.notify!(message, level) };
	}
	return {
		display: (message) => {
			process.stderr.write(`${message}\n`);
		},
	};
}

/** Startup notices run once per Pi process on the initial session_start,
 *  without awaiting remote IO, in an isolated failure domain: a notifier
 *  problem can never block profile activation, change Pi's exit code, or
 *  reach the activation/switch error path. Pi re-executes this module on
 *  reload, and reload/new/resume/fork never pass reason "startup", so no
 *  second check is possible within one process. */
async function startStartupNotices(surface: NoticeSurface): Promise<void> {
	try {
		const version = await readOwnVersion();
		if (version === undefined) return;
		await runStartupNotifications({
			installedVersion: version,
			workspaceDir: getProfileSwitchDir(),
			offline: process.env.PI_OFFLINE === "1",
			surface,
		});
	} catch {
		// Best-effort by contract: swallow everything the notifier missed.
	}
}

async function observeRegisteredSubagents(pi: ExtensionAPI): Promise<"detected" | "unconfirmed"> {
	try {
		return await observeSubagentExtension([...pi.getAllTools(), ...pi.getCommands()]);
	} catch {
		return "unconfirmed";
	}
}

function setProfileStatus(ui: unknown, profile: string | undefined): void {
	if (profile && typeof (ui as { setStatus?: (k: string, v: string) => void })?.setStatus === "function") {
		(ui as { setStatus: (k: string, v: string) => void }).setStatus("profile", `profile: ${profile}`);
	}
}

/** Reports an activation failure through the current UI, falling back to
 *  stderr when the UI is absent or the command context is already stale.
 *  Unlike the success channel, a failure must not vanish after the rollback
 *  reload, so a stale context falls back to stderr instead of being
 *  swallowed. */
function reportActivationFailure(
	ctx: { ui?: { notify?(message: string, level: "error" | "info" | "warning"): void } },
	message: string,
): void {
	try {
		if (ctx.ui?.notify !== undefined) {
			ctx.ui.notify(message, "error");
			return;
		}
	} catch {
		// The command context was invalidated by a reload: fall through to stderr.
	}
	process.stderr.write(`pi-profile: ${message}\n`);
}

export default function piProfileExtension(pi: ExtensionAPI): void {
	const runtimeDir = process.env.PI_CODING_AGENT_DIR;
	if (runtimeDir === undefined) return;

	let pendingSummary: string | undefined;

	pi.on("session_start", async (event, ctx) => {
		// Capture the notice surface synchronously: pi may replace the session
		// right after this handler (one-shot modes), after which a captured
		// ctx throws on access. The surface freezes the channel now.
		const noticeSurface = createNoticeSurface(ctx);
		const plan = await readLaunchPlanFile(runtimeDir);
		setProfileStatus(ctx.ui, plan?.profile);
		const result = await applyLaunchPlan({
			runtimeDir,
			cwd: ctx.cwd,
			reason: event.reason,
			surface: {
				getAllTools: () => pi.getAllTools(),
				setActiveTools: (names) => pi.setActiveTools(names),
				notify: (message, level) => ctx.ui?.notify(message, level),
				getCommands: () => pi.getCommands(),
				observeSubagents: () => observeRegisteredSubagents(pi),
				notifySubagentWarning: (message) => noticeSurface.display(message, "warning"),
			},
		});
		pendingSummary = result.summary;
		if (event.reason === "startup") {
			void startStartupNotices(noticeSurface);
		}
	});

	pi.on("before_agent_start", async (event) => {
		let systemPrompt = event.systemPrompt;
		if (pendingSummary !== undefined) {
			systemPrompt = `${systemPrompt}\n\n[${pendingSummary}]`;
			pendingSummary = undefined;
		}
		return { systemPrompt };
	});

	pi.registerCommand("profile", {
		description: "pi-profile: /profile [use|reload|status|overlay]",
		handler: async (args, ctx) => {
			const [subcommandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommandRaw ?? ""; // bare /profile → selector
			// Stale-tolerant: after a successful reload this command context is
			// invalidated and property access throws. Post-reload feedback is
			// the new instance's job (session_start summary), so swallowed
			// stale-ctx failures lose nothing the user would otherwise see.
			const ui = ctx.ui;
			const notify = (message: string, level: "info" | "warning" | "error") => {
				try {
					ui?.notify(message, level);
				} catch {
					// stale context after reload — see above
				}
			};
			const notifySwitchWarnings = async (result: { profile: string; warnings: string[] }): Promise<void> => {
				// switchProfile returns final-stage structured messages only, not
				// superseded resolution messages. Successful reload delivered these
				// persisted issues; unmatched plain/legacy warnings remain observable.
				const next = await readLaunchPlanFile(runtimeDir);
				const delivered = new Set(next?.profile === result.profile ? (next.diagnostics ?? []).map((issue) => issue.message) : []);
				for (const warning of new Set(result.warnings)) if (!delivered.has(warning)) notify(warning, "warning");
			};
			const usage = `usage: /profile [use <name> | reload | status | ${OVERLAY_USAGE}]`;
			if (subcommand === "use" && rest.length === 0) {
				notify("usage: /profile use <name>", "error");
				return;
			}
			if (subcommand !== "" && !["use", "reload", "status", "overlay"].includes(subcommand)) {
				notify(usage, "error");
				return;
			}
			try {
				const plan = await readLaunchPlanFile(runtimeDir);
				if (plan?.agentDir === undefined) {
					// Without the real agent dir the switch cannot reach catalogs,
					// trust state, or state files — fail loudly, never guess one.
					notify("cannot switch: the launch plan carries no real agent dir", "error");
					return;
				}
				const deps: SwitchDeps = {
					runtimeDir,
					realAgentDir: plan.agentDir,
					cwd: ctx.cwd,
					getAllTools: () => pi.getAllTools(),
					waitForIdle: () => ctx.waitForIdle(),
					reload: () => ctx.reload(),
					// A real reload invalidates this context (Pi re-executes
					// extensions); property access then throws. Interactive Pi
					// swallows reload refusals, so this probe is the switch's
					// proof that the reload actually ran.
					assertStale: () => {
						void ctx.cwd;
					},
					// Deliver the actionable failure cause before the rollback
					// reload invalidates this context; fall back to stderr otherwise.
					reportFailure: (message) => reportActivationFailure(ctx, message),
				};
				if (subcommand === "use") {
					const result = await switchProfile(rest[0], deps, { clearOverlay: true });
					await notifySwitchWarnings(result);
					setProfileStatus(ui, result.profile);
					notify(`profile active: ${result.profile}`, "info");
					return;
				}
				if (subcommand === "reload") {
					const result = await switchProfile(undefined, deps, { reloadCurrent: true });
					await notifySwitchWarnings(result);
					setProfileStatus(ui, result.profile);
					notify(`profile reloaded: ${result.profile}`, "info");
					return;
				}
				if (subcommand === "overlay") {
					const command = parseOverlayArgs(rest.join(" "));
					if (command.kind === "clear") {
						const result = await clearOverlay(deps);
						await notifySwitchWarnings(result);
						notify(`overlay cleared: ${result.profile}`, "info");
						return;
					}
					const result = await applyOverlayMutation(deps, command.mutate);
					await notifySwitchWarnings(result);
					notify(`overlay updated: ${result.profile}`, "info");
					return;
				}
				// Observability surface (ticket 07): bare /profile opens the
				// selector; status renders via a displayed custom message.
				if (subcommand === "status") {
					const { projectTrusted } = await readTrustInputs({ agentDir: plan.agentDir, cwd: ctx.cwd });
					const stateDir = plan.source === "project" ? path.join(ctx.cwd, ".pi") : getGlobalStateDir(plan.agentDir);
					const state = await new RuntimeStateStore(stateDir).read();
					const mcpDiscovery = await loadMergedMcpServers(
						plan.agentDir,
						projectTrusted ? ctx.cwd : undefined,
						{ invalidSource: "diagnose" },
					);
					const discoveredMcpServers = Object.keys(mcpDiscovery.servers).sort();
					const disabledMcpServers = discoveredMcpServers.filter(
						(server) => mcpDiscovery.servers[server]?.enabled === false,
					);
					const report = buildStatusReport({
						plan: { ...plan, diagnostics: mergeResolutionDiagnostics(plan.diagnostics, mcpSourceDiagnostics(plan.profile, mcpDiscovery.diagnostics)) },
						...(plan.subagents !== undefined
							? { subagentObservation: await observeRegisteredSubagents(pi) }
							: {}),
						overlay: state.overlay,
						discoveredMcpServers,
						disabledMcpServers,
						projectMcpServers: [...mcpDiscovery.projectServers].sort(),
						commands: pi.getCommands(),
						tools: pi.getAllTools(),
					});
					pi.sendMessage({
						customType: "pi-profile",
						content: formatStatusMarkdown(report),
						display: true,
						// Structured form for RPC consumers (ticket 11): the message
						// event carries the full report object in `details`.
						details: { kind: "status", report },
					});
					return;
				}
				const catalogDiagnostics: string[] = [];
				const entries = await listProfiles({ realAgentDir: plan.agentDir, cwd: ctx.cwd, onDiagnostic: (message) => catalogDiagnostics.push(message) });
				// Bare /profile: the interactive selector. Degradation boundary
				// (delta "Observability surface"): outside TUI mode the selector
				// does not run — the bare invocation degrades to the trust-gated
				// list, carrying the structured payload the removed `list`
				// subcommand emitted.
				if (!ctx.hasUI || ctx.mode !== "tui") {
					pi.sendMessage({
						customType: "pi-profile",
						content: [formatProfileList(entries, plan.profile), ...catalogDiagnostics.map((message) => `warning: ${message}`)].join("\n"),
						display: true,
						details: { kind: "list", profiles: entries, ...(catalogDiagnostics.length > 0 ? { diagnostics: catalogDiagnostics } : {}) },
					});
					return;
				}
				for (const diagnostic of catalogDiagnostics) notify(diagnostic, "warning");
				for (const entry of entries) {
					if (!entry.available) notify(`${entry.name} [${entry.source}] — unavailable: ${entry.error}`, "error");
					for (const warning of entry.warnings ?? []) notify(warning, "warning");
				}
				const choice = await ctx.ui.select(
					"select a profile",
						entries.filter((entry) => entry.available).map((entry) => {
						const label = entry.label ?? entry.description;
						return `${entry.name} [${entry.source}]${label !== undefined ? ` — ${label}` : ""}`;
					}),
				);
				if (choice === undefined) return; // cancelled
				const chosen = choice.split(" [")[0] ?? choice;
				const selected = entries.find((entry) => entry.name === chosen);
				if (selected?.available !== true) {
					notify(selected?.error ?? `profile "${chosen}" is not selectable; choose an available profile`, "error");
					return;
				}
				if (chosen === plan.profile) return;
				const switched = await switchProfile(chosen, deps, { clearOverlay: true });
				await notifySwitchWarnings(switched);
				setProfileStatus(ui, switched.profile);
			} catch (error) {
				notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
