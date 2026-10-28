#!/usr/bin/env node
// pi-patches.js — re-apply Yellowstone's local patches to installed pi packages.
//
//   node scripts/pi-patches.js           apply every patch (idempotent)
//   node scripts/pi-patches.js --check   report only; exit 1 if any patch is missing
//   node scripts/pi-patches.js --revert  restore the file saved before patching
//
// A package installed from npm is owned by npm: `pi update` replaces the file
// and the patch goes with it. That is why this runs from `scripts/upgrade.sh`
// right after the package step instead of once by hand.
//
// Every patch names the exact text it replaces and the upstream condition that
// retires it. When upstream changes that text the patch stops applying — the
// script says so rather than silently doing nothing, which is the difference
// between a patch and a fork nobody reviews.
//
// Patches are text edits on source files, never on published build output: pi
// loads TypeScript sources directly, so there is no compile step to invalidate.

'use strict';

const { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const PI_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const BACKUP_SUFFIX = '.bak-local-patch';

// Each patch: id, package directory under pi's npm install root, file, marker,
// the edits (exact text in / exact text out), and why it exists.
const PATCHES = [
  {
    id: 'pi-goal-experimental-warning',
    package: '@signalridge/pi-goal',
    file: 'src/lifecycle.ts',
    marker: 'local-patch:pi-goal-experimental-warning',
    why: 'the experimental-goals notice fires on every session start with no way to turn it off',
    retires: 'pi-goal ships a setting that silences the experimental-goals notice',
    edits: [
      {
        find:
          'const EXPERIMENTAL_GOALS_WARNING =\n' +
          '  "Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";',
        replace:
          '// local-patch:pi-goal-experimental-warning — the experimental ordered-goals\n' +
          '// notice is suppressed. Tracked by scripts/pi-patches.js in the Yellowstone\n' +
          '// repo; retire the patch once pi-goal can silence the notice itself.',
      },
      {
        find:
          '    if (runtime.settings.experimental.goals) {\n' +
          '      notifyTerminal(ctx.ui, EXPERIMENTAL_GOALS_WARNING, "warning");\n' +
          '    }',
        replace: '    // local-patch:pi-goal-experimental-warning — notice suppressed.',
      },
    ],
  },
];

function packagePath(entry) {
  return join(PI_DIR, 'npm', 'node_modules', ...entry.package.split('/'));
}

function status(entry) {
  const file = join(packagePath(entry), entry.file);
  if (!existsSync(file)) return { kind: 'absent', file };
  const text = readFileSync(file, 'utf8');
  if (text.includes(entry.marker)) return { kind: 'applied', file };
  if (entry.edits.every((edit) => text.includes(edit.find))) return { kind: 'pending', file };
  return { kind: 'unknown', file };
}

function apply(entry) {
  const state = status(entry);
  if (state.kind === 'absent') {
    console.log(`  skip   ${entry.id}: ${entry.package} is not installed`);
    return 0;
  }
  if (state.kind === 'applied') {
    console.log(`  ok     ${entry.id}: already applied`);
    return 0;
  }
  if (state.kind === 'unknown') {
    console.log(`  STALE  ${entry.id}: ${state.file} does not match the text this patch replaces`);
    console.log(`         upstream changed the file, or the patch was already overtaken`);
    console.log(`         retire it if upstream fixed the cause: ${entry.retires}`);
    return 1;
  }
  let text = readFileSync(state.file, 'utf8');
  for (const edit of entry.edits) text = text.replace(edit.find, edit.replace);
  copyFileSync(state.file, state.file + BACKUP_SUFFIX);
  writeFileSync(state.file, text);
  console.log(`  patch  ${entry.id}: applied to ${state.file}`);
  return 0;
}

function check(entry) {
  const state = status(entry);
  if (state.kind === 'applied' || state.kind === 'absent') {
    console.log(`  ok     ${entry.id}: ${state.kind === 'absent' ? 'not installed' : 'applied'}`);
    return 0;
  }
  console.log(`  MISSING ${entry.id}: ${state.kind === 'unknown' ? 'patch text no longer matches' : 'not applied'}`);
  return 1;
}

function revert(entry) {
  const state = status(entry);
  const backup = state.file + BACKUP_SUFFIX;
  if (!existsSync(backup)) {
    console.log(`  skip   ${entry.id}: no ${BACKUP_SUFFIX} saved`);
    return 0;
  }
  writeFileSync(state.file, readFileSync(backup, 'utf8'));
  rmSync(backup);
  console.log(`  revert ${entry.id}: ${state.file} restored from ${BACKUP_SUFFIX}`);
  return 0;
}

function main(argv) {
  const mode = argv.includes('--revert') ? 'revert' : argv.includes('--check') ? 'check' : 'apply';
  let failures = 0;
  for (const entry of PATCHES) {
    const run = mode === 'check' ? check : mode === 'revert' ? revert : apply;
    failures += run(entry) === 0 ? 0 : 1;
  }
  if (mode === 'apply' && failures > 0) {
    console.log('\nSome patches did not apply. Review the notes above before starting pi.');
  }
  return failures === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { PATCHES };
