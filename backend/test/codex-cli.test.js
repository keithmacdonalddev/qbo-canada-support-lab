'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripCodingCatalogFields, createToolAccessCheck } = require('../src/modules/codex-cli');
const { handleMcpRequest } = require('../src/modules/ai-tool-bridge');

test('the model catalog copy keeps MCP tools visible and coding tools off', () => {
  const catalog = stripCodingCatalogFields({
    models: [{
      slug: 'gpt-6.1-sol', tool_mode: 'code_mode_only', supports_search_tool: true, node_repl_disabled: false,
      experimental_supported_tools: ['clock'], multi_agent_version: 'v2', apply_patch_tool_type: 'freeform',
      model_messages: { multi_agent: {}, approvals: {} },
    }, { slug: 'gpt-5.5', supports_search_tool: true }],
  });
  for (const model of catalog.models) {
    assert.equal(model.supports_search_tool, false);
    assert.equal(model.node_repl_disabled, true);
    assert.deepEqual(model.experimental_supported_tools, []);
    assert.equal(model.tool_mode, undefined);
    assert.equal(model.apply_patch_tool_type, undefined);
  }
  assert.deepEqual(Object.keys(catalog.models[0].model_messages), ['approvals']);
});

// Stands in for Codex: asks the real bridge for its tools and calls the
// probe tool, then reports bridge activity the way run() does.
function fakeCodex({ list = true, call = true, text, calls } = {}) {
  return async ({ prompt, bridge, effort }) => {
    if (calls) calls.push({ prompt, effort });
    const before = bridge.stats();
    if (list) await handleMcpRequest(bridge.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    if (call) {
      const value = text ?? /"([^"]+)"/.exec(prompt)[1];
      await handleMcpRequest(bridge.token, {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echoProbe', arguments: { text: value } },
      });
    }
    const after = bridge.stats();
    return { text: 'done', usage: {}, toolsListed: after.listed > before.listed, toolCalls: after.calls - before.calls };
  };
}

function memoryStore() {
  const saved = new Map();
  return { saved, read: (key) => saved.get(key) || null, write: (key, value) => saved.set(key, value) };
}

function checker(overrides = {}) {
  const clock = { now: Date.parse('2026-10-08T12:00:00Z') };
  const identity = { key: 'binary-a', model: 'gpt-6.1-sol', codexVersion: '0.161.0' };
  const check = createToolAccessCheck({
    identify: async () => identity,
    store: null,
    now: () => clock.now,
    ...overrides,
  });
  return { check, clock, identity };
}

test('a probe passes only when the model calls the tool with the expected text', async () => {
  const calls = [];
  const { check } = checker({ runCodex: fakeCodex({ calls }) });
  const result = await check.verify();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'passed');
  assert.equal(result.reason, null);
  assert.equal(result.codexVersion, '0.161.0');
  assert.equal(result.model, 'gpt-6.1-sol');
  assert.equal(result.checkedAt, '2026-10-08T12:00:00.000Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].effort, 'low');
  assert.deepEqual(check.last(), result);
});

test('results are cached per Codex binary and model, and refresh re-probes', async () => {
  const calls = [];
  const { check, identity } = checker({ runCodex: fakeCodex({ calls }) });
  await check.verify();
  await check.verify();
  assert.equal(calls.length, 1);
  await check.verify({ refresh: true });
  assert.equal(calls.length, 2);
  identity.key = 'binary-b'; // Codex upgraded or model changed
  await check.verify();
  assert.equal(calls.length, 3);
});

test('concurrent callers share one probe', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const inner = fakeCodex({ calls });
  const { check } = checker({ runCodex: async (options) => { await gate; return inner(options); } });
  const first = check.verify();
  const second = check.verify({ refresh: true });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  assert.equal(a.ok, true);
});

test('tools that are listed but never called fail in plain English after one retry', async () => {
  const calls = [];
  const { check, clock } = checker({ runCodex: fakeCodex({ call: false, calls }) });
  const result = await check.verify();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, "The installed Codex CLI (0.161.0) did not expose this app's tools to the model, so the assistant was not started.");
  assert.equal(calls.length, 2);
  await check.verify();
  assert.equal(calls.length, 2, 'a failure is cached briefly');
  clock.now += 11 * 60 * 1000;
  await check.verify();
  assert.equal(calls.length, 4, 'and re-checked after it expires');
});

test('a run that never loads the tools, or calls with the wrong text, fails', async () => {
  const unlisted = await checker({ runCodex: fakeCodex({ list: false, call: false }) }).check.verify();
  assert.equal(unlisted.status, 'failed');
  assert.match(unlisted.reason, /did not load this app's tools/);

  const wrong = await checker({ runCodex: fakeCodex({ text: 'something else' }) }).check.verify();
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.reason, /wrong input/);
});

test('a Codex error is reported, cached for a minute, then retried', async () => {
  let attempts = 0;
  const { check, clock } = checker({
    runCodex: async () => { attempts += 1; throw new Error('Codex CLI is not signed in.'); },
  });
  const result = await check.verify();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.reason, /tool check.*not signed in/);
  await check.verify();
  assert.equal(attempts, 1);
  clock.now += 61 * 1000;
  await check.verify();
  assert.equal(attempts, 2);
});

test('a missing Codex install fails without probing', async () => {
  let attempts = 0;
  const check = createToolAccessCheck({ identify: async () => null, store: null, runCodex: async () => { attempts += 1; } });
  const result = await check.verify();
  assert.equal(result.status, 'not-installed');
  assert.equal(result.ok, false);
  assert.equal(attempts, 0);
});

test('only passes are stored, and a stored pass is reused until it is a day old', async () => {
  const store = memoryStore();
  const failing = checker({ store, runCodex: fakeCodex({ call: false }) });
  await failing.check.verify();
  assert.equal(store.saved.size, 0);

  const passing = checker({ store, runCodex: fakeCodex() });
  await passing.check.verify();
  assert.equal(store.saved.get('binary-a').ok, true);

  const calls = [];
  const restarted = checker({ store, runCodex: fakeCodex({ calls }) });
  assert.equal((await restarted.check.verify()).ok, true);
  assert.equal(calls.length, 0);

  const nextDay = checker({ store, runCodex: fakeCodex({ calls }) });
  nextDay.clock.now += 25 * 60 * 60 * 1000;
  await nextDay.check.verify();
  assert.equal(calls.length, 1);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const config = require('../src/config');
const codexModule = require('../src/modules/codex-cli');

test('PATH discovery returns a binary identity on a headless host and honors explicit paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdl-codex-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'codex'); fs.writeFileSync(binary, '', { mode: 0o700 });
  assert.equal(codexModule.resolveExecutable({ platform: 'linux', cliPath: null, env: { PATH: dir } }), binary);
  assert.equal(codexModule.resolveExecutable({ cliPath: binary }), binary);
  assert.equal(codexModule.resolveExecutable({ cliPath: path.join(dir, 'absent'), env: { PATH: dir } }), null);
  assert.equal(codexModule.resolveExecutable({ cliPath: dir }), null);
});

function mockLogin(t, result) {
  const filename = require.resolve('../src/modules/codex-cli'); const savedModule = require.cache[filename];
  const savedPath = config.ai.codex.cliPath; config.ai.codex.cliPath = __filename;
  const calls = [];
  t.mock.method(cp, 'execFile', (exe, args, options, callback) => {
    calls.push({ exe, args, options });
    if (args.includes('--version')) callback(null, 'codex-cli 0.161.0', '');
    else callback(result.error || null, result.stdout || '', result.stderr || '');
  });
  delete require.cache[filename]; const adapter = require(filename);
  t.after(() => { config.ai.codex.cliPath = savedPath; require.cache[filename] = savedModule; });
  return { adapter, calls };
}

test('login status and refresh use the service file store and never send backend secrets', async t => {
  const { adapter, calls } = mockLogin(t, { stderr: 'Logged in using ChatGPT' });
  const health = await adapter.getStatus();
  assert.equal(health.subscriptionReady, true); assert.equal(health.method, 'chatgpt'); assert.equal(health.status, 'ready');
  assert.equal(health.authStorage, 'file'); assert.ok(Number.isFinite(Date.parse(health.checkedAt)));
  await adapter.getStatus(); assert.equal(calls.filter(c => c.args.includes('status')).length, 1);
  await adapter.getStatus({ refresh: true }); assert.equal(calls.filter(c => c.args.includes('status')).length, 2);
  const call = calls.find(c => c.args.includes('status'));
  assert.deepEqual(call.args, ['-c', 'cli_auth_credentials_store="file"', 'login', 'status']);
  assert.equal(call.options.windowsHide, true); assert.equal(call.options.timeout, 5000);
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'QBO_CLIENT_SECRET', 'JWT_SECRET', 'MONGODB_URI']) assert.equal(call.options.env[name], undefined);
  assert.ok(!Object.hasOwn(health, 'stdout')); assert.ok(!Object.hasOwn(health, 'stderr'));
});

test('API-key login is identified without claiming subscription readiness', async t => {
  const { adapter } = mockLogin(t, { stdout: 'Logged in using an API key - synthetic-do-not-expose' });
  const health = await adapter.getStatus(); assert.equal(health.loggedIn, true); assert.equal(health.subscriptionReady, false);
  assert.equal(health.status, 'api-key'); assert.match(health.reason, /billed separately/);
  assert.ok(!JSON.stringify(health).includes('synthetic-do-not-expose'));
});

test('signed-out, missing binary, and check errors give safe actionable health', async t => {
  for (const [result, expected] of [
    [{ error: { code: 1 }, stderr: 'Not logged in' }, 'signed-out'],
    [{ error: { code: 'ETIMEDOUT' }, stderr: 'synthetic-private-error' }, 'check-failed'],
    [{ error: { code: 'ENOENT' } }, 'not-installed'],
    [{ stdout: 'Logged in' }, 'unknown-login'],
  ]) {
    await t.test(expected, async sub => {
      const { adapter } = mockLogin(sub, result); const health = await adapter.getStatus();
      assert.equal(health.status, expected); assert.equal(health.subscriptionReady, false);
      assert.ok(health.reason); assert.ok(!JSON.stringify(health).includes('synthetic-private-error'));
    });
  }
});

test('Check plan again refreshes host health only after the authorized control succeeds', async () => {
  const { createBusinessAgentRouter } = require('../src/routes/business-agent');
  const calls = [], state = { usage: { totalTokens: 12 } };
  let allowed = true;
  const router = createBusinessAgentRouter({
    service: () => ({ status: async () => state, control: async () => { calls.push('control'); if (!allowed) throw Object.assign(new Error('denied'), { code: 'BUSINESS_ACCESS_DENIED', status: 403 }); return state; } }),
    provider: () => ({ getStatus: async options => { calls.push(options); return { providerStatus: { status: 'ready', detail: 'Subscription ready' }, codex: { subscriptionReady: true } }; } }),
  });
  const handler = (method, url) => router.stack.find(layer => layer.route?.path === url && layer.route.methods[method]).route.stack[0].handle;
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } });
  let res = response(); await handler('get', '/')({ user: {} }, res);
  assert.equal(res.body.data.usage.totalTokens, 12); assert.equal(res.body.data.usage.codex.subscriptionReady, true);
  assert.deepEqual(calls, [{ refresh: false, cached: true }]);
  calls.length = 0; res = response();
  await handler('post', '/control')({ user: {}, body: { command: 'retry-plan-limit' } }, res);
  assert.deepEqual(calls, ['control', { refresh: true, cached: false }]); assert.equal(res.body.data.usage.providerStatus.status, 'ready');
  allowed = false; calls.length = 0; res = response();
  await handler('post', '/control')({ user: {}, body: { command: 'retry-plan-limit' } }, res);
  assert.equal(res.statusCode, 403); assert.deepEqual(calls, ['control']);
});

 test('non-ChatGPT credentials are rejected before catalog/inference and cached polling never launches a process', async t => {
  const { adapter, calls } = mockLogin(t, { stdout: 'Logged in using an API key' });
  assert.equal(adapter.getCachedStatus().status, 'unchecked'); assert.equal(calls.length, 0);
  await assert.rejects(adapter.run({ system: 'synthetic', prompt: 'synthetic' }), error => error.code === 'CODEX_SUBSCRIPTION_UNAVAILABLE');
  assert.ok(calls.every(call => !call.args.includes('models') && !call.args.includes('exec')));
  assert.equal(adapter.getCachedStatus().status, 'api-key');
});
