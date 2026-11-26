#!/usr/bin/env node
/** Tag-only reclassification loss proof: real committed implementation -> real adapter payload. */
import { normalizeAssistantMessage } from './src/reasoning-replay.ts';
import { splitReasoning } from './src/reasoning-tags.ts';

const PI = '/home/bitnom/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist';
const { getApiProvider, registerBuiltInApiProviders } = await import(`${PI}/compat.js`);
registerBuiltInApiProviders();

let cap = null;
const rec = (u, i) => { cap = i?.body ? JSON.parse(i.body) : null; throw new Error('CAPTURED_NO_NETWORK'); };

const model = (api, provider = 'openai', id = 'gpt-x') => ({
  id, name: id, api, provider, baseUrl: 'http://127.0.0.1:9',
  reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const msg = (api, content, provider = 'openai', id = 'gpt-x') => ({
  role: 'assistant', api, provider, model: id,
  content, stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

async function payload(api, blocks) {
  cap = null;
  const m = model(api);
  const ctx = { messages: [
    { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.now() },
    { role: 'assistant', api, provider: 'openai', model: 'gpt-x', content: blocks,
      stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'user', content: [{ type: 'text', text: 'next' }], timestamp: Date.now() },
  ] };
  try {
    const s = getApiProvider(api).stream(m, ctx, { fetch: rec, apiKey: 'k' });
    for await (const _ of s) {}
  } catch (e) { if (!cap) throw e; }
  return cap;
}

const CASES = [
  ['A tag-only: whole message is <thinking>RECOVERED</thinking>',
    [{ type: 'text', text: '<thinking>RECOVERED</thinking>' }]],
  ['B mixed: native thinking + tag-only visible text',
    [{ type: 'thinking', thinking: 'NATIVE', thinkingSignature: 'reasoning_content' },
     { type: 'text', text: '<thinking>RECOVERED</thinking>' }]],
  ['C tag-only + native toolCall',
    [{ type: 'text', text: '<thinking>RECOVERED</thinking>' },
     { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'true' } }]],
  ['D control: tag + visible answer',
    [{ type: 'text', text: '<thinking>RECOVERED</thinking>\nThe answer.' }]],
];

for (const api of ['openai-completions', 'anthropic-messages']) {
  console.log(`\n##### ${api}`);
  for (const [name, source] of CASES) {
    const before = await payload(api, source);
    const n = normalizeAssistantMessage(msg(api, source));
    const normalized = n ? n.content : source;
    const after = await payload(api, normalized);
    const find = (b) => {
      if (api === 'openai-completions') return (b?.messages ?? []).filter((x) => x.role === 'assistant');
      return (b?.messages ?? []).filter((x) => x.role === 'assistant');
    };
    const fb = find(before), fa = find(after);
    const carried = (b) => JSON.stringify(b).includes('RECOVERED');
    console.log(`  ${name}`);
    console.log(`     before: assistantMsgs=${fb.length} carriesRecovered=${carried(before)}  ${JSON.stringify(fb[0] ?? null).slice(0, 110)}`);
    console.log(`     after : assistantMsgs=${fa.length} carriesRecovered=${carried(after)}  ${JSON.stringify(fa[0] ?? null).slice(0, 110)}`);
    console.log(`     => ${fa.length === 0 ? 'MESSAGE DROPPED' : fa.length < fb.length ? 'LOST' : carried(after) || !carried(before) ? 'ok' : 'RECOVERED NOT CARRIED'}`);
  }
}
