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
