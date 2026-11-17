/** Read the launcher's role records.
 *
 * \`pil\` writes one file per lane at \`~/.local/state/pil/roles/<lane>.env\`,
 * containing whitespace-separated KEY=VALUE tokens. The launcher is the only
 * writer, and the record is the one place a lane's role and parent are stated
 * as facts rather than inferred from a name. This reader never evaluates the
 * file: it parses whitelisted keys with a safe-value regex, the same posture as
 * \`pil\`'s own \`restore_role\`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RoleRecord {
  lane: string;
  mode: string | null;
  profile: string | null;
  confirmProject: string | null;
  /** PI_SPAWNED_BY — the lane that created this one, when the spawner passed it. */
  spawnedBy: string | null;
  file: string;
}

const SAFE = /^[A-Za-z0-9_-]+$/;

export function defaultRolesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIL_ROLES_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pil", "roles");
}

export function parseRoleFile(lane: string, file: string, text: string): RoleRecord {
  const record: RoleRecord = { lane, mode: null, profile: null, confirmProject: null, spawnedBy: null, file };
  for (const token of text.split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!SAFE.test(value)) continue;
    switch (key) {
      case "PI_MODE":
        record.mode = value;
        break;
      case "PI_PROFILE":
        record.profile = value;
        break;
      case "PI_MODE_CONFIRM_PROJECT":
        record.confirmProject = value;
        break;
      case "PI_SPAWNED_BY":
        record.spawnedBy = value;
        break;
      default:
        break;
    }
  }
  return record;
}

export function readRoleRecords(dir: string = defaultRolesDir()): Map<string, RoleRecord> {
  const out = new Map<string, RoleRecord>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".env")) continue;
    const lane = entry.slice(0, -4);
    const file = join(dir, entry);
    try {
      out.set(lane, parseRoleFile(lane, file, readFileSync(file, "utf8")));
    } catch {
      out.set(lane, { lane, mode: null, profile: null, confirmProject: null, spawnedBy: null, file });
    }
  }
  return out;
}
