'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessPeriodEvidence } = require('../src/modules/business-period-evidence');
const { createBusinessPeriodStore } = require('../src/modules/business-period-store');
const { harness: runnerHarness, scope, operationId, hash, clone } = require('./helpers/business-run-fixture');
const { fixture, accounts } = require('./helpers/business-report-fixtures');
function harness(count = 3, requirements = [{ key: 'records', evidenceType: 'record-readback', currency: 'CAD' }, { key: 'trial-balance', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' }]) {
  const h = runnerHarness(count, requirements); h.sourceCalls = 0;
  h.reportSources = () => {
    const reports = fixture(); for (const report of Object.values(reports)) report.Header.StartPeriod = h.run().fromDate;
    const source = { version: 1, scope, period: { fromDate: h.run().fromDate, throughDate: h.run().throughDate }, startedAt: new Date(h.clock).toISOString(), observedAt: new Date(h.clock).toISOString(), reports, accounts: accounts.records };
    return { ...source, sourceHash: hash(source) };
  };
  const verifyGraph = h.steps.verifyGraph;
  h.steps.verifyGraph = async (...args) => { const result = await verifyGraph(...args); return { ...result, records: args[2].map(logicalKey => ({ logicalKey })) }; };
  h.collector = createBusinessPeriodEvidence({ ...h.models, transaction: h.transaction, access: { authorize: async () => ({ ...await h.authorize(), ownerId: 'd'.repeat(24) }) }, assertReady: h.assertReady, writerFence: h.writerFence, steps: h.steps, readReports: async () => { h.sourceCalls++; if (h.onReport) return h.onReport(); return h.reportSources(); }, writeAudit: h.writeAudit, now: () => h.clock });
  h.prepareEvidence = h.collector.prepareEvidence;
  h.periods = createBusinessPeriodStore({ ...h.models, Writer: h.writerFence, transaction: h.transaction, authorize: h.authorize, assertReady: h.assertReady, writeAudit: h.writeAudit, loadProof: h.collector.loadProof, now: () => h.clock });
  return h;
}
test('runner completes through retained real period collector and actual period store', async () => {
  const h = harness(), result = await h.execute(); assert.equal(result.complete, true); assert.equal(h.writes, 3); assert.equal(h.sourceCalls, 1);
  assert.equal(h.data.Evidence.length, 1); assert.equal(h.data.Evidence[0].sources.reports.TrialBalance.Header.ReportName, 'TrialBalance'); assert.equal(h.data.Evidence[0].proof.records.length, 3);
  const reread = await h.collector.loadProof(h.run()); assert.equal(hash(reread), h.run().verificationCandidateHash);
  assert.equal((await h.execute()).complete, true); assert.equal(h.sourceCalls, 1); assert.equal(h.writes, 3);
});
test('empty periods retain required report proof without creating records', async () => {
  const h = harness(0); assert.equal((await h.execute()).complete, true); assert.equal(h.writes, 0); assert.equal(h.data.Evidence[0].proof.records.length, 0);
});
test('failed report check remains pending and resumes without another record creation', async () => {
  const h = harness(); h.onReport = () => { const source = h.reportSources(); source.reports.TrialBalance.Rows.Row.at(-1).Summary.ColData[2].value = '99.00'; const { sourceHash, ...raw } = source; return { ...raw, sourceHash: hash(raw) }; };
  const first = await h.execute(); assert.equal(first.state, 'awaiting-evidence'); assert.equal(h.data.Evidence.length, 0); assert.equal(h.calendar().verifiedThrough, '2026-10-05');
  h.onReport = null; assert.equal((await h.execute()).complete, true); assert.equal(h.writes, 3);
});
test('unknown or manual checks cannot be satisfied by balanced books', async () => {
  for (const requirement of [{ key: 'bank-reconciled', evidenceType: 'manual-confirmation', currency: 'CAD' }, { key: 'arbitrary', evidenceType: 'record-readback', currency: 'CAD' }]) {
    const h = harness(0, [requirement]); assert.equal((await h.execute()).complete, false); assert.equal(h.data.Evidence.length, 0);
  }
});
test('changed worker, writer, record or report source cannot freeze a period', async () => {
  for (const mutate of [h => { h.run().leaseToken = 'replacement-worker-0001'; }, h => { h.writer().revision++; }, h => { h.data.Steps[0].verification.observedHash = hash('changed'); }, h => { h.run().evidenceRevision++; }]) {
    const h = harness(); h.onReport = () => { mutate(h); return h.reportSources(); }; await h.execute().catch(() => {}); assert.equal(h.data.Evidence.length, 0); assert.equal(h.calendar().verifiedThrough, '2026-10-05');
  }
});
test('wrong scope, prior observation, changed hash and invented passed evaluation are rejected', async () => {
  for (const mutate of [source => { source.scope = { ...scope, realmId: '456' }; }, source => { source.startedAt = '2026-10-05T12:00:00.000Z'; }, source => { source.sourceHash = hash('fake'); }, source => { source.reports.TrialBalance.Header.Currency = 'USD'; source.evaluation = { checks: [{ key: 'trial-balance', status: 'passed' }] }; }]) {
    const h = harness(); h.onReport = () => { const source = h.reportSources(); mutate(source); return source; }; const result = await h.execute(); assert.equal(result.complete, false); assert.equal(h.data.Evidence.length, 0);
  }
});
test('failed audit rolls back evidence and run candidate as one transaction', async () => {
  const h = harness(); const audit = h.writeAudit;
  // Rebuild only the collector audit adapter, not progress/reservation audit.
  h.collector = createBusinessPeriodEvidence({ ...h.models, transaction: h.transaction, access: { authorize: async () => ({ actorId: 'c'.repeat(24), ownerId: 'd'.repeat(24) }) }, assertReady: h.assertReady, writerFence: h.writerFence, steps: h.steps, readReports: async () => h.reportSources(), writeAudit: async key => { if (key.startsWith('business-period-evidence:')) throw new Error('audit failed'); return audit(key); }, now: () => h.clock });
  h.prepareEvidence = h.collector.prepareEvidence;
  assert.equal((await h.execute()).complete, false); assert.equal(h.data.Evidence.length, 0); assert.equal(h.run().verificationCandidateHash, undefined); assert.equal(h.calendar().verifiedThrough, '2026-10-05');
});
test('lost evidence commit acknowledgement retains proof and retry never recreates records', async () => {
  const h = harness(), prepare = h.prepareEvidence;
  h.prepareEvidence = async input => { const result = await prepare(input); if (!h.lost) { h.lost = true; throw new Error('commit acknowledgement lost'); } return result; };
  assert.equal((await h.execute()).complete, false); assert.equal(h.data.Evidence.length, 1); assert.equal(h.writes, 3);
  assert.equal((await h.execute()).complete, true); assert.equal(h.data.Evidence.length, 2); assert.equal(h.writes, 3);
});
test('retained proof or raw report tampering is rejected on completion read', async () => {
  const h = harness(); await h.execute(); const original = clone(h.data.Evidence[0]);
  h.data.Evidence[0].sources.reports.TrialBalance.Header.Currency = 'USD'; await assert.rejects(h.collector.loadProof(h.run()), /sources changed/);
  h.data.Evidence[0] = clone(original); h.data.Evidence[0].proof.assertions[0].sourceHash = hash('changed'); await assert.rejects(h.collector.loadProof(h.run()), /unavailable/);
});
test('period graph is refreshed in bounded groups and all records are retained', async () => {
  const h = harness(101); assert.equal((await h.execute()).complete, true); assert.equal(h.graphCalls.length, 101); assert.equal(h.data.Evidence[0].proof.records.length, 101);
});

test('runner and collector complete using the concrete scoped report reader', async () => {
  const { createBusinessReportReader } = require('../src/modules/business-report-evidence');
  const { QBOClient } = require('../src/modules/qbo-client');
  const config = require('../src/config'), previous = config.qbo.environment; config.qbo.environment = 'sandbox';
  try {
    const h = harness(), client = Object.create(QBOClient.prototype), calls = [];
    const sources = h.reportSources(); sources.reports.TrialBalance.Rows.Row[0].ColData[0].id = '1'; sources.reports.TrialBalance.Rows.Row[1].ColData[0].id = '2';
    const accounts = [{ Id: '1', SyncToken: '0', AccountType: 'Accounts Receivable' }, { Id: '2', SyncToken: '0', AccountType: 'Accounts Payable' }];
    Object.assign(client, { realmId: scope.realmId, connection: { _id: scope.connectionId, realmId: scope.realmId, userId: 'd'.repeat(24), status: 'active' }, _requestLog: [], _retryAfterUntil: 0, _windowMs: 60000, ensureFreshToken: async () => {}, oauthClient: { makeApiCall: async options => {
      calls.push(options); const name = new URL(options.url).pathname.split('/').at(-1);
      return { status: 200, json: name === 'query' ? { QueryResponse: { Account: accounts, startPosition: 1, maxResults: 2 } } : sources.reports[name] };
    } } });
    const reader = createBusinessReportReader({ access: { authorize: async () => ({ actorId: 'c'.repeat(24), ownerId: 'd'.repeat(24) }), resolveClient: async () => client }, now: () => h.clock });
    h.onReport = () => reader(scope, sources.period);
    assert.equal((await h.execute()).complete, true); assert.equal(calls.length, 6); assert.ok(calls.every(call => call.method === 'GET'));
    assert.equal(h.data.Evidence[0].proof.assertions.length, 2); assert.equal(h.data.Evidence[0].sources.accounts.length, 2);
  } finally { config.qbo.environment = previous; }
});
test('a fabricated passed evaluation cannot override failed retained report totals', async () => {
  const h = harness(); h.onReport = () => {
    const { sourceHash, ...source } = h.reportSources(); source.reports.TrialBalance.Header.Currency = 'USD';
    return { ...source, sourceHash: hash(source), evaluation: { checks: [{ key: 'trial-balance', status: 'passed' }] } };
  };
  assert.equal((await h.execute()).complete, false); assert.equal(h.data.Evidence.length, 0);
});
test('cancellation and stale graph proofs cannot be frozen after reports return', async () => {
  const h = harness(), controller = new AbortController(); h.onReport = () => { controller.abort(); return h.reportSources(); };
  assert.equal((await h.execute({ signal: controller.signal })).complete, false); assert.equal(h.data.Evidence.length, 0);
  const stale = harness(); stale.onReport = () => { stale.clock += 300001; return stale.reportSources(); };
  assert.equal((await stale.execute()).complete, false); assert.equal(stale.data.Evidence.length, 0);
});

test('all supported report requirements are derived from their matching retained reports', async () => {
  const h = harness(0, [
    { key: 'trial-balance', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' },
    { key: 'balance-sheet', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' },
    { key: 'receivables', evidenceType: 'open-balances-at-date', currency: 'CAD' },
    { key: 'payables', evidenceType: 'open-balances-at-date', currency: 'CAD' },
  ]);
  assert.equal((await h.execute()).complete, true); assert.equal(h.data.Evidence[0].proof.assertions.length, 4);
});
test('retained evidence model rejects ordinary replacement and deletion without database access', { timeout: 2000 }, async () => {
  const Model = require('../src/models/OperationEvidence');
  assert.equal(Model.schema.options.autoCreate, false); assert.equal(Model.schema.options.autoIndex, false);
  for (const action of [() => Model.updateOne({}, {}), () => Model.replaceOne({}, {}), () => Model.deleteMany({}), () => Model.findOneAndUpdate({}, {}), () => Model.findOneAndDelete({})]) await assert.rejects(action(), /append-only/);
});
