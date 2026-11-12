// integration.test.ts — disposable running pi sessions, and one change at a time.
//
// These tests drive the real thing: real pi processes, each with this extension
// loaded, so each one runs its own receiver. The caller asks another session for a
// change; that session applies it with its own setters; the answer comes back from
// the session that made the change.
//
// The caller is a real pi too. A driver extension — a temporary fixture, not part of
// the package — registers a command that calls the same function the tool calls, and
// the test drives that command over pi's own control channel. A slash command runs
// in-process, so no provider is called: a parameter change is not a completion.
//
// **The fixture is hermetic.** Each child pi gets its own home, its own pi
// configuration directory, its own session store and its own runtime directory, and it
// inherits nothing but PATH from this process: no operator settings, no operator model
// catalog, no ambient credential. The configuration holds one **fake** provider with
// two fake models and a literal key that is not a credential, and the provider's base
// url points at a local server that records every request — so "no provider call" is
// proven by the absence of a request, not assumed.
//
// No lane of the running fleet is touched, and every session lives in a temporary
// directory.
//
// The question these tests answer is the one that matters: **does a change aimed at
// one session change anything else?**

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelRequest, sendRequest, socketPathFor } from "./channel.ts";
import { openRpcSession, type RpcChild, type RpcSession } from "./rpc.ts";

const SRC_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The driver fixture: a pi extension that loads this package and adds one command.
 *
 * The command calls the package's own session-targeted function with the package's own
 * runtime, built from the real extension context. It is a way to *drive* the tool
 * without a model in the loop; it is not a second implementation of it.
 */
const DRIVER_SOURCE = `import { writeFileSync } from "node:fs";
import parameterTools, { createParameterRuntime } from "${SRC_DIR}/index.ts";
import { applySessionModel, applySessionThinking } from "${SRC_DIR}/target.ts";

export default function driver(pi: any): void {
	parameterTools(pi);
	pi.registerCommand("ft55-call", {
		description: "ft55 test driver: run one parameter tool and report its result",
		handler: async (args: string, ctx: any): Promise<void> => {
			const payload = JSON.parse(args);
			const runtime = createParameterRuntime(pi, ctx);
			const result =
				payload.tool === "set_session_model"
					? await applySessionModel(runtime, payload.tool, payload.request, payload.provider, payload.modelId)
					: await applySessionThinking(runtime, payload.tool, payload.request, payload.level);
			writeFileSync(payload.out, JSON.stringify(result));
		},
	});
	pi.registerCommand("ft55-reload", {
		description: "ft55 test driver: reload the extensions, the way /reload does",
		handler: async (_args: string, ctx: any): Promise<void> => {
			await ctx.reload();
		},
	});
}
`;

/* -------------------------------------------------------------------------- */
/* the hermetic fixture                                                        */
/* -------------------------------------------------------------------------- */

/** The provider the disposable sessions use: a fake one, in an isolated pi config. */
const TEST_PROVIDER = "ft55-test";
/** The model every disposable session starts with. */
const BASE_MODEL = "ft55-model-a";
/** The model the model test switches the target to. */
const OTHER_MODEL = "ft55-model-b";
/** The thinking level every disposable session starts with. */
const BASE_THINKING = "off";

/** A key that is not a credential: the provider is configured, and nothing is reachable. */
const FAKE_KEY = "ft55-fake-key-not-a-credential";

/** The thinking levels the fixture models support. "off" is supported by omission. */
const FIXTURE_THINKING_MAP = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

function fixtureModel(id: string, name: string) {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: { ...FIXTURE_THINKING_MAP },
		input: ["text"],
		contextWindow: 100000,
		maxTokens: 10000,
	};
}

/**
 * The disposable session's own baseline, written into the session file.
 *
 * The model and the thinking level are stated by the session itself, so the fixture
 * does not depend on what a default would be on the machine that runs it.
 */
function writeDisposableSession(dir: string, name: string, id: string): string {
	const path = join(dir, name);
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-11-12T00:00:00.000Z", cwd: dir },
		{
			type: "model_change",
			id: "m0000001",
			parentId: null,
			timestamp: "2026-11-12T00:00:00.000Z",
			provider: TEST_PROVIDER,
			modelId: BASE_MODEL,
		},
		{
			type: "thinking_level_change",
			id: "t0000001",
			parentId: "m0000001",
			timestamp: "2026-11-12T00:00:00.000Z",
			thinkingLevel: BASE_THINKING,
		},
		{
			type: "message",
			id: "msg00001",
			parentId: "t0000001",
			timestamp: "2026-11-12T00:00:00.000Z",
			message: { role: "user", content: "disposable", timestamp: 1762896000000 },
		},
	];
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

/** The isolated pi configuration: one fake provider, two fake models, one fake key. */
function writeIsolatedPiConfig(agentDir: string, baseUrl: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				[TEST_PROVIDER]: {
					name: "FT55 Test Provider",
					baseUrl,
					api: "openai-completions",
					apiKey: FAKE_KEY,
					models: [fixtureModel(BASE_MODEL, "FT55 Model A"), fixtureModel(OTHER_MODEL, "FT55 Model B")],
				},
			},
		})}\n`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			defaultProvider: TEST_PROVIDER,
			defaultModel: BASE_MODEL,
			defaultThinkingLevel: BASE_THINKING,
		})}\n`,
	);
}

let workdir = "";
let agentDir = "";
let sessionStoreDir = "";
let runtimeDir = "";
let driverPath = "";

/**
 * The child's environment: nothing of the operator's, and nothing of the fleet's.
 *
 * Only PATH and the locale survive, because a test child is not the operator's pi and
 * not a lane of the fleet: it has its own home, its own configuration, and no
 * credential of any kind.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "USER", "LOGNAME"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.HOME = workdir;
	env.XDG_RUNTIME_DIR = runtimeDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	env.PI_CODING_AGENT_SESSION_DIR = sessionStoreDir;
	return env;
}

/** pi, in RPC mode, with the extension (and the driver) loaded: a session with a receiver. */
const spawnPi = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) =>
	spawn(command, [...args, "--no-extensions", "--extension", driverPath], {
		stdio: options.stdio,
		env: hermeticEnv(),
	}) as unknown as RpcChild;

/** pi, in RPC mode, with no extension: a running session with no receiver. */
const spawnPiBare = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) =>
	spawn(command, [...args, "--no-extensions"], {
		stdio: options.stdio,
		env: hermeticEnv(),
	}) as unknown as RpcChild;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for something to become true, or say what never became true. */
async function waitFor<T>(
	what: string,
	check: () => T | null | undefined | Promise<T | null | undefined>,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== null && value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

let sessionA = "";
let sessionB = "";
let sessionC = "";
let sessionD = "";
let sessionDup1 = "";
let sessionDup2 = "";
let sessionLife = "";
let idA = "";
let idB = "";
let idC = "";
let idD = "";
let idDup = "";
let idLife = "";
let caller: RpcSession;
let target: RpcSession;
let unrelated: RpcSession;
let bare: RpcSession;
let dupOne: RpcSession;
let dupTwo: RpcSession;
let life: RpcSession;
let callCount = 0;

/** The state a running session reports about itself. */
async function stateOf(session: RpcSession): Promise<Record<string, unknown>> {
	const outcome = await session.getState();
	expect(outcome.ok).toBe(true);
	return (outcome.data ?? {}) as Record<string, unknown>;
}

/** The model a running session reports about itself. */
async function modelOf(session: RpcSession): Promise<{ provider?: string; id?: string }> {
	const state = await stateOf(session);
	return (state.model ?? {}) as { provider?: string; id?: string };
}

/**
 * Call the tool inside the caller's own pi process.
 *
 * The prompt is a slash command, so it runs in-process and the model is never asked
 * anything: pi answers "handled" for a command and "started" for a prompt. The
 * assertion below is what keeps this test provider-free.
 */
async function callTool(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	callCount += 1;
	const out = join(workdir, `result-${callCount}.json`);
	const outcome = await caller.prompt(`/ft55-call ${JSON.stringify({ ...payload, out })}`);
	expect(outcome.ok).toBe(true);
	expect((outcome.data as { disposition?: string } | undefined)?.disposition).toBe("handled");
	return await waitFor("the tool's result", () =>
		existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>) : null,
	);
}

/** A request sent straight over the local channel, to the target's own receiver. */
interface ChannelResponseShape {
	ok: boolean;
	refusal?: { code: string; message: string };
	result?: Record<string, unknown>;
	receiver?: { sessionId: string | null; sessionPath: string | null };
}

/**
 * Ask the receiver that owns a session.
 *
 * The socket is the pair's: the session id **and** the session file. A request that
 * names another session travels over that other session's own socket, with its own
 * pair, so it reaches the process that holds that file.
 */
async function askReceiver(
	sessionId: string,
	sessionPath: string,
	request: Partial<ChannelRequest>,
): Promise<ChannelResponseShape> {
	const response = await sendRequest({
		sessionId,
		sessionPath,
		request: {
			requestId: `probe-${Date.now().toString(36)}`,
			tool: "set_session_thinking",
			sessionId,
			sessionPath: "",
			action: "set_thinking",
			level: "high",
			...request,
		},
	});
	return response as ChannelResponseShape;
}

/** Every request the fake provider's base url received. It must stay empty. */
const providerCalls: string[] = [];
let providerServer: HttpServer | null = null;

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "ft55-sessions-"));
	agentDir = join(workdir, "pi-agent");
	sessionStoreDir = join(workdir, "pi-sessions");
	runtimeDir = join(workdir, "pi-runtime");
	for (const dir of [agentDir, sessionStoreDir, runtimeDir]) mkdirSync(dir, { recursive: true });
	// The sockets live under the runtime directory, so a test run never touches a
	// real lane's socket and never collides with one.
	process.env.XDG_RUNTIME_DIR = runtimeDir;
	driverPath = join(workdir, "driver.ts");
	writeFileSync(driverPath, DRIVER_SOURCE);

	// The fake provider's base url: a local server that answers nothing and records
	// every request. If pi ever called the provider, this test would see it.
	providerServer = createHttpServer((request, response) => {
		providerCalls.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
		response.writeHead(500, { "content-type": "text/plain" });
		response.end("the ft55 fixture does not serve models");
	});
	await new Promise<void>((resolve) => providerServer?.listen(0, "127.0.0.1", resolve));
	const port = (providerServer?.address() as AddressInfo | null)?.port ?? 0;
	writeIsolatedPiConfig(agentDir, `http://127.0.0.1:${port}/v1`);

	idA = "aaaaaaaa-0000-4000-8000-00000000000a";
	idB = "bbbbbbbb-0000-4000-8000-00000000000b";
	idC = "cccccccc-0000-4000-8000-00000000000c";
	idD = "dddddddd-0000-4000-8000-00000000000d";
	idDup = "99999999-0000-4000-8000-000000000009";
	idLife = "88888888-0000-4000-8000-000000000008";
	sessionA = writeDisposableSession(workdir, "a.jsonl", idA);
	sessionB = writeDisposableSession(workdir, "b.jsonl", idB);
	sessionC = writeDisposableSession(workdir, "c.jsonl", idC);
	sessionD = writeDisposableSession(workdir, "d.jsonl", idD);
	// Two sessions that carry the **same** id and sit on **different** files: a
	// copied session file keeps the header's id, so one id is not an identity.
	sessionDup1 = writeDisposableSession(workdir, "dup-1.jsonl", idDup);
	sessionDup2 = writeDisposableSession(workdir, "dup-2.jsonl", idDup);
	sessionLife = writeDisposableSession(workdir, "life.jsonl", idLife);

	caller = await openRpcSession({ spawn: spawnPi, sessionPath: sessionA, timeoutMs: 60_000 });
	target = await openRpcSession({ spawn: spawnPi, sessionPath: sessionB, timeoutMs: 60_000 });
	unrelated = await openRpcSession({ spawn: spawnPi, sessionPath: sessionC, timeoutMs: 60_000 });
	bare = await openRpcSession({ spawn: spawnPiBare, sessionPath: sessionD, timeoutMs: 60_000 });
	dupOne = await openRpcSession({ spawn: spawnPi, sessionPath: sessionDup1, timeoutMs: 60_000 });
	dupTwo = await openRpcSession({ spawn: spawnPi, sessionPath: sessionDup2, timeoutMs: 60_000 });
	life = await openRpcSession({ spawn: spawnPi, sessionPath: sessionLife, timeoutMs: 60_000 });

	// Each session with the extension runs a receiver; the one without does not.
	await waitFor("the caller's receiver", () => (existsSync(socketPathFor(idA, sessionA)) ? true : null));
	await waitFor("the target's receiver", () => (existsSync(socketPathFor(idB, sessionB)) ? true : null));
	await waitFor("the unrelated session's receiver", () => (existsSync(socketPathFor(idC, sessionC)) ? true : null));
	await waitFor("the first duplicate's receiver", () => (existsSync(socketPathFor(idDup, sessionDup1)) ? true : null));
	await waitFor("the second duplicate's receiver", () => (existsSync(socketPathFor(idDup, sessionDup2)) ? true : null));
	await waitFor("the lifecycle session's receiver", () =>
		existsSync(socketPathFor(idLife, sessionLife)) ? true : null,
	);
	// The driver's command must exist before any prompt: a prompt that is not a
	// command would reach the model.
	await waitFor("the driver's command", async () => {
		const outcome = await caller.getCommands();
		const commands = (outcome.data as { commands?: { name?: string }[] } | undefined)?.commands ?? [];
		return commands.some((command) => command.name === "ft55-call") ? true : null;
	});
}, 120_000);

afterAll(async () => {
	for (const session of [caller, target, unrelated, bare, dupOne, dupTwo, life]) {
		if (session) await session.close();
	}
	providerServer?.close();
	if (workdir) rmSync(workdir, { recursive: true, force: true });
	if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
}, 60_000);

describe("a change aimed at another running session", () => {
	test("the fixture is the baseline it claims to be", async () => {
		// The fixture is hermetic: the sessions start at the stated model and the
		// stated thinking level, whatever this machine's own settings say.
		for (const [name, session] of [
			["caller", caller],
			["target", target],
			["unrelated", unrelated],
		] as [string, RpcSession][]) {
			const state = await stateOf(session);
			expect(`${name}:${state.thinkingLevel}`).toBe(`${name}:${BASE_THINKING}`);
			const model = await modelOf(session);
			expect(`${name}:${model.provider}/${model.id}`).toBe(`${name}:${TEST_PROVIDER}/${BASE_MODEL}`);
		}
	});

	test("changes that session's thinking level, and leaves this one alone", async () => {
		const beforeA = readFileSync(sessionA, "utf8");
		const beforeB = readFileSync(sessionB, "utf8");
		const beforeC = readFileSync(sessionC, "utf8");

		const result = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idB, sessionPath: sessionB },
			level: "high",
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.applied).toBe("thinking");
		// the change was made by the target's own process, not by the caller
		expect((result.target as { resolution?: { source?: string } }).resolution?.source).toBe("receiver");
		// the answer is the target's own: before the baseline, after what was asked
		const thinking = result.thinking as { before: string; after: string };
		expect(thinking.before).toBe(BASE_THINKING);
		expect(thinking.after).toBe("high");

		// the target's own running session says so
		expect((await stateOf(target)).thinkingLevel).toBe("high");

		// the caller did not move, and neither did the unrelated session
		expect((await stateOf(caller)).thinkingLevel).toBe(BASE_THINKING);
		expect((await stateOf(unrelated)).thinkingLevel).toBe(BASE_THINKING);
		expect((await modelOf(caller)).id).toBe(BASE_MODEL);
		expect((await modelOf(unrelated)).id).toBe(BASE_MODEL);
		expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
		expect(readFileSync(sessionC, "utf8")).toBe(beforeC);
		expect(readFileSync(sessionB, "utf8")).not.toBe(beforeB);
	});

	test("changes that session's model too", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const beforeA = readFileSync(sessionA, "utf8");
		const beforeC = readFileSync(sessionC, "utf8");

		const result = await callTool({
			tool: "set_session_model",
			request: { sessionId: idB, sessionPath: sessionB },
			provider: TEST_PROVIDER,
			modelId: OTHER_MODEL,
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		// The model changed; the thinking level may have moved with it, because the
		// new model supports different levels.
		expect(["model", "both"]).toContain(result.applied as string);
		expect((result.model as { after?: { modelId?: string } }).after?.modelId).toBe(OTHER_MODEL);
		// the target's own process wrote the record
		expect((result.records as { modelChangeEntryId?: string | null }).modelChangeEntryId).toBeTruthy();

		// the target's own running session says so
		expect((await modelOf(target)).id).toBe(OTHER_MODEL);
		expect(readFileSync(sessionB, "utf8")).not.toBe(beforeB);
		// the caller did not move, and neither did the unrelated session
		expect((await modelOf(caller)).id).toBe(BASE_MODEL);
		expect((await modelOf(unrelated)).id).toBe(BASE_MODEL);
		expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
		expect(readFileSync(sessionC, "utf8")).toBe(beforeC);
	});
});

describe("two sessions that carry the same id", () => {
	test("a change aimed at one of them reaches that one, and leaves the other alone", async () => {
		// One id, two files, two running processes. An id is not an identity: a
		// copied session file keeps the header's id. The socket's name is the pair,
		// so the two are two sockets.
		expect(socketPathFor(idDup, sessionDup1)).not.toBe(socketPathFor(idDup, sessionDup2));
		const beforeOne = readFileSync(sessionDup1, "utf8");
		const beforeTwo = readFileSync(sessionDup2, "utf8");

		const result = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idDup, sessionPath: sessionDup2 },
			level: "high",
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		// the answer is the target's own: its baseline, and what was asked for
		const thinking = result.thinking as { before: string; after: string };
		expect(thinking.before).toBe(BASE_THINKING);
		expect(thinking.after).toBe("high");

		// The process that holds that file changed. The other process, which holds
		// the same id on another file, did not: the request went to one session,
		// not to "the session with that id".
		expect((await stateOf(dupTwo)).thinkingLevel).toBe("high");
		expect((await stateOf(dupOne)).thinkingLevel).toBe(BASE_THINKING);
		expect(readFileSync(sessionDup2, "utf8")).not.toBe(beforeTwo);
		expect(readFileSync(sessionDup1, "utf8")).toBe(beforeOne);
		// and the caller did not move
		expect((await stateOf(caller)).thinkingLevel).toBe(BASE_THINKING);
	});

	test("the other one is reached the same way", async () => {
		const beforeOne = readFileSync(sessionDup1, "utf8");
		const beforeTwo = readFileSync(sessionDup2, "utf8");

		const result = await callTool({
			tool: "set_session_model",
			request: { sessionId: idDup, sessionPath: sessionDup1 },
			provider: TEST_PROVIDER,
			modelId: OTHER_MODEL,
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		expect((await modelOf(dupOne)).id).toBe(OTHER_MODEL);
		expect((await modelOf(dupTwo)).id).toBe(BASE_MODEL);
		expect(readFileSync(sessionDup1, "utf8")).not.toBe(beforeOne);
		expect(readFileSync(sessionDup2, "utf8")).toBe(beforeTwo);
	});
});

describe("a session that changes its own identity", () => {
	test("/new moves the receiver to the new session and leaves no socket behind", async () => {
		const before = await stateOf(life);
		const beforeId = before.sessionId as string;
		const beforeFile = before.sessionFile as string;
		const beforeSocket = socketPathFor(beforeId, beforeFile);
		expect(existsSync(beforeSocket)).toBe(true);

		const outcome = await life.newSession();
		expect(outcome.ok).toBe(true);

		const after = await stateOf(life);
		const afterId = after.sessionId as string;
		const afterFile = after.sessionFile as string;
		expect(afterId).not.toBe(beforeId);
		expect(afterFile).not.toBe(beforeFile);
		// the old session's socket is gone: it went with the old session
		expect(existsSync(beforeSocket)).toBe(false);
		// the new session's receiver is there, and it answers for the new session
		const afterSocket = socketPathFor(afterId, afterFile);
		await waitFor("the new session's receiver", () => (existsSync(afterSocket) ? true : null));
		const response = await sendRequest({
			sessionId: afterId,
			sessionPath: afterFile,
			request: {
				requestId: "lifecycle-new",
				tool: "set_session_thinking",
				sessionId: afterId,
				sessionPath: afterFile,
				action: "set_thinking",
				level: "high",
			},
			timeoutMs: 10_000,
		});
		expect(response.ok).toBe(true);
		expect(response.receiver?.sessionPath).toBe(afterFile);
	}, 60_000);

	test("/resume brings the receiver back to the session it resumes", async () => {
		const outcome = await life.switchSession(sessionLife);
		expect(outcome.ok).toBe(true);
		const state = await stateOf(life);
		expect(state.sessionFile).toBe(sessionLife);
		expect(state.sessionId).toBe(idLife);
		const socket = socketPathFor(idLife, sessionLife);
		await waitFor("the resumed session's receiver", () => (existsSync(socket) ? true : null));
		const response = await sendRequest({
			sessionId: idLife,
			sessionPath: sessionLife,
			request: {
				requestId: "lifecycle-resume",
				tool: "set_session_thinking",
				sessionId: idLife,
				sessionPath: sessionLife,
				action: "set_thinking",
				level: "high",
			},
			timeoutMs: 10_000,
		});
		expect(response.ok).toBe(true);
		expect(response.receiver?.sessionPath).toBe(sessionLife);
	}, 60_000);

	test("/reload replaces the receiver, and the socket stays where it is", async () => {
		const state = await stateOf(life);
		const socket = socketPathFor(state.sessionId as string, state.sessionFile as string);
		// The name points at the receiver's own socket. A reload runs the extension
		// again, so the receiver behind the name is a new one.
		const before = readlinkSync(socket);

		const outcome = await life.prompt("/ft55-reload");
		expect(outcome.ok).toBe(true);
		expect((outcome.data as { disposition?: string } | undefined)?.disposition).toBe("handled");

		await waitFor("the reloaded receiver", () => (existsSync(socket) ? true : null));
		expect(readlinkSync(socket)).not.toBe(before);
		const response = await sendRequest({
			sessionId: state.sessionId as string,
			sessionPath: state.sessionFile as string,
			request: {
				requestId: "lifecycle-reload",
				tool: "set_session_thinking",
				sessionId: state.sessionId as string,
				sessionPath: state.sessionFile as string,
				action: "set_thinking",
				level: "high",
			},
			timeoutMs: 10_000,
		});
		expect(response.ok).toBe(true);
		expect(response.receiver?.sessionPath).toBe(state.sessionFile as string);
	}, 60_000);
});

describe("a target that cannot be changed", () => {
	test("a running session with no receiver loaded is refused, and nothing is written", async () => {
		const beforeD = readFileSync(sessionD, "utf8");
		const result = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idD, sessionPath: sessionD },
			level: "high",
		});
		expect(result.ok).toBe(false);
		expect((result.refusal as { code?: string } | undefined)?.code).toBe("receiver_unavailable");
		expect(result.changed).toBe(false);
		expect(readFileSync(sessionD, "utf8")).toBe(beforeD);
	});

	test("a request that names another session is refused by the target itself", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const response = await askReceiver(idB, sessionB, { sessionId: idC, sessionPath: sessionC });
		expect(response.ok).toBe(false);
		expect(response.refusal?.code).toBe("session_id_mismatch");
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("a request that names another session file is refused by the target itself", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const response = await askReceiver(idB, sessionB, { sessionId: idB, sessionPath: sessionC });
		expect(response.ok).toBe(false);
		expect(response.refusal?.code).toBe("session_identity_mismatch");
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("an ambiguous binding is refused before anything is sent", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const both = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idB, sessionPath: sessionB, lane: "lane-a" },
			level: "high",
		});
		expect(both.ok).toBe(false);
		expect((both.refusal as { code?: string } | undefined)?.code).toBe("identity_binding_conflict");

		const neither = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idB },
			level: "high",
		});
		expect(neither.ok).toBe(false);
		expect((neither.refusal as { code?: string } | undefined)?.code).toBe("identity_binding_required");

		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("a receiver that does not answer is a timeout", async () => {
		// A socket that accepts the connection and never answers: the caller must not
		// wait forever, and must say that it timed out.
		const id = "eeeeeeee-0000-4000-8000-00000000000e";
		const sessionPath = join(workdir, "timeout-probe.jsonl");
		const server = createServer(() => {
			// accept, and say nothing
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(id, sessionPath), resolve));
		try {
			const started = Date.now();
			const response = await sendRequest({
				sessionId: id,
				sessionPath,
				request: {
					requestId: "timeout-probe",
					tool: "set_session_thinking",
					sessionId: id,
					sessionPath: "",
					action: "set_thinking",
					level: "high",
				},
				timeoutMs: 300,
			});
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_timeout");
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			server.close();
		}
	});

	test("nothing ever called the provider", () => {
		// The fake provider's base url recorded every request it received. A
		// parameter change is not a completion: there was no request.
		expect(providerCalls).toEqual([]);
	});
});
