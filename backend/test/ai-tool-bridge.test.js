'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolSession, handleMcpRequest } = require('../src/modules/ai-tool-bridge');

const TOOLS = [
  { name: 'lookupCustomer', description: 'Find a customer', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'createInvoice', description: 'Queue an invoice', input_schema: { type: 'object', properties: {} } },
];

function session(execute = async (name, input) => ({ success: true, data: { name, input } })) {
  return createToolSession({ tools: TOOLS, execute });
}

test('unknown or missing tokens get a plain 404', async () => {
  const result = await handleMcpRequest('f'.repeat(64), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(result.status, 404);
});

test('initialize and tools/list describe only the session tools', async () => {
  const s = session();
  try {
    const init = await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, '2025-06-18');

    const notification = await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);

    const list = await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(list.json.result.tools.map((t) => t.name), ['lookupCustomer', 'createInvoice']);
    assert.equal(list.json.result.tools[0].inputSchema.type, 'object');
  } finally {
    s.revoke();
  }
});

test('tools/call runs through the session executor', async () => {
  const calls = [];
  const s = session(async (name, input) => { calls.push([name, input]); return { queued: true }; });
  try {
    const reply = await handleMcpRequest(s.bridge.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'createInvoice', arguments: { amount: 5 } },
    });
    assert.equal(reply.json.result.isError, false);
    assert.deepEqual(JSON.parse(reply.json.result.content[0].text), { queued: true });
    assert.deepEqual(calls, [['createInvoice', { amount: 5 }]]);
  } finally {
    s.revoke();
  }
});

test('a session counts tool list requests and tool calls for its run', async () => {
  const s = session();
  try {
    assert.deepEqual(s.bridge.stats(), { listed: 0, calls: 0 });
    await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookupCustomer', arguments: { name: 'A' } } });
    await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'runShell', arguments: {} } });
    assert.deepEqual(s.stats(), { listed: 1, calls: 1 });
    assert.deepEqual(s.bridge.stats(), { listed: 1, calls: 1 });
  } finally {
    s.revoke();
  }
});

test('unknown tools and non-object arguments are refused without running', async () => {
  const calls = [];
  const s = session(async (name) => { calls.push(name); return { success: true }; });
  try {
    const unknown = await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'runShell', arguments: {} } });
    assert.equal(unknown.json.result.isError, true);
    const bad = await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lookupCustomer', arguments: ['x'] } });
    assert.equal(bad.json.result.isError, true);
    assert.deepEqual(calls, []);
  } finally {
    s.revoke();
  }
});

test('a revoked session stops answering', async () => {
  const s = session();
  s.revoke();
  const result = await handleMcpRequest(s.bridge.token, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(result.status, 404);
});

test('closing a bridge waits for the active write and refuses queued writes', async () => {
  let release;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const s = session(async () => { calls += 1; started(); await gate; return { success: true, saved: 'record' }; });
  const first = s.call('createInvoice', {});
  await began;
  const second = s.call('createInvoice', {});
  let closed = false;
  const closing = s.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  assert.equal((await first).saved, 'record');
  assert.equal((await second).success, false);
  await closing;
  assert.equal(calls, 1);
  assert.equal(closed, true);
});
