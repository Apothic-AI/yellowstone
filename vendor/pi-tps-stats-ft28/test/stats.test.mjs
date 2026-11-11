import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStatsExtension } from '../index.ts';
import { DEFAULT_CONFIG, MAX_SAMPLES, Measurements, measure, median } from '../metrics.ts';
import { appendMeasurement, loadConfig, logFile, saveConfig, validateConfig } from '../storage.ts';

// No Pi runtime or provider imports: the API accepts only registration; anything else fails.
async function fixture(t, defaults) {
  const directory = await mkdtemp(join(tmpdir(), 'ft28-stats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (defaults) await saveConfig(directory, defaults);
  const events = new Map(), commands = new Map(), notices = [], statuses = new Map();
  let clock = Date.parse('2026-11-10T12:00:00.000Z'), sessionId = 'synthetic-session-001';
  const api = new Proxy({
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, spec) { commands.set(name, spec); },
  }, { get(target, property) { if (!(property in target)) throw new Error(`Forbidden API: ${String(property)}`); return target[property]; } });
  const ctx = {
    hasUI: true,
    ui: { setStatus: (key, value) => statuses.set(key, value), notify: (text, kind) => notices.push({ text, kind }) },
    sessionManager: { getSessionId: () => sessionId },
  };
  createStatsExtension({ directory, now: () => clock })(api);
  const emit = async (name, event = {}) => { await events.get(name)(event, ctx); };
  const command = async (args = '') => { await commands.get('tps-stats').handler(args, ctx); return notices.at(-1)?.text; };
  const sample = async ({ output = 100, duration = 2000, ttft = 200, type = 'thinking_start', privateFields = {} } = {}) => {
    await emit('turn_start', { timestamp: clock });
    if (ttft !== null) { clock += ttft; await emit('message_update', { assistantMessageEvent: { type, ...privateFields } }); clock -= ttft; }
    clock += duration;
    await emit('message_end', { message: { role: 'assistant', usage: { output }, content: 'PRIVATE_OUTPUT', ...privateFields } });
  };
  await emit('session_start');
  return { directory, ctx, emit, command, sample, notices, statuses, events, commands,
    advance: ms => clock += ms, setId: value => sessionId = value, now: () => clock };
}

test('metric definition includes TTFT; invalid and nonfinite metrics rejected', () => {
  assert.deepEqual(measure(100, 1000, 1200, 3000), { endedAtMs: 3000, outputTokens: 100, durationMs: 2000, tps: 50, ttftMs: 200 });
  for (const output of [0, -1, NaN, Infinity]) assert.equal(measure(output, 1000, 1200, 3000), undefined);
  assert.equal(measure(10, 1000, 1000, 1000), undefined);
  assert.equal(measure(10, 2000, 1000, 1000), undefined);
  assert.equal(measure(10, NaN, undefined, 3000), undefined);
  assert.equal(measure(10, 1000, 4000, 3000).ttftMs, null);
  assert.equal(median([30, 10]), 20); assert.equal(median([]), 0);
});

test('default config is period 300s, logging off, and creates no disk artifacts', async t => {
  const f = await fixture(t);
  await f.sample();
  assert.match(await f.command(), /period 300s.*logging off/);
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual([...f.commands.keys()], ['tps-stats']);
  assert.deepEqual([...f.events.keys()].sort(), ['session_start', 'session_shutdown', 'model_select', 'turn_start', 'message_update', 'message_end'].sort());
});

test('period uses median; latest mode and both toggle spellings select newest sample', async t => {
  const f = await fixture(t); await f.sample(); await f.sample({ output: 300, ttft: 600 });
  assert.match(await f.command(), /Samples: 2\neff 100.0 t\/s \| 400ms ttft/);
  assert.match(await f.command('mode'), /latest.*\nSamples: 1\neff 150.0 t\/s \| 600ms/);
  assert.match(await f.command('mode toggle'), /period.*\nSamples: 2/);
  assert.match(await f.command('mode latest'), /Samples: 1/);
  assert.match(await f.command('mode period'), /Samples: 2/);
});

test('period seconds, exact cutoff, expiry, and latest after idle', async t => {
  const f = await fixture(t); await f.sample(); await f.command('period 2');
  f.advance(2000); assert.match(await f.command(), /Samples: 1/);
  f.advance(1); assert.match(await f.command(), /No measurements/);
  assert.equal(f.statuses.get('tps'), undefined);
  assert.match(await f.command('mode latest'), /eff 50.0/);
});

test('bounded history keeps at most 200 completed samples', () => {
  const samples = new Measurements();
  for (let i = 0; i < MAX_SAMPLES + 1; i++) samples.add(measure(i + 1, 0, 0, 1000));
  const selected = samples.select({ ...DEFAULT_CONFIG }, 1000);
  assert.equal(selected.length, MAX_SAMPLES); assert.equal(selected[0].outputTokens, 2);
  samples.reset(); assert.deepEqual(samples.select({ ...DEFAULT_CONFIG }, 1000), []);
});

test('reset clears history and an in-flight turn without changing controls', async t => {
  const f = await fixture(t); await f.sample(); await f.command('mode latest'); await f.command('period 10');
  await f.emit('turn_start', { timestamp: f.now() });
  await f.command('reset'); f.advance(2000);
  await f.emit('message_end', { message: { role: 'assistant', usage: { output: 100 } } });
  assert.match(await f.command(), /latest; logging off\nNo measurements/);
  assert.equal(f.statuses.get('tps'), undefined);
  await f.command('mode period'); assert.match(await f.command(), /period 10s/);
});

test('model changes and session replacement clear measurements; session id comes from context', async t => {
  const f = await fixture(t); await f.command('log on'); await f.sample();
  await f.emit('model_select'); assert.match(await f.command(), /No measurements/);
  await f.sample(); await f.emit('session_shutdown');
  f.setId('synthetic-session-002'); await f.emit('session_start');
  assert.match(await f.command(), /logging off\nNo measurements/);
  await f.command('log on'); await f.sample();
  assert.deepEqual((await readdir(join(f.directory, 'logs'))).sort(), ['synthetic-session-001.jsonl', 'synthetic-session-002.jsonl']);
});

test('JSONL is timestamped, metrics-only, session-named, and stops after logging off', async t => {
  const f = await fixture(t); await f.sample(); await f.command('log');
  await f.sample({ privateFields: { prompt: 'PRIVATE_PROMPT', credential: 'PRIVATE_KEY', payload: { secret: 'PRIVATE_PAYLOAD' } } });
  await f.command('log off'); await f.sample();
  const path = logFile(f.directory, 'synthetic-session-001');
  let text = await readFile(path, 'utf8'); const records = text.trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ['timestamp', 'sessionId', 'outputTokens', 'durationMs', 'tps', 'ttftMs'].sort());
  assert.deepEqual(records[0], { timestamp: '2026-11-10T12:00:04.000Z', sessionId: 'synthetic-session-001', outputTokens: 100, durationMs: 2000, tps: 50, ttftMs: 200 });
  assert.doesNotMatch(text, /PRIVATE|prompt|content|payload|credential/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await f.command('log toggle'); await f.sample({ output: 200 });
  text = await readFile(path, 'utf8'); assert.equal(text.trim().split('\n').length, 2);
  await f.command('reset'); assert.equal(await readFile(path, 'utf8'), text);
});

test('global config and explicit save persist controls; normal commands do not save', async t => {
  const f = await fixture(t, { mode: 'latest', periodSeconds: 30, logging: false });
  assert.match(await f.command(), /latest; logging off/);
  await f.command('mode period'); await f.command('period 60'); await f.command('log on');
  assert.deepEqual(await loadConfig(f.directory), { mode: 'latest', periodSeconds: 30, logging: false });
  await f.command('save');
  assert.deepEqual(await loadConfig(f.directory), { mode: 'period', periodSeconds: 60, logging: true });
  assert.equal((await stat(join(f.directory, 'config.json'))).mode & 0o777, 0o600);
  await f.emit('session_start'); assert.match(await f.command(), /period 60s.*logging on/);
});

test('malformed or invalid config falls back to defaults with logging off', async t => {
  const f = await fixture(t);
  for (const text of ['{broken', '{"mode":"latest","logging":"yes"}', 'null', '{"periodSeconds":0}']) {
    await writeFile(join(f.directory, 'config.json'), text);
    await f.emit('session_start');
    assert.equal(f.notices.at(-1).kind, 'warning');
    assert.match(await f.command(), /period 300s.*logging off/);
  }
  assert.throws(() => validateConfig([]));
  assert.deepEqual(validateConfig({ mode: 'latest' }), { ...DEFAULT_CONFIG, mode: 'latest' });
});

test('invalid slash arguments never alter state or persist config', async t => {
  const f = await fixture(t);
  for (const args of ['mode bad', 'period', 'period 0', 'period -1', 'period 1.5', 'period 86401', 'log yes', 'log off extra', 'reset extra', 'save extra', 'unknown']) {
    assert.match(await f.command(args), /^\/tps-stats/);
    assert.equal(f.notices.at(-1).kind, 'warning');
  }
  assert.match(await f.command(), /period 300s.*logging off/);
  assert.deepEqual(await readdir(f.directory), []);
});

test('TTFT uses first text/thinking/toolcall start only; missing TTFT remains unavailable', async t => {
  const f = await fixture(t); await f.command('mode latest');
  for (const type of ['text_start', 'thinking_start', 'toolcall_start']) {
    await f.sample({ type }); assert.match(await f.command(), /200ms ttft/);
  }
  await f.emit('turn_start', { timestamp: f.now() });
  f.advance(100); await f.emit('message_update', { assistantMessageEvent: { type: 'text_delta' } });
  f.advance(100); await f.emit('message_update', { assistantMessageEvent: { type: 'text_start' } });
  f.advance(100); await f.emit('message_update', { assistantMessageEvent: { type: 'thinking_start' } });
  f.advance(1700); await f.emit('message_end', { message: { role: 'assistant', usage: { output: 100 } } });
  assert.match(await f.command(), /200ms ttft/);
  await f.sample({ ttft: null }); assert.match(await f.command(), /ttft unavailable/);
});

test('zero-output, non-assistant, and duplicate completions do not add samples', async t => {
  const f = await fixture(t);
  await f.sample({ output: 0 }); assert.match(await f.command(), /No measurements/);
  await f.sample();
  await f.emit('message_end', { message: { role: 'assistant', usage: { output: 100 } } });
  await f.emit('message_end', { message: { role: 'user', content: 'PRIVATE' } });
  assert.match(await f.command(), /Samples: 1/);
});

test('write failures disable logging without leaking filesystem errors or breaking metrics', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'logs'), 'not a directory');
  await f.command('log on'); await f.sample();
  assert.equal(f.notices.at(-1).kind, 'error');
  assert.doesNotMatch(f.notices.at(-1).text, /ft28-stats-|ENOTDIR/);
  assert.match(await f.command(), /logging off\nSamples: 1/);
});

test('unsafe session IDs and symlink log targets are refused', async t => {
  const f = await fixture(t); const metric = measure(100, 1000, 1200, 3000);
  for (const id of ['../escape', '.', '', '/tmp/escape', 'id.jsonl', 'a/b']) assert.throws(() => logFile(f.directory, id));
  const outside = join(f.directory, 'sentinel'); await writeFile(outside, 'unchanged');
  await appendMeasurement(f.directory, 'safe-id', metric);
  await symlink(outside, logFile(f.directory, 'symlink-id'));
  await assert.rejects(appendMeasurement(f.directory, 'symlink-id', metric));
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  f.setId('../escape'); await f.command('log on'); await f.sample();
  assert.match(await f.command(), /logging off/);
});

test('headless synthetic events retain metrics without UI calls', async t => {
  const f = await fixture(t); f.ctx.hasUI = false;
  f.ctx.ui = new Proxy({}, { get() { throw new Error('headless UI called'); } });
  await f.sample(); await f.command('reset'); await f.emit('session_shutdown');
});
