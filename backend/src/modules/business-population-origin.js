'use strict';
const {hash}=require('./business-calendar');
const {freezeWriteRequest,denied}=require('./qbo-write-contract');
function populationOriginEvidence(row,scope,entity,id){
  const workflow=row?.workflow,artifact=row?.population;
  if(row?.kind!=='business-population'||!['saved','unknown'].includes(row.state)||row.operation!=='create'||row.entity!=='batch'||row.observed?.outcome!==row.state||workflow?.kind!=='business-population'||artifact?.version!==1||artifact.jobId!==workflow.jobId||artifact.batchHash!==workflow.batchHash||row.dispatchKey!==hash({version:1,populationJobId:workflow.jobId,batchHash:workflow.batchHash})||row._id!==hash({scope,dispatchKey:row.dispatchKey}))throw denied('The native bulk creation origin changed.');
  const request=freezeWriteRequest(scope,artifact.request.method,artifact.request.endpoint,JSON.parse(artifact.request.body));if(request.requestHash!==row.requestHash||artifact.request.requestHash!==row.requestHash)throw denied('Bulk origin request bytes changed.');
  const matches=row.observed.items?.filter(item=>item.entity===entity.toLowerCase()&&item.qboId===id&&item.outcome==='saved');if(matches?.length!==1)throw denied('Bulk origin identity is ambiguous.');const item=matches[0],entries=artifact.entries?.filter(entry=>entry.bId===item.bId&&entry.logicalKey===item.logicalKey),payload=JSON.parse(request.body).BatchItemRequest?.filter(value=>value.bId===item.bId);
  if(entries?.length!==1||payload?.length!==1||payload[0].operation!=='create'||Object.keys(payload[0]).sort().join(',')!==[entity,'bId','operation'].sort().join(',')||item.operation!=='create'||item.httpStatus<200||item.httpStatus>=300)throw denied('Bulk origin item mapping changed.');const entry=entries[0],inner=freezeWriteRequest(scope,'POST',entity.toLowerCase(),payload[0][entity]);
  if(entry.entity!==entity||entry.requestHash!==inner.requestHash||item.requestHash!==inner.requestHash||entry.compilationHash!==item.compilationHash||entry.fingerprint!==item.fingerprint||entry.intentHash!==item.intentHash)throw denied('Bulk origin is not the exact accepted request.');
  require('./business-population-receipt').assertPopulationAudits(scope,row,row.audits);
  return {jobId:workflow.jobId};
}
module.exports={populationOriginEvidence};
