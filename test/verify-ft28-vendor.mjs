// Offline root integration matrix; only temporary settings are written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const repo = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ft28-vendor-'));
const script = path.join(repo, 'scripts/json-edit.js');
const template = path.join(repo, 'home/.pi/agent/settings.json');
const vendor = path.join(repo, 'vendor/pi-tps-stats-ft28');
const upstreamName = '@arhen/pi-core-tps-stats';
const source = entry => typeof entry === 'string' ? entry : entry.source;
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
let checks = 0;
try {
  const settings = path.join(scratch, 'settings.json');
  const local = path.join(scratch, 'upstream');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: upstreamName }));
  const filters = { extensions: ['+index.ts', '-legacy.ts'], skills: [], prompts: [], themes: [] };
  run('render-settings', template, settings, repo);
  const fresh = JSON.parse(fs.readFileSync(settings));
  assert.equal(fresh.packages.filter(p => source(p) === vendor).length, 1);
  assert.equal(fresh.packages.some(p => source(p).includes(upstreamName)), false);
  assert.deepEqual(fresh.packages.find(p => source(p) === 'npm:@99percentpeople/pi-thinking-fold').extensions, ['-index.min.js']);
  checks++;
  for (const old of [
    `npm:${upstreamName}`,
    `npm:${upstreamName}@1.3.4`,
    { source: `npm:${upstreamName}@1.3.4`, ...filters },
    local,
    { source: './upstream', ...filters },
    { source: local, ...filters },
  ]) {
    const unrelated = { source: 'npm:unrelated-package', extensions: [] };
    fs.writeFileSync(settings, JSON.stringify({ theme: 'custom', custom: 123, packages: [unrelated, old] }));
    run('merge-packages', settings, template, repo);
    const merged = JSON.parse(fs.readFileSync(settings));
    assert.equal(merged.theme, 'custom'); assert.equal(merged.custom, 123);
    assert.deepEqual(merged.packages[0], unrelated);
    const entries = merged.packages.filter(p => source(p) === vendor);
    assert.equal(entries.length, 1);
    if (typeof old === 'object') assert.deepEqual(entries[0], { ...filters, source: vendor });
    assert.equal(merged.packages.some(p => source(p).includes(upstreamName) || source(p) === local || source(p) === './upstream'), false);
    const before = fs.readFileSync(settings);
    run('merge-packages', settings, template, repo);
    assert.deepEqual(fs.readFileSync(settings), before, 'warm merge byte-idempotent');
    checks++;
  }
  fs.writeFileSync(settings, JSON.stringify({ packages: [`npm:${upstreamName}`, { source: local, ...filters }, vendor] }));
  run('merge-packages', settings, template, repo);
  assert.equal(JSON.parse(fs.readFileSync(settings)).packages.filter(p => source(p) === vendor).length, 1);
  checks++;
  fs.writeFileSync(settings, JSON.stringify({ packages: [{ source: local, extensions: [] }, { source: `npm:${upstreamName}`, extensions: ['+index.ts'] }] }));
  const conflict = fs.readFileSync(settings);
  assert.throws(() => run('merge-packages', settings, template, repo), /conflicting extensions/);
  assert.deepEqual(fs.readFileSync(settings), conflict, 'conflict leaves disk unchanged');
  checks++;
  const otherTemplate = path.join(scratch, 'template.json');
  fs.writeFileSync(otherTemplate, JSON.stringify({ packages: ['npm:unrelated-package'] }));
  fs.writeFileSync(settings, JSON.stringify({ packages: [`npm:${upstreamName}`] }));
  run('merge-packages', settings, otherTemplate, repo);
  assert.equal(JSON.parse(fs.readFileSync(settings)).packages[0], `npm:${upstreamName}`, 'retirement opt-in only');
  checks++;
  const filteredTemplate = path.join(scratch, 'filtered.json');
  fs.writeFileSync(filteredTemplate, JSON.stringify({ packages: [{ source: '@YELLOWSTONE_REPO@/vendor/pi-tps-stats-ft28', ...filters }] }));
  run('render-settings', filteredTemplate, settings, repo);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)).packages, [{ source: vendor, ...filters }]);
  checks++;
  // All nine accepted files, including MIT attribution and provenance, stay exact.
  const accepted = '0f5d18b8e8729ebde4871661b22948b0e9f15c47';
  const prefix = 'src/pi-extensions/pi-tps-stats/';
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', accepted, prefix], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.equal(paths.length, 9);
  for (const file of paths) assert.deepEqual(fs.readFileSync(path.join(vendor, file.slice(prefix.length))), execFileSync('git', ['show', `${accepted}:${file}`], { cwd: repo }));
  assert.equal(fs.existsSync(path.join(vendor, '.gitrepo')), false);
  checks++;
  console.log(`FT28_VENDOR_PASS ${checks}/${checks}: fresh/warm, pin/object/local, filters, dedupe, conflict, scope, exact 9 files`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
