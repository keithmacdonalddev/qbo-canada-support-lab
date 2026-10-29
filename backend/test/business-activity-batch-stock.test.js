'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/business-stock-fixture');
const {canonical}=require('../src/modules/business-calendar');
test('additional service activity verifies unchanged inventory and preserves the original committed stock carry',{timeout:120000},async t=>{
 const h=await fixture(t,{openingDate:'2026-11-01'});h.clock=Date.parse('2026-11-09T15:00:00Z');await h.publish();
 const initial=await h.service.prepare(h.user,{requestKey:'stock-history-through-yesterday',throughDate:'2026-11-08'});await h.service.approve(h.user,initial.operationId,{planHash:initial.planHash,confirmProduction:true});assert.equal((await h.runtime(initial.operationId).execute()).complete,true);
 const calendar=h.data.Calendars[0],lastVerified=calendar.lastVerifiedOperationId,firstEvidence=structuredClone(h.data.Evidence.at(-1)),opening=firstEvidence.proof.assertions.find(row=>row.key==='stock-costs').stockCosts.calculation.closing;
 const choices={decisionKey:'stock-preserving-hourly-activity',purpose:'Complete and collect a customer service visit without purchasing or selling stock.',activities:[{type:'settled-service-sale',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:2,unitPriceCents:12500,purpose:'Maintenance hours completed and collected without using inventory.'}]};
 const batch=await h.service.prepareActivityBatch(h.user,choices);await h.service.approve(h.user,batch.operationId,{planHash:batch.planHash,confirmProduction:true});const result=await h.runtime(batch.operationId).execute();assert.equal(result.complete,true,JSON.stringify(result));
 assert.equal(h.data.Calendars[0].verifiedThrough,'2026-11-08');assert.equal(h.data.Calendars[0].lastVerifiedOperationId,lastVerified);
 const evidence=h.data.Evidence.at(-1),cost=evidence.proof.assertions.find(row=>row.key==='stock-costs').stockCosts;assert.equal(cost.status,'passed');assert.equal(evidence.proof.stockBasis.length,0);assert.equal(canonical(cost.calculation.closing.items),canonical(opening.items));assert.equal(canonical(h.data.Evidence.find(row=>row.operationId===initial.operationId)),canonical(firstEvidence));
 const next=await h.service.prepare(h.user,{requestKey:'calendar-after-stock-preserving-activity',throughDate:'2026-11-09'});const manifest=h.data.Plans.find(row=>row.operationId===next.operationId).manifest;assert.equal(manifest.stockCostExpectation.carry.operationId,initial.operationId);assert.equal(manifest.stockCostExpectation.opening.stateHash,opening.stateHash);
});
