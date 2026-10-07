'use strict';
const { hash, canonical } = require('./business-calendar');
const { problem } = require('./blueprint-draft');
const DETAIL_VERSION = 1;
// Proposed fixture economics, never approved amounts or QBO write payloads.
function economicsFor(ruleKey) {
  const match = /^(field-job|supply-order|care-subscription)-(\d{3})$/.exec(ruleKey);
  if (!match || Number(match[2]) < 1) throw problem('The activity has no supported transaction-detail template.');
  const index = Number(match[2]) - 1, cohort = match[1];
  if (cohort === 'field-job') return { cohort, customerKey: 'field-client-' + String(1 + Math.floor(index / 2)).padStart(3, '0'), itemKey: 'field-service-hour', quantity: 2 + index % 6, unit: 'hours', unitPriceCents: 12500, incomeMapping: 'serviceIncome' };
  if (cohort === 'care-subscription') return { cohort, customerKey: 'care-client-' + match[2], itemKey: 'care-plan-' + (1 + index % 3), quantity: 1, unit: 'month', unitPriceCents: 14900 + index % 3 * 5000, incomeMapping: 'careIncome' };
  const product = 1 + index % 5, cost = 1800 + product * 250;
  return { cohort, customerKey: 'wholesale-client-' + String(1 + Math.floor(index / 2)).padStart(3, '0'), vendorKey: 'stock-supplier-' + (1 + index % 3), itemKey: 'workshop-stock-' + product, quantity: 12 + index % 4 * 6, unit: 'units', unitCostCents: cost, unitPriceCents: cost * 2, incomeMapping: 'supplyIncome' };
}
function activityDetails(event, events) {
  const economics = economicsFor(event.ruleKey);
  const parents = event.dependsOn.map(key => events.get(key));
  if (parents.some(parent => !parent || parent.ruleKey !== event.ruleKey || parent.occurrence !== event.occurrence || parent.txnDate > event.txnDate)) throw problem('Transaction details require the complete originating activity.');
  const customerKey = economics.customerKey, vendorKey = economics.vendorKey;
  const references = parents.map(parent => ({ logicalKey: parent.logicalKey, entity: parent.entity }));
  const common = { version: DETAIL_VERSION, currency: 'CAD', policyStatus: 'proposed', references, baseAmountCents: null, taxStatus: 'not_applicable', lines: [] };
  const parent = entity => {
    const matches = parents.filter(value => value.entity === entity);
    if (matches.length !== 1) throw problem('Transaction details require one originating ' + entity + '.');
    return matches[0];
  };
  const line = (rate, mapping) => ({ key: 'primary', itemKey: economics.itemKey, quantity: economics.quantity, unit: economics.unit, unitPriceCents: rate, amountCents: economics.quantity * rate, accountMapping: mapping });
  if (event.entity === 'TimeActivity' && economics.cohort === 'field-job') {
    parent('Estimate');
    return { ...common, customerKey, itemKey: economics.itemKey, hours: economics.quantity, billable: true, workerKey: 'field-technician', amountRule: 'time_only' };
  }
  if (['Payment', 'BillPayment', 'Deposit'].includes(event.entity)) {
    const source = parent({ Payment: 'Invoice', BillPayment: 'Bill', Deposit: 'Payment' }[event.entity]);
    return { ...common, ...(event.entity === 'BillPayment' ? { vendorKey } : { customerKey }),
      bankMapping: event.entity === 'Payment' && economics.cohort === 'field-job' ? null : 'operatingBank',
      cashDirection: event.entity === 'BillPayment' ? 'outflow' : event.entity === 'Deposit' ? 'internal_transfer' : 'inflow',
      ...(event.entity === 'BillPayment' ? { fundingSource: 'operating_bank' } : { destination: event.entity === 'Payment' && economics.cohort === 'field-job' ? 'undeposited_funds' : 'operating_bank' }),
      amountRule: 'saved_originating_total', amountSourceKey: source.logicalKey,
      taxStatus: 'included_in_originating_total' };
  }
  let detail;
  if (['Estimate', 'Invoice', 'SalesReceipt'].includes(event.entity)) {
    if (economics.cohort === 'supply-order' && event.entity !== 'SalesReceipt') throw problem('Unsupported stock sales step.');
    if (economics.cohort !== 'supply-order' && event.entity === 'SalesReceipt') throw problem('Unsupported service sales step.');
    if (event.entity === 'SalesReceipt') parent('Bill');
    if (event.entity === 'Invoice' && economics.cohort === 'field-job') { parent('Estimate'); parent('TimeActivity'); }
    detail = { ...common, customerKey, lines: [line(economics.unitPriceCents, economics.incomeMapping)], taxMapping: 'salesTax', ...(event.entity === 'SalesReceipt' ? { bankMapping: 'operatingBank' } : {}) };
  } else if (['PurchaseOrder', 'Bill'].includes(event.entity) && economics.cohort === 'supply-order') {
    if (event.entity === 'Bill') parent('PurchaseOrder');
    detail = { ...common, vendorKey, lines: [line(economics.unitCostCents, 'inventoryAsset')], taxMapping: 'purchaseTax' };
  } else throw problem('The activity type has no supported transaction details.');
  detail.baseAmountCents = detail.lines.reduce((sum, item) => sum + item.amountCents, 0);
  detail.taxStatus = 'unresolved'; detail.amountRule = 'lines_before_tax';
  return detail;
}
function describeBusinessActivity(plan) {
  const all = [...plan.events, ...plan.future, ...plan.prerequisites];
  const events = new Map(all.map(event => [event.logicalKey, event]));
  if (events.size !== all.length) throw problem('Transaction details cannot contain duplicate activity identities.');
  const enrich = event => {
    const details = activityDetails(event, events);
    return { logicalKey: event.logicalKey, details, detailsHash: hash({ calendarFingerprint: event.fingerprint, details }) };
  };
  const byLogicalKey = Object.fromEntries(all.map(event => [event.logicalKey, enrich(event)]));
  if (Buffer.byteLength(canonical({ plan, byLogicalKey })) > 8000000) throw problem('Transaction details exceed the preview size budget. Shorten the period.');
  const byEntity = {};
  for (const event of plan.events) {
    const { details } = byLogicalKey[event.logicalKey];
    const total = byEntity[event.entity] ||= { count: 0, beforeTaxCents: 0, unresolvedTotals: 0 };
    total.count++;
    if (details.baseAmountCents === null) total.unresolvedTotals++;
    else total.beforeTaxCents += details.baseAmountCents;
  }
  return { detailProposal: { version: DETAIL_VERSION, status: 'proposed', currency: 'CAD', byEntity,
    byLogicalKey, fingerprint: hash({ planHash: plan.planHash, byLogicalKey }),
    assumptions: [
      'Illustrative fixture prices and quantities are proposals, not approved business policy or market quotes.',
      'Field jobs use 2–7 hours at CAD 125/hour. Care plans use CAD 149, 199 or 249 per month.',
      'Workshop orders buy and sell the same 12–30 units per batch, with proposed unit costs CAD 20.50–30.50 and prices twice cost.',
      'Payments and deposits must use the originating saved total including its actual tax; no tax rate or final cash amount is assumed.',
      'Customer, supplier, worker and product keys are intended identities, not existing QuickBooks record IDs.',
      'Amounts are shown by record type. Adding quotes, orders, invoices and payments together would double-count the business activity.',
    ] } };
}
module.exports = { economicsFor, activityDetails, describeBusinessActivity, DETAIL_VERSION };
