'use strict';
const { canonical, date, shift } = require('./business-calendar');
const HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_LIFECYCLE_UNVERIFIED' }); }
function exact(value, keys) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
// The saved detail envelope stays version1. These additive, explicit contracts
// define version2 meaning and are independently retained in its approved policy.
function lifecyclePolicy(step) {
  const d = step?.details;
  if (d?.activityBatch !== undefined) return require('./business-activity-batch').batchLifecycle(step);
  if (d?.activityTemplateVersion === undefined) {
    if (d && ['origin', 'settlement', 'stockQuantityRule', 'expenseCategory', 'dueDate', 'creditAdjustment', 'creditSettlement'].some(key => d[key] !== undefined)) fail('Lifecycle terms require the explicit version2 business schedule.');
    return null;
  }
  if (![2, 3].includes(d.activityTemplateVersion) || !exact(d.origin, ['openingDate', 'occurrence', 'ruleKey', 'stepKey'])) fail('The saved business lifecycle version is unsupported.');
  const o = d.origin;
  date(o.openingDate); date(o.occurrence); date(step.txnDate);
  const match = /^(field-job|supply-order|care-subscription|operating-overhead)-(\d{3})$/.exec(o.ruleKey || '');
  if (!match || !o.openingDate.endsWith('-01') || o.occurrence < o.openingDate) fail('The original lifecycle occurrence is unavailable.');
  const cohort = match[1], index = Number(match[2]) - 1, limits = { 'field-job': 30, 'supply-order': 15, 'care-subscription': 25, 'operating-overhead': 3 };
  if (index < 0 || index >= limits[cohort] || Number(o.occurrence.slice(8)) !== 1 + index * 5 % 28) fail('The original lifecycle cohort or date changed.');
  const selected = index % 5 === 0, creditCohort = d.activityTemplateVersion === 3 && cohort === 'care-subscription' && index % 5 === 1;
  const schedules = {
    'field-job': { estimate: ['Estimate', 0], time: ['TimeActivity', 2], invoice: ['Invoice', 7], payment: ['Payment', 21], deposit: ['Deposit', 22], ...(selected ? { 'final-payment': ['Payment', 45], 'final-deposit': ['Deposit', 46] } : {}) },
    'supply-order': { 'purchase-order': ['PurchaseOrder', 0], bill: ['Bill', 3], sale: ['SalesReceipt', 5], 'bill-payment': ['BillPayment', selected ? 45 : 18] },
    'care-subscription': { invoice: ['Invoice', 0], ...(creditCohort ? { credit: ['CreditMemo', 10], 'credit-application': ['Payment', 11] } : {}), payment: ['Payment', selected ? 45 : 14] },
    'operating-overhead': { bill: ['Bill', 0], 'bill-payment': ['BillPayment', 20] },
  };
  const scheduled = schedules[cohort][o.stepKey];
  if (!scheduled || scheduled[0] !== step.entity || shift(o.occurrence, scheduled[1]) !== step.txnDate) fail('The saved lifecycle type or posting date changed.');
  const contract = { version: d.activityTemplateVersion, origin: { ...o }, mode: 'standard' };
  if (['Invoice', 'Bill'].includes(step.entity)) {
    if (d.dueDate !== shift(step.txnDate, 30)) fail('The approved thirty-day terms changed.');
    contract.dueDate = d.dueDate;
  } else if (d.dueDate !== undefined) fail('This activity cannot introduce payment terms.');
  const stage = cohort === 'field-job' && selected && step.entity === 'Payment' ? o.stepKey === 'payment' ? 'first' : 'remainder' : null;
  if (stage) {
    const keys = stage === 'first' ? ['stage', 'basisPoints'] : ['stage', 'basisPoints', 'priorPaymentKey'];
    const source = step.dependencies?.filter(row => row.entity === 'Invoice');
    if (!exact(d.settlement, keys) || d.settlement.stage !== stage || d.settlement.basisPoints !== 6000 || d.amountRule !== (stage === 'first' ? 'saved_originating_installment' : 'saved_originating_remainder') || source?.length !== 1 || source[0].logicalKey !== d.amountSourceKey) fail('The exact sixty-percent installment policy is unavailable.');
    if (stage === 'remainder') {
      const prior = step.dependencies?.filter(row => row.entity === 'Payment');
      if (!HASH.test(d.settlement.priorPaymentKey || '') || prior?.length !== 1 || prior[0].logicalKey !== d.settlement.priorPaymentKey) fail('The exact prior managed payment is required.');
    }
    contract.mode = 'installment'; contract.settlement = { ...d.settlement }; contract.amountSourceKey = d.amountSourceKey;
  } else if (d.settlement !== undefined || ['saved_originating_installment', 'saved_originating_remainder'].includes(d.amountRule)) fail('This activity has no installment authority.');
  if (creditCohort && step.entity === 'CreditMemo') {
    const source = step.dependencies?.filter(row => row.entity === 'Invoice'), amountCents = (14900 + index % 3 * 5000) / 10, line = d.lines?.[0];
    if (!exact(d.creditAdjustment, ['basisPoints', 'invoiceKey']) || d.creditAdjustment.basisPoints !== 1000 || source?.length !== 1 || source[0].logicalKey !== d.creditAdjustment.invoiceKey || d.lines?.length !== 1 || line.key !== 'primary' || line.itemKey !== 'care-plan-' + (1 + index % 3) || line.quantity !== 1 || line.unitPriceCents !== amountCents || line.amountCents !== amountCents || line.accountMapping !== 'careIncome' || d.baseAmountCents !== amountCents || d.taxMapping !== 'salesTax' || d.customerKey !== 'care-client-' + match[2] || d.amountRule !== 'lines_before_tax') fail('The exact care-service credit adjustment changed.');
    contract.mode = 'credit-adjustment'; contract.credit = { ...d.creditAdjustment };
  } else if (d.creditAdjustment !== undefined) fail('This activity has no service-credit authority.');
  if (creditCohort && step.entity === 'Payment') {
    const application = o.stepKey === 'credit-application', stage = application ? 'application' : 'remainder', terms = d.creditSettlement, credit = step.dependencies?.filter(row => row.entity === 'CreditMemo'), prior = step.dependencies?.filter(row => row.entity === 'Payment'), invoice = step.dependencies?.filter(row => row.entity === 'Invoice');
    if (!exact(terms, application ? ['stage', 'creditMemoKey'] : ['stage', 'creditMemoKey', 'applicationKey']) || terms.stage !== stage || credit?.length !== 1 || terms.creditMemoKey !== credit[0].logicalKey || invoice?.length !== 1 || d.amountSourceKey !== invoice[0].logicalKey || d.amountRule !== (application ? 'saved_credit_application' : 'saved_credit_remainder') || (!application && (prior?.length !== 1 || prior[0].logicalKey !== terms.applicationKey)) || d.lines?.length !== 0 || d.destination !== 'operating_bank' || d.bankMapping !== 'operatingBank' || d.cashDirection !== (application ? 'none' : 'inflow')) fail('The exact managed credit application or remaining collection changed.');
    contract.mode = application ? 'credit-application' : 'credit-remainder'; contract.credit = { ...terms, invoiceKey: invoice[0].logicalKey };
  } else if (d.creditSettlement !== undefined || ['saved_credit_application', 'saved_credit_remainder'].includes(d.amountRule)) fail('This activity has no managed credit-settlement authority.');
  if (cohort === 'supply-order' && ['PurchaseOrder', 'Bill', 'SalesReceipt'].includes(step.entity)) {
    const soldQuantity = 12 + index % 4 * 6, retainedQuantity = o.occurrence.slice(0, 7) === o.openingDate.slice(0, 7) ? 6 : 0, purchasedQuantity = soldQuantity + retainedQuantity;
    if (!exact(d.stockQuantityRule, ['purchasedQuantity', 'retainedQuantity']) || d.stockQuantityRule.purchasedQuantity !== purchasedQuantity || d.stockQuantityRule.retainedQuantity !== retainedQuantity || d.lines?.length !== 1 || d.lines[0].quantity !== (step.entity === 'SalesReceipt' ? soldQuantity : purchasedQuantity)) fail('The original opening-stock buffer or planned quantities changed.');
    contract.stock = { purchasedQuantity, soldQuantity, retainedQuantity };
  } else if (d.stockQuantityRule !== undefined) fail('This activity has no stock-buffer authority.');
  if (cohort === 'operating-overhead' && step.entity === 'Bill') {
    const category = ['premises', 'utilities', 'software'][index], amountCents = [95000, 18000, 9500][index], line = d.lines?.[0];
    if (d.expenseCategory !== category || d.vendorKey !== 'overhead-supplier-' + (index + 1) || d.customerKey !== undefined || d.itemKey !== undefined || d.lines?.length !== 1 || !exact(line, ['key', 'accountMapping', 'amountCents', 'billableStatus']) || line.key !== 'primary' || line.accountMapping !== 'operatingExpense' || line.amountCents !== amountCents || line.billableStatus !== 'NotBillable' || d.baseAmountCents !== amountCents || d.taxMapping !== 'purchaseTax' || d.amountRule !== 'lines_before_tax') fail('The exact nonbillable operating expense changed.');
    contract.mode = 'operating-expense'; contract.expense = { category, accountMapping: 'operatingExpense', amountCents, billableStatus: 'NotBillable' };
  } else if (d.expenseCategory !== undefined) fail('This activity has no operating-expense authority.');
  return contract;
}
function validateLifecyclePolicy(step, policy) {
  const expected = lifecyclePolicy(step);
  if (expected ? canonical(policy?.lifecycle || null) !== canonical(expected) : policy?.lifecycle !== undefined) fail('The approved lifecycle terms differ from the original saved activity.');
  return expected;
}
function installmentCents(total) {
  if (!Number.isSafeInteger(total) || total <= 0 || total > 1000000000000) fail('The original accepted gross amount is invalid.');
  return Number((BigInt(total) * 6000n + 5000n) / 10000n);
}
module.exports = { lifecyclePolicy, validateLifecyclePolicy, installmentCents };
