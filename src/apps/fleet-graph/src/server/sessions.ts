/** Derived bead-to-lane attribution (the expensive half of gap G2).
 *
 * The authoritative join is \`assignee\`: a lane that ran
 * \`bd assign <id> <lane-name>\` says so in the tracker. Only a handful of beads
 * have that today. This module supplies the honest fallback the investigation
 * called G2': scan the tail of each lane's recorded session for a bash command
 * that names a bead, and attribute it to that lane — always marked \`derived\`
 * in the UI, never merged into \`assignee\`.
 *
 * The scan is bounded: only the last \`tailBytes\` of each session (default 1.5 MB)
 * and only lines that mention \`bd \`. A session file is append-only JSONL, so the
 * tail is where recent claims are.
 */

import { open, stat } from "node:fs/promises";
import type { LaneRecord } from "../shared/types.ts";

const CANDIDATE = /[A-Za-z0-9][A-Za-z0-9._-]{1,60}/g;

export function beadMentionsInText(text: string, beadIds: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("bd ");
    if (at < 0) continue;
    const slice = line.slice(at, at + 4000);
    CANDIDATE.lastIndex = 0;
    for (const match of slice.matchAll(CANDIDATE)) {
      const token = match[0];
      if (!beadIds.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

async function readTail(path: string, bytes: number): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    const length = Math.min(info.size, bytes);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export interface DerivedJoin {
  /** lane name -> bead id -> mention count */
  byLane: Map<string, Map<string, number>>;
  scanned: number;
  skipped: number;
}

export async function scanLaneSessions(
  lanes: LaneRecord[],
  beadIds: Set<string>,
  opts: { tailBytes?: number; concurrency?: number; now?: number } = {}
): Promise<DerivedJoin> {
  const tailBytes = opts.tailBytes ?? 1_500_000;
  const concurrency = opts.concurrency ?? 8;
  const now = opts.now ?? Date.now();
  const byLane = new Map<string, Map<string, number>>();
  let scanned = 0;
  let skipped = 0;
  const queue = lanes.filter((lane) => Boolean(lane.session_path));

  const worker = async (lane: LaneRecord): Promise<void> => {
    const path = lane.session_path!;
    const text = await readTail(path, tailBytes);
    if (!text) {
      skipped += 1;
      return;
    }
    scanned += 1;
    const mentions = beadMentionsInText(text, beadIds);
    if (mentions.size > 0) byLane.set(lane.name, mentions);
  };

  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      await worker(queue[index]);
    }
  });
  await Promise.all(runners);
  return { byLane, scanned, skipped };
}

export function latestMentionLane(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
