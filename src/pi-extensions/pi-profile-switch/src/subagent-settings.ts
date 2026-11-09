import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type NativeThinking = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export interface SubagentRoleOverride {
	model?: string | false;
	thinking?: NativeThinking | false;
	description?: string;
	advertise?: boolean;
}

export interface ProfileSubagentSettings {
	defaultModel?: string;
	defaultThinking?: NativeThinking;
	agentOverrides?: Record<string, SubagentRoleOverride>;
}

export class SubagentSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentSettingsError";
	}
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly NativeThinking[];
const DEFAULT_FIELDS = ["defaultModel", "defaultThinking", "agentOverrides"] as const;
const ROLE_FIELDS = ["model", "thinking", "description", "advertise"] as const;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineOwn<T>(target: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function hasGlob(value: string): boolean {
	return /[*?\[\]{}]/.test(value);
}

function fail(context: { profile: string; filePath?: string }, field: string, expected: string): never {
	const file = context.filePath ? `${context.filePath}: ` : "";
	throw new SubagentSettingsError(
		`${file}profile "${context.profile}": "subagents.${field}" ${expected}`,
	);
}

function readText(value: unknown, context: { profile: string; filePath?: string }, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		fail(context, field, "must be a nonempty string (whitespace is trimmed)");
	}
	return value.trim();
}

function readThinking(value: unknown, context: { profile: string; filePath?: string }, field: string): NativeThinking {
	if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
		fail(context, field, `must be a Pi thinking level; supported values: ${THINKING_LEVELS.join(", ")}`);
	}
	return value as NativeThinking;
}

/** Parses and normalizes only the bounded profile declaration; it performs no discovery or IO. */
export function parseSubagentSettings(
	value: unknown,
	context: { profile: string; filePath?: string },
): ProfileSubagentSettings | undefined {
	if (value === undefined) return undefined;
	if (!record(value)) fail(context, "", "must be an object");
	const defaults: ProfileSubagentSettings = {};
	for (const key of Object.keys(value)) {
		if (!(DEFAULT_FIELDS as readonly string[]).includes(key)) {
			fail(context, key, `is unsupported; supported fields: ${DEFAULT_FIELDS.join(", ")}`);
		}
	}
	if (Object.hasOwn(value, "defaultModel")) defaults.defaultModel = readText(value.defaultModel, context, "defaultModel");
	if (Object.hasOwn(value, "defaultThinking")) defaults.defaultThinking = readThinking(value.defaultThinking, context, "defaultThinking");
	if (Object.hasOwn(value, "agentOverrides")) {
		const overrides = value.agentOverrides;
		if (!record(overrides)) fail(context, "agentOverrides", "must be an object keyed by exact agent names");
		const parsed: Record<string, SubagentRoleOverride> = {};
		for (const name of Object.keys(overrides)) {
			if (name.trim() === "" || name.trim() !== name || /[\r\n\u2028\u2029]/.test(name) || hasGlob(name)) {
				fail(context, `agentOverrides.${name}`, "must use an exact agent name without surrounding whitespace, line terminators, or glob patterns");
			}
			const rawRole = overrides[name];
			if (!record(rawRole)) fail(context, `agentOverrides.${name}`, "must be an object");
			const role: SubagentRoleOverride = {};
			for (const field of Object.keys(rawRole)) {
				if (!(ROLE_FIELDS as readonly string[]).includes(field)) {
					fail(context, `agentOverrides.${name}.${field}`, `is unsupported; supported fields: ${ROLE_FIELDS.join(", ")}`);
				}
			}
			if (Object.hasOwn(rawRole, "model")) {
				const model = rawRole.model;
				if (model === false) role.model = false;
				else role.model = readText(model, context, `agentOverrides.${name}.model`);
			}
			if (Object.hasOwn(rawRole, "thinking")) {
				const thinking = rawRole.thinking;
				if (thinking === false) role.thinking = false;
				else role.thinking = readThinking(thinking, context, `agentOverrides.${name}.thinking`);
			}
			if (Object.hasOwn(rawRole, "description")) role.description = readText(rawRole.description, context, `agentOverrides.${name}.description`);
			if (Object.hasOwn(rawRole, "advertise")) {
				if (typeof rawRole.advertise !== "boolean") fail(context, `agentOverrides.${name}.advertise`, "must be a boolean");
				role.advertise = rawRole.advertise;
			}
			if (Object.keys(role).length > 0) defineOwn(parsed, name, role);
		}
		if (Object.keys(parsed).length > 0) defaults.agentOverrides = parsed;
	}
	return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function nativeRecord(
	value: unknown,
	settingsPath: string,
	fieldPath: string,
): Record<string, unknown> {
	if (!record(value)) {
		throw new SubagentSettingsError(
			`${settingsPath}: native settings "${fieldPath}" must be an object to apply profile subagent overrides; correct the settings shape and retry`,
		);
	}
	return value;
}

/** Applies only declared fields to touched native settings containers, without mutating inputs. */
export function applySubagentSettings(
	settings: Readonly<Record<string, unknown>>,
	declaration: ProfileSubagentSettings | undefined,
	context: { profile: string; settingsPath: string },
): Record<string, unknown> {
	const result = { ...settings };
	if (
		declaration === undefined ||
		(declaration.defaultModel === undefined && declaration.defaultThinking === undefined &&
			(declaration.agentOverrides === undefined || Object.keys(declaration.agentOverrides).every(
				(name) => Object.keys(declaration.agentOverrides![name] ?? {}).length === 0,
			)))
	) return result;
	const existingSubagents = Object.hasOwn(settings, "subagents") ? settings.subagents : undefined;
	const subagents = existingSubagents === undefined
		? {}
		: { ...nativeRecord(existingSubagents, context.settingsPath, "subagents") };
	if (declaration.defaultModel !== undefined) defineOwn(subagents, "defaultModel", declaration.defaultModel);
	if (declaration.defaultThinking !== undefined) defineOwn(subagents, "defaultThinking", declaration.defaultThinking);
	if (declaration.agentOverrides !== undefined) {
		const existingOverrides = Object.hasOwn(subagents, "agentOverrides") ? subagents.agentOverrides : undefined;
		const overrides = existingOverrides === undefined
			? {}
			: { ...nativeRecord(existingOverrides, context.settingsPath, "subagents.agentOverrides") };
		for (const name of Object.keys(declaration.agentOverrides)) {
			const existingRole = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
			const role = existingRole === undefined
				? {}
				: { ...nativeRecord(existingRole, context.settingsPath, `subagents.agentOverrides.${name}`) };
			for (const field of ROLE_FIELDS) {
				if (Object.hasOwn(declaration.agentOverrides[name]!, field)) {
					defineOwn(role, field, declaration.agentOverrides[name]![field] as unknown);
				}
			}
			defineOwn(overrides, name, role);
		}
		defineOwn(subagents, "agentOverrides", overrides);
	}
	defineOwn(result, "subagents", subagents);
	return result;
}
