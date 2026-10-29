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
const settle = () => ({ decisionKey:'adopted-settlement-decision-001', purpose:'Collect a customer payment received today and pay a supplier bill now due.', activities:[{type:'collect-adopted-invoice',invoiceId:'10720',customerKey:'care-client-021',amountCents:28386,purpose:'Customer paid the September care invoice in full.'},{type:'pay-adopted-bill',billId:'10655',vendorKey:'stock-supplier-2',amountCents:69768,purpose:'Pay the stock supplier bill that falls due today.'}] });
test('adopted obligations settle as a standalone payment with its deposit, and a standalone bill payment',()=>{
 const f=prepared(settle());assert.deepEqual(f.activity.events.map(row=>row.entity),['Payment','Deposit','BillPayment']);validateActivityBatch(f.batch,f.candidate);
 const [payment,deposit,bill]=f.candidate.entries.map(row=>row.step);
 assert.deepEqual(payment.dependencies,[]);assert.deepEqual(bill.dependencies,[]);assert.equal(deposit.details.amountSourceKey,payment.logicalKey);
 const collect=batchLifecycle(payment),pay=batchLifecycle(bill);
 assert.equal(collect.mode,'adopted-settlement');assert.deepEqual(collect.adopted,{entity:'Invoice',qboId:'10720',amountCents:28386});
 assert.equal(pay.mode,'adopted-settlement');assert.deepEqual(pay.adopted,{entity:'Bill',qboId:'10655',amountCents:69768});
 assert.equal(batchLifecycle(deposit).mode,'standard');
});
test('adopted settlements reject foreign parties, duplicates, oversized amounts and tampered terms',()=>{
 for(const mutate of [x=>{x.activities[0].invoiceId='INV-1';},x=>{x.activities[0].customerKey='stock-supplier-1';},x=>{x.activities[1].vendorKey='care-client-001';},x=>{x.activities[0].amountCents=5000001;},x=>{x.activities[0].amountCents=0;},x=>{x.activities[1]={...x.activities[0]};},x=>{x.activities[0].billId='1';}]){const value=settle();mutate(value);assert.throws(()=>validateChoices(value));}
 for(const mutate of [s=>{s.details.adoptedSettlement.amountCents=5000001;},s=>{s.details.adoptedSettlement.entity='Bill';},s=>{s.dependencies=[{logicalKey:'f'.repeat(64)}];},s=>{s.details.amountSourceKey='f'.repeat(64);},s=>{s.details.destination='operating_bank';},s=>{delete s.details.adoptedSettlement;}]){const f=prepared(settle()),step=structuredClone(f.candidate.entries[0].step);mutate(step);assert.throws(()=>batchLifecycle(step));}
});
test('a batch saved under the first policy still rebuilds; it cannot claim the newer workflows',()=>{
 const v1=hash({version:1,key:'non-stock-business-activity-v1',maxActivities:12,maxQuantity:8,maxUnitPriceCents:100000,maxExpenseCents:1000000,maxBatchCents:12000000,workflows:['settled-service-sale','paid-operating-expense']});
 assert.equal(v1.slice(0,12),'a3715d415042','the hash saved on Production batches');
 const saved={...prepared().batch,policyHash:v1};
 assert.deepEqual(buildBatchActivity(saved,scope,'harbour-pine-v2').events.map(row=>row.entity),['Estimate','TimeActivity','Invoice','Payment','Deposit']);
 const settlement={...saved,activities:[{type:'collect-adopted-invoice',invoiceId:'10720',customerKey:'care-client-021',amountCents:1000,purpose:'Collect an imported invoice.'}]};
 settlement.requestHash=hash({decisionKey:settlement.decisionKey,purpose:settlement.purpose,activities:settlement.activities});
 assert.throws(()=>buildBatchActivity(settlement,scope,'harbour-pine-v2'),/policy changed/);
 assert.throws(()=>buildBatchActivity({...saved,policyHash:'0'.repeat(64)},scope,'harbour-pine-v2'),/policy changed/);
});
test('policy v3 adds cash expenses and supplier credits; a v2 batch rebuilds but cannot claim them',()=>{
 const v2=hash({version:2,key:'business-activity-v2',maxActivities:12,maxQuantity:8,maxUnitPriceCents:100000,maxExpenseCents:1000000,maxSettlementCents:5000000,maxBatchCents:12000000,workflows:['settled-service-sale','paid-operating-expense','collect-adopted-invoice','pay-adopted-bill']});
 const input={decisionKey:'cash-expense-decision-001',purpose:'Pay a software charge from the bank and record a landlord credit.',activities:[{type:'paid-cash-expense',vendorKey:'overhead-supplier-3',category:'software',amountCents:4500,purpose:'Monthly software seat paid from the bank.'},{type:'supplier-credit',vendorKey:'overhead-supplier-1',category:'premises',amountCents:2000,purpose:'Landlord credit for an overbilled charge.'}]};
 const f=prepared(input);assert.equal(f.batch.policyHash,POLICY_HASH);assert.equal(validateActivityBatch(f.batch,f.candidate),f.batch);
 assert.deepEqual(f.activity.events.map(row=>row.entity),['Purchase','VendorCredit']);
 const [expense,credit]=f.candidate.entries.map(row=>row.step);
 assert.deepEqual(batchLifecycle(expense).mode,'cash-expense');assert.deepEqual(batchLifecycle(expense).expense,{category:'software',accountMapping:'operatingExpense',amountCents:4500,billableStatus:'NotBillable'});
 assert.equal(batchLifecycle(credit).mode,'supplier-credit');assert.equal(expense.details.bankMapping,'operatingBank');assert.equal(credit.details.bankMapping,undefined);
 for(const mutate of [s=>{s.details.lines[0].billableStatus='Billable';},s=>{s.details.lines[0].amountCents=1;},s=>{s.details.vendorKey='stock-supplier-1';},s=>{s.details.bankMapping='other';},s=>{s.details.lines.push({...s.details.lines[0],key:'second'});},s=>{s.dependencies=[{logicalKey:'f'.repeat(64)}];},s=>{s.details.customerKey='field-client-001';}]){const changed=structuredClone(expense);mutate(changed);assert.throws(()=>batchLifecycle(changed),/cash expense/);}
 const wrongCredit=structuredClone(credit);wrongCredit.details.bankMapping='operatingBank';assert.throws(()=>batchLifecycle(wrongCredit),/supplier credit/);
 const old={...prepared().batch,policyHash:v2};assert.equal(buildBatchActivity(old,scope,'harbour-pine-v2').events.length,5);
 const claimed={...f.batch,policyHash:v2};assert.throws(()=>buildBatchActivity(claimed,scope,'harbour-pine-v2'),/policy changed/);
 assert.throws(()=>validateChoices({...input,activities:[{...input.activities[0],amountCents:1000001}]}),/capacity/);
 assert.throws(()=>validateChoices({...input,activities:[{...input.activities[1],vendorKey:'stock-supplier-1'}]}),/published operating supplier/);
});
test('policy v4 adds customer credits, refunds, transfers and journal entries; a v3 batch rebuilds but cannot claim them',()=>{
 const v3=hash({version:3,key:'business-activity-v3',maxActivities:12,maxQuantity:8,maxUnitPriceCents:100000,maxExpenseCents:1000000,maxSettlementCents:5000000,maxBatchCents:12000000,workflows:['settled-service-sale','paid-operating-expense','collect-adopted-invoice','pay-adopted-bill','paid-cash-expense','supplier-credit']});
 const journal=[{accountKey:'operatingExpense',postingType:'Debit',amountCents:3000},{accountKey:'careIncome',postingType:'Credit',amountCents:3000}];
 const input={decisionKey:'credit-refund-decision-001',purpose:'Credit and refund a client and record a bank charge from the statement.',activities:[{type:'customer-credit',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:1,unitPriceCents:9000,purpose:'Goodwill credit for a short visit.'},{type:'customer-refund',customerKey:'care-client-002',itemKey:'care-plan-1',quantity:1,unitPriceCents:4500,purpose:'Refund for a cancelled care plan month.'},{type:'journal-entry',lines:journal,purpose:'Bank service charge from the statement.'}]};
 const f=prepared(input);assert.equal(f.batch.policyHash,POLICY_HASH);assert.equal(validateActivityBatch(f.batch,f.candidate),f.batch);
 assert.deepEqual(f.activity.events.map(row=>row.entity),['CreditMemo','RefundReceipt','JournalEntry']);
 const [credit,refund,entry]=f.candidate.entries.map(row=>row.step);
 assert.equal(batchLifecycle(credit).mode,'customer-credit');assert.equal(batchLifecycle(refund).mode,'customer-refund');assert.equal(refund.details.bankMapping,'operatingBank');assert.equal(credit.details.bankMapping,undefined);
 assert.deepEqual(batchLifecycle(entry).journal,[{accountMapping:'operatingExpense',postingType:'Debit',amountCents:3000},{accountMapping:'careIncome',postingType:'Credit',amountCents:3000}]);
 for(const mutate of [s=>{s.details.lines[0].amountCents=1;},s=>{s.details.customerKey='stock-supplier-1';},s=>{s.details.bankMapping='operatingBank';},s=>{s.details.lines[0].accountMapping='supplyIncome';},s=>{s.dependencies=[{logicalKey:'f'.repeat(64)}];}]){const changed=structuredClone(credit);mutate(changed);assert.throws(()=>batchLifecycle(changed),/customer credit/);}
 for(const mutate of [s=>{s.details.lines[1].amountCents=2999;s.details.baseAmountCents=3000;},s=>{s.details.lines[0].accountMapping='accountsReceivable';},s=>{s.details.lines.pop();},s=>{s.details.taxMapping='salesTax';}]){const changed=structuredClone(entry);mutate(changed);assert.throws(()=>batchLifecycle(changed),/journal/i);}
 const old={...prepared().batch,policyHash:v3};assert.equal(buildBatchActivity(old,scope,'harbour-pine-v2').events.length,5);
 assert.throws(()=>buildBatchActivity({...f.batch,policyHash:v3},scope,'harbour-pine-v2'),/policy changed/);
 const one=row=>({...input,activities:[row]});
 assert.throws(()=>validateChoices(one({type:'bank-transfer',fromKey:'operatingBank',toKey:'operatingBank',amountCents:1000,purpose:'Move cash to savings.'})),/two published bank accounts/);
 assert.throws(()=>validateChoices(one({type:'journal-entry',lines:[{...journal[0]},{...journal[1],amountCents:2000}],purpose:'Unbalanced entry.'})),/must balance/);
 assert.throws(()=>validateChoices(one({type:'journal-entry',lines:[{...journal[0],accountKey:'accountsPayable'},journal[1]],purpose:'Payables need a party.'})),/published bank, income/);
 assert.throws(()=>validateChoices(one({type:'journal-entry',lines:[journal[0]],purpose:'One line only.'})),/two to four/);
 assert.throws(()=>validateChoices(one({type:'customer-refund',customerKey:'field-client-001',itemKey:'workshop-stock-1',quantity:1,unitPriceCents:100,purpose:'Stock is not a service.'})),/observed service/);
});
test('a journal entry cannot touch the bank, so it cannot create income or spending without a party',()=>{
 const base={decisionKey:'journal-reclass-0001',purpose:'Reclassify an amount between income and operating expense accounts.',activities:[{type:'journal-entry',lines:[{accountKey:'operatingExpense',postingType:'Debit',amountCents:3000},{accountKey:'operatingBank',postingType:'Credit',amountCents:3000}],purpose:'Bank line is not allowed.'}]};
 assert.throws(()=>validateChoices(base));
 base.activities[0].lines[1].accountKey='serviceIncome';assert.doesNotThrow(()=>validateChoices(base));
});
