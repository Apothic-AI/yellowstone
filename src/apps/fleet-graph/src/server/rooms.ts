/** Read-only reader for the pi-rooms store (gap G5 in the FT-74 report).
 *
 * pi-rooms keeps its state in plain files under \`~/.pi/agent/rooms\`:
 *
 *   registry/<name>.json        live agent presence
 *   inbox/<name>/*.json         queued direct messages
 *   inbox/<name>/read/*.json    delivered direct messages
 *   rooms/<room>/room.json      room metadata (members, creator)
 *   rooms/<room>/log.jsonl      append-only room history
 *
 * The extension has no CLI and no export, so this module reads the store
 * directly and treats the layout above as the contract it documents. It is
 * **read-only**: no file is created, moved or rewritten, and there is no send
 * path. Sending stays with \`rooms_dm\` in a live pi lane.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RoomsMessage } from "../shared/types.ts";

export interface RoomsIndex {
  base: string;
  available: boolean;
  error: string | null;
  names: string[];
  rooms: { name: string; members: string[]; createdAt: string | null }[];
}

export function defaultRoomsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.PI_ROOMS_DIR ?? "").trim();
  return explicit.length > 0 ? explicit : join(homedir(), ".pi", "agent", "rooms");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(path: string): string[] {
  try {
    return readdirSync(path)
      .filter((e) => e.endsWith(".json"))
      .map((e) => join(path, e))
      .sort();
  } catch {
    return [];
  }
}

export function readRoomsIndex(base: string = defaultRoomsDir()): RoomsIndex {
  const index: RoomsIndex = { base, available: false, error: null, names: [], rooms: [] };
  try {
    statSync(base);
  } catch {
    index.error = "no rooms store at " + base;
    return index;
  }
  index.available = true;
  const names: string[] = [];
  for (const file of listFiles(join(base, "registry"))) {
    const reg = readJson<{ name?: string }>(file);
    if (reg?.name) names.push(reg.name);
    else names.push(file.split("/").pop()!.replace(/\.json$/, ""));
  }
  const pins = readJson<{ pins?: Record<string, { name?: string }> }>(join(base, "names.json"));
  for (const pin of Object.values(pins?.pins ?? {})) {
    if (pin?.name && !names.includes(pin.name)) names.push(pin.name);
  }
  index.names = names.sort();
  for (const roomDir of listDirs(join(base, "rooms"))) {
    const meta = readJson<{ name?: string; members?: string[]; createdAt?: string }>(
      join(base, "rooms", roomDir, "room.json")
    );
    if (!meta) continue;
    index.rooms.push({
      name: meta.name ?? roomDir,
      members: Array.isArray(meta.members) ? meta.members : [],
      createdAt: meta.createdAt ?? null
    });
  }
  return index;
}

interface Delivery {
  id?: string;
  from?: string;
  to?: string[];
  text?: string;
  sentAt?: string;
  queuedAt?: string;
  deliveredAt?: string;
  room?: string;
  roomSeq?: number;
}

interface RoomPost {
  id?: string;
  from?: string;
  text?: string;
  sentAt?: string;
  recipients?: string[];
  kind?: string;
}

function deliveriesIn(inboxDir: string): Delivery[] {
  const out: Delivery[] = [];
  const collect = (dir: string) => {
    for (const file of listFiles(dir)) {
      const d = readJson<Delivery>(file);
      if (d && typeof d.text === "string" && typeof d.from === "string") out.push(d);
    }
  };
  collect(inboxDir);
  collect(join(inboxDir, "read"));
  return out;
}

function asMessages(
  deliveries: Delivery[],
  lane: string,
  operator: string,
  seen: Set<string>
): RoomsMessage[] {
  const out: RoomsMessage[] = [];
  for (const d of deliveries) {
    const to = Array.isArray(d.to) ? d.to : [];
    const involvesLane = d.from === lane || to.includes(lane);
    if (!involvesLane) continue;
    const counterpart = d.from === lane ? to : [d.from];
    // The modal is the operator <-> lane thread. Other traffic is deliberately
    // not pulled into it; a UI that mixed every fleet DM into one thread would
    // be inventing a conversation nobody had.
    if (!counterpart.includes(operator)) continue;
    const id = d.id ?? [d.from, d.sentAt, d.text?.slice(0, 24)].join(":");
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      from: d.from!,
      to,
      text: d.text!,
      sentAt: d.sentAt ?? d.queuedAt ?? "",
      queuedAt: d.queuedAt,
      deliveredAt: d.deliveredAt,
      room: d.room,
      roomSeq: d.roomSeq,
      source: "dm"
    });
  }
  return out;
}

function roomMessages(
  base: string,
  lane: string,
  operator: string,
  rooms: { name: string; members: string[] }[],
  seen: Set<string>
): RoomsMessage[] {
  const out: RoomsMessage[] = [];
  for (const room of rooms) {
    if (!room.members.includes(lane)) continue;
    if (!room.members.includes(operator)) continue;
    const logPath = join(base, "rooms", room.name, "log.jsonl");
    let text: string;
    try {
      text = readFileSync(logPath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let post: RoomPost;
      try {
        post = JSON.parse(line) as RoomPost;
      } catch {
        continue;
      }
      if (!post.text || !post.from) continue;
      if (post.kind === "event") continue;
      if (post.from !== lane && post.from !== operator) continue;
      const id = post.id ?? [room.name, post.sentAt, post.text.slice(0, 24)].join(":");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        from: post.from,
        to: Array.isArray(post.recipients) ? post.recipients : [],
        text: post.text,
        sentAt: post.sentAt ?? "",
        room: room.name,
        roomSeq: undefined,
        source: "room"
      });
    }
  }
  return out;
}

export interface LaneMessages {
  available: boolean;
  error: string | null;
  identity: string | null;
  rooms: string[];
  messages: RoomsMessage[];
}

export function readLaneMessages(
  lane: string,
  opts: { base?: string; operator?: string; limit?: number } = {}
): LaneMessages {
  const base = opts.base ?? defaultRoomsDir();
  const operator = opts.operator ?? process.env.FLEET_GRAPH_OPERATOR ?? "operator";
  const index = readRoomsIndex(base);
  if (!index.available) {
    return { available: false, error: index.error, identity: null, rooms: [], messages: [] };
  }
  const seen = new Set<string>();
  const deliveries = [...deliveriesIn(join(base, "inbox", lane)), ...deliveriesIn(join(base, "inbox", operator))];
  const messages = [
    ...asMessages(deliveries, lane, operator, seen),
    ...roomMessages(base, lane, operator, index.rooms, seen)
  ]
    .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""))
    .slice(-(opts.limit ?? 500));
  const pins = readJson<{ pins?: Record<string, { name?: string }> }>(join(base, "names.json"));
  const identity = Object.entries(pins?.pins ?? {}).find(([, p]) => p?.name === lane)?.[0] ?? null;
  const rooms = index.rooms.filter((r) => r.members.includes(lane)).map((r) => r.name);
  return { available: true, error: null, identity, rooms, messages };
}
