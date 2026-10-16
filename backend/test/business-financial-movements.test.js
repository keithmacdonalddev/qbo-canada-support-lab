'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope } = require('./helpers/business-governance-fixture');
const { hash, canonical } = require('../src/modules/business-calendar');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { KEYS, balances, createFinancialExpectation, movementRow, compareFinancialMovements, assertMovementCapacity } = require('../src/modules/business-financial-movements');
const period = { fromDate: '2026-10-01', throughDate: '2026-10-31' };
function state(values = {}) {
  const h = fixture(), source = h.reportSources(period), all = { ...Object.fromEntries(KEYS.map(key => [key, 0])), ...values };
  const row = (id, n) => ({ type: 'Data', ColData: [{ id, value: 'Account ' + id }, { value: (Math.max(0, n) / 100).toFixed(2) }, { value: (Math.max(0, -n) / 100).toFixed(2) }] });
  const rows = KEYS.map(key => row(h.mappings[key], all[key])); rows.push(row('972', -Object.values(all).reduce((a,b) => a+b,0)));
  const total = side => rows.reduce((n,r) => n + Math.round(Number(r.ColData[side].value)*100),0);
  rows.push({ group: 'GrandTotal', Summary: { ColData: [{value:'TOTAL'}, {value:(total(1)/100).toFixed(2)}, {value:(total(2)/100).toFixed(2)}] } });
  source.reports.TrialBalance.Rows.Row = rows;
  const { sourceHash, ...raw } = source; source.sourceHash = hash(raw);
  return { h, source, expectation: createFinancialExpectation(scope, period, h.mappings, source) };
}
test('exact-ID trial balances preserve negative debit balances, omitted zeros and reordered unique columns', () => {
  const { source, expectation } = state({ operatingBank: -120000, accountsReceivable: -30000, accountsPayable: 50000 });
  assert.deepEqual(expectation.opening, {operatingBank:-120000,undepositedFunds:0,accountsReceivable:-30000,accountsPayable:50000});
  const report = structuredClone(source.reports.TrialBalance); report.Rows.Row = report.Rows.Row.filter(row=>row.ColData?.[0].id!==expectation.accounts[1].id);
  report.Columns.Column = [report.Columns.Column[2], report.Columns.Column[0], report.Columns.Column[1]];
  for(const row of report.Rows.Row){const cells=row.ColData||row.Summary.ColData;const moved=[cells[2],cells[0],cells[1]];if(row.ColData)row.ColData=moved;else row.Summary.ColData=moved;}
  assert.deepEqual(balances(report,source.accounts,expectation.accounts,period),expectation.opening);
  const observed = structuredClone(source); observed.accounts.find(row=>row.Id===expectation.accounts[0].id).CurrentBalance=999999;
  assert.equal(compareFinancialMovements(expectation,[],observed).status,'passed','present CurrentBalance is not a historical balance or approved definition');
});
test('balanced-but-incomplete, duplicate, unknown, filtered, grouped and wrong-scope TB layouts cannot invent zero', () => {
  const { source, expectation }=state({operatingBank:10000});
  for(const mutate of [
    r=>{r.Columns.Column[2].ColTitle='Debit';},
    r=>{const total=r.Rows.Row.at(-1).Summary.ColData;total[1].value='101.00';total[2].value='101.00';},
    r=>{r.Rows.Row[0].ColData[0].id='99999';},
    r=>{r.Rows.Row[1].ColData[0].id=r.Rows.Row[0].ColData[0].id;},
    r=>{r.Header.Customer='1';},
    r=>{r.Header.Account='1';},
    r=>{r.Header.Option=[{Name:'Account',Value:'1'}];},
    r=>{r.Header.Option=[{Name:'UnknownFilter',Value:'1'}];},
    r=>{r.Header.SummarizeColumnsBy='Customers';},
    r=>{r.Columns.Column[1].Columns={Column:[]};},
    r=>{r.Rows.Row.unshift({Header:{ColData:[{id:expectation.accounts[1].id,value:'Grouped funds'}]}});},
    r=>{r.Header.Currency='USD';},
    r=>{r.Header.EndPeriod='2026-10-30';}
  ]){const report=structuredClone(source.reports.TrialBalance);mutate(report);assert.throws(()=>balances(report,source.accounts,expectation.accounts,period));const observed=structuredClone(source);observed.reports.TrialBalance=report;assert.equal(compareFinancialMovements(expectation,[],observed).status,'unavailable');}
});
test('comparison independently detects a wrong bank, holding, receivable or payable even when the TB balances', () => {
  const {expectation}=state({operatingBank:100000});
  const basis=[{postings:{operatingBank:-11300,undepositedFunds:6780,accountsReceivable:4520,accountsPayable:-22600}}];
  const expected={operatingBank:88700,undepositedFunds:6780,accountsReceivable:4520,accountsPayable:-22600};
  assert.equal(compareFinancialMovements(expectation,basis,state(expected).source).status,'passed');
  for(const key of KEYS){const wrong=state({...expected,[key]:expected[key]+1}).source,check=compareFinancialMovements(expectation,basis,wrong);assert.equal(check.status,'failed');assert.equal(check.checks.find(row=>row.key===key).differenceCents,1);}
});
function artifact(entity, payload, extra={}) {
  const {h,expectation}=state(), logicalKey=hash(entity), step={entity,logicalKey,txnDate:'2026-10-01',details:{amountSourceKey:hash('prior-payment')},references:expectation.accounts.map(row=>({entity:'Account',key:row.key,id:row.id,definition:{version:1,hash:row.definitionHash}}))};
  const policy={version:1,status:'approved',scope,country:'CA',currency:'CAD',stepHash:hash(step),tax:{calculation:'TaxExcluded',salesTax:h.mappings.salesTax,purchaseTax:h.mappings.purchaseTax},readbackTax:{version:1,totalTaxCents:1300,lines:[{rateId:'950',percent:13,taxableCents:10000,amountCents:1300}]}};
  const base={version:1,logicalKey,entity,intentHash:hash(step),request:freezeWriteRequest(scope,'POST',entity.toLowerCase(),{TxnDate:'2026-10-01',...(entity==='TimeActivity'?{}:{CurrencyRef:{value:'CAD'}}),...payload}),evidenceHash:hash('observations'),relationships:extra.relationships||[]};
  const compiled={...base,compilationHash:hash(base)};
  return {h,expectation,step,policy,compiled,origin:{policyHash:hash(policy)}};
}
const calculate=x=>movementRow(x.expectation,x.step,x.compiled,x.policy,x.origin).postings;
test('original creates have independently specified gross, installment, supplier and zero-effect movements', () => {
  const {h}=state(), ref=value=>({value}), line=key=>({Amount:100,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{TaxCodeRef:ref(h.mappings[key])}});
  assert.deepEqual(calculate(artifact('Invoice',{GlobalTaxCalculation:'TaxExcluded',ARAccountRef:ref(h.mappings.accountsReceivable),Line:[line('salesTax')]})),{operatingBank:0,undepositedFunds:0,accountsReceivable:11300,accountsPayable:0});
  assert.deepEqual(calculate(artifact('SalesReceipt',{GlobalTaxCalculation:'TaxExcluded',DepositToAccountRef:ref(h.mappings.operatingBank),Line:[line('salesTax')]})),{operatingBank:11300,undepositedFunds:0,accountsReceivable:0,accountsPayable:0});
  const bill={Amount:100,DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{TaxCodeRef:ref(h.mappings.purchaseTax),AccountRef:ref(h.mappings.operatingExpense),BillableStatus:'NotBillable'}};
  assert.deepEqual(calculate(artifact('Bill',{GlobalTaxCalculation:'TaxExcluded',APAccountRef:ref(h.mappings.accountsPayable),Line:[bill]})),{operatingBank:0,undepositedFunds:0,accountsReceivable:0,accountsPayable:-11300});
  assert.deepEqual(calculate(artifact('Payment',{TotalAmt:67.8,ARAccountRef:ref(h.mappings.accountsReceivable),DepositToAccountRef:ref(h.mappings.undepositedFunds),Line:[{Amount:67.8,LinkedTxn:[{TxnType:'Invoice',TxnId:'900'}]}]})),{operatingBank:0,undepositedFunds:6780,accountsReceivable:-6780,accountsPayable:0});
  assert.deepEqual(calculate(artifact('BillPayment',{TotalAmt:113,PayType:'Check',APAccountRef:ref(h.mappings.accountsPayable),CheckPayment:{BankAccountRef:ref(h.mappings.operatingBank)},Line:[{Amount:113,LinkedTxn:[{TxnType:'Bill',TxnId:'900'}]}]})),{operatingBank:-11300,undepositedFunds:0,accountsReceivable:0,accountsPayable:11300});
  for(const entity of ['Estimate','PurchaseOrder','TimeActivity'])assert.deepEqual(calculate(artifact(entity,{})),{operatingBank:0,undepositedFunds:0,accountsReceivable:0,accountsPayable:0});
});
test('Deposit uses exact linked line cents and original undeposited origin, with no fabricated TotalAmt', () => {
  const {h}=state(), x=artifact('Deposit',{DepositToAccountRef:{value:h.mappings.operatingBank},Line:[{Amount:67.8,LinkedTxn:[{TxnType:'Payment',TxnId:'900'}]}]},{relationships:[{logicalKey:hash('prior-payment'),entity:'Payment',qboId:'900',syncToken:'0',fingerprint:hash('parent'),kind:'linked',links:[{path:'Line.0.LinkedTxn'}]}]});
  assert.equal(JSON.parse(x.compiled.request.body).TotalAmt,undefined);
  assert.deepEqual(calculate(x),{operatingBank:6780,undepositedFunds:-6780,accountsReceivable:0,accountsPayable:0});
  x.origin.policyHash=hash('different');assert.throws(()=>calculate(x),/original managed intent/);
});
test('compact financial proof capacity is bounded before creates and independent of shared tax-history size', () => {
  const {expectation}=state(), base={financialExpectation:expectation,records:Array.from({length:500},()=>({kind:'create',relationships:[]}))};
  const small=assertMovementCapacity(base);assert.ok(small<5500000);
  base.unrelatedTaxHistory='x'.repeat(7000000);assert.equal(assertMovementCapacity(base),small,'full shared tax histories are never copied to normalized period basis');
  assert.throws(()=>assertMovementCapacity({...base,records:Array.from({length:1000},()=>({kind:'create',relationships:Array(20).fill(hash('parent'))}))}),/shorter period/);
});

test('an explicit empty zero report uses the complete observed account definitions without inventing totals',()=>{
 const {source,expectation}=state();
 source.reports.TrialBalance.Rows.Row=[];source.reports.TrialBalance.Header.Option=[{Name:'NoReportData',Value:'true'}];
 assert.deepEqual(balances(source.reports.TrialBalance,source.accounts,expectation.accounts,period),Object.fromEntries(KEYS.map(key=>[key,0])));
 delete source.reports.TrialBalance.Header.Option;assert.throws(()=>balances(source.reports.TrialBalance,source.accounts,expectation.accounts,period));
});

test('reordered explicit-empty sections cannot hide a nonzero debit in the label position used by older zero checks',()=>{
 const {source,expectation}=state(),tb=source.reports.TrialBalance;
 tb.Header.Option=[{Name:'NoReportData',Value:'true'}];tb.Columns.Column=[{ColTitle:'Debit'},{ColTitle:'Account'},{ColTitle:'Credit'}];tb.Rows.Row=[{group:'GrandTotal',Summary:{ColData:[{value:'0.00'},{value:'TOTAL'},{value:'0.00'}]}}];
 assert.deepEqual(balances(tb,source.accounts,expectation.accounts,period),Object.fromEntries(KEYS.map(key=>[key,0])));
 tb.Rows.Row[0].Summary.ColData[0].value='100.00';assert.throws(()=>balances(tb,source.accounts,expectation.accounts,period),/detail does not reconcile/);
});
test('a selected parent with an explicit unambiguous direct row remains supported; its omitted balance cannot be guessed',()=>{
 const {source,expectation}=state(),tb=source.reports.TrialBalance;
 source.accounts.push({Id:'973',SyncToken:'0',Active:false,AccountType:'Bank',Name:'Unused inactive child',ParentRef:{value:expectation.accounts[0].id},CurrencyRef:{value:'CAD'}});
 assert.equal(compareFinancialMovements(expectation,[],source).status,'passed');
 tb.Rows.Row=tb.Rows.Row.filter(row=>row.ColData?.[0].id!==expectation.accounts[0].id);
 assert.equal(compareFinancialMovements(expectation,[],source).status,'unavailable');
});

test('fresh source BSON overhead is admitted with the worst complete proof before creates', () => {
 const {expectation}=state(),manifest={financialExpectation:expectation,records:Array.from({length:500},()=>({kind:'create',relationships:[]}))};
 assert.doesNotThrow(()=>assertMovementCapacity(manifest,{accounts:[{metadata:[0,0]}]}));
 const source={accounts:[{metadata:Array(1300000).fill(0)}]}; assert.ok(Buffer.byteLength(canonical(source))<6000000);
 assert.throws(()=>assertMovementCapacity(manifest,source),/BSON storage budget/);
});
