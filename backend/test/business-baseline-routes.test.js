'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), http = require('node:http'), jwt = require('jsonwebtoken');
const config = require('../src/config');
const { createBusinessBaselineRouter } = require('../src/routes/business-baseline');
const user = { id: 'a'.repeat(24), role: 'supervisor' }, id = 'b'.repeat(24);
async function fixture(service, work) {
  const app = express(); app.use(express.json()); app.use('/baseline', createBusinessBaselineRouter({ service: () => service }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/baseline';
  const headers = { Authorization: 'Bearer ' + jwt.sign(user, config.jwtSecret), 'Content-Type': 'application/json' };
  try { await work((path = '', options = {}) => fetch(base + path, { headers, ...options })); }
  finally { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('baseline routes authenticate and reject context or query overrides before services', async () => {
  let calls = 0; const service = Object.fromEntries(['list', 'capture', 'inspect'].map(key => [key, async () => { calls++; return {}; }]));
  await fixture(service, async request => {
    assert.equal((await request('', { headers: {} })).status, 401);
    for (const path of ['?realmId=456', '?limit=51', '?limit=1&limit=2', '?random=1', '/' + id + '?state=accepted']) assert.equal((await request(path)).status, 400);
    assert.equal((await request('', { method: 'POST', body: JSON.stringify({ environment: 'production' }) })).status, 400);
    assert.equal((await request('?random=1', { method: 'POST', body: '{}' })).status, 400); assert.equal(calls, 0);
  });
});
test('capture, history and inspection retain authenticated user and bounded request contracts', async () => {
  const calls = [], body = { requestKey: 'baseline-request-001' };
  const service = Object.fromEntries(['list', 'capture', 'inspect'].map(key => [key, async (...args) => { calls.push({ key, args }); return { captured: true }; }]));
  await fixture(service, async request => {
    const response = await request('', { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await request('?limit=2')).status, 200); assert.equal((await request('/' + id)).status, 200);
  });
  assert.equal(calls[0].args[0].id, user.id); assert.deepEqual(calls[0].args[1], body); assert.ok(calls[0].args[2].signal instanceof AbortSignal);
  assert.deepEqual(calls[1].args[1], { limit: 2 }); assert.equal(calls[2].args[1], id);
});
test('upstream authentication remains 502 and internal storage failures stay private', async () => {
  for (const [error, expected] of [[Object.assign(new Error('QBO denied'), { status: 401, intuit_tid: 'trace' }), 502], [Object.assign(new Error('throttled'), { status: 429, intuit_tid: 'trace' }), 429], [new Error('private database name'), 500], [Object.assign(new Error('Denied'), { status: 403, code: 'BUSINESS_ACCESS_DENIED' }), 403]]) {
    await fixture({ list: async () => { throw error; } }, async request => { const response = await request(); assert.equal(response.status, expected); assert.equal(JSON.stringify(await response.json()).includes('private database'), false); });
  }
});
test('disconnected capture requests abort the service signal', async () => {
  let began, ended; const started = new Promise(resolve => { began = resolve; }), stopped = new Promise(resolve => { ended = resolve; });
  await fixture({ capture: async (_user, _body, { signal }) => { began(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); ended(); return {}; } }, async request => {
    const controller = new AbortController(); const result = request('', { method: 'POST', body: '{}', signal: controller.signal }).catch(error => error);
    await started; controller.abort(); await result; await stopped;
  });
});

test('only an explicit invalid-request rejection tells the browser nothing was saved', async () => {
  for (const [code, expected] of [['BUSINESS_BASELINE_REQUEST_INVALID', true], ['BUSINESS_BASELINE_UNVERIFIED', undefined]]) {
    await fixture({ capture: async () => { throw Object.assign(new Error('Invalid dates'), { code, status: 400, notSaved: true }); } }, async request => { const response = await request('', { method: 'POST', body: '{}' }); assert.equal(response.status, 400); assert.equal((await response.json()).notSaved, expected); });
  }
});

test('captured inventory routes enforce paging and preserve exact authenticated identity', async () => {
  const calls = [], service = { inventory: async (...args) => { calls.push(args); return { records: [] }; }, review: async (...args) => { calls.push(args); return { comparison: 'matches' }; } };
  await fixture(service, async request => {
    for (const path of ['/' + id + '/inventory', '/' + id + '/inventory?entity=Invoice&limit=51', '/' + id + '/inventory?entity=Invoice&limit=1&limit=2', '/' + id + '/inventory?entity=Invoice&realmId=123', '/' + id + '/inventory/Invoice/20?force=1']) assert.equal((await request(path)).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await request('/' + id + '/inventory?entity=Invoice&limit=2')).status, 200);
    const response = await request('/' + id + '/inventory/Invoice/20'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  assert.equal(calls[0][0].id, user.id); assert.equal(calls[0][1], id); assert.deepEqual(calls[0][2], { entity: 'Invoice', limit: 2 });
  assert.equal(calls[1][0].id, user.id); assert.deepEqual(calls[1].slice(1, 4), [id, 'Invoice', '20']); assert.ok(calls[1][4].signal instanceof AbortSignal);
});
test('inventory comparison maps upstream errors without logging out the app', async () => {
  await fixture({ review: async () => { throw Object.assign(new Error('QBO denied'), { status: 401, intuit_tid: 'fixture-trace' }); } }, async request => { const response = await request('/' + id + '/inventory/Invoice/20'); assert.equal(response.status, 502); assert.equal((await response.json()).qboStatus, 401); });
});
