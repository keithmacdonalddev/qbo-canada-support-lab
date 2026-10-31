'use strict';
// Financial shapes are sanitized CompanySyncRecord observations (ids preserved).
// A private export can replace them to replay the exact raw stored records offline.
// Ledger expectations below are explicit arithmetic fixtures, NOT native report proof.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.QBO_JOB_F_REPLAY_FILE || require.resolve('./fixtures/foreign-currency-native.json'), 'utf8'));
const { createGeneralWriteService, createGeneralWriteContext } = require('../src/modules/general-write-service');
const { createRateReader, observedRate, homeCents, currencyProblems, preservesCurrency } = require('../src/modules/general-write-currency');
const { postingsOf, compareLedger } = require('../src/modules/general-write-postings');
const { matchesSavedRequest } = require('../src/modules/general-write-recovery');
const { closeGeneralDay } = require('../src/modules/general-write-day-close');
const { entitySchema } = require('../src/modules/qbo-entity-schema');
const { hash } = require('../src/modules/business-calendar');
const DAY = '2026-10-31', scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const bound = { scope, ownerId: 'b'.repeat(24), actorId: 'b'.repeat(24) };
const query = value => ({ select() { return this; }, session() { return this; }, sort() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => structuredClone(value) });
const sourceRecords = () => new Map(fixture.records.map(row => [row.entity + ':' + row.qboId, structuredClone(row.record)]));
function context(records) {
 const accounts = [...records].filter(([key]) => key.startsWith('Account:')).map(([, row]) => row);
 return { get: (entity, id) => records.get(entity + ':' + id), receivables: '63', payables: '59', undepositedFunds: '5', exchangeGainLoss: '73',
  currencyAccount: (type, code) => { const hits = accounts.filter(row => row.AccountType === type && (row.CurrencyRef?.value || 'CAD') === code); assert.equal(hits.length, 1); return hits[0].Id; },
  taxAccount: () => '58' };
}
function harness(t, readRate = async (s, currency, day) => ({ SourceCurrencyCode: currency, TargetCurrencyCode: 'CAD', AsOfDate: day, Rate: ({ USD: 1.4, GBP: 1.7, EUR: 1.6, AUD: 0.9 })[currency] || 0.2 })) {
 const records = sourceRecords(), rows = new Map(); let sends = 0;
 t.mock.method(require('../src/modules/business-authority'), 'readPublishedBusiness', async () => ({ view: { mappings: { salesTax: '16', purchaseTax: '16' }, business: {} } }));
 const Runs = { findOne: filter => query(filter._id ? rows.get(filter._id) || null : null),
  create: async input => { for (const row of input) rows.set(row._id, { items: {}, batches: [], owned: [], dirty: [], revision: 0, ...structuredClone(row) }); },
  findOneAndUpdate: (filter, update) => { const row = rows.get(filter._id); if (!row || row.revision !== filter.revision) return query(null); Object.assign(row, structuredClone(update.$set)); row.revision++; return query(row); } };
 const models = { GeneralWriteRuns: Runs, Steps: { findOne: () => query(null) }, Calendars: { findOne: () => query({ verifiedThrough: '2026-10-30' }) }, Policies: { findOne: () => query({ periodControl: {} }) },
  Records: { find: () => query([...records].filter(([key]) => /^(Account|Preferences):/.test(key)).map(([key, record]) => ({ entity: key.split(':')[0], qboId: record.Id, record }))) } };
 const now = () => Date.parse(DAY + 'T20:00:00Z');
 const contextFor = createGeneralWriteContext({ models, now, readRate });
 const copy = { read: async (s, entity, id) => structuredClone(records.get(entity + ':' + id) || null) };
 const transport = { sendBatch: async () => { sends++; throw new Error('A replay may not send.'); } };
 const api = createGeneralWriteService({ models, copy, contextFor, now, dispatchEnabled: () => true, transport });
 return { api, records, rows, models, contextFor, copy, transport, sends: () => sends };
}
const proposal = (decisionKey, operations) => ({ decisionKey, purpose: 'Exercise governed foreign-currency accounting offline.', operations });
const ref = value => ({ value });
function invoice() { return { ref: 'invoice', op: 'create', entity: 'Invoice', payload: { CustomerRef: ref('41'), TxnDate: DAY, CurrencyRef: ref('USD'), GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: ref('26'), Qty: 1, UnitPrice: 100, TaxCodeRef: ref('16') } }] } }; }
const messages = result => (result.problems || []).map(row => row.message).join(' | ');
test('synced Preferences 1 already enables multicurrency with CAD home currency', () => {
 assert.deepEqual(sourceRecords().get('Preferences:1').CurrencyPrefs, { MultiCurrencyEnabled: true, HomeCurrency: { value: 'CAD' } });
 assert.equal(entitySchema('Exchangerate').readOnly, true);
 for (const entity of ['Invoice', 'Bill', 'Payment', 'BillPayment', 'Deposit', 'Transfer']) assert.ok(entitySchema(entity).optional.includes('ExchangeRate'));
});
test('real foreign parties pass the actual preparation/context path without transport', async t => {
 const h = harness(t);
 for (const [entity, id] of [['Customer', '15'], ['Customer', '41'], ['Vendor', '16'], ['Vendor', '69']]) {
  const result = await h.api.prepare(bound, proposal('native-party-' + entity + id, [{ ref: 'party', entity, id, op: 'update', payload: { Active: true }, reason: 'Replay existing foreign party maintenance offline.' }]));
  assert.equal(result.status, 'prepared', messages(result));
 }
 assert.equal(h.sends(), 0);
});
test('new foreign invoice defaults to observed dated Exchangerate and caps exposure in CAD', async t => {
 const h = harness(t), op = invoice(), prepared = await h.api.prepare(bound, proposal('observed-usd-invoice', [op]));
 assert.equal(prepared.status, 'prepared', messages(prepared));
 const saved = h.rows.get(prepared.runId);
 assert.equal(saved.plan.operations[0].payload.ExchangeRate, 1.4);
 assert.equal(saved.plan.currencyEvidence.rates['USD:' + DAY].TargetCurrencyCode, 'CAD');
 assert.equal(saved.plan.exposureCents, 15960); assert.equal(op.payload.ExchangeRate, undefined);
 const large = invoice(); large.payload.Line[0].Amount = 40000;
 assert.match(messages(await h.api.prepare(bound, proposal('usd-home-cap', [large]))), /at most [$]50000/);
});
test('new party then invoice and linked settlement retain dependency order', async t => {
 const h = harness(t), op = invoice(); op.payload.CustomerRef = { value: { $ref: 'party' } };
 const pay = { ref: 'payment', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: { $ref: 'party' } }, CurrencyRef: ref('USD'), TotalAmt: 114, DepositToAccountRef: ref('1150040002'), Line: [{ Amount: 114, LinkedTxn: [{ TxnId: { $ref: 'invoice' }, TxnType: 'Invoice' }] }] } };
 const result = await h.api.prepare(bound, proposal('usd-linked-chain', [{ ref: 'party', op: 'create', entity: 'Customer', payload: { DisplayName: 'Offline USD customer', CurrencyRef: ref('USD') } }, op, pay]));
 assert.equal(result.status, 'prepared', messages(result)); assert.deepEqual(h.rows.get(result.runId).plan.layers, [['party'], ['invoice'], ['payment']]);
});
test('currency, rate, party, control, bank and settings substitutions are refused before sending', async t => {
 const h = harness(t);
 for (const [key, mutate, pattern] of [
  ['bad-rate', op => { op.payload.ExchangeRate = 0.7; }, /must match the observed/],
  ['bad-party', op => { op.payload.CustomerRef = ref('15'); }, /CustomerRef currency/],
  ['bad-control', op => { op.payload.ARAccountRef = ref('69'); }, /ARAccountRef currency/],
  ['unknown-currency', op => { op.payload.CurrencyRef = ref('ZZZ'); }, /not already used/],
  ['bad-shape', op => { op.payload.CurrencyRef = null; }, /non-null reference/],
 ]) { const op = invoice(); mutate(op); const result = await h.api.prepare(bound, proposal('refuse-' + key, [op])); assert.equal(result.status, 'refused', key); assert.match(messages(result), pattern); }
 for (const value of [null, {}, { value: 'CAD' }, { value: 'usd' }, { value: 'USD', $ref: 'x' }]) {
  const result = await h.api.prepare(bound, proposal('immutable-party-' + JSON.stringify(value).length, [{ ref: 'party', op: 'update', entity: 'Customer', id: '41', reason: 'Test currency preservation without a live write.', payload: { CurrencyRef: value } }]));
  assert.equal(result.status, 'refused');
 }
 const prefs = await h.api.prepare(bound, proposal('no-currency-settings', [{ ref: 'prefs', op: 'update', entity: 'Preferences', id: '1', reason: 'This forbidden setting must stay unchanged.', payload: { CurrencyPrefs: { MultiCurrencyEnabled: false } } }]));
 assert.equal(prefs.status, 'refused'); assert.equal(h.sends(), 0);
});
test('foreign vendor bills, bill payments, bank deposits and CAD/foreign transfers prepare', async t => {
 const h = harness(t), bill = { ref: 'bill', op: 'create', entity: 'Bill', payload: { TxnDate: DAY, VendorRef: ref('69'), CurrencyRef: ref('USD'), GlobalTaxCalculation: 'TaxExcluded', Line: [{ Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: ref('51'), TaxCodeRef: ref('16') } }] } };
 // Use a real expense account from the mirror, rather than a fabricated id.
 bill.payload.Line[0].AccountBasedExpenseLineDetail.AccountRef = h.records.get('Bill:24').Line[0].AccountBasedExpenseLineDetail.AccountRef;
 const payment = { ref: 'paid', op: 'create', entity: 'BillPayment', payload: { TxnDate: DAY, VendorRef: ref('69'), CurrencyRef: ref('USD'), TotalAmt: 10, PayType: 'Check', CheckPayment: { BankAccountRef: ref('60') }, Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '547', TxnType: 'Bill' }] }] } };
 const deposit = { ref: 'deposit', op: 'create', entity: 'Deposit', payload: { TxnDate: DAY, CurrencyRef: ref('AUD'), DepositToAccountRef: ref('68'), Line: structuredClone(h.records.get('Deposit:21').Line) } };
 const transfer = { ref: 'transfer', op: 'create', entity: 'Transfer', payload: { TxnDate: DAY, CurrencyRef: ref('USD'), FromAccountRef: ref('60'), ToAccountRef: ref('1150040002'), Amount: 100 } };
 for (const op of [bill, payment, deposit, transfer]) { const result = await h.api.prepare(bound, proposal('foreign-' + op.entity, [op])); assert.equal(result.status, 'prepared', messages(result)); }
 const bad = structuredClone(deposit); bad.payload.Line[0].DepositLineDetail.AccountRef = ref('71');
 assert.equal((await h.api.prepare(bound, proposal('second-foreign-account', [bad]))).status, 'refused');
 const purchase = { ref: 'purchase', op: 'create', entity: 'Purchase', payload: { TxnDate: DAY, PaymentType: 'Cash', AccountRef: ref('60'), EntityRef: { type: 'Vendor', value: '69' }, GlobalTaxCalculation: 'TaxExcluded', Line: bill.payload.Line } };
 assert.match(messages(await h.api.prepare(bound, proposal('cad-purchase-usd-vendor', [purchase]))), /currency must match/);
});
test('original stored foreign records replay CAD postings and explicit realized FX arithmetic', () => {
 const records = sourceRecords(), ctx = context(records);
 const checks = [['Invoice','22',{69:342853, [records.get('Item:1').IncomeAccountRef.value]:-342853}], ['Bill','24',{71:-156055, [records.get('Bill:24').Line[0].AccountBasedExpenseLineDetail.AccountRef.value]:156055}], ['Payment','26',{69:-342853,60:342349,73:504}], ['BillPayment','27',{71:156055,60:-163259,73:7204}], ['Deposit','21',{68:436558, [records.get('Deposit:21').Line[0].DepositLineDetail.AccountRef.value]:-436558}]];
 for (const [entity,id,expected] of checks) {
  const got = postingsOf(entity, records.get(entity + ':' + id), ctx);
  assert.deepEqual(Object.fromEntries([...got].filter(([,n])=>n).sort()), Object.fromEntries(Object.entries(expected).sort()), entity + ' ' + id);
  assert.equal(compareLedger(got, Object.entries(expected).map(([accountId,cents])=>({accountId,cents}))).ok, true);
  const wrong = Object.entries(expected).map(([accountId,cents])=>({accountId:accountId==='73'?'74':accountId,cents}));
  if (expected[73]) assert.equal(compareLedger(got, wrong).ok, false);
 }
 assert.equal(homeCents(500000,0.873115),436558);
});
test('final partial settlement consumes retained home residual instead of rounding it twice', () => {
 const records = sourceRecords(), ctx = context(records), original = { Id:'900', CurrencyRef:ref('USD'), ExchangeRate:1.5, TotalAmt:0.03, HomeTotalAmt:0.05, CustomerRef:ref('41'), Balance:0, HomeBalance:0 };
 records.set('Invoice:900', original);
 const payment = { Id:'901', CurrencyRef:ref('USD'), ExchangeRate:1.5, CustomerRef:ref('41'), TotalAmt:0.01, DepositToAccountRef:ref('60'), Line:[{Amount:0.01,LinkedTxn:[{TxnType:'Invoice',TxnId:'900'}]}] };
 const snapshots = [{ Balance:0.03,HomeBalance:0.05 },{ Balance:0.02,HomeBalance:0.03 },{ Balance:0.01,HomeBalance:0.01 }];
 const clearing = snapshots.map(balance=>postingsOf('Payment',payment,{...ctx,postingSources:{'Invoice:900':{...original,...balance}}}).get('88'));
 assert.deepEqual(clearing,[-2,-2,-1]); assert.equal(clearing.reduce((a,b)=>a+b),-5);
 assert.throws(()=>postingsOf('Payment',payment,ctx),/retained pre-send source/);
});
test('recovery retains exact saved currency/rate/home totals and sends nothing', async t => {
 const h = harness(t);
 for (const [entity,id] of [['Invoice','22'],['Bill','24'],['Payment','26'],['BillPayment','27'],['Deposit','21']]) {
  const record = h.records.get(entity+':'+id), payload = { CurrencyRef: record.CurrencyRef, ExchangeRate: record.ExchangeRate };
  const item = { bId:'1',ref:'original',op:'create',entity,payload }, batch = { index:0,attempt:1,requestId:'retained-'+entity,state:'sending',items:[item],transport:{receiptId:'existing-receipt',items:[{bId:'1',ref:'original',outcome:'saved'}],response:[{bId:'1',[entity]:record}]} };
  const runId='replay-'+entity; h.rows.set(runId,{_id:runId,...scope,revision:0,status:'sending',day:DAY,items:{},owned:[],dirty:[],batches:[batch],plan:{operations:[item],layers:[['original']]}});
  const result=await h.api.execute(bound,runId); assert.equal(result.status,'complete',JSON.stringify(result)); assert.equal(h.rows.get(runId).batches[0].requestId,batch.requestId);
 }
 const before=h.records.get('Invoice:22');
 for(const field of ['CurrencyRef','ExchangeRate','HomeTotalAmt']) {const saved={...before};delete saved[field];assert.equal(matchesSavedRequest({entity:'Invoice',before,payload:{}},saved),false,field);assert.equal(preservesCurrency(before,saved),false);}
 assert.equal(h.sends(),0);
});
test('rate reader proves observation direction/date and transaction cache boundaries',async()=>{
 let calls=0; const response={SourceCurrencyCode:'USD',TargetCurrencyCode:'CAD',AsOfDate:DAY,Rate:1.4};
 const access={resolveClient:async()=>({apiCall:async(method,endpoint)=>{calls++;assert.equal(method,'GET');assert.match(endpoint,/^exchangerate\?sourcecurrencycode=USD&asofdate=2026-10-31$/);return {ExchangeRate:response};}})};
 const first=createRateReader({access});await first(scope,'USD',DAY);await first(scope,'USD',DAY,{session:{}});assert.equal(calls,1);
 const restarted=createRateReader({access});await assert.rejects(restarted(scope,'USD',DAY,{session:{}}),/outside admission/);
 await restarted(scope,'USD',DAY);assert.deepEqual(await restarted(scope,'USD',DAY,{session:{}}),response);assert.equal(calls,2);
 for(const change of [{TargetCurrencyCode:'USD'},{AsOfDate:'2026-10-30'},{SourceCurrencyCode:'CAD'},{Rate:0},{Rate:NaN}])assert.throws(()=>observedRate({...response,...change},'USD','CAD',DAY));
});
test('day close requires CAD ledger and exact per-record home currency rows',async()=>{
 const records=sourceRecords(), record=records.get('Invoice:22'), entity='Invoice', id='22', date=record.TxnDate, ctx=context(records);
 const gathered={records:[{entity,id,current:record,before:null,evidence:{accountant:{record,versionHash:hash(record),request:{CurrencyRef:record.CurrencyRef,ExchangeRate:record.ExchangeRate}}}}],dirty:[]};
 const columns=['tx_date','txn_type','debt_amt','credit_amt'].map(ColType=>({ColType}));
 const ledger={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',StartPeriod:date,EndPeriod:date,Currency:'CAD'},Columns:{Column:columns},Rows:{Row:[['69','3428.53',''],[records.get('Item:1').IncomeAccountRef.value,'','3428.53']].map(([account,debit,credit])=>({type:'Section',Header:{ColData:[{id:account}]},Rows:{Row:[{type:'Data',ColData:[{value:date},{value:'Invoice',id},{value:debit},{value:credit}]}]}}))}};
 const close=()=>closeGeneralDay({day:date,ledgerReport:ledger,ctx,gathered});assert.equal((await close()).ok,true);
 ledger.Header.Currency='GBP';await assert.rejects(close(),/explicitly expressed in CAD/);ledger.Header.Currency='CAD';
 ledger.Rows.Row[0].Rows.Row[0].ColData[2].value='2000.00';assert.equal((await close()).ok,false);
 const wrong={...record,HomeTotalAmt:2000};assert.throws(()=>postingsOf(entity,wrong,ctx),/HomeTotalAmt disagrees/);
});


test('retained response cannot acquire foreign currency or lose exact totals', () => {
 for (const before of [{ CurrencyRef:ref('CAD') }, {}]) assert.equal(preservesCurrency(before,{CurrencyRef:ref('USD')}),false);
 const record=sourceRecords().get('Invoice:22'), missing={...record}; delete missing.TotalAmt;
 assert.equal(matchesSavedRequest({entity:'Invoice',before:record,payload:{}},missing),false);
 assert.equal(require('../src/modules/general-write-merge').isComplete('Invoice',missing,{CurrencyRef:record.CurrencyRef,ExchangeRate:record.ExchangeRate}),false);
 const partial={Id:'9',CurrencyRef:ref('USD'),ExchangeRate:1.5,CustomerRef:ref('41'),TotalAmt:0.01,DepositToAccountRef:ref('60'),Line:[{Amount:0.01,LinkedTxn:[{TxnType:'Invoice',TxnId:'900'}]}]};
 const records=sourceRecords(), source={Id:'900',CurrencyRef:ref('USD'),ExchangeRate:1.5,CustomerRef:ref('41'),TotalAmt:0.03,HomeTotalAmt:0.05,Balance:0.01};records.set('Invoice:900',source);
 assert.throws(()=>postingsOf('Payment',partial,{...context(records),postingSources:{'Invoice:900':source}}),/exact TotalAmt, Balance and HomeBalance/);
});
test('execute retains the real pre-send home balance and rejects source drift at admission', async t => {
 const h=harness(t), source=h.records.get('Invoice:568'), amount=100;
 const op={ref:'payment',op:'create',entity:'Payment',payload:{TxnDate:DAY,CurrencyRef:ref('USD'),CustomerRef:ref('41'),TotalAmt:amount,DepositToAccountRef:ref('60'),Line:[{Amount:amount,LinkedTxn:[{TxnId:'568',TxnType:'Invoice'}]}]}};
 const ready=await h.api.prepare(bound,proposal('retain-source-balance',[op]));assert.equal(ready.status,'prepared',messages(ready));
 let retained;
 h.transport.sendBatch=async(s,{runId,batch})=>{
  retained=batch.items[0].postingSources['Invoice:568'];assert.deepEqual(retained,source);
  await h.api.guardBatch({scope:s,run:h.rows.get(runId),batch,session:{}});
  source.HomeBalance-=0.01;
  await assert.rejects(h.api.guardBatch({scope:s,run:h.rows.get(runId),batch,session:{}}),/source changed before admission/);source.HomeBalance+=0.01;
  const saved={...batch.items[0].payload,Id:'9999',SyncToken:'0',MetaData:{CreateTime:DAY+'T12:00:00Z'},UnappliedAmt:0};
  const response=[{bId:'1',Payment:saved}],row=h.rows.get(runId);row.batches[0].transport={receiptId:'offline-receipt',items:[{bId:'1',ref:'payment',outcome:'saved'}],response};row.revision++;
  return response;
 };
 const result=await h.api.execute(bound,ready.runId);assert.equal(result.status,'complete',JSON.stringify(result));assert.deepEqual(h.rows.get(ready.runId).items.payment.postingSources['Invoice:568'],retained);
});
test('saved unsent batch preflight warms currency before transactional admission, including sparse updates',async t=>{
 const {createGeneralGateTransport,buildGeneralBatch}=require('../src/modules/general-write-transport');
 let calls=0;const rateReader=createRateReader({access:{resolveClient:async()=>({apiCall:async()=>{calls++;return {ExchangeRate:{SourceCurrencyCode:'USD',TargetCurrencyCode:'CAD',AsOfDate:DAY,Rate:1.4}};}})}});
 const h=harness(t,rateReader), before={...h.records.get('Invoice:568'),TxnDate:DAY};h.records.set('Invoice:568',before);
 const item={ref:'update',bId:'1',op:'update',operation:'update',entity:'Invoice',id:'568',before,payload:{Id:'568',SyncToken:before.SyncToken,sparse:true,TxnDate:DAY,ExchangeRate:1.4}};
 const batch={index:0,attempt:1,state:'sending',requestId:'a'.repeat(32),items:[item]};
 const run={_id:'restart-sparse',...scope,revision:0,status:'sending',day:DAY,items:{},owned:[],dirty:[],batches:[batch],plan:{operations:[{...item,reason:'Replay a sparse foreign update after a process restart.'}],layers:[['update']]}};h.rows.set(run._id,run);
 const gate=createGeneralGateTransport({models:h.models,scope,runId:run._id,batchIndex:0,now:()=>Date.parse(DAY+'T20:00:00Z'),warmCurrency:async(s,b)=>{for(const i of b.items){const r={...i.before,...i.payload};await rateReader(s,r.CurrencyRef.value,r.TxnDate);}},admissionGuard:input=>h.api.guardBatch(input)});
 const client={read:async(entity,id)=>{const proper=[...h.records.keys()].find(key=>key.toLowerCase()===entity+':'+id);return {[proper.split(':')[0]]:h.records.get(proper)};},query:async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:false}}]}})};
 const request=buildGeneralBatch(scope,batch);await gate.preflight({request,client,coordination:null});assert.equal(calls,1);
 await h.api.guardBatch({scope,run,batch,session:{}});assert.equal(calls,1);
 assert.deepEqual(batch.items[0].payload,item.payload);assert.equal(batch.requestId,'a'.repeat(32));
});


test('partial foreign history movements use the exact retained source snapshot', () => {
 const records=sourceRecords(), source={Id:'900',TxnDate:DAY,CurrencyRef:ref('USD'),ExchangeRate:1.5,CustomerRef:ref('41'),TotalAmt:0.03,HomeTotalAmt:0.05,Balance:0,HomeBalance:0};records.set('Invoice:900',source);
 const record={Id:'901',SyncToken:'0',TxnDate:DAY,CurrencyRef:ref('USD'),ExchangeRate:1.5,CustomerRef:ref('41'),TotalAmt:0.01,DepositToAccountRef:ref('60'),Line:[{Amount:0.01,LinkedTxn:[{TxnType:'Invoice',TxnId:'900'}]}]};
 const item={outcome:'saved',op:'create',entity:'Payment',record,postingSources:{'Invoice:900':{...source,Balance:0.01,HomeBalance:0.01}},request:{CurrencyRef:record.CurrencyRef,ExchangeRate:record.ExchangeRate}};
 const movements=require('../src/modules/general-write-recovery').historyMovements([{updatedAt:DAY+'T22:00:00Z',items:{payment:item},plan:{operations:[{ref:'payment',op:'create'}]}}],DAY+'T20:00:00Z',context(records),DAY);
 assert.equal(movements.find(row=>row.accountId==='88').cents,-1);assert.equal(movements.find(row=>row.accountId==='73').cents,-1);
});
test('unknown foreign writes replay the exact rate, body, requestid and bId after observation changes', async t => {
 let observed=1.4;const h=harness(t,async(s,currency,day)=>({SourceCurrencyCode:currency,TargetCurrencyCode:'CAD',AsOfDate:day,Rate:observed})), ready=await h.api.prepare(bound,proposal('foreign-lost-response',[invoice()]));assert.equal(ready.status,'prepared');
 let original,attempts=0;
 h.transport.sendBatch=async(s,{runId,batch})=>{
  attempts++;const wire=require('../src/modules/general-write-transport').buildGeneralBatch(s,batch);
  if(attempts===1){original=wire;throw Object.assign(new Error('lost offline reply'),{lost:true});}
  assert.equal(wire.requestHash,original.requestHash);assert.equal(wire.body,original.body);assert.equal(batch.items[0].payload.ExchangeRate,1.4);
  throw Object.assign(new Error('lost again offline'),{lost:true});
 };
 assert.equal((await h.api.execute(bound,ready.runId)).status,'unknown');
 observed=1.6;await h.api.execute(bound,ready.runId);assert.equal(attempts,2);assert.equal(h.rows.get(ready.runId).batches.length,1);
});


test('settlement source proof and duplicate-target cent allocation are guarded before dispatch',async t=>{
 const h=harness(t), source=h.records.get('Invoice:568');
 const make=()=>({ref:'payment',op:'create',entity:'Payment',payload:{TxnDate:DAY,CurrencyRef:ref('USD'),CustomerRef:ref('41'),TotalAmt:source.Balance,DepositToAccountRef:ref('60'),Line:[{Amount:source.Balance,LinkedTxn:[{TxnId:'568',TxnType:'Invoice'}]}]}});
 const home=source.HomeBalance;delete source.HomeBalance;
 let result=await h.api.prepare(bound,proposal('missing-source-home',[make()]));assert.equal(result.status,'refused');assert.match(messages(result),/Balance and HomeBalance before dispatch/);source.HomeBalance=home;
 const op=make();op.payload.Line=[{Amount:1,LinkedTxn:[{TxnId:'568',TxnType:'Invoice'}]},{Amount:1,LinkedTxn:[{TxnId:568,TxnType:'Invoice'}]}];op.payload.TotalAmt=2;
 result=await h.api.prepare(bound,proposal('duplicate-foreign-application',[op]));assert.equal(result.status,'refused');assert.match(messages(result),/one foreign settlement line/);
 const credit=make();credit.payload.Line[0].LinkedTxn[0].TxnType='CreditMemo';result=await h.api.prepare(bound,proposal('held-foreign-credit',[credit]));assert.equal(result.status,'refused');assert.match(messages(result),/credit applications.*held/);
});
test('transfer amounts cannot lower exposure or evade CAD and foreign money limits',async t=>{
 const h=harness(t);
 for(const [n,amount] of [-1000000,0,'100',NaN,Infinity,0.001].entries()) {
  const op={ref:'transfer',op:'create',entity:'Transfer',payload:{TxnDate:DAY,CurrencyRef:ref('USD'),FromAccountRef:ref('60'),ToAccountRef:ref('1150040002'),Amount:amount}};
  if(typeof amount==='number'&&!Number.isFinite(amount)){
   await assert.rejects(h.api.prepare(bound,proposal('invalid-transfer-'+n,[op])),/plain JSON/);
   const local={map:h.records,get:(e,id)=>h.records.get(e+':'+id),owned:()=>false};
   const ctx=await h.contextFor(scope,local,{operations:[op]});
   assert.equal(require('../src/modules/general-write-guards').checkGeneralWrite({proposal:{operations:[op]},local,context:ctx}).ok,false);
  }else{const result=await h.api.prepare(bound,proposal('invalid-transfer-'+n,[op]));assert.equal(result.status,'refused');assert.match(messages(result),/positive finite exact cents/);}
 }
});
