'use strict';
const {hash}=require('../../src/modules/business-calendar');
const F=require('../../src/modules/general-calendar-fulfillment');
const {fixture,scope,ownerId,clock,bound,clone}=require('./general-time-estimate-native-fixture');
const {fixture:transactionFixture}=require('./business-transaction-fixtures');
async function setup(t,{completed=true,beforeRepair=async()=>{},nativeOptions={},stepDate=null,dueDate=null}={}) {
 const h=fixture(t,'success',nativeOptions);h.active.value.baselineHash=hash('accepted opening baseline');
 await beforeRepair(h);if(completed)await h.repair();
 const tx=transactionFixture('Invoice'),identities=h.data.Steps.map(s=>({logicalKey:s.logicalKey,entity:s.entity,fingerprint:s.fingerprint}));
 Object.assign(tx.step,{logicalKey:h.logicalKey,calendarFingerprint:h.activity.events[0].fingerprint,txnDate:stepDate||h.invoice.TxnDate,dependencies:identities});tx.step.details.references=identities.map(({logicalKey,entity})=>({logicalKey,entity}));if(dueDate){tx.step.details.dueDate=dueDate;tx.step.details.activityTemplateVersion=2;tx.step.details.origin={openingDate:'2026-10-01',occurrence:'2026-10-01',ruleKey:'field-job-001',stepKey:'invoice'};tx.policy.lifecycle=require('../../src/modules/business-lifecycle-policy').lifecyclePolicy(tx.step);}tx.policy.throughDate=stepDate||h.invoice.TxnDate;tx.policy.readbackTax={version:1,totalTaxCents:3250,lines:[{rateId:'950',percent:13,taxableCents:25000,amountCents:3250}]};tx.approve();tx.step=F.normalizedStep(tx.step);tx.policy.stepHash=hash(tx.step);
 const service=F.createGeneralCalendarFulfillment({...h.config,assertReady:async()=>{}});
 return {...h,step:tx.step,policy:tx.policy,service,freeze:()=>service.freeze({scope,step:tx.step,policy:tx.policy,active:h.active})};
}

module.exports={setup,scope,ownerId,clock,bound,clone};
