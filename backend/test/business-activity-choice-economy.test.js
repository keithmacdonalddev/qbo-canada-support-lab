'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createActivityChoiceClient } = require('../src/modules/business-activity-choice-client');
const { readBusinessMasters } = require('../src/modules/business-master-data');
const { readDraftSetup } = require('../src/modules/blueprint-draft');
const { callerForRequest, runWithCaller, runWithCategory } = require('../src/modules/qbo-request-meter');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) };
const clock = Date.now();
function fixture() {
 const h = { reads: 0, sourceQueries: 0, rows: [], sources: {} };
 for (const entity of ['Account','TaxCode','Preferences','Customer','Vendor','Employee','Item','Invoice','Payment']) h.sources[entity] = { status:'current',generation:'g',lastSuccessAt:new Date(clock).toISOString(),everyMs:60000 };
 // Mongoose queries are thenable and single-use; lean() does not execute them.
 const q = value => { let executed = false; return { select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean(){return this;},exec(){if(executed)return Promise.reject(Error('Query was already executed'));executed=true;return Promise.resolve(value);},then(resolve,reject){return this.exec().then(resolve,reject);} }; };
 h.Records = { find: filter => { h.reads++; assert.equal(filter.connectionId,scope.connectionId); assert.equal(filter.deleted,false); return q(h.rows.filter(row=>row.entity===filter.entity && row.generation===filter.generation)); } };
 h.Agents = { findOne: filter => { h.sourceQueries++; assert.deepEqual(filter,scope); return q({ sync:{sources:h.sources} }); } };
 h.add = (entity,record) => h.rows.push({entity,qboId:record.Id,record,generation:'g'});
 h.client = createActivityChoiceClient({scope,Records:h.Records,Agents:h.Agents,now:()=>clock}); return h;
}
test('activity choices run existing master/setup readers from the mirror with no provider client', async()=>{
 const h=fixture(); h.add('Account',{Id:'1',SyncToken:'0',Active:true,AccountType:'Bank'}); h.add('Preferences',{Id:'1',AccountingInfoPrefs:{},CurrencyPrefs:{HomeCurrency:{value:'CAD'}}});
 const masters=await readBusinessMasters(h.client,scope),setup=await readDraftSetup(h.client,scope);
 assert.ok(Object.values(masters.completeness).every(Boolean)); assert.equal(setup.complete,true); assert.equal(setup.options.accounts[0].id,'1'); assert.equal(h.reads,7); assert.equal(h.client.source.provisional,true); assert.equal(h.sourceQueries,1); assert.deepEqual(h.client.source.unavailable,[]);
});

test('lean Mongo rows return only the QBO JSON payload for concurrent query and entity reads',async()=>{
 const h=fixture(),{Types}=require('mongoose'),{canonical}=require('../src/modules/business-calendar');
 const stamp=new Date('2026-10-31T23:00:00.000Z');
 h.add('Customer',{Id:'1',SyncToken:'0',Active:true,DisplayName:'Fixture customer',MetaData:{CreateTime:stamp},optional:undefined});
 h.add('Invoice',{Id:'11024',SyncToken:'0',Balance:10,MetaData:{LastUpdatedTime:stamp},optional:undefined});
 for(const row of h.rows)Object.assign(row,{_id:'synced-'+row.qboId,connectionId:new Types.ObjectId(scope.connectionId),createdAt:stamp,lastObservedAt:stamp});
 assert.throws(()=>canonical(h.rows[0]),/plain JSON/);
 const [query,read,api]=await Promise.all([h.client.query('SELECT * FROM Customer'),h.client.read('Invoice','11024'),h.client.apiCall('GET','invoice/11024')]);
 const customer={Id:'1',SyncToken:'0',Active:true,DisplayName:'Fixture customer',MetaData:{CreateTime:stamp.toISOString()}};
 const invoice={Id:'11024',SyncToken:'0',Balance:10,MetaData:{LastUpdatedTime:stamp.toISOString()}};
 assert.deepEqual(query.QueryResponse.Customer,[customer]);assert.deepEqual(read,{Invoice:invoice});assert.deepEqual(api,read);
 assert.doesNotThrow(()=>canonical(query));assert.doesNotThrow(()=>canonical(read));assert.equal(h.sourceQueries,1);assert.equal(h.reads,2);assert.deepEqual(h.client.source.unavailable,[]);
 assert.ok(h.rows[0].record.MetaData.CreateTime instanceof Date);assert.equal(h.rows[0].connectionId._bsontype,'ObjectId');
});
test('one advisory snapshot reuses records and cannot escape into live endpoints',async()=>{
 const h=fixture();h.add('Invoice',{Id:'11024',SyncToken:'0',Balance:0});
 const a=await h.client.apiCall('GET','invoice/11024');a.Invoice.Balance=10;
 assert.equal((await h.client.read('Invoice','11024')).Invoice.Balance,0);assert.equal(h.reads,1);
 await assert.rejects(h.client.apiCall('POST','invoice/11024'));await assert.rejects(h.client.apiCall('GET','reports/GeneralLedger'));await assert.rejects(h.client.query('SELECT * FROM Invoice'));
});
test('stale, partial, missing and wrong-generation advisory data never trigger provider fallback',async()=>{
 const h=fixture();h.sources.Invoice.status='error';assert.deepEqual(await h.client.read('Invoice','1'),{});assert.equal(h.reads,0);
 const p=fixture();p.add('Invoice',{Id:'1',sparse:true});assert.deepEqual(await p.client.read('Invoice','1'),{});
 const g=fixture();g.add('Invoice',{Id:'1',SyncToken:'0'});g.rows[0].generation='old';assert.deepEqual(await g.client.read('Invoice','1'),{});
 const c=new AbortController();c.abort();const client=createActivityChoiceClient({scope,Records:g.Records,Agents:g.Agents,signal:c.signal,now:()=>clock});await assert.rejects(client.read('Invoice','1'));
});
test('transport source attribution discards stack text and preserves explicit caller and sync context',async()=>{
 assert.equal(callerForRequest('at readRecord (C:\\Projects\\qbo\\backend\\src\\modules\\business-governance-service.js:418:2)'), 'source-modules-business-governance-service');
 assert.equal(callerForRequest('at preflight (C:/Projects/qbo/backend/src/modules/qbo-write-gate.js:321:2)'), 'source-modules-qbo-write-gate');
 assert.equal(callerForRequest('secret /tmp/arbitrary-module.js:1:1'),'qbo-direct');
 assert.equal(await runWithCaller('business-transaction',()=>callerForRequest('')), 'business-transaction');
 assert.equal(await runWithCategory('sync',()=>callerForRequest('')), 'business-sync');
});

const { isDiscretionaryGeneralWrite: discretionary } = require('../src/modules/business-request-budget');
const payment = (total = 10) => ({ref:'payment',op:'create',entity:'Payment',payload:{TotalAmt:total,Line:[{Amount:10,LinkedTxn:[{TxnType:'Invoice',TxnId:'11024'}]}]}});
test('budget reserve admits only exact applications and existing-payment deposits',()=>{
 assert.equal(discretionary([payment()]),false);
 const credit=payment(0);credit.payload.Line.push({Amount:10,LinkedTxn:[{TxnType:'CreditMemo',TxnId:'11025'}]});assert.equal(discretionary([credit]),false);
 const deposit={ref:'deposit',op:'create',entity:'Deposit',payload:{Line:[{Amount:10,LinkedTxn:[{TxnType:'Payment',TxnId:{$ref:'payment'}}]}]}};
 assert.equal(discretionary([payment(),deposit]),false);assert.equal(discretionary([deposit]),true);
 assert.equal(discretionary([{...deposit,payload:{Line:[{Amount:10,LinkedTxn:[{TxnType:'Payment',TxnId:'11133'}]}]}}]),false);
 assert.equal(discretionary([{ref:'sale',op:'create',entity:'Invoice',payload:{}},payment()]),true);
 for(const total of [10000,9,NaN,'10',10.001]) assert.equal(discretionary([payment(total)]),true);
 const zero=payment(0);zero.payload.Line[0].Amount=0;assert.equal(discretionary([zero]),true);
 const update={...payment(),op:'update',id:'11135'};assert.equal(discretionary([update]),false);delete update.payload.TotalAmt;assert.equal(discretionary([update]),true);
 assert.equal(discretionary([]),true);assert.equal(discretionary(null),true);
});

test('the general tool admits exact obligations at the cap and holds new sales and overpayments',async t=>{
 const general=require('../src/modules/general-write-service'),original=general.createDefaultGeneralWrite;let prepared=0,executed=0;const events=[];
 general.createDefaultGeneralWrite=()=>({prepare:async()=>{prepared++;return{runId:'reserve-run',status:'prepared',admitted:false};},dispatchEnabled:()=>true,execute:async()=>{executed++;return{status:'complete'};}});t.after(()=>{general.createDefaultGeneralWrite=original;});
 const ownerId='b'.repeat(24),agentId='c'.repeat(24),grantId='grant-reserve',authorityHash='d'.repeat(64);
 const tools=require('../src/modules/business-agent-tools').createBusinessAgentTools({row:{_id:agentId,ownerId,grant:{id:grantId,authorityHash},settings:{instructions:''}},passId:'reserve-test',scope,user:{id:ownerId},now:()=>Date.parse('2026-10-31T22:00:00Z'),guard:async()=>{},signal:new AbortController().signal,
 store:{event:async(_row,kind,_title,_detail,data)=>{assert.ok(['accountant-write-decision','accountant-write-link','accountant-write-outcome-complete'].includes(kind));if(kind!=='accountant-write-outcome-complete')assert.equal(data.passId,'reserve-test');events.push({kind,data});return {id:'decision-reserve',...data};},models:{Runs:{find:()=>({select(){return this},limit(){return this},maxTimeMS(){return this},lean:async()=>[]})}},business:async()=>({scope,blockers:[],verifiedThrough:'2026-10-30',currentOperation:null}),unfinishedRuns:async()=>[]},access:{authorize:async()=>{}},readTools:{toolDefinitions:[],toolHandlers:{}},
 todayFor:async()=>({day:'2026-10-31',target:220,ceiling:440,saved:85,reserved:0,inFlight:0,open:[],hourCap:60,hourUsed:0}),requestsFor:async()=>{const attempts={sync:300,report:1000,query:1000,read:8000,write:89};return{today:{attempts},month:{attempts}};}});
 const input=operations=>({decisionKey:'budget-reserve-test',purpose:'Settle an existing customer obligation.',operations});
 assert.equal((await tools.execute('manageQboRecord',input([payment()]))).success,true);assert.deepEqual([prepared,executed],[1,1]);assert.deepEqual(events.map(e=>e.kind),['accountant-write-decision','accountant-write-link','accountant-write-outcome-complete']);assert.equal(events[1].data.operationId,'reserve-run');
 await assert.rejects(tools.execute('manageQboRecord',input([{ref:'sale',op:'create',entity:'Invoice',payload:{}}])),/request budget/);
 await assert.rejects(tools.execute('manageQboRecord',input([payment(10000)])),/request budget/);assert.deepEqual([prepared,executed],[1,1]);
});
test('every client transport attempt and success has a caller tag',async()=>{
 const {QBOClient}=require('../src/modules/qbo-client'),config=require('../src/config'),prior=config.qbo.environment;config.qbo.environment='sandbox';
 const tags=[],client=Object.create(QBOClient.prototype);Object.assign(client,{connection:{_id:scope.connectionId,realmId:scope.realmId,userId:'b'.repeat(24),status:'active'},realmId:scope.realmId,_requestLog:[],_windowMs:60000,_retryAfterUntil:0,ensureFreshToken:async()=>{},requestMeter:{record:(_scope,_category,_kind,caller)=>tags.push(caller)},oauthClient:{makeApiCall:async()=>({status:200,json:{QueryResponse:{}}})}});
 try{await client.query('SELECT * FROM Customer');await runWithCaller('business-transaction',()=>client.apiCall('GET','invoice/11024'));}finally{config.qbo.environment=prior;}
 assert.deepEqual(tags,['qbo-direct','qbo-direct','business-transaction','business-transaction']);
});
