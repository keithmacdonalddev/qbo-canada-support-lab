'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk').default;
const config = require('../src/config');
const codexCli = require('../src/modules/codex-cli');
const aiProvider = require('../src/modules/ai-provider');
const { isProviderTimeout } = require('../src/modules/ai-provider-timeout');

const { clientCache, timing, providerMemory } = aiProvider._internal;
const apiError = (status, message = 'x', headers) => new Anthropic.APIError(status, { type: 'error', error: { type: 'x', message } }, undefined, headers);

// A fake Anthropic client that fails with the given errors, then answers.
function fakeClient(key, failures) {
  const calls = [];
  clientCache.set(key, { messages: { async create(params, options) {
    calls.push(options);
    const next = failures.shift();
    if (next) throw next;
    return { content: [{ type: 'text', text: 'ok' }], usage: {} };
  } } });
  return calls;
}

function withSleeps(fn) {
  return async () => {
    const original = timing.sleep;
    const sleeps = [];
    timing.sleep = async (ms) => { sleeps.push(ms); };
    try { await fn(sleeps); } finally { timing.sleep = original; }
  };
}

test('overload, rate limit, server and network errors are retried, then answer', withSleeps(async (sleeps) => {
  const calls = fakeClient('k-retry', [apiError(529), new Anthropic.APIConnectionError({ message: 'reset' })]);
  const response = await aiProvider.chat([{ role: 'user', content: 'hi' }], [], { apiKey: 'k-retry', timeoutMs: 120000 });
  assert.equal(response.content[0].text, 'ok');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((options) => options.maxRetries === 0 && options.timeout > 0));
  assert.equal(sleeps.length, 2);
}));

test('a retry-after header sets the wait, capped', withSleeps(async (sleeps) => {
  fakeClient('k-after', [apiError(429, 'slow down', new Headers({ 'retry-after': '3' })), apiError(429, 'slow', new Headers({ 'retry-after': '999' }))]);
  await aiProvider.chat([{ role: 'user', content: 'hi' }], [], { apiKey: 'k-after' });
  assert.deepEqual(sleeps, [3000, 20000]);
}));

test('the final failure is plain English and says what to do', withSleeps(async () => {
  fakeClient('k-over', [apiError(529), apiError(529), apiError(529)]);
  await assert.rejects(aiProvider.chat([], [], { apiKey: 'k-over' }), (err) => {
    assert.equal(err.aiProvider, true);
    assert.equal(err.status, 529);
    assert.match(err.message, /overloaded right now \(tried 3 times\)\. Wait a few minutes/);
    return true;
  });
  const calls = fakeClient('k-auth', [apiError(401)]);
  await assert.rejects(aiProvider.chat([], [], { apiKey: 'k-auth' }), (err) => err.status === 401 && /key was rejected/.test(err.message));
  assert.equal(calls.length, 1, 'authentication errors are not retried');
  fakeClient('k-credit', [apiError(400, 'Your credit balance is too low to access the Anthropic API.')]);
  await assert.rejects(aiProvider.chat([], [], { apiKey: 'k-credit' }), /out of credit/);
  fakeClient('k-model', [apiError(404, 'model: nope')]);
  await assert.rejects(aiProvider.chat([], [], { apiKey: 'k-model', model: 'nope' }), /model "nope" was not found/);
}));

test('a timeout is not retried and stays a resumable provider timeout', withSleeps(async (sleeps) => {
  const calls = fakeClient('k-timeout', [new Anthropic.APIConnectionTimeoutError()]);
  await assert.rejects(aiProvider.chat([], [], { apiKey: 'k-timeout', timeoutMs: 60000 }), (err) => isProviderTimeout(err));
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
}));

test('no retry is started that could not finish inside the time budget', withSleeps(async (sleeps) => {
  const calls = fakeClient('k-budget', [apiError(503)]);
  await assert.rejects(aiProvider.chat([], [], { apiKey: 'k-budget', timeoutMs: 3000 }), (err) => err.status === 503);
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
}));

test('a stored user key falls back to the server key while user keys are disabled', () => {
  const saved = { ...config.ai };
  try {
    Object.assign(config.ai, { userKeysEnabled: false, globalKeyEnabled: true, anthropicApiKey: 'server-key' });
    assert.equal(aiProvider.resolveApiKey({ userApiKey: 'user-key' }), 'server-key');
    Object.assign(config.ai, { userKeysEnabled: true });
    assert.equal(aiProvider.resolveApiKey({ userApiKey: 'user-key' }), 'user-key');
    Object.assign(config.ai, { userKeysEnabled: false, globalKeyEnabled: false });
    assert.throws(() => aiProvider.resolveApiKey({ userApiKey: 'user-key' }), /Personal API keys are turned off/);
  } finally {
    Object.assign(config.ai, saved);
  }
});

test('auto mode re-checks a failed Codex sign-in and keeps a recent good one', async () => {
  const savedProvider = config.ai.provider;
  const savedStatus = codexCli.getStatus;
  const checks = [];
  let answers = [];
  codexCli.getStatus = async (options = {}) => { checks.push(options.refresh === true); return answers.shift(); };
  try {
    config.ai.provider = 'auto';
    providerMemory.codexOkAt = 0;
    answers = [{ installed: true, loggedIn: false }, { installed: true, loggedIn: true }];
    assert.equal(await aiProvider.resolveProvider(), 'codex');
    assert.deepEqual(checks, [false, true]);

    answers = [{ installed: true, loggedIn: false }, { installed: true, loggedIn: false }];
    assert.equal(await aiProvider.resolveProvider(), 'codex', 'a transient failure does not flip providers');

    providerMemory.codexOkAt = Date.now() - 11 * 60 * 1000;
    answers = [{ installed: true, loggedIn: false }, { installed: true, loggedIn: false }];
    assert.equal(await aiProvider.resolveProvider(), 'anthropic');

    answers = [{ installed: false, loggedIn: false }];
    providerMemory.codexOkAt = Date.now();
    assert.equal(await aiProvider.resolveProvider(), 'anthropic', 'an uninstalled CLI is never kept');

    checks.length = 0;
    assert.equal(await aiProvider.resolveProvider({ provider: 'anthropic' }), 'anthropic');
    assert.equal(checks.length, 0, 'a provider resolved for the run is reused without checking');
  } finally {
    config.ai.provider = savedProvider;
    codexCli.getStatus = savedStatus;
    providerMemory.codexOkAt = 0;
  }
});

test('Claude defaults are current models with room for tool turns', () => {
  if (!process.env.AI_MODEL_FAST) assert.equal(config.ai.modelFast, 'claude-sonnet-5-5');
  if (!process.env.AI_MODEL_DEEP) assert.equal(config.ai.modelDeep, 'claude-opus-5-5');
  if (!process.env.AI_MAX_TOKENS) assert.ok(config.ai.maxTokens >= 16000);
});
