'use strict';
// Activity policy v7: corrections of the accountant's own records (pure rules).
const test = require('node:test'), assert = require('node:assert/strict');
const { hash, canonical } = require('../src/modules/business-calendar');
const batchTools = require('../src/modules/business-activity-batch');
const { deriveBusinessPolicies, taxCents } = require('../src/modules/business-tax-policy');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const H = value => hash({ correctionFixture: value });
const original = (entity, extra = {}) => ({ entity, qboId: '501', logicalKey: H('original-' + entity), fingerprint: H('fingerprint'), txnDate: '2026-11-21', policyHash: H('policy'), compilationHash: H('compilation'), ...extra });
const sources = entity => [{ logicalKey: H('original-' + entity), entity, txnDate: '2026-11-21', dependsOn: [] }];
const salesTax = (base = 20000, percent = 13) => ({ codeId: '900', totalTaxCents: taxCents(base, percent), lines: [{ rateId: '950', percent, taxableCents: base, amountCents: taxCents(base, percent) }] });
const saleTerms = (kind = 'credit-unpaid-invoice', extra = {}) => ({ kind, original: original('Invoice'), sources: sources('Invoice'), customerKey: 'care-client-005', lines: [{ key: 'primary', itemKey: 'care-plan-2', quantity: 1, unit: 'month', unitPriceCents: 20000, amountCents: 20000, accountMapping: 'careIncome' }], tax: salesTax(), ...extra });
const billTerms = (extra = {}) => ({ kind: 'credit-unpaid-bill', original: original('Bill'), sources: sources('Bill'), vendorKey: 'overhead-supplier-3', expenseCategory: 'software', lines: [{ key: 'primary', accountMapping: 'operatingExpense', amountCents: 9500, billableStatus: 'NotBillable' }], tax: { codeId: '901', totalTaxCents: 1235, lines: [{ rateId: '951', percent: 13, taxableCents: 9500, amountCents: 1235 }] }, ...extra });
const journalTerms = (extra = {}) => ({ kind: 'reverse-journal', original: original('JournalEntry'), sources: sources('JournalEntry'), lines: [{ key: 'line-1', accountMapping: 'careIncome', postingType: 'Debit', amountCents: 3000 }, { key: 'line-2', accountMapping: 'operatingExpense', postingType: 'Credit', amountCents: 3000 }], ...extra });
const choices = (correction, key = 'correct-001', target = { entity: correction.original.entity, qboId: correction.original.qboId }) => ({ decisionKey: key, purpose: 'Correct an earlier record that was issued by mistake.', activities: [{ type: 'correct-own-record', target, purpose: 'Issued to the wrong client by mistake.', correction }] });
const build = (correction, key = 'correct-001', day = '2026-12-01') => { const batch = batchTools.makeActivityBatch({ scope, businessKey: 'b', day, choices: choices(correction, key) }); return { batch, activity: batchTools.buildBatchActivity(batch, scope, 'b') }; };
const stepOf = (activity, event) => ({ logicalKey: event.logicalKey, entity: event.entity, txnDate: event.txnDate, dependencies: event.dependsOn.map(key => ({ logicalKey: key, entity: [...activity.prerequisites, ...activity.events].find(row => row.logicalKey === key).entity })), details: structuredClone(activity.detailProposal.byLogicalKey[event.logicalKey].details) });

test('policy v7 adds corrections; v6 is frozen with its exact published semantics', () => {
  // v8 (business lifecycles on terms) keeps corrections; v7 is frozen as published.
  assert.ok(batchTools.POLICY.version >= 7); assert.ok(batchTools.POLICY.workflows.includes('correct-own-record'));
  assert.ok([...batchTools.SAVED_POLICIES.values()].some(policy => policy.version === 7 && policy.key === 'business-activity-v7' && policy.workflows.at(-1) === 'correct-own-record'));
  const v6 = { version: 6, key: 'business-activity-v6', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxSettlementCents: 5000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense', 'collect-adopted-invoice', 'pay-adopted-bill', 'paid-cash-expense', 'supplier-credit', 'customer-credit', 'customer-refund', 'bank-transfer', 'journal-entry', 'receive-purchase-order', 'add-customer', 'add-supplier', 'add-item'] };
  assert.equal(canonical(batchTools.SAVED_POLICIES.get(hash(v6))), canonical(v6));
  assert.notEqual(batchTools.POLICY_HASH, hash(v6));
  assert.deepEqual([...batchTools.SAVED_POLICIES.values()].map(policy => policy.version).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Saved v1–v6 batches cannot claim the new workflow and keep rebuilding unchanged.
  for (const policy of [...batchTools.SAVED_POLICIES.values()].filter(value => value.version < 7)) {
    assert.throws(() => batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: choices(saleTerms()), policy }), /not part of the saved activity policy/);
    const sale = batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', policy, choices: { decisionKey: 'sale-policy-v' + policy.version, purpose: 'Sell a monthly care plan to a returning client.', activities: [{ type: 'settled-service-sale', customerKey: 'care-client-001', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] } });
    const activity = batchTools.buildBatchActivity(sale, scope, 'b');
    assert.equal(sale.policyHash, hash(policy)); assert.deepEqual(activity.events.map(event => event.entity), ['Invoice', 'Payment', 'Deposit']); assert.deepEqual(activity.prerequisites, []);
    for (const event of activity.events) assert.equal(event.logicalKey, hash({ realmId: '123', environment: 'sandbox', businessKey: 'b', ruleKey: event.ruleKey, occurrence: '2026-12-01', stepKey: event.stepKey }));
    for (const event of activity.events) assert.equal(batchTools.batchLifecycle(stepOf(activity, event)).mode, 'standard');
  }
});

test('the agent names only a target and reason; terms are server-derived', () => {
  const minimal = { decisionKey: 'correct-min-001', purpose: 'Correct an earlier record that was issued by mistake.', activities: [{ type: 'correct-own-record', target: { entity: 'Invoice', qboId: '501' }, purpose: 'Issued to the wrong client by mistake.' }] };
  assert.deepEqual(batchTools.validateChoices(minimal).activities[0], minimal.activities[0]);
  assert.throws(() => batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: minimal }), /derived by the server/);
  for (const target of [{ entity: 'Purchase', qboId: '1' }, { entity: 'Invoice', qboId: 'x' }, { entity: 'Invoice' }]) assert.throws(() => batchTools.validateChoices({ ...minimal, activities: [{ ...minimal.activities[0], target }] }));
  assert.throws(() => batchTools.validateChoices({ ...minimal, activities: [{ ...minimal.activities[0], amountCents: 5 }] }));
  // A record from today is corrected tomorrow, after its history verified.
  assert.throws(() => build(saleTerms(), 'correct-today', '2026-11-21'), /tomorrow/);
});

test('each kind builds its exact reversal; identities come from the original, never the batch', () => {
  const kinds = { 'credit-unpaid-invoice': [saleTerms(), ['CreditMemo', 'Payment'], ['correction-credit', 'correction-application']], 'refund-collected-sale': [saleTerms('refund-collected-sale'), ['RefundReceipt'], ['correction-refund']], 'credit-unpaid-bill': [billTerms(), ['VendorCredit', 'BillPayment'], ['correction-supplier-credit', 'correction-bill-application']], 'reverse-journal': [journalTerms(), ['JournalEntry'], ['correction-journal']] };
  for (const [kind, [terms, entities, modes]] of Object.entries(kinds)) {
    const { activity } = build(terms), again = build(terms, 'another-decision-key', '2026-12-09').activity;
    assert.deepEqual(activity.events.map(event => event.entity), entities, kind);
    // A second batch (other decision key, other day) collides on the same identities.
    assert.deepEqual(again.events.map(event => event.logicalKey), activity.events.map(event => event.logicalKey), kind);
    for (const event of activity.events) {
      assert.equal(event.ruleKey, 'correction-' + terms.original.logicalKey.slice(0, 40)); assert.equal(event.occurrence, '2026-11-21'); assert.equal(event.txnDate, '2026-12-01');
      assert.ok(event.dependsOn.includes(terms.original.logicalKey));
    }
    assert.deepEqual(activity.prerequisites, terms.sources.map(row => ({ ...row })));
    assert.deepEqual(activity.events.map(event => batchTools.batchLifecycle(stepOf(activity, event)).mode), modes, kind);
  }
  const credit = build(saleTerms()).activity, [memo, application] = credit.events, detail = event => credit.detailProposal.byLogicalKey[event.logicalKey].details;
  assert.deepEqual(application.dependsOn.sort(), [memo.logicalKey, saleTerms().original.logicalKey].sort());
  assert.deepEqual(detail(memo).originalTax, salesTax()); assert.equal(detail(memo).baseAmountCents, 20000); assert.equal(detail(memo).datedTax, undefined);
  assert.equal(detail(application).amountRule, 'correction_application'); assert.equal(detail(application).amountSourceKey, saleTerms().original.logicalKey); assert.deepEqual(detail(application).lines, []);
  const refund = build(saleTerms('refund-collected-sale')).activity, refundDetail = refund.detailProposal.byLogicalKey[refund.events[0].logicalKey].details;
  assert.equal(refundDetail.bankMapping, 'operatingBank'); assert.equal(refundDetail.fundingSource, 'operating_bank');
  const journal = build(journalTerms()).activity;
  assert.deepEqual(batchTools.batchLifecycle(stepOf(journal, journal.events[0])).journal, [{ accountMapping: 'careIncome', postingType: 'Debit', amountCents: 3000 }, { accountMapping: 'operatingExpense', postingType: 'Credit', amountCents: 3000 }]);
  // A field invoice's estimate and time are existing prerequisites too.
  const field = saleTerms('credit-unpaid-invoice', { sources: [...sources('Invoice'), { logicalKey: 'f'.repeat(64), entity: 'Estimate', txnDate: '2026-11-14', dependsOn: [] }].sort((a, b) => a.logicalKey.localeCompare(b.logicalKey)) });
  field.sources.find(row => row.entity === 'Invoice').dependsOn = ['f'.repeat(64)];
  assert.equal(build(field).activity.prerequisites.length, 2);
  // The credit binds the earliest date across the invoice and its sources (the estimate).
  const fieldBuilt = build(field).activity, fieldDetail = event => fieldBuilt.detailProposal.byLogicalKey[event.logicalKey].details;
  assert.equal(fieldDetail(fieldBuilt.events[0]).correction.earliestSourceTxnDate, '2026-11-14'); assert.equal(fieldDetail(fieldBuilt.events[1]).correction.earliestSourceTxnDate, undefined);
  assert.equal(batchTools.batchLifecycle(stepOf(fieldBuilt, fieldBuilt.events[0])).correction.earliestSourceTxnDate, '2026-11-14');
  assert.equal(build(billTerms()).activity.detailProposal.byLogicalKey[build(billTerms()).activity.events[0].logicalKey].details.correction.earliestSourceTxnDate, '2026-11-21');
});

test('tampered or unsupported correction terms are refused', () => {
  const refuse = (terms, pattern) => assert.throws(() => batchTools.validateChoices(choices(terms)), pattern);
  refuse(saleTerms('credit-unpaid-invoice', { lines: [{ key: 'primary', itemKey: 'workshop-stock-1', quantity: 2, unit: 'each', unitPriceCents: 1000, amountCents: 2000, accountMapping: 'supplyIncome' }] }), /published service lines/);
  refuse(saleTerms('credit-unpaid-invoice', { customerKey: 'added-customer-0123456789ab' }), /published customers/);
  refuse(saleTerms('credit-unpaid-invoice', { tax: { ...salesTax(), totalTaxCents: 2599 } }), /exact original tax/);
  refuse(saleTerms('credit-unpaid-invoice', { tax: { codeId: '900', totalTaxCents: 2600, lines: [{ rateId: '950', percent: 13, taxableCents: 19999, amountCents: 2600 }] } }), /exact original tax/);
  refuse(saleTerms('credit-unpaid-invoice', { sources: [{ logicalKey: 'e'.repeat(64), entity: 'Invoice', txnDate: '2026-11-21', dependsOn: [] }] }));
  refuse(saleTerms('credit-unpaid-invoice', { sources: [{ ...sources('Invoice')[0], dependsOn: ['f'.repeat(64)] }] }));
  refuse(saleTerms('refund-collected-sale', { original: original('Bill') }));
  refuse(billTerms({ vendorKey: 'added-supplier-0123456789ab' }), /published suppliers/);
  refuse(billTerms({ lines: [{ key: 'primary', accountMapping: 'inventoryAsset', amountCents: 9500, billableStatus: 'NotBillable' }] }));
  refuse(journalTerms({ lines: [{ key: 'line-1', accountMapping: 'careIncome', postingType: 'Debit', amountCents: 3000 }, { key: 'line-2', accountMapping: 'operatingExpense', postingType: 'Credit', amountCents: 2999 }] }), /balance/);
  refuse(journalTerms({ lines: [{ key: 'line-1', accountMapping: 'operatingBank', postingType: 'Debit', amountCents: 3000 }, { key: 'line-2', accountMapping: 'operatingExpense', postingType: 'Credit', amountCents: 3000 }] }));
  refuse({ ...saleTerms(), extra: true });
  assert.throws(() => batchTools.validateChoices(choices(saleTerms(), 'k-001', { entity: 'Invoice', qboId: '777' })));
  // Once per batch, and two corrections cannot share an original.
  const twice = choices(saleTerms()); twice.activities.push(structuredClone(twice.activities[0]));
  assert.throws(() => batchTools.validateChoices(twice), /once per batch/);
  const shared = choices(saleTerms()); shared.activities.push({ ...structuredClone(shared.activities[0]), target: { entity: 'Bill', qboId: '501' }, correction: billTerms({ sources: [{ ...sources('Invoice')[0], entity: 'Bill' }], original: original('Bill', { logicalKey: H('original-Invoice') }) }) });
  assert.throws(() => batchTools.validateChoices(shared), /share an original/);
});

test('a correction step keeps its exact lifecycle in isolation', () => {
  const { activity } = build(saleTerms()), memo = stepOf(activity, activity.events[0]), application = stepOf(activity, activity.events[1]);
  const lifecycle = batchTools.batchLifecycle(memo);
  assert.deepEqual(lifecycle.correction, { kind: 'credit-unpaid-invoice', original: saleTerms().original, earliestSourceTxnDate: '2026-11-21' }); assert.deepEqual(lifecycle.originalTax, salesTax());
  // Only the credit step binds the earliest source date; its application does not.
  assert.deepEqual(batchTools.batchLifecycle(application).correction, { kind: 'credit-unpaid-invoice', original: saleTerms().original });
  for (const mutate of [s => { delete s.details.correction.earliestSourceTxnDate; }, s => { s.details.correction.earliestSourceTxnDate = '2026-11-22'; }, s => { s.details.correction.earliestSourceTxnDate = 'soon'; }])
    { const changed = structuredClone(memo); mutate(changed); assert.throws(() => batchTools.batchLifecycle(changed)); }
  { const changed = structuredClone(application); changed.details.correction.earliestSourceTxnDate = '2026-11-21'; assert.throws(() => batchTools.batchLifecycle(changed)); }
  for (const mutate of [s => { delete s.details.originalTax; }, s => { s.details.originalTax.lines[0].percent = 14; s.details.originalTax.lines[0].amountCents = 2800; }, s => { s.details.bankMapping = 'operatingBank'; }, s => { s.details.taxMapping = 'purchaseTax'; }, s => { s.dependencies = []; }, s => { s.details.correction.kind = 'refund-collected-sale'; }, s => { s.details.dueDate = '2026-12-01'; }, s => { s.details.lines[0].quantity = 2; }])
    { const changed = structuredClone(memo); mutate(changed); assert.throws(() => batchTools.batchLifecycle(changed)); }
  for (const mutate of [s => { s.details.amountRule = 'saved_originating_total'; }, s => { s.details.cashDirection = 'inflow'; }, s => { s.details.amountSourceKey = 'e'.repeat(64); }, s => { s.dependencies = s.dependencies.slice(0, 1); }, s => { s.details.lines = [{ amountCents: 1 }]; }])
    { const changed = structuredClone(application); mutate(changed); assert.throws(() => batchTools.batchLifecycle(changed)); }
  // Ordinary steps cannot borrow correction terms.
  const sale = batchTools.buildBatchActivity(batchTools.makeActivityBatch({ scope, businessKey: 'b', day: '2026-12-01', choices: { decisionKey: 'sale-plain-001', purpose: 'Sell a monthly care plan to a returning client.', activities: [{ type: 'settled-service-sale', customerKey: 'care-client-001', itemKey: 'care-plan-1', quantity: 1, unitPriceCents: 1000, purpose: 'Monthly care plan.' }] } }), scope, 'b');
  const invoice = stepOf(sale, sale.events[0]); invoice.details.originalTax = salesTax(1000);
  assert.throws(() => batchTools.batchLifecycle(invoice), /exact derived reversal terms/);
});

// Original-supply tax (CRA Notice 342): a reversal repeats the original rate exactly,
// even when corrected after the Nova Scotia change, or it is refused.
function taxClient(rateHistory) {
  const records = { 'TaxCode:900': { Id: '900', SyncToken: '0', Active: true, Taxable: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '950' }, TaxTypeApplicable: 'TaxOnAmount', TaxOnTaxOrder: 0 }] } }, 'TaxRate:950': { Id: '950', SyncToken: '0', Active: true, RateValue: rateHistory.at(-1).RateValue, EffectiveTaxRate: rateHistory } };
  return { read: async (entity, id) => { const key = { taxcode: 'TaxCode', taxrate: 'TaxRate' }[entity] + ':' + id; return { [key.split(':')[0]]: structuredClone(records[key]) }; } };
}
async function derive(terms, client) {
  const { activity } = build(terms), event = activity.events[0], step = { ...stepOf(activity, event), calendarFingerprint: event.fingerprint, references: [{ entity: 'TaxCode', key: 'salesTax', id: '900' }] };
  step.dependencies = step.dependencies.map(link => ({ ...link, fingerprint: H('fingerprint') }));
  const assembly = { candidate: { scope, fromDate: '2026-12-01', throughDate: '2026-12-01', entries: [{ kind: 'create', step }] } };
  return (await deriveBusinessPolicies(assembly, client, 'c'.repeat(64), Date.parse('2026-12-01T15:00:00Z')))[0].policy;
}
test('a correction repeats the original 15 or 14 percent tax exactly, or is refused', async () => {
  // 333 cents: 15% is 49.95 -> 50 cents; 14% is 46.62 -> 47 cents (half-up, exact cents).
  assert.equal(taxCents(333, 15), 50); assert.equal(taxCents(333, 14), 47);
  const line = { key: 'primary', itemKey: 'care-plan-1', quantity: 1, unit: 'month', unitPriceCents: 333, amountCents: 333, accountMapping: 'careIncome' };
  const fifteen = saleTerms('credit-unpaid-invoice', { original: original('Invoice', { txnDate: '2025-03-20' }), sources: [{ ...sources('Invoice')[0], txnDate: '2025-03-20' }], lines: [line], tax: salesTax(333, 15) });
  // The original 15% code still produces 15% today: the reversal repeats 15%.
  const policy = await derive(fifteen, taxClient([{ EffectiveDate: '2016-07-01', RateValue: 15 }]));
  assert.deepEqual(policy.readbackTax, { version: 1, totalTaxCents: 50, lines: [{ rateId: '950', percent: 15, taxableCents: 333, amountCents: 50 }] });
  assert.equal(policy.lifecycle.mode, 'correction-credit'); assert.equal(policy.datedTax, undefined);
  // The same code now yields 14% on a record dated today: QuickBooks would credit 14%, so refuse.
  await assert.rejects(derive(fifteen, taxClient([{ EffectiveDate: '2016-07-01', EndDate: '2025-04-01', RateValue: 15 }, { EffectiveDate: '2025-04-01', RateValue: 14 }])), /repeat the original 15% tax exactly/);
  // The old rate ended with no successor: still refused, never silently taxed at 0%.
  await assert.rejects(derive(fifteen, taxClient([{ EffectiveDate: '2016-07-01', EndDate: '2025-04-01', RateValue: 15 }])), /repeat the original 15% tax exactly/);
  // An original 14% supply after April 2025 reverses at 14%.
  const fourteen = { ...fifteen, original: original('Invoice', { txnDate: '2025-06-02' }), sources: [{ ...sources('Invoice')[0], txnDate: '2025-06-02' }], tax: salesTax(333, 14) };
  assert.equal((await derive(fourteen, taxClient([{ EffectiveDate: '2016-07-01', EndDate: '2025-04-01', RateValue: 15 }, { EffectiveDate: '2025-04-01', RateValue: 14 }]))).readbackTax.totalTaxCents, 47);
  // Terms whose cents differ from what the rate yields are refused.
  await assert.rejects(derive({ ...fifteen, tax: { codeId: '900', totalTaxCents: 49, lines: [{ rateId: '950', percent: 15, taxableCents: 333, amountCents: 49 }] } }, taxClient([{ EffectiveDate: '2016-07-01', RateValue: 15 }])), /repeat the original/);
  // Another tax code than the original's is refused.
  await assert.rejects(derive({ ...fifteen, tax: { ...salesTax(333, 15), codeId: '902' } }, taxClient([{ EffectiveDate: '2016-07-01', RateValue: 15 }])), /repeat the original/);
});
