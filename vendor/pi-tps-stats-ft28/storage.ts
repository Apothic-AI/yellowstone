import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config, type Measurement } from "./metrics.ts";

export function statsDirectory(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "tps-stats");
}
export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stats config");
  const config = { ...DEFAULT_CONFIG, ...value };
  if ((config.mode !== "period" && config.mode !== "latest") ||
      !Number.isInteger(config.periodSeconds) || config.periodSeconds < 1 || config.periodSeconds > 86400 ||
      typeof config.logging !== "boolean") throw new Error("Invalid stats config");
  return { mode: config.mode, periodSeconds: config.periodSeconds, logging: config.logging };
}
export async function loadConfig(directory: string): Promise<Config> {
  try { return validateConfig(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw error;
  }
}
export async function saveConfig(directory: string, config: Config): Promise<void> {
  const safe = validateConfig(config);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, "config.json"));
  } finally { await rm(temporary, { force: true }); }
}
export function logFile(directory: string, sessionId: string): string {
  // Pi uses UUIDs; allow other safe opaque IDs without rewriting/colliding them.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) throw new Error("Unsafe session ID");
  return join(directory, "logs", `${sessionId}.jsonl`);
}
export async function appendMeasurement(directory: string, sessionId: string, sample: Measurement): Promise<void> {
  const file = logFile(directory, sessionId);
  // Explicit allowlist: never serialize an event, message, config, or provider object.
  const record = {
    timestamp: new Date(sample.endedAtMs).toISOString(),
    sessionId,
    outputTokens: sample.outputTokens,
    durationMs: sample.durationMs,
    tps: sample.tps,
    ttftMs: sample.ttftMs,
  };
  await mkdir(join(directory, "logs"), { recursive: true, mode: 0o700 });
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); }
  finally { await handle.close(); }
}
