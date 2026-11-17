// verify-compaction-state.mjs — the pi extension that makes a compaction observable.
//
// FT-57: a lane's herdr status reads `idle` for the whole life of a `/compact`, so an
// observer cannot tell a fold in progress from a finished one, and `reload-fleet`'s idle
// barrier can satisfy itself mid-fold and send `/reload` into a compaction that is still
// executing. pi DOES emit the transition (`session_before_compact` / `session_compact` /
// `session_compact_failed`); the herdr-managed reporter consumes none of it, and its own
// header says to add hooks BESIDE it rather than editing it.
//
// What this gate pins, and why each one can fail silently:
//
//   1. every terminal event CLEARS the claim. A fold that ends by error, abort or
//      extension-cancel goes through `session_compact_failed`; if only the success path
//      cleared, a failed fold would leave the lane looking busy until the TTL expired and
//      every reload would wait 30 minutes for nothing.
//   2. the claim is published BEFORE the work, from `session_before_compact`, not after.
//   3. a missing HERDR_PANE_ID makes the extension inert rather than throwing — this file
//      loads in every lane, including headless ones with no pane.
//   4. the token grammar herdr accepts is respected. herdr rejects a key containing a dot
//      with `invalid_metadata_token` and exits 0, so a name like `pi.compacting` would
//      look applied and do nothing. Measured 2026-11-17: `--token pi.compacting=manual`
//      returns that error.
//   5. reports are delivered one at a time and AWAITED, because herdr applies them in the
//      order received — a clear fired at the same instant as its set must not overtake it.
//      The extension deliberately sends no `seq`: herdr drops any report whose seq is not
//      strictly greater than the last for that (source, pane), answering ok with exit
//      status 0. Measured 2026-11-17 on a live pane: seq 1 applied, seq 2 applied, seq 1
//      again was silently ignored. A wall-clock seq therefore has a permanent silent-death
//      mode — one larger value (a clock step, a probe) and the lane stops reporting folds
//      forever, which is the very failure this extension exists to remove.
//
// Hermetic: a fake `pi` records handlers and a fake spawn records argv. No herdr needed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const modulePath = path.join(repo, 'home/.pi/agent/extensions/compaction-state.ts');
let checks = 0;
const ok = (label) => { checks++; console.log(`ok   ${label}`); };

const load = async () => import(pathToFileURL(modulePath).href);

const ext = await load();

// --- 1. the token channel, in herdr's accepted grammar -------------------------------
const setArgv = ext.setArgs('w1:p1', 'manual', 1794923000);
assert.equal(setArgv[0], 'pane');
assert.equal(setArgv[1], 'report-metadata');
const pane = setArgv[setArgv.length - 1];
assert.equal(pane, 'w1:p1');
const tokens = setArgv.filter((_, i) => setArgv[i - 1] === '--token');
assert.deepEqual(tokens, ['compacting=manual', 'compacting_since=1794923000']);
// herdr's normalizer accepts only ASCII alnum plus `_` and `-` (api_helpers.rs:261-266);
// a dot in a key is rejected with `invalid_metadata_token` and exit status 0.
for (const token of tokens) {
  const key = token.split('=')[0];
  assert.match(key, /^[A-Za-z0-9_-]{1,32}$/, `hostile token key: ${key}`);
  assert.ok(!key.includes('.'), `herdr rejects a dotted token key: ${key}`);
}
ok('the fold is published as underscore tokens herdr accepts (a dotted key is rejected silently)');

// The report must carry NO --seq. herdr's `sequence_is_fresh` treats None as fresh
// (metadata_tokens.rs:22), while a seq that is not strictly greater than the stored one is
// dropped with exit status 0. Omitting it is what makes a poisoned counter harmless.
assert.equal(setArgv.includes('--seq'), false,
             'a --seq here reintroduces the silent stale-drop failure mode');
ok('the claim sends no --seq, so a stale counter cannot silently mute the lane');

// The TTL is a crash backstop: a killed mid-fold process must not make a lane look busy
// forever. It must be within herdr's accepted range (1 ms .. 86_400_000 ms).
const ttl = Number(setArgv[setArgv.indexOf('--ttl-ms') + 1]);
assert.ok(ttl >= 1 && ttl <= 86_400_000, `ttl out of herdr's range: ${ttl}`);
assert.ok(ttl >= 60 * 60 * 1000, 'ttl shorter than a plausible fold would clear it mid-fold');
ok(`the claim carries a crash-backstop TTL inside herdr's range (${ttl} ms)`);

// --- 2. the clear covers both names --------------------------------------------------
const clearArgv = ext.clearArgs('w1:p1');
assert.equal(clearArgv.includes('--seq'), false, 'the clear must match the set');
const cleared = clearArgv.filter((_, i) => clearArgv[i - 1] === '--clear-token');
assert.deepEqual(cleared.sort(), ['compacting', 'compacting_since']);
assert.equal(clearArgv[clearArgv.length - 1], 'w1:p1');
ok('clearing removes BOTH names, so no stale `compacting_since` outlives a fold');

// --- 3. the reason is normalized ------------------------------------------------------
assert.equal(ext.normalizeReason('manual'), 'manual');
assert.equal(ext.normalizeReason('THRESHOLD'), 'threshold');
assert.equal(ext.normalizeReason('overflow'), 'overflow');
assert.equal(ext.normalizeReason(undefined), 'unknown');
assert.equal(ext.normalizeReason(''), 'unknown');
assert.equal(ext.normalizeReason('a b\nc'), 'abc');
assert.ok(!ext.normalizeReason('x'.repeat(99)).includes(' '));
ok('the reason is a bounded word, so no newline or space can split the argv token');

// --- 4. every terminal event clears; the claim is set before the work ------------------
{
  const handlers = new Map();
  const argv = [];
  const fakePi = { on: (name, fn) => handlers.set(name, fn) };
  const paneId = 'w9:p9';
  const original = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = paneId;
  try {
    let clock = 1794923000000;
    ext.register(fakePi, (args) => argv.push(args), () => clock);
    for (const name of ['session_before_compact', 'session_compact',
                        'session_compact_failed', 'session_start', 'session_shutdown']) {
      assert.ok(handlers.has(name), `no handler registered for ${name}`);
    }
    // The set must be queued synchronously from the *before* event, so it lands before the
    // summary request starts rather than racing it.
    handlers.get('session_before_compact')({ reason: 'manual' });
    clock += 1000;
    handlers.get('session_compact')({});
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(argv.length, 2, `expected a set and a clear, got ${argv.length}`);
    const [set, clear] = argv;
    assert.deepEqual(set.filter((_, i) => set[i - 1] === '--token'),
                     ['compacting=manual', 'compacting_since=1794923000']);
    assert.deepEqual(clear.filter((_, i) => clear[i - 1] === '--clear-token').sort(),
                     ['compacting', 'compacting_since']);
    // Delivery is serialized and awaited, so the clear cannot overtake its set even when
    // the fold fails immediately. This pins the order the spawner actually observed.
    assert.deepEqual(argv.map((args) => (args.includes('--token') ? 'set' : 'clear')),
                     ['set', 'clear'], 'the clear was delivered before its set');
    ok('session_before_compact publishes, session_compact clears, in delivery order');

    // A failed fold — error, abort, or extension-cancel — must clear just the same, or the
    // lane looks busy until the TTL expires.
    argv.length = 0;
    handlers.get('session_before_compact')({ reason: 'threshold' });
    handlers.get('session_compact_failed')({ aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(argv.length, 2);
    assert.deepEqual(argv[1].filter((_, i) => argv[1][i - 1] === '--clear-token').sort(),
                     ['compacting', 'compacting_since']);
    ok('session_compact_failed clears the claim (an aborted fold cannot wedge the lane)');

    // A session start clears: no fold from a previous process survives it.
    argv.length = 0;
    handlers.get('session_start')({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(argv.length, 1);
    assert.ok(argv[0].includes('--clear-token'));
    ok('session_start clears a claim left by a previous process');
  } finally {
    if (original === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = original;
  }
}

// --- 5. no pane, no report, and no throw ----------------------------------------------
{
  const handlers = new Map();
  const argv = [];
  const original = process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PANE_ID;
  try {
    ext.register({ on: (name, fn) => handlers.set(name, fn) }, (args) => argv.push(args));
    for (const [, fn] of handlers) fn({ reason: 'manual' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(argv, [], 'a pane-less session must not report');
    ok('a session with no HERDR_PANE_ID is inert and does not throw');
  } finally {
    if (original !== undefined) process.env.HERDR_PANE_ID = original;
  }
}

// --- 6. a spawn failure cannot break a turn -------------------------------------------
{
  const handlers = new Map();
  const original = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = 'w9:p9';
  try {
    ext.register({ on: (name, fn) => handlers.set(name, fn) }, () => {
      throw new Error('herdr vanished');
    });
    handlers.get('session_before_compact')({ reason: 'manual' });
    handlers.get('session_compact')({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok('a failing herdr call is swallowed — reporting never breaks a turn');
  } finally {
    if (original === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = original;
  }
}

console.log(`verify-compaction-state: ${checks} checks passed`);
