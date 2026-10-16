'use strict';
const { publicAuditEvent: reportProjection }=require('./report-evidence-contract');
const { isPeriodEvent }=require('./period-close-contract');
function publicAuditEvent(row){
  if(!isPeriodEvent(row))return reportProjection(row);
  const value=typeof row.toObject==='function'?row.toObject():row;
  return Object.fromEntries([...['_id','userId','actorUserId','realmId','action','actionType','outcome','aiDriven','createdAt'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]),['periodEvidence',{details:'/company/period-close',message:'Open reconciliation and close to inspect this decision in its company scope.'}]]);
}
module.exports={publicAuditEvent};
