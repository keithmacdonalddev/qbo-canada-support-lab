'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBooks, readBookEvidence, validDate, money, rowsOf } = require('../src/modules/book-evidence');
const period = { fromDate: '2026-10-01', throughDate: '2026-10-06' };
const header = { StartPeriod: period.fromDate, EndPeriod: period.throughDate, ReportBasis: 'Accrual', Currency: 'CAD' };
const cell = value => ({ value });
const data = (id, debit, credit) => ({ type: 'Data', ColData: [{ id, value: id }, cell(debit), cell(credit)] });
const total = (group, values) => ({ type: 'Section', group, Summary: { ColData: values.map(cell) } });
const report = (columns, rows) => ({ Header: { ...header }, Columns: { Column: columns.map(ColTitle => ({ ColTitle })) }, Rows: { Row: rows } });
function fixture() {
  const reports = {
    TrialBalance: report(['Account', 'Debit', 'Credit'], [data('ar', '100.00', ''), data('ap', '', '50.00'), data('other', '', '50.00'), total('GrandTotal', ['TOTAL', '100.00', '100.00'])]),
    BalanceSheet: report(['Account', 'Total'], [data('bank', '100.00', ''), total('Assets', ['Total Assets', '100.00']), total('LiabilitiesAndEquity', ['Total Liabilities and Equity', '100.00'])]),
    ProfitAndLoss: report(['Account', 'Total'], [data('income', '50.00', '')]),
    AgedReceivables: report(['Name', 'Current', 'Total'], [data('customer', '100.00', '100.00'), total('GrandTotal', ['TOTAL', '100.00', '100.00'])]),
    AgedPayables: report(['Name', 'Current', 'Total'], [data('vendor', '50.00', '50.00'), total('GrandTotal', ['TOTAL', '50.00', '50.00'])]),
  };
  for (const [name, result] of Object.entries(reports)) result.Header.ReportName = name;
  return reports;
}
const accounts = { records: [{ Id: 'ar', AccountType: 'Accounts Receivable' }, { Id: 'ap', AccountType: 'Accounts Payable' }] };
test('matching scoped reports prove only the named accounting assertions', () => {
  const result = evaluateBooks(fixture(), period, {}, accounts);
  assert.equal(result.status, 'checks-passed');
  assert.equal(result.checks.length, 4);
  assert.equal(result.reconciled, false);
  assert.equal(result.calendarVerified, false);
});
test('aging differences are shown instead of silently passing balanced books', () => {
  const reports = fixture();
  reports.AgedReceivables.Rows.Row[1].Summary.ColData[2].value = '99.99';
  const result = evaluateBooks(reports, period, {}, accounts);
  assert.equal(result.status, 'differences-found');
  assert.equal(result.checks.find(check => check.key === 'receivables').difference, 0.01);
});
test('wrong dates, cash basis, and foreign or missing currency are not eligible evidence', () => {
  for (const change of [{ EndPeriod: '2026-10-05' }, { ReportBasis: 'Cash' }, { Currency: 'USD' }, { Currency: undefined }]) {
    const reports = fixture(); Object.assign(reports.TrialBalance.Header, change);
    assert.equal(evaluateBooks(reports, period, {}, accounts).checks[0].status, 'unverified');
  }
});
test('partial account reads and missing account rows cannot prove ledger agreement', () => {
  for (const source of [undefined, { ...accounts, truncated: true }, { ...accounts, error: 'failed' }, { records: [...accounts.records, { Id: 'ar2', AccountType: 'Accounts Receivable' }] }]) {
    assert.equal(evaluateBooks(fixture(), period, {}, source).checks.find(check => check.key === 'receivables').status, 'unverified');
  }
});
test('duplicate totals, empty and failed reports remain unverified', () => {
  const reports = fixture();
  reports.TrialBalance.Rows.Row.push(total('GrandTotal', ['TOTAL', '100.00', '100.00']));
  reports.BalanceSheet.Header.Option = [{ Name: 'NoReportData', Value: 'true' }];
  const result = evaluateBooks(reports, period, { AgedPayables: 'unavailable' }, accounts);
  assert.equal(result.checks[0].status, 'unverified');
  assert.equal(result.checks[1].status, 'unverified');
  assert.equal(result.reports.find(report => report.name === 'AgedPayables').status, 'unavailable');
});
test('date and amount parsing rejects impossible dates and ambiguous amounts', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2024-02-29'), true);
  assert.equal(money('1,000.00'), null);
  assert.equal(money(''), null);
  assert.equal(money('0.01'), 1);
  assert.equal(money('1.001'), null);
});
test('book reads use fixed GET report names and SELECT accounts only', async () => {
  const calls = [];
  const fixtures = fixture();
  const qbo = { query: async query => { calls.push(['query', query]); return { QueryResponse: { Account: accounts.records } }; }, apiCall: async (method, endpoint) => {
    calls.push([method, endpoint]); return fixtures[endpoint.split('/')[1].split('?')[0]];
  } };
  const result = await readBookEvidence(qbo, { ...period, today: period.throughDate });
  assert.equal(result.status, 'checks-passed');
  assert.equal(calls.length, 6);
  assert.ok(calls.every(([method]) => ['GET', 'query'].includes(method)));
  assert.ok(calls.filter(([method]) => method === 'GET').every(([, endpoint]) => endpoint.includes('accounting_method=Accrual')));
});
test('invalid or future periods cause no QuickBooks calls', async () => {
  let called = false;
  const qbo = { query: async () => { called = true; }, apiCall: async () => { called = true; } };
  await assert.rejects(readBookEvidence(qbo, { ...period, throughDate: '2026-10-07', today: '2026-10-06' }), error => error.status === 400);
  assert.equal(called, false);
});

test('report traversal bounds flat and nested data and rejects invalid row lists', () => {
  const row = data('1', '1.00', '');
  assert.throws(() => rowsOf({ Rows: { Row: Array(100001).fill(row) } }), /budget/);
  let nested = row;
  for (let i = 0; i < 32; i++) nested = { Rows: { Row: [nested] } };
  assert.throws(() => rowsOf({ Rows: { Row: [nested] } }), /budget/);
  assert.throws(() => rowsOf({ Rows: { Row: {} } }), /invalid row list/);
});
test('a data row without a type attribute remains readable, and wrong report identity does not pass', () => {
  const reports = fixture();
  for (const row of reports.TrialBalance.Rows.Row) delete row.type;
  assert.equal(evaluateBooks(reports, period, {}, accounts).checks[0].status, 'passed');
  reports.TrialBalance.Header.ReportName = 'BalanceSheet';
  assert.equal(evaluateBooks(reports, period, {}, accounts).checks[0].status, 'unverified');
});


test('Canadian aging without a ReportBasis is explicitly dated open-balance evidence', () => {
  const reports = fixture();
  delete reports.AgedReceivables.Header.ReportBasis;
  delete reports.AgedReceivables.Header.StartPeriod;
  const result = evaluateBooks(reports, period, {}, accounts);
  assert.equal(result.checks.find(check => check.key === 'receivables').status, 'passed');
  assert.equal(result.reports.find(report => report.name === 'AgedReceivables').basis, null);
  assert.equal(result.reports.find(report => report.name === 'AgedReceivables').evidenceType, 'open-balances-at-date');
});
test('unambiguous Canadian balance-sheet summary labels provide direct report evidence', () => {
  const reports = fixture();
  reports.BalanceSheet.Rows.Row[1].group = 'OtherAssetsKey';
  reports.BalanceSheet.Rows.Row[2].group = 'OtherEquityKey';
  reports.BalanceSheet.Rows.Row.push(total('OtherARKey', ['Total Accounts Receivable (A/R)', '100.00']));
  reports.BalanceSheet.Rows.Row.push(total('OtherAPKey', ['Total Accounts Payable (A/P)', '50.00']));
  assert.equal(evaluateBooks(reports, period).status, 'checks-passed');
  reports.BalanceSheet.Rows.Row.push(total('DuplicateARKey', ['Total Accounts Receivable (A/R)', '100.00']));
  assert.equal(evaluateBooks(reports, period).checks.find(check => check.key === 'receivables').status, 'unverified');
});

test('malformed aging basis values are not equivalent to an omitted basis', () => {
  for (const value of [false, 0, [], {}]) {
    const reports = fixture(); reports.AgedReceivables.Header.ReportBasis = value;
    assert.equal(evaluateBooks(reports, period, {}, accounts).checks.find(check => check.key === 'receivables').status, 'unverified');
  }
});
