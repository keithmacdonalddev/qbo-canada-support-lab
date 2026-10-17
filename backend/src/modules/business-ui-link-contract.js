'use strict';
const {hash,canonical}=require('./business-calendar');
const {scoped,freezeWriteRequest}=require('./qbo-write-contract');
const {observation,headerLinks,creationIdentity}=require('./business-link-repair-contract');
const PLAN='business-ui-link-correction-plan',ATTEMPT='business-ui-link-correction-attempt',OBSERVATION='business-ui-link-correction-observation',OUTCOME='business-ui-link-correction-outcome';
const PROVENANCE='agent-operated authenticated QBO browser session under owner full-company authority';
const PROCEDURE='copy-exact-whole-estimate-into-existing-invoice';
const HASH=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{24}$/,QID=/^[1-9]\d{0,29}$/;
const equal=(a,b)=>canonical(a)===canonical(b);
function fail(message){throw Object.assign(new Error(message),{status:409,code:'BUSINESS_UI_LINK_CORRECTION_UNVERIFIED'});}
const financial=record=>(record.Line||[]).filter(line=>line.DetailType!=='SubTotalLineDetail');
function assertUiPlan(p,now=Date.now(),fresh=false){
 if(!p||p.version!==1||p.kind!==PLAN||!ID.test(p.ownerId||'')||!ID.test(p.operationId||'')||!HASH.test(p.planHash||'')||!HASH.test(p.logicalKey||'')||!HASH.test(p.publishedAuthorityHash||'')||!HASH.test(p.priorReverseNoEffectHash||'')||p.actorProvenance!==PROVENANCE||p.procedure!==PROCEDURE||typeof p.reason!=='string'||p.reason.length<30||p.reason.length>2000||!equal(scoped(p.scope),p.scope)||!p.state)fail('Exact scoped browser correction authority is required.');
 const stamp=Date.parse(p.reviewedAt);if(!Number.isFinite(stamp)||new Date(stamp).toISOString()!==p.reviewedAt||stamp>now||(fresh&&now-stamp>300000))fail('Browser correction review is stale or invalid.');
 const clock=fresh?now:stamp,step=p.originalStep,request=require('./business-readback').validateCompilation(step?.compilation),payload=JSON.parse(request.body),origins=step?.compilation?.relationships||[],estimate=origins.filter(x=>x.entity==='Estimate'),time=origins.filter(x=>x.entity==='TimeActivity');
 if(step.entity!=='Invoice'||String(step.operationId)!==p.operationId||step.planHash!==p.planHash||step.logicalKey!==p.logicalKey||request.entity!=='invoice'||!equal(request.scope,p.scope)||step.compilation.logicalKey!==p.logicalKey||origins.length!==2||estimate.length!==1||time.length!==1||origins.some(x=>x.kind!=='linked')||!Array.isArray(p.identities)||p.identities.length<3||p.identities.length>500||new Set(p.identities.map(x=>x.logicalKey)).size!==p.identities.length||!equal(p.identities.find(x=>x.logicalKey===p.logicalKey),creationIdentity(step)))fail('The original accepted Invoice compilation and three-record chain are required.');
 for(const identity of p.identities)if(!HASH.test(identity.logicalKey||'')||!QID.test(identity.qboId||'')||!['fingerprint','compilationHash','compilation','dispatch','receipt'].every(k=>HASH.test(identity[k]||'')))fail('Every original creation needs exact retained identity.');
 for(const origin of origins)if(p.identities.filter(x=>x.entity===origin.entity&&x.logicalKey===origin.logicalKey&&x.qboId===origin.qboId&&x.fingerprint===origin.fingerprint).length!==1)fail('Both parents must belong to the original accepted operation.');
 const b=p.before||{},invoice=observation(b.invoice,p.scope,'Invoice',step.qboId,clock),source=observation(b.estimate,p.scope,'Estimate',estimate[0].qboId,clock),work=observation(b.time,p.scope,'TimeActivity',time[0].qboId,clock),customer=observation(b.customer,p.scope,'Customer',invoice.CustomerRef?.value,clock);
 if(!equal(invoice.LinkedTxn,[{TxnId:work.Id,TxnType:'TimeActivity'}])||source.LinkedTxn!==undefined||!['Pending','Accepted'].includes(source.TxnStatus)||work.BillableStatus!=='HasBeenBilled'||work.LinkedTxn!==undefined||customer.Active!==true||invoice.Balance!==invoice.TotalAmt||invoice.HomeBalance!==invoice.HomeTotalAmt||!equal(invoice.CustomerRef,source.CustomerRef)||invoice.CustomerRef.value!==work.CustomerRef?.value||invoice.CurrencyRef?.value!=='CAD'||payload.CustomerRef?.value!==customer.Id||invoice.TxnDate!==payload.TxnDate||invoice.Line?.some(line=>line.LinkedTxn!==undefined))fail('Only the exact unchanged unconverted owned chain is eligible.');
 const original=financial(invoice),quoted=financial(source),wanted=payload.Line;
 if(original.length!==1||quoted.length!==1||wanted?.length!==1||original[0].DetailType!=='SalesItemLineDetail'||quoted[0].DetailType!=='SalesItemLineDetail'||!QID.test(original[0].Id||'')||!QID.test(quoted[0].Id||'')||!equal(wanted[0].LinkedTxn,[{TxnId:source.Id,TxnType:'Estimate',TxnLineId:quoted[0].Id}]))fail('One exact original sales line and its requested Estimate source line are required.');
 const economy=line=>({Amount:line.Amount,DetailType:line.DetailType,ItemRef:line.SalesItemLineDetail?.ItemRef?.value,Qty:line.SalesItemLineDetail?.Qty,UnitPrice:line.SalesItemLineDetail?.UnitPrice,TaxCodeRef:line.SalesItemLineDetail?.TaxCodeRef?.value});
 if(!equal(economy(original[0]),economy(quoted[0]))||!equal(economy(original[0]),economy(wanted[0]))||work.ItemRef?.value!==original[0].SalesItemLineDetail.ItemRef.value||work.Hours+work.Minutes/60!==original[0].SalesItemLineDetail.Qty||invoice.TotalAmt!==source.TotalAmt||invoice.GlobalTaxCalculation!==source.GlobalTaxCalculation||invoice.ExchangeRate!==source.ExchangeRate||!equal(invoice.CurrencyRef,source.CurrencyRef)||!equal(invoice.TxnTaxDetail,source.TxnTaxDetail))fail('The existing full Estimate, billed time and invoice economics must already match exactly.');
 const allowed=p.lineReplacement;
 if(!allowed||allowed.originalInvoiceLineId!==original[0].Id||allowed.originalLineHash!==hash(original[0])||allowed.estimateSourceLineId!==quoted[0].Id||allowed.estimateSourceLineHash!==hash(quoted[0])||allowed.allowIdChange!==true||allowed.allowExactOriginalEstimateLink!==true)fail('The reviewed original-to-source line identity exception is unavailable.');
 const ui=p.uiEvidence;
 if(!ui||ui.version!==1||ui.companyId!==p.scope.realmId||ui.invoiceId!==invoice.Id||ui.estimateId!==source.Id||ui.invoiceLogicalKey!==p.logicalKey||ui.origin!=='https://qbo.intuit.com'||ui.actorProvenance!==PROVENANCE||!HASH.test(ui.artifactHash||'')||!Number.isFinite(Date.parse(ui.observedAt))||Date.parse(ui.observedAt)>stamp||stamp-Date.parse(ui.observedAt)>300000)fail('Fresh visible browser company identity and actor evidence are required.');
 const budget=p.allocation;
 if(!budget||!Number.isSafeInteger(budget.previousCompanyRepairSdkGets)||budget.previousCompanyRepairSdkGets<0||!Number.isSafeInteger(budget.maxSdkGets)||budget.maxSdkGets<1||budget.maxSdkGets>1000||budget.aggregateMaxSdkGets!==budget.previousCompanyRepairSdkGets+budget.maxSdkGets||!Number.isSafeInteger(budget.oldApiRepairMaxSdkGets)||budget.oldApiRepairMaxSdkGets<budget.previousCompanyRepairSdkGets||budget.oldApiInvoiceUpdateConsumed!==true||budget.oldApiEstimateUpdateConsumed!==true||!Number.isSafeInteger(budget.maxDurationMs)||budget.maxDurationMs<1||budget.maxDurationMs>1800000)fail('The separate reviewed browser workflow allocation and prior consumed attempts are required.');
 return p;
}
// A semantic request used ONLY by the existing protected-period reader. This is
// neither a claimed SDK request nor permission to transmit any accounting POST.
function uiPeriodGuardRequest(p){return freezeWriteRequest(p.scope,'POST','invoice',{Id:p.before.invoice.record.Id,SyncToken:p.before.invoice.record.SyncToken,sparse:true,LinkedTxn:[{TxnId:p.before.estimate.record.Id,TxnType:'Estimate'},{TxnId:p.before.time.record.Id,TxnType:'TimeActivity'}]});}
function metadata(record){const value=structuredClone(record);delete value.SyncToken;if(value.MetaData){delete value.MetaData.LastUpdatedTime;delete value.MetaData.LastModifiedByRef;}return value;}
function assertMetadata(before,after){
 if(!before.MetaData||!Number.isFinite(Date.parse(before.MetaData.LastUpdatedTime))||!after.MetaData||!Number.isFinite(Date.parse(after.MetaData.LastUpdatedTime))||Date.parse(after.MetaData.LastUpdatedTime)<Date.parse(before.MetaData?.LastUpdatedTime)||BigInt(after.SyncToken)<BigInt(before.SyncToken))fail('Browser correction metadata moved backwards or became invalid.');
 const modifier=after.MetaData.LastModifiedByRef;if(modifier!==undefined&&(!modifier||Object.keys(modifier).some(k=>k!=='value')||!QID.test(modifier.value||'')))fail('Browser modifier metadata has an unsupported shape.');
}
function observations(p,after,now,notBefore){if(notBefore!==undefined&&(!Number.isFinite(Date.parse(notBefore))||Date.parse(notBefore)>now))fail('Invalid persisted browser action boundary.');for(const [key,entity]of Object.entries({invoice:'Invoice',estimate:'Estimate',time:'TimeActivity',customer:'Customer'})){observation(after[key],p.scope,entity,p.before[key].record.Id,now);if(notBefore!==undefined&&Date.parse(after[key].observedAt)<Date.parse(notBefore))fail('Native readback predates the persisted browser action boundary.');}}
function assertUiReadback(p,after,now=Date.now(),notBefore){
 assertUiPlan(p,now);observations(p,after,now,notBefore);const b=p.before,invoice=after.invoice.record,estimate=after.estimate.record;
 assertMetadata(b.invoice.record,invoice);assertMetadata(b.estimate.record,estimate);
 if(BigInt(invoice.SyncToken)<=BigInt(b.invoice.record.SyncToken)||!equal(headerLinks(invoice.LinkedTxn),[{TxnId:estimate.Id,TxnType:'Estimate'},{TxnId:p.before.time.record.Id,TxnType:'TimeActivity'}])||!equal(headerLinks(estimate.LinkedTxn),[{TxnId:invoice.Id,TxnType:'Invoice'}])||estimate.TxnStatus!=='Closed')fail('Actual reciprocal Estimate/Invoice links and provider closure are required.');
 const original=financial(b.invoice.record),current=financial(invoice),source=financial(b.estimate.record);
 if(current.length!==1||!QID.test(current[0].Id||''))fail('The browser correction left duplicate or invalid financial lines.');
 const old=metadata(b.invoice.record),next=metadata(invoice);delete old.LinkedTxn;delete next.LinkedTxn;
 for(const line of old.Line)if(line.DetailType==='SalesItemLineDetail')delete line.Id;
 for(const line of next.Line)if(line.DetailType==='SalesItemLineDetail'){
  delete line.Id;if(line.LinkedTxn!==undefined){if(!equal(line.LinkedTxn,[{TxnId:estimate.Id,TxnType:'Estimate',TxnLineId:source[0].Id}]))fail('The UI returned an unapproved line origin.');delete line.LinkedTxn;}
 }
 const oldEstimate=metadata(b.estimate.record),nextEstimate=metadata(estimate);delete oldEstimate.LinkedTxn;delete nextEstimate.LinkedTxn;delete oldEstimate.TxnStatus;delete nextEstimate.TxnStatus;
 if(!equal(old,next)||!equal(oldEstimate,nextEstimate)||!equal(b.time.record,after.time.record)||!equal(b.customer.record,after.customer.record))fail('The UI changed fields outside its exact line-ID/link/causal metadata exception.');
 return{version:1,kind:'owned-ui-link-record-invariants',scope:p.scope,logicalKey:p.logicalKey,beforeHash:hash(b),afterHash:hash(after),unchangedAccounting:true,actualHeaderLinks:true,actualEstimateBacklink:true,originalInvoiceLineId:original[0].Id,finalInvoiceLineId:current[0].Id,estimateSourceLineId:source[0].Id,physicalInvoiceLineLinkReturned:current[0].LinkedTxn!==undefined,actorProvenance:PROVENANCE};
}
function assertUiUnchanged(p,after,now=Date.now(),notBefore){
 assertUiPlan(p,now);observations(p,after,now,notBefore);
 if(!['invoice','estimate','time','customer'].every(key=>equal(p.before[key].record,after[key].record)))fail('The browser action cannot be classified unchanged from its exact native records.');
 return{version:1,kind:'owned-ui-link-records-unchanged',scope:p.scope,logicalKey:p.logicalKey,beforeHash:hash(p.before),afterHash:hash(after),linkVerified:false,originalOperationBlocked:true,actorProvenance:PROVENANCE};
}
module.exports={PLAN,ATTEMPT,OBSERVATION,OUTCOME,PROVENANCE,PROCEDURE,fail,equal,assertUiPlan,uiPeriodGuardRequest,assertUiReadback,assertUiUnchanged};
