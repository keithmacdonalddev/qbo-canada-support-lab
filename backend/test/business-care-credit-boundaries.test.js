'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope, ownerId } = require('./helpers/business-governance-fixture');
const { hash } = require('../src/modules/business-calendar');
const { activityDefinition } = require('../src/modules/business-activity-preview');
const { readPublishedBusiness, assertPublishedBusiness } = require('../src/modules/business-authority');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
const options = { activityTemplateVersion: 3, copyOnWriteTransactions: true, originalSdkTransport: true };
async function prepared(h, throughDate, key) { const p = await h.service.prepare(h.user, { requestKey: key, throughDate }); await h.service.approve(h.user, p.operationId, { planHash: p.planHash }); return { ...p, runtime: h.runtime(p.operationId) }; }
async function run(h, throughDate, key) { const saved = await prepared(h, throughDate, key), result = await saved.runtime.execute(); assert.equal(result.complete, true, JSON.stringify(result)); return saved; }
const cents = value => Math.round(value * 100);
function creditFor(h, rule) { const intent = h.data.Intents.find(row => row.step.entity === 'CreditMemo' && row.step.details.origin.ruleKey === rule && row.step.details.origin.occurrence.startsWith('2026-10')); assert.ok(intent, rule); const step = h.data.Steps.find(row => row.logicalKey === intent.logicalKey); assert.ok(step?.qboId, rule); return { step, credit: h.records.get('creditmemo:' + step.qboId).record, invoice: h.records.get('invoice:' + step.compilation.relationships[0].qboId).record }; }
test('flagship cross-month credits retain negative AR before application and exact three original October cohorts', { timeout: 360000 }, async () => {
  const h = fixture({ ...options, volumeProfile: 'flagship' }); await h.publish();
  await run(h, '2026-10-31', 'credit-flagship-october-01');
  await run(h, '2026-11-01', 'credit-flagship-credit-02');
  const first = creditFor(h, 'care-subscription-022'), invoiceId = first.invoice.Id, creditId = first.credit.Id;
  assert.equal(first.credit.TxnDate, '2026-11-01'); assert.equal(first.invoice.TxnDate, '2026-10-22'); assert.equal(first.credit.RemainingCredit, first.credit.TotalAmt); assert.equal(first.invoice.Balance, first.invoice.TotalAmt);
  assert.equal(h.data.Evidence.at(-1).proof.financialBasis.find(row => row.qboId === creditId).postings.accountsReceivable, -cents(first.credit.TotalAmt));
  await run(h, '2026-11-02', 'credit-flagship-apply-003');
  assert.equal(h.records.get('creditmemo:' + creditId).record.RemainingCredit, 0);
  assert.equal(cents(h.records.get('invoice:' + invoiceId).record.Balance), cents(first.invoice.TotalAmt) - cents(first.credit.TotalAmt));
  const app = h.data.Evidence.at(-1).proof.financialBasis.find(row => row.entity === 'Payment' && Object.values(row.postings).every(value => value === 0)); assert.ok(app);
  await run(h, '2026-11-08', 'credit-flagship-other-004');
  for (const [rule, date] of [['care-subscription-012', '2026-11-07'], ['care-subscription-017', '2026-11-04'], ['care-subscription-022', '2026-11-01']]) { const found = creditFor(h, rule); assert.equal(found.credit.TxnDate, date); assert.equal(found.credit.RemainingCredit, 0); assert.equal(found.step.compilation.relationships[0].sourceTxnDate, found.invoice.TxnDate); }
  assert.equal(h.records.get('invoice:' + invoiceId).record.Balance, 0); assert.equal(h.data.Calendars[0].verifiedThrough, '2026-11-08');
  assert.ok(h.data.Evidence.every(row => row.proof.complete)); assert.equal(h.data.Writers[0].unresolved, null);
});
test('reviewed future-effective2-to3 preserves old day45/46 collections and applies credits only to new occurrences', { timeout: 240000 }, async () => {
  const h = fixture({ ...options, activityTemplateVersion: 2, continuity: true }); await h.publish();
  const first = await run(h, '2026-10-06', 'credit-upgrade-original-01'), originalPlan = JSON.stringify(h.data.Plans[0]), originalProof = JSON.stringify(h.data.Evidence[0]);
  const draft = h.saveRevision({ activityTemplateVersion: 3 }), selection = { blueprintId: draft._id, blueprintHash: draft.contentHash, effectiveFrom: '2026-10-07' }, review = await h.service.reviewContinuity(h.user, selection), decision = { ...selection, reviewHash: review.reviewHash, reason: 'Owner reviewed future care-service credits while retaining every earlier business obligation.' };
  assert.deepEqual(review.review.changes.activityTemplateVersion, { from: 2, to: 3 }); await h.service.applyContinuity(h.user, decision);
  await run(h, '2026-10-31', 'credit-upgrade-october-002'); assert.equal(h.data.Steps.filter(row => row.entity === 'CreditMemo').length, 0, 'The October6 care occurrence retains v2');
  const november = await run(h, '2026-11-16', 'credit-upgrade-november-3'), plan = h.data.Plans.find(row => row.operationId === november.operationId).manifest;
  for (const stepKey of ['final-payment', 'final-deposit']) { const origin = plan.continuity.origins.find(row => row.ruleKey === 'field-job-001' && row.occurrence === '2026-10-01' && row.stepKey === stepKey); assert.ok(origin); assert.equal(origin.blueprintHash, h.data.Versions[0].contentHash); }
  const credit = plan.continuity.origins.find(row => row.ruleKey === 'care-subscription-002' && row.stepKey === 'credit'); assert.equal(credit.occurrence, '2026-11-06'); assert.equal(credit.blueprintHash, draft.contentHash);
  assert.equal(JSON.stringify(h.data.Plans.find(row => row.operationId === first.operationId)), originalPlan); assert.equal(JSON.stringify(h.data.Evidence[0]), originalProof);
  const replay = await h.service.applyContinuity(h.user, decision); assert.equal(replay.reused, true);
  const down = h.saveRevision({ activityTemplateVersion: 2 }); await assert.rejects(h.service.reviewContinuity(h.user, { blueprintId: down._id, blueprintHash: down.contentHash, effectiveFrom: '2026-11-17' }), /original schedule|upgrade/);
});
test('Stop after accepted credit preserves it, and explicit reviewed resume applies the same credit once', { timeout: 120000 }, async () => {
  const h = fixture(options); await h.publish(); const saved = await prepared(h, '2026-10-20', 'credit-stop-original-0001'); let stopped = false;
  h.afterPost = async opts => { if (!stopped && opts.url.endsWith('/creditmemo')) { stopped = true; await saved.runtime.stop(); } };
  const result = await saved.runtime.execute(); assert.equal(result.state, 'stopped'); assert.equal(h.data.Calendars[0].verifiedThrough, null);
  const original = [...h.records.values()].filter(row => row.entity === 'CreditMemo'); assert.equal(original.length, 1); const creditId = original[0].record.Id, posts = h.posts;
  assert.equal((await saved.runtime.execute()).state, 'stopped'); assert.equal(h.posts, posts);
  const review = await h.service.reviewResume(h.user, saved.operationId, { planHash: saved.planHash }); await h.service.resume(h.user, saved.operationId, { planHash: saved.planHash, reviewHash: review.reviewHash, reason: 'Owner reviewed the stopped credit and its exact saved progress before continuing.' });
  assert.equal((await saved.runtime.execute()).complete, true); const final = [...h.records.values()].filter(row => row.entity === 'CreditMemo'); assert.equal(final.length, 1); assert.equal(final[0].record.Id, creditId); assert.equal(final[0].record.RemainingCredit, 0); assert.equal(h.data.Writers[0].unresolved, null);
});
test('external credit consumption, changed party and missing exact application remain unverified and cannot create replacement cash', { timeout: 180000 }, async () => {
  for (const mode of ['unused', 'party', 'missing']) {
    const h = fixture(options); await h.publish(); await run(h, mode === 'missing' ? '2026-10-17' : '2026-10-16', 'credit-drift-first-' + mode);
    const next = await prepared(h, mode === 'missing' ? '2026-10-20' : '2026-10-17', 'credit-drift-next-' + mode);
    const row = [...h.records.values()].find(value => value.entity === 'CreditMemo').record;
    if (mode === 'unused') row.RemainingCredit -= 1;
    if (mode === 'party') row.CustomerRef.value = '999999';
    if (mode === 'missing') { const app = [...h.records.values()].find(value => value.entity === 'Payment' && value.record.TotalAmt === 0).record; app.Line.pop(); app.SyncToken = String(Number(app.SyncToken) + 1); }
    row.SyncToken = String(Number(row.SyncToken) + 1);
    if (mode === 'missing') await assert.rejects(next.runtime.execute(), /All seven critical reports/);
    else assert.equal((await next.runtime.execute()).complete, false, mode); assert.equal([...h.records.values()].filter(value => value.entity === 'CreditMemo').length, 1); assert.equal([...h.records.values()].filter(value => value.entity === 'Payment' && value.record.CustomerRef?.value === h.data.Versions[0].definition.masterBindings['care-client-002'] && value.record.TotalAmt > 0).length, 0);
    assert.notEqual(h.data.Calendars[0].verifiedThrough, '2026-10-20');
  }
});
test('retained valid Productionv3 authority and pending calendar remain readable, while new publication and admission refuse', async () => {
  const production = { ...scope, environment: 'production' }; config.qbo.environment = 'production';
  try {
    const h = fixture({ ...options, scope: production }), baseline = await h.capture(), definition = h.data.Versions[0].definition;
    const before = h.reads; await assert.rejects(h.service.reviewPublication(h.user, { blueprintHash: h.data.Versions[0].contentHash, baselineId: baseline.id }), /direct Canadian company acceptance/); assert.equal(h.reads, before);
    // Retained data represents a previously accepted authority. This construction
    // is fixture-only; the current publication service above refuses new grants.
    const value = { version: 1, scope: production, status: 'published', ownerId, ownershipDisposition: 'retain-unmanaged', activityTemplateVersion: 3, activityRulesHash: hash(activityDefinition({ openingDate: definition.calendar.openingDate, volumeProfile: definition.volumeProfile, activityTemplateVersion: 3 })), baselineId: baseline.id, baselineHash: h.data.Baselines[0].evidenceHash, inventoryHash: hash(h.data.Baselines[0].inventorySources.records), blueprintId: String(h.data.Versions[0]._id), blueprintHash: h.data.Versions[0].contentHash, businessKey: 'harbour-pine-v2', openingDate: definition.calendar.openingDate };
    const contentHash = hash(value), auditId = 'e'.repeat(24); h.data.Authorities.push({ _id: 'f'.repeat(24), contractVersion: 1, ...production, payload: value, contentHash, auditId });
    h.data.Audits.push({ _id: auditId, userId: ownerId, realmId: production.realmId, action: 'Business published and opening evidence accepted', outcome: 'success', afterState: { authorityHash: contentHash, blueprintHash: value.blueprintHash, baselineHash: value.baselineHash, inventoryHash: value.inventoryHash } });
    h.data.Calendars.push({ _id: production.environment + ':' + production.realmId, ...production, authorityHash: contentHash, authorityRevision: 0, blueprintId: value.blueprintId, blueprintHash: value.blueprintHash, businessKey: value.businessKey, openingDate: value.openingDate, baseline: { status: 'verified', evidenceHash: value.baselineHash }, currentOperationId: null, verifiedThrough: null, pendingCommit: null, revision: 0, writerRevision: 0 });
    assert.equal((await readPublishedBusiness({ ...h.models, scope: production })).value.activityTemplateVersion, 3); assert.equal((await h.service.status(h.user)).published.activityTemplateVersion, 3);
    await assert.rejects(assertPublishedBusiness({ ...h.models, scope: production, requireScheduleAcceptance: true }), /direct Canadian company acceptance/);
    h.data.Calendars[0].pendingCommit = { operationId: 'd'.repeat(24) };
    assert.ok((await readPublishedBusiness({ ...h.models, scope: production })).calendar.pendingCommit); assert.equal((await h.service.status(h.user)).calendar.completionPending, true); assert.equal(h.posts, 0);
  } finally { config.qbo.environment = 'sandbox'; }
});
