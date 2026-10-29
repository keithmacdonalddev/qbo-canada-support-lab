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
function fixture(critical = false) {
  const reports = {
    TrialBalance: report(['Account', 'Debit', 'Credit'], [data('ar', '100.00', ''), data('ap', '', '50.00'), data('other', '', '50.00'), total('GrandTotal', ['TOTAL', '100.00', '100.00'])]),
    BalanceSheet: report(['Account', 'Total'], [data('bank', '100.00', ''), total('Assets', ['Total Assets', '100.00']), total('LiabilitiesAndEquity', ['Total Liabilities and Equity', '100.00'])]),
    ProfitAndLoss: report(['Account', 'Total'], [data('income', '50.00', '')]),
    AgedReceivables: report(['Name', 'Current', 'Total'], [data('customer', '100.00', '100.00'), total('GrandTotal', ['TOTAL', '100.00', '100.00'])]),
    AgedPayables: report(['Name', 'Current', 'Total'], [data('vendor', '50.00', '50.00'), total('GrandTotal', ['TOTAL', '50.00', '50.00'])]),
  };
  if (critical) { for (const name of ['BalanceSheet','ProfitAndLoss']) for (const row of reports[name].Rows.Row) if (row.ColData) row.ColData = row.ColData.slice(0,2); reports.GeneralLedger = report(['Account', 'Debit', 'Credit'], [data('ar', '100.00', '')]); reports.CashFlow = report(['Activity', 'Total'], [{ColData:[{value:'Cash'},{value:'100.00'}]}]); }
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
  const fixtures=fixture(true);fixtures.TrialBalance.Rows.Row[0].ColData[0].id='1';fixtures.TrialBalance.Rows.Row[1].ColData[0].id='2';
  const h=require('./helpers/book-read-fixture').bookReadFixture(fixtures);
  const result=await readBookEvidence(h.access,h.scope,period);
  assert.equal(result.status,'checks-passed');assert.equal(result.readAttempts,8);assert.equal(h.calls.length,8);assert.ok(h.calls.every(call=>call.method==='GET'));assert.ok(h.actions.every(action=>action==='reports.observe'));assert.ok(h.calls.filter(call=>call.url.includes('/reports/')).every(call=>call.url.includes('accounting_method=Accrual')));
});
test('invalid or future periods cause no QuickBooks calls',async()=>{
 const h=require('./helpers/book-read-fixture').bookReadFixture(fixture(true));await assert.rejects(readBookEvidence(h.access,h.scope,{...period,throughDate:'2026-10-07'},{now:()=>Date.parse('2026-10-06T12:00:00Z')}),{status:400});assert.equal(h.calls.length,0);
});
test('public book reads stop after revocation, enforce detail budgets and cancel stuck observations',async()=>{
 const make=()=>{const reports=fixture(true);reports.TrialBalance.Rows.Row[0].ColData[0].id='1';reports.TrialBalance.Rows.Row[1].ColData[0].id='2';return require('./helpers/book-read-fixture').bookReadFixture(reports);};
 const revoked=make();revoked.onCall=async()=>{revoked.revoked=true;};await assert.rejects(readBookEvidence(revoked.access,revoked.scope,period),{code:'BUSINESS_ACCESS_DENIED'});assert.ok(revoked.calls.length<=2,'at most already-started reads finish after revocation');
 const large=make();large.reports.GeneralLedger.Rows.Row[0].ColData[0].value='x'.repeat(6000000);await assert.rejects(readBookEvidence(large.access,large.scope,period),{code:'BUSINESS_REPORT_UNVERIFIED'});
 const stuck=make(),controller=new AbortController();let release;const held=new Promise(resolve=>{release=resolve;});stuck.onCall=async options=>{if(options.url.includes('/reports/GeneralLedger')){controller.abort();await held;}};
 try{await assert.rejects(readBookEvidence(stuck.access,stuck.scope,period,{signal:controller.signal}),/cancelled/);}finally{release();}
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

test('an explicit empty aging report cannot invent a missing or duplicate ledger balance',()=>{
 for(const duplicate of [false,true]){
  const reports=fixture();reports.TrialBalance.Rows.Row=reports.TrialBalance.Rows.Row.filter(row=>row.ColData?.[0]?.id!=='ar');
  if(duplicate)reports.TrialBalance.Rows.Row.push(data('ar','0.00',''),data('ar','0.00',''));
  reports.BalanceSheet.Rows.Row.push(total('AccountsReceivable',['Total Accounts Receivable (A/R)','100.00']));
  reports.AgedReceivables.Rows.Row=[];reports.AgedReceivables.Header.Option=[{Name:'NoReportData',Value:'true'}];
  const result=evaluateBooks(reports,period,{},accounts,{allowExplicitZero:true}),check=result.checks.find(row=>row.key==='receivables');assert.equal(check.status,'failed');assert.equal(check.left,100);assert.equal(check.right,0);
 }
});
test('an explicitly empty zero P&L and aging retain scope checks and require independent ledger totals',()=>{
 const reports=fixture();reports.ProfitAndLoss.Rows.Row=[];reports.ProfitAndLoss.Header.Option=[{Name:'NoReportData',Value:'true'}];
 assert.equal(evaluateBooks(reports,period,{},accounts,{allowExplicitZero:true}).status,'checks-passed');
 for(const name of ['TrialBalance','BalanceSheet','AgedReceivables','AgedPayables']){reports[name].Rows.Row=[];reports[name].Header.Option=[{Name:'NoReportData',Value:'true'}];}
 assert.equal(evaluateBooks(reports,period,{},accounts,{allowExplicitZero:true}).status,'checks-passed');assert.equal(evaluateBooks(reports,period,{},accounts).status,'verification-incomplete');
 reports.TrialBalance.Header.Currency='USD';assert.equal(evaluateBooks(reports,period,{},accounts,{allowExplicitZero:true}).checks[0].status,'unverified');
});

test('v2 availability cannot pass missing P&L, ledger or cash flow merely because four arithmetic checks agree',()=>{
 for(const name of ['ProfitAndLoss','GeneralLedger','CashFlow']){const reports=fixture(true);delete reports[name];const result=evaluateBooks(reports,period,{},accounts,{includeCritical:true});assert.ok(result.checks.every(row=>row.status==='passed'));assert.equal(result.status,'verification-incomplete');assert.equal(result.reportCoverage.complete,false);assert.ok(result.reportCoverage.missing.includes(name));}
 // The immutable v1 evaluator keeps its original output; new decisions use v2.
 const old=fixture();delete old.ProfitAndLoss;const legacy=evaluateBooks(old,period,{},accounts);assert.equal(legacy.status,'checks-passed');assert.equal('reportCoverage'in legacy,false);
});
test('critical detail and cash-flow observations require both dates and their own accounting semantics',()=>{
 for(const name of ['GeneralLedger','CashFlow'])for(const patch of [{StartPeriod:'2026-09-01'},{EndPeriod:'2026-10-05'},{Currency:'USD'},{ReportBasis:'Cash'},{ReportName:'GeneralLedgerDetail'}]){const reports=fixture(true);Object.assign(reports[name].Header,patch);assert.equal(evaluateBooks(reports,period,{},accounts,{includeCritical:true}).reportCoverage.complete,false);}
 const reports=fixture(true);delete reports.CashFlow.Header.ReportBasis;const result=evaluateBooks(reports,period,{},accounts,{includeCritical:true});assert.equal(result.reportCoverage.complete,true);assert.equal(result.reports.find(row=>row.name==='CashFlow').evidenceType,'cash-movement-statement');assert.equal(result.reports.find(row=>row.name==='GeneralLedger').evidenceType,'ledger-detail');assert.equal(result.reconciled,false);
});

test('malformed critical report columns, rows and cells never count as available',()=>{
 for(const name of ['GeneralLedger','CashFlow'])for(const mutate of [r=>{r.Columns.Column=[];r.Rows.Row=[{ColData:[]}];},r=>{r.Rows.Row=[{ColData:[{value:'Only one cell'}]}];},r=>{r.Rows.Row[0].ColData[0].value={unparsed:true};},r=>{r.Columns.Column[0]={};}]){const reports=fixture(true);mutate(reports[name]);const result=evaluateBooks(reports,period,{},accounts,{includeCritical:true});assert.equal(result.reportCoverage.complete,false);assert.equal(result.status,'verification-incomplete');assert.ok(result.checks.every(row=>row.status==='passed'));}
});

test('critical report sections require bounded string cells before availability and public summaries', () => {
  for (const name of ['GeneralLedger', 'CashFlow']) {
    for (const section of ['Header', 'Summary']) {
      for (const cells of [[{value:'TOTAL'}, {value:{bad:true}}], [{value:123}], [], Array(33).fill({value:'0.00'}), [{value:'TOTAL',id:{bad:true}}]]) {
        const reports = fixture(true); reports[name].Rows.Row.push({[section]:{ColData:cells}});
        const result = evaluateBooks(reports, period, {}, accounts, {includeCritical:true});
        assert.equal(result.reportCoverage.complete, false); assert.equal(result.reports.find(row=>row.name===name).status, 'unavailable');
      }
    }
    const reports = fixture(true); reports[name].Rows.Row.push({Header:{ColData:[{value:'Account section'}]}});
    assert.equal(evaluateBooks(reports, period, {}, accounts, {includeCritical:true}).reportCoverage.complete, true);
  }
});

test('v2 report metadata, supported summary shapes and explicit truncation warnings fail closed', () => {
  for (const name of Object.keys(fixture(true))) {
    for (const key of ['ReportName','StartPeriod','EndPeriod','Currency','ReportBasis']) {
      const reports = fixture(true); reports[name].Header[key] = {bad:true};
      assert.equal(evaluateBooks(reports, period, {}, accounts, {includeCritical:true}).reports.find(row=>row.name===name).status, 'unavailable');
    }
    const reports = fixture(true), width = reports[name].Columns.Column.length;
    reports[name].Rows.Row.push({ColData:Array.from({length:width},(_,i)=>({value:i?'':'Unable to display more data. Please reduce the date range.'}))});
    assert.equal(evaluateBooks(reports, period, {}, accounts, {includeCritical:true}).reportCoverage.complete,false);
  }
});

test('a one-column profit and loss marked NoReportData is an explicit zero, not a missing report', () => {
  const { emptyProfitAndLoss, explicitZeroReport } = require('../src/modules/book-evidence');
  const empty = { Header: { ReportName: 'ProfitAndLoss', Option: [{ Name: 'NoReportData', Value: 'true' }] }, Columns: { Column: [{ ColTitle: '' }] }, Rows: { Row: [{ group: 'NetIncome', ColData: [{ value: 'PROFIT' }] }] } };
  assert.equal(emptyProfitAndLoss(empty), true);
  assert.equal(explicitZeroReport(empty, 3), true);
  assert.equal(emptyProfitAndLoss({ ...empty, Rows: { Row: [{ ColData: [{ value: '12.00' }] }] } }), false);
  assert.equal(emptyProfitAndLoss({ ...empty, Header: { ReportName: 'ProfitAndLoss', Option: [] } }), false);
  assert.equal(emptyProfitAndLoss({ ...empty, Header: { ...empty.Header, ReportName: 'BalanceSheet' } }), false);
});
