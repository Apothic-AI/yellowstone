#!/usr/bin/env node
// plugins-manifest.js — read home/.config/herdr/plugins.toml for the installer.
//
// Shell cannot parse TOML and should not try. This reads the one shape the
// manifest uses ([[plugin]] tables of scalar string keys) and prints one record
// per plugin. Fields are joined with \x1f (unit separator), not tabs: bash's
// `read` collapses runs of IFS whitespace, which would silently drop empty
// middle fields.
//
//   node scripts/plugins-manifest.js rows    <manifest>
//   node scripts/plugins-manifest.js ids     <manifest>
//   node scripts/plugins-manifest.js get <manifest> <id> <key>

'use strict';

const fs = require('node:fs');

const FIELDS = ['id', 'source', 'ref', 'link_path', 'optional', 'why', 'repo', 'note', 'keybind'];

function parseManifest(file) {
  const text = fs.readFileSync(file, 'utf8');
  const plugins = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[plugin]]') {
      cur = {};
      plugins.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"$/);
    if (!m) continue;
    cur[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return plugins;
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file) throw new Error('usage: plugins-manifest.js <rows|ids|get> <manifest> [args]');
  const plugins = parseManifest(file);

  switch (cmd) {
    case 'rows':
      for (const p of plugins) {
        process.stdout.write(`${FIELDS.map((k) => p[k] ?? '').join('\u001f')}\n`);
      }
      return;
    case 'ids':
      for (const p of plugins) if (p.id) process.stdout.write(`${p.id}\n`);
      return;
    case 'get': {
      const [id, key] = rest;
      const p = plugins.find((x) => x.id === id);
      if (!p) throw new Error(`no such plugin: ${id}`);
      process.stdout.write(`${p[key] ?? ''}\n`);
      return;
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`plugins-manifest: ${e.message}\n`);
  process.exit(1);
}
