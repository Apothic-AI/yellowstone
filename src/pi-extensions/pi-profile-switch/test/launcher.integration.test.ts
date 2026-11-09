import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LAUNCHER_BIN as BIN,
	launcherEnv,
	runLauncher,
} from "./helpers/launcher-runner.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";
import { RpcDriver } from "./helpers/rpc-driver.ts";
let fixture: PiFixture;
beforeEach(async () => {
	fixture = await createPiFixture();
	await addGlobalSkill(fixture, "alpha-skill");
	await addGlobalSkill(fixture, "beta-skill");
	await addGlobalExtension(fixture, "fixture-ext-cmd");
});
afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});
describe("launcher integration: real pi subprocess, default profile", () => {
	it(
		"starts the default profile exposing all fixture resources, and leaves the real agent dir untouched",
		{ timeout: 45_000 },
		async () => {
			const userSettings = { customKey: "keep-me" };
			await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(userSettings));
			const agentDirBefore = await listFiles(fixture.agentDir);
			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				const commands = await rpc.commandNames();
				const names = commands.map((command) => command.name);
				expect(names).toContain("skill:alpha-skill");
				expect(names).toContain("skill:beta-skill");
				// The fixture extension's command proves its code loaded.
				expect(commands.some((command) => command.name === "fixture-ext-cmd" && command.source === "extension")).toBe(
					true,
				);
			} finally {
				await rpc.close();
			}
			// User's real settings are never rewritten.
			expect(JSON.parse(await readFile(path.join(fixture.agentDir, "settings.json"), "utf8"))).toEqual(userSettings);
			// New files in the real agent dir stay inside pi-profile-owned runtime
			// dirs, Pi's own session storage, the state paths pi-profile seeds
			// so that Pi writes them there instead of into the instance
			// (ADR-0010), and the profile-config skill the launcher distributes on
			// startup (spec: Distributing the profile-config skill) — nothing else appears.
			const agentDirAfter = await listFiles(fixture.agentDir);
			const created = agentDirAfter.filter((file) => !agentDirBefore.includes(file));
			for (const file of created) {
				const relative = path.relative(fixture.agentDir, file);
				expect(
					["sessions", "missions", "auth.json", "models-store.json", `skills${path.sep}profile-config`].some(
						(seed) => relative === seed || relative.startsWith(`${seed}${path.sep}`),
					),
				).toBe(true);
			}
			// If session files were created, verify they are placed inside project subdirectories,
			// never directly under sessions/
			const sessionFiles = await listFiles(path.join(fixture.agentDir, "sessions"));
			for (const file of sessionFiles) {
				const rel = path.relative(path.join(fixture.agentDir, "sessions"), file);
				expect(rel.includes(path.sep)).toBe(true);
			}
			// Launcher selection is transient: no runtime state file anywhere.
			const files = await listFiles(fixture.root);
			expect(files.filter((file) => file.endsWith("pi-profile-state.json"))).toEqual([]);
		},
	);
	it(
		"forwards arbitrary pi flags verbatim (pi itself reports the unknown flag)",
		{ timeout: 45_000 },
		async () => {
			// pi prints its own "Unknown option" error and then continues into
			// interactive mode; with stdin at EOF it exits. The point here: the
			// flag reaches pi — pi-profile never rejects it with a whitelist error.
			const output = await runLauncher(fixture, ["--", "--definitely-not-a-pi-flag"]);
			const text = `${output.stdout}\n${output.stderr}`;
			expect(text).toContain("Unknown option: --definitely-not-a-pi-flag");
			expect(text).not.toContain("unsupported pi argument");
		},
	);
	it(
		"rejects an unknown profile name before spawning pi",
		{ timeout: 30_000 },
		async () => {
			const failure = await runLauncher(fixture, ["review", "--", "--mode", "rpc"]);
			expect(failure.code).toBe(2);
			expect(failure.stderr).toContain("unknown profile: review");
		},
	);
});
describe("launcher integration: instance dir cleanup", () => {
	function instancesRoot(): string {
		return path.join(fixture.profileSwitchDir, "instances");
	}
	async function instanceDirNames(): Promise<string[]> {
		try {
			return (await readdir(instancesRoot())).filter((entry) => entry.startsWith("launch-")).sort();
		} catch {
			return [];
		}
	}
	/** Spawns a child that exits immediately and returns its (now dead) pid. */
	async function deadPid(): Promise<number> {
		const child = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => child.on("exit", resolve));
		if (child.pid === undefined) throw new Error("child pid missing");
		return child.pid;
	}
	it(
		"sweeps a pre-seeded stale instance dir (dead pid) at startup",
		{ timeout: 45_000 },
		async () => {
			const stale = path.join(instancesRoot(), "launch-staleTest");
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));
			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await rpc.commandNames();
				expect(existsSync(stale)).toBe(false);
				// Only this launch's own instance dir remains.
				const names = await instanceDirNames();
				expect(names).toHaveLength(1);
				expect(existsSync(path.join(instancesRoot(), names[0]!, "settings.json"))).toBe(true);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
	it(
		"converges across launches: the previous dir is reclaimed or explicitly reported, never silently dropped",
		{ timeout: 90_000 },
		async () => {
			const first = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await first.commandNames();
			} finally {
				await first.close();
				await first.waitForExit();
			}
			const before = await instanceDirNames();
			expect(before).toHaveLength(1);
			const previousName = before[0]!;
			const previousPath = path.join(instancesRoot(), previousName);
			// The launched process is gone; its pid may however have been recycled
			// by then (pid reuse keeps the dir one round longer by design), so pin
			// a known-dead pid to make the convergence assertion deterministic.
			await writeFile(path.join(previousPath, "pid"), String(await deadPid()));
			const second = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await second.commandNames();
				const afterSecond = await instanceDirNames();
				const stderr = second.stderr.join("");
				// This launch always gets its own dir, never a reused one.
				expect(afterSecond.filter((name) => !before.includes(name))).toHaveLength(1);
				// A previous dir is only kept when it holds state pi-profile did not
				// generate (a leftover lock dir, or state from another package). The
				// runtime state Pi resolves under the agent dir is seeded instead, so
				// the expected outcome is reclamation. Either way the outcome is
				// explicit: reclaimed, or reported on stderr.
				if (existsSync(previousPath)) {
					expect(stderr).toContain(`${previousPath} was not reclaimed`);
					expect(afterSecond).toHaveLength(2);
				} else {
					expect(stderr).not.toContain(previousPath);
					expect(afterSecond).toHaveLength(1);
				}
			} finally {
				await second.close();
				await second.waitForExit();
			}
		},
	);
	it(
		"keeps a stale dir whose unrecognized entry references the instance path, and warns",
		{ timeout: 45_000 },
		async () => {
			const stale = path.join(instancesRoot(), "launch-pathRef");
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));
			// A ledger-style record embedding its own instance path must survive
			// untouched (ADR-0010 protection, ADR-0012 scan gate).
			await writeFile(
				path.join(stale, "ledger.json"),
				JSON.stringify({ recordPath: path.join(stale, "ledger.json") }),
			);
			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await rpc.commandNames();
				expect(existsSync(stale)).toBe(true);
				expect(existsSync(path.join(stale, "ledger.json"))).toBe(true);
				expect(existsSync(path.join(fixture.agentDir, "ledger.json"))).toBe(false);
				const stderr = rpc.stderr.join("");
				expect(stderr).toContain(`${stale} was not reclaimed`);
				expect(stderr).toContain("ledger.json");
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
	it(
		"adopts an unrecognized entry with no path references into the real agent dir, then reclaims the dir",
		{ timeout: 45_000 },
		async () => {
			const stale = path.join(instancesRoot(), "launch-adopt");
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));
			await writeFile(path.join(stale, "mcp-cache.json"), JSON.stringify({ cache: "portable" }));
			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await rpc.commandNames();
				expect(existsSync(stale)).toBe(false);
				expect(JSON.parse(await readFile(path.join(fixture.agentDir, "mcp-cache.json"), "utf8"))).toEqual({
					cache: "portable",
				});
				const stderr = rpc.stderr.join("");
				expect(stderr).toContain("pi-profile: notice:");
				expect(stderr).toContain("adopted mcp-cache.json");
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
	it(
		"deletes the instance copy on a name conflict with the real agent dir (real wins), with a notice",
		{ timeout: 45_000 },
		async () => {
			await writeFile(path.join(fixture.agentDir, "custom-state.json"), JSON.stringify({ real: true }));
			const stale = path.join(instancesRoot(), "launch-conflict");
			await mkdir(stale, { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));
			await writeFile(path.join(stale, "custom-state.json"), JSON.stringify({ instance: true }));
			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await rpc.commandNames();
				expect(existsSync(stale)).toBe(false);
				// Real wins: the real agent dir's copy is untouched, no comparison.
				expect(JSON.parse(await readFile(path.join(fixture.agentDir, "custom-state.json"), "utf8"))).toEqual({
					real: true,
				});
				const stderr = rpc.stderr.join("");
				expect(stderr).toContain("pi-profile: notice:");
				expect(stderr).toContain("deleted custom-state.json");
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
	it(
		"only warns for unrecognized entries inside the managed extensions/ dir",
		{ timeout: 45_000 },
		async () => {
			const stale = path.join(instancesRoot(), "launch-extWarn");
			await mkdir(path.join(stale, "extensions", "some-ext"), { recursive: true });
			await writeFile(path.join(stale, "pid"), String(await deadPid()));
			await writeFile(path.join(stale, "extensions", "some-ext", "config.json"), "{}");
			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await rpc.commandNames();
				expect(existsSync(stale)).toBe(true);
				expect(existsSync(path.join(stale, "extensions", "some-ext", "config.json"))).toBe(true);
				expect(existsSync(path.join(fixture.agentDir, "extensions", "some-ext"))).toBe(false);
				const stderr = rpc.stderr.join("");
				expect(stderr).toContain(`${stale} was not reclaimed`);
				expect(stderr).toContain("some-ext");
				expect(stderr).not.toContain("pi-profile: notice:");
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
});
describe("launcher integration: starter assets ensure", () => {
	it(
		"seeds starter profile ask and makes it resolvable on first launch",
		{ timeout: 45_000 },
		async () => {
			const profilesDir = path.join(fixture.profileSwitchDir, "profiles");
			expect(existsSync(path.join(profilesDir, "ask.json"))).toBe(false);
			const rpc = new RpcDriver("node", [BIN, "ask", "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				const commands = await rpc.commandNames();
				expect(commands.length).toBeGreaterThan(0);
				expect(existsSync(path.join(profilesDir, "ask.json"))).toBe(true);
				expect(existsSync(path.join(fixture.agentDir, "skills", "profile-config", "SKILL.md"))).toBe(true);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}
		},
	);
});
describe("launcher integration: startup notifications", () => {
	it(
		"rpc mode writes the startup notice to stderr only and marks it shown for later launches",
		{ timeout: 45_000 },
		async () => {
			const ownVersion = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")).version as string;
			const newerTarget = "99.0.0";
			const dir = path.join(fixture.profileSwitchDir, "notifications");
			await mkdir(dir, { recursive: true });
			const fresh = Date.now();
			await writeFile(
				path.join(dir, "npm-latest.json"),
				JSON.stringify({ schemaVersion: 1, data: { latest: newerTarget }, lastSuccess: fresh, lastAttempt: fresh }),
			);
			await writeFile(path.join(dir, "displayed.json"), JSON.stringify({ schemaVersion: 1, keys: [] }));

			const rpc = new RpcDriver("node", [BIN, "--", "--mode", "rpc"], {
				cwd: fixture.cwd,
				env: launcherEnv(fixture),
			});
			try {
				await rpc.commandNames();
				// The notice arrives asynchronously after session_start; poll stderr.
				const deadline = Date.now() + 10_000;
				while (!rpc.stderr.join("").includes(newerTarget) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				const stderr = rpc.stderr.join("");
				expect(stderr).toContain(ownVersion);
				expect(stderr).toContain(newerTarget);
				// Structured stdout stays native: every line the driver parsed is
				// a valid JSON-RPC message and carries no notice text.
				expect(rpc.messages.length).toBeGreaterThan(0);
				expect(JSON.stringify(rpc.messages)).not.toContain(newerTarget);
			} finally {
				await rpc.close();
				await rpc.waitForExit();
			}

			// The displayed target is recorded in the shared global history.
			const history = JSON.parse(await readFile(path.join(dir, "displayed.json"), "utf8")) as { keys: string[] };
			expect(history.keys).toContain(`upgrade:${newerTarget}`);
		},
	);
});


describe("launcher integration: selected catalog validation", () => {
	async function profileFile(name: string, content: string): Promise<string> {
		const dir = path.join(fixture.profileSwitchDir, "profiles");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, `${name}.json`);
		await writeFile(file, content);
		return file;
	}

	it("spawns Pi for a valid profile despite unrelated corrupt and invalid definitions", { timeout: 45_000 }, async () => {
		await profileFile("review", '{"skills":["alpha-skill"]}');
		await profileFile("corrupt", "{ bad");
		await profileFile("invalid", '{"skills":1}');
		const output = await runLauncher(fixture, ["review", "--", "--version"]);
		expect(output.code).toBe(0);
		expect(output.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		expect(output.stderr).not.toContain("corrupt.json");
		expect(output.stderr).not.toContain("invalid.json");
	});

	it("spawns default despite corrupt entries and a reserved default file", { timeout: 45_000 }, async () => {
		await profileFile("corrupt", "{ bad");
		await profileFile("default", "{ bad");
		const output = await runLauncher(fixture, ["default", "--", "--version"]);
		expect(output.code).toBe(0);
		expect(output.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it.each(["{ bad", "[]", '{"skills":1}'])("rejects a selected illegal definition before Pi spawn: %s", { timeout: 30_000 }, async (content) => {
		const file = await profileFile("review", content);
		const output = await runLauncher(fixture, ["review", "--", "--version"]);
		expect(output.code).toBe(2);
		expect(output.stderr).toContain(file);
		expect(output.stdout).toBe("");
		expect(existsSync(path.join(fixture.profileSwitchDir, "instances"))).toBe(false);
	});

	it("does not fall back from a malformed saved existing profile", { timeout: 30_000 }, async () => {
		const file = await profileFile("review", "{ bad");
		await writeFile(path.join(fixture.agentDir, "pi-profile-state.json"), '{"activeProfile":"review"}');
		const output = await runLauncher(fixture, ["--", "--version"]);
		expect(output.code).toBe(2);
		expect(output.stderr).toContain(file);
		expect(output.stderr).not.toContain("starting the default profile");
		expect(output.stdout).toBe("");
	});

	it("warns on unknown keys without forwarding them as native settings", { timeout: 45_000 }, async () => {
		await profileFile("review", '{"skills":[],"defaultTools":["write"],"unknownNativeSetting":"ignored"}');
		const output = await runLauncher(fixture, ["review", "--", "--version"]);
		expect(output.code).toBe(0);
		expect(output.stderr).toContain('unknown field "defaultTools" ignored');
		expect(output.stderr).toContain('unknown field "unknownNativeSetting" ignored');
		expect(output.stdout).not.toContain("unknown field");
		const dirs = await readdir(path.join(fixture.profileSwitchDir, "instances"));
		expect(dirs).toHaveLength(1);
		const settings = JSON.parse(await readFile(path.join(fixture.profileSwitchDir, "instances", dirs[0]!, "settings.json"), "utf8"));
		expect(Object.hasOwn(settings, "defaultTools")).toBe(false);
		expect(Object.hasOwn(settings, "unknownNativeSetting")).toBe(false);
	});
});
