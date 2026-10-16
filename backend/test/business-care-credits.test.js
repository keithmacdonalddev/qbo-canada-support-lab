'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope } = require('./helpers/business-governance-fixture');
const { activityDefinition, assertActivityTemplateAccepted } = require('../src/modules/business-activity-preview');
const { planBusinessCalendar, hash } = require('../src/modules/business-calendar');
const { describeBusinessActivity } = require('../src/modules/business-activity-details');
const { readPublishedBusiness, assertPublishedBusiness } = require('../src/modules/business-authority');
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; });
test.after(() => { config.qbo.environment = previous; });
const options = { activityTemplateVersion: 3, copyOnWriteTransactions: true, originalSdkTransport: true };
async function period(h, throughDate, key) {
  const saved = await h.service.prepare(h.user, { requestKey: key, throughDate });
  await h.service.approve(h.user, saved.operationId, { planHash: saved.planHash });
  return { ...saved, runtime: h.runtime(saved.operationId) };
}
const money = value => Math.round(value * 100);
const originals = [
  ['c8b569d8c7357b1104b5df522bffb6d90e2da1d6578034ea7d2a293e3f18832a', '5629578bf4277fe654d12fa5c036224cbd544cfde23c80b2818ae94eae42092e', 'dffe6b1ab13220c67475b0b682a34f5f8f9de6b2bf7c7e246ec3e40f8ac2e14f', 70],
  ['51ff43d254256b809bacab3a075657fe762aa745e6047be3d3d70337001e149a', 'afe81330dc4f44245eef88e2b8a46e8e097f7b7688f884e4d6a399d5242cd2f3', 'e17c4d578c28b202282ab9ce37ea6e9ba4e188269ac00cc9e17cf1980b3358d7', 80],
];
function calendar(version, volumeProfile = 'development', fromDate = '2026-10-01', throughDate = '2026-10-31') {
  const definition = activityDefinition({ activityTemplateVersion: version, volumeProfile, openingDate: '2026-10-01' });
  return { definition, plan: planBusinessCalendar({ definition, scope: { realmId: '1234567890', environment: 'sandbox' }, fromDate, throughDate, today: '2026-12-01' }) };
}
test('literal original schedule hashes remain exact; new fixed care cohorts preserve business identities and late cohorts', () => {
  for (const version of [1, 2]) {
    const { definition, plan } = calendar(version), actual = [hash(definition), plan.planHash, hash(describeBusinessActivity(plan)), definition.rules.reduce((sum, row) => sum + row.steps.length, 0)];
    assert.deepEqual(actual, originals[version - 1]);
  }
  for (const [volume, count] of [['development', 82], ['flagship', 288]]) {
    const { definition, plan } = calendar(3, volume), old = calendar(2, volume).plan;
    assert.equal(definition.businessKey, 'harbour-pine-v2');
    assert.equal(definition.rules.reduce((sum, row) => sum + row.steps.length, 0), count);
    for (const event of old.events) assert.ok([...plan.events, ...plan.future].some(row => row.logicalKey === event.logicalKey && row.entity === event.entity && row.txnDate === event.txnDate));
    const credits = definition.rules.filter(row => row.steps.some(step => step.entity === 'CreditMemo'));
    assert.deepEqual(credits.map(row => row.key), volume === 'development' ? ['care-subscription-002'] : ['care-subscription-002', 'care-subscription-007', 'care-subscription-012', 'care-subscription-017', 'care-subscription-022']);
    assert.equal(definition.rules.find(row => row.key === 'care-subscription-001').steps.find(row => row.key === 'payment').offsetDays, 45);
  }
  const cross = calendar(3, 'flagship', '2026-11-01', '2026-11-08').plan;
  for (const key of ['care-subscription-012', 'care-subscription-017', 'care-subscription-022']) assert.ok(cross.events.some(row => row.ruleKey === key && row.entity === 'CreditMemo' && row.occurrence.startsWith('2026-10')));
});
test('separate saved periods prove unapplied credit, zero-funds application and only the actual remaining cash', { timeout: 240000 }, async () => {
  const h = fixture(options); await h.publish();
  const first = await period(h, '2026-10-16', 'credit-first-create-0001');
  assert.equal((await first.runtime.execute()).complete, true);
  const creditStep = h.data.Steps.find(row => row.entity === 'CreditMemo'), credit = h.records.get('creditmemo:' + creditStep.qboId).record;
  const original = creditStep.compilation.relationships[0], invoice = h.records.get('invoice:' + original.qboId).record;
  assert.equal(original.kind, 'prerequisite'); assert.equal(original.sourceTxnDate, '2026-10-06');
  assert.equal(JSON.parse(creditStep.compilation.request.body).LinkedTxn, undefined);
  assert.equal(credit.RemainingCredit, credit.TotalAmt); assert.equal(invoice.Balance, invoice.TotalAmt);
  assert.equal(money(credit.TotalAmt), 2249); assert.equal(money(invoice.TotalAmt), 22487);
  const firstProof = h.data.Evidence.at(-1).proof, creditBasis = firstProof.financialBasis.find(row => row.entity === 'CreditMemo');
  assert.equal(creditBasis.postings.accountsReceivable, -2249); assert.equal(creditBasis.postings.careIncome, 1990);
  assert.equal((await first.runtime.inspect()).financialMovements.status, 'passed');
  assert.equal(h.data.Receipts.find(row => row.entity === 'creditmemo').periodProof.businessCreditSource.sourceTxnDate, '2026-10-06');
  const second = await period(h, '2026-10-17', 'credit-application-0002');
  assert.equal((await second.runtime.execute()).complete, true);
  const applicationStep = h.data.Steps.find(row => row.entity === 'Payment' && JSON.parse(row.compilation.request.body).TotalAmt === 0);
  const application = h.records.get('payment:' + applicationStep.qboId).record;
  assert.equal(application.TotalAmt, 0); assert.equal(application.UnappliedAmt, 0); assert.equal(application.ProcessPayment, false);
  assert.deepEqual(application.Line.map(row => [money(row.Amount), row.LinkedTxn[0].TxnType]).sort((a,b)=>a[1].localeCompare(b[1])), [[2249, 'CreditMemo'], [2249, 'Invoice']]);
  assert.equal(h.records.get('creditmemo:' + credit.Id).record.RemainingCredit, 0);
  assert.equal(money(h.records.get('invoice:' + invoice.Id).record.Balance), 20238);
  const applicationBasis = h.data.Evidence.at(-1).proof.financialBasis.find(row => row.qboId === application.Id);
  assert.ok(Object.values(applicationBasis.postings).every(value => value === 0));
  assert.equal((await second.runtime.inspect()).financialMovements.status, 'passed');
  const third = await period(h, '2026-10-20', 'credit-cash-remainder-003');
  assert.equal((await third.runtime.execute()).complete, true);
  const cash = [...h.records.values()].filter(row => row.entity === 'Payment' && row.record.TotalAmt > 0 && row.record.CustomerRef.value === invoice.CustomerRef.value);
  assert.equal(cash.length, 1); assert.equal(money(cash[0].record.TotalAmt), money(invoice.TotalAmt) - money(credit.TotalAmt));
  assert.equal(h.records.get('invoice:' + invoice.Id).record.Balance, 0);
  assert.equal((await third.runtime.inspect()).financialMovements.status, 'passed');
  const posts = h.posts; assert.equal((await third.runtime.execute()).complete, true); assert.equal(h.posts, posts);
  assert.equal((await first.runtime.inspect()).financialMovements.status, 'passed');
});
test('original effective tax-rate drift refuses credit creation before its transport receipt or SDK POST', { timeout: 120000 }, async () => {
  const h = fixture(options); await h.publish();
  const first = await period(h, '2026-10-15', 'credit-tax-original-0001'); assert.equal((await first.runtime.execute()).complete, true);
  h.records.get('taxrate:950').record.EffectiveTaxRate.push({ EffectiveDate: '2026-10-16T00:00:00-04:00', RateValue: 14 });
  h.records.get('taxrate:950').record.SyncToken = '1';
  const next = await period(h, '2026-10-16', 'credit-tax-drift-000002'); const result = await next.runtime.execute();
  assert.equal(result.complete, false); assert.match(result.error, /tax-rate identities and percentages/);
  assert.equal(h.data.Receipts.filter(row => row.entity === 'creditmemo').length, 0);
  assert.equal([...h.records.values()].filter(row => row.entity === 'CreditMemo').length, 0);
  assert.equal(h.data.Calendars[0].verifiedThrough, '2026-10-15');
});
test('already protected original invoice refuses credit before it can leave an inevitably blocked application', { timeout: 120000 }, async () => {
  const h = fixture(options); await h.publish(); const first = await period(h, '2026-10-15', 'credit-cutoff-original-001'); assert.equal((await first.runtime.execute()).complete, true);
  const old = h.data.Policies[0].periodControl, { contentHash, ...source } = old; source.closedThrough = '2026-10-06'; h.data.Policies[0].periodControl = { ...source, contentHash: hash(source) }; h.data.Policies[0].revision++;
  const next = await period(h, '2026-10-16', 'credit-cutoff-denied-0002'); const result = await next.runtime.execute(); assert.equal(result.complete, false); assert.equal(result.code, 'BUSINESS_CREDIT_SOURCE_PROTECTED'); assert.match(result.error, /This credit was not sent/);
  assert.equal([...h.records.values()].filter(row => row.entity === 'CreditMemo').length, 0); assert.equal(h.data.Receipts.filter(row => row.entity === 'creditmemo').length, 0);
  assert.equal(h.data.Writers[0].unresolved, null); assert.ok(h.data.Audits.some(row => row.action === 'Business dispatch proved never admitted'));
});
test('lost acknowledgement after saved credit keeps the original uncertainty and never creates replacement credit or cash', { timeout: 120000 }, async () => {
  const h = fixture(options); await h.publish(); const saved = await period(h, '2026-10-20', 'credit-unknown-original-01');
  let lost = false; h.afterPost = opts => { if (!lost && opts.url.endsWith('/creditmemo')) { lost = true; throw Error('Fixture lost credit response'); } };
  const result = await saved.runtime.execute(); assert.equal(result.complete, false); assert.equal(result.state, 'recovery_required');
  const records = [...h.records.values()].filter(row => row.entity === 'CreditMemo'); assert.equal(records.length, 1);
  const uncertain = structuredClone(h.data.Writers[0].unresolved), posts = h.posts; assert.ok(uncertain.transportConsumed);
  assert.equal((await saved.runtime.execute()).complete, false); assert.equal(h.posts, posts); assert.deepEqual(h.data.Writers[0].unresolved, uncertain);
  assert.equal([...h.records.values()].filter(row => row.entity === 'CreditMemo').length, 1); assert.equal(h.data.Calendars[0].verifiedThrough, null);
});
test('Production release is explicit and version-aware; original continuing schedule remains available', () => {
  assert.doesNotThrow(() => assertActivityTemplateAccepted({ activityTemplateVersion: 2 }, { environment: 'production' }));
  assert.doesNotThrow(() => assertActivityTemplateAccepted({ activityTemplateVersion: 3 }, { environment: 'sandbox' }));
  assert.throws(() => assertActivityTemplateAccepted({ activityTemplateVersion: 3 }, { environment: 'production' }), /direct Canadian company acceptance/);
});
