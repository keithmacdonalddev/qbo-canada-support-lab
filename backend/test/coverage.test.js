'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const coverage = require('../src/modules/coverage');
const { toolHandlers, toolPermissions } = require('../src/modules/ai-tools');

const TODAY = '2026-10-02';
const empty = () => ({ records: [] });

function baseData() {
  const data = {};
  for (const name of Object.keys(coverage.LIST_SOURCES)) data[name] = empty();
  for (const name of coverage.TXN_SOURCES) data[name] = empty();
  data.preferences = { records: [{ CurrencyPrefs: { HomeCurrency: { value: 'CAD' } }, AccountingInfoPrefs: {} }] };
  return data;
}

const area = (result, key) => result.areas.find((a) => a.key === key);
const signal = (result, areaKey, key) => area(result, areaKey).signals.find((s) => s.key === key);

test('every measured area maps to a catalog capability', () => {
  const result = coverage.scoreCoverage(baseData(), { today: TODAY });
  const keys = new Set(result.areas.map((a) => a.key));
  for (const key of Object.keys(coverage.AREA_SIGNALS)) assert.ok(keys.has(key), `${key} is not in the catalog`);
  assert.ok(result.areas.every((a) => a.status !== 'unmeasured'), 'a catalog area has no signals');
});

test('an empty company reads as missing, manual areas stay manual, lab internals are not scored', () => {
  const result = coverage.scoreCoverage(baseData(), { today: TODAY });
  assert.equal(area(result, 'sales.receivables-lifecycle').status, 'missing');
  assert.equal(area(result, 'accounting.reconciliation').status, 'manual');
  assert.equal(area(result, 'administration.api-budgets').status, 'internal');
  assert.equal(result.summary.areas.internal, undefined);
  assert.ok(result.summary.gaps.assistant > 0);
  assert.ok(result.summary.gaps.quickbooks > 0);
});

test('activity is in use when recent, stale when only old, and says who can fill it', () => {
  const data = baseData();
  data.Invoice = { records: [
    { Id: '1', TxnDate: '2026-09-20', DueDate: '2026-09-25', TotalAmt: 100, Balance: 40 },
    { Id: '2', TxnDate: '2026-01-10', DueDate: '2026-02-10', TotalAmt: 50, Balance: 0, LinkedTxn: [{ TxnType: 'Estimate', TxnId: '9' }] },
  ] };
  const result = coverage.scoreCoverage(data, { today: TODAY });

  const invoices = signal(result, 'sales.receivables-lifecycle', 'invoices');
  assert.equal(invoices.status, 'ok');
  assert.equal(invoices.last, '2026-09-20');
  assert.equal(invoices.fill, 'assistant');

  assert.equal(signal(result, 'sales.receivables-lifecycle', 'partly-paid-invoices').status, 'ok');
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'overdue-invoices').status, 'ok');
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'estimate-to-invoice').status, 'stale');
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'refund-receipts').status, 'missing');
  assert.equal(area(result, 'sales.receivables-lifecycle').status, 'partial');
});

test('current receivables, billable expenses and tax payments are measured', () => {
  const data = baseData();
  data.Invoice = { records: [
    { TxnDate: '2026-09-25', DueDate: '2026-10-25', TotalAmt: 100, Balance: 100 },
    { TxnDate: '2026-09-10', DueDate: '2026-09-20', TotalAmt: 80, Balance: 0, Line: [{ LinkedTxn: [{ TxnType: 'ReimburseCharge' }] }] },
  ] };
  data.taxPayments = { records: [{ PaymentDate: '2026-04-30', PaymentAmount: 900 }] };
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'current-invoices').status, 'ok');
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'billable-expenses').status, 'ok');
  const tax = signal(result, 'tax.canadian-sales-tax', 'tax-payments');
  assert.equal(tax.status, 'stale');
  assert.equal(tax.last, '2026-04-30');
  assert.equal(tax.fill, 'quickbooks');
});

test('setup signals honour minimums and preferences', () => {
  const data = baseData();
  data.customers = { records: Array.from({ length: 10 }, (_, i) => ({ Id: String(i), Active: true, BillAddr: { CountrySubDivisionCode: i % 2 ? 'NS' : 'ON' } })) };
  data.preferences.records[0].AccountingInfoPrefs.ClassTrackingPerTxnLine = true;
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'sales.customers', 'active-customers').status, 'ok');
  assert.equal(signal(result, 'sales.customers', 'customer-provinces').status, 'ok');
  assert.equal(signal(result, 'sales.customers', 'sub-customers').status, 'missing');
  assert.equal(signal(result, 'company.preferences', 'class-tracking').status, 'ok');
  assert.equal(signal(result, 'company.preferences', 'class-tracking').fill, 'quickbooks');
});

test('project activity is matched through project customers', () => {
  const data = baseData();
  data.customers = { records: [{ Id: '77', IsProject: true }] };
  data.Purchase = { records: [{ Id: '5', TxnDate: '2026-09-28', Line: [{ AccountBasedExpenseLineDetail: { CustomerRef: { value: '77' } } }] }] };
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'projects.project-lifecycle', 'projects').status, 'ok');
  assert.equal(signal(result, 'projects.project-lifecycle', 'project-costs').status, 'ok');
  assert.equal(signal(result, 'projects.project-lifecycle', 'project-time').status, 'missing');
});

test('gaps that need a QuickBooks setting first are not offered to the assistant', () => {
  const result = coverage.scoreCoverage(baseData(), { today: TODAY });
  const projectInvoices = signal(result, 'projects.project-lifecycle', 'project-invoices');
  assert.equal(projectInvoices.status, 'missing');
  assert.equal(projectInvoices.fill, 'quickbooks');
  assert.match(projectInvoices.blockedBy, /project/);
  assert.equal(signal(result, 'company.dimensions', 'class-tagged-sales').fill, 'quickbooks');
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'invoices').fill, 'assistant');
});

test('a refused read for a feature that is off is a gap, not a failure', () => {
  const data = baseData();
  data.currencies = { records: [], error: 'HTTP 400: Multicurrency is not enabled' };
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'company.multicurrency', 'foreign-currencies').status, 'missing');
  assert.equal(area(result, 'company.multicurrency').status, 'missing');
  assert.deepEqual(result.sourceErrors, []);
});

test('manual checks are not counted as gaps', () => {
  const result = coverage.scoreCoverage(baseData(), { today: TODAY });
  const counted = result.areas.flatMap((a) => a.signals).filter((s) => ['missing', 'stale'].includes(s.status));
  assert.equal(result.summary.gaps.assistant + result.summary.gaps.quickbooks, counted.length);
});

test('a source that failed to read is reported, not counted as missing', () => {
  const data = baseData();
  data.Bill = { records: [], error: 'HTTP 400: bad query' };
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'expenses.payables-lifecycle', 'bills').status, 'error');
  assert.deepEqual(result.sourceErrors, [{ source: 'Bill', error: 'HTTP 400: bad query' }]);
});

function fakeQbo({ fail = () => false } = {}) {
  const queries = [];
  return {
    queries,
    async query(q) {
      queries.push(q);
      const entity = q.match(/FROM (\w+)/)[1];
      if (fail(entity)) { const err = new Error('QBO API error (HTTP 401): AuthenticationFailed'); err.status = 401; throw err; }
      if (entity === 'Invoice') return { QueryResponse: { Invoice: [{ Id: '1', TxnDate: '2026-09-30', TotalAmt: 10, Balance: 10 }] } };
      return { QueryResponse: {} };
    },
  };
}

test('getCoverage reads only with SELECT queries, caches, and shares one run', async () => {
  coverage._internal.cache.clear();
  const qbo = fakeQbo();
  const now = new Date(`${TODAY}T12:00:00Z`);
  const [a, b] = await Promise.all([
    coverage.getCoverage(qbo, 'realm-1', { now }),
    coverage.getCoverage(qbo, 'realm-1', { now }),
  ]);
  assert.equal(a, b);
  const first = qbo.queries.length;
  assert.ok(first > 0);
  assert.ok(qbo.queries.every((q) => q.startsWith('SELECT * FROM ')));
  assert.ok(qbo.queries.some((q) => q.includes("FROM Invoice WHERE TxnDate >= '2025-10-02'")));

  await coverage.getCoverage(qbo, 'realm-1', { now });
  assert.equal(qbo.queries.length, first, 'second call should use the cache');
  await coverage.getCoverage(qbo, 'realm-1', { now, refresh: true });
  assert.equal(qbo.queries.length, first, 'a refresh within a minute should reuse the fresh result');
  coverage.invalidate('realm-1');
  assert.equal(coverage.getCached('realm-1'), null);
  await coverage.getCoverage(qbo, 'realm-1', { now });
  assert.equal(qbo.queries.length, first * 2);
  assert.equal(coverage.getCached('realm-1').realmId, 'realm-1');
  assert.match(coverage.summarizeForAssistant(a), /Sales and receivables lifecycle/);
});

test('getCoverage throws the QuickBooks error when nothing can be read', async () => {
  coverage._internal.cache.clear();
  await assert.rejects(
    coverage.getCoverage(fakeQbo({ fail: () => true }), 'realm-2'),
    (err) => err.status === 401,
  );
  assert.equal(coverage.getCached('realm-2'), null);
});

test('coverage and report tools are read-only', () => {
  assert.equal(toolPermissions.getCoverage, 'auto');
  assert.equal(toolPermissions.runReport, 'auto');
});

test('runReport validates input and flattens report rows', async () => {
  const calls = [];
  const qbo = {
    async apiCall(method, endpoint) {
      calls.push([method, endpoint]);
      return {
        Header: { ReportName: 'AgedReceivables', StartPeriod: '2026-09-01', EndPeriod: '2026-09-30' },
        Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Total' }] },
        Rows: { Row: [
          { type: 'Data', ColData: [{ value: 'Harbourview Dental' }, { value: '1250.00' }] },
          { type: 'Section', Summary: { ColData: [{ value: 'TOTAL' }, { value: '1250.00' }] } },
        ] },
      };
    },
  };
  const bad = await toolHandlers.runReport({ report: 'AgedReceivables', reportDate: '30/09/2026' }, { qbo });
  assert.equal(bad.success, false);
  assert.equal((await toolHandlers.runReport({ report: 'Nope' }, { qbo })).success, false);
  assert.equal(calls.length, 0);

  const ok = await toolHandlers.runReport({ report: 'AgedReceivables', reportDate: '2026-09-30' }, { qbo });
  assert.deepEqual(calls[0], ['GET', 'reports/AgedReceivables?report_date=2026-09-30']);
  assert.equal(ok.success, true);
  assert.equal(ok.data.empty, false);
  assert.equal(ok.data.dataRows, 1);
  assert.deepEqual(ok.data.lines, ['Harbourview Dental | 1250.00', 'TOTAL | 1250.00']);
});


test('future transactions never establish current activity', () => {
  const data = baseData();
  data.SalesReceipt.records = [{ Id: 'future', TxnDate: '2026-10-03' }];
  const result = coverage.scoreCoverage(data, { today: TODAY });
  const receipt = signal(result, 'sales.receivables-lifecycle', 'sales-receipts');
  assert.equal(receipt.status, 'missing');
  assert.equal(receipt.recent, 0);
  assert.equal(receipt.last, null);
  assert.equal(receipt.future, 1);
});

test('missing source data is unknown, never an empty successful read', () => {
  const data = baseData();
  delete data.Invoice;
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'sales.receivables-lifecycle', 'invoices').status, 'error');
  assert.equal(result.evidence.complete, false);
});

test('incomplete pages cannot prove a feature is missing', () => {
  const data = baseData();
  data.Purchase = { records: [], truncated: true };
  const result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'expenses.payables-lifecycle', 'card-credits').status, 'error');
  assert.equal(result.evidence.complete, false);
  assert.equal(result.evidence.incompleteSources[0].source, 'Purchase');
});

test('coverage reads past 1000 records and finds evidence on later pages', async () => {
  const calls = [];
  const qbo = { async query(q) {
    calls.push(q);
    return { QueryResponse: { Invoice: calls.length === 1
      ? Array.from({ length: 1000 }, (_, i) => ({ Id: String(i), TxnDate: '2026-09-30' }))
      : [{ Id: '1001', TxnDate: '2026-09-20', LinkedTxn: [{ TxnType: 'Estimate', TxnId: 'est' }] }] } };
  } };
  const source = await coverage._internal.readSource(qbo, 'Invoice', '2025-10-02');
  assert.equal(source.records.length, 1001);
  assert.equal(source.truncated, false);
  assert.match(calls[1], /STARTPOSITION 1001 MAXRESULTS 1000/);
  const data = baseData(); data.Invoice = source;
  assert.equal(signal(coverage.scoreCoverage(data, { today: TODAY }), 'sales.receivables-lifecycle', 'estimate-to-invoice').status, 'ok');
});

test('repeated pages and later-page failures do not become complete evidence', async () => {
  const page = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i) }));
  const repeated = await coverage._internal.readSource({ query: async () => ({ QueryResponse: { Bill: page } }) }, 'Bill', '2025-10-02');
  assert.equal(repeated.truncated, true);
  assert.equal(repeated.records.length, 1000);
  let calls = 0;
  const failed = await coverage._internal.readSource({ query: async () => {
    if (++calls === 2) throw new Error('Read failed');
    return { QueryResponse: { Bill: page } };
  } }, 'Bill', '2025-10-02');
  assert.equal(failed.truncated, true);
  assert.equal(failed.records.length, 1000);
  assert.match(failed.error, /Read failed/);
});

test('malformed upstream response is a read error', async () => {
  const source = await coverage._internal.readSource({ query: async () => ({}) }, 'Bill', '2025-10-02');
  assert.match(source.error, /no query response/);
});


test('incomplete project and preference reads do not become setup gaps', () => {
  const data = baseData();
  data.customers = { records: [], truncated: true };
  data.Invoice = { records: [{ TxnDate: '2026-09-30', CustomerRef: { value: 'unread-project' } }] };
  let result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'projects.project-lifecycle', 'project-invoices').status, 'error');
  delete data.preferences;
  result = coverage.scoreCoverage(data, { today: TODAY });
  assert.equal(signal(result, 'company.dimensions', 'class-tagged-sales').status, 'error');
  assert.equal(signal(result, 'company.preferences', 'class-tracking').status, 'error');
  assert.equal(result.evidence.complete, false);
});


test('one shared budget bounds all concurrent coverage readers', async () => {
  let calls = 0;
  const qbo = { query: async () => { calls++; return { QueryResponse: {} }; } };
  const sources = await coverage._internal.readAll(qbo, ['Invoice', 'Bill', 'Payment', 'Purchase'], '2025-10-02', { pages: 2, records: 10000, deadline: Date.now() + 60000 });
  assert.equal(calls, 2);
  assert.equal(Object.values(sources).filter(source => source.truncated).length, 2);
  const expired = await coverage._internal.readAll(qbo, ['Invoice'], '2025-10-02', { pages: 2, records: 10000, deadline: Date.now() - 1 });
  assert.equal(calls, 2);
  assert.equal(expired.Invoice.truncated, true);
});
