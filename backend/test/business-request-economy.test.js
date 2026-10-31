'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {hash}=require('../src/modules/business-calendar');
const {createBusinessObservationStore}=require('../src/modules/business-observation-store');
const {createBusinessReferenceReader,createBusinessTransactionReader,bindBusinessReference,verifyBusinessReference}=require('../src/modules/business-reference');
const {createBusinessTransactionBatchReader}=require('../src/modules/business-transaction-batch-reader');
const {createBusinessReportCache,assertReportReuse}=require('../src/modules/business-report-cache');
const {createBusinessReportReader}=require('../src/modules/business-report-evidence');
const {QBOClient}=require('../src/modules/qbo-client');
const {ENTITIES,SNAPSHOT_ONLY}=require('../src/modules/business-agent-sync');
const {fixture,period}=require('./helpers/business-report-fixtures');
const {packReport}=require('../src/modules/business-report-source');
const scope={realmId:'123',environment:'sandbox',connectionId:'a'.repeat(24)},ownerId='b'.repeat(24),actorId=ownerId;
const clock=Date.parse('2026-10-06T12:00:00.000Z'),iso=value=>new Date(value).toISOString(),copy=structuredClone;
const get=(obj,key)=>key.split('.').reduce((value,part)=>value?.[part],obj);
function matches(row,filter){return Object.entries(filter).every(([key,value])=>{
 if(key==='$or')return value.some(branch=>matches(row,branch));
 const actual=get(row,key);
 if(value instanceof Date)return new Date(actual).getTime()===value.getTime();
 if(value&&typeof value==='object')return Object.entries(value).every(([op,wanted])=>op==='$gte'?new Date(actual).getTime()>=new Date(wanted).getTime():op==='$in'?wanted.includes(actual):op==='$ne'?actual!==wanted:op==='$elemMatch'?Array.isArray(actual)&&actual.some(item=>matches(item,wanted)):false);
 return String(actual)===String(value);
 });}
function model(rows){return{findOne(filter){return cursor(()=>rows.find(row=>matches(row,filter))||null);},find(filter){return cursor(()=>rows.filter(row=>matches(row,filter)));},async updateOne(filter,update,options){let row=rows.find(row=>matches(row,filter));if(!row&&options?.upsert){row={...filter,...copy(update.$setOnInsert)};rows.push(row);}if(row)Object.assign(row,copy(update.$set));return{matchedCount:row?1:0};}};}
function cursor(read){let order,limit=Infinity;return{select(){return this;},sort(value){order=value;return this;},limit(value){limit=value;return this;},maxTimeMS(){return this;},async lean(){let value=copy(read());if(Array.isArray(value)){if(order)value.sort((a,b)=>{for(const [key,direction]of Object.entries(order)){const cmp=String(get(a,key)).localeCompare(String(get(b,key)));if(cmp)return cmp*direction;}return 0;});return value.slice(0,limit);}return value;}};}
function harness(){
 const h={now:clock,records:[],receipts:[],audits:[],writers:[{...scope,unresolved:null}],agents:[{...scope,sync:{sources:{}}}]};
 for(const entity of ENTITIES)h.agents[0].sync.sources[entity]={entity,mode:SNAPSHOT_ONLY.includes(entity)?'snapshot':'cdc',phase:'incremental',status:'current',generation:'fixture-generation',startedAt:iso(clock-120000),since:iso(clock-60000),lastSuccessAt:iso(clock-10000),everyMs:300000,count:0};
 h.models={Records:model(h.records),Agents:model(h.agents),Receipts:model(h.receipts),Audits:model(h.audits),Writers:model(h.writers),now:()=>h.now};
 h.store=createBusinessObservationStore(h.models);h.cache=createBusinessReportCache(h.models);
 h.add=(entity,record,extra={})=>{const row={...scope,entity,qboId:record.Id,record:copy(record),deleted:false,generation:'fixture-generation',lastObservedAt:new Date(clock-10000),lastReadStartedAt:new Date(clock-120000),...extra};h.records.push(row);h.agents[0].sync.sources[entity].count++;return row;};
 h.saved=(entity='Bill',record={Id:'100',SyncToken:'0',TxnDate:'2026-10-06',TotalAmt:113,Empty:{}})=>{
  const payload={[entity]:copy(record)},observed={outcome:'saved',entity:entity.toLowerCase(),operation:'create',httpStatus:200,qboId:record.Id,syncToken:record.SyncToken,responseHash:crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),intuitTid:null},dispatchKey=hash('dispatch'),requestHash=hash('request'),receiptId=hash({scope,dispatchKey});
  const receipt={...scope,_id:receiptId,kind:'business',operationId:'c'.repeat(24),logicalKey:hash('step'),ownerId,actorId,dispatchKey,requestHash,operation:'create',entity:entity.toLowerCase(),state:'saved',observed,savedResponse:payload,sentAt:new Date(clock-1000),observedAt:new Date(clock),startAuditId:hash({receiptId,event:'started'}).slice(0,24),resultAuditId:hash({receiptId,event:'response',observed}).slice(0,24)};
  h.receipts.push(receipt);const inputParams={environment:scope.environment,connectionId:scope.connectionId,dispatchKey,requestHash,entity:receipt.entity,operation:'create'};
  for(const [id,action,outcome,afterState]of [[receipt.startAuditId,'QuickBooks write dispatch recorded','partial',{state:'possibly-sent',receiptId}],[receipt.resultAuditId,'QuickBooks write response recorded','success',{state:'saved',receiptId,...observed}]])h.audits.push({_id:id,userId:ownerId,realmId:scope.realmId,action,actionType:'manual',outcome,inputParams,afterState});
  return receipt;
 };
 h.client=Object.create(QBOClient.prototype);h.calls=[];
 Object.assign(h.client,{realmId:scope.realmId,connection:{_id:scope.connectionId,userId:ownerId,realmId:scope.realmId,status:'active'},ensureFreshToken:async()=>{},_requestLog:[],_retryAfterUntil:0,_windowMs:60000,requestMeter:{record(){}},oauthClient:{makeApiCall:async options=>{h.calls.push(options);return{status:200,json:await h.response(options)};}}});
 h.access={authorize:async()=>{if(h.revoked)throw Error('permission revoked');return{actorId,ownerId};},resolveClient:async()=>h.client};
 return h;
}
test('current complete mirror supplies references and still enforces every approved definition field',async()=>{
 const h=harness(),row=h.add('Account',{Id:'1',SyncToken:'0',Active:true,Name:'Bank',AccountType:'Bank',CurrencyRef:{value:'CAD'}});
 const reader=createBusinessReferenceReader({...h.access,now:()=>h.now,observationStore:h.store});
 const observed=await reader(scope,'Account','1'),binding=bindBusinessReference({scope,key:'bank',entity:'Account',observed,now:h.now});
 assert.equal(h.calls.length,0);assert.equal(observed.source.kind,'qbo-current-mirror');assert.equal(verifyBusinessReference({scope,binding,observed,now:h.now}).Id,'1');
 row.record.AccountType='Expense';row.record.SyncToken='1';const changed=await reader(scope,'Account','1');assert.throws(()=>verifyBusinessReference({scope,binding,observed:changed,now:h.now}),/definition/);
});
test('snapshot tax definitions use their actual sync cadence with explicit old completion provenance',async()=>{
 const h=harness();h.add('TaxCode',{Id:'1',SyncToken:'0',Active:true,Taxable:false});
 const source=h.agents[0].sync.sources.TaxCode;source.everyMs=6*3600000;source.lastSuccessAt=iso(clock-3*3600000);
 const observed=await h.store.read(scope,'TaxCode','1');assert.equal(observed.source.completedAt,source.lastSuccessAt);assert.equal(observed.observedAt,iso(clock));
 assert.doesNotThrow(()=>bindBusinessReference({scope,key:'tax',entity:'TaxCode',observed,now:clock}));
 h.now+=10*3600000;assert.equal(await h.store.read(scope,'TaxCode','1'),null);
});
test('stale, wrong-generation, partial, deleted, failed and saturated mirror sources need a live read',async()=>{
 for(const mutate of [h=>h.now+=11*60000,h=>h.records[0].generation='old',h=>h.records[0].record.sparse=true,h=>h.records[0].deleted=true,h=>h.agents[0].sync.sources.Account.status='saturated',h=>h.agents[0].sync.sources.Account.error='fixture']){
  const h=harness();h.add('Account',{Id:'1',SyncToken:'0',Active:true,AccountType:'Bank'});mutate(h);assert.equal(await h.store.read(scope,'Account','1'),null);
 }
});
test('saved response verifies without GET, retains mirror record and keeps complete empty objects',async()=>{
 const h=harness(),receipt=h.saved(),reader=createBusinessTransactionReader({...h.access,now:()=>h.now,observationStore:h.store});
 const observed=await reader(scope,'Bill','100');assert.equal(h.calls.length,0);assert.deepEqual(observed.record,receipt.savedResponse.Bill);assert.equal(observed.source.kind,'qbo-write-response');assert.equal(h.records[0].record.Empty.constructor,Object);assert.equal(h.agents[0].sync.sources.Bill.lastSuccessAt,iso(clock-10000));
});
test('tampered body, audit, wrong company, expired response, sparse response and CDC tombstones cannot replace a live read',async()=>{
 for(const mutate of [h=>h.receipts[0].savedResponse.Bill.TotalAmt++,h=>h.audits[1].outcome='partial',h=>h.receipts[0].connectionId='d'.repeat(24),h=>h.now+=300001,h=>{const p=h.receipts[0].savedResponse;p.Bill.sparse=true;h.receipts[0].observed.responseHash=crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');},h=>h.add('Bill',{Id:'100',SyncToken:'0',status:'Deleted'},{deleted:true,lastObservedAt:new Date(clock+1)}),h=>h.add('Bill',{Id:'100',SyncToken:'1',TotalAmt:999},{lastObservedAt:new Date(clock+1)})]){
  const h=harness();h.saved();mutate(h);assert.equal(await h.store.saved(scope,'Bill','100'),null);
 }
});
test('payment invalidates original invoice response until a subsequent CDC covers its changed balance',async()=>{
 const h=harness(),receipt=h.saved('Invoice',{Id:'100',SyncToken:'0',Balance:113,TotalAmt:113});
 h.add('Invoice',receipt.savedResponse.Invoice);h.now+=2000;
 h.receipts.push({...scope,_id:hash('payment'),entity:'payment',state:'saved',sentAt:new Date(clock+1000),observedAt:new Date(clock+1500),periodProof:{evidence:{records:[{entity:'Invoice',id:'100'}]}}});
 assert.equal(await h.store.saved(scope,'Invoice','100'),null);assert.equal(await h.store.read(scope,'Invoice','100',{transactions:true}),null);
 const source=h.agents[0].sync.sources.Invoice;source.since=iso(clock+1600);source.lastSuccessAt=iso(clock+1800);h.records[0].record.Balance=0;
 const observed=await h.store.read(scope,'Invoice','100',{transactions:true});assert.equal(observed.record.Balance,0);
});
test('mirror merge cannot overwrite a newer version or a later read',async()=>{
 for(const extra of [{record:{Id:'100',SyncToken:'2'}},{lastReadStartedAt:new Date(clock+1)}]){
 const h=harness();h.add('Bill',{Id:'100',SyncToken:'0'},extra);assert.equal(await h.store.retain(scope,'Bill',{Id:'100',SyncToken:'1'},iso(clock)),false);
 }
});
test('slow mirror retention still obeys deadline and authority checks',async()=>{
 for(const mutate of [h=>h.now+=60001,h=>h.revoked=true]){
 const h=harness();h.saved();const store={...h.store,retain:async()=>mutate(h)};
 await assert.rejects(createBusinessTransactionReader({...h.access,now:()=>h.now,observationStore:store})(scope,'Bill','100'));
 }
});
test('changed parent reads are one full query per type, and partial pages fail closed',async()=>{
 const h=harness(),steps=[{entity:'Invoice',qboId:'1'},{entity:'Invoice',qboId:'2'},{entity:'Bill',qboId:'3'}];
 h.response=async options=>{const q=new URL(options.url).searchParams.get('query'),entity=q.includes('FROM Invoice')?'Invoice':'Bill',ids=entity==='Invoice'?['1','2']:['3'];return{QueryResponse:{[entity]:ids.map(Id=>({Id,SyncToken:'1',Balance:0})),startPosition:1,maxResults:ids.length}};};
 const read=createBusinessTransactionBatchReader({access:h.access,observations:h.store,now:()=>h.now});const result=await read(scope,steps);assert.equal(result.size,3);assert.equal(h.calls.length,2);assert.ok(h.calls.every(call=>new URL(call.url).searchParams.get('query').startsWith('SELECT * FROM')));
 h.response=async()=>({QueryResponse:{Invoice:[{Id:'1',SyncToken:'1'}]}});await assert.rejects(read(scope,steps),/omitted|truncated/);
});
function reports(h){const raw=fixture({critical:true});raw.TrialBalance.Rows.Row[0].ColData[0].id='1';raw.TrialBalance.Rows.Row[1].ColData[0].id='2';const accounts=[{Id:'1',SyncToken:'0',AccountType:'Accounts Receivable'},{Id:'2',SyncToken:'0',AccountType:'Accounts Payable'}];return{raw,source:{version:3,scope,period,startedAt:iso(clock-3000),observedAt:iso(clock-2000),reports:Object.fromEntries(Object.entries(raw).map(([name,value])=>[name,packReport(name,value,3)])),accounts}};}
test('one report set survives reader instances and is reused only after later unchanged CDC plus live ledger probe',async()=>{
 const h=harness();h.add('CompanyInfo',{Id:'1',SyncToken:'0'});const {source,raw}=reports(h),before=await h.cache.snapshot(scope);await h.cache.retain(scope,source,before);
 assert.equal(await h.cache.load(scope,period,before,{readLedger:async()=>raw.GeneralLedger}),null,'CDC completion alone is not coverage after the report');
 for(const s of Object.values(h.agents[0].sync.sources)){s.since=iso(clock-1000);s.lastSuccessAt=iso(clock);}
 const next=createBusinessReportCache(h.models),token=await next.snapshot(scope);let probes=0;
 const cached=await next.load(scope,period,token,{readLedger:async()=>{probes++;return raw.GeneralLedger;}});
 assert.equal(probes,1);assert.equal(cached.evaluation.status,'checks-passed');assert.equal(cached.reuse.sourceHash,hash(source));assert.doesNotThrow(()=>assertReportReuse(cached));
 const broken=copy(cached);broken.reuse.sourceHash=hash('tampered');assert.throws(()=>assertReportReuse(broken));
 const {sourceHash,evaluation,...retained}=cached;assert.equal(hash(retained),sourceHash);
});
test('record changes without new SyncToken, deletions, pending writes, new day, or changed ledger invalidate reports',async()=>{
 for(const mutate of [h=>h.records[0].record.Name='changed with same token',h=>h.records[0].deleted=true,h=>h.receipts.push({...scope,_id:'pending',state:'possibly-sent',sentAt:new Date(clock)}),h=>h.now+=86400000]){
 const h=harness();h.add('CompanyInfo',{Id:'1',SyncToken:'0'});h.add('Account',{Id:'1',SyncToken:'0',Name:'Bank'});const {source,raw}=reports(h);await h.cache.retain(scope,source,await h.cache.snapshot(scope));for(const s of Object.values(h.agents[0].sync.sources)){s.since=iso(clock-1000);s.lastSuccessAt=iso(clock);}mutate(h);const token=await h.cache.snapshot(scope);assert.equal(await h.cache.load(scope,period,token,{readLedger:async()=>raw.GeneralLedger}),null);
 }
 const h=harness();h.add('CompanyInfo',{Id:'1',SyncToken:'0'});const {source,raw}=reports(h);await h.cache.retain(scope,source,await h.cache.snapshot(scope));for(const s of Object.values(h.agents[0].sync.sources)){s.since=iso(clock-1000);s.lastSuccessAt=iso(clock);}raw.GeneralLedger.Header.Currency='USD';assert.equal(await h.cache.load(scope,period,await h.cache.snapshot(scope),{readLedger:async()=>raw.GeneralLedger}),null);
});
test('report reader uses one probe for a cache hit, and reuses a changed probe in one refreshed seven-report set',async()=>{
 for(const hit of [true,false]){
 const h=harness(),{raw}=reports(h);h.response=async options=>{const name=new URL(options.url).pathname.split('/').at(-1);return name==='query'?{QueryResponse:{Account:[{Id:'1',SyncToken:'0',AccountType:'Accounts Receivable'},{Id:'2',SyncToken:'0',AccountType:'Accounts Payable'}],startPosition:1,maxResults:2}}:raw[name];};
 const cached={status:'fixture-cache-hit'},cache={snapshot:async()=>({}),load:async(_s,_p,_t,{readLedger})=>{await readLedger();return hit?cached:null;},retain:async()=>{}};
 const result=await createBusinessReportReader({access:h.access,now:()=>h.now,cache})(scope,period);assert.equal(h.calls.length,hit?1:8);assert.equal(h.calls.filter(call=>call.url.includes('reports/GeneralLedger')).length,1);if(hit)assert.equal(result,cached);else assert.equal(result.evaluation.status,'checks-passed');
 }
});

test('known master updates invalidate reference mirrors before CDC, while financial balance writes do not invalidate definitions',async()=>{
 for(const entity of ['Account','Item','TaxCode']){
 const h=harness();h.add(entity,{Id:'1',SyncToken:'0',Active:true});
 h.receipts.push({...scope,_id:hash('master update'),entity:entity.toLowerCase(),state:'saved',sentAt:new Date(clock-1000),observed:{qboId:'1'}});
 assert.equal(await h.store.read(scope,entity,'1'),null);
 }
 const h=harness();h.add('Customer',{Id:'1',SyncToken:'0',Active:true});h.receipts.push({...scope,entity:'invoice',state:'saved',sentAt:new Date(clock-1000),periodProof:{evidence:{records:[{entity:'Customer',id:'1'}]}}});assert.ok(await h.store.read(scope,'Customer','1'));
});
test('stale snapshot sources refuse report cache even if the stored status still says current',async()=>{
 const h=harness();h.add('CompanyInfo',{Id:'1',SyncToken:'0'});h.agents[0].sync.sources.CompanyInfo.lastSuccessAt=iso(clock-11*60000);assert.equal(await h.cache.snapshot(scope),null);
});
