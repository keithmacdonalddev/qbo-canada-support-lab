'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {activityDefinition}=require('../src/modules/business-activity-preview');
const {planBusinessCalendar,shift,canonical}=require('../src/modules/business-calendar');
const {fixture}=require('./helpers/business-governance-fixture');
const {unpackReports,MAX_SOURCE_BYTES,MAX_DECODED_BYTES}=require('../src/modules/business-report-source');
const config=require('../src/config'),previous=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
test('version2 flagship rolling31-day windows retain every follow-up inside the500-create ceiling across leap and year boundaries',()=>{
 const definition=activityDefinition({openingDate:'2023-01-01',volumeProfile:'flagship',activityTemplateVersion:2}),counts=new Map();
 for(const [fromDate,throughDate]of [['2024-01-01','2024-12-31'],['2025-01-01','2025-12-31'],['2026-01-01','2026-01-30']]){
  const plan=planBusinessCalendar({definition,scope:{realmId:'123',environment:'sandbox'},fromDate,throughDate,today:'2026-12-31'});
  for(const event of plan.events)counts.set(event.txnDate,(counts.get(event.txnDate)||0)+1);
 }
 let maximum=0,period;for(let day='2024-01-01';day<='2025-12-31';day=shift(day,1)){let count=0;for(let i=0;i<31;i++)count+=counts.get(shift(day,i))||0;if(count>maximum){maximum=count;period={fromDate:day,throughDate:shift(day,30)};}}
 assert.ok(maximum>=278);assert.ok(maximum<=500);console.log(JSON.stringify({version2Maximum:maximum,period,createCeiling:500}));
});
test('actual version2 flagship first month executes and retains seven reports within existing evidence budgets',{timeout:180000},async()=>{
 const h=fixture({volumeProfile:'flagship',activityTemplateVersion:2,copyOnWriteTransactions:true});await h.publish();
 const prepared=await h.service.prepare(h.user,{requestKey:'lifecycle-flagship-capacity-0001',throughDate:'2026-10-31'});await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});
 // Original first-month202 records plus6 overhead records, less1 stock and2 care payments moved into later periods.
 assert.equal(h.data.Plans[0].manifest.createCount,205);const result=await h.runtime(prepared.operationId).execute();assert.equal(result.complete,true,JSON.stringify(result));assert.equal(h.posts,205);
 const saved=h.data.Evidence[0],decoded=unpackReports(saved.sources),retainedBytes=Buffer.byteLength(canonical(saved.sources)),decodedBytes=Object.values(decoded).reduce((n,row)=>n+Buffer.byteLength(canonical(row)),0),bsonBytes=require('mongoose').mongo.BSON.calculateObjectSize(saved);
 assert.ok(retainedBytes<MAX_SOURCE_BYTES*.8);assert.ok(decodedBytes<MAX_DECODED_BYTES*.8);assert.ok(bsonBytes<12000000);assert.equal(Object.keys(decoded).length,7);assert.ok(decoded.GeneralLedger.Rows.Row.some(row=>row.ColData?.[2]?.id===h.mappings.operatingExpense));
 // Cohort012 receives36 units on October31 and sells30 on November2.
 const stock=()=>Object.fromEntries([...h.records.values()].filter(row=>row.entity==='Item'&&row.record.Type==='Inventory').map(row=>[row.record.Name,row.record.QtyOnHand]));
 assert.deepEqual(stock(),{'workshop-stock-1':18,'workshop-stock-2':48,'workshop-stock-3':18,'workshop-stock-4':18,'workshop-stock-5':18});
 const followup=await h.service.prepare(h.user,{requestKey:'lifecycle-flagship-capacity-0002',throughDate:'2026-11-02'}),carry=h.data.Intents.find(row=>row.step.details.origin?.ruleKey==='supply-order-012'&&row.step.details.origin.occurrence==='2026-10-28'&&row.step.entity==='SalesReceipt');assert.ok(carry);assert.equal(carry.step.txnDate,'2026-11-02');assert.equal(carry.step.details.lines[0].quantity,30);assert.deepEqual(carry.step.details.stockQuantityRule,{purchasedQuantity:36,retainedQuantity:6});
 await h.service.approve(h.user,followup.operationId,{planHash:followup.planHash});assert.equal((await h.runtime(followup.operationId).execute()).complete,true);assert.ok(Object.values(stock()).every(quantity=>quantity===18));
 console.log(JSON.stringify({label:'actual-v2-flagship-first-month-and-rollover',firstMonthCreates:205,followUpCreates:h.posts-205,retainedBytes,decodedBytes,bsonBytes}));
});
