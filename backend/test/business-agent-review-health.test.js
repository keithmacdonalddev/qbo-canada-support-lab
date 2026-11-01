'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {agentBlockers}=require('../src/modules/business-error-detail');
const saved=require('./fixtures/accountant-review-stall-2026-11-01.json');
test('watchdog reports an expired or missing heartbeat, but never calls a fresh lease orphaned',()=>{
 const row=structuredClone(saved.agent),now=Date.parse(saved.observedAt);row.leaseToken='worker';row.leaseExpiresAt=new Date(now+120000);
 assert.equal(agentBlockers(row,now).some(b=>b.errorDetail.code==='BUSINESS_REVIEW_ORPHANED'),false);
 row.leaseExpiresAt=new Date(now-1);assert.ok(agentBlockers(row,now).some(b=>b.errorDetail.code==='BUSINESS_REVIEW_ORPHANED'));
 row.leaseToken=null;assert.equal(agentBlockers(row,now).some(b=>b.errorDetail.code==='BUSINESS_REVIEW_ORPHANED'),false,'a recent attempt is inside the grace period');
 assert.ok(agentBlockers(row,now+120000).some(b=>b.errorDetail.code==='BUSINESS_REVIEW_ORPHANED'));
 row.settings.monitoring=false;assert.deepEqual(agentBlockers(row,now+120000),[]);
});
test('stored unverified reconciliation remains visible with its exact amounts and no invented mismatch',()=>{
 const blockers=agentBlockers(saved.agent,Date.parse(saved.observedAt));const ar=blockers.find(b=>b.errorDetail.detail.entity==='Invoice');
 assert.equal(ar.errorDetail.code,'BUSINESS_AMOUNT_RECONCILIATION_UNVERIFIED');assert.equal(ar.errorDetail.detail.qboCents,8136286);assert.equal(ar.errorDetail.detail.knownCents,8045829);assert.equal(ar.errorDetail.detail.differenceCents,null);assert.match(ar.errorDetail.message,/independent governed writes remain available/);
});

test('current CDC with unreadable nightly count evidence is visible as an attention item',()=>{
 const row=structuredClone(saved.agent);row.syncView.sources[0].reconcileError='Nightly count could not be read';
 assert.ok(agentBlockers(row,Date.parse(saved.observedAt)).some(b=>b.errorDetail.code==='BUSINESS_COUNT_RECONCILIATION_UNVERIFIED'));
});

test('stored six-record overnight rhythm explains the pre-07:00 quiet interval across Halifax clock rollback',()=>{
 const cadence=require('../src/modules/business-agent-cadence'),receipts=Array.from({length:6},(_,i)=>({operationId:'saved',logicalKey:'record-'+i,entity:'Invoice'}));
 for(const at of ['2026-11-01T04:40:04Z','2026-11-01T05:30:00Z','2026-11-01T06:59:00Z']){
  const today=cadence.summarizeToday({rhythm:saved.agent.cadence.rhythm,receipts,now:Date.parse(at)});assert.equal(today.dueSlot,null);assert.equal(today.nextSlotAt,'2026-11-01T07:00:00.000Z');
 }
 const due=cadence.summarizeToday({rhythm:saved.agent.cadence.rhythm,receipts,now:Date.parse('2026-11-01T07:00:00Z')});assert.equal(due.behind,5);assert.ok(due.dueSlot);
});
