'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, scope } = require('./helpers/business-governance-fixture');
const { activityDefinition } = require('../src/modules/business-activity-preview');
const { planBusinessCalendar, shift, canonical, hash } = require('../src/modules/business-calendar');
const { unpackReports, MAX_SOURCE_BYTES, MAX_DECODED_BYTES } = require('../src/modules/business-report-source');
const { evaluateReportSources } = require('../src/modules/book-evidence');
const bsonSize = value => require('mongoose').mongo.BSON.calculateObjectSize(value);
const config = require('../src/config'), previous = config.qbo.environment;
test.before(() => { config.qbo.environment = 'sandbox'; }); test.after(() => { config.qbo.environment = previous; });
function budgets(source, retained, label) {
  const {sourceHash,evaluation,...raw} = source, decoded = unpackReports(raw);
  const metrics = {label,retainedBytes:Buffer.byteLength(canonical(raw)),decodedBytes:Object.values(decoded).reduce((sum,report)=>sum+Buffer.byteLength(canonical(report)),0),bsonBytes:bsonSize({...retained,createdAt:new Date(),__v:0})};
  assert.ok(metrics.retainedBytes < MAX_SOURCE_BYTES * .8, JSON.stringify(metrics)); assert.ok(metrics.decodedBytes < MAX_DECODED_BYTES * .8, JSON.stringify(metrics)); assert.ok(metrics.bsonBytes < 15000000 * .8, JSON.stringify(metrics));
  assert.equal(evaluateReportSources(raw,{allowExplicitZero:true}).reportCoverage.complete,true);
  for(const name of ['GeneralLedger','CashFlow']) assert.equal(hash(decoded[name]),source.reports[name].sha256);
  console.log(JSON.stringify(metrics)); return decoded;
}
test('current flagship maximum rolling31-day template stays inside the policy ceiling across leap and year boundaries',()=>{
  const definition = activityDefinition({openingDate:'2023-01-01',volumeProfile:'flagship'}),counts = new Map();
  for(const[fromDate,throughDate]of [['2024-01-01','2024-12-31'],['2025-01-01','2025-12-31'],['2026-01-01','2026-01-30']]){
    const plan = planBusinessCalendar({definition,scope:{realmId:scope.realmId,environment:scope.environment},fromDate,throughDate,today:'2026-12-31'});
    for(const event of plan.events) counts.set(event.txnDate,(counts.get(event.txnDate)||0)+1);
  }
  let maximum = 0, maximumPeriod;
  for(let day='2024-01-01';day<='2025-12-31';day=shift(day,1)){
    let count = 0; for(let i=0;i<31;i++)count+=counts.get(shift(day,i))||0;
    if(count>maximum){maximum=count;maximumPeriod={fromDate:day,throughDate:shift(day,30)};}
  }
  assert.ok(maximum>=260); assert.ok(maximum<=500); console.log(JSON.stringify({currentTemplateMaximum:maximum,maximumPeriod,policyCreateCeiling:500}));
});
test('actual first31-day flagship workflow retains complete independent report evidence within budgets', {timeout:180000}, async()=>{
  const h = fixture({volumeProfile:'flagship',copyOnWriteTransactions:true}); await h.publish();
  const prepared = await h.service.prepare(h.user,{requestKey:'flagship-month-capacity-0001',throughDate:'2026-10-31'}); await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});
  h.afterPost=async()=>{if(h.posts%50===0)console.log(JSON.stringify({fixtureProgress:h.posts,target:202}));};
  assert.equal(h.data.Plans[0].manifest.createCount,202); const result = await h.runtime(prepared.operationId).execute(); assert.equal(result.complete,true,JSON.stringify(result)); assert.equal(h.posts,202);
  const saved = h.data.Evidence[0], decoded = budgets(saved.sources,saved,'actual-first31-day-flagship');
  const original = h.reportSources({fromDate:'2026-10-01',throughDate:'2026-10-31'}); assert.deepEqual(unpackReports(original),decoded); assert.ok(decoded.GeneralLedger.Rows.Row.length>202);
});
test('separate500-financial-record ceiling stress preserves varied detail through real reader and approval storage',async()=>{
  const h = fixture(); await h.publish();
  for(let i=0;i<500;i++){
    const fingerprint = hash({index:i,fixture:'independent remote accepted-record format'}),id=String(900000+i),net=(10000+(i*7919)%900000)/100,tax=Math.round(net*13)/100;
    const record={Id:id,SyncToken:String(i%7),TxnDate:'2026-10-'+String(1+i%31).padStart(2,'0'),DocNumber:'CAP-'+fingerprint,PrivateNote:'Fixture invoice '+fingerprint+' '+hash({invoice:i,note:true}),CustomerRef:{value:String(80000+i),name:'Fixture party '+hash({party:i}).slice(0,40)},Line:[{Amount:net}],TxnTaxDetail:{TotalTax:tax},TotalAmt:Math.round((net+tax)*100)/100};
    h.records.set('invoice:'+id,{entity:'Invoice',record});
  }
  const prepared = await h.service.prepare(h.user,{requestKey:'synthetic500-report-capacity-0001',throughDate:'2026-10-31'}); await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash}); assert.equal(h.posts,0);
  const retained = h.data.Candidates.find(row=>row.payload.kind==='business-approval-reports'),source = retained.payload.sources,decoded = budgets(source,retained,'synthetic500-financial-record-observation');
  assert.equal(decoded.GeneralLedger.Rows.Row.length,1500); const docIds = new Set(decoded.GeneralLedger.Rows.Row.map(row=>row.ColData[1].id)); assert.equal(docIds.size,500);
  assert.equal(new Set(decoded.GeneralLedger.Rows.Row.map(row=>row.ColData[4].value)).size,500); assert.equal(hash(source),retained.payload.sourceHash);
  assert.equal((await h.service.reviewOperation(h.user,prepared.operationId)).approvalReports.available,7);
});
