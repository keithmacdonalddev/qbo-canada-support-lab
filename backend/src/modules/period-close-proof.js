'use strict';
const { hash }=require('./business-calendar');
const { assertPeriodControl }=require('./qbo-write-period');
const C=require('./period-close-contract');
const { validateObservation,eligible }=require('./period-close-reader');
const maximum=(...values)=>values.filter(Boolean).sort().at(-1)||null;
function validatePeriodDecision(row,scope,ownerId){
  const p=C.validateDecisionEnvelope(row,scope,ownerId);
  if(p.status==='cancelled')return p;
  const request=p.input.request,r=p.review,source=validateObservation(p.observations,scope),before=r.state?.periodControl;
  if(!C.same(r.scope,scope) || r.ownerId!==ownerId || r.mode!==request.mode || r.requestHash!==hash(request) || !C.same(r.qbo,{preferencesHash:source.preferences.contentHash,closedThrough:source.preferences.closedThrough,accountInventoryHash:source.accountInventoryHash}) || r.readyToApply!==true || !Array.isArray(r.blockers) || r.blockers.length || Date.parse(source.observedAt)>Date.parse(p.recordedAt) || Date.parse(p.recordedAt)-Date.parse(source.startedAt)>180000)C.fail('Retained period sources differ from the original accepted review.');
  assertPeriodControl(before,scope,ownerId);assertPeriodControl(p.resultingControl,scope,ownerId);
  const after={closedThrough:before.closedThrough,reconciledThrough:before.reconciledThrough};
  if(request.mode==='reopen'){
    if(request.previousControlHash!==before.contentHash || source.accounts!==null)C.fail('The original reopening control or preference-only scope changed.');
    for(const key of ['closedThrough','reconciledThrough'])after[key]=request[key];
  }else{
    if(source.accountInventoryHash!==request.accountInventoryHash || !C.same(C.bankResults(request,eligible(source.accounts)),r.bankResults) || !Array.isArray(r.reportChecks) || !C.same(r.reportChecks.map(value=>({key:value.key,id:value.id,evidenceHash:value.evidenceHash})),request.reportChecks))C.fail('The retained manual account or report selection differs from its original review.');
    if(request.mode==='close'){after.closedThrough=request.period.throughDate;if(request.advanceReconciled)after.reconciledThrough=request.period.throughDate;}
  }
  const expectedBefore={closedThrough:before.closedThrough,reconciledThrough:before.reconciledThrough,effectiveThrough:maximum(before.closedThrough,before.reconciledThrough,source.preferences.closedThrough)};
  const expectedAfter={...after,effectiveThrough:maximum(after.closedThrough,after.reconciledThrough,source.preferences.closedThrough)};
  if(!C.same(r.dateEffect?.before,expectedBefore) || !C.same(r.dateEffect?.after,expectedAfter))C.fail('The retained accounting-date effect differs from the reviewed sources.');
  if(request.mode==='record'){
    if(!C.same(p.resultingControl,before))C.fail('A record-only decision cannot change app protection.');
  }else{
    const control={version:1,status:'owner-recorded',scope,ownerId,...after,evidenceNote:request.reason.trim(),recordedAt:p.recordedAt};
    if(!C.same(p.resultingControl,{...control,contentHash:hash(control)}))C.fail('The resulting app protection differs from the exact owner decision.');
  }
  return p;
}
module.exports={validatePeriodDecision};
