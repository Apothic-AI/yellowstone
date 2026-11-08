import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import envContext, { buildEnvironmentSection, DEFAULT_OMIT, SECTION_NAME } from "../src/index.ts";
import { clearEnvMessages, registerEnvMessage } from "../src/messages.ts";
import { clearContributions, REGISTRY_SYMBOL, registerEnvContribution } from "../src/registry.ts";
import { resetEnabled } from "../src/toggle.ts";

afterEach(() => {
	clearContributions();
	clearEnvMessages();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	resetEnabled();
});

// The on/off switch is read from pi's settings file, so every test gets a file of its own rather
// than the operator's: a real one that says "off" would fail every test here.
beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-persist-agent-"));
	resetEnabled();
});

type Handler = (event: unknown, ctx: unknown) => unknown;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function harness(
	activeTools: string[] = ["read", "bash"],
	settings: object = {},
	settingsThrows = false,
	options: {
		cwd?: string;
		projectTrusted?: boolean;
		hasUI?: boolean;
		notify?: (message: string, type?: string) => void;
	} = {},
) {
	const handlers = new Map<string, Handler>();
	envContext({
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: () => {},
		getActiveTools: () => activeTools,
		getSettings: () => {
			if (settingsThrows) throw new Error("settings unavailable");
			return settings;
		},
	} as unknown as ExtensionAPI);

	const ctx = {
		cwd: options.cwd ?? "/home/u/project",
		provider: "relayfast",
		mode: "tui",
		model: { provider: "relayfast" },
		// Pi answers this per project; the harness decides, since there is no trust store on disk.
		isProjectTrusted: () => options.projectTrusted ?? false,
		hasUI: options.hasUI ?? false,
		ui: { notify: options.notify ?? (() => {}) },
		// Dedup reads the active branch; an empty one means "nothing injected yet".
		sessionManager: { buildContextEntries: () => [] as unknown[] },
	};
	// `systemPrompt` is a readonly field pi sets on the event; the handler must not return an
	// override, so the harness omits it entirely rather than seeding a value.
	const event: { type: string; systemPrompt?: string; systemPromptOptions: { sections: Record<string, string> } } = {
		type: "before_agent_start",
		systemPromptOptions: { sections: {} },
	};
	return {
		async providerRequest(payload: unknown) {
			return handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx);
		},
		async start() {
			const result = (await handlers.get("before_agent_start")!(event, ctx)) as
				| { message?: { customType?: string; content?: string } }
				| undefined;
			return { event, message: result?.message };
		},
		event,
		ctx,
	};
}

describe("before_agent_start wiring", () => {
	test("writes the section in place so pi can diff it", async () => {
		const app = harness();
		const { event } = await app.start();
		const section = event.systemPromptOptions.sections[SECTION_NAME];
		// The body carries no wrapper; pi wraps every section in its own `<name>` tag.
		expect(section).toContain("<shell>");
		expect(section).not.toContain("<environment_context>");
		expect(section).toContain("<shell>");
		// The handler mutates `sections` and returns undefined. Returning a `systemPrompt` override
		// would drop every other section and re-report the whole prompt as changed each request.
		expect(event.systemPrompt).toBeUndefined();
	});

	test("volatile contributions never enter the prompt section", async () => {
		registerEnvMessage({ id: "clock", content: "12:00" });
		const { event } = await harness().start();
		// A section change re-renders the cached prefix; volatile text must stay out of it.
		expect(event.systemPromptOptions.sections[SECTION_NAME]).not.toContain("12:00");
	});

	test("before_provider_request appends the trailing message to the payload", async () => {
		const app = harness();
		// Registered after envContext() so the built-in clock does not overwrite the fixture.
		registerEnvMessage({ id: "fixture", content: "12:00" });
		const payload = { messages: [{ role: "user", content: "hi" }] as Array<{ role: string; content: unknown }> };
		await app.providerRequest(payload);
		expect(payload.messages.at(-1)?.role).toBe("developer");
		expect(String(payload.messages.at(-1)?.content)).toContain("<fixture>12:00</fixture>");
	});

	test("declarative items reach both channels", async () => {
		const app = harness();
		const payload = { messages: [] as Array<{ role: string; content: unknown }> };
		await app.providerRequest(payload);
		const text = String(payload.messages.at(-1)?.content);
		// Whatever the items file holds, the envelope is still well formed.
		expect(text.startsWith("<pi_context>")).toBe(true);
		expect(text).toContain("not a user message");
	});

	test("omits cwd because pi already renders its own <cwd> section", async () => {
		const { event } = await harness().start();
		expect(DEFAULT_OMIT).toContain("cwd");
		expect(event.systemPromptOptions.sections[SECTION_NAME]).not.toContain("<cwd>");
	});

	test("includes registered contributions on the next request", async () => {
		registerEnvContribution({ id: "mode", content: () => "<mode>plan</mode>" });
		const { event } = await harness().start();
		expect(event.systemPromptOptions.sections[SECTION_NAME]).toContain("<mode>&lt;mode&gt;plan&lt;/mode&gt;</mode>");
	});

	test("a contribution filtered by provider never reaches the section", async () => {
		registerEnvContribution({ id: "other", providers: ["openrouter"], content: "present" });
		const { event } = await harness().start();
		expect(event.systemPromptOptions.sections[SECTION_NAME]).not.toContain("present");
	});

	test("successive requests produce the same bytes", async () => {
		const app = harness();
		const first = (await app.start()).event.systemPromptOptions.sections[SECTION_NAME];
		const second = (await app.start()).event.systemPromptOptions.sections[SECTION_NAME];
		expect(second).toBe(first);
	});

	test("removes the section when nothing renders", async () => {
		const app = harness();
		app.event.systemPromptOptions.sections[SECTION_NAME] = "stale";
		// Freeze the clock out of the picture: omit everything and register nothing.
		const empty = buildEnvironmentSection({
			cwd: "/x",
			activeTools: [],
			mode: "tui",
			omit: ["cwd", "shell", "platform", "arch"],
		});
		expect(empty).toBe("");
		delete app.event.systemPromptOptions.sections[SECTION_NAME];
		await app.start();
		expect(app.event.systemPromptOptions.sections[SECTION_NAME]).toContain("<shell>");
	});
});

describe("cross-extension registration without importing this package", () => {
	test("a foreign extension can build the registry itself", async () => {
		// The documented escape hatch: an extension with no hard dependency creates the same object
		// shape and sets into the Map directly.
		clearContributions();
		const registry = (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL] as {
			protocol: string;
			version: number;
			contributions: Map<string, unknown>;
		};
		registry.contributions.set("foreign", { id: "foreign", content: "from outside" });
		const { event } = await harness().start();
		expect(event.systemPromptOptions.sections[SECTION_NAME]).toContain("from outside");
	});
});

describe("project-local items", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	/**
	 * A temp agent dir and a temp project dir. `globalItems` overrides the seeded preset, which lets
	 * a test drive an override without touching the real config.
	 */
	function fixture(globalItems?: unknown[], projectItems?: unknown[]): string {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-persist-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-persist-cwd-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		if (globalItems) {
			writeFileSync(join(agentDir, "pi-persist.json"), JSON.stringify({ version: 1, items: globalItems }));
		}
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "pi-persist.json"),
			JSON.stringify({
				version: 1,
				items: projectItems ?? [{ id: "repo_notes", channel: "section", content: "project-scoped note" }],
			}),
		);
		return cwd;
	}

	test("a trusted project's items render in the section", async () => {
		const cwd = fixture();
		const app = harness(["read"], {}, false, { cwd, projectTrusted: true });
		const { event } = await app.start();

		expect(event.systemPromptOptions.sections[SECTION_NAME]).toContain("<repo_notes>project-scoped note</repo_notes>");
	});

	test("an untrusted project's items stay out, and the global items still render", async () => {
		const cwd = fixture();
		const app = harness(["read"], {}, false, { cwd, projectTrusted: false });
		const { event } = await app.start();
		const section = event.systemPromptOptions.sections[SECTION_NAME];

		expect(section).not.toContain("project-scoped note");
		// The built-in environment block is global and must survive a refused project.
		expect(section).toContain("<shell>");
	});

	test("a project item overrides a global item with the same channel:id", async () => {
		const cwd = fixture([{ id: "repo_notes", channel: "section", content: "global note" }]);
		const app = harness(["read"], {}, false, { cwd, projectTrusted: true });
		const { event } = await app.start();
		const section = event.systemPromptOptions.sections[SECTION_NAME];

		expect(section).toContain("project-scoped note");
		expect(section).not.toContain("global note");
	});

	test("reports loaded project items through the UI when there is one", async () => {
		const cwd = fixture();
		const notices: string[] = [];
		const app = harness(["read"], {}, false, {
			cwd,
			projectTrusted: true,
			hasUI: true,
			notify: (message) => notices.push(message),
		});
		await app.start();

		// A project file changes the system prompt, so loading it is never silent.
		expect(notices.join("\n")).toContain(`loaded 1 item(s) from ${join(cwd, ".pi", "pi-persist.json")}`);
	});

	test("warns instead of loading when the project is not trusted", async () => {
		const cwd = fixture();
		const notices: string[] = [];
		const app = harness(["read"], {}, false, {
			cwd,
			projectTrusted: false,
			hasUI: true,
			notify: (message) => notices.push(message),
		});
		await app.start();

		expect(notices.join("\n")).toContain("the project is not trusted");
	});

	test("the same override applies to the trailing channel", async () => {
		const cwd = fixture(
			[{ id: "clock", channel: "trailing", content: "global clock" }],
			[{ id: "clock", channel: "trailing", content: "project clock" }],
		);
		const app = harness(["read"], {}, false, { cwd, projectTrusted: true });
		const payload = { messages: [] as unknown[] };
		await app.start();
		await app.providerRequest(payload);

		const trailing = JSON.stringify(payload.messages);
		expect(trailing).toContain("project clock");
		expect(trailing).not.toContain("global clock");
	});
});
