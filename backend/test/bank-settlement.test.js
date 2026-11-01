'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const moduleRoot = process.env.BF1_MODULE_ROOT || path.join(__dirname,'../src/modules');
const C = require(path.join(moduleRoot,'bank-settlement-contract'));
const { buildSettlementEvents, postingDate, DEFAULT_POLICY } = require(path.join(moduleRoot,'bank-settlement-engine'));
const history = JSON.parse(fs.readFileSync(process.env.BF1_FIXTURE || path.join(__dirname,'fixtures/bank-settlement-history.json'),'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const result = buildSettlementEvents(history);
const events = (entity,id,data = result) => data.events.filter(e => e.source.entity === entity && e.source.id === id);
function small() {
  const scope = clone(history.scope);
  return {scope,homeCurrency:'CAD',asOf:'2026-10-31',accounts:[
    {id:'b',type:'Bank',subtype:'Checking',currency:'CAD'},
    {id:'c',type:'Credit Card',subtype:'CreditCard',currency:'CAD'},
    {id:'u',type:'Other Current Asset',subtype:'UndepositedFunds',currency:'CAD'}],mirror:[],
    ledger:{scope,sourceId:'fixture-ledger',observedAt:'2026-11-01T00:00:00Z',expectedRowCount:0,rows:[]}};
}
function add(input,entity,record,legs) {
  input.mirror.push({scope:input.scope,entity,qboId:record.Id,record,observedAt:'2026-11-01T00:00:00Z'});
  for (const [accountId,amount] of legs) input.ledger.rows.push({accountId,entity,transactionId:record.Id,
    date:record.TxnDate || record.PaymentDate,type:entity,transactionCurrency:record.CurrencyRef?.value || 'CAD',
    homeAmountCents:amount,foreignTransactionAmountCents:amount,bankAccountAmountCents:amount,status:'unmarked'});
  input.ledger.expectedRowCount = input.ledger.rows.length;
  return record;
}
const currency = {value:'CAD'};
test('versioned contract and exact money reject rounding and unsafe integer values', () => {
  assert.equal(C.CONTRACT_VERSION,1);
  assert.equal(C.SETTLEMENT_CONTRACT.amountScale,2);
  assert.equal(C.minor('3423.49'),342349);
  assert.equal(C.minor(-775.5),-77550);
  assert.equal(C.minor('0.01'),1);
  for (const value of [0.1+0.2,'1.001','1e4',null,'900719925474099.99']) assert.throws(() => C.minor(value));
  assert.throws(() => C.sum([Number.MAX_SAFE_INTEGER,1]));
});
test('offline replay accounts for every one of the 3789 retained rows exactly once', () => {
  assert.equal(history.ledger.rows.length,3789);
  assert.equal(result.ledgerCrosswalk.length,3789);
  assert.equal(new Set(result.ledgerCrosswalk.map(r => r.rowIndex)).size,3789);
  assert.deepEqual(result.summary,{events:3784,resolvedEvents:3779,unresolvedEvents:5,retainedLedgerRows:3789,depositLinks:1385,undepositedReceipts:7});
  assert.equal(result.coverage.representedLedgerRows,3789);
  assert.equal(result.coverage.complete,false);
  assert.equal(result.coverage.nativeBankStateVerified,false);
  assert.equal(result.coverage.packageBlocked,true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
  for (const row of result.ledgerCrosswalk) {
    const native = history.ledger.rows[row.rowIndex];
    assert.equal(row.accountId,native.accountId);
    assert.equal(row.id,native.transactionId);
    if (row.eventId) {
      const e = result.events.find(e => e.eventId === row.eventId);
      assert.equal(e.bookAmountMinor,native.bankAccountAmountCents);
      assert.equal(e.source.ledgerRowIndex,row.rowIndex);
    }
  }
});
test('all 16 account-native totals retain the audit including unresolved postings', () => {
  const expected = {'1150040000':0,'1150040002':3000,'1150040005':12400,'1150040006':-10000,
    '1150040007':100000,'1150040008':0,'1150040011':0,'120':0,'121':0,'123':129956373,
    '53':0,'60':6729874,'66':854414,'68':500000,'85':30565,'90':0};
  for (const row of result.accountSummaries) assert.equal(row.nativeBookMovementMinor,expected[row.accountId],row.accountId);
  assert.equal(result.accountSummaries.length,16);
  assert.equal(result.provisionalRanges.filter(r=>r.evidenceType==='bank-or-card-statement').reduce((n,r)=>n+r.periods,0),324);
  assert.equal(result.provisionalRanges.filter(r=>r.evidenceType==='cash-count-or-cashbook').reduce((n,r)=>n+r.periods,0),116);
});
test('all 1385 receipt links are preserved and cannot produce a second settlement', () => {
  assert.equal(result.depositLinks.length,1385);
  assert.equal(new Set(result.depositLinks.map(l => l.receiptEntity+':'+l.receiptId)).size,1385);
  for (const link of result.depositLinks) {
    assert.equal(events(link.receiptEntity,link.receiptId).length,0);
    const deposit = events('Deposit',link.depositId)[0];
    assert.ok(deposit.source.depositLinks.some(l => l.receiptId === link.receiptId));
    assert.equal(deposit.status,'resolved');
  }
  const waiting = result.outstandingItems.filter(i=>i.kind==='undeposited-receipt');
  assert.equal(C.sum(waiting.map(i=>i.amountMinor)),852703);
  assert.ok(waiting.every(i=>i.expectedPostingDate===null));
});
test('Invoice 486 deposits only CAD50; Payment26 preserves proved CAD3423.49 from GBP2000', () => {
  const invoice = events('Invoice','486')[0], payment = events('Payment','26')[0];
  assert.equal(invoice.amountMinor,5000);
  assert.equal(invoice.kind,'invoice-deposit');
  assert.equal(payment.accountCurrency,'CAD');
  assert.equal(payment.amountMinor,342349);
  assert.equal(payment.source.foreignTransactionAmountMinor,200000);
  assert.equal(payment.source.transactionCurrency,'GBP');
  assert.equal(payment.source.nativeAmountBasis,'retained-account-native-ledger');
  assert.equal(payment.status,'resolved');
});
test('USD cash stays native -1100,+1130 while JE200 moves no AUD cash', () => {
  const usd = result.events.filter(e=>e.accountId==='1150040002');
  assert.deepEqual(usd.map(e=>e.amountMinor).sort((a,b)=>a-b),[-110000,113000]);
  assert.equal(C.sum(usd.map(e=>e.amountMinor)),3000);
  assert.equal(events('JournalEntry','200').length,0);
  const adjustment = result.nonSettlements.find(e=>e.entity==='JournalEntry'&&e.id==='200');
  assert.equal(adjustment.nativeAmountMinor,0);
  assert.equal(adjustment.homeAmountMinor,8684);
  assert.equal(adjustment.code,'revaluation-zero-native-cash');
});
test('483 and Transfers343/345 have two linked legs and explicit card debt signs', () => {
  for (const [entity,id,amount] of [['CreditCardPayment','483',10000],['Transfer','343',10000],['Transfer','345',30000]]) {
    const legs = events(entity,id);
    assert.equal(legs.length,2);
    assert.equal(C.sum(legs.map(e=>e.amountMinor)),0);
    assert.equal(legs[0].pairedEventId,legs[1].eventId);
    assert.equal(legs[1].pairedEventId,legs[0].eventId);
    assert.equal(legs[0].settlementGroupId,legs[1].settlementGroupId);
    assert.equal(legs.find(e=>e.cardDebtChangeMinor!==null).cardDebtChangeMinor,-amount);
    assert.ok(legs.every(e=>e.status==='resolved'));
  }
  const cardCharge = events('Purchase','490')[0];
  assert.equal(cardCharge.amountMinor,-22400);
  assert.equal(cardCharge.cardDebtChangeMinor,22400);
});
test('all TaxPayments including signed refund460 and zero576 retain their meaning', () => {
  const refund = events('TaxPayment','460')[0];
  assert.equal(refund.amountMinor,77550);
  assert.equal(refund.status,'resolved');
  assert.equal(events('TaxPayment','576').length,0);
  assert.equal(result.nonSettlements.filter(e=>e.entity==='Payment'&&e.code==='zero-native-movement').length,3);
  assert.equal(result.events.filter(e=>e.source.entity==='TaxPayment').length,12);
});
test('report-only adjustments are exact unresolved events and never balancing plugs', () => {
  assert.deepEqual(result.unresolvedEvents.map(e=>e.source.id).sort(),['91','93','94','97','98'].sort());
  assert.equal(C.sum(result.unresolvedEvents.map(e=>e.bookAmountMinor)),305000);
  for (const e of result.unresolvedEvents) {
    assert.equal(e.kind,'report-only-adjustment');
    assert.equal(e.resolution.action,'investigate');
    assert.equal(e.resolution.reason.code,'report-only-adjustment-economic-meaning-unclassified');
    assert.equal(e.accountId,'60');
    assert.ok(e.source.ledgerSourceId);
  }
});
test('native R/C marks preserve evidence without attesting bank matching or reconciliation', () => {
  assert.equal(result.events.filter(e=>e.source.nativeStatus==='R').length,13);
  assert.equal(result.events.filter(e=>e.source.nativeStatus==='C').length,20);
  assert.ok(result.events.every(e=>!e.resolution.nativeMatchVerified));
  assert.equal(result.coverage.complete,false);
  assert.ok(result.events.filter(e=>e.source.nativeStatus==='R').every(e=>e.resolution.nativeInspectionRequired && e.resolution.nativeActionBlockers.length===1));
});
test('direct receipt, net deposit fees, refunds, card credit and bank/card bill payments', () => {
  const input = small();
  add(input,'Payment',{Id:'p',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[['b',1000]]);
  add(input,'SalesReceipt',{Id:'s',TxnDate:'2026-10-30',TotalAmt:20,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[]);
  add(input,'Deposit',{Id:'d',TxnDate:'2026-10-30',TotalAmt:19,CurrencyRef:currency,DepositToAccountRef:{value:'b'},Line:[
    {Id:'receipt',Amount:20,LinkedTxn:[{TxnType:'SalesReceipt',TxnId:'s'}]},
    {Id:'fee',Amount:-1,DepositLineDetail:{AccountRef:{value:'fee-expense'}}}]},[['b',1900]]);
  add(input,'RefundReceipt',{Id:'r',TxnDate:'2026-10-30',TotalAmt:5,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[['b',-500]]);
  add(input,'Purchase',{Id:'credit',TxnDate:'2026-10-30',TotalAmt:2,CurrencyRef:currency,AccountRef:{value:'c'},Credit:true},[['c',-200]]);
  add(input,'BillPayment',{Id:'bp',TxnDate:'2026-10-30',TotalAmt:3,CurrencyRef:currency,CheckPayment:{BankAccountRef:{value:'b'}}},[['b',-300]]);
  add(input,'BillPayment',{Id:'cc',TxnDate:'2026-10-30',TotalAmt:4,CurrencyRef:currency,CreditCardPayment:{CCAccountRef:{value:'c'}}},[['c',400]]);
  const out = buildSettlementEvents(input);
  assert.equal(out.unresolvedEvents.length,0);
  assert.equal(events('SalesReceipt','s',out).length,0);
  assert.equal(events('Payment','p',out)[0].amountMinor,1000);
  assert.equal(events('Deposit','d',out)[0].amountMinor,1900);
  assert.deepEqual(events('Deposit','d',out)[0].source.depositBreakdown.map(l=>l.amountMinor),[2000,-100]);
  assert.equal(events('RefundReceipt','r',out)[0].amountMinor,-500);
  assert.equal(events('Purchase','credit',out)[0].amountMinor,200);
  assert.equal(events('BillPayment','cc',out)[0].amountMinor,-400);
});
test('deposit links override changed receipt account refs; ambiguous allocations block the deposit', () => {
  const input = small();
  add(input,'Payment',{Id:'p',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[]);
  add(input,'Deposit',{Id:'d',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'},Line:[{Amount:10,LinkedTxn:[{TxnType:'Payment',TxnId:'p'}]}]},[['b',1000]]);
  let out = buildSettlementEvents(input);
  assert.equal(events('Payment','p',out).length,0);
  assert.equal(out.events.length,1);
  input.mirror[1].record.Line[0].LinkedTxn.push({TxnType:'Payment',TxnId:'missing'});
  out = buildSettlementEvents(input);
  assert.equal(events('Deposit','d',out)[0].status,'unresolved');
  assert.equal(events('Deposit','d',out)[0].resolution.reason.code,'deposit-link-evidence-invalid');
});
test('unknown FX cannot fall back to a home amount or transaction total', () => {
  const input = small(); input.accounts[0].currency='USD';
  add(input,'Payment',{Id:'fx',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[['b',null]]);
  const out = buildSettlementEvents(input), event = out.events[0];
  assert.equal(event.amountMinor,null);
  assert.equal(event.bookAmountMinor,null);
  assert.equal(event.status,'unresolved');
  assert.equal(event.resolution.reason.code,'account-native-currency-allocation-unknown');
  assert.equal(out.accountSummaries.find(a=>a.accountId==='b').nativeBookMovementMinor,null);
  assert.equal(out.coverage.packageBlocked,true);
});
test('cross-currency transfer preserves two proved native amounts without new conversion', () => {
  const input = small(); input.accounts[1]={id:'c',type:'Bank',subtype:'Checking',currency:'USD'};
  add(input,'Transfer',{Id:'fx',TxnDate:'2026-10-30',Amount:130,CurrencyRef:currency,FromAccountRef:{value:'b'},ToAccountRef:{value:'c'}},[['b',-13000],['c',10000]]);
  const out = buildSettlementEvents(input), legs = events('Transfer','fx',out);
  assert.equal(out.unresolvedEvents.length,0);
  assert.deepEqual(legs.map(e=>[e.accountCurrency,e.amountMinor]).sort(),[['CAD',-13000],['USD',10000]]);
  input.ledger.rows.pop(); input.ledger.expectedRowCount=1;
  const incomplete = buildSettlementEvents(input);
  assert.ok(incomplete.events.every(e=>e.status==='unresolved'));
  assert.ok(incomplete.events.every(e=>e.resolution.reason.code==='paired-settlement-unproved'));
});
test('mirror alone, missing native money, missing account currency and unknown report types never claim coverage', () => {
  const input = small();
  add(input,'Payment',{Id:'p',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[['b',1000]]);
  delete input.ledger;
  let out = buildSettlementEvents(input);
  assert.equal(out.events[0].resolution.reason.code,'native-ledger-evidence-missing');
  assert.equal(out.coverage.mirrorAloneProvesCoverage,false);
  assert.equal(out.coverage.packageBlocked,true);
  const missing = small(); missing.accounts[0].currency=null;
  add(missing,'UnknownFinancialSource',{Id:'x',TxnDate:'2026-10-30'},[['b',4200]]);
  out = buildSettlementEvents(missing);
  assert.equal(out.events[0].status,'unresolved');
  assert.equal(out.events[0].accountCurrency,null);
  assert.equal(out.ledgerCrosswalk.length,1);
});
test('journal cash economic meaning needs separate evidence; known revaluation remains excluded', () => {
  const input = small();
  add(input,'JournalEntry',{Id:'j',TxnDate:'2026-10-30',CurrencyRef:currency,TotalAmt:999,
    Line:[{Id:'1',Amount:1,JournalEntryLineDetail:{AccountRef:{value:'b'},PostingType:'Credit'}},
      {Id:'2',Amount:1,JournalEntryLineDetail:{AccountRef:{value:'fee'},PostingType:'Debit'}}]},[['b',-100]]);
  assert.equal(buildSettlementEvents(input).events[0].resolution.reason.code,'journal-economic-meaning-unclassified');
  input.ledger.rows[0].economicMeaning={kind:'bank-fee',evidenceRef:'retained-bank-advice'};
  const event = buildSettlementEvents(input).events[0];
  assert.equal(event.status,'resolved'); assert.equal(event.amountMinor,-100);
});
test('deterministic posting schedule carries cheques and deposits beyond period end', () => {
  const input = small();
  add(input,'BillPayment',{Id:'check',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,CheckPayment:{BankAccountRef:{value:'b'}}},[['b',-1000]]);
  add(input,'Deposit',{Id:'dep',TxnDate:'2026-10-30',TotalAmt:20,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[['b',2000]]);
  const out = buildSettlementEvents(input), check = events('BillPayment','check',out)[0];
  assert.equal(check.expectedPostingDate,'2026-11-06');
  assert.equal(postingDate('2026-10-31',1,DEFAULT_POLICY),'2026-11-02');
  assert.equal(postingDate('2026-10-31',0,DEFAULT_POLICY),'2026-11-02');
  assert.equal(postingDate('2026-10-30',0,DEFAULT_POLICY),'2026-10-30');
  assert.equal(check.actualPostingDate,null);
  assert.equal(check.statementPeriod,'2026-11');
  assert.equal(check.postingBasis,'simulated-policy');
  assert.equal(out.outstandingItems.length,2);
  assert.equal(postingDate('2026-10-30',1,{...DEFAULT_POLICY,holidays:['2026-11-02']}),'2026-11-03');
  input.ledger.rows[0].actualPostingDate='2026-10-31';
  assert.equal(buildSettlementEvents(input).events.find(e=>e.source.id==='check').resolution.reason.code,'actual-posting-evidence-missing');
  input.ledger.rows[0].actualPostingEvidenceRef='simulated-bank-posting-receipt';
  assert.equal(buildSettlementEvents(input).outstandingItems.length,1);
});
test('source revisions keep stable identity, pairing and hash separate from SyncToken', () => {
  const input = small();
  add(input,'Payment',{Id:'p',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'},SyncToken:'0'},[['b',1000]]);
  const initial = buildSettlementEvents(input).events[0];
  input.priorEvents=[initial];
  assert.equal(buildSettlementEvents(input).events[0].revision,1);
  input.mirror[0].record.SyncToken='1';
  let changed = buildSettlementEvents(input).events[0];
  assert.equal(changed.eventId,initial.eventId);
  assert.notEqual(changed.source.sourceHash,initial.source.sourceHash);
  assert.equal(changed.revision,2);
  input.mirror[0].record.SyncToken='0'; input.policy={electronicLagDays:2};
  changed = buildSettlementEvents(input).events[0];
  assert.equal(changed.eventId,initial.eventId); assert.equal(changed.revision,2);
});
test('scope, duplicate ledger/source identities and malformed exact amounts fail closed', () => {
  const input = small();
  add(input,'Payment',{Id:'p',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,DepositToAccountRef:{value:'b'}},[['b',1000]]);
  for (const target of ['mirror','ledger','row','account']) {
    const bad = clone(input), foreign = {...input.scope,realmId:'another-company'};
    if (target==='mirror') bad.mirror[0].scope=foreign;
    if (target==='ledger') bad.ledger.scope=foreign;
    if (target==='row') bad.ledger.rows[0].scope=foreign;
    if (target==='account') bad.accounts[0].scope=foreign;
    assert.throws(()=>buildSettlementEvents(bad),/scope/);
  }
  const duplicate=clone(input); duplicate.ledger.rows.push(clone(duplicate.ledger.rows[0]));
  assert.throws(()=>buildSettlementEvents(duplicate),/Ambiguous repeated/);
  const duplicatedSource=clone(input); duplicatedSource.mirror.push(clone(duplicatedSource.mirror[0]));
  assert.throws(()=>buildSettlementEvents(duplicatedSource),/Duplicate mirrored/);
  input.ledger.rows[0].bankAccountAmountCents=1.1;
  assert.throws(()=>buildSettlementEvents(input),/safe integer/);
});
test('input is unchanged by replay and event identities survive report row reordering', () => {
  const input = clone(history), original = C.hash(input);
  const initial = buildSettlementEvents(input);
  assert.equal(C.hash(input),original);
  input.ledger.rows.reverse();
  const reordered = buildSettlementEvents(input);
  assert.deepEqual(reordered.events.map(e=>[e.eventId,e.source.sourceHash,e.amountMinor]),initial.events.map(e=>[e.eventId,e.source.sourceHash,e.amountMinor]));
});

test('an orphan receipt backlink blocks direct settlement until the deposit is proved', () => {
  const input = small();
  add(input,'Payment',{Id:'p',TxnDate:'2026-10-30',TotalAmt:10,CurrencyRef:currency,
    DepositToAccountRef:{value:'b'},LinkedTxn:[{TxnType:'Deposit',TxnId:'not-synced'}]},[['b',1000]]);
  const out = buildSettlementEvents(input);
  assert.equal(out.events[0].status,'unresolved');
  assert.equal(out.events[0].resolution.reason.code,'receipt-deposit-backlink-unproved');
  assert.equal(out.coverage.packageBlocked,true);
});
