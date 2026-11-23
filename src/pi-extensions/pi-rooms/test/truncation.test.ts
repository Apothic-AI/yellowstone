/**
 * Truncation tests: the threshold is a config setting read once per session, so
 * every scenario below starts from a session that has not read a config yet.
 * `session_shutdown` is what drops the cached session; without it the second
 * scenario would silently reuse the first one's config and prove nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import init from "../index.ts";
import { configPath } from "../src/config.ts";
import { archive, drain, findReceived, readPosts, resolvePaths } from "../src/store.ts";

interface Recorded {
  tools: Map<string, any>;
  handlers: Map<string, Function>;
  sent: { content: string; customType: string }[];
}

function loadExtension(env: Record<string, string>): Recorded {
  // Sandbox: never inherit a real HERDR_PANE_ID / session id, or every fake lane
  // in a test would look like the same pane and pins would resolve across tests.
  for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PI_SESSION_ID", "PI_AGENT_NAME"]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const recorded: Recorded = { tools: new Map(), handlers: new Map(), sent: [] };
  const pi = {
    registerTool: (def: any) => recorded.tools.set(def.name, def),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: (event: string, handler: Function) => {
      recorded.handlers.set(event, handler);
      return () => {};
    },
    sendMessage: (message: any) => recorded.sent.push({ content: message.content, customType: message.customType }),
    appendEntry: () => {},
  };
  init(pi as any);
  return recorded;
}

const CWD = "/work/trunc";

/** A message longer than the old hard cap, so the difference is visible. */
const LONG = "L".repeat(5000);

const ctx = (cwd: string) => ({ cwd, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } }) as any;

async function call(ext: Recorded, name: string, params: unknown, cwd = CWD) {
  const tool = ext.tools.get(name);
  assert.ok(tool != null, `${name} should be registered`);
  return tool.execute("call-1", params, undefined, undefined, ctx(cwd));
}

function base(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rooms-trunc-"));
}

/** Write the config *before* the session reads it, then load the extension. */
function start(dir: string, name: string, config?: unknown): Recorded {
  if (config !== undefined) fs.writeFileSync(configPath(resolvePaths(dir)), JSON.stringify(config));
  return loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: name });
}

async function stop(ext: Recorded): Promise<void> {
  const handler = ext.handlers.get("session_shutdown");
  assert.ok(handler != null);
  await handler({}, ctx(CWD));
}

/** Read a delivered body back the way `reply_all` would find it, queued or archived. */
function storedText(dir: string, recipient: string, id: string): string {
  const found = findReceived(resolvePaths(dir), recipient, id);
  assert.ok(found != null, `message ${id} should be in ${recipient}'s inbox history`);
  return found.text;
}

test("no config file: a DM longer than 4000 characters is stored and delivered whole", async () => {
  const dir = base();
  const ext = start(dir, "lead");
  const sent = await call(ext, "rooms_dm", { to: "core", message: LONG }, CWD);
  assert.equal(sent.isError, undefined);
  const text = storedText(dir, "core", sent.details.id);
  assert.equal(text.length, LONG.length, "the whole message is kept, not cut at 4000");
  assert.doesNotMatch(text, /\[truncated \d+ chars\]/);
  await stop(ext);
});

test("no config file: a room post longer than 4000 characters reaches history and inbox whole", async () => {
  const dir = base();
  const paths = resolvePaths(dir);
  const ext = start(dir, "lead");
  await call(ext, "rooms_create", { room: "trunc", members: ["core"] }, CWD);
  await call(ext, "rooms_post", { room: "trunc", message: LONG }, CWD);

  const post = readPosts(paths, "trunc", 0, 10).at(-1);
  assert.equal(post?.text, LONG, "room history keeps the whole body");
  const queued = drain(paths, "core").find((entry) => entry.message.room === "trunc");
  assert.equal(queued?.message.text, LONG, "the fanned-out copy keeps the whole body");
  await stop(ext);
});

test("no config file: a reply-all longer than 4000 characters is stored whole", async () => {
  const dir = base();
  const paths = resolvePaths(dir);
  const lead = start(dir, "lead");
  await call(lead, "rooms_create", { room: "trunc", members: ["core"] }, CWD);
  await call(lead, "rooms_post", { room: "trunc", message: "who owns it?" }, CWD);

  // Stand in for the watcher: the post is in core's read/ archive, which is what
  // reply_all searches, so the reply has an id to answer.
  const pending = drain(paths, "core").find((entry) => entry.message.room === "trunc")!;
  archive(paths, "core", pending.file, pending.message);

  const core = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "core" });
  const reply = await call(core, "rooms_reply_all", { messageId: pending.message.id, message: LONG }, CWD);
  assert.equal(reply.isError, undefined);
  assert.equal(readPosts(paths, "trunc", 0, 10).at(-1)?.text, LONG);
  await stop(core);
});

for (const disabled of [0, -1]) {
  test(`maxMessageChars ${disabled} disables truncation: the full DM is stored`, async () => {
    const dir = base();
    const ext = start(dir, "lead", { maxMessageChars: disabled });
    const sent = await call(ext, "rooms_dm", { to: "core", message: LONG }, CWD);
    assert.equal(sent.isError, undefined);
    const text = storedText(dir, "core", sent.details.id);
    assert.equal(text, LONG);
    assert.doesNotMatch(text, /\[truncated \d+ chars\]/);
    await stop(ext);
  });
}

test("a positive maxMessageChars truncates a DM at that many characters with the marker", async () => {
  const dir = base();
  const ext = start(dir, "lead", { maxMessageChars: 120 });
  const sent = await call(ext, "rooms_dm", { to: "core", message: LONG }, CWD);
  const text = storedText(dir, "core", sent.details.id);
  assert.equal(text, `${"L".repeat(120)}\n… [truncated 4880 chars]`);
  await stop(ext);
});

test("a positive maxMessageChars truncates room posts and replies too", async () => {
  const dir = base();
  const paths = resolvePaths(dir);
  const lead = start(dir, "lead", { maxMessageChars: 50 });
  await call(lead, "rooms_create", { room: "trunc", members: ["core"] }, CWD);
  await call(lead, "rooms_post", { room: "trunc", message: LONG }, CWD);

  const cut = `${"L".repeat(50)}\n… [truncated 4950 chars]`;
  const pending = drain(paths, "core").find((entry) => entry.message.room === "trunc")!;
  assert.equal(pending.message.text, cut, "the pushed copy is cut at the threshold");
  assert.equal(readPosts(paths, "trunc", 0, 10).at(-1)?.text, cut, "history holds the same cut text");
  archive(paths, "core", pending.file, pending.message);

  const core = loadExtension({ PI_ROOMS_DIR: dir, PI_ROOMS_NAME: "core" });
  const reply = await call(core, "rooms_reply_all", { messageId: pending.message.id, message: LONG }, CWD);
  assert.equal(reply.isError, undefined);
  assert.equal(readPosts(paths, "trunc", 0, 10).at(-1)?.text, cut, "a reply is cut the same way");
  await stop(core);
});

test("disabling truncation keeps control-character sanitisation", async () => {
  const dir = base();
  const ext = start(dir, "lead", { maxMessageChars: 0 });
  const body = `a\u0000b\u0001c\u001b[31m${"x".repeat(4500)}`;
  const sent = await call(ext, "rooms_dm", { to: "core", message: body }, CWD);
  const text = storedText(dir, "core", sent.details.id);
  // Stripped, then kept whole: the full 4500 characters survive with no escapes.
  assert.equal(text, `abc[31m${"x".repeat(4500)}`);
  await stop(ext);
});

test("a positive threshold counts characters after sanitisation, not raw bytes", async () => {
  const dir = base();
  const ext = start(dir, "lead", { maxMessageChars: 10 });
  // Ten control characters around eleven visible ones: the cut lands on the
  // cleaned text, so no threshold budget is spent on characters that are gone.
  const body = `a\u0000${"y".repeat(20)}`;
  const sent = await call(ext, "rooms_dm", { to: "core", message: body }, CWD);
  assert.equal(storedText(dir, "core", sent.details.id), `a${"y".repeat(9)}\n… [truncated 11 chars]`);
  await stop(ext);
});
