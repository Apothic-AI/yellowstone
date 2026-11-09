import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as initialProfile from "../src/launcher/initial-profile.ts";
import * as jsonFile from "../src/json-file.ts";
import piProfileExtension from "../extensions/pi-profile/index.ts";

let root: string;
let savedAgentDir: string | undefined;
let savedSwitchDir: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-profile-ext-"));
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	savedSwitchDir = process.env.PI_PROFILE_SWITCH_DIR;
	savedHome = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_PROFILE_SWITCH_DIR = root;
	process.env.HOME = root;
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedSwitchDir === undefined) delete process.env.PI_PROFILE_SWITCH_DIR;
	else process.env.PI_PROFILE_SWITCH_DIR = savedSwitchDir;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	await rm(root, { recursive: true, force: true });
});

interface FakePi {
	handlers: Map<string, Array<(...args: never[]) => unknown>>;
	commands: Map<string, { description: string; handler: (...args: never[]) => unknown }>;
	events: { on(event: string, handler: unknown): void; emit(event: string, data: unknown): void };
	activeTools: string[];
	sentMessages: Array<{ customType: string; content: unknown; display?: boolean; details?: unknown }>;
	on(event: string, handler: (...args: never[]) => unknown): void;
	registerCommand(name: string, def: { description: string; handler: (...args: never[]) => unknown }): void;
	getAllTools(): Array<{ name: string }>;
	setActiveTools(names: string[]): void;
	getCommands(): Array<{ name: string; sourceInfo?: { path: string } }>;
	sendMessage(message: { customType: string; content: unknown; display?: boolean }): void;
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
	const commands = new Map<string, { description: string; handler: (...args: never[]) => unknown }>();
	const pi: FakePi = {
		handlers,
		commands,
		events: { on() {}, emit() {} },
		activeTools: [],
		sentMessages: [],
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		getAllTools: () => ["read", "bash"].map((name) => ({ name })),
		setActiveTools(names) {
			pi.activeTools = names;
		},
		getCommands: () => [],
		sendMessage(message) {
			pi.sentMessages.push(message);
		},
	};
	return pi;
}

function fakeCtx(options?: {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	selectAnswer?: string;
	selectAnswers?: string[];
	inputAnswers?: Array<string | undefined>;
	confirmAnswers?: boolean[];
	/** Model Pi's post-reload context invalidation for `ui` access. */
	staleUi?: boolean;
	/** No UI surface at all (non-interactive modes). */
	uiAbsent?: boolean;
}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const inputAnswers = [...(options?.inputAnswers ?? [])];
	const confirmAnswers = [...(options?.confirmAnswers ?? [])];
	const selectAnswers = [...(options?.selectAnswers ?? [])];
	// Mirror real Pi: reload re-executes extensions, invalidating this
	// context — property access afterwards throws (the switch's staleness
	// probe reads ctx.cwd).
	let stale = false;
	const uiSurface = {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		select: async (title: string, selectOptions: string[]) => {
			selectCalls.push({ title, options: selectOptions });
			return selectAnswers.length > 0 ? selectAnswers.shift() : options?.selectAnswer;
		},
		input: async () => inputAnswers.shift(),
		confirm: async () => confirmAnswers.shift() ?? true,
	};
	return {
		notifications,
		selectCalls,
		get cwd() {
			if (stale) throw new Error("context invalidated by reload");
			return root;
		},
		hasUI: options?.hasUI ?? false,
		mode: options?.mode ?? "tui",
		isIdle: () => true,
		waitForIdle: async () => {},
		reload: async () => {
			stale = true;
		},
		get ui(): typeof uiSurface | undefined {
			if (options?.uiAbsent) return undefined;
			if (options?.staleUi && stale) throw new Error("context invalidated by reload");
			return uiSurface;
		},
	};
}

async function writeLaunchPlan(plan: unknown): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "pi-profile.json"), JSON.stringify(plan));
}

async function writeGlobalProfiles(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(root, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function fireSessionStart(pi: FakePi, reason = "startup", ctx?: ReturnType<typeof fakeCtx>): Promise<void> {
	const handler = pi.handlers.get("session_start")?.[0];
	await handler?.({ reason } as never, (ctx ?? fakeCtx()) as never);
}

/** Lets the un-awaited startup-notifier job (fs-bound, no network with a
 *  fresh seeded cache) surface its notices. The notice is displayed before
 *  its key is persisted, so the history is a LATER step: never assert on
 *  `displayed.json` right after this returns, wait for the expected key with
 *  `waitForDisplayedKey` instead. */
async function waitForNotices(ctx: ReturnType<typeof fakeCtx>): Promise<void> {
	const deadline = Date.now() + 2000;
	while (ctx.notifications.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Waits for the recorded displayed-history to contain `until` and returns
 *  the keys read. Recording follows display by a few (fs-latency-bound)
 *  milliseconds; a single read races that write. */
async function waitForDisplayedKey(until: string): Promise<string[]> {
	const deadline = Date.now() + 2000;
	let keys: string[] = [];
	while (!keys.includes(until) && Date.now() < deadline) {
		try {
			const history = JSON.parse(await readFile(path.join(root, "notifications", "displayed.json"), "utf8")) as {
				keys?: unknown;
			};
			keys = Array.isArray(history.keys) ? history.keys.filter((key): key is string => typeof key === "string") : [];
		} catch {
			// Not written yet (or observed mid-rename): retry until the deadline.
		}
		if (!keys.includes(until)) await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return keys;
}

async function runBeforeAgentStart(pi: FakePi, systemPrompt: string): Promise<string | undefined> {
	const handler = pi.handlers.get("before_agent_start")?.[0];
	const result = (await handler?.({ systemPrompt } as never, fakeCtx() as never)) as
		| { systemPrompt?: string }
		| undefined;
	return result?.systemPrompt;
}

describe("startup notifications (add-startup-notifications)", () => {
	const ownVersion = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")).version as string;
	const newerTarget = "99.0.0";
	let savedOffline: string | undefined;

	beforeEach(() => {
		savedOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1"; // never touch the network in unit tests
	});

	afterEach(() => {
		if (savedOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = savedOffline;
	});

	interface AnnouncementSeed {
		id: string;
		message: string;
		action: string;
		expiresAt: string;
		requiresUpgrade?: boolean;
	}

	async function seedNotificationCache(seed: {
		latest?: string;
		announcements?: AnnouncementSeed[];
		displayed?: string[];
	}): Promise<void> {
		const dir = path.join(root, "notifications");
		await mkdir(dir, { recursive: true });
		const fresh = Date.now();
		if (seed.latest !== undefined) {
			await writeFile(
				path.join(dir, "npm-latest.json"),
				JSON.stringify({ schemaVersion: 1, data: { latest: seed.latest }, lastSuccess: fresh, lastAttempt: fresh }),
			);
		}
		if (seed.announcements !== undefined) {
			await writeFile(
				path.join(dir, "announcements-feed.json"),
				JSON.stringify({
					schemaVersion: 1,
					data: { announcements: seed.announcements.map((entry) => ({ requiresUpgrade: false, ...entry })) },
					lastSuccess: fresh,
				lastAttempt: fresh,
				}),
			);
		}
		await writeFile(
			path.join(dir, "displayed.json"),
			JSON.stringify({ schemaVersion: 1, keys: seed.displayed ?? [] }),
		);
	}

	const upgradeAnnouncement: AnnouncementSeed = {
		id: "upgrade-required",
		message: "Urgent: please upgrade pi-profile-switch.",
		action: "Run npm install -g pi-profile-switch.",
		expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		requiresUpgrade: true,
	};

	it("displays an eligible cached notice through the TUI on initial session start", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		await seedNotificationCache({ latest: newerTarget });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ hasUI: true, mode: "tui" });

		await fireSessionStart(pi, "startup", ctx);
		await waitForNotices(ctx);

		expect(ctx.notifications).toHaveLength(1);
		expect(ctx.notifications[0]!.message).toContain(ownVersion);
		expect(ctx.notifications[0]!.message).toContain(newerTarget);
		expect(ctx.notifications[0]!.message).toContain("npm install -g pi-profile-switch");
		expect(ctx.notifications[0]!.level).toBe("info");
	});

	it("an upgrade-required announcement suppresses the routine reminder without marking its target shown", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		await seedNotificationCache({ latest: newerTarget, announcements: [upgradeAnnouncement] });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ hasUI: true, mode: "tui" });

		await fireSessionStart(pi, "startup", ctx);
		await waitForNotices(ctx);

		const text = ctx.notifications.map((entry) => entry.message).join("\n");
		expect(text).toContain(upgradeAnnouncement.message);
		expect(text).not.toContain(`${ownVersion} → ${newerTarget}`);
		// The suppressed reminder target is NOT recorded as shown…
		const keys = await waitForDisplayedKey(`announcement:${upgradeAnnouncement.id}`);
		expect(keys).toContain(`announcement:${upgradeAnnouncement.id}`);
		expect(keys).not.toContain(`upgrade:${newerTarget}`);
	});

	it("writes notices to stderr outside TUI modes", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin" });
		await seedNotificationCache({ latest: newerTarget });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ hasUI: false, mode: "print" });
		const written: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await fireSessionStart(pi, "startup", ctx);
			const deadline = Date.now() + 2000;
			while (!written.some((chunk) => chunk.includes(newerTarget)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		} finally {
			process.stderr.write = realWrite;
		}

		expect(written.join("")).toContain(ownVersion);
		expect(written.join("")).toContain(newerTarget);
		// stdout and the UI notification channel stay untouched.
		expect(ctx.notifications).toEqual([]);
	});

	it("runs the notice check exactly once per process: reload/new/resume/fork do not rerun it", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		await seedNotificationCache({ latest: newerTarget });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ hasUI: true, mode: "tui" });

		await fireSessionStart(pi, "startup", ctx);
		await waitForNotices(ctx);
		expect(ctx.notifications).toHaveLength(1);

		for (const reason of ["reload", "new", "resume", "fork"]) {
			await fireSessionStart(pi, reason, ctx);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(ctx.notifications).toHaveLength(1);
	});

	it("keeps announcement text out of the agent prompt", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		await seedNotificationCache({ announcements: [upgradeAnnouncement] });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ hasUI: true, mode: "tui" });

		await fireSessionStart(pi, "startup", ctx);
		await waitForNotices(ctx);
		expect(ctx.notifications).toHaveLength(1);

		const prompt = await runBeforeAgentStart(pi, "BASE PROMPT");
		expect(prompt).toBe("BASE PROMPT");
		expect(prompt).not.toContain(upgradeAnnouncement.message);
	});
});

describe("pi-profile extension", () => {
	it("sets the footer status badge on session start and profile switch", async () => {
		await writeLaunchPlan({ profile: "review", source: "global" });
		const pi = fakePi();
		piProfileExtension(pi as never);

		const statuses: Record<string, string> = {};
		const ctx = fakeCtx();
		(ctx.ui as any).setStatus = (k: string, v: string) => {
			statuses[k] = v;
		};

		const handler = pi.handlers.get("session_start")?.[0];
		await handler?.({ reason: "startup" } as never, ctx as never);

		expect(statuses.profile).toBe("profile: review");
	});

	it("injects the switch summary into exactly one turn after a switch", async () => {
		await writeLaunchPlan({ profile: "impl", source: "global", switchedFrom: "review" });
		const pi = fakePi();
		piProfileExtension(pi as never);
		await fireSessionStart(pi, "reload");

		const withSummary = await runBeforeAgentStart(pi, "BASE");
		expect(withSummary).toContain("review → impl");
		// One-shot: the marker was consumed and cleared from the plan file.
		expect(await runBeforeAgentStart(pi, "BASE")).not.toContain("→");
	});

	it("registers the /profile command naming the accepted subcommand set", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);

		const command = pi.commands.get("profile");
		expect(command).toBeDefined();
		expect(command?.description).toBe("pi-profile: /profile [use|reload|status|overlay]");
		const ctx = fakeCtx();
		await command?.handler("bogus" as never, ctx as never);
		expect(ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("usage"))).toBe(
			true,
		);
	});

	it("rejects removed subcommands as unknown, naming the accepted set", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);
		for (const args of ["create", "edit x", "delete x", "duplicate", "list", "reset", "customize disable skill x"]) {
			const ctx = fakeCtx({ mode: "rpc" });
			await pi.commands.get("profile")?.handler(args as never, ctx as never);
			const rejection = ctx.notifications.find((entry) => entry.level === "error" && entry.message.includes("usage"));
			expect(rejection?.message).toBeDefined();
			expect(rejection?.message).toContain("use");
			expect(rejection?.message).toContain("reload");
			expect(rejection?.message).toContain("status");
			expect(rejection?.message).toContain("overlay");
		}
	});

	it("rejects use without a name with the use usage note", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx();
		await pi.commands.get("profile")?.handler("use" as never, ctx as never);
		expect(ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("usage: /profile use <name>"))).toBe(
			true,
		);
	});

	it("dispatches overlay mutations and overlay clear through the overlay module", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);

		// Resolution-time validation errors surface as notifications.
		const disableCtx = fakeCtx();
		await pi.commands.get("profile")?.handler("overlay disable skill ghost" as never, disableCtx as never);
		expect(
			disableCtx.notifications.some(
				(entry) => entry.level === "error" && entry.message.includes('overlay disables unknown skill "ghost"'),
			),
		).toBe(true);

		const clearCtx = fakeCtx();
		await pi.commands.get("profile")?.handler("overlay clear" as never, clearCtx as never);
		expect(clearCtx.notifications.some((entry) => entry.level === "info" && entry.message.includes("overlay cleared"))).toBe(
			true,
		);
	});

	it("dispatches the overlay tool form in non-TUI (rpc) mode: disable then enable", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const stateFile = path.join(root, "pi-profile-state.json");

		const disableCtx = fakeCtx({ mode: "rpc" });
		await pi.commands.get("profile")?.handler("overlay disable tool read" as never, disableCtx as never);
		expect(
			disableCtx.notifications.some((entry) => entry.level === "info" && entry.message.includes("overlay updated")),
		).toBe(true);
		expect(JSON.parse(await readFile(stateFile, "utf8")).overlay).toEqual({ disabledTools: ["read"] });

		const enableCtx = fakeCtx({ mode: "rpc" });
		await pi.commands.get("profile")?.handler("overlay enable tool read" as never, enableCtx as never);
		expect(
			enableCtx.notifications.some((entry) => entry.level === "info" && entry.message.includes("overlay updated")),
		).toBe(true);
		const overlay = JSON.parse(await readFile(stateFile, "utf8")).overlay as Record<string, unknown> | undefined;
		expect(overlay === undefined || Object.keys(overlay).length === 0).toBe(true);
	});

	it("delivers an actionable activation failure before the rollback reload invalidates the context", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		await writeGlobalProfiles({ open: {} });
		// Real content at the managed extension path blocks the transition.
		await mkdir(path.join(root, "extensions"), { recursive: true });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ staleUi: true });

		await pi.commands.get("profile")?.handler("use open" as never, ctx as never);

		const failure = ctx.notifications.find(
			(entry) => entry.level === "error" && entry.message.includes('activation of profile "open" failed'),
		);
		expect(failure?.message).toContain(path.join(root, "extensions"));
		expect(failure?.message).toContain("will not delete or overwrite");
		// No false activation reporting on failure.
		expect(ctx.notifications.some((entry) => entry.message.includes("profile active"))).toBe(false);
	});

	it("falls back to stderr when no UI is available for an activation failure", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		await writeGlobalProfiles({ open: {} });
		await mkdir(path.join(root, "extensions"), { recursive: true });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx({ uiAbsent: true });

		const chunks: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await pi.commands.get("profile")?.handler("use open" as never, ctx as never);
		} finally {
			process.stderr.write = realWrite;
		}

		const text = chunks.join("");
		expect(text).toContain('activation of profile "open" failed');
		expect(text).toContain("will not delete or overwrite");
	});

	describe("observability surface (ticket 07)", () => {
		it("/profile status sends the resolved plan report", async () => {
			await writeLaunchPlan({
				profile: "review",
				source: "global",
				agentDir: root,
				resolved: { skills: [{ name: "code-review", filePath: "/x/SKILL.md" }], extensions: [] },
				mcps: ["github"],
			});
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("status" as never, fakeCtx() as never);

			const content = String(pi.sentMessages[0]?.content);
			expect(content).toContain("profile: review (global)");
			expect(content).toContain("code-review → /x/SKILL.md");
			expect(content).toContain("mcp: enabled=[] disabled=[] missing=[github]");
		});

		it("reports declared subagent inputs separately from live extension ownership", async () => {
			await writeLaunchPlan({
				profile: "review",
				source: "global",
				agentDir: root,
				resolved: { skills: [], extensions: [] },
				subagents: { defaultModel: "provider/model", agentOverrides: { reviewer: { description: "Review code" } } },
			});
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("status" as never, fakeCtx() as never);

			const message = pi.sentMessages[0];
			const report = (message?.details as { report: { subagents?: unknown } }).report;
			expect(report.subagents).toEqual({
				declared: { defaultModel: "provider/model", agentOverrides: { reviewer: { description: "Review code" } } },
				extension: "unconfirmed",
			});
			expect(String(message?.content)).toContain("not effective runtime mappings");
			expect(String(message?.content)).toContain("/subagents-models");
		});

		it("warns through the mode-safe notice surface only when declarations exist", async () => {
			await writeLaunchPlan({ profile: "review", source: "global", subagents: { defaultModel: "provider/model" } });
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({ hasUI: true, mode: "tui" });

			await fireSessionStart(pi, "startup", ctx);

			expect(ctx.notifications.filter((entry) => entry.level === "warning" && entry.message.includes("pi-subagents"))).toHaveLength(1);
			expect(ctx.notifications.find((entry) => entry.message.includes("pi-subagents"))?.message).toContain("/subagents-models");
			expect(pi.activeTools).toEqual([]);
		});

		it("does not add subagent warning on session start without a declaration", async () => {
			await writeLaunchPlan({ profile: "review", source: "global" });
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({ hasUI: true, mode: "tui" });

			await fireSessionStart(pi, "startup", ctx);

			expect(ctx.notifications.some((entry) => entry.message.includes("pi-subagents registration"))).toBe(false);
		});

		it("bare /profile falls back to the list without dialog-capable UI", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("" as never, fakeCtx() as never);

			expect(pi.sentMessages).toHaveLength(1);
			expect(String(pi.sentMessages[0]?.content)).toContain("default [builtin]");
		});

		it("bare /profile with a UI but outside TUI mode degrades to the list", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			await writeGlobalProfiles({ review: { label: "Code review" } });
			const pi = fakePi();
			piProfileExtension(pi as never);

			await pi.commands.get("profile")?.handler("" as never, fakeCtx({ hasUI: true, mode: "rpc" }) as never);

			expect(pi.sentMessages).toHaveLength(1);
			expect(pi.sentMessages[0]?.customType).toBe("pi-profile");
			expect(String(pi.sentMessages[0]?.content)).toContain("review [global] — Code review");
		});

		it("bare /profile with UI offers every visible profile and cancels cleanly", async () => {
			await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
			await writeGlobalProfiles({ review: {} });
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx({ hasUI: true, selectAnswer: undefined });

			await pi.commands.get("profile")?.handler("" as never, ctx as never);

			expect(ctx.selectCalls[0]?.options).toContain("default [builtin]");
			expect(ctx.selectCalls[0]?.options).toContain("review [global]");
			// Cancelled: no message, no error notification.
			expect(pi.sentMessages).toHaveLength(0);
			expect(ctx.notifications).toHaveLength(0);
		});
	});

	it("does not register an mcp command", async () => {
		const pi = fakePi();
		piProfileExtension(pi as never);
		expect(pi.commands.has("mcp")).toBe(false);
		expect(pi.commands.has("profile")).toBe(true);
	});

	it("/profile resource is rejected as an unknown subcommand", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		const pi = fakePi();
		piProfileExtension(pi as never);
		const ctx = fakeCtx();
		await pi.commands.get("profile")?.handler("resource list" as never, ctx as never);
		expect(
			ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("usage: /profile")),
		).toBe(true);
	});

	describe("separate MCP tool filtering", () => {
		it("session_start retains live MCP tools when tools narrows Pi tools", async () => {
			await writeLaunchPlan({
				profile: "narrow",
				source: "global",
				agentDir: root,
				tools: ["read"],
				toolReferences: ["read"],
				resolved: {
					skills: [],
					extensions: [],
				},
			});
			const pi = fakePi();
			pi.getAllTools = () => [
				{ name: "read", sourceInfo: { path: "pi", source: "builtin" } },
				{ name: "bash", sourceInfo: { path: "pi", source: "builtin" } },
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
				{ name: "fixture_tool", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			];
			piProfileExtension(pi as never);

			await fireSessionStart(pi);

			// read is retained; bash is excluded; MCP tools (mcp, fixture_tool) are preserved
			expect(pi.activeTools).toContain("read");
			expect(pi.activeTools).not.toContain("bash");
			expect(pi.activeTools).toContain("mcp");
			expect(pi.activeTools).toContain("fixture_tool");
		});

		it("session_start does not retain a tool from a sibling extension as MCP-owned", async () => {
			await writeLaunchPlan({
				profile: "no-pi-tools",
				source: "global",
				agentDir: root,
				tools: [],
				toolReferences: [],
				resolved: {
					skills: [],
					extensions: [
						{ id: "mcp-helper", entry: "/agent/extensions/mcp-helper.ts" },
						{ id: "linter", entry: "/agent/extensions/linter.ts" },
					],
				},
			});
			const pi = fakePi();
			pi.getAllTools = () => [
				{ name: "mcp", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
				{ name: "helper_tool", sourceInfo: { path: "/agent/extensions/mcp-helper.ts", source: "extension" } },
				{ name: "lint_check", sourceInfo: { path: "/agent/extensions/linter.ts", source: "extension" } },
			];
			piProfileExtension(pi as never);

			const ctx = fakeCtx();
			await fireSessionStart(pi, "startup", ctx);

			expect(pi.activeTools).toEqual(["mcp"]);
			expect(ctx.notifications.some((entry) => /lint_check.*mcp_tools/.test(entry.message))).toBe(false);
		});

		it("session_start retains native MCP discovery entry points when the plan marks gateways", async () => {
			await writeLaunchPlan({
				profile: "narrow",
				source: "global",
				agentDir: root,
				tools: ["read"],
				toolReferences: ["read"],
				mcpGateways: true,
				resolved: { skills: [], extensions: [] },
			});
			const pi = fakePi();
			pi.getAllTools = () => [
				{ name: "read", sourceInfo: { path: "pi", source: "builtin" } },
				{ name: "bash", sourceInfo: { path: "pi", source: "builtin" } },
				{ name: "codemode", sourceInfo: { path: "builtin:codemode", source: "builtin" } },
				{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
				{ name: "fixture_tool", sourceInfo: { path: "/agent/extensions/fixture.ts", source: "extension" } },
			];
			piProfileExtension(pi as never);
			const ctx = fakeCtx();

			await fireSessionStart(pi, "startup", ctx);

			expect(pi.activeTools).toContain("read");
			expect(pi.activeTools).toContain("codemode");
			expect(pi.activeTools).toContain("tool_search");
			expect(pi.activeTools).not.toContain("bash");
			expect(pi.activeTools).not.toContain("fixture_tool");
		});

		it("session_start does not use a same-named foreign tool as an MCP gateway", async () => {
			await writeLaunchPlan({
				profile: "narrow",
				source: "global",
				agentDir: root,
				tools: ["read"],
				toolReferences: ["read"],
				mcpGateways: true,
				resolved: { skills: [], extensions: [] },
			});
			const pi = fakePi();
			pi.getAllTools = () => [
				{ name: "read", sourceInfo: { path: "pi", source: "builtin" } },
				{ name: "codemode", sourceInfo: { path: "/agent/extensions/other.ts", source: "extension" } },
				{ name: "tool_search", sourceInfo: { path: "builtin:tool-search", source: "builtin" } },
			];
			piProfileExtension(pi as never);
			const ctx = fakeCtx();

			await fireSessionStart(pi, "startup", ctx);

			expect(pi.activeTools).toContain("read");
			expect(pi.activeTools).toContain("tool_search");
			expect(pi.activeTools).not.toContain("codemode");
			expect(
				ctx.notifications.some(
					(entry) =>
						entry.level === "warning" &&
						entry.message.includes('MCP entry point "codemode" is registered by /agent/extensions/other.ts'),
				),
			).toBe(true);
		});

		it("session_start warns about legacy MCP references in tools", async () => {
			await writeLaunchPlan({
				profile: "legacy",
				source: "global",
				agentDir: root,
				tools: ["read", "mcp__*"],
				toolReferences: ["read", "mcp__*"],
				resolved: {
					skills: [],
					extensions: [],
				},
			});
			const pi = fakePi();
			pi.getAllTools = () => [
				{ name: "read", sourceInfo: { path: "pi", source: "builtin" } },
				{ name: "mcp__query", sourceInfo: { path: "builtin:mcp", source: "builtin" } },
			];
			piProfileExtension(pi as never);
			const ctx = fakeCtx();

			await fireSessionStart(pi, "startup", ctx);

			expect(
				ctx.notifications.some(
					(n) => n.level === "warning" && n.message.includes('tool reference "mcp__*" matched only MCP tools') && n.message.includes("mcp_tools"),
				),
			).toBe(true);
		});

		it("keeps configured MCP names restrictive without warning or validation status", async () => {
			await writeFile(
				path.join(root, "mcp.json"),
				JSON.stringify({ mcpServers: { github: {}, linear: { enabled: false } } }),
			);
			await writeLaunchPlan({
				profile: "restricted",
				source: "global",
				agentDir: root,
				mcpTools: { github: ["serach"] },
			});
			const pi = fakePi();
			piProfileExtension(pi as never);
			const ctx = fakeCtx();

			await fireSessionStart(pi, "startup", ctx);
			expect(ctx.notifications.some((entry) => /MCP server.*tool.*not found/i.test(entry.message))).toBe(false);

			await pi.commands.get("profile")?.handler("status" as never, fakeCtx() as never);
			const report = (pi.sentMessages.at(-1)?.details as { report: any }).report;
			expect(report.mcp).toEqual({ enabled: ["github"], disabled: ["linear"], missing: [] });
			expect(report.mcpTools).toEqual([{ server: "github", policy: "restricted", tools: ["serach"] }]);
			expect(JSON.stringify(report)).not.toMatch(/validation|missing.*candidates|did you mean/i);
		});
	});
});


describe("unavailable listing and diagnostic status", () => {
	it("lists unavailable definitions and filename diagnostics in displayed and structured payloads", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		await writeGlobalProfiles({ bad: { skills: 1 }, valid: {}, default: {}, "bad name": {} });
		const pi = fakePi(); piProfileExtension(pi as never);
		await pi.commands.get("profile")?.handler("" as never, fakeCtx() as never);
		const message = pi.sentMessages[0]!;
		expect(String(message.content)).toContain("bad [global] — unavailable:");
		expect(String(message.content)).toContain("bad name.json");
		const details = message.details as { profiles: Array<{ name: string; available: boolean; error?: string }>; diagnostics: string[] };
		expect(details.profiles.find((entry) => entry.name === "bad")).toMatchObject({ available: false, error: expect.stringContaining("bad.json") });
		expect(details.diagnostics.join("\n")).toContain("default.json");
	});
	it("offers only available choices, shows unavailable errors, and rejects a forged unavailable choice", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		await writeGlobalProfiles({ bad: { skills: 1 }, valid: {} });
		const before = await readFile(path.join(root, "pi-profile.json"), "utf8");
		const pi = fakePi(); piProfileExtension(pi as never);
		const ctx = fakeCtx({ hasUI: true, selectAnswer: "bad [global]" });
		await pi.commands.get("profile")?.handler("" as never, ctx as never);
		expect(ctx.selectCalls[0]?.options).toEqual(["default [builtin]", "valid [global]"]);
		expect(ctx.notifications.some((entry) => entry.message.includes("bad.json"))).toBe(true);
		expect(await readFile(path.join(root, "pi-profile.json"), "utf8")).toBe(before);
	});
	it("explicit use still reports the unavailable selected-definition error without writes", async () => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		await writeGlobalProfiles({ bad: { skills: 1 } });
		const pi = fakePi(); piProfileExtension(pi as never); const ctx = fakeCtx();
		await pi.commands.get("profile")?.handler("use bad" as never, ctx as never);
		expect(ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("bad.json"))).toBe(true);
		expect(JSON.parse(await readFile(path.join(root, "pi-profile.json"), "utf8")).profile).toBe("default");
	});
	it("status never reads catalog definitions and stays available with a bad catalog path", async () => {
		await writeLaunchPlan({ profile: "review", source: "global", agentDir: root, mcps: [], diagnostics: [{ kind: "skill", code: "unknown-reference", reference: "missing", message: "missing skill; not loaded" }] });
		await writeFile(path.join(root, "profiles"), "not a directory");
		await writeFile(path.join(root, "mcp.json"), "{ malformed");
		const pi = fakePi(); piProfileExtension(pi as never); const ctx = fakeCtx();
		const read = vi.spyOn(jsonFile, "readJsonFile");
		await pi.commands.get("profile")?.handler("status" as never, ctx as never);
		expect(pi.sentMessages).toHaveLength(1);
		const report = (pi.sentMessages[0]?.details as { report: { diagnostics: Array<{ kind: string }> } }).report;
		expect(report.diagnostics.some((issue) => issue.kind === "skill")).toBe(true);
		expect(report.diagnostics.some((issue) => issue.kind === "mcp-source")).toBe(true);
		expect(read.mock.calls.map(([file]) => file).some((file) => file.includes(`${path.sep}profiles${path.sep}`))).toBe(false);
	});
	it("reload owns persisted warnings once while non-persisted warnings remain observable after a stale context", async () => {
		const issue = { kind: "extension-discovery", code: "discovery-warning", reference: "collision", message: 'profile "review": collision; local file wins' };
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		vi.spyOn(initialProfile, "resolveInitialProfile").mockResolvedValue({ plan: { profile: "review", source: "global", filter: "selection", skills: [], extensions: [], resourceSelection: { skills: true, extensions: true }, diagnostics: [issue] }, projectTrusted: true, warnings: [issue.message, "non-persisted warning"] });
		const pi = fakePi(); piProfileExtension(pi as never);
		const next = fakeCtx({ hasUI: true });
		const previous = fakeCtx({ hasUI: true });
		const ui = previous.ui;
		const invalidate = previous.reload;
		previous.reload = async () => { await fireSessionStart(pi, "reload", next); await invalidate(); };
		Object.defineProperty(previous, "ui", { get() { void previous.cwd; return ui; } });
		await pi.commands.get("profile")?.handler("use review" as never, previous as never);
		const notices = [...previous.notifications, ...next.notifications];
		expect(notices.filter((entry) => entry.message === issue.message)).toHaveLength(1);
		expect(notices.filter((entry) => entry.message === "non-persisted warning")).toHaveLength(1);
		expect(notices.some((entry) => entry.message.includes("context invalidated"))).toBe(false);
	});
});


describe("command feedback after diagnostic message refresh", () => {
	it.each([false, true])("does not replay replaced/cleared diagnostics (cleared=%s) and retains plain warnings", async (cleared) => {
		await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
		await writeGlobalProfiles({ policy: { mcp_tools: { late: ["search"] } } });
		await writeFile(path.join(root, "mcp.json"), '{"mcpServers":{"alpha":{"command":"alpha"}}}');
		const resolve = initialProfile.resolveInitialProfile;
		vi.spyOn(initialProfile, "resolveInitialProfile").mockImplementation(async (...args) => {
			const result = await resolve(...args);
			await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: cleared ? { late: { command: "late" } } : { beta: { command: "beta" } } }));
			return { ...result, warnings: [...result.warnings, "plain discovery warning"] };
		});
		const pi = fakePi(); piProfileExtension(pi as never);
		const next = fakeCtx({ hasUI: true }); const previous = fakeCtx({ hasUI: true });
		const invalidate = previous.reload;
		previous.reload = async () => { await fireSessionStart(pi, "reload", next); await invalidate(); };
		await pi.commands.get("profile")?.handler("use policy" as never, previous as never);
		const warnings = [...previous.notifications, ...next.notifications].filter((entry) => entry.level === "warning").map((entry) => entry.message);
		expect(warnings.filter((message) => message === "plain discovery warning")).toHaveLength(1);
		expect(warnings.some((message) => message.includes("candidates: alpha"))).toBe(false);
		const issues = warnings.filter((message) => message.includes('unknown MCP server "late"'));
		expect(issues).toHaveLength(cleared ? 0 : 1);
		if (!cleared) expect(issues[0]).toContain("candidates: beta");
	});
});

it("preserves legacy plain command warnings when the persisted plan has no diagnostics", async () => {
	await writeLaunchPlan({ profile: "default", source: "builtin", agentDir: root });
	vi.spyOn(initialProfile, "resolveInitialProfile").mockResolvedValue({ plan: { profile: "legacy", source: "global", filter: "selection", skills: [], extensions: [], resourceSelection: { skills: true, extensions: true } }, projectTrusted: true, warnings: ["legacy plain warning"] });
	const pi = fakePi(); piProfileExtension(pi as never);
	const previous = fakeCtx({ hasUI: true }); const next = fakeCtx({ hasUI: true });
	const invalidate = previous.reload;
	previous.reload = async () => { await fireSessionStart(pi, "reload", next); await invalidate(); };
	await pi.commands.get("profile")?.handler("use legacy" as never, previous as never);
	expect([...previous.notifications, ...next.notifications].filter((entry) => entry.message === "legacy plain warning")).toHaveLength(1);
	expect(JSON.parse(await readFile(path.join(root, "pi-profile.json"), "utf8")).diagnostics).toBeUndefined();
});
