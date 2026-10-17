'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash,canonical}=require('../src/modules/business-calendar');
const {fixture,scope,ownerId,operationId,now,clone}=require('./helpers/business-link-repair-fixture');
const {assertPlan,assertRepairReadback,assertReadFence,creationIdentity}=require('../src/modules/business-link-repair-contract');
const {loadOwnedLinkLineage,assertRepairGraph}=require('../src/modules/business-link-repair');
const {createEstimateConversionProof}=require('../src/modules/business-estimate-conversion');
const {reconcileBusinessGraph}=require('../src/modules/business-graph-readback');
const {freezeWriteRequest}=require('../src/modules/qbo-write-contract');
const {normalizeWorkflow}=require('../src/modules/qbo-write-workflow');
async function graph(h){
 const lineage=await loadOwnedLinkLineage({models:h.models,scope,step:h.plan.originalStep}),invoice=h.after.invoice;
 invoice.estimateConversion=createEstimateConversionProof({compiled:h.plan.originalStep.compilation,receipt:h.plan.originalStep.receipt,observed:invoice,estimateObserved:h.after.estimate,timeObserved:h.after.time,lineage,now:h.clock});
 const entries=h.entries.map(e=>({...clone(e),observed:clone(h.after[e.step.entity==='TimeActivity'?'time':e.step.entity.toLowerCase()])}));
 const result=reconcileBusinessGraph({scope,roots:[h.plan.logicalKey],entries,now:h.clock});
 const writerFence=await h.transaction(session=>h.service.graphSnapshot({scope,intent:{operationId,planHash:h.plan.planHash},authorityHash:h.approval.authorityHash,session}));
 return{...result,sourcesJson:JSON.stringify(entries),sourcesHash:hash(JSON.stringify(entries)),writerFence,evidenceHash:hash({graph:result.evidenceHash,writerFence}),durationMs:1};
}
test('dedicated native sparse update retains barrier, original create evidence and actual physical full-conversion proof',async()=>{
 const h=fixture(),original=h.data.Steps.map(creationIdentity),compilation=canonical(h.plan.originalStep.compilation);await h.approve();await h.send();
 assert.equal(h.sent.length,1);assert.deepEqual(JSON.parse(h.sent[0].body),{Id:'5003',SyncToken:'0',sparse:true,LinkedTxn:h.plan.links});
 assert.equal(h.data.Receipts.at(-1).kind,'business-link-repair');assert.equal(h.data.Receipts.at(-1).state,'saved');assert.ok(h.data.Writers[0].unresolved);assert.equal(h.data.Runs[0].nextOrdinal,32);assert.equal(h.data.Writers[0].operationId,operationId);assert.deepEqual(h.data.Steps.map(creationIdentity),original);
 const proof=await graph(h);assert.equal(proof.complete,true,JSON.stringify(proof.failures));assert.equal(proof.records.find(x=>x.entity==='Invoice').proof.estimateConversion.physicalInvoiceLineLinkReturned,false);
 const completed=await h.service.finalize({scope,authorityHash:h.approval.authorityHash,after:h.after,reports:clone(h.plan.reports),graph:proof});
 assert.equal(completed.status,'verified');assert.equal(h.data.Writers[0].unresolved,null);assert.equal(h.data.Writers[0].operationId,operationId);assert.equal(h.data.Runs[0].nextOrdinal,32);assert.deepEqual(h.data.Steps.map(creationIdentity),original);assert.equal(canonical(h.plan.originalStep.compilation),compilation);assert.equal(h.after.invoice.record.Line[0].LinkedTxn,undefined);
 const outcome=h.data.Authorities.find(x=>x.payload.kind==='business-link-repair-outcome');assert.ok(outcome.payload.graphSourceJson.includes('TaxRateRef'));assert.equal(outcome.contentHash,hash(outcome.payload));
 const lineage=await loadOwnedLinkLineage({models:h.models,scope,step:h.plan.originalStep});assert.equal(lineage.stage,'verified-outcome');assert.ok(lineage.outcomeHash);assert.equal(h.opened,h.closed);
});
test('competing requests admit one single update and never replay a saved repair',async()=>{
 const h=fixture();await h.approve();const results=await Promise.allSettled([h.send(),h.send()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.sent.length,1);await assert.rejects(h.send());assert.equal(h.sent.length,1);
});
test('distinct concurrent approval decisions serialize by target authority identity',async()=>{
 const h=fixture(),other=clone(h.plan);other.reason+=' A distinct reviewed explanation.';const results=await Promise.allSettled([h.service.approve(h.plan),h.service.approve(other)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.data.Authorities.length,1);assert.equal(h.sent.length,0);
});
test('original create permits and ordinary legacy writes cannot masquerade as owned repairs',async()=>{
 const h=fixture();await h.approve();await assert.rejects(h.gate.begin({request:h.approval.request,ownerId,actorId:ownerId}));await assert.rejects(h.gate.begin({request:h.approval.request,ownerId,actorId:ownerId,permit:{},workflow:{version:1,kind:'business-link-repair',authorityHash:h.approval.authorityHash}}));assert.equal(h.sent.length,0);
 assert.throws(()=>normalizeWorkflow({version:1,kind:'business-link-repair',authorityHash:h.approval.authorityHash,allowUnknown:true}));
});
test('changed parties, money, tax, line identity, dates, notes or creation metadata are not link-only repair',()=>{
 for(const mutate of [x=>x.invoice.record.TotalAmt++,x=>x.invoice.record.Balance--,x=>x.invoice.record.Line[0].Amount++,x=>x.invoice.record.Line[0].Id='99',x=>x.invoice.record.TxnTaxDetail.TotalTax++,x=>x.invoice.record.CustomerRef.value='99',x=>x.invoice.record.TxnDate='2026-10-05',x=>x.invoice.record.PrivateNote='different',x=>x.invoice.record.MetaData.CreateTime='2020-01-01T00:00:00.000Z',x=>x.estimate.record.Line[0].SalesItemLineDetail.Qty++,x=>x.time.record.Hours++,x=>x.customer.record.Active=false]){
  const h=fixture();mutate(h.after);for(const o of Object.values(h.after))o.recordHash=hash(o.record);assert.throws(()=>assertRepairReadback(h.plan,h.after,now));
 }
});
test('missing, extra, partial and competing actual relationships cannot pass with unchanged money',async()=>{
 for(const mutate of [x=>x.invoice.record.LinkedTxn.shift(),x=>x.estimate.record.LinkedTxn=[],x=>x.estimate.record.LinkedTxn.push({TxnId:'999',TxnType:'Invoice'}),x=>x.estimate.record.TxnStatus='Accepted',x=>x.invoice.record.Line[0].LinkedTxn=[{TxnId:'999',TxnType:'Estimate'}]]){
  const h=fixture();await h.approve();await h.send();mutate(h.after);for(const o of Object.values(h.after))o.recordHash=hash(o.record);await assert.rejects(graph(h));assert.ok(h.data.Writers[0].unresolved);
 }
});
test('owner, publication, active worker, pending execution, preserved receipts and stale scope races fail before update',async()=>{
 for(const mutate of [h=>h.allowed=false,h=>h.authorityChanged=true,h=>h.data.Runs[0].leaseToken='worker',h=>h.data.Runs[0].executionRequest.pending=true,h=>h.data.Runs[0].nextOrdinal++,h=>h.data.Steps[0].receipt.evidenceHash=hash('changed'),h=>h.data.Connections[0].status='revoked',h=>h.data.Memberships[0].role='reviewer',h=>h.data.Calendars[0].stopRequested=true,h=>h.data.Writers[0].revision++]){
  const h=fixture();await h.approve();mutate(h);await assert.rejects(h.send());assert.equal(h.sent.length,0);
 }
});
test('unsupported or missing before financial observations deny approval before transport',async()=>{
 for(const mutate of [h=>h.plan.reports=[],h=>h.plan.currentDate='2026-10-07',h=>h.plan.period.throughDate='2026-10-05',h=>{h.plan.reports[0].sourceHash=hash('wrong');}]){
  const h=fixture();mutate(h);await assert.rejects(h.approve());assert.equal(h.sent.length,0);assert.equal(h.data.Authorities.length,0);
 }
});
test('stale target or source before-image denies native preflight admission',async()=>{
 const h=fixture();await h.approve();h.entries[0].observed.record.SyncToken='8';h.entries[0].observed.recordHash=hash(h.entries[0].observed.record);await assert.rejects(h.send());assert.equal(h.sent.length,0);
});
test('unknown outcome permanently retains barrier and cannot provide provisional lineage or replay',async()=>{
 const h=fixture();await h.approve();h.response={status:200,json:{Invoice:{Id:'5003'}}};await assert.rejects(h.send());assert.equal(h.sent.length,1);assert.equal(h.data.Receipts.at(-1).state,'unknown');assert.ok(h.data.Writers[0].unresolved);await assert.rejects(loadOwnedLinkLineage({models:h.models,scope,step:h.plan.originalStep}));await assert.rejects(h.send());assert.equal(h.sent.length,1);
});
test('known rejection retains no-effect receipt, preserves original operation, and grants no retry',async()=>{
 const h=fixture();await h.approve();h.response={status:400,json:{Fault:{type:'ValidationFault',Error:[{code:'6000',Message:'fixture refused'}]}}};await assert.rejects(h.send());assert.equal(h.data.Receipts.at(-1).state,'rejected');assert.equal(h.data.Writers[0].unresolved,null);assert.equal(h.data.Writers[0].operationId,operationId);await assert.rejects(h.send());assert.equal(h.sent.length,1);
});
test('admission audit failure sends nothing; lost admission reply holds possibly-sent receipt with no replay',async()=>{
 const h=fixture();await h.approve();h.failAudit=true;await assert.rejects(h.send());assert.equal(h.sent.length,0);assert.equal(h.data.Receipts.length,3);h.failAudit=false;h.loseReply=true;await assert.rejects(h.send());assert.equal(h.sent.length,0);assert.equal(h.data.Receipts.at(-1).state,'possibly-sent');assert.ok(h.data.Writers[0].unresolved);await assert.rejects(h.send());
});
test('tampered graph hash, identities, revision, closure, order or failures never release the barrier',async()=>{
 for(const mutate of [g=>g.evidenceHash=hash('wrong'),g=>g.failures.push({issue:'missing'}),g=>g.records[0].qboId='999',g=>g.records[0].fingerprint=hash('wrong'),g=>g.records[0].stepRevision++,g=>g.records[2].proof.relationships=[],g=>g.order.reverse(),g=>g.recordCount=2]){
  const h=fixture();await h.approve();await h.send();const g=await graph(h);mutate(g);await assert.rejects(h.service.finalize({scope,authorityHash:h.approval.authorityHash,after:h.after,reports:clone(h.plan.reports),graph:g}));assert.ok(h.data.Writers[0].unresolved);assert.equal(h.data.Authorities.length,1);
 }
});
test('known saved update can be verified after the original five-minute review window without another POST',async()=>{
 const h=fixture();await h.approve();await h.send();h.clock+=360000;
 for(const o of Object.values(h.after))o.observedAt=new Date(h.clock).toISOString();
 const reports=clone(h.plan.reports);for(const s of reports){s.startedAt=new Date(h.clock-1).toISOString();s.observedAt=new Date(h.clock).toISOString();const {sourceHash,...raw}=s;s.sourceHash=hash(raw);}
 const g=await graph(h);assert.equal(g.complete,true,JSON.stringify(g.failures));const result=await h.service.finalize({scope,authorityHash:h.approval.authorityHash,after:h.after,reports,graph:g});assert.equal(result.status,'verified');assert.equal(h.sent.length,1);
});
test('read quarantine never disguises unknown or possibly-sent state as settled',async()=>{
 const h=fixture();await h.approve();await h.send();const g=await graph(h);assert.ok(assertReadFence(g.writerFence).unresolved);for(const mutate of [v=>delete v.quarantinedRepair,v=>v.unresolved.responseReceiptId=hash('other'),v=>v.quarantinedRepair.receiptId=hash('other')]){const f=clone(g.writerFence);mutate(f);assert.throws(()=>assertReadFence(f));}
});

test('forged inner proofs with correct outer hashes cannot release the known saved barrier',async()=>{
 const h=fixture();await h.approve();await h.send();const g=await graph(h);g.records[2].proof.evidenceHash=hash('forged content');g.evidenceHash=hash({graph:hash({scope:g.scope,roots:g.roots,records:g.records,failures:g.failures}),writerFence:g.writerFence});await assert.rejects(h.service.finalize({scope,authorityHash:h.approval.authorityHash,after:h.after,reports:clone(h.plan.reports),graph:g}));assert.ok(h.data.Writers[0].unresolved);
});
test('immutable old report baseline supports recovery but is stale for new admission',async()=>{
 const h=fixture();h.plan.reviewedAt=new Date(now-299000).toISOString();for(const s of h.plan.reports){s.startedAt=new Date(now-598001).toISOString();s.observedAt=new Date(now-598000).toISOString();const {sourceHash,...raw}=s;s.sourceHash=hash(raw);}await assert.rejects(h.approve());assert.equal(h.sent.length,0);
});
test('source parent owned by a previous operation is rejected before approval',async()=>{
 const h=fixture();h.plan.identities=h.plan.identities.filter(x=>x.entity!=='Estimate');assert.throws(()=>assertPlan(h.plan,now,true));assert.equal(h.sent.length,0);
});

test('native admission preserves BSON writer IDs and date metadata',async()=>{
 const {Types}=require('mongoose'),h=fixture();h.data.Writers[0].connectionId=new Types.ObjectId(scope.connectionId);h.data.Writers[0].operationId=new Types.ObjectId(operationId);h.data.Writers[0].createdAt=new Date(now-1000);h.data.Writers[0].updatedAt=new Date(now);await h.approve();await h.send();assert.equal(h.sent.length,1);assert.equal(h.data.Receipts.at(-1).state,'saved');
});
test('header ordering and provider zero line marker preserve exact whole-conversion semantics',()=>{
 const h=fixture();h.after.invoice.record.LinkedTxn.reverse();h.after.invoice.record.LinkedTxn[0].TxnLineId='0';h.after.estimate.record.LinkedTxn[0].TxnLineId='0';for(const o of Object.values(h.after))o.recordHash=hash(o.record);assert.equal(assertRepairReadback(h.plan,h.after,now).unchangedAccounting,true);
});
test('omitted or forged compatibility source cannot be replaced by a matching outer hash',async()=>{
 const h=fixture();await h.approve();await h.send();const g=await graph(h),sources=JSON.parse(g.sourcesJson);delete sources.find(e=>e.step.entity==='Invoice').observed.estimateConversion;g.sourcesJson=JSON.stringify(sources);g.sourcesHash=hash(g.sourcesJson);await assert.rejects(h.service.finalize({scope,authorityHash:h.approval.authorityHash,after:h.after,reports:clone(h.plan.reports),graph:g}));assert.ok(h.data.Writers[0].unresolved);
});

test('held repair graph refreshes omitted Invoice AR ledger evidence and retains full taxed source depth',async()=>{
 const h=fixture();delete h.plan.before.invoice.record.ARAccountRef;h.plan.before.invoice.recordHash=hash(h.plan.before.invoice.record);delete h.after.invoice.record.ARAccountRef;h.after.invoice.recordHash=hash(h.after.invoice.record);h.entries.find(e=>e.step.entity==='Invoice').observed=clone(h.plan.before.invoice);
 await h.approve();await h.send();
 const {input}=require('./helpers/business-receivables-fixture').routingFixture();const fence=await h.transaction(session=>h.service.graphSnapshot({scope,intent:{operationId,planHash:h.plan.planHash},authorityHash:h.approval.authorityHash,session}));
 input.compiled=clone(h.plan.originalStep.compilation);input.receipt={...clone(h.plan.originalStep.receipt),scope,entity:'Invoice',logicalKey:h.plan.logicalKey};input.observed=h.after.invoice;input.beforeFence=clone(fence);input.afterFence=clone(fence);input.report.Rows.Row[0].Rows.Row[0].ColData[1].id=h.after.invoice.record.Id;
 h.after.invoice.accountRouting=require('../src/modules/business-receivables-route').invoiceReceivablesEvidence(input);
 const g=await graph(h);assert.equal(g.complete,true,JSON.stringify(g.failures));const completed=await h.service.finalize({scope,authorityHash:h.approval.authorityHash,after:h.after,reports:clone(h.plan.reports),graph:g});assert.equal(completed.status,'verified');assert.equal(h.after.invoice.record.ARAccountRef,undefined);assert.equal(h.after.invoice.record.Line[0].LinkedTxn,undefined);assert.equal(h.sent.length,1);
});
