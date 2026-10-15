'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { activityDefinition, previewBusinessActivity } = require('../src/modules/business-activity-preview');
const { planBusinessCalendar, hash } = require('../src/modules/business-calendar');
const { describeBusinessActivity } = require('../src/modules/business-activity-details');
const { proposalView, buildDraftDefinition, draftView } = require('../src/modules/blueprint-draft');
const { masterRequirements } = require('../src/modules/business-master-data');
// Captured from pushed54e7b76 before lifecycle changes; these are immutable compatibility contracts.
const legacy = {
  "input": {
    "openingDate": "2024-01-01",
    "fromDate": "2024-02-01",
    "throughDate": "2024-02-29",
    "today": "2026-10-15",
    "scope": {
      "realmId": "123",
      "environment": "sandbox"
    },
    "requestKey": "11111111-1111-4111-8111-111111111111",
    "connectionId": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "baseHash": null
  },
  "profiles": {
    "development": {
      "business": {
        "displayName": "Harbour & Pine Operations Inc.",
        "openingDate": "2024-01-01",
        "historicalMonths": 36,
        "fiscalYearStartMonth": 9,
        "volumeProfile": "development"
      },
      "activityDefinitionHash": "5917815e7d42516af724f4fa040a8d563b6e69150f9af2233811cabdf41a04be",
      "calendarPlanHash": "32b142eab803a3b9f48587c1a3c9787d05660a57decf1d1d3fb62a074b0ebf60",
      "calendarHash": "b89a220d7b341d2a588bed612f1d1d2fe1f257470f937dccf012eccf0855c298",
      "detailsFingerprint": "de4a54c1ca4ec33817e9e1f08b84d020ff21aac14ec4ff50997cd8fd4028969e",
      "detailsHash": "b7694c3c45fa740bfc3c3ab809f10228e39ca7f1102f3d9642ace2cb668b46ba",
      "draftDefinitionHash": "0774be5c65d81553ae073559889fddde7ce58ae2e970e03a5d495e9da401f95e"
    },
    "flagship": {
      "business": {
        "displayName": "Harbour & Pine Operations Inc.",
        "openingDate": "2024-01-01",
        "historicalMonths": 36,
        "fiscalYearStartMonth": 9,
        "volumeProfile": "flagship"
      },
      "activityDefinitionHash": "795b65e2a15be8b7808b66ce9591d57b704c4e08a061dc1a6cbc495631804d64",
      "calendarPlanHash": "4e321e9e88d628b09a61228e8943330acde4740e6bd1de0f703000522165654d",
      "calendarHash": "fbe6e98405c878403cf21491c354198649c2ecd46b4f5da60055ad49402ad3ac",
      "detailsFingerprint": "dd56301fcaec3f669403d3c0aa6b1e182037a6ac1cdea760e0817af9a833d2ad",
      "detailsHash": "b8d0a64db702cfe7445bcf5dc8d121795ff7655eb6c676ac71760eee58bf43fb",
      "draftDefinitionHash": "1577a2c475b74d8171fd546c60669e891826f1e26ea5df06b6a93dd8aba3981d"
    }
  }
};
test('version1 business definitions, calendars and transaction details retain their original bytes', () => {
 for (const [volumeProfile, before] of Object.entries(legacy.profiles)) {
  const business = before.business, definition = activityDefinition(business);
  assert.equal(hash(definition), before.activityDefinitionHash);
  assert.deepEqual(activityDefinition({...business,activityTemplateVersion:1}), definition);
  const calendar = planBusinessCalendar({...legacy.input,definition});
  assert.equal(calendar.planHash,before.calendarPlanHash);assert.equal(hash(calendar),before.calendarHash);
  const details = describeBusinessActivity(calendar);
  assert.equal(details.detailProposal.fingerprint,before.detailsFingerprint);assert.equal(hash(details),before.detailsHash);
  const input = {requestKey:legacy.input.requestKey,connectionId:legacy.input.connectionId,baseHash:null,business,mappings:proposalView().mappings,masterBindings:{}};
  const saved = buildDraftDefinition(input);
  assert.equal(hash(saved),before.draftDefinitionHash);assert.equal(saved.activityTemplateVersion,undefined);
  const explicit = buildDraftDefinition({...input,business:{...business,activityTemplateVersion:1}});
  assert.deepEqual(explicit,saved);assert.equal(draftView({_id:'d'.repeat(24),definition:saved,connectionId:legacy.input.connectionId},legacy.input.connectionId).business.activityTemplateVersion,undefined);
  assert.equal(masterRequirements(business).filter(row=>row.key.startsWith('overhead-supplier')).length,0,volumeProfile);
 }
});
function previewV2(volumeProfile='development',fromDate='2026-10-01',throughDate='2026-10-31') {
 const proposal=proposalView();proposal.business={...proposal.business,openingDate:'2026-10-01',volumeProfile,activityTemplateVersion:2};
 const view={realmId:'123',environment:'sandbox',connectionId:'a'.repeat(24),draft:null,proposal};
 return previewBusinessActivity(view,{connectionId:view.connectionId,baseHash:null,fromDate,throughDate},'2026-12-01');
}
test('new proposed template explicitly includes operating bills and planned settlement variation',()=>{
 assert.equal(proposalView().business.activityTemplateVersion,2);
 for(const [volumeProfile,target] of [['development',80],['flagship',278]]) {
  const result=previewV2(volumeProfile);assert.equal(result.templateVersion,2);assert.equal(result.businessKey,'harbour-pine-v2');assert.equal(result.monthlyTarget,target);
  const definition=activityDefinition({...proposalView().business,openingDate:'2026-10-01',volumeProfile,activityTemplateVersion:2});assert.equal(definition.rules.reduce((n,r)=>n+r.steps.length,0),target);
  const all=[...result.events,...result.future,...result.prerequisites];
  const first=all.find(row=>row.ruleKey==='field-job-001'&&row.stepKey==='payment'),last=all.find(row=>row.ruleKey==='field-job-001'&&row.stepKey==='final-payment');
  assert.equal(first.txnDate,'2026-10-22');assert.equal(last.txnDate,'2026-11-15');assert.ok(last.dependsOn.includes(first.logicalKey));
  assert.equal(result.detailProposal.byLogicalKey[first.logicalKey].details.settlement.basisPoints,6000);assert.equal(result.detailProposal.byLogicalKey[last.logicalKey].details.settlement.priorPaymentKey,first.logicalKey);
  const overhead=result.events.filter(row=>row.ruleKey.startsWith('operating-overhead')&&row.entity==='Bill');assert.equal(overhead.length,3);
  assert.deepEqual(overhead.map(row=>result.detailProposal.byLogicalKey[row.logicalKey].details.baseAmountCents).sort((a,b)=>a-b),[9500,18000,95000]);
  for(const row of overhead){const details=result.detailProposal.byLogicalKey[row.logicalKey].details;assert.equal(details.activityTemplateVersion,2);assert.equal(details.lines[0].accountMapping,'operatingExpense');assert.equal(details.lines[0].itemKey,undefined);assert.equal(details.customerKey,undefined);}
  assert.ok(result.events.every(row=>row.txnDate<=result.throughDate));assert.ok(result.future.some(row=>row.stepKey==='final-deposit'));
 }
});
test('opening stock buffer is retained once and quotes/time/invoices share seasonal hours',()=>{
 const first=previewV2(),second=previewV2('development','2026-11-01','2026-11-30');
 for(const [result,buffer] of [[first,6],[second,0]]){
  const all=[...result.events,...result.future,...result.prerequisites],occurrence=result.fromDate;
  const bill=all.find(row=>row.ruleKey==='supply-order-001'&&row.occurrence===occurrence&&row.entity==='Bill'),sale=all.find(row=>row.ruleKey==='supply-order-001'&&row.occurrence===occurrence&&row.entity==='SalesReceipt');
  const b=result.detailProposal.byLogicalKey[bill.logicalKey].details,s=result.detailProposal.byLogicalKey[sale.logicalKey].details;
  assert.equal(b.lines[0].quantity-s.lines[0].quantity,buffer);assert.deepEqual(s.stockQuantityRule,{purchasedQuantity:b.lines[0].quantity,retainedQuantity:buffer});
 }
 const business={...proposalView().business,openingDate:'2026-01-01',volumeProfile:'development'},scope={realmId:'123',environment:'sandbox'};
 const details=month=>{const plan=planBusinessCalendar({definition:activityDefinition(business),scope,fromDate:'2026-'+month+'-01',throughDate:'2026-'+month+'-28',today:'2026-12-01'}),proposal=describeBusinessActivity(plan),events=[...plan.events,...plan.future,...plan.prerequisites];return events.filter(row=>row.ruleKey==='field-job-001'&&row.occurrence==='2026-'+month+'-01').map(row=>({entity:row.entity,details:proposal.detailProposal.byLogicalKey[row.logicalKey].details}));};
 const winter=details('01'),summer=details('07');assert.equal(summer.find(row=>row.entity==='TimeActivity').details.hours,winter.find(row=>row.entity==='TimeActivity').details.hours+1);
 for(const rows of [winter,summer])assert.deepEqual(rows.find(row=>row.entity==='Estimate').details.lines,rows.find(row=>row.entity==='Invoice').details.lines);
});

const { fixture: compilerFixture } = require('./helpers/business-transaction-fixtures');
const { lifecyclePolicy, installmentCents } = require('../src/modules/business-lifecycle-policy');
const { bindBusinessReference } = require('../src/modules/business-reference');
const { verifyBusinessContent } = require('../src/modules/business-readback');
function v2Compiler(ruleKey, stepKey) {
 const result=previewV2(),event=[...result.events,...result.future,...result.prerequisites].find(row=>row.ruleKey===ruleKey&&row.stepKey===stepKey&&row.occurrence==='2026-10-01');
 const f=compilerFixture(event.entity),details=structuredClone(result.detailProposal.byLogicalKey[event.logicalKey].details);
 f.now=Date.parse('2026-12-01T12:00:00Z');const stamp=new Date(f.now).toISOString();f.observationFence.observedAt=stamp;
 f.step={...f.step,logicalKey:event.logicalKey,txnDate:event.txnDate,calendarFingerprint:event.fingerprint,details};
 for(const binding of f.step.references)if(binding.key==='client')binding.key=details.customerKey||'client';else if(binding.key==='supplier')binding.key=details.vendorKey||'supplier';else if(binding.key==='stock'&&details.lines[0]?.itemKey)binding.key=details.lines[0].itemKey;
 if(event.entity==='Bill'){f.parents=[];const record={Id:'608',SyncToken:'0',Active:true,AccountType:'Expense'},recordHash=hash(record),observation={scope:f.scope,entity:'Account',record,recordHash,observedAt:stamp,operationId:f.observationFence.operationId,writerRevision:4,source:{version:1,kind:'qbo-full-entity-get',scope:f.scope,entity:'Account',id:record.Id,endpoint:'account/'+record.Id,recordHash}};f.referenceEvidence.push(observation);f.step.references.push(bindBusinessReference({scope:f.scope,entity:'Account',key:'operatingExpense',observed:observation,now:f.now}));}
 const source=f.parents.find(row=>row.entity==='Invoice');
 if(source){source.logicalKey=details.amountSourceKey;source.record.TxnDate='2026-10-08';source.record.TotalAmt=282.51;source.record.Balance=282.51;}
 if(details.settlement?.stage==='remainder'){
  const prior={...structuredClone(source),entity:'Payment',logicalKey:details.settlement.priorPaymentKey,fingerprint:hash('prior managed installment'),qboId:'1005',syncToken:'0',record:{Id:'1005',SyncToken:'0',TxnDate:'2026-10-22',CurrencyRef:{value:'CAD'},CustomerRef:{value:'10'},ARAccountRef:{value:'601'},DepositToAccountRef:{value:'603'},TotalAmt:169.51,UnappliedAmt:0,Line:[{Amount:169.51,LinkedTxn:[{TxnId:source.qboId,TxnType:'Invoice'}]}]}};
  f.parents.push(prior);source.record.Balance=113;source.record.LinkedTxn=[{TxnId:prior.qboId,TxnType:'Payment'}];
 }
 if(event.entity==='SalesReceipt'){const bill=f.parents[0];bill.logicalKey=details.references[0].logicalKey;bill.record.Line[0].ItemBasedExpenseLineDetail.Qty=18;bill.record.Line[0].Amount=369;bill.record.TotalAmt=416.97;bill.record.Balance=416.97;}
 for(const value of [...f.referenceEvidence,...f.parents])value.observedAt=stamp;
 f.step.dependencies=f.parents.map(row=>({entity:row.entity,logicalKey:row.logicalKey,fingerprint:row.fingerprint}));
 f.policy.fromDate='2026-10-01';f.policy.throughDate='2026-12-01';
 f.approve=()=>{f.step.detailsHash=hash({calendarFingerprint:f.step.calendarFingerprint,details:f.step.details});f.policy.stepHash=hash(f.step);f.policy.lifecycle=lifecyclePolicy(f.step);};
 f.refresh();f.approve();return f;
}
test('installments use accepted taxed gross and exact cents, keeping prior payment prerequisite-only',()=>{
 assert.equal(installmentCents(28251),16951);assert.equal(installmentCents(1000000000000),600000000000);
 const first=v2Compiler('field-job-001','payment'),one=JSON.parse(first.compile().request.body);assert.equal(one.TotalAmt,169.51);assert.equal(one.Line[0].Amount,169.51);assert.equal(one.ProcessPayment,false);
 const last=v2Compiler('field-job-001','final-payment'),compiled=last.compile(),two=JSON.parse(compiled.request.body);assert.equal(two.TotalAmt,113);assert.deepEqual(two.Line[0].LinkedTxn,[{TxnId:'1003',TxnType:'Invoice'}]);assert.equal(compiled.relationships.find(row=>row.entity==='Payment').kind,'prerequisite');assert.equal(two.LinkedTxn,undefined);
 for(const mutate of [f=>{f.parents[0].record.Balance=112.99;},f=>{f.parents[1].record.TotalAmt=169.50;},f=>{f.parents[1].record.Line[0].LinkedTxn[0].TxnId='999';},f=>{f.parents[1].record.CustomerRef.value='999';},f=>{f.parents[1].record.DepositToAccountRef.value='600';},f=>{f.parents[1].record.ARAccountRef.value='999';},f=>{f.parents[1].record.UnappliedAmt=1;},f=>{f.parents[0].record.LinkedTxn.push({TxnId:'999',TxnType:'Payment'});}]){const f=v2Compiler('field-job-001','final-payment');mutate(f);f.refresh();assert.throws(f.compile,/installment|remaining/);}
 const missing=v2Compiler('field-job-001','payment');delete missing.policy.lifecycle;assert.throws(missing.compile,/approved lifecycle/);
 const changed=v2Compiler('field-job-001','payment');changed.step.details.settlement.basisPoints=5000;assert.throws(()=>changed.approve(),/sixty-percent/);
});
test('reduced stock sale requires original opening quantity contract and legacy full-batch rules stay strict',()=>{
 const f=v2Compiler('supply-order-001','sale'),body=JSON.parse(f.compile().request.body);assert.equal(body.Line[0].SalesItemLineDetail.Qty,12);
 f.parents[0].record.Line[0].ItemBasedExpenseLineDetail.Qty=19;f.refresh();assert.throws(f.compile,/stock/i);
 const changed=v2Compiler('supply-order-001','sale');changed.step.details.lines[0].quantity=13;assert.throws(()=>changed.approve(),/quantities/);
 const old=compilerFixture('SalesReceipt');old.parents[0].record.Line[0].ItemBasedExpenseLineDetail.Qty=18;old.refresh();assert.throws(old.compile,/stock/i);
});
test('nonbillable overhead uses its exact expense account, AP, tax and terms and verifies saved readback',()=>{
 const f=v2Compiler('operating-overhead-001','bill'),compiled=f.compile(),record={...JSON.parse(compiled.request.body),Id:'2000',SyncToken:'0',TotalAmt:1073.50,Balance:1073.50,TxnTaxDetail:{TotalTax:123.50,TaxLine:[{Amount:123.50,DetailType:'TaxLineDetail',TaxLineDetail:{TaxRateRef:{value:'950'},PercentBased:true,TaxPercent:13,NetAmountTaxable:950}}]}};
 assert.equal(record.DueDate,'2026-10-31');assert.equal(record.APAccountRef.value,'602');assert.equal(record.CustomerRef,undefined);assert.equal(record.LinkedTxn,undefined);assert.deepEqual(record.Line,[{Amount:950,DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:{value:'608'},BillableStatus:'NotBillable',TaxCodeRef:{value:'901'}}}]);
 const observed={scope:f.scope,entity:'Bill',record,recordHash:hash(record),observedAt:new Date(f.now).toISOString()},receipt={version:1,scope:f.scope,entity:'Bill',logicalKey:compiled.logicalKey,requestHash:compiled.request.requestHash,dispatchKey:hash('expense dispatch'),qboId:record.Id,evidenceHash:hash('expense response'),source:'create-response'},taxPolicy={version:1,status:'approved',scope:f.scope,compilationHash:compiled.compilationHash,evidenceHash:hash('fixture tax'),totalTaxCents:12350,lines:[{rateId:'950',percent:13,taxableCents:95000,amountCents:12350}]};
 const check=()=>{observed.recordHash=hash(record);return verifyBusinessContent({compiled,observed,receipt,taxPolicy,now:f.now});};assert.equal(check().matchesIntent,true);
 for(const mutate of [r=>{r.DueDate='2026-11-01';},r=>{r.Line[0].AccountBasedExpenseLineDetail.AccountRef.value='999';},r=>{r.Line[0].AccountBasedExpenseLineDetail.BillableStatus='Billable';},r=>{r.Line[0].AccountBasedExpenseLineDetail.CustomerRef={value:'10'};}]){const before=structuredClone(record);mutate(record);assert.equal(check().matchesIntent,false);for(const key of Object.keys(record))delete record[key];Object.assign(record,before);}
});
