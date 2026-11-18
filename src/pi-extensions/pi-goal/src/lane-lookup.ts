// lane-lookup.ts — FT-89: who is asking, read from the fleet's own records.
//
// The authorization rule needs two facts about the caller: which lane it is, and
// whether that lane is a leader. Both exist on disk — the pil session records name
// the lane and its workspace, and the lane's role record carries PI_MODE. Reading
// them here keeps the rule pure and its adapter testable against a fixture directory
// instead of the live fleet.
//
// A claim in the request only *selects* which record to check. It never decides the
// answer: an unknown session id resolves to null and the rule refuses.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LaneRecord {
  lane: string;
  sessionId: string;
  workspaceId: string | null;
}

export interface LaneLookup {
  /** The record whose session id matches, or null when no record claims it. */
  bySessionId(sessionId: string): LaneRecord | null;
  /** The lane's PI_MODE ("leader", "worker"), or null when its record is absent or says nothing. */
  modeOf(lane: string): string | null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The live adapter: the pil session and role records.
 *
 * Every failure is an absence rather than an exception: a malformed record, a
 * missing directory or an unreadable file leaves the caller unresolved, which the
 * rule refuses. A lookup that threw would turn "I cannot tell" into a crashed
 * receiver, and a caller cannot distinguish that from a hung worker.
 */
export function createLaneLookup(baseDir: string): LaneLookup {
  let cache: LaneRecord[] | null = null;
  const records = (): LaneRecord[] => {
    if (cache) return cache;
    const found: LaneRecord[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(join(baseDir, "sessions"));
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = readJson(join(baseDir, "sessions", entry));
      if (!record) continue;
      const lane = text(record.lane);
      const sessionId = text(record.sessionId);
      if (!lane || !sessionId) continue;
      found.push({ lane, sessionId, workspaceId: text(record.workspaceId) });
    }
    cache = found;
    return found;
  };

  return {
    bySessionId(sessionId) {
      return records().find((record) => record.sessionId === sessionId) ?? null;
    },
    modeOf(lane) {
      try {
        const env = readFileSync(join(baseDir, "roles", lane + ".env"), "utf8");
        const match = /(?:^|\s)PI_MODE=([^\s]+)/.exec(env);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    },
  };
}
