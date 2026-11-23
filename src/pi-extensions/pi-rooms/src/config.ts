/**
 * pi-rooms — configuration.
 *
 * Read from `<base>/config.json`. Every field is optional; a missing or
 * malformed file yields the defaults below rather than failing the session,
 * because a broken config must not take an agent's messaging offline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "./store.ts";

export type DeliveryMode = "steer" | "followUp";

export interface RoomsConfig {
  /** Join the registry automatically on session start. */
  autoJoin: boolean;
  /**
   * Outbound messages one session may send before the tool refuses.
   *
   * `null` — the default — means unbounded: no cap is applied unless the
   * operator sets one. When set, the cap is structural rather than advice, so
   * two agents cannot volley past it and widening it is a deliberate config
   * edit. Set it per fleet, not per agent.
   */
  maxSendsPerSession: number | null;
  /**
   * Longest message stored and delivered, in characters.
   *
   * `null` — the default — disables truncation: the whole message is kept.
   * A positive integer truncates at that many characters with the existing
   * marker. `0` and `-1` both mean disabled, as does any value that is not a
   * positive integer, so an existing config file keeps its current behaviour
   * and a broken one cannot silently start cutting messages.
   */
  maxMessageChars: number | null;
  /** How a direct message interrupts the receiver. */
  dmDelivery: DeliveryMode;
  /** How a room post interrupts the receiver. */
  roomDelivery: DeliveryMode;
  /**
   * Most messages handed to the session in one flush.
   *
   * A backlog is delivered in bounded batches so a long absence cannot inject N
   * transcripts (and N turns) into one moment. The remainder stays queued, in
   * arrival order, for the next tick.
   */
  maxDeliverPerFlush: number;
  /**
   * Messages older than this are rendered with an explicit age prefix, so a
   * catch-up cannot masquerade as fresh conversation.
   */
  staleAfterMs: number;
  /** Inbox fallback poll interval, for filesystems where watch is unreliable. */
  pollMs: number;
}

export const DEFAULTS: RoomsConfig = {
  autoJoin: true,
  maxSendsPerSession: null,
  maxMessageChars: null,
  dmDelivery: "steer",
  roomDelivery: "followUp",
  pollMs: 2000,
  maxDeliverPerFlush: 5,
  staleAfterMs: 900_000,
};

export function configPath(paths: Paths): string {
  return path.join(paths.base, "config.json");
}

export function loadConfig(paths: Paths): RoomsConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(paths), "utf8");
  } catch {
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULTS };
  const input = parsed as Record<string, unknown>;
  const delivery = (value: unknown, fallback: DeliveryMode): DeliveryMode =>
    value === "steer" || value === "followUp" ? value : fallback;
  const number = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  // Both settings are off unless an explicit positive number turns them on, and
  // the mapping is deliberately the same for each: for the send cap that means
  // unbounded, for the truncation threshold it means "store the whole message".
  // `0` and `-1` are the documented ways to spell "disabled", so they fall into
  // the same branch as missing, negative and non-numeric values.
  const positiveOrNull = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    // A fraction that floors to 0 is not a usable threshold: for the send cap it
    // would read as "refuse every send", and for truncation as "disabled". Both
    // are surprises, so an unusable value falls back to the documented default.
    const whole = Math.floor(value);
    return whole > 0 ? whole : null;
  };
  return {
    autoJoin: input.autoJoin === false ? false : DEFAULTS.autoJoin,
    maxSendsPerSession: positiveOrNull(input.maxSendsPerSession),
    maxMessageChars: positiveOrNull(input.maxMessageChars),
    dmDelivery: delivery(input.dmDelivery, DEFAULTS.dmDelivery),
    roomDelivery: delivery(input.roomDelivery, DEFAULTS.roomDelivery),
    pollMs: number(input.pollMs, DEFAULTS.pollMs),
    maxDeliverPerFlush: number(input.maxDeliverPerFlush, DEFAULTS.maxDeliverPerFlush),
    staleAfterMs: number(input.staleAfterMs, DEFAULTS.staleAfterMs),
  };
}
