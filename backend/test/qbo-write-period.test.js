'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { freezeWriteRequest } = require('../src/modules/qbo-write-contract');
const { readWritePeriodEvidence, assertWritePeriod } = require('../src/modules/qbo-write-period');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, ownerId = 'b'.repeat(24), now = Date.parse('2026-10-15T15:00:00Z');
function controls(closedThrough = null, reconciledThrough = null) { const value = { version: 1, status: 'owner-recorded', scope, ownerId, closedThrough, reconciledThrough, evidenceNote: 'Owner reviewed the accounting periods.', recordedAt: new Date(now).toISOString() }; return { ...value, contentHash: hash(value) }; }
function fixture(records = {}, closedThrough = null) {
  const calls = [];
  return { calls, client: { query: async query => { calls.push(query); return { QueryResponse: { Preferences: [{ AccountingInfoPrefs: { ...(closedThrough ? { BookCloseDate: closedThrough } : {}) }, SalesFormsPrefs: { AutoApplyCredit: false } }] } }; }, read: async (entity, id) => { calls.push(entity + ':' + id); return { [entity[0].toUpperCase() + entity.slice(1)]: records[entity + ':' + id] }; } } };
}
const request = (endpoint, body) => freezeWriteRequest(scope, 'POST', endpoint, body);
const check = (req, evidence, policy = controls(), clock = now) => assertWritePeriod(req, evidence, policy, clock, ownerId);
test('create is refused at either owner cutoff or the current QuickBooks closing date', async () => {
  const req = request('invoice', { TxnDate: '2026-09-30' }), f = fixture({}, '2026-09-30'), evidence = await readWritePeriodEvidence(req, f.client, () => now);
  assert.throws(() => check(req, evidence), /closed or reconciled/);
  const fresh = await readWritePeriodEvidence(req, fixture().client, () => now);
  assert.throws(() => check(req, fresh, controls('2026-09-30')), /closed or reconciled/);
  assert.throws(() => check(req, fresh, controls(null, '2026-09-30')), /closed or reconciled/);
  assert.equal(check(req, fresh, controls('2026-09-29')).protectedThrough, '2026-09-29');
});
for (const endpoint of ['invoice', 'invoice?operation=void', 'invoice?operation=delete']) test('sparse '+endpoint+' protects the original date as well as any requested new date', async () => {
  const req = request(endpoint, { Id: '10', SyncToken: '2', ...(endpoint === 'invoice' ? { TxnDate: '2026-10-15' } : {}) });
  const f = fixture({ 'invoice:10': { Id: '10', SyncToken: '2', TxnDate: '2026-09-01' } });
  const evidence = await readWritePeriodEvidence(req, f.client, () => now);
  assert.throws(() => check(req, evidence, controls('2026-09-30')), /closed or reconciled/);
  assert.ok(evidence.affectedDates.includes('2026-09-01'));
});
test('a current payment cannot bypass protection by linking an older invoice or credit chain', async () => {
  const req = request('payment', { TxnDate: '2026-10-15', Line: [{ LinkedTxn: [{ TxnType: 'Invoice', TxnId: '10' }] }] });
  const f = fixture({ 'invoice:10': { Id: '10', SyncToken: '2', TxnDate: '2026-10-01', LinkedTxn: [{ TxnType: 'CreditMemo', TxnId: '20' }] }, 'creditmemo:20': { Id: '20', SyncToken: '0', TxnDate: '2026-09-01' } });
  f.client.read = async (entity, id) => ({ [entity === 'creditmemo' ? 'CreditMemo' : 'Invoice']: entity === 'invoice' ? { Id: id, SyncToken: '2', TxnDate: '2026-10-01', LinkedTxn: [{ TxnType: 'CreditMemo', TxnId: '20' }] } : { Id: id, SyncToken: '0', TxnDate: '2026-09-01' } });
  const evidence = await readWritePeriodEvidence(req, f.client, () => now); assert.equal(evidence.records.length, 2);
  assert.throws(() => check(req, evidence, controls(null, '2026-09-30')), /closed or reconciled/);
  const changed = structuredClone(evidence); changed.records.pop(); changed.affectedDates = ['2026-10-01', '2026-10-15']; changed.evidenceHash = hash(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== 'evidenceHash')));
  assert.throws(() => check(req, changed), /missing/);
});
test('unreadable preferences, changed source version, missing dates and unknown link types fail before writes', async () => {
  await assert.rejects(readWritePeriodEvidence(request('invoice', {}), fixture().client, () => now), /explicit accounting date/);
  await assert.rejects(readWritePeriodEvidence(request('invoice', { TxnDate: '2026-10-15' }), { query: async () => ({}) }, () => now), /closing preferences/);
  await assert.rejects(readWritePeriodEvidence(request('invoice?operation=delete', { Id: '10', SyncToken: '1' }), fixture({ 'invoice:10': { Id: '10', SyncToken: '2', TxnDate: '2026-10-01' } }).client, () => now), /changed/);
  await assert.rejects(readWritePeriodEvidence(request('payment', { TxnDate: '2026-10-15', LinkedTxn: [{ TxnType: 'Unknown', TxnId: '10' }] }), fixture().client, () => now), /cannot be checked/);
});
test('master opening balances and undated quantity changes cannot bypass period controls', async () => {
  await assert.rejects(readWritePeriodEvidence(request('customer', { DisplayName: 'Fixture', Balance: 10 }), fixture().client, () => now), /Opening balances/);
  await assert.rejects(readWritePeriodEvidence(request('item', { Id: '10', SyncToken: '0', QtyOnHand: 1 }), fixture().client, () => now), /dated inventory adjustment/);
  await assert.rejects(readWritePeriodEvidence(request('item', { Type: 'Inventory', QtyOnHand: 10 }), fixture().client, () => now), /explicit accounting date/);
  const req = request('customer', { DisplayName: 'Fixture' }), f = fixture(), evidence = await readWritePeriodEvidence(req, f.client, () => now);
  assert.deepEqual(f.calls, []); assert.deepEqual(check(req, evidence).affectedDates, []);
});
test('missing owner choices, changed controls and stale observations fail closed', async () => {
  const req = request('invoice', { TxnDate: '2026-10-15' }), evidence = await readWritePeriodEvidence(req, fixture().client, () => now);
  assert.throws(() => check(req, evidence, null), /owner must/);
  assert.throws(() => check(req, evidence, { ...controls(), closedThrough: '2026-09-30' }), /changed/);
  assert.throws(() => check(req, evidence, controls(), now + 300001), /stale/);
});

for (const [entity, source] of [['payment', 'Invoice'], ['billpayment', 'Bill']]) test('new '+entity+' can settle an unchanged protected source on a later posting date', async () => {
 const req=request(entity,{TxnDate:'2026-10-15',Line:[{Amount:50,LinkedTxn:[{TxnType:source,TxnId:'10'}]}]});
 const client={read:async()=>({[source]:{Id:'10',SyncToken:'3',TxnDate:'2026-09-10'}}),query:async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{BookCloseDate:'2026-09-30'},SalesFormsPrefs:{AutoApplyCredit:false}}]}})};
 const evidence=await readWritePeriodEvidence(req,client,()=>now), proof=check(req,evidence,controls('2026-09-30'));
 assert.deepEqual(proof.affectedDates,['2026-10-15']);assert.equal(proof.evidence.records[0].syncToken,'3');assert.equal(proof.controls.closedThrough,'2026-09-30');
 const backdated=request(entity,{TxnDate:'2026-09-30',Line:[{Amount:50,LinkedTxn:[{TxnType:source,TxnId:'10'}]}]});
 assert.throws(()=>check(backdated,{...evidence,requestHash:backdated.requestHash}),/stale|changed/);
 const oldEvidence=await readWritePeriodEvidence(backdated,client,()=>now);assert.throws(()=>check(backdated,oldEvidence),/closed or reconciled/);
});

for(const [entity,source,detail] of [['invoice','Estimate','SalesItemLineDetail'],['bill','PurchaseOrder','ItemBasedExpenseLineDetail'],['deposit','Payment','DepositLineDetail']])test('new '+entity+' retains its own posting date across a closed source month',async()=>{
 const link={TxnType:source,TxnId:'10'}, line={Amount:50,DetailType:detail,...(entity==='deposit'?{LinkedTxn:[link]}:{})};
 const req=request(entity,{TxnDate:'2026-10-15',Line:[line],...(entity==='deposit'?{}:{LinkedTxn:[link]})});
 const client={read:async()=>({[source]:{Id:'10',SyncToken:'0',TxnDate:'2026-09-30'}}),query:async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{BookCloseDate:'2026-09-30'},SalesFormsPrefs:{AutoApplyCredit:false}}]}})};
 const evidence=await readWritePeriodEvidence(req,client,()=>now);assert.deepEqual(check(req,evidence,controls('2026-09-30')).affectedDates,['2026-10-15']);
});


test('invoice, credit memo and explicit credit application require a strict own false preference before admission',async()=>{
 const {AUTOMATIC_CREDITS_CODE}=require('../src/modules/qbo-write-period');
 for(const endpoint of ['invoice','creditmemo','payment']){
  const req=request(endpoint,{TxnDate:'2026-10-15',...(endpoint==='payment'?{Line:[{Amount:1,LinkedTxn:[{TxnType:'CreditMemo',TxnId:'20'}]}]}:{})});
  for(const sales of [undefined,null,[],{},'false',{AutoApplyCredit:true},{AutoApplyCredit:'false'},{AutoApplyCredit:0},{AutoApplyCredit:null},Object.create({AutoApplyCredit:false})]){
   const f=fixture();f.client.read=async()=>({CreditMemo:{Id:'20',SyncToken:'0',TxnDate:'2026-10-10'}});f.client.query=async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:sales}]}});
   await assert.rejects(readWritePeriodEvidence(req,f.client,()=>now),error=>error.code===AUTOMATIC_CREDITS_CODE&&error.qboStage==='write_admission'&&error.outcomeUnknown===false);
  }
  for(const accounting of [[],Object.create({BookCloseDate:'2026-09-30'})]){
   const f=fixture();f.client.read=async()=>({CreditMemo:{Id:'20',SyncToken:'0',TxnDate:'2026-10-10'}});f.client.query=async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:accounting,SalesFormsPrefs:{AutoApplyCredit:false}}]}});await assert.rejects(readWritePeriodEvidence(req,f.client,()=>now));
  }
  const f=fixture();f.client.read=async()=>({CreditMemo:{Id:'20',SyncToken:'0',TxnDate:'2026-10-10'}});const evidence=await readWritePeriodEvidence(req,f.client,()=>now);assert.equal(evidence.version,2);assert.equal(evidence.autoApplyCredit,false);assert.ok(check(req,evidence));assert.equal(f.calls.length,1,'Reuse the one existing Preferences GET');
 }
});
test('current credit proof cannot be downgraded, stripped, changed, moved or reused after expiry',async()=>{
 const req=request('invoice',{TxnDate:'2026-10-15'}),evidence=await readWritePeriodEvidence(req,fixture().client,()=>now),rehash=row=>{delete row.evidenceHash;return{...row,evidenceHash:hash(row)};};
 for(const change of [row=>{row.version=1;},row=>{delete row.autoApplyCredit;},row=>{row.autoApplyCredit=true;},row=>{row.autoApplyCredit=0;},row=>{row.scope.realmId='999';},row=>{row.requestHash=hash('different request');}]){
  const changed=structuredClone(evidence);change(changed);assert.throws(()=>check(req,rehash(changed)));
 }
 const changed=structuredClone(evidence);changed.preferencesHash=hash('changed without matching evidence hash');assert.throws(()=>check(req,changed));assert.throws(()=>check(req,evidence,controls(),now+300001));
 const untrusted=request('invoice',{TxnDate:'2026-10-15',autoApplyCredit:false,creditControl:false});await assert.rejects(readWritePeriodEvidence(untrusted,{query:async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:true}}]}})},()=>now));
});
test('unaffected creates and original-record updates retain the v1 period envelope without a credit flag',async()=>{
 for(const req of [request('estimate',{TxnDate:'2026-10-15'}),request('salesreceipt',{TxnDate:'2026-10-15'}),request('invoice',{Id:'10',SyncToken:'0',TxnDate:'2026-10-15'})]){
  const f=fixture({'invoice:10':{Id:'10',SyncToken:'0',TxnDate:'2026-10-05'}});f.client.query=async()=>({QueryResponse:{Preferences:[{AccountingInfoPrefs:{},SalesFormsPrefs:{AutoApplyCredit:true}}]}});const evidence=await readWritePeriodEvidence(req,f.client,()=>now);
  assert.equal(evidence.version,1);assert.equal(Object.hasOwn(evidence,'autoApplyCredit'),false);assert.ok(check(req,evidence));
 }
});
