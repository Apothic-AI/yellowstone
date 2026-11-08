import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	readPersistSettings,
	readSettingsFromDisk,
	SETTINGS_KEY,
	setPersistEnabled,
} from "../src/settings.ts";

describe("readPersistSettings", () => {
	test("defaults when the namespace is absent", () => {
		expect(readPersistSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(readPersistSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	test("ignores malformed blocks instead of throwing", () => {
		expect(readPersistSettings({ [SETTINGS_KEY]: null })).toEqual(DEFAULT_SETTINGS);
		expect(readPersistSettings({ [SETTINGS_KEY]: [] })).toEqual(DEFAULT_SETTINGS);
		expect(readPersistSettings({ [SETTINGS_KEY]: "off" })).toEqual(DEFAULT_SETTINGS);
	});

	test("ignores unknown keys", () => {
		expect(readPersistSettings({ [SETTINGS_KEY]: { future: true } })).toEqual(DEFAULT_SETTINGS);
	});

	test("reads the switch", () => {
		expect(readPersistSettings({ [SETTINGS_KEY]: { enabled: false } })).toEqual({ enabled: false });
		expect(readPersistSettings({ [SETTINGS_KEY]: { enabled: true } })).toEqual({ enabled: true });
	});

	test("ignores a switch that is not a boolean", () => {
		expect(readPersistSettings({ [SETTINGS_KEY]: { enabled: "off" } })).toEqual(DEFAULT_SETTINGS);
		expect(readPersistSettings({ [SETTINGS_KEY]: { enabled: 0 } })).toEqual(DEFAULT_SETTINGS);
		expect(readPersistSettings({ [SETTINGS_KEY]: { enabled: null } })).toEqual(DEFAULT_SETTINGS);
	});

	test("leaves unrelated settings untouched", () => {
		const settings = { theme: "neon-noir", [SETTINGS_KEY]: { anything: 1 } };
		readPersistSettings(settings);
		expect(settings.theme).toBe("neon-noir");
	});
});

describe("readSettingsFromDisk", () => {
	// A temp dir, not a path under test/, so nothing can be committed by accident.
	afterEach(() => {});

	function freshDir(): string {
		return mkdtempSync(join(tmpdir(), "pi-persist-settings-"));
	}

	test("falls back to defaults when settings.json is missing", () => {
		expect(readSettingsFromDisk(join(tmpdir(), "pi-persist-missing-dir"))).toEqual(DEFAULT_SETTINGS);
	});

	test("falls back to defaults when the file is malformed", () => {
		const target = freshDir();
		writeFileSync(join(target, "settings.json"), "{ not json");
		expect(readSettingsFromDisk(target)).toEqual(DEFAULT_SETTINGS);
	});

	test("reads a real settings file without inventing keys", () => {
		const target = freshDir();
		writeFileSync(join(target, "settings.json"), JSON.stringify({ theme: "x", [SETTINGS_KEY]: {} }));
		expect(readSettingsFromDisk(target)).toEqual(DEFAULT_SETTINGS);
	});

	test("reads the switch from disk", () => {
		const target = freshDir();
		writeFileSync(join(target, "settings.json"), JSON.stringify({ [SETTINGS_KEY]: { enabled: false } }));
		expect(readSettingsFromDisk(target)).toEqual({ enabled: false });
	});
});

describe("setPersistEnabled", () => {
	function freshDir(): string {
		return mkdtempSync(join(tmpdir(), "pi-persist-settings-"));
	}

	test("writes the switch into pi's settings file", async () => {
		const target = freshDir();
		await setPersistEnabled(false, target);
		const written = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
		expect(written).toEqual({ [SETTINGS_KEY]: { enabled: false } });
	});

	test("keeps the settings it does not own", async () => {
		const target = freshDir();
		writeFileSync(join(target, "settings.json"), JSON.stringify({ theme: "neon-noir", [SETTINGS_KEY]: { future: 1 } }));
		await setPersistEnabled(false, target);
		const written = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
		expect(written.theme).toBe("neon-noir");
		expect(written[SETTINGS_KEY]).toEqual({ future: 1, enabled: false });
	});

	test("leaves a malformed settings file alone", async () => {
		const target = freshDir();
		const path = join(target, "settings.json");
		writeFileSync(path, "{ not json");
		// Replacing the file would drop every other setting the operator has.
		await expect(setPersistEnabled(false, target)).rejects.toThrow(/not valid JSON/);
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});

	test("leaves no lock behind", async () => {
		const target = freshDir();
		await setPersistEnabled(true, target);
		expect(existsSync(join(target, "settings.json.lock"))).toBe(false);
	});
});
