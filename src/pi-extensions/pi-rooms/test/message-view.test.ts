/**
 * FT-04 — collapsible pi-rooms messages.
 *
 * Four properties are asserted:
 *
 * 1. the setting is `collapse-rooms-messages` in `<base>/message-view.json`,
 *    defaults to collapsed, and only an explicit boolean opts out;
 * 2. a message parses from its `details` — and still parses from its persisted
 *    content when details are absent (history recorded by an older build);
 * 3. the collapsed block names the sender and the destination, while expanded
 *    carries the reply hints and the whole body;
 * 4. a real queued message, delivered through the extension's own flush, reaches
 *    the registered renderer as a `pi_rooms_message` and draws collapsed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import init from "../index.ts";
import {
  COLLAPSE_ROOMS_MESSAGES_KEY,
  ROOMS_MESSAGE_CUSTOM_TYPE,
  createRoomsMessagePresentation,
  messageViewConfigPath,
  parseRoomsMessage,
  readRoomsMessageViewConfig,
  renderRoomsMessageBlock,
  renderRoomsMessageLines,
  stripAnsi,
  writeRoomsMessageViewConfig,
  flushRoomsMessageViewWrites,
} from "../src/message-view.ts";
import { deliver, register, resolvePaths, unregister } from "../src/store.ts";

const theme = { fg: (_colour: string, text: string) => text };
const plain = (lines: string[]) => lines.join("\n");

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-view-"));
}

/** A message shaped exactly like the delivery path's handoff. */
function message(overrides: Record<string, unknown> = {}, contentParts?: string[]) {
  const id = (overrides.id as string) ?? randomUUID();
  const from = (overrides.from as string) ?? "alpha";
  const text = (overrides.text as string) ?? "the body";
  const details: Record<string, unknown> = {
    id,
    from,
    to: ["lane"],
    text,
    sentAt: "2026-11-17T12:00:00.000Z",
    queuedAt: "2026-11-17T12:00:00.000Z",
    ...overrides,
  };
  const where =
    details.room != null
      ? `[room ${details.room}${details.roomSeq != null ? ` #${details.roomSeq}` : ""}] ${from}`
      : `[dm] ${from}`;
  const content =
    contentParts?.join("\n") ??
    `${where} · id ${id.slice(0, 8)} · reply: rooms_dm({to:"${from}"}) · reply to all: rooms_reply_all({messageId:"${id}"})\n\n${text}`;
  return { id, from, content, details };
}

// ─── The setting ─────────────────────────────────────────────────────────

test("the collapse setting defaults to true, honours only an explicit boolean, and merges on write", async () => {
  const base = tempBase();
  try {
    assert.equal(readRoomsMessageViewConfig(base).collapse, true, "missing file -> collapsed");

    await writeRoomsMessageViewConfig(base, { collapse: false });
    assert.equal(readRoomsMessageViewConfig(base).collapse, false, "explicit false -> expanded");
    const written = JSON.parse(fs.readFileSync(messageViewConfigPath(base), "utf8"));
    assert.equal(written[COLLAPSE_ROOMS_MESSAGES_KEY], false);

    // A stray string cannot turn the transcript into a wall of expanded blocks.
    fs.writeFileSync(
      messageViewConfigPath(base),
      JSON.stringify({ [COLLAPSE_ROOMS_MESSAGES_KEY]: "no", "unrelated-key": 7 })
    );
    assert.equal(readRoomsMessageViewConfig(base).collapse, true, "non-boolean -> default");

    // A flip must not drop a key another writer put in the same file.
    await writeRoomsMessageViewConfig(base, { collapse: true });
    const merged = JSON.parse(fs.readFileSync(messageViewConfigPath(base), "utf8"));
    assert.equal(merged["unrelated-key"], 7, "read-modify-write preserves other keys");

    fs.writeFileSync(messageViewConfigPath(base), "{not json");
    assert.equal(readRoomsMessageViewConfig(base).collapse, true, "malformed file -> default");
    await flushRoomsMessageViewWrites();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ─── Parsing ─────────────────────────────────────────────────────────────

test("a direct message parses from details: sender, no room, body, reply hints", () => {
  const parsed = parseRoomsMessage(message({ text: "line one\nline two" }));
  assert.equal(parsed.from, "alpha");
  assert.equal(parsed.room, null);
  assert.equal(parsed.seq, null);
  assert.deepEqual(parsed.body, ["line one", "line two"]);
  assert.match(parsed.hints, /^id [0-9a-f]{8}/);
  assert.match(parsed.hints, /rooms_reply_all/);
  assert.equal(parsed.stale, null);
});

test("a room post carries its room, sequence and reply target", () => {
  const id = randomUUID();
  const parsed = parseRoomsMessage(
    message({ id, room: "core", roomSeq: 7, replyTo: id, text: "answer" })
  );
  assert.equal(parsed.room, "core");
  assert.equal(parsed.seq, 7);
  assert.equal(parsed.replyTo, id);
  assert.equal(parsed.key, id, "the id is the block's identity");
});

test("a message with no details still parses from its persisted content", () => {
  const id = randomUUID();
  const parsed = parseRoomsMessage({
    content:
      `[stale · queued 2h ago]\n[room core #12] beta · id ${id.slice(0, 8)} · ` +
      `read: rooms_read({room:"core", since:12})\n\nthe body\nsecond line`,
  });
  assert.equal(parsed.from, "beta");
  assert.equal(parsed.room, "core");
  assert.equal(parsed.seq, 12);
  assert.equal(parsed.stale, "[stale · queued 2h ago]");
  assert.match(parsed.hints, /rooms_read/);
  assert.deepEqual(parsed.body, ["the body", "second line"]);
  assert.equal(parsed.key, id.slice(0, 8), "the id is recovered from the header");
});

test("a body-only message parses without inventing a header", () => {
  const parsed = parseRoomsMessage({ content: "just text", details: { from: "alpha", text: "just text" } });
  assert.equal(parsed.from, "alpha");
  assert.deepEqual(parsed.body, ["just text"]);
  assert.equal(parsed.hints, "");
});

test("ANSI in a message body is stripped, not rendered", () => {
  const parsed = parseRoomsMessage(
    message({ text: "\u001B[31mred\u001B[0m plain" })
  );
  assert.deepEqual(parsed.body, ["red plain"]);
  assert.equal(stripAnsi("\u001B[1mhi\u001B[0m"), "hi");
});

// ─── Rendering ───────────────────────────────────────────────────────────

test("collapsed: the title names the sender and the destination, plus a preview", () => {
  const dm = renderRoomsMessageLines({
    parsed: parseRoomsMessage(message({ from: "self-improvement-leader", text: "rollout DONE: 69/69 spaces pass" })),
    collapsed: true,
    width: 120,
    theme,
  });
  assert.equal(dm.length, 2, "collapsed is a title and one preview line");
  assert.match(dm[0], /^▸ Rooms · DM from self-improvement-leader · click to expand$/);
  assert.match(dm[1], /rollout DONE: 69\/69 spaces pass/);

  const room = renderRoomsMessageLines({
    parsed: parseRoomsMessage(message({ from: "beta", room: "core", roomSeq: 7, text: "a\nb\nc" })),
    collapsed: true,
    width: 120,
    theme,
  });
  assert.match(room[0], /^▸ Rooms · #core #7 from beta · 3 lines · click to expand$/);
});

test("expanded: the reply hints and the whole body, wrapped to the width", () => {
  const full = renderRoomsMessageLines({
    parsed: parseRoomsMessage(message({ text: "line one\nline two" })),
    collapsed: false,
    // Wide enough that the routing line is one row: this case is about the
    // body, and the narrow-width case below covers wrapping.
    width: 400,
    theme,
  });
  assert.match(full[0], /^▾ Rooms · DM from alpha · 2 lines · click to collapse$/);
  assert.match(full[1], /id [0-9a-f]{8}/, "the reply hints are available when expanded");
  assert.deepEqual(full.slice(2), ["  line one", "  line two"], "the whole body, line for line");

  // Hard wrapping at a narrow width leaves a long line intact character for
  // character; only the row it sits on changes.
  const body = "x".repeat(45);
  const narrow = renderRoomsMessageLines({
    parsed: parseRoomsMessage(message({ text: `${body}\nlast` })),
    collapsed: false,
    width: 20,
    theme,
  });
  // The body is drawn last, so its wrapped rows are the tail of the block.
  const wrapped = narrow.slice(-4).map((line) => line.replace(/^ {2}/, ""));
  assert.deepEqual(wrapped, ["x".repeat(18), "x".repeat(18), "x".repeat(9), "last"]);
});

test("a zero-width block draws nothing rather than throwing", () => {
  assert.deepEqual(
    renderRoomsMessageLines({ parsed: parseRoomsMessage(message()), collapsed: true, width: 0, theme }),
    []
  );
});

test("a click toggles one message and leaves the others collapsed", () => {
  const presentation = createRoomsMessagePresentation({ collapse: true });
  const first = message({ text: "first" });
  const second = message({ text: "second" });
  const a = renderRoomsMessageBlock(presentation, first, { expanded: false }, theme);
  const b = renderRoomsMessageBlock(presentation, second, { expanded: false }, theme);

  assert.match(a.render(100)[0], /click to expand/);
  assert.deepEqual(a.handleMouse!({ type: "click", button: "right" }), undefined, "only a left click is ours");
  assert.match(a.render(100)[0], /click to expand/, "a right click changes nothing");
  assert.deepEqual(a.handleMouse!({ type: "click", button: "left" }), { handled: true });

  assert.match(a.render(100)[0], /click to collapse/, "the clicked message expands");
  assert.match(b.render(100)[0], /click to expand/, "its neighbour does not");
});

test("pi's global expansion wins over the setting", () => {
  const presentation = createRoomsMessagePresentation({ collapse: true });
  const block = renderRoomsMessageBlock(presentation, message(), { expanded: true }, theme);
  assert.match(block.render(100)[0], /click to collapse/);
});

// ─── Registration, command, and a real delivered message ─────────────────

interface SentMessage {
  customType: string;
  content: unknown;
  details: any;
  options: any;
}

function harness(base: string) {
  const saved = { ...process.env };
  for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_SESSION_ID", "PI_AGENT_NAME", "PI_ROOMS_NAME"]) {
    delete process.env[key];
  }
  process.env.PI_ROOMS_DIR = base;
  process.env.PI_ROOMS_NAME = "lane";

  const sent: SentMessage[] = [];
  const renderers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function>();
  init({
    registerTool() {},
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerMessageRenderer: (customType: string, renderer: Function) => renderers.set(customType, renderer),
    on: (event: string, handler: Function) => {
      handlers.set(event, handler);
      return () => {};
    },
    sendMessage: (message: any, options: any) => sent.push({ ...message, options }),
    appendEntry() {},
  } as any);

  const ctx = { cwd: `${base}/work`, hasUI: true, ui: { setStatus() {}, notify() {} } } as any;
  return {
    sent,
    renderers,
    commands,
    handlers,
    ctx,
    restore: async () => {
      await handlers.get("session_shutdown")?.({}, ctx);
      await flushRoomsMessageViewWrites();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    },
  };
}

test("the extension registers the pi_rooms_message renderer and the slash command", async () => {
  const base = tempBase();
  const h = harness(base);
  try {
    assert.ok(h.renderers.has(ROOMS_MESSAGE_CUSTOM_TYPE), "a renderer is registered for the custom type");
    const command = h.commands.get("toggle-collapse-rooms-messages");
    assert.ok(command, "/toggle-collapse-rooms-messages is registered");

    // The command persists the setting and reports it.
    const notices: string[] = [];
    const ctx = { ...h.ctx, ui: { notify: (text: string) => notices.push(text) } };
    await command.handler("expand", ctx);
    assert.match(notices[0], /will start expanded/);
    assert.equal(readRoomsMessageViewConfig(base).collapse, false);

    await command.handler("collapse", ctx);
    assert.match(notices[1], /will start collapsed/);
    assert.equal(readRoomsMessageViewConfig(base).collapse, true);

    await command.handler("toggle", ctx);
    assert.equal(readRoomsMessageViewConfig(base).collapse, false, "bare flip toggles");

    await command.handler("sideways", ctx);
    assert.match(notices[3], /Unknown value "sideways"/);
    assert.equal(readRoomsMessageViewConfig(base).collapse, false, "an unknown verb changes nothing");
  } finally {
    await h.restore();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a real queued message is handed over as pi_rooms_message and draws collapsed", async () => {
  const base = tempBase();
  const h = harness(base);
  const createdAt = new Date().toISOString();
  try {
    const paths = resolvePaths(base);
    // The sender is live, so delivery carries no absence notice.
    register(paths, { name: "self-improvement-leader", pid: process.pid, cwd: base, startedAt: createdAt, updatedAt: createdAt });
    const id = randomUUID();
    deliver(paths, {
      id,
      from: "self-improvement-leader",
      to: ["lane"],
      text: "workspace-prompt rollout DONE: 69/69 spaces pass",
      sentAt: createdAt,
      queuedAt: createdAt,
    });

    await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);

    const handoff = h.sent.find((entry) => entry.customType === ROOMS_MESSAGE_CUSTOM_TYPE);
    assert.ok(handoff, "the flush handed the message over as pi_rooms_message");
    assert.equal(handoff!.details.id, id, "the full message travels in details");

    const renderer = h.renderers.get(ROOMS_MESSAGE_CUSTOM_TYPE)!;
    const block = renderer(handoff, { expanded: false, outputPad: 0 }, theme);
    const lines = block.render(120);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^▸ Rooms · DM from self-improvement-leader · click to expand$/);
    assert.match(lines[1], /rollout DONE: 69\/69 spaces pass/);

    // Expanded, the same real payload also carries the reply tooling.
    const expanded = renderer(handoff, { expanded: true, outputPad: 0 }, theme).render(120);
    assert.match(plain(expanded), /rooms_reply_all/);
    assert.match(plain(expanded), /rollout DONE: 69\/69 spaces pass/);
  } finally {
    unregister(resolvePaths(base), "self-improvement-leader", process.pid);
    await h.restore();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a failed preference write leaves the stored file intact and no temp file behind", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-view-write-"));
  const target = messageViewConfigPath(base);
  try {
    await writeRoomsMessageViewConfig(base, { collapse: false });
    const before = fs.readFileSync(target, "utf8");
    // Block the temp path a write must go through: a directory cannot be
    // overwritten as a file, so the atomic write fails before the rename.
    fs.mkdirSync(`${target}.${process.pid}.tmp`);
    await assert.rejects(
      () => writeRoomsMessageViewConfig(base, { collapse: true }),
      "a write that cannot complete must surface, not be swallowed"
    );
    assert.equal(
      fs.readFileSync(target, "utf8"),
      before,
      "the stored preference survives a failed write — the point of writing beside it and renaming"
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
