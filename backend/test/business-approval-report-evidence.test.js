'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope } = require('./helpers/business-governance-fixture');
const { hash } = require('../src/modules/business-calendar');
const { KIND, readApprovalReports } = require('../src/modules/business-approval-report-evidence');
const { validateOperationCandidate } = require('../src/modules/business-operation-plan-store');
const { unpackReport, packReport } = require('../src/modules/business-report-source');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
async function prepared() { const h = fixture(); await h.publish(); h.p = await h.service.prepare(h.user, { requestKey: 'retained-report-proof-0001', throughDate: '2026-10-06' }); return h; }
async function approve(h) { return h.service.approve(h.user, h.p.operationId, { planHash: h.p.planHash }); }
const retained = h => h.data.Candidates.filter(row => row.payload.kind === KIND);
test('actual approval retains full seven-report sources and both exact audit links without financial writes', async () => {
  const h = await prepared(); await approve(h); const run = h.data.Runs[0], row = retained(h)[0];
  assert.equal(h.posts, 0); assert.equal(retained(h).length, 1); assert.equal(row.payload.sources.version, 3); assert.ok(Object.values(row.payload.sources.reports).every(report => report.encoding === 'gzip-canonical-json-v2')); assert.equal(Object.keys(row.payload.sources.reports).length, 7);
  assert.equal(hash(row.payload), run.approval.reportEvidence.evidenceHash); assert.throws(() => validateOperationCandidate(row.payload, scope, h.clock));
  const audit = h.data.Audits.find(value => value._id === run.approval.auditId); assert.equal(audit.inputParams.details.reportEvidenceHash, row.candidateHash); assert.equal(audit.inputParams.details.reportSourceHash, row.payload.sourceHash);
  const reads = h.reads, review = await h.service.reviewOperation(h.user, h.p.operationId, 0);
  assert.equal(review.approvalReports.available, 7); assert.equal(review.approvalReports.reports, 7); assert.equal(h.reads, reads);
  assert.equal(review.approvalReports.sources, undefined); assert.equal(review.approvalReports.reportsData, undefined);
  const original = structuredClone(run.approval); h.clock += 600000; assert.equal((await approve(h)).reused, true); assert.deepEqual(h.data.Runs[0].approval, original); assert.equal(retained(h).length, 1); assert.equal(h.reads, reads);
});
test('lost approval acknowledgement reuses its original retained observation without provider reads', async () => {
  const h = await prepared(); h.loseReply = true; await assert.rejects(approve(h), /acknowledgement/);
  assert.equal(h.data.Runs[0].status, 'approved'); const reads = h.reads, original = structuredClone(h.data.Runs[0].approval);
  assert.equal((await approve(h)).reused, true); assert.equal(h.reads, reads); assert.equal(h.posts, 0); assert.deepEqual(h.data.Runs[0].approval, original); assert.equal(retained(h).length, 1);
});
test('missing or changed retained approval data and either audit cannot be presented or reused', async () => {
  const h = await prepared(); await approve(h); const original = structuredClone(h.data);
  const mutations = [
    h => { delete h.data.Runs[0].approval.reportEvidence; },
    h => { h.data.Runs[0].approval.reportEvidence.sourceHash = hash('different'); },
    h => { h.data.Candidates = h.data.Candidates.filter(row => row.payload.kind !== KIND); },
    h => { retained(h)[0].payload.sources.scope.realmId = '456'; },
    h => { h.data.Audits = h.data.Audits.filter(row => row._id !== h.data.Runs[0].approval.auditId); },
    h => { h.data.Audits.find(row => row._id === h.data.Runs[0].approval.auditId).inputParams.details.reportSourceHash = hash('different'); },
    h => { h.data.Audits.find(row => row._id === h.data.Runs[0].approval.auditId).inputParams.details.phase = 'prepared'; },
    h => { h.data.Audits.find(row => row._id === retained(h)[0].auditId).actionType = 'ai'; },
    h => { h.data.Audits.find(row => row._id === retained(h)[0].auditId).actorUserId = 'f'.repeat(24); },
    h => { h.data.Audits.find(row => row._id === retained(h)[0].auditId).afterState.observedAt = '2020-01-01T00:00:00.000Z'; },
  ];
  for (const mutate of mutations) { h.data = structuredClone(original); mutate(h); const reads = h.reads; await assert.rejects(approve(h), {code:'BUSINESS_APPROVAL_REPORT_UNVERIFIED'}); await assert.rejects(h.service.reviewOperation(h.user, h.p.operationId, 0), {code:'BUSINESS_APPROVAL_REPORT_UNVERIFIED'}); assert.equal(h.reads, reads); assert.equal(h.posts, 0); }
});
test('genuine earlier approved events keep their original assurance without a seven-report label', async () => {
  const h = await prepared(); await approve(h); const run = h.data.Runs[0], audit = h.data.Audits.find(row => row._id === run.approval.auditId);
  delete run.approval.reportEvidence; delete audit.inputParams.details.reportEvidenceHash; delete audit.inputParams.details.reportSourceHash;
  assert.equal(await readApprovalReports({models:h.models,run,ownerId:h.user.id}), null);
  const reads = h.reads; assert.equal((await approve(h)).reused, true); assert.equal(h.reads, reads); assert.equal((await h.service.reviewOperation(h.user,h.p.operationId,0)).approvalReports,null);
});
test('approval audit failure rolls back report storage, decision and coordination', async () => {
  const h = await prepared(), before = structuredClone(h.data); h.failCreate = 'Audits'; await assert.rejects(approve(h));
  assert.deepEqual(h.data, before); assert.equal(h.posts, 0); h.failCreate = null; await approve(h); assert.equal(retained(h).length, 1);
});
test('fresh incomplete ledger or cash flow blocks first POST and the same approved run can recover', async () => {
  for (const name of ['GeneralLedger','CashFlow']) {
    const h = await prepared(); await approve(h); const source = h.reportSources; h.reportSources = period => { const value = source(period), raw = unpackReport(name,value.reports[name],2); raw.Header.Currency = 'USD'; value.reports[name] = packReport(name,raw); return value; };
    const approval = structuredClone(h.data.Runs[0].approval); await assert.rejects(h.runtime(h.p.operationId).execute(), /seven critical reports/); assert.equal(h.posts, 0); assert.equal(h.data.Calendars[0].verifiedThrough, null);
    h.reportSources = source; assert.equal((await h.runtime(h.p.operationId).execute()).complete,true); assert.deepEqual(h.data.Runs[0].approval,approval);
  }
});

test('genuine version2 retained approval sources keep their original seven-report meaning', async () => {
  const h = await prepared(); await approve(h); const run = h.data.Runs[0], row = retained(h)[0], approvalAudit = h.data.Audits.find(value => value._id === run.approval.auditId), observationAudit = h.data.Audits.find(value => value._id === row.auditId);
  row.payload.sources.reports = Object.fromEntries(Object.entries(row.payload.sources.reports).map(([name, value]) => [name, packReport(name, unpackReport(name, value, 3), 2)])); row.payload.sources.version = 2;
  row.payload.sourceHash = hash(row.payload.sources); row.candidateHash = hash(row.payload); row._id = hash({ scope, evidenceHash: row.candidateHash }).slice(0, 24); row.auditId = hash({ approvalReports: row.candidateHash }).slice(0, 24);
  Object.assign(run.approval.reportEvidence, { sourceVersion: 2, evidenceHash: row.candidateHash, sourceHash: row.payload.sourceHash });
  Object.assign(approvalAudit.inputParams.details, { reportEvidenceHash: row.candidateHash, reportSourceHash: row.payload.sourceHash });
  observationAudit._id = row.auditId; Object.assign(observationAudit.afterState, { reportEvidenceHash: row.candidateHash, reportSourceHash: row.payload.sourceHash });
  const reads = h.reads, original = hash(row.payload); const evidence = await readApprovalReports({ models: h.models, run, ownerId: h.user.id });
  assert.equal(evidence.sourceVersion, 2); assert.equal(evidence.available, 7); assert.equal(hash(row.payload), original); assert.equal(h.reads, reads); assert.equal(h.posts, 0);
});
