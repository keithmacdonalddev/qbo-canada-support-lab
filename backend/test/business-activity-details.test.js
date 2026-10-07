'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewBusinessActivity } = require('../src/modules/business-activity-preview');
const { describeBusinessActivity, economicsFor } = require('../src/modules/business-activity-details');
const { proposalView } = require('../src/modules/blueprint-draft');
const view = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24), draft: null, proposal: proposalView() };
const request = { connectionId: view.connectionId, baseHash: null, fromDate: '2026-09-01', throughDate: '2026-09-30' };
const rawPreview = overrides => previewBusinessActivity(view, { ...request, ...overrides }, '2026-10-06');
const preview = overrides => { const result = rawPreview(overrides); for (const name of ['events', 'future', 'prerequisites']) result[name] = result[name].map(event => ({ ...event, ...result.detailProposal.byLogicalKey[event.logicalKey] })); return result; };
test('each lifecycle retains exact party, product, quantity and amount relationships', () => {
  const result = preview(), all = [...result.events, ...result.future, ...result.prerequisites];
  const groups = new Map();
  for (const event of all) { const key = event.ruleKey + event.occurrence; const list = groups.get(key) || []; list.push(event); groups.set(key, list); }
  let field = 0, stock = 0;
  for (const group of groups.values()) {
    const find = entity => group.find(event => event.entity === entity)?.details;
    if (find('Estimate') && find('Invoice')) {
      field++; assert.deepEqual(find('Estimate').lines, find('Invoice').lines);
      assert.equal(find('TimeActivity').hours, find('Invoice').lines[0].quantity);
      assert.equal(find('Estimate').customerKey, find('Invoice').customerKey);
    }
    if (find('PurchaseOrder') && find('Bill') && find('SalesReceipt')) {
      stock++; assert.deepEqual(find('PurchaseOrder').lines, find('Bill').lines);
      assert.equal(find('Bill').lines[0].quantity, find('SalesReceipt').lines[0].quantity);
      assert.equal(find('Bill').lines[0].itemKey, find('SalesReceipt').lines[0].itemKey);
      assert.equal(find('SalesReceipt').baseAmountCents, find('Bill').baseAmountCents * 2);
    }
  }
  assert.ok(field > 0 && stock > 0);
});
test('payments and deposits refer to exactly the originating saved total and never invent tax', () => {
  const result = preview(), all = [...result.events, ...result.future, ...result.prerequisites];
  const byKey = new Map(all.map(event => [event.logicalKey, event]));
  for (const event of all.filter(event => ['Payment', 'BillPayment', 'Deposit'].includes(event.entity))) {
    assert.equal(event.details.baseAmountCents, null); assert.equal(event.details.amountRule, 'saved_originating_total');
    assert.equal(byKey.get(event.details.amountSourceKey).entity, { Payment: 'Invoice', BillPayment: 'Bill', Deposit: 'Payment' }[event.entity]);
    assert.equal(event.details.taxStatus, 'included_in_originating_total');
  }
  for (const event of all.filter(event => event.details.lines.length)) {
    assert.equal(event.details.taxStatus, 'unresolved'); assert.equal(event.details.taxRate, undefined);
    assert.ok(Number.isSafeInteger(event.details.baseAmountCents));
  }
});
test('field payments wait for deposit while care payments select the operating bank once', () => {
  const result = preview();
  const field = result.events.find(event => event.entity === 'Payment' && event.ruleKey.startsWith('field-job'));
  const care = result.events.find(event => event.entity === 'Payment' && event.ruleKey.startsWith('care-subscription'));
  assert.equal(field.details.destination, 'undeposited_funds'); assert.equal(field.details.bankMapping, null);
  assert.equal(care.details.destination, 'operating_bank'); assert.equal(care.details.bankMapping, 'operatingBank');
  const supplierPayment = result.events.find(event => event.entity === 'BillPayment');
  assert.equal(supplierPayment.details.cashDirection, 'outflow'); assert.equal(supplierPayment.details.fundingSource, 'operating_bank'); assert.equal(supplierPayment.details.destination, undefined);
});
test('adjacent preview windows preserve transaction details and fingerprints', () => {
  const all = preview(), first = preview({ throughDate: '2026-09-15' }), second = preview({ fromDate: '2026-09-16' });
  const identity = events => events.map(event => [event.logicalKey, event.detailsHash]).sort();
  assert.deepEqual(identity(all.events), identity([...first.events, ...second.events]));
  assert.deepEqual(all, preview());
});
test('amount totals are grouped by entity to avoid counting a quote, invoice and payment as revenue', () => {
  const result = preview();
  assert.equal(result.detailProposal.totalRevenue, undefined);
  for (const [entity, totals] of Object.entries(result.detailProposal.byEntity)) {
    const events = result.events.filter(event => event.entity === entity);
    assert.equal(totals.count, events.length);
    assert.equal(totals.beforeTaxCents, events.reduce((sum, event) => sum + (event.details.baseAmountCents || 0), 0));
  }
  assert.equal(result.detailProposal.status, 'proposed'); assert.equal(result.executable, false);
});
test('incomplete or mixed-origin detail dependencies and duplicate identities reject the whole preview', () => {
  const result = rawPreview();
  for (const mutate of [
    plan => { plan.events.push(plan.events[0]); },
    plan => { plan.events.find(event => event.entity === 'Payment').dependsOn = ['missing']; },
    plan => { const payment = plan.events.find(event => event.entity === 'Payment'); payment.dependsOn = [plan.events.find(event => event.ruleKey !== payment.ruleKey).logicalKey]; },
  ]) { const copy = structuredClone(result); mutate(copy); assert.throws(() => describeBusinessActivity(copy), error => error.status === 400); }
  for (const key of ['field-job-000', 'random-001', 'field-job-x']) assert.throws(() => economicsFor(key));
});

test('detail proposals preserve the calendar hash contract used by reconciliation and revision comparison', () => {
  const { compareCalendarPlans } = require('../src/modules/business-calendar');
  const result = rawPreview();
  const comparison = compareCalendarPlans(result, rawPreview());
  assert.equal(comparison.requiresReview, false);
  assert.ok(result.events.every(event => !Object.hasOwn(event, 'details')));
  assert.equal(Object.keys(result.detailProposal.byLogicalKey).length, result.events.length + result.future.length + result.prerequisites.length);
});
