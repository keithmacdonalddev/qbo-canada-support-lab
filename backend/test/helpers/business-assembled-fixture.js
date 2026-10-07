'use strict';
const { createBusinessRuntime } = require('../../src/modules/business-runtime');
const { validateOperationCandidate } = require('../../src/modules/business-operation-plan-store');
const { harness: dispatchHarness, scope, operationId, actorId, ownerId } = require('./business-runtime-fixture');
const { fixture: reportsFixture } = require('./business-report-fixtures');
const { hash } = require('../../src/modules/business-calendar');
function harness() {
  const h = dispatchHarness(), f = h.fixture, run = h.data.Runs[0];
  f.policy.readbackTax = { version: 1, totalTaxCents: 3250, lines: [{ rateId: '950', percent: 13, taxableCents: 25000, amountCents: 3250 }] };
  const candidate = { version: 1, scope, businessKey: 'business', blueprintId: 'e'.repeat(24), blueprintHash: hash('blueprint'), baselineHash: hash('baseline'), openingDate: '2026-10-01', fromDate: '2026-10-06', throughDate: '2026-10-06', expectedCursor: '2026-10-05', expectedRevision: 1,
    requiredAssertions: [{ key: 'trial-balance', evidenceType: 'accrual-ledger', currency: 'CAD', basis: 'Accrual' }], entries: [{ kind: 'create', step: f.step, policy: f.policy }] };
  const { manifest, planHash, entries } = validateOperationCandidate(candidate, scope, h.clock), planId = 'f'.repeat(24);
  Object.assign(run, manifest, { _id: operationId, ...scope, planHash, planId, createdBy: actorId, status: 'approved', nextOrdinal: 0, executionRevision: 0, evidenceRevision: 0, verification: null, approval: { ...run.approval, planHash } }); delete run.scope; delete run.records; delete run.version;
  h.data.Plans.push({ _id: planId, contractVersion: 1, ...scope, operationId, planHash, manifest, createdBy: actorId, auditId: 'retained-preparation' });
  h.data.Intents.push(...entries.map((entry, ordinal) => ({ _id: hash(entry.step).slice(0, 24), contractVersion: 1, ...scope, planId, planHash, ordinal, kind: entry.kind, step: entry.step, policy: entry.policy, logicalKey: entry.step.logicalKey, fingerprint: hash(entry.step) })));
  Object.assign(h.data.Calendars[0], { currentOperationId: null, verifiedThrough: run.expectedCursor, revision: 1, openingDate: '2026-10-01' }); Object.assign(h.writer(), { operationId: null, planHash: null }); h.data.Policies[0].preparationEvidenceHash = hash('prepared coordination');
  h.posts = 0; h.gets = 0; const reports = reportsFixture(); for (const report of Object.values(reports)) report.Header.StartPeriod = run.fromDate;
  reports.TrialBalance.Rows.Row[0].ColData[0].id = '1'; reports.TrialBalance.Rows.Row[1].ColData[0].id = '2';
  h.onSend = async options => {
    if (h.beforeProvider) await h.beforeProvider(options);
    if (options.method === 'POST') {
      h.posts++; h.record = { ...JSON.parse(options.body), Id: '1000', SyncToken: '0', TotalAmt: 282.5, TxnStatus: 'Pending', TxnTaxDetail: { TotalTax: 32.5, TaxLine: [{ Amount: 32.5, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '950' }, PercentBased: true, TaxPercent: 13, NetAmountTaxable: 250 } }] } }; h.record.Line.forEach((line, index) => { line.Id = String(index + 1); });
      return { status: 200, json: { Estimate: structuredClone(h.record) } };
    }
    h.gets++; const url = new URL(options.url), name = url.pathname.split('/').at(-1);
    if (url.pathname.includes('/reports/')) return { status: 200, json: structuredClone(reports[name]) };
    if (name === 'query') return { status: 200, json: { QueryResponse: { Account: [{ Id: '1', SyncToken: '0', AccountType: 'Accounts Receivable' }, { Id: '2', SyncToken: '0', AccountType: 'Accounts Payable' }], startPosition: 1, maxResults: 2 } } };
    const reference = h.referenceRecords.find(value => options.url.endsWith('/' + value.entity.toLowerCase() + '/' + value.record.Id));
    return { status: 200, json: reference ? { [reference.entity]: structuredClone(reference.record) } : { Estimate: structuredClone(h.record) } };
  };
  h.runtime = createBusinessRuntime({ scope, operationId, actorId, ownerId, models: h.models, transaction: h.transaction, assertReady: h.assertReady, createClient: async () => h.client, environment: () => 'sandbox', now: () => h.clock });
  return h;
}
module.exports = { harness, scope, operationId, actorId, ownerId };
