'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {harness,scope,clock}=require('./helpers/business-economy-fixture');
const {createBusinessTransactionBatchReader}=require('../src/modules/business-transaction-batch-reader');
const {createGeneralCloseReader}=require('../src/modules/general-write-close-reader');
const {generalRecordsFor}=require('../src/modules/general-write-day-close');
const config=require('../src/config'),originalEnvironment=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=originalEnvironment;});
const day='2026-11-01',clone=structuredClone;
const record=(id,extra={})=>({Id:id,SyncToken:'0',TxnDate:day,MetaData:{LastUpdatedTime:new Date(clock).toISOString()},...extra});
const chain=value=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>clone(value)});
function fixture(count=51){
 const h=harness(),native=new Map(Array.from({length:count},(_,i)=>['Invoice:'+String(i+1),record(String(i+1),{Balance:100})]));
 const run={_id:'c'.repeat(24),status:'complete',day,plan:{operations:[...native.values()].map(r=>({ref:'r'+r.Id,op:'create',entity:'Invoice',payload:{TxnDate:day}}))},items:Object.fromEntries([...native.values()].map(r=>['r'+r.Id,{entity:'Invoice',op:'create',outcome:'saved',qboId:r.Id,record:clone(r)}])),batches:[]};
 const Runs={find:()=>chain([run])};
 h.response=async options=>{
  const url=new URL(options.url),q=url.searchParams.get('query');
  if(q){const entity=/FROM ([A-Za-z]+)/.exec(q)[1],ids=/WHERE Id IN \(([^)]+)\)/.exec(q)[1].split(',').map(id=>id.trim().replaceAll("'",'')),rows=ids.map(id=>native.get(entity+':'+id)).filter(Boolean);return{QueryResponse:{[entity]:clone(rows),startPosition:1,maxResults:rows.length}};}
  const parts=url.pathname.split('/'),id=parts.at(-1),entity=[...native.keys()].map(k=>k.split(':')[0]).find(e=>e.toLowerCase()===parts.at(-2)),body=native.get(entity+':'+id);return{[entity]:clone(body)};
 };
 const copy=createGeneralCloseReader({scope,access:h.access,client:h.client,now:()=>h.now});
 return{h,native,run,Runs,copy,gather:()=>generalRecordsFor({Runs,scope,day,copy,now:()=>clock})};
}
test('close gathers exact IDs in fresh native groups for both windows instead of one GET per saved record',async()=>{
 const f=fixture(),before=await f.gather();assert.equal(before.records.length,51);
 assert.equal(f.h.calls.length,2,'51 invoice identities need two native requests: one query and one singleton GET');
 f.native.get('Invoice:1').Balance=25;
 const after=await f.gather();assert.equal(f.h.calls.length,4,'the second window issues two new requests without reusing the first');
 assert.equal(before.records.find(r=>r.id==='1').current.Balance,100);assert.equal(after.records.find(r=>r.id==='1').current.Balance,25,'same-token changes remain visible');
});

test('older records moved into the closing period are still observed; explicit delete tombstones are not queried',async()=>{
 const f=fixture(2);f.run.items.r1.record.TxnDate='2026-10-01';f.run.plan.operations[0].payload.TxnDate='2026-10-01';
 f.run.items.dead={entity:'Invoice',op:'delete',outcome:'deleted',qboId:'900',request:{SyncToken:'0'},before:record('900'),record:null};
 f.run.plan.operations.push({ref:'dead',op:'delete',entity:'Invoice',id:'900'});
 const gathered=await f.gather();assert.ok(gathered.records.some(row=>row.id==='1'&&row.current.TxnDate===day));
 const deleted=gathered.records.find(row=>row.id==='900');assert.equal(deleted.deleted,true);assert.equal(deleted.current,null);assert.equal(deleted.unavailable,false);
 assert.equal(f.h.calls.length,1);assert.doesNotMatch(new URL(f.h.calls[0].url).searchParams.get('query'),/'900'/);
});
test('unsupported entity GETs are the only fallback; grouped omissions, truncation and faults fail closed',async()=>{
 const f=fixture(2);f.native.set('Class:800',record('800',{Name:'Fictional class'}));f.run.items.class={entity:'Class',op:'create',outcome:'saved',qboId:'800',record:clone(f.native.get('Class:800'))};f.run.plan.operations.push({ref:'class',op:'create',entity:'Class',payload:{}});
 assert.equal((await f.gather()).records.length,3);assert.equal(f.h.calls.length,2);
 assert.ok(new URL(f.h.calls[0].url).searchParams.get('query'));assert.match(new URL(f.h.calls[1].url).pathname,/class\/800$/);
 for(const bad of [{QueryResponse:{Invoice:[record('1')],maxResults:1}},{QueryResponse:{Invoice:[record('1'),record('2')],maxResults:1}},{Fault:{Error:[{code:'500',Message:'Fixture query fault'}]}}]){
  const h=fixture(2);h.h.response=async()=>bad;await assert.rejects(h.gather(),/omitted|truncated/);assert.equal(h.h.calls.length,1,'a failed query never falls back to per-record GETs');
 }
 const missing=fixture(0);missing.native.set('Class:800',record('900'));await assert.rejects(missing.copy.readMany(scope,[{entity:'Class',qboId:'800'}]),/unavailable/);
});
test('each grouped record map is exact and company-bound; forged or incomplete maps do not trigger singleton fallback',async()=>{
 const f=fixture(2);await assert.rejects(f.copy.readMany({...scope,realmId:'999'},[{entity:'Invoice',qboId:'1'}]),/scope/);assert.equal(f.h.calls.length,0);
 await assert.rejects(f.copy.readMany(scope,[{entity:'Invoice',qboId:'1'},{entity:'Invoice',qboId:'1'}]),/unique/);
 for(const bad of [new Map(),new Map([['Invoice:1',record('2')],['Invoice:2',record('2')]]),new Map([['Invoice:1',record('1')],['Invoice:2',record('2')],['Invoice:3',record('3')]])]){
  f.copy.readMany=async()=>bad;await assert.rejects(f.gather(),/omitted|changed/);assert.equal(f.h.calls.length,0);
 }
 const read=createBusinessTransactionBatchReader({access:f.h.access});assert.equal(read.supports('Invoice'),true);assert.equal(read.supports('Class'),false);assert.throws(()=>{read.supports=()=>true;},TypeError);
});
test('prepare cancellation reaches grouped, supported singleton and unsupported GETs',async()=>{
 for(const mode of ['grouped','singleton','unsupported']){
  const f=fixture(mode==='grouped'?2:1),controller=new AbortController();
  const reader=createGeneralCloseReader({scope,access:f.h.access,client:f.h.client,signal:controller.signal,now:()=>f.h.now});
  const original=f.h.response;f.h.response=async options=>{controller.abort();return original(options);};
  const refs=mode==='unsupported'?[{entity:'Class',qboId:'800'}]:[...f.native.values()].map(row=>({entity:'Invoice',qboId:row.Id}));
  if(mode==='unsupported')f.native.set('Class:800',record('800'));
  await assert.rejects(reader.readMany(scope,refs));assert.equal(f.h.calls.length,1,mode);
  await assert.rejects(reader.read(scope,'Class','800'));assert.equal(f.h.calls.length,1,'cancelled readers send no further request');
 }
});
test('a before/after native mutation cannot produce a passing general close',async()=>{
 const f=fixture(2),closes=[];
 for(const row of f.native.values())Object.assign(row,{ARAccountRef:{value:'120'},CustomerRef:{value:'1'},TotalAmt:115,Line:[{Amount:100,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'40'},Qty:1,UnitPrice:100,TaxCodeRef:{value:'7'}}}],TxnTaxDetail:{TotalTax:15,TaxLine:[{Amount:15,TaxLineDetail:{TaxRateRef:{value:'8'}}}]}});
 for(const item of Object.values(f.run.items))item.record=clone(f.native.get('Invoice:'+item.qboId));
 f.native.set('Item:40',record('40',{Type:'Service',IncomeAccountRef:{value:'400'}}));
 const models={GeneralWriteRuns:f.Runs,GeneralDayCloses:{findOne:()=>chain(null),create:async([row])=>closes.push(row)},Records:{find:()=>chain([{qboId:'210',record:{AccountSubType:'GlobalTaxPayable'}}])}};
 const gate=require('../src/modules/general-write-close-gate').createGeneralCloseGate({models,copy:f.copy,now:()=>clock});
 const columns=['tx_date','txn_type','doc_num','name','memo','split_acc','debt_amt','credit_amt'].map(ColType=>({ColType}));let ledgerReads=0;
 const readLedger=async()=>{ledgerReads++;f.native.get('Invoice:1').Balance=100-ledgerReads;return{Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:day,EndPeriod:day},Columns:{Column:columns},Rows:{Row:[]}};};
 await assert.rejects(gate.assertPeriodReady(scope,{fromDate:day,throughDate:day,verifiedThrough:'2026-10-31',openingDate:'2026-10-01',mappings:{accountsReceivable:'120'},readLedger}),/records or posting references changed/);
 assert.equal(ledgerReads,2,'the existing single bounded re-read remains');assert.ok(closes.every(row=>row.ok===false));
});

test('inactive and externally changed masters retain exact GET coverage without active-filter query assumptions',async()=>{
 const f=fixture(2),refs=[];
 for(const [entity,id] of [['Customer','801'],['Vendor','802'],['Item','803']]){
  f.native.set(entity+':'+id,record(id,{Active:false,Name:'Fictional inactive master'}));refs.push({entity,qboId:id});
 }
 const first=await f.copy.readMany(scope,refs);assert.equal(first.size,3);assert.equal(f.h.calls.length,3);
 for(const call of f.h.calls){const url=new URL(call.url);assert.equal(url.searchParams.has('query'),false);assert.equal(call.method,'GET');}
 assert.ok([...first.values()].every(row=>row.Active===false));
 f.native.get('Customer:801').Active=true;
 const second=await f.copy.readMany(scope,refs);assert.equal(second.get('Customer:801').Active,true,'a later window observes external master changes');assert.equal(first.get('Customer:801').Active,false,'earlier window remains original');assert.equal(f.h.calls.length,6);
});

test('retained master cohort uses three inactive-inclusive exact queries instead of thirty GETs per fresh window',async()=>{
 const f=fixture(0),refs=[];for(const [entity,count,start]of [['Customer',25,800],['Vendor',3,900],['Item',2,950]])for(let i=0;i<count;i++){const id=String(start+i);f.native.set(entity+':'+id,record(id,{Active:i%2===0,Name:'Fictional master'}));refs.push({entity,qboId:id});}
 const first=await f.copy.readMany(scope,refs);assert.equal(first.size,30);assert.equal(f.h.calls.length,3);for(const call of f.h.calls)assert.match(new URL(call.url).searchParams.get('query'),/AND Active IN \(true,false\)/);
 f.native.get('Customer:800').Active=false;const second=await f.copy.readMany(scope,refs);assert.equal(f.h.calls.length,6);assert.equal(first.get('Customer:800').Active,true);assert.equal(second.get('Customer:800').Active,false);assert.ok([...second.values()].some(row=>row.Active===false));
});

test('inactive master groups retain singleton economy and every strict query failure without GET fallback',async()=>{
 const many=fixture(0),refs=Array.from({length:51},(_,i)=>({entity:'Customer',qboId:String(i+800)}));for(const ref of refs)many.native.set('Customer:'+ref.qboId,record(ref.qboId,{Active:false}));assert.equal((await many.copy.readMany(scope,refs)).size,51);assert.equal(many.h.calls.length,2);assert.match(new URL(many.h.calls[0].url).searchParams.get('query'),/Active IN \(true,false\)/);assert.equal(new URL(many.h.calls[1].url).searchParams.has('query'),false,'last singleton retains exact GET');
 for(const entity of ['Customer','Vendor','Item'])for(const mode of ['missing','duplicate','wrong-id','sparse','version','truncated','fault','error']){
  const f=fixture(0),rows=[record('800',{Active:false}),record('801',{Active:true})];if(mode==='missing')rows.pop();if(mode==='duplicate')rows[1]=rows[0];if(mode==='wrong-id')rows[1].Id='999';if(mode==='sparse')rows[0].sparse=true;if(mode==='version')rows[0].SyncToken='invalid';
  f.h.response=async()=>{if(mode==='error')throw Error('Fixture list transport error');return mode==='fault'?{Fault:{Error:[{code:'500',Message:'Fixture list query fault'}]}}:{QueryResponse:{[entity]:rows,startPosition:1,maxResults:mode==='truncated'?1:rows.length}};};
  await assert.rejects(f.copy.readMany(scope,[{entity,qboId:'800'},{entity,qboId:'801'}]),/omitted|truncated|partial|unrelated|Fixture list transport/);assert.equal(f.h.calls.length,1,entity+':'+mode+' cannot retry as GET');
 }
});
test('list query cancellation preserves the existing prepare abort boundary',async()=>{
 const f=fixture(0),controller=new AbortController();for(const id of ['800','801'])f.native.set('Customer:'+id,record(id,{Active:false}));const reader=createGeneralCloseReader({scope,access:f.h.access,client:f.h.client,signal:controller.signal,now:()=>f.h.now}),original=f.h.response;f.h.response=async options=>{controller.abort();return original(options);};
 await assert.rejects(reader.readMany(scope,[{entity:'Customer',qboId:'800'},{entity:'Customer',qboId:'801'}]));assert.equal(f.h.calls.length,1);await assert.rejects(reader.readMany(scope,[{entity:'Customer',qboId:'800'}]));assert.equal(f.h.calls.length,1);
});
