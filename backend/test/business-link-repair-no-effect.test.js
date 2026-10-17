'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../src/modules/business-calendar');
const {fixture,scope,clone,now}=require('./helpers/business-link-repair-fixture');
const {creationIdentity,assertNoEffectReadback}=require('../src/modules/business-link-repair-contract');
const {loadOwnedLinkLineage}=require('../src/modules/business-link-repair');
const {reconcileBusinessGraph}=require('../src/modules/business-graph-readback');
async function setup(){const h=fixture();await h.approve();await h.send();h.after=clone(h.plan.before);h.after.invoice.record.SyncToken='1';h.after.invoice.record.MetaData.LastUpdatedTime=new Date(now+1).toISOString();for(const o of Object.values(h.after))o.recordHash=hash(o.record);return h;}
const settle=h=>h.service.finalizeNoEffect({scope,authorityHash:h.approval.authorityHash,after:h.after,reports:clone(h.plan.reports)});
test('saved unsuccessful update clears only exact pointer, preserves original blocked state and never becomes conversion proof',async()=>{
 const h=await setup(),original=clone({run:h.data.Runs[0],calendar:h.data.Calendars[0],steps:h.data.Steps}),ids=h.data.Steps.map(creationIdentity),receipt=clone(h.data.Receipts.at(-1));
 const result=await settle(h);assert.equal(result.status,'saved-without-effect');assert.equal(result.linkVerified,false);assert.equal(result.originalOperationBlocked,true);assert.equal(h.data.Writers[0].unresolved,null);assert.deepEqual({run:h.data.Runs[0],calendar:h.data.Calendars[0],steps:h.data.Steps},original);assert.deepEqual(h.data.Steps.map(creationIdentity),ids);assert.deepEqual(h.data.Receipts.at(-1),receipt);assert.equal(await loadOwnedLinkLineage({models:h.models,scope,step:h.plan.originalStep}),null);
 const entries=h.entries.map(e=>({...clone(e),observed:clone(h.after[e.step.entity==='TimeActivity'?'time':e.step.entity.toLowerCase()])}));const graph=reconcileBusinessGraph({scope,roots:[h.plan.logicalKey],entries,now});assert.equal(graph.complete,false);await assert.rejects(h.send());await assert.rejects(settle(h));assert.equal(h.sent.length,1);assert.equal(h.opened,h.closed);
});
test('unsuccessful settlement rejects any accounting, source, link or non-observed metadata change',async()=>{
 for(const mutate of [a=>a.invoice.record.SyncToken='2',a=>a.invoice.record.TotalAmt++,a=>a.invoice.record.Balance--,a=>a.invoice.record.Line[0].Id='99',a=>a.invoice.record.LinkedTxn=[],a=>a.invoice.record.MetaData.LastModifiedByRef={value:'2'},a=>a.invoice.record.MetaData.CreateTime='2020-01-01T00:00:00.000Z',a=>a.estimate.record.TxnStatus='Closed',a=>a.estimate.record.SyncToken='1',a=>a.time.record.Hours++,a=>a.customer.record.Active=false]){const h=await setup();mutate(h.after);for(const o of Object.values(h.after))o.recordHash=hash(o.record);await assert.rejects(settle(h));assert.ok(h.data.Writers[0].unresolved);assert.equal(h.data.Authorities.length,1);}
});
test('unknown/rejected transport or changed saved receipt cannot release through unsuccessful settlement',async()=>{
 for(const mutate of [h=>h.data.Receipts.at(-1).state='unknown',h=>h.data.Receipts.at(-1).observed.syncToken='2',h=>h.data.Receipts.at(-1).observed.qboId='999',h=>h.data.Audits.at(-1).outcome='partial',h=>h.data.Steps[0].receipt.evidenceHash=hash('changed')]){const h=await setup();mutate(h);await assert.rejects(settle(h));assert.ok(h.data.Writers[0].unresolved);}
});
test('stale report and changed all-account observation cannot settle the saved unsuccessful update',async()=>{
 const h=await setup();h.clock+=360000;await assert.rejects(settle(h));assert.ok(h.data.Writers[0].unresolved);
});
test('unsuccessful audit failure or pointer CAS conflict rolls back retained outcome and release',async()=>{
 for(const mode of ['audit','writer']){const h=await setup();if(mode==='audit')h.failAudit=true;else h.conflict='Writers';await assert.rejects(settle(h));assert.equal(h.data.Authorities.length,1);assert.ok(h.data.Writers[0].unresolved);}
});
test('competing unsuccessful settlements retain exactly one outcome and never admit another POST',async()=>{
 const h=await setup(),results=await Promise.allSettled([settle(h),settle(h)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.data.Authorities.filter(x=>x.payload.kind==='business-link-repair-no-effect').length,1);assert.equal(h.sent.length,1);assert.equal(h.data.Runs[0].status,'blocked');
});
test('tampered unsuccessful outcome or audit is never silently converted to absent lineage',async()=>{
 for(const mutate of [h=>h.data.Authorities.at(-1).payload.linkVerified=true,h=>h.data.Audits.at(-1).outcome='success',h=>h.data.Authorities.at(-1).payload.after.invoice.record.TotalAmt++]){const h=await setup();await settle(h);mutate(h);await assert.rejects(loadOwnedLinkLineage({models:h.models,scope,step:h.plan.originalStep}));}
});
test('known saved single-version receipt and untouched original links are mandatory',async()=>{const h=await setup();assert.equal(assertNoEffectReadback(h.plan,h.after,h.data.Receipts.at(-1),now).linkVerified,false);assert.throws(()=>assertNoEffectReadback(h.plan,h.after,{},now));});
