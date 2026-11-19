// mode-snapshots.ts — FT-92: the composition a lane was approved under, kept so drift has
// somewhere to fall back to instead of the native prompt.
//
// Drift means the files moved; it does not mean the approved instructions are gone. The state
// records a digest (`fingerprints`), which proves identity but cannot reconstruct text — so a
// reuse policy needs the definition bytes themselves.
//
// Location and privacy: the snapshot lives in a local sidecar next to the modes
// (`<agentDir>/modes/.snapshots`, 0600), NOT in the session file. The session keeps digests only;
// prompt text must not widen what a session record holds.
//
// Self-verifying: a snapshot is only usable when its recomposed fingerprint equals the digest it
// is filed under. A stale, edited or hand-copied snapshot is ignored, never silently used — the
// whole point is to run what was approved, and the digest is the only proof of what that was.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MODE_SCHEMA_VERSION,
  modeDefinitionFingerprint,
  type ModeScope,
  type PromptStrategy,
  type ResolvedMode,
} from "./mode-definitions.ts";

const MODE_SCOPES: readonly ModeScope[] = ["builtin", "global", "project"];
const PROMPT_STRATEGIES: readonly PromptStrategy[] = [
  "append",
  "replace_base",
  "replace_final",
  "replace",
];

function asPromptStrategy(value: unknown): PromptStrategy | null {
  return typeof value === "string" && (PROMPT_STRATEGIES as readonly string[]).includes(value)
    ? (value as PromptStrategy)
    : null;
}

function asScope(value: unknown): ModeScope | null {
  return typeof value === "string" && (MODE_SCOPES as readonly string[]).includes(value)
    ? (value as ModeScope)
    : null;
}

/** The fields the fingerprint covers. Anything outside this set is not part of identity. */
export interface SnapshotDefinition {
  schemaVersion?: number;
  key: string;
  label?: string;
  description?: string;
  promptStrategy?: string;
  systemPrompt?: string;
  requires?: string[];
  conflictsWith?: string[];
  before?: string[];
  after?: string[];
}

export interface ModeSnapshot {
  key: string;
  scope: ModeScope;
  path: string | null;
  digest: string;
  /** When this composition was first seen clean — equal to approval only for a lane launched
   * after it was recorded, which is why it is not called an approval. */
  firstSeenAt: string;
  definition: SnapshotDefinition;
}

export function snapshotRoot(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".pi", "agent");
  return join(agentDir, "modes", ".snapshots");
}

export function snapshotPath(key: string, digest: string, env: NodeJS.ProcessEnv = process.env): string {
  const safeKey = key.replace(/[^a-z0-9._-]/gi, "_");
  return join(snapshotRoot(env), `${safeKey}@${digest.slice(0, 16)}.json`);
}

/**
 * The fingerprint covers more of a mode than a snapshot stores as optional, so the rebuild is
 * normalized to the fingerprint's own input type rather than cast. The normalization is safe
 * against a tampered file precisely because the digest is recomputed over the normalized object:
 * a file that is missing or mis-typing a field normalizes to a different digest than the recorded
 * one and is refused.
 */
function fingerprintInput(
  definition: SnapshotDefinition,
  scope: ModeScope,
  path: string | null | undefined,
): Parameters<typeof modeDefinitionFingerprint>[0] {
  return {
    schemaVersion: definition.schemaVersion === MODE_SCHEMA_VERSION ? MODE_SCHEMA_VERSION : 1,
    key: definition.key,
    label: definition.label ?? definition.key,
    description: definition.description,
    promptStrategy: asPromptStrategy(definition.promptStrategy) ?? "append",
    systemPrompt: definition.systemPrompt ?? "",
    requires: definition.requires ?? [],
    conflictsWith: definition.conflictsWith ?? [],
    before: definition.before ?? [],
    after: definition.after ?? [],
    scope,
    path: path ?? undefined,
  };
}

/** The definition fields of a resolved mode, as a snapshot stores them. */
export function definitionOf(mode: ResolvedMode): SnapshotDefinition {
  return {
    schemaVersion: mode.schemaVersion,
    key: mode.key,
    label: mode.label,
    description: mode.description,
    promptStrategy: mode.promptStrategy,
    systemPrompt: mode.systemPrompt,
    requires: mode.requires ?? [],
    conflictsWith: mode.conflictsWith ?? [],
    before: mode.before ?? [],
    after: mode.after ?? [],
  };
}

/**
 * Keep the composition a lane is running under a digest-named file. Idempotent: called on every
 * clean composition, it writes once and then only stats. A lane that has never composed cleanly
 * has no snapshot, and `reuse` falls back to blocking with that reason — never to a guess.
 */
export function ensureSnapshot(
  mode: ResolvedMode,
  firstSeenAt: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const definition = definitionOf(mode);
  const digest = modeDefinitionFingerprint(fingerprintInput(definition, mode.scope, mode.path)).digest;
  const path = snapshotPath(mode.key, digest, env);
  if (existsSync(path)) return path;
  try {
    mkdirSync(snapshotRoot(env), { recursive: true, mode: 0o700 });
    chmodSync(snapshotRoot(env), 0o700);
    const payload: ModeSnapshot = {
      key: mode.key,
      scope: mode.scope,
      path: mode.path ?? null,
      digest,
      firstSeenAt,
      definition,
    };
    writeFileSync(path, JSON.stringify(payload, null, 1) + "\n", { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/**
 * The approved definition for a key at a digest, or null.
 *
 * The digest is recomputed from the stored bytes and must equal both the requested digest and the
 * one recorded in the file. Anything else is an absence: a snapshot that does not prove itself is
 * not a fallback, it is a different prompt wearing the old name.
 */
export function readSnapshot(
  key: string,
  digest: string,
  env: NodeJS.ProcessEnv = process.env,
): ModeSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(snapshotPath(key, digest, env), "utf8")) as Partial<ModeSnapshot>;
    if (!raw || typeof raw !== "object") return null;
    if (raw.key !== key || typeof raw.digest !== "string") return null;
    if (raw.digest !== digest) return null;
    const definition = raw.definition;
    if (!definition || typeof definition !== "object") return null;
    if (definition.key !== key) return null;
    if (
      definition.promptStrategy !== undefined &&
      asPromptStrategy(definition.promptStrategy) === null
    ) {
      return null;
    }
    const scope = asScope(raw.scope);
    if (!scope) return null;
    if (raw.path !== null && raw.path !== undefined && typeof raw.path !== "string") return null;
    const storedPath = typeof raw.path === "string" ? raw.path : null;
    const recomputed = modeDefinitionFingerprint(fingerprintInput(definition, scope, storedPath)).digest;
    if (recomputed !== digest) return null;
    return {
      key,
      scope,
      path: storedPath,
      digest,
      firstSeenAt: typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : "unknown",
      definition,
    };
  } catch {
    return null;
  }
}
