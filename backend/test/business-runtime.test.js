'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/business-assembled-fixture');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
test('assembled runtime performs one approved operation through actual authority, plans, dispatch, graph, reports and completion', async () => {
  const h = harness(); assert.equal(h.sent.length, 0); assert.equal(h.data.Audits.length, 1); // Only the retained publication audit exists; composition wrote nothing.
  const before = await h.runtime.inspect(); assert.equal(before.status, 'approved'); assert.equal('leaseToken' in before, false); assert.equal(h.sent.length, 0);
  const result = await h.runtime.execute(); assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(h.posts, 1); assert.ok(h.gets > 6); assert.equal(h.data.Evidence.length, 1); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-06');
  assert.ok(h.data.Audits.some(row => row.inputParams?.eventKey?.startsWith('business-period-evidence:')));
  assert.equal((await h.runtime.execute()).complete, true); assert.equal(h.posts, 1);
});
test('preparing coordination and missing preparation proof cannot create a marker or send', async () => {
  for (const mutate of [h => { h.data.Policies[0].state = 'preparing'; }, h => { delete h.data.Policies[0].preparationEvidenceHash; }]) {
    const h = harness(); mutate(h); await h.runtime.execute().catch(() => {}); assert.equal(h.posts, 0); assert.equal(h.data.Steps.length, 0); assert.equal(h.writer().unresolved, null);
  }
});
test('policy transition during compilation is fenced before dispatch marker', async () => {
  const h = harness(); h.beforeProvider = async options => { if (options.method === 'GET' && /\/(?:customer|vendor|item|account|taxcode|employee)\/\d+$/.test(new URL(options.url).pathname)) h.data.Policies[0].state = 'preparing'; };
  const result = await h.runtime.execute(); assert.equal(result.complete, false); assert.equal(h.posts, 0); assert.equal(h.data.Steps[0].state, 'claimed'); assert.equal(h.writer().unresolved, null);
});
test('revoked membership and changed company prevent execution', async () => {
  for (const mutate of [h => { h.data.Memberships[0].status = 'suspended'; }, h => { h.data.Connections[0].realmId = '456'; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.runtime.execute()); assert.equal(h.posts, 0); assert.equal(h.data.Steps.length, 0);
  }
});
test('cancellation after a sent record settles its receipt and resumes without duplication', async () => {
  const h = harness(), controller = new AbortController(); h.beforeProvider = async options => { if (options.method === 'POST') controller.abort(); };
  assert.equal((await h.runtime.execute({ signal: controller.signal })).complete, false); assert.equal(h.posts, 1); assert.equal(h.writer().unresolved, null);
  h.beforeProvider = null; assert.equal((await h.runtime.execute()).complete, true); assert.equal(h.posts, 1);
});

test('already-sent work can settle and finish while new write coordination is preparing', async () => {
  const h = harness(), controller = new AbortController(); h.beforeProvider = async options => { if (options.method === 'POST') { h.data.Policies[0].state = 'preparing'; controller.abort(); } };
  assert.equal((await h.runtime.execute({ signal: controller.signal })).complete, false); assert.equal(h.posts, 1); assert.equal(h.writer().unresolved, null);
  h.beforeProvider = null; assert.equal((await h.runtime.execute()).complete, true); assert.equal(h.posts, 1);
});
test('default model loading rejects missing legacy registrations without registering them', () => {
  const mongoose = require('mongoose'), { loadModels } = require('../src/modules/business-runtime'), original = mongoose.models.User;
  delete mongoose.models.User; const names = Object.keys(mongoose.models).sort();
  try { assert.throws(loadModels, /registered/); assert.deepEqual(Object.keys(mongoose.models).sort(), names); } finally { if (original) mongoose.models.User = original; }
});

test('coordination transition during starting reports cannot reserve a dispatch marker', async () => {
  const h = harness(); h.beforeProvider = async options => { if (options.method === 'GET' && options.url.includes('/reports/')) h.data.Policies[0].state = 'preparing'; };
  const result = await h.runtime.execute(); assert.equal(result.complete, false); assert.equal(h.posts, 0); assert.equal(h.data.Steps.length, 0); assert.equal(h.writer().unresolved, null);
});
test('cancellation during the starting observation retains the reserved unsent run without a worker lease', async () => {
  const h = harness(), controller = new AbortController(); h.beforeProvider = async options => { if (options.url.includes('/reports/')) controller.abort(); };
  const result = await h.runtime.execute({signal:controller.signal}); assert.equal(result.state, 'interrupted'); assert.equal(result.complete, false); assert.equal(h.posts, 0); assert.equal(h.data.Steps.length, 0); assert.equal(h.data.Runs[0].leaseToken == null, true, 'No worker lease was claimed');
});

test('legacy plans without financial expectations admit fresh source BSON before any create', { timeout: 120000 }, async () => {
  const h = harness(), original = h.onSend, beforeCursor = h.data.Calendars[0].verifiedThrough; assert.equal(h.data.Plans[0].manifest.financialExpectation, undefined);
  h.onSend = async options => { const response = await original(options); if (options.method === 'GET' && response.json?.QueryResponse?.Account) { response.json.QueryResponse.Account.push({ Id: '99999', SyncToken: '0', AccountType: 'Other Asset', metadata: Array(1300000).fill(0) }); response.json.QueryResponse.maxResults++; } return response; };
  await assert.rejects(h.runtime.execute(), error => error.code === 'BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED' && /BSON storage budget/.test(error.message));
  assert.equal(h.posts, 0); assert.equal(h.data.Steps.length, 0); assert.equal(h.data.Evidence.length, 0); assert.equal(h.data.Calendars[0].verifiedThrough, beforeCursor);
});
