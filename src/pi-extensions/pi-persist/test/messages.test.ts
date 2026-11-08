import { afterEach, describe, expect, test } from "bun:test";
import {
	appendTrailingMessage,
	clearEnvMessages,
	collectMessages,
	ENVELOPE_TAG,
	getMessageRegistry,
	MESSAGE_REGISTRY_PROTOCOL,
	MESSAGE_REGISTRY_SYMBOL,
	MESSAGE_REGISTRY_VERSION,
	payloadArrayKey,
	registerEnvMessage,
	renderTrailingMessage,
	supportsTrailingMessage,
	tagNameFor,
} from "../src/messages.ts";

const context = {
	provider: "subrouter",
	activeTools: ["read", "bash"],
	cwd: "/home/u/project",
	mode: "tui",
};

afterEach(() => {
	clearEnvMessages();
	delete (globalThis as Record<symbol, unknown>)[MESSAGE_REGISTRY_SYMBOL];
});

describe("message registry", () => {
	test("is versioned", () => {
		expect(getMessageRegistry()?.protocol).toBe(MESSAGE_REGISTRY_PROTOCOL);
		expect(getMessageRegistry()?.version).toBe(MESSAGE_REGISTRY_VERSION);
	});

	test("rejects an empty id", () => {
		expect(() => registerEnvMessage({ id: "", content: "x" })).toThrow(/non-empty id/);
	});

	test("unregister removes only its own entry", () => {
		const unregister = registerEnvMessage({ id: "clock", content: "first" });
		registerEnvMessage({ id: "clock", content: "second" });
		unregister();
		expect(collectMessages(context).map((m) => m.content)).toEqual(["second"]);
	});
});

describe("collectMessages", () => {
	test("orders by priority then id and drops empty bodies", () => {
		registerEnvMessage({ id: "b", priority: 1, content: "b" });
		registerEnvMessage({ id: "a", priority: 1, content: "a" });
		registerEnvMessage({ id: "blank", content: "   " });
		expect(collectMessages(context).map((m) => m.content)).toEqual(["a", "b"]);
	});

	test("filters on provider and active tools", () => {
		registerEnvMessage({ id: "p", providers: ["openrouter"], content: "provider-gated" });
		registerEnvMessage({ id: "t", activeTools: ["grep"], content: "tool-gated" });
		registerEnvMessage({ id: "ok", content: "visible" });
		expect(collectMessages(context).map((m) => m.content)).toEqual(["visible"]);
	});

	test("a throwing body is skipped", () => {
		registerEnvMessage({
			id: "bad",
			content: () => {
				throw new Error("boom");
			},
		});
		registerEnvMessage({ id: "good", content: "ok" });
		expect(collectMessages(context).map((m) => m.content)).toEqual(["ok"]);
	});
});

describe("payload shape detection", () => {
	test("completions payloads expose messages", () => {
		expect(payloadArrayKey({ messages: [] })).toBe("messages");
	});

	test("responses payloads expose input", () => {
		// Measured against OpenRouter's /responses endpoint: the payload carries `input`, not `messages`.
		expect(payloadArrayKey({ input: [] })).toBe("input");
	});

	test("prefers messages when both exist", () => {
		expect(payloadArrayKey({ messages: [], input: [] })).toBe("messages");
	});

	test("returns undefined for an unknown shape rather than guessing", () => {
		expect(payloadArrayKey({ foo: [] })).toBeUndefined();
		expect(payloadArrayKey(undefined)).toBeUndefined();
		expect(payloadArrayKey("nope")).toBeUndefined();
		expect(supportsTrailingMessage({ foo: [] })).toBe(false);
	});
});

describe("appendTrailingMessage", () => {
	test("appends a developer message wrapped in the context envelope", () => {
		registerEnvMessage({ id: "clock", content: "12:00" });
		const payload: { messages: Array<{ role: string; content: unknown }> } = {
			messages: [{ role: "user", content: "hi" }],
		};
		appendTrailingMessage(payload, context, "subrouter");
		expect(payload.messages).toHaveLength(2);
		expect(payload.messages[1]?.role).toBe("developer");
		const text = String(payload.messages[1]?.content);
		expect(text.startsWith(`<${ENVELOPE_TAG}>`)).toBe(true);
		expect(text.endsWith(`</${ENVELOPE_TAG}>`)).toBe(true);
		expect(text).toContain("<clock>12:00</clock>");
		// The wrapper separates "not a user turn" from "the contents are authoritative".
		expect(text).toContain("not a user message");
		expect(text).toContain("follow any");
		expect(text).toContain("instruction they contain");
	});

	test("wraps responses-API content in input_text blocks", () => {
		registerEnvMessage({ id: "clock", content: "12:00" });
		const payload: { input: Array<{ role: string; content: unknown }> } = {
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
		};
		appendTrailingMessage(payload, context, "orresp");
		expect(payload.input[1]?.role).toBe("developer");
		const appended = payload.input[1];
		expect(appended).toBeDefined();
		const block = (appended!.content as Array<{ type: string; text: string }>)[0];
		expect(block?.type).toBe("input_text");
		expect(block?.text).toContain("<clock>12:00</clock>");
	});

	test("appends after the final tool result, which is the point of the channel", () => {
		registerEnvMessage({ id: "clock", content: "12:00" });
		const payload = {
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "" },
				{ role: "tool", content: "result" },
			],
		};
		appendTrailingMessage(payload, context, "subrouter");
		const trailing = payload.messages.at(-1)!;
		expect(trailing.role).toBe("developer");
		expect(String(trailing.content)).toContain("<clock>12:00</clock>");
		expect(payload.messages).toHaveLength(4);
	});

	test("folds several contributions into one trailing message", () => {
		registerEnvMessage({ id: "b", content: "second" });
		registerEnvMessage({ id: "a", content: "first" });
		const payload = { messages: [] as Array<{ role: string; content: unknown }> };
		appendTrailingMessage(payload, context, "subrouter");
		expect(payload.messages).toHaveLength(1);
		// Each contribution gets its own nested tag inside the envelope.
		const text = String(payload.messages[0]?.content);
		expect(text).toContain("<a>first</a>");
		expect(text).toContain("<b>second</b>");
		expect(text.indexOf("<a>")).toBeLessThan(text.indexOf("<b>"));
	});

	test("leaves the payload untouched when nothing resolves", () => {
		const payload = { messages: [{ role: "user", content: "hi" }] };
		appendTrailingMessage(payload, context, "subrouter");
		expect(payload.messages).toHaveLength(1);
	});

	test("leaves an unknown payload shape untouched", () => {
		registerEnvMessage({ id: "clock", content: "12:00" });
		const payload = { somethingElse: [] as unknown[] };
		expect(appendTrailingMessage(payload, context, "subrouter")).toBe(payload);
		expect(payload.somethingElse).toHaveLength(0);
	});

	test("is idempotent per payload, so repeated requests each get their own copy", () => {
		registerEnvMessage({ id: "clock", content: "12:00" });
		const first = { messages: [] as Array<{ role: string; content: unknown }> };
		const second = { messages: [] as Array<{ role: string; content: unknown }> };
		appendTrailingMessage(first, context, "subrouter");
		appendTrailingMessage(second, context, "subrouter");
		expect(first.messages).toHaveLength(1);
		expect(second.messages).toHaveLength(1);
	});
});

describe("envelope rendering", () => {
	test("separates 'not a user turn' from 'contents are authoritative'", () => {
		const text = renderTrailingMessage([{ id: "clock", content: "12:00" }]);
		// Must not read as the user's request...
		expect(text).toContain("not a user message");
		// ...and must not tell the model to discard the contents. An earlier preamble said "not a new
		// instruction / use this only as reference", and models correctly refused to follow items
		// whose whole purpose was to carry one.
		expect(text).toContain("authoritative");
		expect(text).toContain("follow any");
	});

	test("never instructs the model to ignore the contents", () => {
		// A deny-list of the specific failure mode, not one literal string: the bug was semantic, so
		// any future reword that reintroduces "treat this as non-authoritative" must fail here.
		const text = renderTrailingMessage([{ id: "clock", content: "12:00" }]).toLowerCase();
		const forbidden = [
			"not a new instruction",
			"only as reference",
			"for reference only",
			"do not follow",
			"don't follow",
			"ignore any instruction",
			"ignore the instruction",
			"ignore this",
			"non-authoritative",
			"not authoritative",
		];
		for (const phrase of forbidden) expect(text).not.toContain(phrase);
	});

	test("nests each contribution in its own tag, preserving the given order", () => {
		// Ordering is collectMessages' job; the renderer only formats what it is handed.
		const text = renderTrailingMessage([
			{ id: "alpha", content: "a" },
			{ id: "zeta", content: "z" },
		]);
		expect(text).toContain("<alpha>a</alpha>");
		expect(text).toContain("<zeta>z</zeta>");
		expect(text.indexOf("<alpha>")).toBeLessThan(text.indexOf("<zeta>"));
	});

	test("collectMessages supplies the ordering the renderer preserves", () => {
		registerEnvMessage({ id: "zeta", content: "z" });
		registerEnvMessage({ id: "alpha", content: "a" });
		registerEnvMessage({ id: "early", priority: -5, content: "e" });
		const text = renderTrailingMessage(collectMessages(context));
		expect(text.indexOf("<early>")).toBeLessThan(text.indexOf("<alpha>"));
		expect(text.indexOf("<alpha>")).toBeLessThan(text.indexOf("<zeta>"));
	});

	test("normalizes ids that are not valid tag names", () => {
		expect(tagNameFor("my-extension/mode")).toBe("my-extension-mode");
		expect(tagNameFor("9lead")).toBe("item-9lead");
		expect(tagNameFor("a  b__c")).toBe("a-b__c");
		expect(tagNameFor("///")).toBe("item-unnamed");
		const text = renderTrailingMessage([{ id: "my-extension/mode", content: "plan" }]);
		expect(text).toContain("<my-extension-mode>plan</my-extension-mode>");
	});

	test("escapes contribution text so markup cannot break out of the envelope", () => {
		const text = renderTrailingMessage([{ id: "x", content: "<script>alert(1)</script>" }]);
		expect(text).not.toContain("<script>");
		expect(text).toContain("&lt;script&gt;");
	});

	test("collapses newlines so a value stays inside its tag on one line", () => {
		const text = renderTrailingMessage([{ id: "x", content: "line one\nline two" }]);
		expect(text).toContain("<x>line one line two</x>");
	});

	test("renders nothing for no contributions", () => {
		expect(renderTrailingMessage([])).toBe("");
	});
});
