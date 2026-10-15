'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope,ownerId,actorId}=require('./helpers/business-governance-fixture');
const {hash}=require('../src/modules/business-calendar');
const config=require('../src/config'),previous=config.qbo.environment;test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
test('owner publishes complete opening evidence while original draft and observation remain unchanged',async()=>{
 const h=fixture();const result=await h.publish();assert.equal(result.published,true);assert.equal(h.posts,0);assert.equal(h.data.Authorities.length,1);assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(h.data.Baselines[0].payload.accepted,false);assert.equal(h.data.Versions[0].status,'draft');assert.equal(h.data.Authorities[0].payload.country,'CA');
 assert.equal((await h.service.publish(h.user,h.publicationInput)).reused,true);assert.equal(h.data.Authorities.length,1);
});
test('unassigned drafts, protected opening dates, other country, changed source and audit failure cannot activate a business',async()=>{
 for(const mode of ['unassigned','protected','country','drift','audit','late-stock']){
  const h=fixture();if(mode==='unassigned'){h.data.Versions[0].definition.mappings.operatingBank=null;h.data.Versions[0].contentHash=hash(h.data.Versions[0].definition);}if(mode==='protected')h.closedThrough='2026-10-01';if(mode==='country')h.country='US';if(mode==='late-stock')[...h.records.values()].find(row=>row.entity==='Item'&&row.record.Type==='Inventory').record.InvStartDate='2099-01-01';
  if(mode==='drift'){const original=h.service.publish;h.service.publish=async(...args)=>{h.records.get('account:1').record.Name='Changed bank definition';return original(...args);};}if(mode==='audit')h.failCreate='Authorities';
  await assert.rejects(h.publish());assert.equal(h.data.Authorities.length,0,mode);assert.equal(h.data.Calendars.length,0,mode);assert.equal(h.posts,0,mode);
 }
});
test('real preparation saves server-owned plans; operator can prepare but only the owner can approve',async()=>{
 const h=fixture();await h.publish();const request={requestKey:'first-business-period-001',throughDate:'2026-10-06'},operator={id:ownerId,actorId};
 const prepared=await h.service.prepare(operator,request);assert.equal(prepared.status,'previewed');assert.equal(h.posts,0);assert.ok(h.data.Intents.length>0);assert.ok(h.data.Intents.every(row=>row.policy.authorityHash===h.data.Authorities[0].contentHash));
 assert.equal((await h.service.prepare(operator,request)).reused,true);await assert.rejects(h.service.approve(operator,prepared.operationId,{planHash:prepared.planHash}),error=>error.status===403);
 await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});assert.equal(h.data.Runs[0].status,'approved');assert.equal(h.posts,0);
});
test('actual preparation, approval, transport, readback, independent ledger reports and calendar cover two adjacent periods once',async()=>{
 const h=fixture();await h.publish();
 for(const[ordinal,throughDate]of ['2026-10-15','2026-10-31'].entries()){
  const prepared=await h.service.prepare(h.user,{requestKey:'adjacent-business-period-'+ordinal,throughDate});await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});
  const runtime=h.runtime(prepared.operationId),result=await runtime.execute();assert.equal(result.complete,true,JSON.stringify({result,last:h.events.at(-1),steps:h.data.Steps.filter(row=>row.verification?.status!=='verified').slice(-5),audit:h.data.Audits.slice(-3),run:h.data.Runs.find(row=>row._id===prepared.operationId)}));assert.equal(h.data.Calendars[0].verifiedThrough,throughDate);const posts=h.posts;assert.equal((await runtime.execute()).complete,true);assert.equal(h.posts,posts);
 }
 const types=new Set([...h.records.values()].filter(row=>row.record.TxnDate).map(row=>row.entity));for(const name of ['Estimate','TimeActivity','Invoice','Payment','Deposit','PurchaseOrder','Bill','SalesReceipt','BillPayment'])assert.ok(types.has(name),name);
 assert.equal(h.data.Evidence.length,2);assert.equal(h.data.Calendars[0].revision,2);assert.equal(h.data.Writers[0].operationId,null);assert.equal(h.data.Writers[0].unresolved,null);
 const receipts=h.data.Receipts.filter(row=>row.kind==='business');assert.equal(new Set(receipts.map(row=>row.observed.qboId)).size,h.posts);
});

test('unsent retirement releases only proved never-sent claims and permits a fresh reviewed operation',async()=>{
 const h=fixture();await h.publish();const request={requestKey:'retirement-tax-drift-0001',throughDate:'2026-10-06'},prepared=await h.service.prepare(h.user,request);await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});
 h.records.get('taxrate:950').record.SyncToken='1';const blocked=await h.runtime(prepared.operationId).execute();assert.equal(blocked.complete,false);assert.equal(h.posts,0);assert.equal(h.data.Steps.length,1);
 const input={planHash:prepared.planHash},review=await h.service.reviewRetirement(h.user,prepared.operationId,input);assert.equal(review.claimCount,1);assert.equal(review.qboWrites,0);
 const choice={...input,reviewHash:review.reviewHash,reason:'Tax definitions changed before any request was sent.'};h.loseReply=true;await assert.rejects(h.service.retire(h.user,prepared.operationId,choice),/acknowledgement/);
 assert.equal((await h.service.retire(h.user,prepared.operationId,choice)).reused,true);assert.equal(h.data.Steps.length,0);assert.equal(h.data.Writers[0].operationId,null);assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(h.data.Plans.length,1);assert.ok(h.data.Audits.some(row=>row.action==='Unsent business operation retired'&&row.beforeState.claims.length===1));
 assert.equal((await h.runtime(prepared.operationId).execute()).state,'retired');await assert.rejects(h.service.prepare(h.user,request),/new request/);await assert.rejects(h.service.approve(h.user,prepared.operationId,input),/retired/);
 const fresh=await h.service.prepare(h.user,{...request,requestKey:'retirement-tax-drift-0002'});await h.service.approve(h.user,fresh.operationId,{planHash:fresh.planHash});assert.equal((await h.runtime(fresh.operationId).execute()).complete,true);assert.equal(h.data.Calendars[0].verifiedThrough,request.throughDate);
});
test('retirement denies sent, uncertain, changed, active or non-owner work and rolls back audit failures',async()=>{
 for(const mode of ['receipt','unknown','changed','active','operator','audit']){
  const h=fixture();await h.publish();const prepared=await h.service.prepare(h.user,{requestKey:'retirement-boundary-0001',throughDate:'2026-10-06'}),input={planHash:prepared.planHash};
  const review=await h.service.reviewRetirement(h.user,prepared.operationId,input),run=h.data.Runs[0];
  if(mode==='receipt')h.data.Receipts.push({...scope,operationId:prepared.operationId,kind:'business'});if(mode==='unknown')h.data.Writers[0].unresolved={operationId:prepared.operationId};if(mode==='changed')h.data.Writers[0].revision++;if(mode==='active'){run.leaseToken='active-operation-worker';run.leaseExpiresAt=new Date(h.clock+1000);}if(mode==='audit')h.failCreate='Audits';
  await assert.rejects(h.service.retire(mode==='operator'?{id:ownerId,actorId}:h.user,prepared.operationId,{...input,reviewHash:review.reviewHash,reason:'Owner reviewed this exact unused operation for retirement.'}));assert.equal(h.data.Runs[0].status,'previewed',mode);assert.equal(h.posts,0,mode);
 }
});

async function savedPlan(h,key='recovery-period-00001',throughDate='2026-10-15'){const p=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});return p;}
async function resume(h,p){const body={planHash:p.planHash},review=await h.service.reviewResume(h.user,p.operationId,body);await h.service.resume(h.user,p.operationId,{...body,reviewHash:review.reviewHash,reason:'Owner approves continuing this exact saved operation.'});assert.equal((await h.runtime(p.operationId).inspect()).financialMovements,null);}
test('owner resumes the same stopped partial operation without changing or duplicating its first saved record',async()=>{
 const h=fixture();await h.publish();const p=await savedPlan(h),runtime=h.runtime(p.operationId);h.afterPost=async()=>{h.afterPost=null;await runtime.stop();};assert.equal((await runtime.execute()).state,'stopped');assert.equal(h.posts,1);const first=structuredClone([...h.records.values()].find(row=>row.record.TxnDate));
 await assert.rejects(h.service.reviewResume({id:ownerId,actorId},p.operationId,{planHash:p.planHash}),error=>error.status===403);await resume(h,p);assert.equal((await runtime.execute()).complete,true);assert.equal(h.records.get(first.entity.toLowerCase()+':'+first.record.Id).record.Id,first.record.Id);assert.equal(h.data.Receipts.filter(row=>row.observed?.qboId===first.record.Id).length,1);
});
test('two owner tax amendments retain the policy used for each saved record across resumed and adjacent periods',async()=>{
 const h=fixture();await h.publish();const p=await savedPlan(h,'tax-amendment-period-001'),runtime=h.runtime(p.operationId),originalPlan=hash(h.data.Plans[0].manifest);h.afterPost=async(_opts,record)=>{if(record.TxnTaxDetail){h.afterPost=null;await runtime.stop();}};assert.equal((await runtime.execute()).state,'stopped');const first=h.data.Steps.find(row=>row.qboId),firstRecord=structuredClone(h.records.get(first.entity.toLowerCase()+':'+first.qboId).record),oldTax=firstRecord.TxnTaxDetail.TotalTax;
 await resume(h,p);const rate=h.records.get('taxrate:950').record;rate.SyncToken='1';rate.RateValue=15;rate.EffectiveTaxRate[0].RateValue=15;
 let review=await h.service.reviewTaxChange(h.user,p.operationId,{planHash:p.planHash});assert.ok(review.changes.some(row=>row.previousTaxCents!==row.proposedTaxCents));let input={planHash:p.planHash,reviewHash:review.reviewHash,reason:'Owner reviewed the new dated tax rate for all unsent records.'};const one=await h.service.approveTaxChange(h.user,p.operationId,input);assert.equal((await runtime.inspect()).financialMovements,null);assert.equal((await h.service.approveTaxChange(h.user,p.operationId,input)).reused,true);
 h.afterPost=async(_opts,record)=>{if(record.TxnTaxDetail){h.afterPost=null;await runtime.stop();}};assert.equal((await runtime.execute()).state,'stopped');assert.ok(h.data.Steps.some(row=>row.dispatch?.policyAmendmentHash===one.amendmentHash&&row.qboId));await resume(h,p);
 const code=h.records.get('taxcode:'+h.mappings.salesTax).record;code.SyncToken='1';code.SalesTaxRateList.TaxRateDetail[0].TaxRateRef.value='951';h.records.set('taxrate:951',{entity:'TaxRate',record:{Id:'951',SyncToken:'0',Active:true,RateValue:7,EffectiveTaxRate:[{EffectiveDate:'2020-01-01',RateValue:7}]}});
 review=await h.service.reviewTaxChange(h.user,p.operationId,{planHash:p.planHash});assert.ok(review.changes.some(row=>row.taxCodeDefinitionChanged));input={planHash:p.planHash,reviewHash:review.reviewHash,reason:'Owner reviewed the changed same-ID sales tax code and remaining tax.'};await h.service.approveTaxChange(h.user,p.operationId,input);const outcome=await runtime.execute();assert.equal(outcome.complete,true,JSON.stringify(outcome));assert.equal(h.records.get(first.entity.toLowerCase()+':'+first.qboId).record.TxnTaxDetail.TotalTax,oldTax);assert.equal(hash(h.data.Plans[0].manifest),originalPlan);assert.equal(h.data.Receipts.filter(row=>row.observed?.qboId===first.qboId).length,1);
 const next=await savedPlan(h,'tax-amendment-period-002','2026-10-31');assert.equal((await h.runtime(next.operationId).execute()).complete,true);assert.equal(h.data.Calendars[0].revision,2);
});
test('a definite rejected attempt requires owner approval, keeps its receipt and gets a distinct next dispatch',async()=>{
 const h=fixture();await h.publish();const p=await savedPlan(h,'rejected-period-00001','2026-10-06');h.rejectNext=true;const runtime=h.runtime(p.operationId),result=await runtime.execute();assert.equal(result.complete,false);assert.equal(h.posts,1);const step=h.data.Steps.find(row=>row.state==='rejected');assert.ok(step);const old=structuredClone(step),body={planHash:p.planHash,logicalKey:step.logicalKey};await assert.rejects(h.service.reviewRetirement(h.user,p.operationId,{planHash:p.planHash}),/receipt/i);
 const review=await h.service.reviewRejected(h.user,p.operationId,body),input={...body,reviewHash:review.reviewHash,reason:'Owner corrected the validation cause and approves a separate attempt.'};await h.service.retryRejected(h.user,p.operationId,input);assert.equal((await h.service.retryRejected(h.user,p.operationId,input)).reused,true);const code=h.records.get('taxcode:'+h.mappings.salesTax).record;code.SyncToken='1';code.Name='Reviewed after rejection';const taxReview=await h.service.reviewTaxChange(h.user,p.operationId,{planHash:p.planHash});await h.service.approveTaxChange(h.user,p.operationId,{planHash:p.planHash,reviewHash:taxReview.reviewHash,reason:'Owner reviewed the corrected same-code definition after the refusal.'});const completed=await runtime.execute();assert.equal(completed.complete,true,JSON.stringify(completed));assert.equal(h.data.Receipts.find(row=>row._id===old.rejection.receiptId).state,'rejected');assert.notEqual(h.data.Steps.find(row=>row.logicalKey===old.logicalKey).dispatch.key,old.dispatch.key);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-06');
});
test('an empty or altered income report cannot verify planned nonzero sales',async()=>{
 const h=fixture();await h.publish();const p=await savedPlan(h,'income-proof-period-001','2026-10-06'),read=h.reportSources;h.reportSources=period=>{const source=read(period);if(h.posts){const pnl=source.reports.ProfitAndLoss;pnl.Rows.Row=[];pnl.Header.Option=[{Name:'NoReportData',Value:'true'}];}return source;};const result=await h.runtime(p.operationId).execute();assert.equal(result.complete,false);assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(h.data.Evidence.length,1);assert.equal(h.data.Evidence[0].proof.complete,false);assert.equal(h.data.Evidence[0].proof.assertions.find(row=>row.key==='profit-and-loss').status,'unavailable');assert.equal(h.data.Runs[0].verificationCandidateHash,null);
});

test('changed starting revenue stops before any provider write and leaves an unsent plan recoverable',async()=>{
 const h=fixture();await h.publish();const p=await savedPlan(h,'changed-opening-income-001','2026-10-06');h.records.set('invoice:99000',{entity:'Invoice',record:{Id:'99000',SyncToken:'0',TxnDate:'2026-10-02',Line:[{Amount:10}],TotalAmt:10,Balance:10}});
 await assert.rejects(h.runtime(p.operationId).execute(),/income changed after preparation/);assert.equal(h.posts,0);const review=await h.service.reviewRetirement(h.user,p.operationId,{planHash:p.planHash});await h.service.retire(h.user,p.operationId,{planHash:p.planHash,reviewHash:review.reviewHash,reason:'Starting income changed; no request from this operation was sent.'});assert.equal(h.data.Writers[0].operationId,null);
});
