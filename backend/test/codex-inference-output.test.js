'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { collectInference, drainCompletion, boundedAwait } = require('../src/modules/codex-inference-output');
function child(autoClose = true) {
  const value = new EventEmitter(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.stdin = new PassThrough(); value.kills = 0;
  value.kill = () => { value.kills++; if (autoClose) queueMicrotask(() => value.emit('close', 1)); return true; };
  return value;
}
const event = text => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n';
test('inference accepts only complete bounded UTF-8 text and keeps no tool bridge', async () => {
  const c = child(), result = collectInference(c, { prompt: 'safe', timeoutMs: 1000, maxOutputBytes: 2048 });
  const bytes = Buffer.from(event('évidence') + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2 } }) + '\n');
  const at = bytes.indexOf(Buffer.from('é'));
  c.stdout.write(bytes.subarray(0, at + 1)); c.stdout.write(bytes.subarray(at + 1)); c.emit('close', 0);
  const done = await result; assert.equal(done.text, 'évidence'); assert.equal(done.toolCalls, 0); assert.deepEqual(done.usage, { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1 });
});
test('stdout/stderr floods, invalid events and attempted MCP calls kill only the supplied child', async () => {
  for (const mode of ['stdout', 'stderr', 'invalid', 'tool']) {
    const c = child(), result = collectInference(c, { prompt: '', timeoutMs: 1000, maxOutputBytes: 256 });
    if (mode === 'stdout' || mode === 'stderr') c[mode].write('x'.repeat(257));
    if (mode === 'invalid') c.stdout.write('not JSON\n');
    if (mode === 'tool') c.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call' } }) + '\n');
    await assert.rejects(result, error => /AI_ASSESSMENT_/.test(error.code)); assert.equal(c.kills, 1);
  }
});
test('abort and caller drain wait for delayed child close before reporting completion', async () => {
  const c = child(false), controller = new AbortController();
  let ended = false;
  const collected = collectInference(c, { prompt: 'bounded', timeoutMs: 1000, signal: controller.signal, maxOutputBytes: 2048 });
  const result = drainCompletion(collected, { signal: controller.signal, cleanupMs: 500 }).finally(() => { ended = true; });
  const rejected = assert.rejects(result, error => error.name === 'AbortError');
  controller.abort(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(c.kills, 1); assert.equal(ended, false);
  c.emit('close', 1); await rejected; assert.equal(ended, true);
});
test('timeout discards partial text and waits for owned process close', async () => {
  const c = child(), result = collectInference(c, { prompt: '', timeoutMs: 5, maxOutputBytes: 2048 }); c.stdout.write(event('partial'));
  await assert.rejects(result, error => error.code === 'AI_PROVIDER_TIMEOUT'); assert.equal(c.kills, 1);
});
test('a completion ignoring cancellation reports cleanup unconfirmed instead of a result', async () => {
  const controller = new AbortController(), result = drainCompletion(new Promise(() => {}), { signal: controller.signal, cleanupMs: 5 }); controller.abort();
  await assert.rejects(result, error => error.code === 'AI_ASSESSMENT_CLEANUP_UNCONFIRMED');
});
test('bounded preparation rejects abort without consuming a late value', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(boundedAwait(Promise.resolve('late'), { signal: controller.signal, timeoutMs: 100 }), error => error.name === 'AbortError');
});

test('explicit provider failure after valid text cannot become a result even on zero exit', async () => {
  for (const type of ['error', 'turn.failed']) {
    const c = child(false), result = collectInference(c, { prompt: '', timeoutMs: 1000, maxOutputBytes: 2048 });
    c.stdout.write(event('{"coverage":"complete"}')); c.stdout.write(JSON.stringify({ type, error: { message: 'synthetic turn failure' } }) + '\n'); c.emit('close', 0);
    await assert.rejects(result, error => error.code === 'AI_ASSESSMENT_INCOMPLETE'); assert.equal(c.kills, 1);
  }
});
