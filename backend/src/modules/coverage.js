'use strict';

// Coverage: which parts of QuickBooks the connected company actually uses,
// measured from its records instead of claimed. Every feature area in the
// discovery catalog (docs/discovery/catalog.v1.json) gets a few concrete
// signals, such as "an invoice is overdue" or "a bill was paid in part".
//
//   in use   matching records exist, and recently for day-to-day activity
//   stale    matching records exist, but none recently
//   missing  no matching records in the last 12 months
//   manual   QuickBooks doesn't let apps read or create it; check by hand
//
// Each signal also says who can close the gap: the assistant (it can create
// that record type, through an approved plan) or a person in QuickBooks.
// Every check here is a read.

const path = require('path');
const fs = require('fs');
const { WRITABLE_ENTITY_TYPES } = require('./ai-tools');

const CATALOG_PATH = path.resolve(__dirname, '../../../docs/discovery/catalog.v1.json');

const LOOKBACK_DAYS = 365;
const DEFAULT_FRESH_DAYS = 45;
const MAX_RESULTS = 1000;
const READ_BUDGET_MS = 60 * 1000;
const MAX_CHECK_PAGES = 128;
const MAX_CHECK_RECORDS = 100000;
const MAX_PAGES = 50; // Explicit read budget; an exhausted budget is incomplete evidence.
const CACHE_MS = 10 * 60 * 1000;
// A forced re-read within this window returns the result just made, so
// repeated refreshes (by a person or the assistant) cost one check.
const MIN_REFRESH_MS = 60 * 1000;
const POOL_SIZE = 4;

// ---------------------------------------------------------------------------
// What gets read
// ---------------------------------------------------------------------------

const LIST_SOURCES = {
  customers: { entity: 'Customer', where: 'WHERE Active IN (true, false)' },
  vendors: { entity: 'Vendor', where: 'WHERE Active IN (true, false)' },
  items: { entity: 'Item', where: 'WHERE Active IN (true, false)' },
  accounts: { entity: 'Account', where: 'WHERE Active IN (true, false)' },
  classes: { entity: 'Class' },
  departments: { entity: 'Department' },
  terms: { entity: 'Term' },
  taxCodes: { entity: 'TaxCode' },
  employees: { entity: 'Employee' },
  budgets: { entity: 'Budget' },
  recurring: { entity: 'RecurringTransaction' },
  attachments: { entity: 'Attachable' },
  currencies: { entity: 'CompanyCurrency' },
  // Dated by PaymentDate, not TxnDate, so it is read as a list.
  taxPayments: { entity: 'TaxPayment' },
  preferences: { entity: 'Preferences', single: true },
};

const TXN_SOURCES = [
  'Invoice', 'Payment', 'CreditMemo', 'SalesReceipt', 'RefundReceipt', 'Estimate',
  'Bill', 'BillPayment', 'VendorCredit', 'Purchase', 'PurchaseOrder',
  'Deposit', 'Transfer', 'JournalEntry', 'TimeActivity', 'InventoryAdjustment',
];

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

const num = (v) => Number(v) || 0;
const lines = (r) => (Array.isArray(r?.Line) ? r.Line : []);

// A reference on the record itself or on any of its lines' detail blocks.
function refsOn(record, refName) {
  const found = [];
  if (record?.[refName]?.value) found.push(record[refName].value);
  for (const line of lines(record)) {
    for (const [key, detail] of Object.entries(line || {})) {
      if (key.endsWith('Detail') && detail && detail[refName]?.value) found.push(detail[refName].value);
    }
  }
  return found;
}

const hasRef = (refName) => (r) => refsOn(r, refName).length > 0;
const taxed = (r) => num(r?.TxnTaxDetail?.TotalTax) > 0;
const openBalance = (r) => num(r.Balance) > 0;
const partlyPaid = (r) => num(r.Balance) > 0 && num(r.Balance) < num(r.TotalAmt);
const overdue = (r, ctx) => num(r.Balance) > 0 && r.DueDate && r.DueDate < ctx.today;
const foreign = (r, ctx) => r?.CurrencyRef?.value && ctx.homeCurrency && r.CurrencyRef.value !== ctx.homeCurrency;
const linkedTo = (txnType) => (r) => lines(r).some((l) => (l.LinkedTxn || []).some((t) => t.TxnType === txnType))
  || (r.LinkedTxn || []).some((t) => t.TxnType === txnType);
const onProject = (r, ctx) => [r?.CustomerRef?.value, r?.ProjectRef?.value, ...refsOn(r, 'CustomerRef')]
  .some((id) => id && ctx.projectIds.has(id));

// ---------------------------------------------------------------------------
// Signals per catalog feature area
// ---------------------------------------------------------------------------
// kind: 'activity' needs dated records within freshDays; 'setup' needs the
// thing to exist; 'manual' cannot be read by an app.
// fill: 'assistant' when the assistant can create the record type,
// otherwise 'quickbooks' (a person does it in QuickBooks).

const activity = (key, label, source, match, extra = {}) => ({ key, label, source, match, kind: 'activity', ...extra });
const setup = (key, label, source, match, extra = {}) => ({ key, label, source, match, kind: 'setup', ...extra });
const manual = (key, label, how) => ({ key, label, kind: 'manual', how });
const pref = (key, label, read) => ({ key, label, source: 'preferences', kind: 'setup', fill: 'quickbooks', read });

const prefs = (ctx) => ctx.preferences || {};

// Prerequisites a person sets up in QuickBooks. Until they exist, the
// assistant can't fill the dependent gap, so it's marked for QuickBooks.
const NEEDS_PROJECTS = (ctx) => (ctx.projectIds.size ? null : 'Needs a project, which is set up in QuickBooks');
const NEEDS_CLASSES = (ctx) => (prefs(ctx).AccountingInfoPrefs?.ClassTrackingPerTxn || prefs(ctx).AccountingInfoPrefs?.ClassTrackingPerTxnLine
  ? null : 'Needs class tracking turned on in QuickBooks');
const NEEDS_LOCATIONS = (ctx) => (prefs(ctx).AccountingInfoPrefs?.TrackDepartments ? null : 'Needs location tracking turned on in QuickBooks');
const NEEDS_MULTICURRENCY = (ctx) => (prefs(ctx).CurrencyPrefs?.MultiCurrencyEnabled ? null : 'Needs multicurrency turned on in QuickBooks');

const AREA_SIGNALS = {
  'company.preferences': [
    pref('class-tracking', 'Class tracking turned on', (p) => p.AccountingInfoPrefs?.ClassTrackingPerTxn || p.AccountingInfoPrefs?.ClassTrackingPerTxnLine),
    pref('location-tracking', 'Location tracking turned on', (p) => p.AccountingInfoPrefs?.TrackDepartments),
    pref('inventory-tracking', 'Inventory quantity tracking turned on', (p) => p.ProductAndServicesPrefs?.QuantityOnHand),
    pref('custom-txn-numbers', 'Custom transaction numbers turned on', (p) => p.SalesFormsPrefs?.CustomTxnNumbers),
  ],
  'accounting.chart-of-accounts': [
    setup('cash-accounts', 'Bank and credit card accounts', 'accounts', (a) => ['Bank', 'Credit Card'].includes(a.AccountType), { min: 2 }),
    setup('asset-accounts', 'Current and fixed asset accounts', 'accounts', (a) => ['Other Current Asset', 'Fixed Asset'].includes(a.AccountType), { min: 2 }),
    setup('liability-accounts', 'Current and long-term liability accounts', 'accounts', (a) => ['Other Current Liability', 'Long Term Liability'].includes(a.AccountType), { min: 2 }),
    setup('cogs-accounts', 'Cost of goods sold accounts', 'accounts', (a) => a.AccountType === 'Cost of Goods Sold'),
    setup('sub-accounts', 'Sub-accounts', 'accounts', (a) => a.SubAccount === true),
    setup('inactive-account', 'An inactive account', 'accounts', (a) => a.Active === false),
  ],
  'sales.customers': [
    setup('active-customers', 'At least 10 active customers', 'customers', (c) => c.Active !== false && !c.IsProject, { min: 10 }),
    setup('sub-customers', 'Sub-customers', 'customers', (c) => Boolean(c.ParentRef?.value) && !c.IsProject),
    setup('customer-terms', 'Customers with payment terms', 'customers', (c) => Boolean(c.SalesTermRef?.value)),
    setup('customer-provinces', 'Customers in more than one province', 'customers', null, {
      count: (records) => new Set(records.map((c) => c.BillAddr?.CountrySubDivisionCode).filter(Boolean)).size, min: 2,
    }),
    setup('inactive-customer', 'An inactive customer', 'customers', (c) => c.Active === false),
    setup('customers-owing', 'Customers with an open balance', 'customers', (c) => num(c.Balance) > 0),
  ],
  'expenses.vendors': [
    setup('active-vendors', 'At least 5 active vendors', 'vendors', (v) => v.Active !== false, { min: 5 }),
    setup('vendor-terms', 'Vendors with payment terms', 'vendors', (v) => Boolean(v.TermRef?.value)),
    setup('vendors-owed', 'Vendors with an open balance', 'vendors', (v) => num(v.Balance) > 0),
    setup('inactive-vendor', 'An inactive vendor', 'vendors', (v) => v.Active === false),
  ],
  'inventory.items': [
    setup('service-items', 'Service items', 'items', (i) => i.Type === 'Service'),
    setup('inventory-items', 'Inventory items', 'items', (i) => i.Type === 'Inventory'),
    setup('non-inventory-items', 'Non-inventory items', 'items', (i) => i.Type === 'NonInventory'),
    setup('bundles', 'Bundles', 'items', (i) => i.Type === 'Group', { fill: 'quickbooks' }),
    setup('inactive-item', 'An inactive item', 'items', (i) => i.Active === false),
    activity('inventory-adjustments', 'Inventory quantity adjustments', 'InventoryAdjustment', null, { freshDays: 120, fill: 'quickbooks' }),
  ],
  'sales.receivables-lifecycle': [
    activity('estimates', 'Estimates', 'Estimate'),
    activity('estimate-to-invoice', 'Estimates turned into invoices', 'Invoice', linkedTo('Estimate'), { freshDays: 90 }),
    activity('invoices', 'Invoices', 'Invoice'),
    activity('payments', 'Customer payments', 'Payment'),
    activity('partly-paid-invoices', 'Partly paid invoices', 'Invoice', partlyPaid, { freshDays: 90 }),
    activity('current-invoices', 'Open invoices not yet due', 'Invoice', (r, ctx) => openBalance(r) && r.DueDate && r.DueDate >= ctx.today),
    activity('overdue-invoices', 'Overdue invoices', 'Invoice', overdue, { freshDays: 120 }),
    activity('unapplied-payments', 'Payments not applied to an invoice', 'Payment', (p) => num(p.UnappliedAmt) > 0, { freshDays: 120 }),
    activity('multi-invoice-payments', 'One payment covering several invoices', 'Payment', (p) => lines(p).filter((l) => (l.LinkedTxn || []).length).length > 1, { freshDays: 90 }),
    activity('credit-memos', 'Credit memos', 'CreditMemo', null, { freshDays: 90 }),
    activity('sales-receipts', 'Sales receipts', 'SalesReceipt'),
    activity('refund-receipts', 'Refund receipts', 'RefundReceipt', null, { freshDays: 120 }),
    activity('billable-expenses', 'Billable expenses added to invoices', 'Invoice', linkedTo('ReimburseCharge'), { freshDays: 90 }),
  ],
  'expenses.payables-lifecycle': [
    activity('purchase-orders', 'Purchase orders', 'PurchaseOrder'),
    activity('po-to-bill', 'Purchase orders turned into bills', 'Bill', linkedTo('PurchaseOrder'), { freshDays: 90 }),
    activity('bills', 'Bills', 'Bill'),
    activity('bill-payments', 'Bill payments', 'BillPayment'),
    activity('card-bill-payments', 'Bills paid by credit card', 'BillPayment', (b) => b.PayType === 'CreditCard', { freshDays: 180 }),
    activity('partly-paid-bills', 'Partly paid bills', 'Bill', partlyPaid, { freshDays: 90 }),
    activity('current-bills', 'Unpaid bills not yet due', 'Bill', (r, ctx) => openBalance(r) && r.DueDate && r.DueDate >= ctx.today),
    activity('overdue-bills', 'Overdue bills', 'Bill', overdue, { freshDays: 120 }),
    activity('vendor-credits', 'Vendor credits', 'VendorCredit', null, { freshDays: 120 }),
    activity('cheques-and-cash', 'Cheques and cash expenses', 'Purchase', (p) => ['Check', 'Cash'].includes(p.PaymentType)),
    activity('card-charges', 'Credit card charges', 'Purchase', (p) => p.PaymentType === 'CreditCard' && !p.Credit),
    activity('card-credits', 'Credit card refunds', 'Purchase', (p) => p.PaymentType === 'CreditCard' && p.Credit === true, { freshDays: 180 }),
  ],
  'banking.cash-and-clearing': [
    activity('deposits', 'Bank deposits', 'Deposit'),
    activity('grouped-deposits', 'Deposits that combine customer payments', 'Deposit', linkedTo('Payment'), { freshDays: 60 }),
    activity('transfers', 'Transfers between accounts', 'Transfer', null, { freshDays: 90 }),
  ],
  'tax.canadian-sales-tax': [
    setup('tax-codes', 'Sales tax codes set up', 'taxCodes', (t) => t.Active !== false, { min: 2, fill: 'quickbooks' }),
    activity('taxed-sales', 'Sales with tax charged', 'Invoice', taxed),
    activity('taxed-purchases', 'Bills with tax paid', 'Bill', taxed),
    activity('tax-payments', 'Sales tax return paid or refunded', 'taxPayments', null, { freshDays: 120, dateField: 'PaymentDate', fill: 'quickbooks' }),
  ],
  'projects.project-lifecycle': [
    setup('projects', 'Projects', 'customers', (c) => c.IsProject === true, { fill: 'quickbooks' }),
    activity('project-invoices', 'Invoices for a project', 'Invoice', onProject, { freshDays: 60, needs: NEEDS_PROJECTS }),
    activity('project-costs', 'Expenses or bills charged to a project', 'Bill', onProject, { freshDays: 60, alsoSource: 'Purchase', needs: NEEDS_PROJECTS }),
    activity('project-time', 'Time logged to a project', 'TimeActivity', onProject, { freshDays: 60, needs: NEEDS_PROJECTS }),
  ],
  'accounting.journals-and-close': [
    activity('journal-entries', 'Journal entries', 'JournalEntry'),
    activity('adjusting-entries', 'Adjusting journal entries', 'JournalEntry', (j) => j.Adjustment === true, { freshDays: 120 }),
    pref('books-closed', 'Books closed through a date', (p) => p.AccountingInfoPrefs?.BookCloseDate),
  ],
  'accounting.reconciliation': [
    manual('bank-reconciled', 'Bank account reconciled', 'Reconcile in Settings > Reconcile. Apps cannot read or record reconciliations.'),
    manual('card-reconciled', 'Credit card reconciled', 'Reconcile the card account in Settings > Reconcile.'),
  ],
  'accounting.budgets': [
    setup('budgets', 'A budget', 'budgets', null, { fill: 'quickbooks' }),
  ],
  'company.dimensions': [
    setup('classes', 'Classes', 'classes', (c) => c.Active !== false, { min: 2 }),
    setup('locations', 'Locations', 'departments', (d) => d.Active !== false, { min: 2 }),
    activity('class-tagged-sales', 'Sales tagged with a class', 'Invoice', hasRef('ClassRef'), { needs: NEEDS_CLASSES }),
    activity('class-tagged-costs', 'Bills tagged with a class', 'Bill', hasRef('ClassRef'), { needs: NEEDS_CLASSES }),
    activity('location-tagged', 'Transactions tagged with a location', 'Invoice', hasRef('DepartmentRef'), { alsoSource: 'Bill', needs: NEEDS_LOCATIONS }),
  ],
  'users.qbo-company-roles': [
    manual('extra-users', 'More than one user with different roles', 'Invite users in Settings > Manage users. Apps cannot read or change users.'),
  ],
  'accounting.recurring-transactions': [
    setup('recurring-templates', 'Recurring transaction templates', 'recurring', null, { fill: 'quickbooks' }),
  ],
  'company.multicurrency': [
    pref('multicurrency-on', 'Multicurrency turned on', (p) => p.CurrencyPrefs?.MultiCurrencyEnabled),
    setup('foreign-currencies', 'Foreign currencies added', 'currencies', (c) => c.Active !== false, { fill: 'quickbooks', needs: NEEDS_MULTICURRENCY }),
    activity('foreign-sales', 'Sales in a foreign currency', 'Invoice', foreign, { freshDays: 90, needs: NEEDS_MULTICURRENCY }),
    activity('foreign-bills', 'Bills in a foreign currency', 'Bill', foreign, { freshDays: 90, needs: NEEDS_MULTICURRENCY }),
  ],
  'company.custom-fields': [
    activity('custom-field-values', 'Sales forms with custom field values', 'Invoice', (r) => (r.CustomField || []).some((f) => f.StringValue), { freshDays: 90 }),
  ],
  'administration.attachments': [
    setup('attachments', 'Attachments on records', 'attachments', null, { fill: 'quickbooks' }),
  ],
  'expenses.time-activity': [
    setup('employees', 'Employees', 'employees', (e) => e.Active !== false),
    activity('time-entries', 'Time entries', 'TimeActivity'),
    activity('billable-time', 'Billable time', 'TimeActivity', (t) => t.BillableStatus === 'Billable'),
  ],
  'accounting.payroll-summary': [
    manual('payroll-run', 'Payroll run or payroll journal', 'Run payroll in QuickBooks Payroll, or record a summary journal entry by hand.'),
  ],
};

// About this app rather than the company's data, so they aren't measured here.
const LAB_INTERNAL_AREAS = new Set([
  'reporting.reports-api', 'administration.api-budgets', 'administration.full-pagination',
]);

function fillFor(signal) {
  if (signal.kind === 'manual') return 'quickbooks';
  if (signal.fill) return signal.fill;
  const entity = LIST_SOURCES[signal.source]?.entity || signal.source;
  return WRITABLE_ENTITY_TYPES.includes(entity) ? 'assistant' : 'quickbooks';
}

// ---------------------------------------------------------------------------
// Reading the company
// ---------------------------------------------------------------------------

// The server's own calendar date, so 'today' matches the operator's day.
function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Calendar arithmetic on a YYYY-MM-DD string, independent of time zone.
function daysBefore(today, days) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function queryFor(name, since, startPosition = 1) {
  if (LIST_SOURCES[name]?.single) return 'SELECT * FROM ' + LIST_SOURCES[name].entity;
  const pagination = ' STARTPOSITION ' + startPosition + ' MAXRESULTS ' + MAX_RESULTS;
  if (LIST_SOURCES[name]) {
    const { entity, where = '' } = LIST_SOURCES[name];
    return ('SELECT * FROM ' + entity + ' ' + where + pagination).replace(/\s+/g, ' ');
  }
  return "SELECT * FROM " + name + " WHERE TxnDate >= '" + since + "' ORDERBY TxnDate DESC" + pagination;
}

function shortError(err) {
  const status = err?.status ? 'HTTP ' + err.status : null;
  const msg = String(err?.message || 'Read failed').replace(/^QBO API error \(HTTP \d+\):\s*/, '').slice(0, 160);
  return status ? status + ': ' + msg : msg;
}

async function readSource(qbo, name, since, budget = { pages: MAX_PAGES, records: MAX_PAGES * MAX_RESULTS, deadline: Date.now() + READ_BUDGET_MS }) {
  const entity = LIST_SOURCES[name]?.entity || name;
  const records = [];
  const ids = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (budget.pages <= 0 || budget.records < MAX_RESULTS || Date.now() >= budget.deadline) {
        return { records, truncated: true, incompleteReason: 'The shared coverage read budget or deadline was reached.' };
      }
      budget.pages--;
      budget.records -= MAX_RESULTS; // Reserve before the asynchronous request.
      const result = await qbo.query(queryFor(name, since, page * MAX_RESULTS + 1));
      if (!result?.QueryResponse || typeof result.QueryResponse !== 'object') throw new Error('QuickBooks returned no query response');
      const rows = result.QueryResponse[entity] || [];
      if (!Array.isArray(rows) || rows.length > MAX_RESULTS) throw new Error('QuickBooks returned an invalid record list');
      budget.records += MAX_RESULTS - rows.length;
      let repeated = false;
      for (const row of rows) {
        if (row.Id && ids.has(String(row.Id))) { repeated = true; continue; }
        if (row.Id) ids.add(String(row.Id));
        records.push(row);
      }
      // Offset pages can change while a company is edited. Never silently call
      // a repeated/shifted page complete or retry it without a bound.
      if (repeated) return { records, truncated: true, incompleteReason: 'Records changed or repeated while paging. Check again.' };
      if (LIST_SOURCES[name]?.single || rows.length < MAX_RESULTS) return { records, truncated: false };
    }
    return { records, truncated: true, incompleteReason: 'The coverage read budget was reached.' };
  } catch (err) {
    return { records, truncated: records.length > 0, error: shortError(err), cause: err };
  }
}

async function readAll(qbo, names, since, budget = { pages: MAX_CHECK_PAGES, records: MAX_CHECK_RECORDS, deadline: Date.now() + READ_BUDGET_MS }) {
  const out = {};
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next++];
      out[name] = await readSource(qbo, name, since, budget);
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL_SIZE, names.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function evaluateSignal(signal, data, ctx) {
  const base = { key: signal.key, label: signal.label, kind: signal.kind, fill: fillFor(signal) };
  if (signal.kind === 'manual') return { ...base, status: 'manual', how: signal.how };

  if (signal.read) {
    const src = data.preferences;
    if (!src || src.error || !src.records?.[0]) {
      ctx.failedSources.add('preferences');
      return { ...base, status: 'error', error: src?.error || 'Preferences were not returned' };
    }
    return { ...base, status: signal.read(prefs(ctx)) ? 'ok' : 'missing' };
  }

  const prerequisiteSources = signal.needs === NEEDS_PROJECTS || signal.match === onProject ? ['customers']
    : [NEEDS_CLASSES, NEEDS_LOCATIONS, NEEDS_MULTICURRENCY].includes(signal.needs) || signal.match === foreign ? ['preferences'] : [];
  const incompletePrerequisite = prerequisiteSources.find((name) => !data[name] || data[name].error || data[name].truncated
    || (name === 'preferences' && !data[name].records?.[0]));
  if (incompletePrerequisite) {
    ctx.failedSources.add(incompletePrerequisite);
    return { ...base, status: 'error', error: 'Prerequisite records could not be completely checked: ' + incompletePrerequisite };
  }

  const sourceNames = [signal.source, signal.alsoSource].filter(Boolean);
  const failedName = sourceNames.find((n) => !data[n] || data[n].error);
  if (failedName) {
    const failed = data[failedName];
    // QuickBooks refuses some reads while the feature is off; that's a gap, not a failure.
    const blockedBy = signal.needs ? signal.needs(ctx) : null;
    if (blockedBy) return { ...base, status: 'missing', fill: 'quickbooks', blockedBy };
    sourceNames.filter((n) => !data[n] || data[n].error).forEach((n) => ctx.failedSources.add(n));
    return { ...base, status: 'error', error: failed?.error || 'Not read' };
  }

  let records = sourceNames.flatMap((n) => data[n].records);
  if (signal.match) records = records.filter((r) => signal.match(r, ctx));
  const truncated = sourceNames.some((n) => data[n].truncated);
  const min = signal.min || 1;

  if (signal.kind === 'setup') {
    const count = signal.count ? signal.count(records) : records.length;
    return { ...base, status: count >= min ? 'ok' : truncated ? 'error' : 'missing', count, min, truncated,
      ...(count < min && truncated ? { error: 'The record list is incomplete; absence is not established.' } : {}) };
  }

  const freshDays = signal.freshDays || DEFAULT_FRESH_DAYS;
  const freshSince = daysBefore(ctx.today, freshDays);
  const allDates = records.map((r) => r[signal.dateField || 'TxnDate']).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const future = allDates.filter((d) => d > ctx.today).length;
  const dates = allDates.filter((d) => d <= ctx.today && d >= daysBefore(ctx.today, LOOKBACK_DAYS)).sort();
  const last = dates[dates.length - 1] || null;
  const recent = dates.filter((d) => d >= freshSince).length;
  const status = recent >= min ? 'ok' : truncated ? 'error' : dates.length > 0 ? 'stale' : 'missing';
  const result = { ...base, status, count: dates.length, recent, freshDays, last, truncated, future,
    ...(status === 'error' ? { error: 'The record list is incomplete; absence is not established.' } : {}) };
  // A gap whose prerequisite is missing can only be started in QuickBooks.
  const blockedBy = status !== 'ok' && signal.needs ? signal.needs(ctx) : null;
  return blockedBy ? { ...result, fill: 'quickbooks', blockedBy } : result;
}

function areaStatus(signals) {
  const measured = signals.filter((s) => s.status !== 'manual');
  if (measured.length === 0) return 'manual';
  const ok = measured.filter((s) => s.status === 'ok').length;
  // Don't call an area unused when part of it couldn't be read.
  if (ok === 0 && measured.some((s) => s.status === 'error')) return 'error';
  if (ok === measured.length) return 'covered';
  if (ok > 0) return 'partial';
  if (measured.some((s) => s.status === 'stale')) return 'stale';
  return 'missing';
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

/**
 * Score already-read source data. Pure: no QuickBooks calls.
 * @param {Object} data - source name -> { records, truncated?, error? }
 * @param {Object} options - { today: 'YYYY-MM-DD', catalog? }
 */
function scoreCoverage(data, { today, catalog = loadCatalog() } = {}) {
  const preferences = data.preferences?.records?.[0] || {};
  const ctx = {
    today,
    preferences,
    homeCurrency: preferences.CurrencyPrefs?.HomeCurrency?.value || null,
    projectIds: new Set((data.customers?.records || []).filter((c) => c.IsProject === true).map((c) => c.Id)),
    failedSources: new Set(),
  };
  const reportNames = new Map((catalog.reports || []).map((r) => [r.key, r.name]));

  const areas = catalog.capabilities.map((cap) => {
    const common = {
      key: cap.key,
      name: cap.name,
      domain: cap.domain,
      tier: cap.tier,
      purpose: cap.purpose,
      linkedReports: (cap.linkedReports || []).map((k) => reportNames.get(k) || k),
    };
    if (LAB_INTERNAL_AREAS.has(cap.key)) return { ...common, status: 'internal', signals: [] };
    const signals = (AREA_SIGNALS[cap.key] || []).map((s) => evaluateSignal(s, data, ctx));
    return { ...common, status: signals.length ? areaStatus(signals) : 'unmeasured', signals };
  });

  const measured = areas.filter((a) => !['internal', 'unmeasured'].includes(a.status));
  const areaCounts = {};
  for (const a of measured) areaCounts[a.status] = (areaCounts[a.status] || 0) + 1;
  const gaps = { assistant: 0, quickbooks: 0 };
  for (const a of measured) {
    for (const s of a.signals) {
      if (['missing', 'stale'].includes(s.status)) gaps[s.fill] += 1;
    }
  }
  // Only failures that left a check unanswered; an expected refusal is already a gap.
  const sourceErrors = Object.entries(data)
    .filter(([name, s]) => s?.error && ctx.failedSources.has(name))
    .map(([name, s]) => ({ source: LIST_SOURCES[name]?.entity || name, error: s.error }));

  return {
    asOf: today,
    summary: { areas: areaCounts, measuredAreas: measured.length, gaps },
    areas,
    sourceErrors,
    evidence: {
      complete: !measured.some((area) => area.signals.some((signal) => signal.status === 'error'))
        && !Object.values(data).some((source) => source?.truncated),
      incompleteSources: Object.entries(data).filter(([, source]) => source?.truncated).map(([name, source]) => ({
        source: LIST_SOURCES[name]?.entity || name, reason: source.incompleteReason || 'The source was only partially read.',
      })),
      meaning: 'Completed bounded reads of feature presence and recent activity; not a consistent snapshot or proof of calendar continuity or reconciled accounts.',
    },
  };
}

// ---------------------------------------------------------------------------
// Public API with a short per-company cache
// ---------------------------------------------------------------------------

const cache = new Map(); // realmId -> { result, at }
const inflight = new Map(); // realmId -> Promise

function getCached(realmId) {
  const hit = cache.get(String(realmId));
  return hit ? hit.result : null;
}

async function runCheck(qbo, realmId, now) {
  const started = Date.now();
  const today = isoDate(now);
  const since = daysBefore(today, LOOKBACK_DAYS);
  const names = [...Object.keys(LIST_SOURCES), ...TXN_SOURCES];
  const data = await readAll(qbo, names, since);

  // When nothing could be read at all, the connection is the problem; let the
  // caller report the QuickBooks error rather than a page of failed checks.
  const results = Object.values(data);
  if (results.every((s) => s.error)) throw results[0].cause || new Error(results[0].error);

  const scored = scoreCoverage(data, { today });
  for (const s of Object.values(data)) delete s.cause;
  const result = {
    realmId: String(realmId),
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    lookbackDays: LOOKBACK_DAYS,
    ...scored,
  };
  cache.set(String(realmId), { result, at: Date.now() });
  return result;
}

/**
 * Coverage for a company. Uses the cached result for up to ten minutes
 * unless refresh is set. Concurrent callers share one check.
 */
async function getCoverage(qbo, realmId, { refresh = false, now = new Date() } = {}) {
  const key = String(realmId);
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (age < (refresh ? MIN_REFRESH_MS : CACHE_MS)) return hit.result;
  if (inflight.has(key)) return inflight.get(key);
  const run = runCheck(qbo, key, now).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** Forget a company's result, e.g. after the lab changed its records. */
function invalidate(realmId) {
  cache.delete(String(realmId));
}

const STATUS_WORDS = {
  ok: 'in use', stale: 'stale', missing: 'missing', manual: 'check by hand', error: 'could not check',
};

/**
 * A compact plain-text summary for the assistant's instructions.
 */
function summarizeForAssistant(result, { areaKey } = {}) {
  if (!result) return null;
  const areas = result.areas.filter((a) => !['internal', 'unmeasured'].includes(a.status)
    && (!areaKey || a.key === areaKey));
  const lines = [`Coverage checked ${result.checkedAt.slice(0, 16).replace('T', ' ')} UTC (records from the last ${result.lookbackDays} days).`];
  for (const area of areas) {
    const gaps = area.signals.filter((s) => s.status !== 'ok').map((s) => {
      const who = s.fill === 'assistant' ? 'you can create' : 'needs QuickBooks';
      const when = s.last ? `, last ${s.last}` : '';
      return `${s.label} (${STATUS_WORDS[s.status]}${when}; ${who})`;
    });
    lines.push(`- ${area.name} [${area.key}]: ${area.status}${gaps.length ? `. Gaps: ${gaps.join('; ')}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  getCoverage,
  readSource,
  getCached,
  invalidate,
  scoreCoverage,
  summarizeForAssistant,
  AREA_SIGNALS,
  LIST_SOURCES,
  TXN_SOURCES,
  _internal: { evaluateSignal, areaStatus, refsOn, queryFor, readSource, readAll, daysBefore, cache },
};
