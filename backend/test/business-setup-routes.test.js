'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), jwt = require('jsonwebtoken');
const { createBusinessSetupRouter } = require('../src/routes/business-setup');
const config = require('../src/config');
async function server(work) {
  const calls = [];
  const service = Object.fromEntries(['status', 'preview', 'apply', 'previewStorage', 'applyStorage', 'prepareCoordination', 'recordPeriodControls', 'activateCoordination'].map(action => [action, async (user, body) => { calls.push({ action, user, body }); return { action, qboWrites: 0 }; }]));
  const token = jwt.sign({ id: 'b'.repeat(24), role: 'agent' }, config.jwtSecret);
  const app = express(); app.use(express.json()); app.use('/setup', createBusinessSetupRouter({ service: () => service }));
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  const call = async (path = '', body, auth = true) => fetch('http://127.0.0.1:' + listener.address().port + '/setup' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try { await work({ calls, call }); } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
}
test('actual setup routes expose separate authenticated local transitions without implicit activation', async () => server(async ({ calls, call }) => {
  const response = await call(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const [path, body] of [['/preview', {}], ['/apply', { planHash: 'a'.repeat(64) }], ['/coordination/prepare', {}], ['/period-controls', { closedThrough: null, reconciledThrough: null, evidenceNote: 'Owner inspected the books.' }], ['/coordination/activate', { preparationEvidenceHash: 'c'.repeat(64) }]]) assert.equal((await call(path, body)).status, 200);
  assert.deepEqual(calls.map(row => row.action), ['status', 'preview', 'apply', 'prepareCoordination', 'recordPeriodControls', 'activateCoordination']); assert.ok(calls.every(row => row.user.id === 'b'.repeat(24)));
}));
test('actual setup routes refuse missing auth, query overrides and body scope overrides before services', async () => server(async ({ calls, call }) => {
  assert.equal((await call('', undefined, false)).status, 401);
  assert.equal((await call('?realmId=999')).status, 400);
  assert.equal((await call('/preview', { ownerId: 'e'.repeat(24) })).status, 400);
  assert.equal((await call('/coordination/prepare', { approved: true })).status, 400);
  assert.equal(calls.length, 0);
}));

test('additive storage routes are authenticated and forward reviewed profile and hash', async () => server(async ({ calls, call }) => {
  const preview = { profile: 'general-writes' }, apply = { ...preview, planHash: 'a'.repeat(64) };
  const p = await call('/storage/preview', preview), a = await call('/storage/apply', apply);
  assert.equal(p.status, 200); assert.equal(a.status, 200); assert.equal(p.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.map(row => [row.action, row.body]), [['previewStorage', preview], ['applyStorage', apply]]);
  assert.ok(calls.every(row => row.user.id === 'b'.repeat(24)));
}));
test('additive storage routes reject unauthenticated calls and company context overrides', async () => server(async ({ calls, call }) => {
  assert.equal((await call('/storage/preview', { profile: 'general-writes' }, false)).status, 401);
  assert.equal((await call('/storage/apply', { profile: 'general-writes', planHash: 'a'.repeat(64) }, false)).status, 401);
  assert.equal((await call('/storage/preview?realmId=999', { profile: 'general-writes' })).status, 400);
  assert.equal((await call('/storage/apply', { profile: 'general-writes', planHash: 'a'.repeat(64), realmId: '999' })).status, 400);
  assert.equal(calls.length, 0);
}));
