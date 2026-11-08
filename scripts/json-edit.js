#!/usr/bin/env node
// json-edit.js — non-destructive JSON edits for the Yellowstone installer.
//
// Editing a user's settings.json is not a job for sed. Every subcommand reads
// the file (returning {} when it is missing or unparseable, with a backup in
// that case), edits only the keys it owns, and writes with stable 2-space
// indentation so diffs stay reviewable.
//
//   merge-packages <settings.json> <template.json> <repo-root>
//       Union `packages` from template into settings. Template entries that
//       contain the @YELLOWSTONE_REPO@ placeholder are rewritten to
//       <repo-root>/<suffix>. Existing order is preserved; new entries append.
//   merge-models <models.json> <template.json>
//       Union providers; template provider wins only when the target is absent.
//   ensure-keys <settings.json> <template.json> <key>...
//       Copy selected top-level keys from template when absent in settings.
//   validate <file>...
//       Parse each file, exit 1 on the first failure.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER = '@YELLOWSTONE_REPO@';

// A package that lives in an external checkout. The merge rewrites this to the
// checkout's path, or drops the entry when no checkout is passed — better a
// missing fork than a package entry pointing at a directory that does not exist.
const EXTERNAL_PLACEHOLDER = '@PI_EXTENSIONS_APOTHIC@';

// The same idea for every other external checkout the fleet installs from. Each
// placeholder names an environment variable holding its root, so a machine that
// keeps a checkout somewhere else only has to say so once, in the environment.
const EXTERNAL_OTHERS = [
  ['@PI_EXTENSIONS_1@', 'PI_EXTENSIONS_1'],
  ['@PI_FLEET_HOOKS@', 'PI_FLEET_HOOKS'],
];

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.bak-yellowstone-${timestamp()}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function readJson(file, { tolerateCorrupt = false } = {}) {
  if (!fs.existsSync(file)) return { value: {}, existed: false };
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { value: JSON.parse(text), existed: true };
  } catch (e) {
    if (!tolerateCorrupt) throw new Error(`${file}: ${e.message}`);
    const dest = backup(file);
    process.stderr.write(`warn: ${file} is not valid JSON; backed up to ${dest}\n`);
    return { value: {}, existed: false };
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// A package entry is either a source string or { source, ... }.
function sourceOf(entry) {
  return typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.source : undefined;
}

// Compare packages by *identity*, not by source string. The same package can be
// installed from three different sources — `npm:pi-x`, `git:github.com/o/pi-x`,
// and a local path — and adding a second copy of a package the user already has
// is how you end up with two extensions fighting over one tool name.
//
//   npm:@scope/name@1.2.3   -> @scope/name
//   git:github.com/o/repo   -> the repo's package.json name when it is already
//                              cloned, otherwise the repo basename
//   /abs/path  or  ./rel    -> that directory's package.json name
function packageNameOf(entry) {
  const source = sourceOf(entry);
  if (!source) return undefined;

  if (source.startsWith('npm:')) {
    const spec = source.slice(4);
    const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
    return at > 0 ? spec.slice(0, at) : spec;
  }

  if (source.startsWith('git:') || /^https?:\/\/github\.com\//.test(source)) {
    const url = source.replace(/^git:/, '').replace(/^https?:\/\//, '');
    const parts = url.split(/[#@]/)[0].replace(/^github\.com\//, '').split('/').filter(Boolean);
    const repo = parts[parts.length - 1] || url;
    // A git package that pi has already cloned keeps its real name.
    for (const guess of [url, parts.join('/')]) {
      const manifest = path.join(process.env.PI_AGENT_DIR || path.join(process.env.HOME || '', '.pi/agent'),
        'git', guess.replace(/\.git$/, ''), 'package.json');
      try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).name || repo;
      } catch { /* not cloned yet */ }
    }
    return repo;
  }

  const dir = source.startsWith('~')
    ? path.join(process.env.HOME || '', source.slice(1))
    : path.resolve(source);
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name || path.basename(dir);
  } catch {
    return path.basename(dir);
  }
}

function renderSource(source, repoRoot, externalRoot) {
  if (typeof source !== 'string') return source;
  for (const [placeholder, envVar] of EXTERNAL_OTHERS) {
    if (!source.startsWith(placeholder)) continue;
    const root = process.env[envVar];
    if (!root) return undefined;
    return path.join(root, source.slice(placeholder.length).replace(/^\/+/, ''));
  }
  if (source.startsWith(EXTERNAL_PLACEHOLDER)) {
    if (!externalRoot) return undefined;  // caller reports the missing fork
    const suffix = source.slice(EXTERNAL_PLACEHOLDER.length).replace(/^\/+/, '');
    return path.join(externalRoot, suffix);
  }
  if (!source.startsWith(PLACEHOLDER)) return source;
  const suffix = source.slice(PLACEHOLDER.length).replace(/^\/+/, '');
  return path.join(repoRoot, suffix);
}

function mergePackages(settingsPath, templatePath, repoRoot, externalRoot) {
  const settings = readJson(settingsPath, { tolerateCorrupt: true });
  const template = readJson(templatePath).value;
  const existing = Array.isArray(settings.value.packages) ? settings.value.packages : [];
  // Two sets: the exact source (so a re-run is a no-op) and the package
  // identity (so a different source for the same package is not doubled).
  const presentSources = new Set(existing.map(sourceOf).filter(Boolean));
  const presentNames = new Set(existing.map(packageNameOf).filter(Boolean));

  const added = [];
  for (const entry of template.packages || []) {
    const rendered = typeof entry === 'string'
      ? renderSource(entry, repoRoot, externalRoot)
      : { ...entry, source: renderSource(entry.source, repoRoot, externalRoot) };
    if (rendered === undefined || (typeof rendered === 'object' && rendered.source === undefined)) {
      process.stdout.write(`packages: skipped ${sourceOf(entry)} (its checkout is not configured)\n`);
      continue;
    }
    const source = sourceOf(rendered);
    if (!source || presentSources.has(source)) continue;
    const name = packageNameOf(rendered);
    if (name && presentNames.has(name)) {
      process.stdout.write(`packages: kept existing source for ${name} (template wanted ${source})\n`);
      continue;
    }
    presentSources.add(source);
    if (name) presentNames.add(name);
    existing.push(rendered);
    added.push(source);
  }

  if (added.length === 0) {
    process.stdout.write('packages: already complete\n');
    return;
  }

  if (settings.existed) { const b = backup(settingsPath); process.stdout.write(`backed up ${path.basename(settingsPath)} -> ${path.basename(b)}\n`); }
  settings.value.packages = existing;
  writeJson(settingsPath, settings.value);
  process.stdout.write(`packages: added ${added.join(', ')}\n`);
}

function mergeModels(modelsPath, templatePath) {
  const target = readJson(modelsPath, { tolerateCorrupt: true });
  const template = readJson(templatePath).value;
  target.value.providers = target.value.providers || {};
  const added = [];
  for (const [id, provider] of Object.entries(template.providers || {})) {
    if (target.value.providers[id]) continue; // never clobber a user's endpoints
    target.value.providers[id] = provider;
    added.push(id);
  }
  for (const [id, override] of Object.entries(template.modelOverrides || {})) {
    target.value.modelOverrides = target.value.modelOverrides || {};
    if (target.value.modelOverrides[id]) continue;
    target.value.modelOverrides[id] = override;
    added.push(`override:${id}`);
  }
  if (added.length === 0) {
    process.stdout.write('models: providers already present\n');
    return;
  }
  if (target.existed) { const b = backup(modelsPath); process.stdout.write(`backed up ${path.basename(modelsPath)} -> ${path.basename(b)}\n`); }
  writeJson(modelsPath, target.value);
  process.stdout.write(`models: added ${added.join(', ')}\n`);
}

function ensureKeys(settingsPath, templatePath, keys) {
  const settings = readJson(settingsPath, { tolerateCorrupt: true });
  const template = readJson(templatePath).value;
  const added = [];
  for (const key of keys) {
    if (settings.value[key] !== undefined) continue;
    if (template[key] === undefined) continue;
    settings.value[key] = template[key];
    added.push(key);
  }
  if (added.length === 0) {
    process.stdout.write(`settings: ${keys.join(', ')} already set\n`);
    return;
  }
  if (settings.existed) { const b = backup(settingsPath); process.stdout.write(`backed up ${path.basename(settingsPath)} -> ${path.basename(b)}\n`); }
  writeJson(settingsPath, settings.value);
  process.stdout.write(`settings: added ${added.join(', ')}\n`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'merge-packages': {
      const [settings, template, repoRoot, externalRoot] = rest;
      if (!settings || !template || !repoRoot) throw new Error('merge-packages needs <settings> <template> <repo-root> [<external-root>]');
      return mergePackages(settings, template, repoRoot, externalRoot);
    }
    case 'merge-models': {
      const [models, template] = rest;
      if (!models || !template) throw new Error('merge-models needs <models> <template>');
      return mergeModels(models, template);
    }
    case 'ensure-keys': {
      const [settings, template, ...keys] = rest;
      if (!settings || !template || keys.length === 0) throw new Error('ensure-keys needs <settings> <template> <key>...');
      return ensureKeys(settings, template, keys);
    }
    case 'validate': {
      for (const f of rest) {
        JSON.parse(fs.readFileSync(f, 'utf8'));
        process.stdout.write(`ok ${f}\n`);
      }
      return;
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`json-edit: ${e.message}\n`);
  process.exit(1);
}
