'use strict';
// Job I capability fixtures. In-memory records/reports only: no QBO, DB or services.
const test = require('node:test'), assert = require('node:assert/strict');
const { checkGeneralWrite } = require('../src/modules/general-write-guards');
const { postingsOf, movementsOf } = require('../src/modules/general-write-postings');
const { closeGeneralDay } = require('../src/modules/general-write-day-close');
const { hash } = require('../src/modules/business-calendar');
const { entitySchema, VOID_SUPPORT } = require('../src/modules/qbo-entity-schema');
const { buildGeneralBatch, classifyGeneralResponse } = require('../src/modules/general-write-transport');
const { itemOutcomes } = require('../src/modules/general-write-recovery');
const DAY = '2026-12-02', scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const rows = new Map([
  ['Customer:1', { Id: '1', Active: true }], ['Customer:2', { Id: '2', Active: true }],
  ['Account:100', { Id: '100', Active: true, AccountType: 'Bank' }],
  ['Account:125', { Id: '125', Active: true, AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds' }],
  ['Account:610', { Id: '610', Active: true, AccountType: 'Expense' }],
  ['Account:400', { Id: '400', Active: true, AccountType: 'Income' }],
  ['Item:40', { Id: '40', Active: true, Type: 'Service', IncomeAccountRef: { value: '400' } }],
  ['Item:41', { Id: '41', Active: true, Type: 'Inventory' }],
  ...['7','8','9'].map(Id => ['TaxCode:' + Id, { Id, SyncToken:'0', Active: true, ...(Id==='9'?{Taxable:false}:{SalesTaxRateList:{TaxRateDetail:[{TaxRateRef:{value:Id==='7'?'17':'18'},TaxTypeApplicable:'TaxOnAmount'}]}}) }]),
  ...[['17',13],['18',5]].map(([Id,percent])=>['TaxRate:'+Id,{Id,SyncToken:'0',Active:true,EffectiveTaxRate:[{EffectiveDate:'2026-01-01',RateValue:percent}]}]),
  ['Invoice:700', { Id: '700', SyncToken: '0', TxnDate: DAY, CustomerRef: { value: '1' }, Balance: 60, TotalAmt: 60, Line: [] }],
  ['Payment:800', { Id: '800', SyncToken: '0', TxnDate: DAY, CustomerRef: { value: '1' }, DepositToAccountRef: { value: '125' }, TotalAmt: 100, UnappliedAmt: 100, Line: [] }],
]);
const local = { get: (entity, id) => rows.get(entity + ':' + id) || null, owned: () => true };
const context = { day: DAY, protectedThrough: '2026-10-31', taxCodes: { sales: ['7','8','9'] }, taxPercent: { 7: 13, 8: 5, 9: 0 } };
const ctx = { get: local.get, receivables: '120', undepositedFunds: '125', payables: '200', taxAccount: rate => ({ 17: '210', 18: '211' })[rate] };
const check = (op, custom = {}) => checkGeneralWrite({ proposal: { operations: Array.isArray(op) ? op : [op] }, local, context, ...custom });
const messages = r => r.problems.map(p => p.message).join(' | ');
const accept = r => assert.equal(r.ok, true, messages(r));
const refuse = (op, pattern, custom) => { const r = check(op, custom); assert.equal(r.ok, false); assert.match(messages(r), pattern); };
const link = (TxnType, TxnId, Amount) => ({ Amount, LinkedTxn: [{ TxnType, TxnId }] });
const payment = extra => ({ ref: 'pay', op: 'create', entity: 'Payment', payload: { TxnDate: DAY, CustomerRef: { value: '1' }, TotalAmt: 100, ...extra } });
const feeDeposit = (fee = -3) => ({ ref: 'dep', op: 'create', entity: 'Deposit', payload: { TxnDate: DAY, DepositToAccountRef: { value: '100' }, Line: [link('Payment', '800', 100), { Amount: fee, DetailType: 'DepositLineDetail', DepositLineDetail: { AccountRef: { value: '610' } } }] } });
const sale = entity => ({ ref: 'sale', op: 'create', entity, payload: { TxnDate: DAY, CustomerRef: { value: '1' }, ...(entity === 'SalesReceipt' ? { DepositToAccountRef: { value: '125' } } : {}), GlobalTaxCalculation: 'TaxExcluded', Line: ['7','8','9'].map(code => ({ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '40' }, TaxCodeRef: { value: code } } })) } });

test('unapplied cash and overpayment create; later application reuses the same Payment and receives no second cash', () => {
  accept(check(payment())); accept(check(payment({ Line: [] })));
  const over = payment({ Line: [link('Invoice', '700', 60)] }); accept(check(over));
  const apply = { ref: 'apply', op: 'update', entity: 'Payment', id: '800', payload: { Line: [link('Invoice', '700', 60)] } }; accept(check(apply));
  const before = rows.get('Payment:800'), after = { ...before, ...apply.payload, UnappliedAmt: 40, SyncToken: '1' };
  assert.deepEqual(Object.fromEntries(postingsOf('Payment', before, ctx)), { 120: -10000, 125: 10000 });
  assert.deepEqual(postingsOf('Payment', after, ctx), postingsOf('Payment', before, ctx));
  assert.deepEqual(movementsOf('Payment', before, after, ctx), []);
  refuse(payment({ TotalAmt: -1 }), /non-negative/); refuse(payment({ TotalAmt: 1.001 }), /exact cents/);
  refuse(payment({ TotalAmt: 50000.01 }), /at most/);
  refuse(payment({ TotalAmt: 50, Line: [link('Invoice','700',60)] }), /TotalAmt must equal/);
  refuse(payment({ Line: [link('Invoice','700',61)] }), /has [$]60 open/);
  refuse(payment({ CustomerRef: { value: '2' }, Line: [link('Invoice','700',60)] }), /another customer/);
  refuse(payment({ UnappliedAmt: 100 }), /set by QuickBooks/);
  refuse([payment({ TotalAmt: 50, Line: [link('Invoice','700',50)] }), { ...payment({ TotalAmt: 50, Line: [link('Invoice','700',50)] }), ref: 'second' }], /has [$]60 open/);
});

test('mixed Canadian sales codes stay on their own invoice and receipt lines; posting keeps tax agency accounts distinct', () => {
  for (const entity of ['Invoice', 'SalesReceipt']) {
    const op = sale(entity); accept(check(op));
    const saved = { ...op.payload, TotalAmt: 318, TxnTaxDetail: { TotalTax: 18, TaxLine: [{ Amount: 13, TaxLineDetail: { TaxRateRef: { value: '17' } } }, { Amount: 5, TaxLineDetail: { TaxRateRef: { value: '18' } } }] } };
    assert.deepEqual(Object.fromEntries(postingsOf(entity, saved, ctx)), { 400: -30000, 210: -1300, 211: -500, [entity === 'Invoice' ? '120' : '125']: 31800 });
    refuse({ ...op, payload: { ...op.payload, Line: [...op.payload.Line, { ...op.payload.Line[0], SalesItemLineDetail: { ItemRef: { value: '40' }, TaxCodeRef: { value: '99' } } }] } }, /not a TaxCode/);
    refuse({ ...op, payload: { ...op.payload, Line: op.payload.Line.map(line => ({ ...line, Amount: 16000 })) } }, /at most/);
  }
});

test('processor fees debit expense while linked undeposited cash clears in full; offsets cannot evade caps', () => {
  accept(check(feeDeposit()));
  assert.deepEqual(Object.fromEntries(postingsOf('Deposit', feeDeposit().payload, ctx)), { 100: 9700, 125: -10000, 610: 300 });
  for (const amount of [-100, -101]) refuse(feeDeposit(amount), /positive net/);
  const wrong = feeDeposit(); wrong.payload.Line[1].DepositLineDetail.AccountRef.value = '400'; refuse(wrong, /Expense/);
  const unlinked = feeDeposit(); unlinked.payload.Line.shift(); refuse(unlinked, /accompany linked/);
  const partial = feeDeposit(); partial.payload.Line[0].Amount = 99; refuse(partial, /full amount/);
  const negativeLink = feeDeposit(); negativeLink.payload.Line[0].Amount = -100; refuse(negativeLink, /non-negative/);
  const taxed = feeDeposit(); taxed.payload.Line[1].DepositLineDetail.TaxCodeRef = { value: '7' }; refuse(taxed, /no tax overrides/);
  const large = feeDeposit(-25000); large.payload.Line[0].Amount = 30000;
  const copy = { ...local, get: (e,id) => e === 'Payment' && id === '800' ? { ...rows.get('Payment:800'), TotalAmt: 30000 } : local.get(e,id) };
  refuse(large, /at most/, { local: copy });
});

const voidItem = entity => ({ bId: '1', ref: 'void', op: 'void', operation: 'void', entity, id: '900', before: { SyncToken: '0' }, payload: { Id: '900', SyncToken: '0', sparse: true } });
const voidRecord = () => ({ Id: '900', SyncToken: '1', TxnDate: DAY, TotalAmt: 0, PrivateNote: 'Voided', Line: [], TxnTaxDetail: { TotalTax: 0 } });
test('only confirmed void endpoints are advertised; batch uses update plus optionsData void and requires a newer zero response', () => {
  for (const entity of ['Invoice','SalesReceipt','Payment','BillPayment']) {
    assert.equal(VOID_SUPPORT[entity].enabled, true); assert.ok(entitySchema(entity).operations.includes('void'));
    const item = voidItem(entity), batch = { requestId: 'a'.repeat(32), items: [item] };
    const wire = JSON.parse(buildGeneralBatch(scope,batch).body).BatchItemRequest[0];
    assert.equal(wire.operation, 'update'); assert.equal(wire.optionsData, 'void');
    const response = record => ({ status: 200, json: { BatchItemResponse: [{ bId: '1', [entity]: record }] } });
    assert.equal(classifyGeneralResponse(scope,batch,response(voidRecord())).items[0].outcome, 'saved');
    assert.equal(itemOutcomes(batch,response(voidRecord()).json.BatchItemResponse).items[0].outcome, 'saved');
    for (const patch of [{ TotalAmt: 1 }, { SyncToken: '0' }, { PrivateNote: 'ordinary' }, { Line: [{ Amount: 1 }] }, { TxnTaxDetail: { TotalTax: 1 } }]) {
      const bad = { ...voidRecord(), ...patch };
      assert.equal(classifyGeneralResponse(scope,batch,response(bad)).items[0].outcome, 'unknown');
      assert.equal(itemOutcomes(batch,response(bad).json.BatchItemResponse).items[0].outcome, 'unknown');
    }
  }
  for (const entity of ['RefundReceipt','CreditMemo','Bill','VendorCredit','Purchase','PurchaseOrder','Deposit','Transfer','JournalEntry','Estimate']) {
    assert.equal(entitySchema(entity).voidSupport.enabled, false); assert.equal(entitySchema(entity).operations.includes('void'), false);
  }
});

test('void preserves accountant ownership, protected dates, amount caps and inventory restrictions', () => {
  const op = { ref: 'void', op: 'void', entity: 'Invoice', id: '700' }; accept(check(op));
  refuse(op, /accountant-created/, { local: { ...local, owned: () => false } });
  const withRecord = record => ({ ...local, get: (e,id) => e === 'Invoice' && id === '700' ? { ...rows.get('Invoice:700'), ...record } : local.get(e,id) });
  refuse(op, /closed or reconciled/, { local: withRecord({ TxnDate: '2026-10-01' }) });
  refuse(op, /at most/, { local: withRecord({ Line: [{ Amount: 50001 }] }) });
  refuse(op, /Inventory/, { local: withRecord({ Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '41' } } }] }) });
  refuse(op, /Unlink/, { local: withRecord({ LinkedTxn: [{ TxnType: 'Payment', TxnId: '800' }] }) });
});

function reportFor(entity, id, entries) {
  const labels = { SalesReceipt: 'Sales Receipt', BillPayment: 'Bill Payment (Check)' };
  return { Header: { ReportName: 'GeneralLedger', ReportBasis: 'Accrual', StartPeriod: DAY, EndPeriod: DAY }, Columns: { Column: ['tx_date','txn_type','debt_amt','credit_amt'].map(ColType => ({ ColType })) }, Rows: { Row: Object.entries(entries).map(([account,cents]) => ({ type: 'Section', Header: { ColData: [{ id: account }] }, Rows: { Row: [{ type: 'Data', ColData: [{ value: DAY },{ value: labels[entity] || entity, id },{ value: cents > 0 ? (cents / 100).toFixed(2) : '' },{ value: cents < 0 ? (-cents / 100).toFixed(2) : '' }] }] } })) } };
}
async function closeFixture(entity, current, entries, before = null, op = 'create') {
  const row = { entity, id: current.Id, current, before, evidence: { accountant: { versionHash: hash(current), record: current, operation: op, request: op === 'void' ? { Id: current.Id } : {} } } };
  return closeGeneralDay({ scope, day: DAY, ctx, ledgerReport: reportFor(entity,current.Id,entries), gathered: { records: [row], dirty: [], ownSettlements: [] } });
}
test('day-close fixtures prove unapplied/overpaid cash, later applications, mixed tax, net deposits and void reversals', async () => {
  for (const Line of [[],[link('Invoice','700',60)]]) {
    const p = { ...rows.get('Payment:800'), Line, UnappliedAmt: Line.length ? 40 : 100 };
    assert.equal((await closeFixture('Payment',p,{ 120: -10000, 125: 10000 })).ok,true);
    const applied = { ...p, Line: [link('Invoice','700',60)], UnappliedAmt: 40, SyncToken: '1' };
    const close = await closeFixture('Payment',applied,{ 120: -10000, 125: 10000 },p,'update'); assert.equal(close.ok,true); assert.deepEqual(close.movements,[]);
  }
  for (const entity of ['Invoice','SalesReceipt']) {
    const current = { ...sale(entity).payload, Id: '900', SyncToken: '0', TotalAmt: 318, TxnTaxDetail: { TotalTax: 18, TaxLine: [{ Amount: 13, TaxLineDetail: { TaxRateRef: { value: '17' } } },{ Amount: 5, TaxLineDetail: { TaxRateRef: { value: '18' } } }] } };
    assert.equal((await closeFixture(entity,current,{ 400: -30000, 210: -1300, 211: -500, [entity === 'Invoice' ? '120' : '125']: 31800 })).ok,true);
    assert.equal((await closeFixture(entity,current,{ 400: -30000, 210: -1800, [entity === 'Invoice' ? '120' : '125']: 31800 })).ok,false,'wrong tax agency fails');
  }
  const dep = { ...feeDeposit().payload, Id: '900', SyncToken: '0', TotalAmt: 97 };
  assert.equal((await closeFixture('Deposit',dep,{ 100: 9700, 125: -10000, 610: 300 })).ok,true);
  assert.equal((await closeFixture('Deposit',dep,{ 100: 9700, 125: -9700 })).ok,false,'fee hidden in net settlement fails');
  const originals = { Invoice: { ...sale('Invoice').payload, Id:'900' }, SalesReceipt: { ...sale('SalesReceipt').payload, Id:'900' }, Payment: { ...rows.get('Payment:800'), Id:'900' }, BillPayment: { Id:'900', TxnDate: DAY, TotalAmt:100, PayType:'Check', CheckPayment:{ BankAccountRef:{ value:'100' } }, Line:[] } };
  for (const [entity,before] of Object.entries(originals)) {
    const close = await closeFixture(entity,voidRecord(),{},before,'void'); assert.equal(close.ok,true,JSON.stringify(close.failures));
    assert.ok(close.movements.length); assert.equal(close.movements.reduce((sum,row)=>sum+row.cents,0),0);
    assert.equal((await closeFixture(entity,voidRecord(),{100:1},before,'void')).ok,false,'any residual posting fails');
  }
});

function memoryRuns() {
  const records = new Map(), query = value => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => structuredClone(value) });
  const match = (row,f) => Object.entries(f).every(([k,v]) => k === 'owned' ? row.owned.some(item => Object.entries(v.$elemMatch).every(([key,want]) => item[key] === want)) : row[k] === v);
  return { records, findOne: f => query([...records.values()].find(r=>match(r,f)) || null), create: async ([r]) => records.set(r._id, { batches:[],items:{},dirty:[],owned:[],revision:0,...structuredClone(r) }), findOneAndUpdate: (f,u) => { const r=records.get(f._id); if (!r || r.revision!==f.revision) return query(null); Object.assign(r,structuredClone(u.$set));r.revision++;return query(r); } };
}
const bound = { scope, ownerId:'b'.repeat(24), actorId:'b'.repeat(24) };
const input = (decisionKey,operations) => ({ decisionKey,purpose:'Record a governed teaching example for the business.',operations });
test('service prepares and executes an owned void through the saved batch contract and refuses imported targets', async () => {
  const Runs=memoryRuns(), saved = { ...rows.get('Invoice:700') }, sent=[];
  const query = v=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>v});
  let owned=true;
  const api = require('../src/modules/general-write-service').createGeneralWriteService({ models:{ GeneralWriteRuns:Runs,Steps:{findOne:()=>query(owned?{_id:'proof'}:null)} },copy:{read:async(s,e,id)=>e==='Invoice' && id==='700'?saved:local.get(e,id)},contextFor:async()=>context,dispatchEnabled:()=>true,transport:{sendBatch:async(s,{batch})=>{ sent.push(batch); const r={...voidRecord(),Id:'700'}; return [{bId:'1',Invoice:r}]; }} });
  const op={ref:'void',op:'void',entity:'Invoice',id:'700'};
  const prepared=await api.prepare(bound,input('owned-void-0001',[op]));assert.equal(prepared.status,'prepared',JSON.stringify(prepared));
  const done=await api.execute(bound,prepared.runId);assert.equal(done.status,'complete',JSON.stringify(done));
  assert.equal(sent[0].items[0].operation,'void');assert.equal(sent[0].items[0].payload.sparse,true);
  owned=false;
  const denied=await api.prepare(bound,input('external-void-0001',[{...op,reason:'This imported invoice should be removed for teaching.'}]));assert.equal(denied.status,'refused');assert.match(denied.problems.map(p=>p.message).join(' '),/accountant-created/);
});

test('live context admits explicitly referenced mixed sales codes with complete dated rates, including non-taxable codes', async t => {
  const authority=require('../src/modules/business-authority');
  t.mock.method(authority,'readPublishedBusiness',async()=>({view:{mappings:{salesTax:'7',purchaseTax:'7'},business:{openingDate:'2026-01-01'}}}));
  const q=v=>({session(){return this;},select(){return this;},maxTimeMS(){return this;},lean:async()=>v});
  const models={Calendars:{findOne:()=>q({verifiedThrough:'2026-12-01'})},Policies:{findOne:()=>q({periodControl:{}})},GeneralWriteRuns:{findOne:()=>q(null)}};
  const detail = id=>({TaxRateRef:{value:id},TaxTypeApplicable:'TaxOnAmount'});
  const copy=new Map(rows);
  copy.set('TaxCode:7',{Id:'7',SyncToken:'0',Active:true,SalesTaxRateList:{TaxRateDetail:[detail('17')]},PurchaseTaxRateList:{TaxRateDetail:[detail('17')]}});
  copy.set('TaxCode:8',{Id:'8',SyncToken:'0',Active:true,SalesTaxRateList:{TaxRateDetail:[detail('18')]}});
  copy.set('TaxCode:9',{Id:'9',SyncToken:'0',Active:true,Taxable:false});
  copy.set('TaxRate:17',{Id:'17',SyncToken:'0',Active:true,RateValue:13,EffectiveTaxRate:[{EffectiveDate:'2026-01-01',RateValue:13}]});copy.set('TaxRate:18',{Id:'18',SyncToken:'0',Active:true,RateValue:5,EffectiveTaxRate:[{EffectiveDate:'2026-01-01',RateValue:5}]});
  const localCopy={...local,map:copy,get:(e,id)=>copy.get(e+':'+id)};
  const contextFor=require('../src/modules/general-write-service').createGeneralWriteContext({models,now:()=>Date.parse(DAY+'T16:00:00Z')});
  const mixed=await contextFor(scope,localCopy,{operations:[sale('Invoice')]});
  assert.deepEqual(mixed.taxCodes.sales,['7','8','9']);assert.deepEqual(mixed.taxPercent,{7:13,8:5,9:0});accept(check(sale('Invoice'),{local:localCopy,context:mixed}));
  copy.get('TaxCode:8').Active=false;const inactive=await contextFor(scope,localCopy,{operations:[sale('Invoice')]});refuse(sale('Invoice'),/complete active/,{local:localCopy,context:inactive});
  copy.get('TaxCode:8').Active=true;copy.get('TaxCode:8').SalesTaxRateList.TaxRateDetail[0].TaxTypeApplicable='TaxOnTax';const compound=await contextFor(scope,localCopy,{operations:[sale('Invoice')]});refuse(sale('Invoice'),/Compound|ambiguous/,{local:localCopy,context:compound});
});

test('service passes proposed invoice line codes into the guarded tax context', async () => {
  let requested;
  const api=require('../src/modules/general-write-service').createGeneralWriteService({models:{GeneralWriteRuns:memoryRuns(),Steps:{findOne:()=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>null})}},copy:{read:async(s,e,id)=>local.get(e,id)},contextFor:async(s,l,options)=>{requested=options.salesTaxCodes;return context;}});
  assert.equal((await api.prepare(bound,input('mixed-tax-invoice-001',[sale('Invoice')]))).status,'prepared');assert.deepEqual(requested,['7','8','9']);
});


test('fee deposit keeps historical receipt dates read-only in the protected-period proof', async () => {
  const { freezeWriteRequest }=require('../src/modules/qbo-write-contract'),{readWritePeriodEvidence,assertWritePeriod}=require('../src/modules/qbo-write-period');
  const op=feeDeposit(), req=freezeWriteRequest(scope,'POST','deposit',op.payload), clock=Date.parse(DAY+'T16:00:00Z');
  const client={read:async(entity,id)=>({[entity==='payment'?'Payment':'Invoice']:{Id:id,SyncToken:'0',TxnDate:'2026-10-01'}}),query:async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{BookCloseDate:'2026-10-31'}}]}})};
  const evidence=await readWritePeriodEvidence(req,client,()=>clock);
  assert.deepEqual(evidence.affectedDates,[DAY]);assert.deepEqual(evidence.records[0].dates,['2026-10-01']);
  const controls={version:1,status:'owner-recorded',ownerId:bound.ownerId,scope,closedThrough:'2026-10-31',reconciledThrough:null,evidenceNote:'Recorded only for isolated unit test.',recordedAt:new Date(clock).toISOString()};controls.contentHash=hash(controls);
  assert.equal(assertWritePeriod(req,evidence,controls,clock,bound.ownerId).protectedThrough,'2026-10-31');
  const changed=structuredClone(op.payload);changed.Line[1].DetailType='SalesItemLineDetail';
  const bad=freezeWriteRequest(scope,'POST','deposit',changed),badEvidence=await readWritePeriodEvidence(bad,client,()=>clock);assert.throws(()=>assertWritePeriod(bad,badEvidence,controls,clock,bound.ownerId),/closed or reconciled/);
});

test('same-day unapplied Payment and fee Deposit close through the real gather and report parser', async () => {
  const original={...rows.get('Payment:800')},deposit={...feeDeposit().payload,Id:'900',SyncToken:'0',TotalAmt:97};
  const current={...original,SyncToken:'1',DepositToAccountRef:{value:'100'},LinkedTxn:[{TxnType:'Deposit',TxnId:'900'}]};
  const items={pay:{entity:'Payment',op:'create',outcome:'saved',qboId:'800',record:original,request:{CustomerRef:{value:'1'},TotalAmt:100,DepositToAccountRef:{value:'125'},Line:[]}},dep:{entity:'Deposit',op:'create',outcome:'saved',qboId:'900',record:deposit}};
  const run={_id:'run',...scope,items,plan:{operations:[{ref:'pay',entity:'Payment',op:'create'},{ref:'dep',entity:'Deposit',op:'create'}]},dirty:[]};
  const query={select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>[run]};
  const ledger=reportFor('Payment','800',{120:-10000,125:10000});ledger.Rows.Row.push(...reportFor('Deposit','900',{100:9700,125:-10000,610:300}).Rows.Row);
  const result=await closeGeneralDay({Runs:{find:()=>query},scope,day:DAY,copy:{read:async(s,e,id)=>e==='Payment'?current:deposit},ctx,ledgerReport:ledger});
  assert.equal(result.ok,true,JSON.stringify(result.failures));assert.equal(result.records.length,2);
  assert.deepEqual(Object.fromEntries(postingsOf('Payment',current,ctx)),{120:-10000,125:10000});
});

test('malformed proposals reach normal refusals and deposit accounts can reference an earlier create', async () => {
  const op=feeDeposit();op.payload.DepositToAccountRef={$ref:'bank'};
  accept(check([{ref:'bank',entity:'Account',op:'create',payload:{Name:'Processor bank',AccountType:'Bank'}},op]));
  const api=require('../src/modules/general-write-service').createGeneralWriteService({models:{GeneralWriteRuns:memoryRuns(),Steps:{findOne:()=>({select(){return this;},maxTimeMS(){return this;},lean:async()=>null})}},copy:{read:async(s,e,id)=>local.get(e,id)},contextFor:async()=>context});
  assert.equal((await api.prepare(bound,input('invalid-null-op-001',[null]))).status,'refused');
  const malformed=sale('Invoice');malformed.payload.Line={invalid:true};assert.equal((await api.prepare(bound,input('invalid-line-op-001',[malformed]))).status,'refused');
  malformed.payload.Line=[null];assert.equal((await api.prepare(bound,input('invalid-null-line-001',[malformed]))).status,'refused');
});
