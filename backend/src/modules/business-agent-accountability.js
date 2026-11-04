'use strict';
const {hash}=require('./business-calendar');
const WRITE_TOOLS=new Set(['configureBankOriginPolicy','processBankOriginDue','addBankOriginAdvice','bookBankOriginEvent','repairEstimateConversion','manageQboRecord','prepareBusinessActivity','prepareBusinessPeriod','executeBusinessPeriod','resumeBusinessOperation','recordCloseChecklistEvidence']);
function decisionData({name,input,plan,day,passId,operation}){
 const meta=input.decision||{},purpose=input.purpose||input.reason||input.note||'Close the elapsed business period under published policy';
 return {version:1,day,tool:name,goal:meta.goal||'Maintain a coherent, active business with deliberate feature coverage',reason:purpose.slice(0,2000),planItem:meta.planItem||'Independent governed work outside the saved daily changes',planId:plan?.id||null,decisionKey:input.decisionKey||operation?.activityBatch?.decisionKey||operation?.decisionKey||(input.throughDate?'period:'+input.throughDate:passId),operationId:input.operationId||null,passId};
}
async function retainOutcome({store,row,scope,decision,result}){
 if(['configureBankOriginPolicy','processBankOriginDue','addBankOriginAdvice'].includes(decision.tool)){const value=result?.data||{},data={decisionId:decision.id,decisionKey:decision.decisionKey,status:'bank-only',qboCalls:0,...(Number.isSafeInteger(value.posted)?{posted:value.posted}:{}),...(Number.isSafeInteger(value.revision)?{policyRevision:value.revision}:{})};await store.event(row,'accountant-write-outcome-complete','Independent bank action retained',decision.reason||'',data,null,'write-outcome:'+hash(data));return;}
 let d=decision;
 if(d.tool==='bookBankOriginEvent'){const value=result?.data||{},runId=String(value.runId||'');if(!/^[a-f0-9]{24}$/.test(runId)){const data={decisionId:d.id,decisionKey:d.decisionKey,status:value.status==='booked'?'bank-booked':'bank-held',records:[],reason:value.reason||'Bank-origin bookkeeping has no retained General run yet.'};await store.event(row,'accountant-write-outcome-complete','Bank-origin obligation retained',d.reason||'',data,null,'write-outcome:'+hash(data));return;}d={...d,operationId:runId};}

 let fixed=[],general=[];
 if(d.operationId){fixed=await store.models.Runs.find({...scope,_id:d.operationId,'agentAuthority.agentId':String(row._id)}).select('_id status activityBatch.decisionKey').limit(1).maxTimeMS(3000).lean();}
 else if(d.decisionKey){fixed=await store.models.Runs.find({...scope,'activityBatch.decisionKey':d.decisionKey,'agentAuthority.agentId':String(row._id)}).select('_id status').limit(20).maxTimeMS(3000).lean();}
 if(store.models.GeneralWriteRuns)general=await store.models.GeneralWriteRuns.find({...scope,ownerId:String(row.ownerId),'agentAuthority.agentId':String(row._id),...(d.operationId?{_id:d.operationId}:{decisionKey:d.decisionKey})}).select('_id status items').limit(20).maxTimeMS(3000).lean();
 if(!fixed.length&&!general.length){const data={decisionId:d.id,decisionKey:d.decisionKey,status:'no-retained-operation',records:[]};await store.event(row,'accountant-write-outcome-complete','No retained operation for this attempt',d.reason||'',data,null,'write-outcome:'+hash(data));}
 for(const run of [...fixed,...general]){
  const ids=run.items?Object.values(run.items).filter(i=>i.qboId).map(i=>({entity:i.entity,id:String(i.qboId),outcome:i.outcome})): (await savedSteps(store.models.Steps,scope,String(run._id))).map(i=>({entity:i.entity,id:String(i.qboId),outcome:i.state}));
  // Chunk results to stay inside the append-only event size limit. Never keep raw QBO payloads.
  for(let offset=0;offset<Math.max(1,ids.length);offset+=100){const data={decisionId:d.id,decisionKey:d.decisionKey,operationId:String(run._id),status:run.status,checkedAt:new Date().toISOString().slice(0,16),offset,records:ids.slice(offset,offset+100)};await store.event(row,'accountant-write-outcome','Accountant write outcome',d.reason||'',data,null,'write-outcome:'+hash(data));}
 }
 if(fixed.length||general.length){const runs=[...fixed,...general],terminal=runs.every(r=>['verified','retired','complete','needs-correction'].includes(r.status))&&fixed.length<20&&general.length<20;
 const done={decisionId:d.id,decisionKey:d.decisionKey,status:terminal?'complete':'pending',checkedAt:new Date().toISOString().slice(0,16)};await store.event(row,'accountant-write-outcome-complete','Accountant outcome observation complete',d.reason||'',done,null,'write-outcome-complete:'+hash(done));}
}
async function savedSteps(Steps,scope,operationId){
 const rows=[];let after=null;
 for(let page=0;page<100;page++){const part=await Steps.find({...scope,operationId,qboId:{$ne:null},...(after?{_id:{$gt:after}}:{})}).select('_id entity qboId state').sort({_id:1}).limit(500).maxTimeMS(3000).lean();rows.push(...part);if(part.length<500)return rows;if(String(part.at(-1)._id)===String(after))throw new Error('Saved-record enumeration made no progress.');after=part.at(-1)._id;}
 throw new Error('Saved-record evidence needs another bounded enumeration.');
}
function scorecard({day,today,snapshot,prior,blockers,business,decisions=[]}){
 const situations=snapshot?.situations?.rows||[],covered=situations.filter(r=>r.evidence?.complete&&r.presentAtAll).map(r=>r.key),old=prior?.coveredKeys;
 const rows=snapshot?.weekly?.rows||[];
 return {day,asOf:snapshot?.asOf||null,records:today&&!today.unavailable?{saved:today.saved,verified:today.verified,target:today.target}:null,
  situations:{covered:covered.length,newlyCovered:Array.isArray(old)?covered.filter(k=>!old.includes(k)).length:null,baselineAvailable:Array.isArray(old),coveredKeys:covered,weeklyGaps:rows.filter(r=>r.status==='missing').length,unknown:rows.filter(r=>r.status==='unknown').length},
  collections:snapshot?.collections||null,closes:{verifiedThrough:business?.verifiedThrough||null,manualReconciliation:'Not established by calendar close'},blockers:blockers?.unavailable?null:(blockers?.blockers||[]).length,decisions:decisions.length,
  limits:'Records are saved outcomes, not a test count. New coverage compares with the previous saved daily baseline; unknown source data is never counted as a gap or proof. Collections are dated payments, not a claim that every overdue invoice was collected.'};
}
module.exports={WRITE_TOOLS,decisionData,retainOutcome,scorecard};
