import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeStateStore } from "../src/runtime-state-store.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeState(content: unknown): Promise<void> {
	await writeFile(
		path.join(fixture.agentDir, "pi-profile-state.json"),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

describe("RuntimeStateStore (global scope)", () => {
	it("reads the saved active profile from the global state file", async () => {
		await writeState({ activeProfile: "review" });

		const store = new RuntimeStateStore(fixture.agentDir);
		const state = await store.read();

		expect(state.activeProfile).toBe("review");
	});

	it("returns an empty state when no state file exists", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);

		expect(await store.read()).toEqual({});
	});

	it("returns an empty state on malformed content rather than failing the launch", async () => {
		await writeState("{ not json");

		const store = new RuntimeStateStore(fixture.agentDir);

		expect(await store.read()).toEqual({});
	});

	it("ignores non-string activeProfile values", async () => {
		await writeState({ activeProfile: 42 });

		const store = new RuntimeStateStore(fixture.agentDir);

		expect((await store.read()).activeProfile).toBeUndefined();
	});

	it("writes the state, replacing the file", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({ activeProfile: "impl" });

		expect(await store.read()).toEqual({ activeProfile: "impl" });
	});

	it("creates the state directory when writing (project .pi may be fresh)", async () => {
		const freshDir = path.join(fixture.root, "new-project", ".pi");
		const store = new RuntimeStateStore(freshDir);

		await store.write({ activeProfile: "impl" });

		expect(await store.read()).toEqual({ activeProfile: "impl" });
	});

	it("round-trips the runtime overlay", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({
			activeProfile: "review",
			overlay: { disabledSkills: ["noisy-skill"], disabledTools: ["bash"] },
		});

		expect((await store.read()).overlay).toEqual({ disabledSkills: ["noisy-skill"], disabledTools: ["bash"] });
	});

	it("ignores a stale `tools` key in the stored overlay instead of failing the parse", async () => {
		await writeState({
			activeProfile: "review",
			overlay: { disabledSkills: ["noisy-skill"], tools: ["read"] },
		});

		const store = new RuntimeStateStore(fixture.agentDir);

		expect((await store.read()).overlay).toEqual({ disabledSkills: ["noisy-skill"] });
	});

	it("update merges patches and deletes undefined fields without clobbering others", async () => {
		const store = new RuntimeStateStore(fixture.agentDir);
		await store.write({
			activeProfile: "review",
			overlay: { disabledSkills: ["noisy-skill"] },
		});

		const next = await store.update({ activeProfile: "impl", overlay: undefined });

		expect(next).toEqual({ activeProfile: "impl" });
		expect(await store.read()).toEqual({ activeProfile: "impl" });
	});
});
