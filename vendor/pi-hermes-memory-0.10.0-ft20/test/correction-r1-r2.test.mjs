// Synthetic, offline production-entry regressions. No provider, process or disk store.
// FT20_DIST selects the exact rejected candidate for negative controls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
const dist = process.env.FT20_DIST ? pathToFileURL(process.env.FT20_DIST + '/') : new URL('../dist/', import.meta.url);
const load = (name) => import(new URL(`src/handlers/${name}.js`, dist));
const { runDirectMemoryCompletion } = await load('review-memory-ops');
const { setupBackgroundReview, describeDiagnostics } = await load('background-review');
const { setupSessionFlush } = await load('session-flush');
const { setupCorrectionDetector } = await load('correction-detector');
const { triggerConsolidation } = await load('auto-consolidate');
const primary = { provider: 'test-provider', id: 'primary', api: 'test-api', reasoning: false };
const fallback = { ...primary, id: 'fallback' };
const config = { llmModelOverride: 'test-provider/primary', llmFallbackModels: ['test-provider/fallback'] };
const branch = Array.from({ length: 4 }, (_, i) => ({ type: 'message', message: {
  role: i % 2 ? 'assistant' : 'user', content: 'synthetic public fixture ' + i,
} }));
function ctx(models = [primary, fallback]) {
  const notices = [];
  return { notices, model: models[0], cwd: '/synthetic',
    modelRegistry: { getAll: () => models, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic', headers: {}, env: {} }) },
    sessionManager: { getSessionId: () => 'synthetic', getBranch: () => branch },
    ui: { notify: (...args) => notices.push(args) },
  };
}
const add = { action: 'add', target: 'memory', content: 'synthetic durable fact' };
const remove = { action: 'remove', target: 'memory', old_text: 'absent' };
const payload = JSON.stringify({ operations: [add, remove] });
function storeDouble(mode = 'skip') {
  const calls = [];
  return { calls, getMemoryEntries: () => [], getUserEntries: () => [],
    add: async () => { calls.push('add'); if (mode === 'first-throw') throw Error('STORE-PRIVATE-SENTINEL'); return { success: true }; },
    remove: async () => { calls.push('remove'); if (mode === 'throw') throw Error('STORE-PRIVATE-SENTINEL'); return { success: false }; },
    addFailure: async () => { calls.push('addFailure'); return { success: true }; },
    applyMutationPlan: async () => { calls.push('atomic'); throw Error('STORE-PRIVATE-SENTINEL'); },
  };
}
function runner(text = payload, stopReason = 'stop') {
  const attempts = [];
  const run = (c, s, p, options, db, project) => runDirectMemoryCompletion(c, s, p, options, db, project, {
    completeSimple: async (model) => { attempts.push(model.id); return { stopReason, content: [{ type: 'text', text }] }; },
  });
  return { run, attempts };
}
async function direct(mode, { atomic = false, signal, text = payload, models, stopReason } = {}) {
  const c = ctx(models), s = storeDouble(mode), r = runner(text, stopReason);
  const result = await r.run(c, s, null, { userPrompt: 'synthetic', systemPrompt: 'synthetic', config: models ? {} : config,
    requireAtomicShrink: atomic, signal });
  return { result, calls: s.calls, attempts: r.attempts };
}
for (const [mode, confirmed, unknown] of [['skip', 1, 0], ['throw', 1, 1], ['first-throw', 0, 1]]) {
  test(`R1 ${mode}: terminal partial, truthful lower bound, no second model`, async () => {
    const { result, calls, attempts } = await direct(mode);
    assert.equal(result.fallbackReason, 'partial_apply');
    assert.equal(result.terminalPartial, true);
    assert.equal(result.ok, false);
    assert.equal(result.appliedCount, confirmed);
    assert.equal(result.unknownMutationCount ?? 0, unknown);
    assert.deepEqual(attempts, ['primary']);
    assert.deepEqual(calls, mode === 'first-throw' ? ['add'] : ['add', 'remove']);
    assert.ok(!JSON.stringify(result).includes('STORE-PRIVATE-SENTINEL'));
  });
}
test('R1 atomic throwing call is bounded unknown, not zero-write failure/retry', async () => {
  const { result, calls, attempts } = await direct('throw', { atomic: true });
  assert.equal(result.terminalPartial, true);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.unknownMutationCount, 2);
  assert.deepEqual(calls, ['atomic']);
  assert.deepEqual(attempts, ['primary']);
});
test('R1 abort after confirmed write retains count and is terminal', async () => {
  const c = ctx(), s = storeDouble(), r = runner(), ac = new AbortController();
  s.add = async () => { s.calls.push('add'); ac.abort(); return { success: true }; };
  const result = await r.run(c, s, null, { userPrompt: 'synthetic', systemPrompt: 'synthetic', config, signal: ac.signal });
  assert.equal(result.terminalPartial, true);
  assert.equal(result.appliedCount, 1);
  assert.deepEqual(s.calls, ['add']);
  assert.deepEqual(r.attempts, ['primary']);
});
test('R1 zero-write skipped operation still permits configured model retry', async () => {
  const { result, calls, attempts } = await direct('skip', { text: JSON.stringify({ operations: [remove] }) });
  assert.equal(result.fallbackReason, 'invalid_operations');
  assert.equal(result.appliedCount, 0);
  assert.deepEqual(calls, ['remove', 'remove']);
  assert.deepEqual(attempts, ['primary', 'fallback']);
});
async function background(c, s, runDirectReview, { childCode = 0 } = {}) {
  const handlers = new Map(), childCalls = [];
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const pi = { on: (name, fn) => handlers.set(name, fn) };
  setupBackgroundReview(pi, s, null, { ...config, reviewEnabled: true, nudgeInterval: 1, nudgeToolCalls: 1, reviewRecentMessages: 0 }, {
    deps: { runDirectReview, execChildPrompt: async () => { childCalls.push('child'); return { code: childCode, stderr: 'synthetic child failure' }; }, onReviewSettled: settle },
  });
  for (let i = 0; i < 3; i++) await handlers.get('message_end')({ message: { role: 'user' } }, c);
  await handlers.get('turn_end')({ message: { role: 'assistant', content: [] } }, c);
  await settled;
  await handlers.get('session_shutdown')();
  return childCalls;
}
for (const mode of ['skip', 'throw', 'first-throw']) for (const caller of ['background', 'compact-flush', 'shutdown-flush', 'correction', 'consolidation']) {
  test(`R1 actual ${caller} ${mode} entry honors terminal result and suppresses mutating fallback`, async () => {
    const c = ctx(), s = storeDouble(mode), r = runner(), childCalls = [];
    s.getStorageIdentity = async () => { s.calls.push('FORBIDDEN-lock'); throw Error('forbidden lock access'); };
    const handlers = new Map();
    const pi = { on: (name, fn) => handlers.set(name, fn), exec: async () => {
      childCalls.push('child'); throw Error('FORBIDDEN subprocess reached stub');
    } };
    let warning;
    if (caller === 'background') {
      childCalls.push(...await background(c, s, r.run));
    } else if (caller.endsWith('flush')) {
      setupSessionFlush(pi, s, null, { ...config, flushMinTurns: 1, flushOnCompact: true, flushOnShutdown: true }, null, null,
        { runDirectMemoryCompletion: r.run });
      await handlers.get('message_end')({ message: { role: 'user' } }, c);
      await handlers.get(caller === 'compact-flush' ? 'session_before_compact' : 'session_shutdown')({ reason: 'exit' }, c);
    } else if (caller === 'correction') {
      setupCorrectionDetector(pi, s, null, { ...config, correctionDetection: true, correctionStrongPatterns: ['^synthetic correction'], correctionNegativePatterns: [] }, null, null,
        { runDirectMemoryCompletion: r.run });
      await handlers.get('message_end')({ message: { role: 'user', content: 'synthetic correction use safe values' } }, c);
      await handlers.get('turn_end')({}, c);
    } else {
      const result = await triggerConsolidation(pi, s, 'memory', undefined, 1000, 'memory', config, c, null, null,
        { runDirectMemoryCompletion: r.run });
      assert.equal(result.consolidated, false);
      warning = result.error;
    }
    assert.deepEqual(childCalls, []);
    assert.deepEqual(r.attempts, ['primary']);
    assert.deepEqual(s.calls, caller === 'consolidation' ? ['atomic'] : mode === 'first-throw' ? ['add'] : ['add', 'remove']);
    warning ??= c.notices.find(([, kind]) => kind === 'warning')?.[0];
    assert.match(warning, /partially applied: [01] confirmed operation/);
    assert.match(warning, /No retry or fallback attempted/);
    if (caller === 'consolidation') assert.match(warning, /up to 2 additional mutation/);
    else if (mode !== 'skip') assert.match(warning, /up to 1 additional mutation/);
  });
}
for (const caller of ['background', 'flush', 'correction']) {
  test(`R1 ${caller}: notification exception cannot trigger fallback or extra writes`, async () => {
    const c = ctx(), s = storeDouble(), r = runner();
    c.ui.notify = () => { throw Error('synthetic stale UI'); };
    let children = 0;
    const handlers = new Map(), pi = { on: (name, fn) => handlers.set(name, fn), exec: async () => { children++; throw Error('forbidden child stub'); } };
    if (caller === 'background') assert.deepEqual(await background(c, s, r.run), []);
    if (caller === 'flush') {
      setupSessionFlush(pi, s, null, { ...config, flushMinTurns: 1, flushOnCompact: true }, null, null, { runDirectMemoryCompletion: r.run });
      await handlers.get('message_end')({ message: { role: 'user' } }, c);
      await handlers.get('session_before_compact')({}, c);
    }
    if (caller === 'correction') {
      setupCorrectionDetector(pi, s, null, { ...config, correctionDetection: true, correctionStrongPatterns: ['synthetic'], correctionNegativePatterns: [] }, null, null, { runDirectMemoryCompletion: r.run });
      await handlers.get('message_end')({ message: { role: 'user', content: 'synthetic correction' } }, c);
      await handlers.get('turn_end')({}, c);
    }
    assert.equal(children, 0);
    assert.deepEqual(r.attempts, ['primary']);
    assert.deepEqual(s.calls, ['add', 'remove']);
  });
}
test('R1 background successful writes plus stale UI cannot trigger fallback', async () => {
  const c = ctx(), s = storeDouble(), r = runner(JSON.stringify({ operations: [add] }));
  c.ui.notify = () => { throw Error('synthetic stale UI'); };
  assert.deepEqual(await background(c, s, r.run), []);
  assert.deepEqual(s.calls, ['add']);
  assert.deepEqual(r.attempts, ['primary']);
});
const hostile = 'PRIVATE-SENTINEL https://endpoint.invalid/private sk-KEY-SENTINEL /private/PATH-SENTINEL \n\u001b' + 'x'.repeat(4096);
for (const metadata of ['stopReason', 'provider', 'id', 'plausible-id']) {
  test(`R2 ${metadata}: no sentinel in returned diagnostics or actual background warning`, async () => {
    const models = [{ ...primary }];
    if (metadata === 'provider' || metadata === 'id') models[0][metadata] = hostile;
    if (metadata === 'plausible-id') models[0].id = 'sk-KEY-SENTINEL';
    const c = ctx(models), s = storeDouble(), r = runner('synthetic unparsable prose', metadata === 'stopReason' ? hostile : 'stop');
    const result = await r.run(c, s, null, { userPrompt: 'PROMPT-SENTINEL', systemPrompt: 'synthetic', config: {} });
    const encoded = JSON.stringify(result), rendered = describeDiagnostics(result.diagnostics);
    assert.ok(encoded.length < 900);
    assert.ok(rendered.length <= 512);
    assert.equal(result.diagnostics.stopReason, metadata === 'stopReason' ? 'unknown' : 'stop');
    await background(c, s, async () => result, { childCode: 1 });
    assert.equal(c.notices.length, 1);
    const warning = c.notices[0][0];
    for (const output of [encoded, rendered, warning]) for (const sentinel of ['PRIVATE-SENTINEL', 'KEY-SENTINEL', 'PATH-SENTINEL', 'endpoint.invalid', 'PROMPT-SENTINEL', '\u001b', '\n']) {
      assert.ok(!output.includes(sentinel), `leaked ${sentinel}`);
    }
    assert.ok(warning.length < 800);
    assert.deepEqual(s.calls, []);
  });
}
test('R2 renderer recontains hostile injected diagnostics including counts and reason codes', () => {
  const rendered = describeDiagnostics({ model: hostile, stopReason: hostile, responseChars: hostile, promptChars: Infinity,
    invalidOperationCount: -1, reasonCodes: [hostile, ...Array(1000).fill('unknown_action')] });
  assert.ok(rendered.length <= 512);
  assert.ok(!rendered.includes('SENTINEL'));
  assert.match(rendered, /stopReason=unknown/);
  assert.match(rendered, /responseChars=0 promptChars=0/);
});
test('R2 stop reasons use only the fixed runtime vocabulary', async () => {
  for (const stopReason of ['stop', 'length', 'toolUse', 'error', 'aborted', 'unknown', {}, null, 'STOP', 'length\\n']) {
    const { result } = await direct('skip', { text: 'synthetic prose', stopReason });
    if (result.diagnostics) assert.equal(result.diagnostics.stopReason,
      ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(stopReason) ? stopReason : 'unknown');
  }
});
test('R2 thinking provider notice cannot echo hostile model metadata', async () => {
  const c = ctx([{ ...primary, provider: hostile, id: hostile }]), notices = [];
  const result = await runDirectMemoryCompletion(c, storeDouble(), null,
    { userPrompt: 'synthetic', systemPrompt: 'synthetic', config: {} }, null, null,
    { completeSimple: async () => ({ stopReason: 'stop', content: [{ type: 'thinking', thinking: 'synthetic prose' }] }),
      onProviderNotice: message => notices.push(message), providerNoticeState: { logged: false } });
  assert.equal(notices.length, 1);
  assert.ok(!JSON.stringify([result, notices]).includes('SENTINEL'));
});
test('R2 provider-error response cannot echo secret metadata via error field', async () => {
  const c = ctx(), s = storeDouble();
  const result = await runDirectMemoryCompletion(c, s, null, { userPrompt: 'synthetic', systemPrompt: 'synthetic', config: {} }, null, null,
    { completeSimple: async () => ({ stopReason: 'error', errorMessage: hostile, content: [] }) });
  assert.equal(result.fallbackReason, 'provider_error');
  assert.ok(!JSON.stringify(result).includes('SENTINEL'));
});
