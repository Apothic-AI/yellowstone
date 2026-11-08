import { afterEach, describe, expect, test } from "bun:test";
import {
	acceptsContribution,
	type ContributionContext,
	clearContributions,
	collectContributions,
	getRegistry,
	REGISTRY_PROTOCOL,
	REGISTRY_SYMBOL,
	REGISTRY_VERSION,
	registerEnvContribution,
} from "../src/registry.ts";

const context: ContributionContext = {
	provider: "relayfast",
	activeTools: ["read", "bash"],
	cwd: "/home/u/project",
	mode: "tui",
};

afterEach(() => {
	clearContributions();
	delete (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL];
});

describe("registry lifecycle", () => {
	test("the registry is versioned and created on first use", () => {
		const registry = getRegistry();
		expect(registry?.protocol).toBe(REGISTRY_PROTOCOL);
		expect(registry?.version).toBe(REGISTRY_VERSION);
		expect(registry?.contributions.size).toBe(0);
	});

	test("a second instance adopts the registry instead of creating a private one", () => {
		// Two copies of a package can load in one session (npm cache plus a local path); both must
		// agree on the same Map or contributions silently disappear.
		const first = getRegistry();
		const second = (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL];
		expect(second).toBe(first);
		registerEnvContribution({ id: "a", content: "one" });
		expect(getRegistry()?.contributions.size).toBe(1);
	});

	test("declines to write into a foreign value squatting on the symbol", () => {
		(globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL] = { protocol: "other", version: 99 };
		expect(getRegistry()).toBeUndefined();
		expect(() => registerEnvContribution({ id: "x", content: "y" })).toThrow(/incompatible/);
	});

	test("rejects an empty id", () => {
		expect(() => registerEnvContribution({ id: "", content: "x" })).toThrow(/non-empty id/);
	});
});

describe("unregistration", () => {
	test("removes only its own entry", () => {
		const unregister = registerEnvContribution({ id: "shared", content: "first" });
		registerEnvContribution({ id: "shared", content: "second" });
		unregister();
		// The replacement must survive: unregistering a stale registration cannot delete the live one.
		expect(collectContributions(context).map((entry) => entry.content)).toEqual(["second"]);
	});

	test("is idempotent", () => {
		const unregister = registerEnvContribution({ id: "once", content: "x" });
		unregister();
		expect(() => unregister()).not.toThrow();
		expect(collectContributions(context)).toEqual([]);
	});
});

describe("filtering", () => {
	test("providers restricts to the listed ids and skips unknown providers", () => {
		const contribution = { id: "p", content: "x", providers: ["relayfast"] };
		expect(acceptsContribution(contribution, context)).toBe(true);
		expect(acceptsContribution(contribution, { ...context, provider: "openrouter" })).toBe(false);
		expect(acceptsContribution(contribution, { ...context, provider: undefined })).toBe(false);
	});

	test("activeTools requires every listed tool", () => {
		const contribution = { id: "t", content: "x", activeTools: ["read", "bash"] };
		expect(acceptsContribution(contribution, context)).toBe(true);
		expect(acceptsContribution(contribution, { ...context, activeTools: ["read"] })).toBe(false);
	});
});

describe("collectContributions", () => {
	test("orders by priority, then id, independent of registration order", () => {
		registerEnvContribution({ id: "b", priority: 5, content: "b5" });
		registerEnvContribution({ id: "a", priority: 5, content: "a5" });
		registerEnvContribution({ id: "z", priority: -1, content: "z-1" });
		expect(collectContributions(context).map((entry) => entry.id)).toEqual(["z", "a", "b"]);
	});

	test("drops whitespace-only results and accepts a function body", () => {
		registerEnvContribution({ id: "blank", content: "   \n " });
		registerEnvContribution({ id: "fn", content: (ctx) => `${ctx.mode}:${ctx.activeTools.length}` });
		expect(collectContributions(context)).toEqual([{ id: "fn", content: "tui:2" }]);
	});

	test("a throwing body is skipped instead of breaking the prompt", () => {
		registerEnvContribution({
			id: "bad",
			content: () => {
				throw new Error("boom");
			},
		});
		registerEnvContribution({ id: "good", content: "ok" });
		expect(collectContributions(context)).toEqual([{ id: "good", content: "ok" }]);
	});

	test("re-registering an id replaces the earlier contribution", () => {
		registerEnvContribution({ id: "same", content: "old" });
		registerEnvContribution({ id: "same", content: "new" });
		expect(collectContributions(context)).toEqual([{ id: "same", content: "new" }]);
	});

	test("returns empty when no registry exists", () => {
		expect(collectContributions(context, undefined)).toEqual([]);
	});
});
