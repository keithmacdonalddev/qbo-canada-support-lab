'use strict';
// Historical notes are hypotheses, never write admission. The live validators still decide.
async function checkBeliefs({models,scope,ownerId,business,sync,now=()=>Date.now()}) {
  const blockers=[...(business?.blockers||[]),...(business?.errorBlockers||[])];
  const out={ownerId:String(ownerId),checkedAt:new Date(now()).toISOString(),blockersKnown:!business?.unavailable&&!business?.diagnosticsUnavailable,blockers:blockers.map(b=>({code:b.code,operationId:b.operationId,title:b.title})),roles:[],instruction:'Historical blocked claims expire at every review. Re-read current choices and attempt one real governed preparation for eligible independent work. A cleared diagnostic is not permission to replay saved writes. An unavailable check is unknown, not a blocker for unrelated work.'};
  if(!models?.Records)return {...out,roleCheck:'unavailable'};
  try {
    const roles=require('./business-added-roles'), registry=await roles.listAddedRoles(models,scope,ownerId);
    for(const role of registry.roles){
      const source=sync?.sources?.find(s=>s.entity===role.entity);
      if(sync?.status!=='current'||source?.status!=='current'){out.roles.push({key:role.key,id:role.id,entity:role.entity,status:'unknown',reason:'Current synchronized observation unavailable'});continue;}
      try {
        await roles.resolveBatchRoles({scope,registry,batch:{activities:[{[role.kind==='customer'?'customerKey':role.kind==='supplier'?'vendorKey':'itemKey']:role.key,...(role.kind==='item'?{incomeRole:role.incomeRole,unit:role.unit}:{})}]},readRecord:async(entity,qboId)=>(await models.Records.findOne({...scope,entity,qboId,deleted:false}).select('record').maxTimeMS(3000).lean())?.record,now});
        out.roles.push({key:role.key,id:role.id,entity:role.entity,status:'passed',check:'authenticated-creation-definition'});
      }catch(error){out.roles.push({key:role.key,id:role.id,entity:role.entity,status:'failed',code:error.code||'CHECK_UNAVAILABLE'});}
    }
    out.roleCheck='checked';out.unusable=(registry.unusable||[]).map(r=>({key:r.key,reason:r.reason}));
  }catch{out.roleCheck='unavailable';}
  return out;
}
function memoryForReview(memory,checks){
  return 'Retained history only; any blocked claim below expires for this review. Current checks and governed tool results take precedence. '+(checks?.blockersKnown&&!checks.blockers.length?'Current saved diagnostics report no blockers. Test eligible work instead of carrying forward a sales hold. ':'Recheck the exact dependent action; continue independent work. ')+'\n'+String(memory||'');
}
module.exports={checkBeliefs,memoryForReview};
