#!/usr/bin/env node
// strict-json.mjs — the receipt gate. A receipt a machine cannot parse is not a
// receipt, and the previous release shipped one with a trailing comma after the
// final patch row (review finding 4). JSON.parse is the whole test: no repair,
// no tolerant reader, no regex, because a repair path is how a malformed file
// keeps passing.
//
//   node lib/strict-json.mjs <file.json> [<file.json> …]
//
// Exit 0 only if every file parses. On failure it names the file and the
// parser's position, and exits 1.

import fs from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: strict-json.mjs <file.json> [<file.json> …]");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.error(`MISSING ${file}: ${error.message}`);
    failed += 1;
    continue;
  }
  try {
    const value = JSON.parse(text);
    const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : "-";
    console.log(`STRICT ${file} (${text.length} B, top-level keys ${keys})`);
  } catch (error) {
    const at = /position (\d+)/.exec(error.message)?.[1];
    const line = at === undefined ? null : text.slice(0, Number(at)).split("\n").length;
    console.error(`MALFORMED ${file}: ${error.message}${line ? ` (line ${line})` : ""}`);
    failed += 1;
  }
}

process.exit(failed === 0 ? 0 : 1);
