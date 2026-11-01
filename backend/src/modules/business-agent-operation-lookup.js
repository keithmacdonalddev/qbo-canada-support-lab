'use strict';
const {operationAllowed}=require('./business-agent-tools');
async function findOperations({models,scope,row,decisionKey}){
 if(typeof decisionKey!=='string'||decisionKey.length<1||decisionKey.length>120)throw new Error('Choose a bounded exact decision key.');
 const bound={...scope,createdBy:row.ownerId,'agentAuthority.agentId':String(row._id),'agentAuthority.ownerId':String(row.ownerId),'agentAuthority.version':1};
 // Earlier grants remain readable; only current-grant operations may execute through existing tools.
 const fixed=await models.Runs.find({...bound,'activityBatch.decisionKey':decisionKey}).sort({_id:1}).limit(21).maxTimeMS(3000).lean();
 const general=models.GeneralWriteRuns?await models.GeneralWriteRuns.find({...scope,ownerId:String(row.ownerId),'agentAuthority.agentId':String(row._id),'agentAuthority.ownerId':String(row.ownerId),contract:'general-write-v1',decisionKey}).sort({_id:1}).limit(21).maxTimeMS(3000).lean():[];
 const steps=fixed.length&&models.Steps?await models.Steps.find({...scope,operationId:{$in:fixed.map(r=>r._id)}}).select('operationId entity qboId state').limit(1001).maxTimeMS(3000).lean():[];
 const rows=[...fixed.map(r=>({...r,contract:'fixed'})),...general];
 return {decisionKey,bounded:fixed.length>=21||general.length>=21||steps.length>=1001,operations:rows.slice(0,40).map(run=>({operationId:String(run._id),contract:run.contract,status:run.status,createdAt:run.createdAt,day:run.day||run.activityBatch?.day,planHash:run.planHash||null,contentHash:run.contentHash||null,currentGrant:operationAllowed(run,row),choices:run.activityBatch||run.plan?.operations||null,effects:run.contract==='fixed'?steps.filter(s=>String(s.operationId)===String(run._id)).map(s=>({entity:s.entity,id:s.qboId||null,outcome:s.state})):Object.entries(run.items||{}).map(([ref,item])=>({ref,entity:item.entity,id:item.qboId||null,outcome:item.outcome}))}))};
}
module.exports={findOperations};
