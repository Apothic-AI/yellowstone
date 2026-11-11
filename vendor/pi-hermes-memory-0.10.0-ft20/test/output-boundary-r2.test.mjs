// Remaining R2 output boundaries. Actual default direct handler via synthetic
// registry.streamSimple; no injected direct result, real provider, child or store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupBackgroundReview } from '../dist/src/handlers/background-review.js';
import { triggerConsolidation } from '../dist/src/handlers/auto-consolidate.js';

const secret = 'sk-SYNTHETICCREDENT1AL0123456789';
const hostile = 'META-SENTINEL https://endpoint.invalid/private /private/PATH-SENTINEL '
  + secret + '\n\u001b\u0000' + 'x'.repeat(4096);
const branch = Array.from({ length: 4 }, (_, i) => ({ type: 'message', message: {
  role: i % 2 ? 'assistant' : 'user', content: 'PROMPT-SENTINEL ' + i,
} }));
function fixture({ child, empty = false, modelId = 'synthetic-model', provider = 'test-provider' } = {}) {
  const handlers = new Map(), notices = [], attempts = [], calls = [], children = [];
  const model = { provider, id: modelId, api: 'test-api', reasoning: false };
  const ctx = { cwd: '/synthetic', model, modelRegistry: {
    getAll: () => [model],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic', headers: {}, env: {} }),
    streamSimple: m => { attempts.push(m.id); return { result: async () => ({ stopReason: 'stop',
      content: [{ type: 'text', text: empty ? '' : 'BODY-SENTINEL synthetic unparsable prose' }],
    }) }; },
  }, sessionManager: { getBranch: () => branch, getSessionId: () => 'synthetic' },
  ui: { notify: (message, kind) => notices.push({ message, kind }) } };
  const forbidden = async () => { calls.push('FORBIDDEN mutation or lock'); throw Error('offline guard'); };
  const store = { getMemoryEntries: () => [], getUserEntries: () => [],
    add: forbidden, remove: forbidden, replace: forbidden, addFailure: forbidden,
    applyMutationPlan: forbidden, getStorageIdentity: forbidden };
  const exec = async () => { children.push('child'); return child(); };
  const pi = { on: (name, fn) => handlers.set(name, fn), exec };
  return { ctx, store, pi, exec, handlers, notices, attempts, calls, children };
}
function assertSafe(output) {
  for (const marker of ['META-SENTINEL', 'PATH-SENTINEL', 'endpoint.invalid', 'BODY-SENTINEL', 'PROMPT-SENTINEL', secret, '\u001b', '\u0000', '\n']) {
    assert.ok(!output.includes(marker), `leaked ${JSON.stringify(marker)}`);
  }
  assert.ok(output.length < 800);
}
for (const ingress of ['stderr', 'stdout', 'throw']) {
  test(`R2 actual background warning contains no raw child ${ingress}`, async () => {
    const f = fixture({ child: async () => {
      if (ingress === 'throw') throw Error(hostile);
      return ingress === 'stderr' ? { code: 71, stderr: hostile }
        : { code: 71, stdout: 'BODY-SENTINEL PROMPT-SENTINEL ' + hostile };
    } });
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    setupBackgroundReview(f.pi, f.store, null, {
      reviewEnabled: true, nudgeInterval: 1, nudgeToolCalls: 1, reviewRecentMessages: 0,
    }, { deps: { execChildPrompt: f.exec, onReviewSettled: settle } });
    for (let i = 0; i < 3; i++) await f.handlers.get('message_end')({ message: { role: 'user' } }, f.ctx);
    await f.handlers.get('turn_end')({ message: { role: 'assistant', content: [] } }, f.ctx);
    await done;
    await f.handlers.get('session_shutdown')();
    assert.deepEqual(f.attempts, ['synthetic-model']);
    assert.deepEqual(f.children, ['child']);
    assert.deepEqual(f.calls, []);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].kind, 'warning');
    const warning = f.notices[0].message;
    assertSafe(warning);
    assert.match(warning, ingress === 'throw' ? /Subprocess: child_exception\./ : /Subprocess: child_failed \(exit code 71\)\./);
  });
}
for (const exitCode of [Infinity, NaN, -1, 256, 1.5, hostile, 255]) {
  test(`R2 actual background warning bounds numeric exit code (${typeof exitCode}:${Number.isInteger(exitCode) ? exitCode : 'invalid'})`, async () => {
    const f = fixture({ child: async () => ({ code: exitCode, stderr: hostile }) });
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    setupBackgroundReview(f.pi, f.store, null, { reviewEnabled: true, nudgeInterval: 1, nudgeToolCalls: 1, reviewRecentMessages: 0 },
      { deps: { execChildPrompt: f.exec, onReviewSettled: settle } });
    for (let i = 0; i < 3; i++) await f.handlers.get('message_end')({ message: { role: 'user' } }, f.ctx);
    await f.handlers.get('turn_end')({ message: { role: 'assistant', content: [] } }, f.ctx);
    await done;
    await f.handlers.get('session_shutdown')();
    assert.equal(f.notices.length, 1);
    const warning = f.notices[0].message;
    assertSafe(warning);
    assert.match(warning, exitCode === 255 ? /Subprocess: child_failed \(exit code 255\)\./ : /Subprocess: child_failed\./);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.children, ['child']);
  });
}
for (const [provider, modelId] of [['test-provider', secret], [hostile, hostile]]) {
  test(`R2 actual consolidation empty response uses fixed error (${modelId === secret ? 'credential-shaped id' : 'hostile metadata'})`, async () => {
    const f = fixture({ empty: true, provider, modelId, child: async () => { throw Error('FORBIDDEN child'); } });
    const result = await triggerConsolidation(f.pi, f.store, 'memory', undefined, 5000, 'memory', {}, f.ctx);
    assert.equal(result.consolidated, false);
    assertSafe(result.error);
    assert.equal(result.error, 'The active model returned an empty completion; no consolidation attempted');
    assert.deepEqual(f.attempts, [modelId]);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.children, []);
  });
}
