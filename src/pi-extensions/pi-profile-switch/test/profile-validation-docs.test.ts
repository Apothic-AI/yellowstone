import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ADR = "docs/adr/0018-tolerant-activation-with-restrictive-partial-resolution.md";
const MARKER = "**Superseded by ADR-0018.**\n\n";
// SHA-256 of the complete upstream historical bodies at 7e154aa, before top markers.
const HISTORY = [
	["docs/adr/0009-reference-resolution-failure-tiering.md", "71d6a5e6328e99dc6f7e70694c35a4d41409f82b0105eb457e8c18c91b15628e"],
	["docs/adr/0016-drop-pi-mcp-adapter.md", "ba7b5d01761b61c13a721a45ff2f84cdae553828cde1517db76cd46e096f4ebe"],
] as const;
const CURRENT_DOCS = ["README.md", "README.zh-CN.md", "skills/profile-config/SKILL.md", "docs/architecture/overview.md", ADR];
const read = (file: string) => readFile(path.resolve(file), "utf8");

function anchor(name: string): string {
	return `requirement-${name.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/\s+/g, "-")}`;
}

async function checkContractLink(file: string, domain: string, requirement: string): Promise<void> {
	const owner = `openspec/specs/${domain}/spec.md`;
	const relative = path.relative(path.dirname(file), owner).split(path.sep).join("/");
	const fragment = anchor(requirement);
	expect(await read(file), `${file}: missing owning contract`).toContain(`](${relative}#${fragment})`);
	const main = await read(owner);
	// Parent syncs approved deltas after this documentation slice. Added
	// requirement anchors may be present only in that delta until then.
	const delta = `openspec/changes/relax-profile-startup-validation/specs/${domain}/spec.md`;
	const approved = existsSync(delta) ? await read(delta) : "";
	expect(`${main}\n${approved}`, `${owner}: anchor lacks a main or approved-delta owner`).toContain(`### Requirement: ${requirement}`);
}

// The native value inventories this suite guards against restating. These are
// CONTRACT values, recorded deliberately rather than re-derived from Pi's source
// on every run.
//
// Deriving them from source made this a coupling defect: the test pinned the
// SHAPE of another package's internals, so any upstream refactor read as "the
// authority moved" and failed five documentation assertions for a reason that
// had nothing to do with the documentation. Pi 1.6.2 moved the `mcpServers`
// shape into `@earendil-works/pi-mcp` — `dist/core/mcp-servers.js` now only says
// so in its header and imports the validator — and the old derivation then found
// zero transports and threw.
//
// Provenance, from Pi's own documentation at 1.6.2:
//   docs/mcp.md:78  "When present, `type` must be `stdio`, `http`, or
//                   `streamable-http`."
//   docs/mcp.md:79  "`sse` is rejected."
//   dist/cli/args.js  VALID_THINKING_LEVELS
// When Pi's supported values change, update the list HERE: a deliberate,
// reviewable edit in our repository instead of a silent dependency on someone
// else's file layout.
const NATIVE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// `sse` is rejected by Pi, so it is not part of the inventory to guard against.
const NATIVE_MCP_TRANSPORTS = ["stdio", "http", "streamable-http"];

async function assertReferenceOnlyNativeValues(file: string): Promise<void> {
	const text = await read(file);
	expect(
		NATIVE_THINKING_LEVELS.every((level) => new RegExp(`\\b${level}\\b`).test(text)),
		`${file}: copied native thinking inventory`,
	).toBe(false);
	expect(
		NATIVE_MCP_TRANSPORTS.every((transport) => new RegExp(`(?:["\x60]|\\b)${transport}(?:["\x60]|\\b)`).test(text)),
		`${file}: copied native transport inventory`,
	).toBe(false);
}

describe("profile validation documentation", () => {
	it.each(HISTORY)("prepends only the supersession marker to historical %s", async (file, hash) => {
		const bytes = await readFile(path.resolve(file));
		expect(bytes.subarray(0, Buffer.byteLength(MARKER)).toString()).toBe(MARKER);
		expect(createHash("sha256").update(bytes.subarray(Buffer.byteLength(MARKER))).digest("hex")).toBe(hash);
	});

	it("limits ADR-0016 supersession to transport and retains its other decisions by reference", async () => {
		const text = await read(ADR);
		expect(text).toContain("only Decision 4 (launcher-side transport rejection) of ADR-0016");
		expect(text).toContain("ADR-0016 Decisions 1–3 remain in effect");
		expect(text).toContain("](0016-drop-pi-mcp-adapter.md)");
		expect(text).toContain("](0009-reference-resolution-failure-tiering.md)");
		expect(text).toContain("## Rejected alternatives");
		await checkContractLink(ADR, "resource-reference", "Unified failure tiering for references");
		await checkContractLink(ADR, "launcher", "Native model declaration handoff");
	});

	it.each(["skills/profile-config/SKILL.md"])("links %s authoring guidance to authoritative contracts", async (file) => {
		await checkContractLink(file, "profile-catalog", "Catalog file format validation");
		await checkContractLink(file, "profile-catalog", "Profile definition fields");
		await checkContractLink(file, "resource-reference", "Unified failure tiering for references");
		await checkContractLink(file, "launcher", "Native model declaration handoff");
		await checkContractLink(file, "in-session-switch", "Observability surface");
		const relativeSchema = path.relative(path.dirname(file), "schemas/profiles.schema.json").split(path.sep).join("/");
		expect(await read(file)).toContain(`](${relativeSchema})`);
	});

	it.each([
		["README.md", ["Activation continues with warnings", "Pi handles model availability", "Unknown top-level field"]],
		["README.zh-CN.md", ["激活继续，报告警告", "模型是否可用、认证", "未知顶层字段"]],
	])("%s provides actionable configuration diagnostics without requiring internal links", async (file, phrases) => {
		const text = await read(file);
		expect(text).toContain("](schemas/profiles.schema.json)");
		expect(text).toContain("/profile reload");
		expect(text).toContain("/profile status");
		for (const phrase of phrases) expect(text).toContain(phrase);
	});

	it("updates architecture ownership, launch ordering and diagnostic transport without the retired module", async () => {
		const text = await read("docs/architecture/overview.md");
		expect(text).not.toMatch(/model-check\.ts|checkDeclaredModel|model check|declared model authenticated/);
		expect(existsSync("src/launcher/model-check.ts")).toBe(false);
		expect(text).toContain("ProfileCatalog.load");
		expect(text).toContain("resolve(name)");
		expect(text).toContain("LaunchPlanFile.diagnostics");
		expect(text).toContain("mergeResolutionDiagnostics");
		expect(text).toContain("](../adr/0018-tolerant-activation-with-restrictive-partial-resolution.md)");
		const launch = text.split("### Launch\n")[1]?.split("### In-session switching")[0] ?? "";
		expect(launch.indexOf("readTrustInputs")).toBeGreaterThan(-1);
		expect(launch.indexOf("ProfileCatalog.load")).toBeGreaterThan(launch.indexOf("readTrustInputs"));
		await checkContractLink("docs/architecture/overview.md", "launcher", "Native model declaration handoff");
	});

	it.each(CURRENT_DOCS)("does not copy native value inventories into %s", assertReferenceOnlyNativeValues);

	it("keeps the recorded native transport contract in step with the installed Pi docs", async () => {
		// Advisory, and pointed at DOCUMENTATION rather than at source shape: docs are
		// the public contract, whereas the previous source regex broke the moment Pi
		// moved a file. An absent docs file is not a failure — the recorded contract
		// above is the authority; this only surfaces drift early.
		const doc = path.resolve("node_modules/@earendil-works/pi-coding-agent/docs/mcp.md");
		if (!existsSync(doc)) return;
		const text = await read(doc);
		for (const transport of NATIVE_MCP_TRANSPORTS) expect(text, `Pi docs no longer mention ${transport}`).toContain(transport);
	});

	it("documents the composed definition as mechanism, without restating the contract tables", async () => {
		const overview = await read("docs/architecture/overview.md");
		expect(overview).toContain("profile-composition.ts");
		expect(overview).toMatch(/composed with its same-named global definition/);
		expect(overview).toMatch(/still reports the project source/i);
		expect(overview).toContain("](../adr/0022-project-profile-append-composition.md)");
		// Mechanism only: the requirement tables and their diagnostic codes live in
		// the spec deltas, not in the architecture overview.
		expect(overview).not.toMatch(/append-unapplied-reference|append-cannot-narrow|append-standalone/);

		const glossary = await read("CONTEXT.md");
		expect(glossary).toContain("**Composed definition**");
		expect(glossary).toMatch(/composition never adds a fourth source/);
	});

	it.each([
		["README.md", "a composed (`append`) profile does not either"],
		["README.zh-CN.md", "声明 `append` 的组合式 profile 同样不会"],
	])("%s keeps the project-scope limitation unchanged for composed profiles", async (file, phrase) => {
		expect(await read(file)).toContain(phrase);
	});

	it("removes obsolete activation-failure editing guidance from current usage docs", async () => {
		for (const file of ["README.md", "skills/profile-config/SKILL.md"]) {
			const text = await read(file);
			expect(text).not.toMatch(/(?:SSE servers|Servers using `type: "sse"`).*cannot be selected|malformed source fail activation|project-only fails activation/);
		}
		expect(await read("skills/profile-config/SKILL.md")).toContain("Fatal shapes");
		expect(await read("skills/profile-config/SKILL.md")).toContain("Reference warnings");
		expect(await read("skills/profile-config/SKILL.md")).toContain("Native model handoff");
	});
});
