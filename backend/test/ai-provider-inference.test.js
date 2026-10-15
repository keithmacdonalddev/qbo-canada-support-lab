'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const config = require('../src/config'), provider = require('../src/modules/ai-provider'), codex = require('../src/modules/codex-cli');
test('inference-only Codex completion forwards bounds and cancellation without a bridge', async t => {
  const calls = [], controller = new AbortController();
  t.mock.method(codex, 'run', async options => { calls.push(options); return { text: '{"ok":true}', usage: {} }; });
  const result = await provider.complete({ system: 'bounded test', prompt: 'synthetic', provider: 'codex', timeoutMs: 1000, signal: controller.signal, maxOutputBytes: 256, inferenceOnly: true });
  assert.equal(result.text, '{"ok":true}'); assert.equal(calls.length, 1); assert.equal(calls[0].signal, controller.signal); assert.equal(calls[0].timeoutMs, 1000); assert.equal(calls[0].maxOutputBytes, 256); assert.equal(calls[0].inferenceOnly, true); assert.equal(calls[0].bridge, undefined);
});
test('Anthropic assessment has no tools or retry and rejects partial/oversized responses', async () => {
  const previous = { ...config.ai }, key = 'isolated-assessment-provider-key', calls = [], controller = new AbortController(); let reply = { content: [{ type: 'text', text: '{"ok":true}' }], usage: {} };
  config.ai.userKeysEnabled = true;
  provider._internal.clientCache.set(key, { messages: { create: async (params, options) => { calls.push({ params, options }); return reply; } } });
  const invoke = () => provider.complete({ system: 'bounded test', prompt: 'synthetic', provider: 'anthropic', userApiKey: key, timeoutMs: 1000, signal: controller.signal, maxOutputBytes: 256, inferenceOnly: true });
  try {
    await invoke(); assert.equal(calls[0].params.tools, undefined); assert.equal(calls[0].options.signal, controller.signal); assert.equal(calls[0].options.maxRetries, 0); assert.ok(calls[0].options.timeout > 0);
    reply = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }; await assert.rejects(invoke(), error => error.code === 'AI_ASSESSMENT_INCOMPLETE');
    reply = { content: [{ type: 'tool_use', id: 'bad', name: 'createRecord', input: {} }] }; await assert.rejects(invoke(), error => error.code === 'AI_ASSESSMENT_INCOMPLETE');
    reply = { content: [{ type: 'text', text: 'é'.repeat(129) }] }; await assert.rejects(invoke(), error => error.code === 'AI_ASSESSMENT_TOO_LARGE');
    provider._internal.clientCache.get(key).messages.create = async () => { calls.push('failure'); throw Object.assign(new Error('fixture failure'), { status: 503 }); };
    const before = calls.length; await assert.rejects(invoke(), /fixture failure/); assert.equal(calls.length, before + 1);
  } finally { Object.assign(config.ai, previous); provider._internal.clientCache.delete(key); }
});
test('already cancelled inference starts no provider and invalid budgets are rejected', async t => {
  let calls = 0; t.mock.method(codex, 'run', async () => { calls++; return { text: 'unused' }; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.complete({ provider: 'codex', signal: controller.signal, timeoutMs: 1000, maxOutputBytes: 256 }), error => error.name === 'AbortError');
  await assert.rejects(provider.complete({ provider: 'codex', timeoutMs: -1 }), TypeError);
  await assert.rejects(provider.complete({ provider: 'codex', maxOutputBytes: 2000000 }), TypeError); assert.equal(calls, 0);
});
