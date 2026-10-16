'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, ownerId, scope } = require('./helpers/business-governance-fixture');
const { hash } = require('../src/modules/business-calendar');
const { createBusinessReportReader } = require('../src/modules/business-report-evidence');
const { unpackReport } = require('../src/modules/business-report-source');
const { createIncomeExpectation, checkIncomeExpectation } = require('../src/modules/business-income-evidence');
const { createFinancialExpectation, compareFinancialMovements } = require('../src/modules/business-financial-movements');
const { readApprovalReports } = require('../src/modules/business-approval-report-evidence');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
test('nested original-SDK reports survive capture, publication, new expectations, approval, period completion and historical reload', { timeout: 120000 }, async () => {
  const h = fixture({ activityTemplateVersion: 2, copyOnWriteTransactions: true, originalSdkTransport: true, originalReportCapture: true, nestedReportLevels: 8, reportTimeChanges: true });
  await h.publish(); const baseline = h.data.Baselines[0], originalBaselineHash = baseline.evidenceHash;
  assert.equal(baseline.sources.version, 3); assert.ok(Object.values(baseline.sources.reports).every(report => report.encoding === 'gzip-canonical-json-v2'));
  assert.ok(h.reportSequence >= 14, 'publication rereads the original SDK reports with different Header.Time');
  const prepared = await h.service.prepare(h.user, { requestKey: 'nested-report-period-0001', throughDate: '2026-10-02' }), plan = h.data.Plans.find(row => row.planHash === prepared.planHash);
  assert.equal(plan.manifest.incomeExpectation.version, 2); assert.equal(plan.manifest.incomeExpectation.source.reportSourceVersion, 3);
  assert.equal(plan.manifest.financialExpectation.version, 2); assert.equal(plan.manifest.financialExpectation.source.reportSourceVersion, 3);
  assert.equal(plan.manifest.incomeExpectation.source.report.encoding, 'gzip-canonical-json-v2'); assert.doesNotThrow(() => hash(plan.manifest));
  await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  const run = h.data.Runs.find(row => row._id === prepared.operationId); assert.equal(run.approval.reportEvidence.sourceVersion, 3);
  const result = await h.runtime(prepared.operationId).execute(); assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-02');
  const beforeReads = h.reads, beforePosts = h.posts, inspected = await h.runtime(prepared.operationId).inspect();
  assert.equal(inspected.financialMovements.status, 'passed'); assert.equal(h.reads, beforeReads); assert.equal(h.posts, beforePosts); assert.equal(h.data.Baselines[0].evidenceHash, originalBaselineHash);
  const evidence = h.data.Evidence.find(row => row.operationId === prepared.operationId && row.proof.complete === true); assert.ok(evidence); assert.equal(evidence.sources.version, 3);
  const pointer = structuredClone(run.approval.reportEvidence); run.approval.reportEvidence.sourceVersion = 2;
  await assert.rejects(readApprovalReports({ models: h.models, run, ownerId }), /retained seven-report/); run.approval.reportEvidence = pointer;
  assert.equal((await readApprovalReports({ models: h.models, run, ownerId })).sourceVersion, 3);
});
test('immutable v1 income and financial expectations compare with a fresh nested v3 observation', async () => {
  const h = fixture({ copyOnWriteTransactions: true, originalSdkTransport: true, nestedReportLevels: 8 }), period = { fromDate: '2026-10-01', throughDate: '2026-10-02' }, old = h.reportSources(period);
  const income = createIncomeExpectation(scope, period, [], old.reports.ProfitAndLoss, old.observedAt), financial = createFinancialExpectation(scope, period, h.mappings, old), original = hash({ income, financial });
  assert.equal(income.version, 1); assert.equal(financial.version, 1);
  const current = await createBusinessReportReader({ access: h.accessFor({ actorId: ownerId, ownerId }), now: () => h.clock })(scope, period);
  assert.equal(current.version, 3); assert.equal(checkIncomeExpectation(income, scope, period, unpackReport('ProfitAndLoss', current.reports.ProfitAndLoss, current.version), current.version).passed, true);
  assert.equal(compareFinancialMovements(financial, [], current).status, 'passed'); assert.equal(hash({ income, financial }), original);
});

test('a fresh opening source that cannot fit BSON blocks the normal runtime before any create', { timeout: 120000 }, async () => {
  const h = fixture({ copyOnWriteTransactions: true, originalSdkTransport: true, originalReportCapture: true, nestedReportLevels: 8 }); await h.publish();
  const prepared = await h.service.prepare(h.user, { requestKey: 'opening-bson-capacity-0001', throughDate: '2026-10-02' }); await h.service.approve(h.user, prepared.operationId, { planHash: prepared.planHash });
  const beforeCursor = h.data.Calendars[0].verifiedThrough;
  h.records.get('account:' + h.mappings.operatingBank).record.metadata = Array(1300000).fill(0);
  await assert.rejects(h.runtime(prepared.operationId).execute(), error => error.code === 'BUSINESS_FINANCIAL_MOVEMENTS_UNVERIFIED' && /BSON storage budget/.test(error.message)); assert.equal(h.posts, 0); assert.equal(h.data.Evidence.length, 0); assert.equal(h.data.Calendars[0].verifiedThrough, beforeCursor);
});
