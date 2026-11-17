/**
 * FT-04 — collapsible pi-rooms messages in the transcript.
 *
 * Every delivered message is one `pi_rooms_message` custom message. Before this
 * module, pi drew each of them with its default custom-message renderer: a
 * generic `◇ Pi Rooms Message` title and the whole body — the routing header,
 * the reply hints and the text — as a full block. An agent-to-agent conversation
 * therefore filled the transcript with blocks that repeated tool-call syntax the
 * operator rarely needs, and every block was expanded whether or not the body
 * was interesting.
 *
 * Registering a message renderer is what makes a block collapsible: pi wraps the
 * returned component and dispatches clicks into it. Collapsed (the default) the
 * block is a title naming the sender and the destination, a one-line preview of
 * the body, and a click hint; expanded it adds the reply hints and the whole
 * body, wrapped to the terminal width. The title is the FT-04 request: it names
 * *who* sent the message and *where* it was posted instead of saying "Pi Rooms
 * Message".
 *
 * The state a block is added in comes from the operator's setting
 * `collapse-rooms-messages` (default true) in `<base>/message-view.json`.
 * Presentation lives in its own file so a collapse toggle can never rewrite
 * `config.json`, whose `maxSendsPerSession` is a structural cap.
 *
 * A click toggles one message, session-local and never persisted: a message is
 * a discrete unit, unlike a monitor's stream (FT-03), where one click had to
 * cover every block of that monitor to be useful.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ─── Preference file ─────────────────────────────────────────────────────

/** Presentation preferences only — never delivery policy. */
export const MESSAGE_VIEW_CONFIG_FILENAME = "message-view.json";
/** The key the operator's item names by shape: the FT-03 setting is
 *  `collapse-monitor-events`, so this one is its pi-rooms counterpart. */
export const COLLAPSE_ROOMS_MESSAGES_KEY = "collapse-rooms-messages";
/** New blocks are collapsed unless the operator opted out. */
export const DEFAULT_COLLAPSE_ROOMS_MESSAGES = true;
/** The custom type the delivery path emits and this module renders. One
 *  constant, so producer and renderer cannot drift apart. */
export const ROOMS_MESSAGE_CUSTOM_TYPE = "pi_rooms_message";

export interface RoomsMessageViewConfig {
  collapse: boolean;
}

/** `<base>/message-view.json`, next to the config it deliberately does not share. */
export function messageViewConfigPath(base: string): string {
  return join(base, MESSAGE_VIEW_CONFIG_FILENAME);
}

function readRecord(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Tolerant read: a missing, unreadable or malformed file degrades to the
 * default, never an error. Only an explicit boolean opts out — a stray string
 * or number cannot turn the transcript back into a wall of expanded blocks.
 */
export function readRoomsMessageViewConfig(base: string): RoomsMessageViewConfig {
  const value = readRecord(messageViewConfigPath(base))[COLLAPSE_ROOMS_MESSAGES_KEY];
  return {
    collapse: typeof value === "boolean" ? value : DEFAULT_COLLAPSE_ROOMS_MESSAGES,
  };
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write on one queue, so concurrent writers cannot clobber each
 * other or the file's other keys. A presentation file is small and written
 * rarely (only when the setting is flipped), so serialising is cheap.
 */
export function writeRoomsMessageViewConfig(
  base: string,
  patch: Partial<RoomsMessageViewConfig>
): Promise<void> {
  const path = messageViewConfigPath(base);
  const filePatch: Record<string, boolean> = {};
  if (patch.collapse !== undefined) filePatch[COLLAPSE_ROOMS_MESSAGES_KEY] = patch.collapse;
  const write = writeQueue.then(async () => {
    await writeFile(path, `${JSON.stringify({ ...readRecord(path), ...filePatch }, null, 2)}\n`);
  });
  writeQueue = write.catch(() => {});
  return write;
}

/** Resolves once every queued write has settled; a flip right before exit
 *  drains through this. */
export function flushRoomsMessageViewWrites(): Promise<void> {
  return writeQueue.then(() => {});
}

// ─── Session presentation state ──────────────────────────────────────────

export interface RoomsMessagePresentation {
  /** The setting in force for blocks rendered from now on. */
  collapse: boolean;
  /** Click decisions, keyed by message id. Deliberately session-local: the
   *  operator asked for a setting, not a memory of the last click. */
  overrides: Map<string, boolean>;
}

export function createRoomsMessagePresentation(
  config: RoomsMessageViewConfig
): RoomsMessagePresentation {
  return { collapse: config.collapse, overrides: new Map() };
}

/**
 * Whether one message renders collapsed. `globallyExpanded` is pi's Ctrl+O
 * "expand everything" state; while it is on it wins, so a block cannot hide
 * from the global expansion.
 */
export function roomsMessageCollapsed(
  presentation: RoomsMessagePresentation,
  key: string,
  globallyExpanded = false
): boolean {
  if (globallyExpanded) return false;
  const override = key ? presentation.overrides.get(key) : undefined;
  return override ?? presentation.collapse;
}

/** Record one block's click decision (session-local). */
export function setRoomsMessageCollapsed(
  presentation: RoomsMessagePresentation,
  key: string,
  collapsed: boolean
): void {
  if (!key) return;
  presentation.overrides.set(key, collapsed);
}

// ─── Message parsing ─────────────────────────────────────────────────────

/** The `details` payload the delivery path attaches to every message. */
export interface RoomsMessageDetails {
  id?: string;
  from?: string;
  room?: string;
  roomSeq?: number;
  replyTo?: string;
  text?: string;
}

export interface RoomsMessageInput {
  content: unknown;
  details?: unknown;
}

export interface ParsedRoomsMessage {
  /** Stable identity for this block: the message id, or a content-derived
   *  fallback for messages recorded before `details` carried one. */
  key: string;
  from: string;
  /** Room name, or null for a direct message. */
  room: string | null;
  /** 1-based position in the room log, when posted into a room. */
  seq: number | null;
  /** The `[stale · queued …]` marker, when the message arrived old. */
  stale: string | null;
  /** The `id … · reply: …` routing text, shown only when expanded. */
  hints: string;
  /** The message body, split into lines. */
  body: string[];
  replyTo: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/**
 * Escape sequences are stripped, not rendered: a message body may carry ANSI
 * copied out of a terminal or another program, and a transcript block must not
 * let it recolour the rest of the screen. The stored content keeps the raw text,
 * so nothing the model reads changes — this only affects what is drawn.
 */
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\^_`a-z{|}~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

/** Split the persisted content into its routing header and its body. The
 *  delivery path writes `[stale …]\n[dm|room …] …\n\n<body>`. */
function splitContent(content: string): { head: string[]; body: string } {
  const split = content.indexOf("\n\n");
  if (split < 0) return { head: content.split("\n"), body: "" };
  return {
    head: content.slice(0, split).split("\n"),
    body: content.slice(split + 2),
  };
}

/**
 * Split a message into what the block needs.
 *
 * `details` is authoritative — it carries the sender, room and full body — and
 * the persisted content is the fallback, so a message recorded before this
 * change (or by a version that did not attach details) still renders rather
 * than disappearing behind an empty block.
 */
export function parseRoomsMessage(message: RoomsMessageInput): ParsedRoomsMessage {
  const details = (
    message.details && typeof message.details === "object" ? message.details : {}
  ) as RoomsMessageDetails;
  const content = stripAnsi(textOf(message.content));
  const { head, body: contentBody } = splitContent(content);
  const headLines = head.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim().length > 0);
  const staleLine = headLines.find((line) => line.startsWith("[stale")) ?? null;
  const headerLine = headLines.find((line) => line !== staleLine) ?? "";

  // The routing text starts at "id "; before it sits the legacy `[dm] name` /
  // `[room name #seq] name` prefix this module's title replaces.
  const hintIndex = headerLine.indexOf(" · id ");
  const hints = hintIndex >= 0 ? headerLine.slice(hintIndex + 3) : "";

  const dm = /^\[dm\]\s+(\S+)/.exec(headerLine);
  const room = /^\[room\s+([^\]\s#]+)(?:\s+#(\d+))?\]\s+(\S+)/.exec(headerLine);

  const from = (
    typeof details.from === "string" && details.from.trim().length > 0
      ? details.from
      : dm?.[1] ?? room?.[3] ?? "unknown"
  ).trim();
  const roomName =
    typeof details.room === "string" && details.room.trim().length > 0
      ? details.room.trim()
      : room?.[1] ?? null;
  const seq =
    typeof details.roomSeq === "number" && Number.isFinite(details.roomSeq)
      ? details.roomSeq
      : room?.[2] != null
        ? Number(room[2])
        : null;

  const id =
    typeof details.id === "string" && details.id.length > 0
      ? details.id
      : (/(?:^|·)\s*id\s+([0-9a-z-]{4,})/i.exec(hints)?.[1] ?? "");

  const bodySource = typeof details.text === "string" ? details.text : contentBody;
  const bodyLines = stripAnsi(bodySource).replace(/\r$/, "").split("\n");
  while (bodyLines.length > 0 && bodyLines[0].trim().length === 0) bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim().length === 0) bodyLines.pop();

  const replyTo = typeof details.replyTo === "string" ? details.replyTo : "";
  const key = id || `${from}|${roomName ?? "dm"}|${bodyLines[0] ?? ""}`;
  return { key, from, room: roomName, seq, stale: staleLine, hints, body: bodyLines, replyTo };
}

// ─── Rendering ───────────────────────────────────────────────────────────

export interface RoomsMessageTheme {
  fg(colour: string, text: string): string;
}

/** Visible columns. Input is already ANSI-stripped by {@link stripAnsi}. */
export function visibleWidth(text: string): number {
  return [...text].length;
}

/**
 * Fit one line into `width` columns, ending an over-long line with `…`.
 * Counting code points rather than East-Asian display width can overflow a row
 * by up to 2× for CJK text; room names and paths are ASCII, which is exact.
 */
export function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length <= width) return text;
  return `${chars.slice(0, Math.max(1, width - 1)).join("")}…`;
}

/** Wrap one line into `width` columns. Hard wrapping (not word wrapping): a
 *  message may be a path or a command, and losing its tail is worse than
 *  breaking mid-token. */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const chars = [...text];
  if (chars.length <= width) return [text];
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += width) {
    out.push(chars.slice(index, index + width).join(""));
  }
  return out;
}

export interface RenderRoomsMessageArgs {
  parsed: ParsedRoomsMessage;
  collapsed: boolean;
  width: number;
  theme: RoomsMessageTheme;
}

/**
 * The block's lines. Collapsed is a title plus a one-line preview; expanded is
 * the title, the stale marker and reply hints when present, then every body
 * line wrapped to the width.
 */
export function renderRoomsMessageLines(args: RenderRoomsMessageArgs): string[] {
  const { parsed, collapsed, width, theme } = args;
  if (width <= 0) return [];

  const marker = collapsed ? "▸" : "▾";
  const where = parsed.room != null
    ? `#${parsed.room}${parsed.seq != null ? ` #${parsed.seq}` : ""}`
    : "DM";
  const reply = parsed.replyTo ? ` · ↩ ${parsed.replyTo.slice(0, 8)}` : "";
  const count = parsed.body.length > 1 ? ` · ${parsed.body.length} lines` : "";
  const hint = collapsed ? "click to expand" : "click to collapse";
  // FT-04's title request: who sent it and where it was posted, not
  // "Pi Rooms Message".
  const header = `${marker} Rooms · ${where} from ${parsed.from}${reply}${count} · ${hint}`;
  const out = [theme.fg("customMessageLabel", fitLine(header, width))];

  if (collapsed) {
    const preview = parsed.body.find((line) => line.trim().length > 0);
    if (preview) out.push(theme.fg("dim", fitLine(`  ${preview}`, width)));
    return out;
  }

  if (parsed.stale) out.push(theme.fg("dim", fitLine(`  ${parsed.stale}`, width)));
  // Wrapped, not fitted: the reply-all call carries the message id, and an
  // expanded block must not hide the line an operator is trying to copy.
  for (const part of parsed.hints ? wrapLine(parsed.hints, Math.max(1, width - 2)) : []) {
    out.push(theme.fg("dim", `  ${part}`));
  }
  for (const line of parsed.body) {
    for (const part of wrapLine(line, Math.max(1, width - 2))) out.push(`  ${part}`);
  }
  return out;
}

/** The component pi wraps for a `pi_rooms_message` message. */
export interface RoomsMessageComponent {
  render(width: number): string[];
  handleMouse?(event: { type: string; button: string }): { handled: boolean } | undefined;
  invalidate(): void;
}

/**
 * Build the renderer's component for one message. State is read from
 * `presentation` on every render, so a click only has to record the decision;
 * pi's next frame (a handled mouse event requests one) draws it.
 */
export function renderRoomsMessageBlock(
  presentation: RoomsMessagePresentation,
  message: RoomsMessageInput,
  options: { expanded: boolean },
  theme: RoomsMessageTheme
): RoomsMessageComponent {
  const parsed = parseRoomsMessage(message);
  const collapsedNow = (): boolean =>
    roomsMessageCollapsed(presentation, parsed.key, options.expanded);
  return {
    render: (width: number) =>
      renderRoomsMessageLines({
        parsed,
        collapsed: collapsedNow(),
        width,
        theme,
      }),
    handleMouse: (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      // Toggle what is on screen. Session-local, per message.
      setRoomsMessageCollapsed(presentation, parsed.key, !collapsedNow());
      return { handled: true };
    },
    invalidate: () => {},
  };
}

/** Register the renderer. The presentation is the session object the command
 *  mutates, so a flip in one place shows up in the other. */
export function registerRoomsMessageRenderer(
  pi: ExtensionAPI,
  presentation: RoomsMessagePresentation
): void {
  pi.registerMessageRenderer(ROOMS_MESSAGE_CUSTOM_TYPE, (message, options, theme) =>
    renderRoomsMessageBlock(presentation, message as RoomsMessageInput, options, theme)
  );
}

/**
 * `/toggle-collapse-rooms-messages [collapse|expand|toggle]`.
 *
 * The write is awaited before the notification, so the operator is told what was
 * persisted rather than what was attempted. A failed write is reported as a
 * warning instead of being swallowed.
 */
export function registerRoomsMessageViewCommand(
  pi: ExtensionAPI,
  presentation: RoomsMessagePresentation,
  base: string
): void {
  pi.registerCommand("toggle-collapse-rooms-messages", {
    description:
      "Collapse or expand pi-rooms message blocks in the transcript: /toggle-collapse-rooms-messages [collapse|expand|toggle]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const verb = args.trim().toLowerCase();
      if (verb && verb !== "collapse" && verb !== "expand" && verb !== "toggle") {
        ctx.ui.notify(
          `Unknown value "${verb}". Use \`/toggle-collapse-rooms-messages [collapse|expand|toggle]\`.`,
          "warning"
        );
        return;
      }
      const collapsed =
        verb === "collapse" ? true : verb === "expand" ? false : !presentation.collapse;
      presentation.collapse = collapsed;
      // A click decision for one message outranks the setting. Flipping the
      // setting is a deliberate global choice, so it discards those decisions
      // and is in force for every message from here on.
      presentation.overrides.clear();
      try {
        await writeRoomsMessageViewConfig(base, { collapse: collapsed });
      } catch (error) {
        ctx.ui.notify(
          `Rooms message blocks set to ${collapsed ? "collapsed" : "expanded"} for this session, ` +
            `but ${messageViewConfigPath(base)} could not be written: ${(error as Error).message}`,
          "warning"
        );
        return;
      }
      ctx.ui.notify(
        `Rooms message blocks will start ${collapsed ? "collapsed" : "expanded"}.`,
        "info"
      );
    },
  });
}
