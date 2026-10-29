'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash, canonical } = require('../src/modules/business-calendar');
const { makeActivityBatch, buildBatchActivity, validateActivityBatch, validateChoices, batchLifecycle, POLICY_HASH } = require('../src/modules/business-activity-batch');
const { fenceAgentAuthority } = require('../src/modules/business-agent-authority');
const scope = { environment:'sandbox', realmId:'123', connectionId:'a'.repeat(24) };
const choices = () => ({ decisionKey:'hourly-business-decision-001', purpose:'A completed same-day service visit with its accepted customer payment.', activities:[{type:'settled-service-sale',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:3,unitPriceCents:12500,purpose:'Completed on-site maintenance visit and collected the accepted invoice.'}] });
function prepared(input=choices()) {
 const batch = makeActivityBatch({scope,businessKey:'harbour-pine-v2',day:'2026-12-01',choices:input}), activity=buildBatchActivity(batch,scope,'harbour-pine-v2');
 const entries=activity.events.map(event=>({kind:'create',step:{logicalKey:event.logicalKey,entity:event.entity,txnDate:event.txnDate,calendarFingerprint:event.fingerprint,details:activity.detailProposal.byLogicalKey[event.logicalKey].details,dependencies:event.dependsOn.map(logicalKey=>({logicalKey})),references:[]}}));
 return {batch,activity,candidate:{scope,businessKey:'harbour-pine-v2',fromDate:batch.day,throughDate:batch.day,expectedCursor:'2026-11-30',entries}};
}
test('one business choice yields a self-contained sale, time, collection and deposit chain',()=>{
 const f=prepared();assert.deepEqual(f.activity.events.map(row=>row.entity),['Estimate','TimeActivity','Invoice','Payment','Deposit']);
 assert.equal(validateActivityBatch(f.batch,f.candidate),f.batch);assert.equal(f.batch.policyHash,POLICY_HASH);
 const byType=Object.fromEntries(f.candidate.entries.map(row=>[row.step.entity,row.step]));
 assert.equal(byType.Invoice.details.baseAmountCents,37500);assert.equal(byType.Payment.details.amountSourceKey,byType.Invoice.logicalKey);assert.equal(byType.Deposit.details.destination,'operating_bank');assert.equal(byType.Deposit.details.amountSourceKey,byType.Payment.logicalKey);
 assert.equal(batchLifecycle(byType.Invoice).dueDate,'2026-12-01');
});
test('independent same-day decisions have distinct identities; exact retries are stable',()=>{
 const first=prepared(),retry=prepared(),input=choices();input.decisionKey='hourly-business-decision-002';const next=prepared(input);
 assert.equal(canonical(first.batch),canonical(retry.batch));assert.equal(canonical(first.activity),canonical(retry.activity));
 assert.equal(first.activity.events.some(row=>next.activity.events.some(other=>other.logicalKey===row.logicalKey)),false);
});
test('raw bodies, inventory, foreign parties, invalid quantities and oversized batches are rejected',()=>{
 for(const mutate of [x=>{x.realmId='foreign';},x=>{x.activities[0].payload={TxnDate:'2026-12-01'};},x=>{x.activities[0].itemKey='workshop-stock-1';},x=>{x.activities[0].customerKey='123';},x=>{x.activities[0].quantity=0.5;},x=>{x.activities[0].unitPriceCents=100001;},x=>{x.activities=Array.from({length:13},()=>structuredClone(x.activities[0]));}]){const value=choices();mutate(value);assert.throws(()=>validateChoices(value));}
});
test('changed transaction dates, omitted settlement, duplicate records and borrowed monthly rules fail closed',()=>{
 for(const mutate of [f=>{f.candidate.expectedCursor=null;},f=>{f.candidate.fromDate='2026-11-30';},f=>{f.candidate.entries.pop();},f=>{f.candidate.entries[1]=structuredClone(f.candidate.entries[0]);},f=>{f.candidate.entries[2].step.details.lines[0].amountCents++;},f=>{f.candidate.entries[2].step.details.activityTemplateVersion=2;},f=>{f.candidate.entries[4].step.dependencies=[];},f=>{f.batch.activities[0].quantity++;}]){const f=prepared();mutate(f);assert.throws(()=>validateActivityBatch(f.batch,f.candidate));}
});
test('operating overhead retains exact supplier, expense and payment without stock movement',()=>{
 const input={decisionKey:'operating-expense-decision-001',purpose:'Pay the software supplier for the additional business users added today.',activities:[{type:'paid-operating-expense',vendorKey:'overhead-supplier-3',category:'software',amountCents:5900,purpose:'Additional software seats invoiced and paid for the support team.'}]};
 const f=prepared(input);assert.deepEqual(f.activity.events.map(row=>row.entity),['Bill','BillPayment']);validateActivityBatch(f.batch,f.candidate);
 const contract=batchLifecycle(f.candidate.entries[0].step);assert.equal(contract.mode,'operating-expense');assert.equal(contract.expense.amountCents,5900);assert.equal(f.candidate.entries.some(row=>row.step.details.lines.some(line=>line.itemKey)),false);
});
test('native accounting admission requires the renewed activity policy and keeps pause transaction fencing',async()=>{
 const authority={version:1,agentId:'b'.repeat(24),grantId:'c'.repeat(64),authorityHash:'d'.repeat(64),ownerId:'e'.repeat(24)},batch=prepared().batch;
 let filter;const Agents={findOneAndUpdate(value){filter=value;return{lean:async()=>null};}};
 await assert.rejects(fenceAgentAuthority({authority,run:{createdBy:authority.ownerId,authorityHash:authority.authorityHash,activityBatch:batch},scope,ownerId:authority.ownerId,actorId:authority.ownerId,Agents,session:{inTransaction:()=>true}}),/paused|authorization changed/);
 assert.equal(filter['grant.activityPolicyHash'],POLICY_HASH);assert.equal(filter['settings.autonomous'],true);assert.equal(filter['grant.id'],authority.grantId);
});
