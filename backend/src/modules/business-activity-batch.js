'use strict';
// Business choices only. This module never accepts a QBO payload or performs I/O.
const { hash, canonical, date, shift } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const POLICY = Object.freeze({ version: 1, key: 'non-stock-business-activity-v1', maxActivities: 12, maxQuantity: 8, maxUnitPriceCents: 100000, maxExpenseCents: 1000000, maxBatchCents: 12000000, workflows: ['settled-service-sale', 'paid-operating-expense'] });
const POLICY_HASH = hash(POLICY), HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_ACTIVITY_UNVERIFIED' }); }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Use the supported business choices without raw accounting or authority overrides.'); }
function text(value, min, max) { if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\u0000-\u001f]/.test(value)) fail('Retain a concise business purpose and unique decision identifier.'); return value.trim(); }
function integer(value, max) { if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('Business amounts and quantities exceed this activity batch capacity.'); return value; }
function validateChoices(input) {
  exact(input, ['decisionKey', 'purpose', 'activities']);
  const decisionKey = text(input.decisionKey, 8, 100), purpose = text(input.purpose, 20, 2000);
  if (!/^[a-zA-Z0-9_-]+$/.test(decisionKey) || !Array.isArray(input.activities) || input.activities.length < 1 || input.activities.length > POLICY.maxActivities) fail('Choose one to twelve concrete business activities and retain their decision identifier.');
  let cents = 0;
  const activities = input.activities.map(row => {
    if (row?.type === 'settled-service-sale') {
      exact(row, ['type', 'customerKey', 'itemKey', 'quantity', 'unitPriceCents', 'purpose']);
      if (!/^(field-client-0(?:0[1-9]|1[0-5])|care-client-0(?:0[1-9]|1[0-9]|2[0-5]))$/.test(row.customerKey || '') || !['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'].includes(row.itemKey)) fail('Choose an observed service and customer role from the published business.');
      const quantity = integer(row.quantity, POLICY.maxQuantity), unitPriceCents = integer(row.unitPriceCents, POLICY.maxUnitPriceCents);
      cents += quantity * unitPriceCents;
      return { type: row.type, customerKey: row.customerKey, itemKey: row.itemKey, quantity, unitPriceCents, purpose: text(row.purpose, 10, 500) };
    }
    if (row?.type === 'paid-operating-expense') {
      exact(row, ['type', 'vendorKey', 'category', 'amountCents', 'purpose']);
      if (!/^overhead-supplier-[1-3]$/.test(row.vendorKey || '') || !['premises', 'utilities', 'software'].includes(row.category)) fail('Choose a published operating supplier and expense category.');
      const amountCents = integer(row.amountCents, POLICY.maxExpenseCents); cents += amountCents;
      return { type: row.type, vendorKey: row.vendorKey, category: row.category, amountCents, purpose: text(row.purpose, 10, 500) };
    }
    fail('Only settled service sales and paid non-stock overhead are supported in these additional activity batches.');
  });
  if (cents > POLICY.maxBatchCents) fail('This activity batch exceeds its exact-cent capacity.');
  return { decisionKey, purpose, activities };
}
function makeActivityBatch({ scope, businessKey, day, choices }) {
  choices = validateChoices(choices); date(day);
  const requestHash = hash(choices), key = hash({ version: 1, scope, businessKey, day, decisionKey: choices.decisionKey });
  return { version: 1, policyHash: POLICY_HASH, key, requestHash, day, ...choices };
}
function buildBatchActivity(batch, scope, businessKey) {
  exact(batch, ['version', 'policyHash', 'key', 'requestHash', 'day', 'decisionKey', 'purpose', 'activities']);
  const expected = makeActivityBatch({ scope, businessKey, day: batch.day, choices: { decisionKey: batch.decisionKey, purpose: batch.purpose, activities: batch.activities } });
  if (canonical(batch) !== canonical(expected)) fail('The exact additional activity decision or policy changed.');
  const events = [], byLogicalKey = {};
  for (const [index, choice] of batch.activities.entries()) {
    const ruleKey = 'activity-' + batch.key.slice(0, 20) + '-' + String(index + 1).padStart(3, '0');
    const rows = new Map();
    const add = (stepKey, entity, parents, detail) => {
      const logicalKey = hash({ realmId: scope.realmId, environment: scope.environment, businessKey, ruleKey, occurrence: batch.day, stepKey });
      const event = { logicalKey, ruleKey, occurrence: batch.day, stepKey, entity, txnDate: batch.day, dependsOn: parents.map(key => rows.get(key).logicalKey), intent: { purpose: choice.purpose } };
      event.fingerprint = hash({ version: 1, batchKey: batch.key, requestHash: batch.requestHash, ruleKey, stepKey, entity, txnDate: batch.day });
      const details = { version: 1, currency: 'CAD', policyStatus: 'proposed', references: parents.map(key => ({ logicalKey: rows.get(key).logicalKey, entity: rows.get(key).entity })), baseAmountCents: null, taxStatus: 'not_applicable', lines: [], activityBatch: { key: batch.key, index, stepKey, purpose: choice.purpose }, ...detail };
      rows.set(stepKey, event); events.push(event); byLogicalKey[logicalKey] = { logicalKey, details, detailsHash: hash({ calendarFingerprint: event.fingerprint, details }) };
    };
    if (choice.type === 'settled-service-sale') {
      const field = choice.itemKey === 'field-service-hour', customerKey = choice.customerKey, itemKey = choice.itemKey;
      const line = { key: 'primary', itemKey, quantity: choice.quantity, unit: field ? 'hours' : 'month', unitPriceCents: choice.unitPriceCents, amountCents: choice.quantity * choice.unitPriceCents, accountMapping: field ? 'serviceIncome' : 'careIncome' };
      const sale = { customerKey, lines: [line], baseAmountCents: line.amountCents, taxMapping: 'salesTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' };
      if (field) { add('estimate', 'Estimate', [], sale); add('time', 'TimeActivity', ['estimate'], { customerKey, itemKey, hours: choice.quantity, billable: true, workerKey: 'field-technician', amountRule: 'time_only' }); }
      add('invoice', 'Invoice', field ? ['estimate', 'time'] : [], { ...sale, dueDate: batch.day });
      add('payment', 'Payment', ['invoice'], { customerKey, bankMapping: null, cashDirection: 'inflow', destination: 'undeposited_funds', amountRule: 'saved_originating_total', amountSourceKey: rows.get('invoice').logicalKey, taxStatus: 'included_in_originating_total' });
      add('deposit', 'Deposit', ['payment'], { customerKey, destination: 'operating_bank', bankMapping: 'operatingBank', cashDirection: 'internal_transfer', amountRule: 'saved_originating_total', amountSourceKey: rows.get('payment').logicalKey, taxStatus: 'included_in_originating_total' });
    } else {
      add('bill', 'Bill', [], { vendorKey: choice.vendorKey, expenseCategory: choice.category, dueDate: batch.day, lines: [{ key: 'primary', accountMapping: 'operatingExpense', amountCents: choice.amountCents, billableStatus: 'NotBillable' }], baseAmountCents: choice.amountCents, taxMapping: 'purchaseTax', taxStatus: 'unresolved', amountRule: 'lines_before_tax' });
      add('bill-payment', 'BillPayment', ['bill'], { vendorKey: choice.vendorKey, bankMapping: 'operatingBank', cashDirection: 'outflow', fundingSource: 'operating_bank', amountRule: 'saved_originating_total', amountSourceKey: rows.get('bill').logicalKey, taxStatus: 'included_in_originating_total' });
    }
  }
  return { businessKey, planHash: hash(batch), events, prerequisites: [], future: [], detailProposal: { byLogicalKey, fingerprint: hash(byLogicalKey) } };
}
function validateActivityBatch(batch, candidate) {
  if (!HASH.test(batch?.key || '') || candidate.expectedCursor === null || candidate.fromDate !== batch.day || candidate.throughDate !== batch.day || shift(candidate.expectedCursor, 1) !== batch.day) fail('Additional activity requires the next open business day after verified history.');
  const activity = buildBatchActivity(batch, candidate.scope, candidate.businessKey), proposed = candidate.entries || candidate.steps?.map(step => ({ kind: 'create', step }));
  if (!Array.isArray(proposed) || proposed.length !== activity.events.length || proposed.some(entry => entry.kind !== 'create')) fail('Additional activity must contain its exact self-contained new records.');
  const expectedKeys = new Set(activity.events.map(event => event.logicalKey));
  for (const entry of proposed) {
    const event = activity.events.find(row => row.logicalKey === entry.step?.logicalKey), detail = event && activity.detailProposal.byLogicalKey[event.logicalKey].details;
    // Dated tax is independently added from the published authority by preparation.
    const { datedTax, ...actual } = entry.step?.details || {};
    if (!event || entry.step.entity !== event.entity || entry.step.txnDate !== batch.day || entry.step.calendarFingerprint !== event.fingerprint || canonical(actual) !== canonical(detail) || canonical((entry.step.dependencies || []).map(row => row.logicalKey).sort()) !== canonical([...event.dependsOn].sort())) fail('Additional activity differs from the retained business choices.');
    if (entry.step.references?.some(ref => ref.entity === 'Item' && !['field-service-hour', 'care-plan-1', 'care-plan-2', 'care-plan-3'].includes(ref.key))) fail('Additional activity cannot introduce inventory movement.');
    expectedKeys.delete(event.logicalKey);
  }
  if (expectedKeys.size) fail('Additional activity contains duplicate or missing records.');
  return batch;
}
function batchLifecycle(step) {
  const value = step?.details?.activityBatch, d = step?.details;
  exact(value, ['key', 'index', 'stepKey', 'purpose']);
  if (!HASH.test(value.key || '') || !Number.isInteger(value.index) || value.index < 0 || value.index >= POLICY.maxActivities || !['estimate', 'time', 'invoice', 'payment', 'deposit', 'bill', 'bill-payment'].includes(value.stepKey)) fail('The additional activity lifecycle is incomplete.');
  text(value.purpose, 10, 500); date(step.txnDate);
  const entity = { estimate: 'Estimate', time: 'TimeActivity', invoice: 'Invoice', payment: 'Payment', deposit: 'Deposit', bill: 'Bill', 'bill-payment': 'BillPayment' }[value.stepKey];
  if (step.entity !== entity) fail('The additional activity step changed its transaction type.');
  if (d.activityTemplateVersion !== undefined || d.origin !== undefined || d.settlement !== undefined || d.stockQuantityRule !== undefined || d.creditAdjustment !== undefined || d.creditSettlement !== undefined) fail('An additional activity cannot borrow a monthly, stock or credit lifecycle.');
  const contract = { version: 4, activityBatch: structuredClone(value), mode: 'standard' };
  if (['Invoice', 'Bill'].includes(step.entity)) { if (d.dueDate !== step.txnDate) fail('These settled activities require immediate terms.'); contract.dueDate = d.dueDate; }
  else if (d.dueDate !== undefined) fail('Only an invoice or bill may carry payment terms.');
  if (step.entity === 'Bill') { const line = d.lines?.[0]; if (d.lines.length !== 1 || line.itemKey !== undefined || line.accountMapping !== 'operatingExpense' || line.billableStatus !== 'NotBillable' || line.amountCents !== d.baseAmountCents) fail('The additional bill must remain a non-stock operating expense.'); contract.mode = 'operating-expense'; contract.expense = { category: d.expenseCategory, accountMapping: 'operatingExpense', amountCents: line.amountCents, billableStatus: 'NotBillable' }; }
  return contract;
}
function assertBatchPreparation(active, batch, now) {
  if (active.calendar.verifiedThrough === null || batch.day !== businessDate(new Date(now)) || shift(active.calendar.verifiedThrough, 1) !== batch.day) fail('Verify business history through yesterday before preparing today’s additional activity. Keep today open for further hourly work.');
}
module.exports = { POLICY, POLICY_HASH, validateChoices, makeActivityBatch, buildBatchActivity, validateActivityBatch, batchLifecycle, assertBatchPreparation };
