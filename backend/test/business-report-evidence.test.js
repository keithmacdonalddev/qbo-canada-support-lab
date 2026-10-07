'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessReportReader } = require('../src/modules/business-report-evidence');
const { QBOClient } = require('../src/modules/qbo-client');
const { hash } = require('../src/modules/business-calendar');
const { fixture, period } = require('./helpers/business-report-fixtures');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24), ownerId = 'c'.repeat(24);
function harness() {
  const h = { clock: Date.parse('2026-10-06T12:00:00.000Z'), reports: fixture(), calls: [], accounts: [{ Id: '1', SyncToken: '0', AccountType: 'Accounts Receivable' }, { Id: '2', SyncToken: '0', AccountType: 'Accounts Payable' }], reads: 0 };
  h.reports.TrialBalance.Rows.Row[0].ColData[0].id = '1'; h.reports.TrialBalance.Rows.Row[1].ColData[0].id = '2';
  h.client = Object.create(QBOClient.prototype);
  Object.assign(h.client, { connection: { _id: scope.connectionId, realmId: scope.realmId, userId: ownerId, status: 'active' }, realmId: scope.realmId, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
    h.calls.push(options); if (h.onRead) await h.onRead(options);
    const url = new URL(options.url), name = url.pathname.split('/').at(-1);
    if (name === 'query') return { status: 200, json: h.accountResponse || { QueryResponse: { Account: h.accounts, startPosition: 1, maxResults: h.accounts.length } } };
    return { status: 200, json: structuredClone(h.reports[name]) };
  } } });
  h.access = { authorize: async (_scope, action) => { assert.deepEqual(_scope, scope); assert.equal(action, 'operations.verify'); if (h.revoked) throw new Error('permission revoked'); h.reads++; return { actorId, ownerId: h.ownerChanged && h.reads > 1 ? 'd'.repeat(24) : ownerId }; }, resolveClient: async () => h.client };
  h.read = options => createBusinessReportReader({ access: h.access, now: () => h.clock })(scope, period, options);
  return h;
}
test('retains full scoped report sources with reproducible hash and named checks', async () => {
  const h = harness(), result = await h.read();
  assert.equal(result.evaluation.status, 'checks-passed'); assert.equal(h.calls.length, 6); assert.ok(h.calls.every(row => row.method === 'GET'));
  assert.ok(h.calls.some(row => decodeURIComponent(row.url).includes('Active IN (true, false)')));
  const { sourceHash, evaluation, ...source } = result; assert.equal(sourceHash, hash(source)); assert.equal(Object.keys(source.reports).length, 5);
});
test('wrong company or substituted transport is rejected before provider access', async () => {
  for (const mutate of [h => { h.client.connection.realmId = '456'; }, h => { h.client.connection.userId = actorId; }, h => { h.client.query = async () => ({}); }, h => { h.client.connection.status = 'inactive'; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.read(), /client/); assert.equal(h.calls.length, 0);
  }
});
test('missing or wrong-scope report totals cannot pass required checks', async () => {
  const h = harness(); h.reports.TrialBalance.Header.Currency = 'USD'; const result = await h.read(); assert.equal(result.evaluation.checks[0].status, 'unverified');
});
test('complete account observation rejects projected, repeated, warning or truncated pages', async () => {
  for (const response of [{ QueryResponse: { Account: [{ Id: '1' }], startPosition: 1 } }, { QueryResponse: { Account: [{ Id: '1', SyncToken: '0', AccountType: 'Bank' }, { Id: '1', SyncToken: '0', AccountType: 'Bank' }], startPosition: 1 } }, { QueryResponse: {}, warnings: [] }, { QueryResponse: { Account: [], totalCount: 1 } }]) {
    const h = harness(); h.accountResponse = response; await assert.rejects(h.read(), /account/i);
  }
});
test('revoked or changed authority discards already-observed sources', async () => {
  const h = harness(); h.onRead = async () => { h.revoked = true; }; await assert.rejects(h.read(), /revoked/);
  const changed = harness(); changed.ownerChanged = true; await assert.rejects(changed.read(), /authority changed/);
});
test('cancelled reads do not start provider calls and late results are discarded', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(); await assert.rejects(h.read({ signal: controller.signal }), /cancelled/); assert.equal(h.calls.length, 0);
  const late = harness(); late.onRead = async () => { late.clock += 180001; }; await assert.rejects(late.read(), /three minutes/);
});

test('present non-array account values and report warnings are never accepted as complete', async () => {
  for (const Account of [null, false, 0, {}]) { const h = harness(); h.accountResponse = { QueryResponse: { Account } }; await assert.rejects(h.read(), /Account pagination/); }
  const h = harness(); h.reports.TrialBalance.Warning = 'partial'; await assert.rejects(h.read(), /warnings/);
});

test('baseline report purpose is fixed by trusted composition and cannot authorize operation verification', async () => {
  const h = harness(), actions = [];
  h.access.authorize = async (_scope, action) => { actions.push(action); assert.equal(action, 'baseline.capture'); return { actorId, ownerId }; };
  const read = createBusinessReportReader({ access: h.access, now: () => h.clock, purpose: 'baseline' });
  const result = await read(scope, period, { purpose: 'operation', action: 'operations.verify' });
  assert.equal(result.evaluation.status, 'checks-passed'); assert.deepEqual(actions, ['baseline.capture', 'baseline.capture']);
  assert.throws(() => createBusinessReportReader({ access: h.access, purpose: 'arbitrary' }), /purpose/);
});
