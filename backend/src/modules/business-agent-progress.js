'use strict';
// Live progress for one business review: a short plain-English step per governed
// tool call, so the owner can see what the accountant is doing right now.
// Only a fixed label, a status and a time are kept. Tool inputs, outputs, record
// contents, prompts and error text are never stored; labels use allowlisted
// words chosen from enum-validated input fields or counts, nothing free-form.
const MAX_STEPS = 20, MAX_LABEL = 100;
const STATUSES = new Set(['running', 'done', 'failed']);
const ENTITIES = Object.freeze({
  Customer: ['customer', 'customers'], Vendor: ['supplier', 'suppliers'], Employee: ['employee', 'employees'],
  Item: ['product or service', 'products and services'], Account: ['account', 'accounts'], Class: ['class', 'classes'],
  Department: ['location', 'locations'], Term: ['payment term', 'payment terms'], Invoice: ['invoice', 'invoices'],
  Payment: ['customer payment', 'customer payments'], CreditMemo: ['credit memo', 'credit memos'],
  SalesReceipt: ['sales receipt', 'sales receipts'], RefundReceipt: ['refund', 'refunds'], Estimate: ['estimate', 'estimates'],
  Bill: ['bill', 'bills'], BillPayment: ['bill payment', 'bill payments'], VendorCredit: ['supplier credit', 'supplier credits'],
  Purchase: ['expense', 'expenses'], PurchaseOrder: ['purchase order', 'purchase orders'], Deposit: ['deposit', 'deposits'],
  Transfer: ['transfer', 'transfers'], JournalEntry: ['journal entry', 'journal entries'], TimeActivity: ['time entry', 'time entries'],
  TaxCode: ['tax code', 'tax codes'], TaxRate: ['tax rate', 'tax rates'], PaymentMethod: ['payment method', 'payment methods'],
  Preferences: ['company setting', 'company settings'], CompanyInfo: ['company profile', 'company profile'],
});
const REPORTS = Object.freeze({
  BalanceSheet: 'Balance Sheet', ProfitAndLoss: 'Profit and Loss', ProfitAndLossDetail: 'Profit and Loss Detail', TrialBalance: 'Trial Balance',
  GeneralLedger: 'General Ledger', CashFlow: 'Statement of Cash Flows', AgedReceivables: 'A/R Aging Summary', AgedReceivableDetail: 'A/R Aging Detail',
  AgedPayables: 'A/P Aging Summary', AgedPayableDetail: 'A/P Aging Detail', CustomerBalance: 'Customer Balance Summary',
  CustomerBalanceDetail: 'Customer Balance Detail', CustomerSales: 'Sales by Customer', CustomerIncome: 'Income by Customer',
  VendorBalance: 'Supplier Balance Summary', VendorBalanceDetail: 'Supplier Balance Detail', VendorExpenses: 'Expenses by Supplier',
  ItemSales: 'Sales by Product/Service', ClassSales: 'Sales by Class', DepartmentSales: 'Sales by Location', AccountList: 'Account List',
  InventoryValuationSummary: 'Inventory Valuation Summary', InventoryValuationDetail: 'Inventory Valuation Detail',
  TransactionList: 'Transaction List', JournalReport: 'Journal',
});
const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);
const plural = (count, one, many) => count + ' ' + (count === 1 ? one : many);
const FIXED = Object.freeze({
  lookupCustomer: 'Looking up a customer',
  lookupInvoice: 'Looking up an invoice',
  getTransactionChain: 'Tracing linked transactions',
  getBusinessDecision: 'Reading a retained decision',
  getBusinessState: 'Checking the business state',
  getBusinessWork: 'Reading its work list',
  inspectBusinessOperation: 'Checking a saved accounting plan',
  getBusinessActivityChoices: 'Reviewing customers, suppliers and open items it can use',
  prepareBusinessPeriod: 'Preparing the dated business calendar',
  executeBusinessPeriod: 'Sending an approved plan to QuickBooks',
  resumeBusinessOperation: 'Resuming interrupted work in QuickBooks',
  rememberBusinessContext: 'Saving notes for its next review',
  linkReproductionCase: 'Linking a troubleshooting case',
});
// One table maps every governed tool to a short label; unknown tools get a humanised name.
function stepLabel(name, input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let label;
  if (has(FIXED, name)) label = FIXED[name];
  else if (name === 'searchEntities') label = 'Searching ' + (has(ENTITIES, value.type) ? ENTITIES[value.type][1] : 'company records');
  else if (name === 'getEntityDetail') label = 'Reading ' + (has(ENTITIES, value.entityType) ? 'a saved ' + ENTITIES[value.entityType][0] : 'a saved record');
  else if (name === 'runReport') label = has(REPORTS, value.report) ? 'Running the ' + REPORTS[value.report] + ' report' : 'Running a report';
  else if (name === 'getObligations') label = value.area === 'payables' ? 'Reading ' + (value.overdueOnly === true ? 'overdue' : 'unpaid') + ' supplier bills' : value.area === 'receivables' ? 'Reading ' + (value.overdueOnly === true ? 'overdue' : 'unpaid') + ' customer invoices' : 'Reading what is owed';
  else if (name === 'prepareBusinessActivity') {
    const count = Array.isArray(value.activities) && value.activities.length >= 1 && value.activities.length <= 12 ? value.activities.length : 0;
    label = count ? 'Preparing ' + plural(count, 'piece', 'pieces') + ' of same-day activity' : 'Preparing same-day activity';
  } else if (name === 'recordBusinessDecision') label = value.requiresOwner === true ? 'Asking you for a decision' : 'Recording a business decision';
  else if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(name)) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase();
    label = 'Using ' + words;
  } else label = 'Using a business tool';
  return label.slice(0, MAX_LABEL);
}
// Steps are rendered as given; keep only the expected shape and bounds.
function cleanSteps(steps, max = MAX_STEPS) {
  return (Array.isArray(steps) ? steps : []).filter(step => step && typeof step.label === 'string').slice(-max).map(step => ({
    at: Number.isFinite(new Date(step.at).getTime()) ? new Date(step.at).toISOString() : null,
    label: step.label.slice(0, MAX_LABEL),
    status: STATUSES.has(step.status) ? step.status : 'done',
  }));
}
// Records steps without delaying tools: writes run in the background, coalesce to the
// latest list, and failures are only counted. flush() waits a bounded time at pass end.
function createReviewProgress({ write, now = () => Date.now(), max = MAX_STEPS, flushMs = 2000 } = {}) {
  let steps = [], dirty = false, inflight = null, failures = 0;
  async function pump() {
    while (dirty) {
      dirty = false;
      try { await write(cleanSteps(steps, max)); } catch { failures++; }
    }
  }
  const save = () => {
    if (typeof write !== 'function') return;
    dirty = true;
    if (!inflight) inflight = Promise.resolve().then(pump).finally(() => { inflight = null; if (dirty) save(); });
  };
  function begin(name, input) {
    const step = { at: new Date(now()).toISOString(), label: stepLabel(name, input), status: 'running' };
    steps = [...steps, step].slice(-max); save(); return step;
  }
  function finish(step, status) { if (!step) return; step.status = status; save(); }
  function wrap(execute) {
    return async (name, input) => {
      let step = null;
      try { step = begin(name, input); } catch { step = null; }
      try {
        const value = await execute(name, input);
        try { finish(step, value && value.success === false ? 'failed' : 'done'); } catch { /* progress is best-effort */ }
        return value;
      } catch (error) {
        try { finish(step, 'failed'); } catch { /* progress is best-effort */ }
        throw error;
      }
    };
  }
  // Wall-clock bound (not the injectable business clock) so a stuck write never holds the pass.
  async function flush() {
    const deadline = Date.now() + flushMs;
    while (inflight) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer;
      await Promise.race([inflight, new Promise(resolve => { timer = setTimeout(resolve, left); timer.unref?.(); })]);
      clearTimeout(timer);
    }
  }
  return { wrap, flush, steps: () => cleanSteps(steps, max), failures: () => failures };
}
module.exports = { createReviewProgress, stepLabel, cleanSteps, MAX_STEPS };
