'use strict';
const { providerTimeout } = require('./ai-provider-timeout');
const { StringDecoder } = require('node:string_decoder');
function aborted() { return Object.assign(new Error('The independent assessment was cancelled.'), { name: 'AbortError', code: 'AI_ASSESSMENT_CANCELLED' }); }
function boundedAwait(promise, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); fn(value); };
    const stop = () => done(reject, aborted());
    const timer = setTimeout(() => done(reject, providerTimeout('Independent assessment', timeoutMs)), timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
  });
}
// Owns only the supplied inference child. A failed/cancelled response never returns partial text.
function collectInference(child, { prompt, timeoutMs, signal, maxOutputBytes = 32768 }) {
  return new Promise((resolve, reject) => {
    let buffer = '', outputBytes = 0, failed = null, settled = false, grace;
    const decoder = new StringDecoder('utf8');
    const messages = [], usage = { inputTokens: 0, outputTokens: 0 };
    const error = (message, code) => Object.assign(new Error(message), { code, aiProvider: true });
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', stop); fn(value); };
    const fail = reason => {
      if (failed || settled) return;
      failed = reason;
      try { child.kill(); } catch { /* wait for close, then report failure */ }
      if (!settled) grace = setTimeout(() => finish(reject, error('The cancelled assessment process did not confirm shutdown.', 'AI_ASSESSMENT_CLEANUP_UNCONFIRMED')), 5000);
    };
    const stop = () => fail(aborted());
    const line = value => {
      if (failed || settled || !value.trim()) return;
      let event; try { event = JSON.parse(value); } catch { fail(error('The assessment returned an invalid event.', 'AI_ASSESSMENT_INVALID')); return; }
      if (event.type === 'error' || event.type === 'turn.failed' || event.error) { fail(error('The independent assessment reported a failed turn.', 'AI_ASSESSMENT_INCOMPLETE')); return; }
      const item = event.item;
      if (item?.type && !['agent_message', 'reasoning'].includes(item.type)) { fail(error('The independent assessment attempted to use a tool.', 'AI_ASSESSMENT_TOOL_DENIED')); return; }
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') messages.push(item.text);
      if (event.type === 'turn.completed' && event.usage) { usage.inputTokens += event.usage.input_tokens || 0; usage.outputTokens += event.usage.output_tokens || 0; }
    };
    const take = chunk => {
      if (failed || settled) return false;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) { fail(error('The independent assessment exceeded its output limit.', 'AI_ASSESSMENT_TOO_LARGE')); return false; }
      return true;
    };
    child.stdout.on('data', chunk => { if (!take(chunk)) return; buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); const lines = buffer.split(/\r?\n/); buffer = lines.pop(); for (const value of lines) line(value); });
    child.stderr.on('data', take);
    child.on('error', () => finish(reject, failed || error('The independent assessment process could not start.', 'AI_ASSESSMENT_START_FAILED')));
    child.on('close', code => {
      if (!failed) line(buffer + decoder.end());
      if (failed) return finish(reject, failed);
      const text = messages.join('\n\n').trim();
      if (code !== 0 || !text) return finish(reject, error('The independent assessment did not return a complete response.', 'AI_ASSESSMENT_INCOMPLETE'));
      finish(resolve, { text, usage, toolCalls: 0, toolsListed: false });
    });
    const timer = setTimeout(() => fail(providerTimeout('Independent assessment', timeoutMs)), timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    if (signal?.aborted) stop();
    if (!failed) child.stdin.end(String(prompt || ''));
  });
}
function drainCompletion(promise, { signal, cleanupMs = 6000 }) {
  return new Promise((resolve, reject) => {
    let settled = false, grace;
    const done = (fn, value) => { if (settled) return; settled = true; clearTimeout(grace); signal?.removeEventListener('abort', stop); fn(value); };
    const stop = () => { if (!grace) grace = setTimeout(() => done(reject, Object.assign(new Error('The cancelled assessment did not confirm cleanup.'), { code: 'AI_ASSESSMENT_CLEANUP_UNCONFIRMED' })), cleanupMs); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    Promise.resolve(promise).then(value => done(signal?.aborted ? reject : resolve, signal?.aborted ? aborted() : value), error => done(reject, error));
  });
}
module.exports = { boundedAwait, collectInference, drainCompletion };
