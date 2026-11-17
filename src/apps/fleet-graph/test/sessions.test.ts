import test from "node:test";
import assert from "node:assert/strict";
import { beadMentionsInText } from "../src/server/sessions.ts";

const ids = new Set(["ft-74", "swarm-c0l.9.45", "task-a1"]);

test("counts bead ids named in a bd command, and nothing else", () => {
  const text = [
    '{"type":"tool","command":"bd update ft-74 --status in_progress"}',
    '{"type":"tool","command":"bd show swarm-c0l.9.45"}',
    "the word ft-74 appears in prose without a bd command",
    '{"type":"tool","command":"grep ft-74 docs.md"}'
  ].join("\n");
  const mentions = beadMentionsInText(text, ids);
  assert.equal(mentions.get("ft-74"), 1);
  assert.equal(mentions.get("swarm-c0l.9.45"), 1);
  assert.equal(mentions.get("task-a1"), undefined);
});

test("unknown ids are not invented from the text", () => {
  const mentions = beadMentionsInText('{"command":"bd update not-a-real-bead"}', ids);
  assert.equal(mentions.size, 0);
});
