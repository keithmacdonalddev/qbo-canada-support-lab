'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express'), http = require('node:http'), jwt = require('jsonwebtoken');
const config = require('../src/config');
const { createBusinessOperationsRouter } = require('../src/routes/business-operations');
const user = { id: 'a'.repeat(24), role: 'supervisor' }, id = 'b'.repeat(24);
async function fixture(service, work) {
  const app = express(); app.use(express.json()); app.use('/operations', createBusinessOperationsRouter({ service: () => service }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/operations';
  const headers = { Authorization: 'Bearer ' + jwt.sign(user, config.jwtSecret), 'Content-Type': 'application/json' };
  try { await work((path = '', options = {}) => fetch(base + path, { headers, ...options })); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('routes authenticate and reject company, state and query overrides before invoking services', async () => {
  let calls = 0; const service = Object.fromEntries(['list', 'inspect', 'request', 'stop'].map(key => [key, async () => { calls++; return {}; }]));
  await fixture(service, async request => {
    assert.equal((await request('', { headers: {} })).status, 401);
    for (const path of ['?realmId=456', '?limit=101', '?limit=1&limit=2', '?random=1', '/' + id + '?state=verified']) assert.equal((await request(path)).status, 400);
    assert.equal((await request('/' + id + '/execute', { method: 'POST', body: JSON.stringify({ environment: 'production' }) })).status, 400);
    assert.equal((await request('/' + id + '/stop', { method: 'POST', body: JSON.stringify({ pending: false }) })).status, 400);
    assert.equal(calls, 0);
  });
});
test('execute returns accepted immediately; reads and stops use authenticated user and exact id', async () => {
  const calls = [], body = { planHash: 'c'.repeat(64), requestKey: 'fixture_request_0001' };
  const service = Object.fromEntries(['list', 'inspect', 'request', 'stop'].map(key => [key, async (...args) => { calls.push({ key, args }); return key === 'request' ? { accepted: true, operationId: id } : { fixture: true }; }]));
  await fixture(service, async request => {
    const response = await request('/' + id + '/execute', { method: 'POST', body: JSON.stringify(body) }); assert.equal(response.status, 202); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await request('?limit=2')).status, 200); assert.equal((await request('/' + id)).status, 200); assert.equal((await request('/' + id + '/stop', { method: 'POST', body: '{}' })).status, 200);
  });
  assert.equal(calls[0].args[0].id, user.id); assert.equal(calls[0].args[1], id); assert.deepEqual(calls[0].args[2], body); assert.deepEqual(calls[1].args[1], { after: undefined, limit: 2 });
});
test('upstream auth remains 502, rate limiting remains 429, internal errors are sanitized', async () => {
  for (const [failure, expected] of [[Object.assign(new Error('fixture QBO denied'), { status: 401, intuit_tid: 'trace' }), 502], [Object.assign(new Error('fixture throttle'), { status: 429, intuit_tid: 'trace' }), 429], [new Error('private storage information'), 500], [Object.assign(new Error('Permission denied'), { status: 403, code: 'BUSINESS_ACCESS_DENIED' }), 403]]) {
    await fixture({ list: async () => { throw failure; } }, async request => { const response = await request(); assert.equal(response.status, expected); assert.equal(JSON.stringify(await response.json()).includes('private storage'), false); });
  }
});
