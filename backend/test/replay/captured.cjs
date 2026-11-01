'use strict';
const {createRuntime,safeError}=require('./runtime.cjs');
const ALLOWED=new Set(['qbo-write-gate','business-period-store','business-period-evidence','general-write-service','general-write-transport','business-graph-readback','general-write-day-close','general-write-guards','general-write-recovery','business-transaction-compiler']);
async function replayEvidence({root,data,run,evidence,features,transform}) {
 const stages=[];
 for(const row of evidence) {
  const rt=createRuntime({root,data,run,at:+new Date(row.capturedAt),features,transform});
  try {
   const recorder=rt.current('business-replay-evidence');
   const result=await recorder.replayCaptured(row,name=>{if(!ALLOWED.has(name))throw Object.assign(Error(),{code:'REPLAY_CAPTURE_BOUNDARY_INVALID'});return rt.current(name);});
   stages.push({stage:row.boundary,evidenceId:row.evidenceId,status:'passed',baseline:result.refused?'refused':'accepted',resultHash:row.bodyHash});
  }catch(error){stages.push({stage:row.boundary,evidenceId:row.evidenceId,status:'failed',errorDetail:safeError(error,row.boundary)});}
 }
 const required=run.contract==='general-write-v1'?['general-write-service:guardBatch','general-write-guards:checkGeneralWrite','qbo-write-gate:begin','general-write-transport:admit','general-write-transport:classify','general-write-recovery:itemOutcomes','general-write-day-close:closeGeneralDay']:['business-transaction-compiler:compileBusinessTransactionWithDefinitions','qbo-write-gate:begin','qbo-write-gate:complete','business-graph-readback:$call','business-period-store:finish','business-period-evidence:prepareEvidence'];
 const absent=required.filter(boundary=>!stages.some(s=>s.stage===boundary));
 const missingEvidence=absent.map(boundary=>({stage:boundary,code:'REPLAY_BOUNDARY_EVIDENCE_MISSING'}));
 // Automatic fixed recovery has no retained coverage-search transcript yet.
 if(run.status==='unknown'||run.errorDetail?.code==='BUSINESS_UNKNOWN_REVIEW_REQUIRED')missingEvidence.push({stage:'automatic-recovery',code:'REPLAY_AUTOMATIC_RECOVERY_EVIDENCE_MISSING'});
 const errors=stages.filter(s=>s.status==='failed').map(s=>s.errorDetail);
 return {id:String(run._id),kind:run.contract==='general-write-v1'?'general':'fixed',evidence:'captured',coverage:'captured-decisions-only',missingEvidence,outcome:errors.some(e=>e.code==='REPLAY_CAPTURE_NEWLY_REFUSED')?'newly refused':errors.some(e=>e.code==='REPLAY_CAPTURE_NEWLY_ACCEPTED')?'newly accepted':errors.length?'errored':'same outcome',stages,errorDetail:errors};
}
module.exports={replayEvidence};
