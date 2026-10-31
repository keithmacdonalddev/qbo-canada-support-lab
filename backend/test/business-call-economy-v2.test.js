'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {harness,scope,clock,iso}=require('./helpers/business-economy-fixture');
const {hash}=require('../src/modules/business-calendar');
const {createBusinessTransactionBatchReader}=require('../src/modules/business-transaction-batch-reader');
const {readBusinessGuardRecord}=require('../src/modules/business-observation-store');
const {readWritePeriodEvidence}=require('../src/modules/qbo-write-period');
const {freezeWriteRequest}=require('../src/modules/qbo-write-contract');
const config=require('../src/config'),previous=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
const record=(id,extra={})=>({Id:id,SyncToken:'0',MetaData:{LastUpdatedTime:iso(clock-120000)},...extra});
const fence=revision=>({scope,operationId:'e'.repeat(24),revision});
function current(h,entity,id,extra={}){return h.add(entity,record(id,extra));}
function provider(h,rows){h.response=async options=>{const u=new URL(options.url),q=u.searchParams.get('query');assert.equal(options.method,'GET');if(!q){const id=u.pathname.split('/').at(-1),value=rows.find(r=>r.Id===id);return{Invoice:structuredClone(value)};}const ids=/WHERE Id IN \(([^)]+)\)/.exec(q)[1].split(',').map(id=>id.trim().replaceAll("'",''));const found=rows.filter(r=>ids.includes(r.Id));return{QueryResponse:{Invoice:structuredClone(found),startPosition:1,maxResults:found.length}};};}
test('exact-ID grouping shares unchanged revision reads, preserving observation times; same-token child writes, expiry and forced clears invalidate',async()=>{
 const h=harness(),rows=[record('1',{Balance:100}),record('2',{Balance:200})];provider(h,rows);
 const read=createBusinessTransactionBatchReader({access:h.access,now:()=>h.now}),steps=rows.map(r=>({entity:'Invoice',qboId:r.Id}));
 const first=await read(scope,steps,{writerFence:fence(1)});assert.equal(h.calls.length,1);assert.ok(new URL(h.calls[0].url).searchParams.get('query').startsWith('SELECT * FROM Invoice WHERE Id IN'));
 h.now+=1000;const reused=await read(scope,steps,{writerFence:fence(1)});assert.equal(h.calls.length,1);assert.equal(reused.get('Invoice:1').observedAt,first.get('Invoice:1').observedAt);
 rows[0].Balance=0;const changed=await read(scope,steps,{writerFence:fence(2)});assert.equal(changed.get('Invoice:1').record.Balance,0);assert.equal(h.calls.length,2,'a child save refreshes even with unchanged SyncToken');
 read.clear();await read(scope,steps,{writerFence:fence(2)});assert.equal(h.calls.length,3);
 h.now+=60001;await read(scope,steps,{writerFence:fence(2)});assert.equal(h.calls.length,4);
 const stop=new AbortController();stop.abort();await assert.rejects(read(scope,steps,{signal:stop.signal,writerFence:fence(2)}));assert.equal(h.calls.length,4);
 h.revoked=true;await assert.rejects(read(scope,steps,{writerFence:fence(2)}),/revoked/);
});
test('missing, duplicated, sparse, extra and foreign batch records fail closed; each group is bounded to 50 IDs',async()=>{
 const steps=[{entity:'Invoice',qboId:'1'},{entity:'Invoice',qboId:'2'}];
 for(const rows of [[record('1')],[record('1'),record('1')],[record('1',{sparse:true}),record('2')],[record('1'),record('9')]]){
  const h=harness();h.response=async()=>({QueryResponse:{Invoice:rows,startPosition:1,maxResults:rows.length}});await assert.rejects(createBusinessTransactionBatchReader({access:h.access,now:()=>h.now})(scope,steps),/omitted|partial|unrelated/);
 }
 const h=harness(),rows=Array.from({length:101},(_,i)=>record(String(i+1)));provider(h,rows);const result=await createBusinessTransactionBatchReader({access:h.access,now:()=>h.now})(scope,rows.map(r=>({entity:'Invoice',qboId:r.Id})));assert.equal(result.size,101);assert.equal(h.calls.length,3);
 const wrong=harness();provider(wrong,rows);wrong.client.connection.userId='f'.repeat(24);await assert.rejects(createBusinessTransactionBatchReader({access:wrong.access,now:()=>wrong.now})(scope,steps),/company or owner/);assert.equal(wrong.calls.length,0);
});
test('guard mirror needs a CDC boundary after the record change; snapshots, same-time changes and unresolved or late replies fall back',async()=>{
 const h=harness();current(h,'Invoice','1',{TxnDate:'2026-10-01'});assert.ok(await readBusinessGuardRecord(h.client,'Invoice','1',{store:h.store}));assert.equal(h.calls.length,0);
 for(const mutate of [h=>h.agents[0].sync.sources.Invoice.mode='snapshot',h=>h.records[0].record.MetaData.LastUpdatedTime=iso(clock-60000),h=>h.records[0].generation='other',h=>h.records[0].record.sparse=true,h=>h.agents[0].sync.amountReconciliation={status:'attention'},h=>h.receipts.push({...scope,entity:'invoice',state:'unknown',sentAt:new Date(clock-90000)}),h=>h.receipts.push({...scope,entity:'invoice',state:'saved',sentAt:new Date(clock-90000),observedAt:new Date(clock-1000)}),h=>h.receipts.push({...scope,entity:'payment',state:'unknown',sentAt:new Date(clock-90000),periodProof:{evidence:{records:[{entity:'Invoice',id:'1'}]}}})]){
  const f=harness();current(f,'Invoice','1',{TxnDate:'2026-10-01'});mutate(f);assert.equal(await readBusinessGuardRecord(f.client,'Invoice','1',{store:f.store}),null);
 }
 const stock=harness();current(stock,'Item','1',{Type:'Inventory',QtyOnHand:5});stock.receipts.push({...scope,entity:'batch',state:'unknown',sentAt:new Date(clock-90000)});assert.equal(await readBusinessGuardRecord(stock.client,'Item','1',{store:stock.store}),null);
});
test('period guard preserves exact linked dates and live closing preferences; edit targets always read live',async()=>{
 const h=harness(),saved=current(h,'Invoice','1',{TxnDate:'2026-10-01'});h.response=async options=>new URL(options.url).pathname.endsWith('/query')?{QueryResponse:{Preferences:[{AccountingInfoPrefs:{BookCloseDate:'2026-09-30'},SalesFormsPrefs:{AutoApplyCredit:false}}]}}:{Invoice:structuredClone(saved.record)};
 const request=freezeWriteRequest(scope,'POST','payment',{TxnDate:'2026-10-06',Line:[{Amount:50,LinkedTxn:[{TxnType:'Invoice',TxnId:'1'}]}]});
 const observed=await readWritePeriodEvidence(request,h.client,()=>h.now,null,h.store);assert.equal(h.calls.length,1);assert.equal(observed.qboClosedThrough,'2026-09-30');assert.equal(observed.records[0].recordHash,hash(saved.record));
 const edit=freezeWriteRequest(scope,'POST','invoice',{Id:'1',SyncToken:'0',TxnDate:'2026-10-06'});await readWritePeriodEvidence(edit,h.client,()=>h.now,null,h.store);assert.equal(h.calls.length,3,'target GET and live Preferences remain mandatory');
 h.agents[0].sync.sources.Invoice.status='error';await readWritePeriodEvidence(request,h.client,()=>h.now,null,h.store);assert.equal(h.calls.length,5,'stale mirror restores both live calls');
});
test('deposit absence source proves complete count, generation and post-payment coverage; pre-boundary pending sends and late replies refuse reuse',async()=>{
 const h=harness();current(h,'Deposit','10',{Line:[{Amount:1,DepositLineDetail:{AccountRef:{value:'2'}}}]});
 const result=await h.store.deposits(scope,iso(clock-120000));assert.equal(result.length,1);assert.equal(h.calls.length,0);
 assert.equal(await h.store.deposits(scope,iso(clock-60000)),null);
 for(const mutate of [h=>h.agents[0].sync.sources.Deposit.count++,h=>h.records[0].generation='old',h=>h.records[0].record.MetaData.LastUpdatedTime=iso(clock-30000),h=>h.receipts.push({...scope,entity:'deposit',state:'possibly-sent',sentAt:new Date(clock-90000)}),h=>h.receipts.push({...scope,entity:'batch',state:'saved',sentAt:new Date(clock-90000),observedAt:new Date(clock-1000)})]){
  const f=harness();current(f,'Deposit','10',{Line:[]});mutate(f);assert.equal(await f.store.deposits(scope,iso(clock-120000)),null);
 }
});

test('receipt-authenticated reuse survives verification-only revisions and refuses late replies, unresolved sends and newly synced changes',async()=>{
 const h=harness(),rows=[record('1',{Balance:100}),record('2',{Balance:200})];provider(h,rows);
 const read=createBusinessTransactionBatchReader({access:h.access,observations:h.store,now:()=>h.now}),steps=rows.map(r=>({entity:'Invoice',qboId:r.Id}));
 await read(scope,steps,{writerFence:fence(1)});h.now+=1000;await read(scope,steps,{writerFence:fence(5)});assert.equal(h.calls.length,1,'verification bookkeeping needs no second transport');
 h.receipts.push({...scope,entity:'payment',state:'saved',sentAt:new Date(clock-1000),observedAt:new Date(h.now)});rows[0].Balance=0;
 const changed=await read(scope,steps,{writerFence:fence(6)});assert.equal(changed.get('Invoice:1').record.Balance,0);assert.equal(h.calls.length,2);
 for(const mutate of [h=>h.receipts.push({...scope,state:'unknown',sentAt:new Date(clock-90000)}),h=>h.records.push({...scope,entity:'Invoice',qboId:'1',lastObservedAt:new Date(clock+1)})]){const f=harness();mutate(f);assert.equal(await f.store.unchanged(scope,clock),false);}
 const fail=harness();provider(fail,rows);const faulty=createBusinessTransactionBatchReader({access:fail.access,observations:{unchanged:async()=>{throw Error('offline read timeout');}},now:()=>fail.now});await faulty(scope,steps,{writerFence:fence(1)});await faulty(scope,steps,{writerFence:fence(1)});assert.equal(fail.calls.length,2,'unavailable safety evidence restores live observations');
});
