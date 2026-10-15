'use strict';
function legacyOwnershipQueries(scope,entity,id) {
  const company={realmId:scope.realmId}, types=[entity,entity.toLowerCase()];
  const environment={$or:[{environment:scope.environment},{environment:{$exists:false}},{environment:null}]};
  const tools={Invoice:'createInvoice',Payment:'applyPayment',Bill:'createBill',BillPayment:'applyBillPayment'};
  return [
    {collection:'masterpreparationruns',filter:{...company,...environment,records:{$elemMatch:{entity,qboId:id}}}},
    {collection:'aiplans',filter:{...company,steps:{$elemMatch:{'result.data.id':id,$and:[{$or:[{toolName:'createRecord','toolInput.entityType':entity},...(tools[entity]?[{toolName:tools[entity]}]:[])]},{$or:[{executionScope:{$exists:false}},{executionScope:null},{'executionScope.environment':{$exists:false}},{'executionScope.environment':null},{$and:[{'executionScope.environment':scope.environment},{$or:[{'executionScope.realmId':scope.realmId},{'executionScope.realmId':{$exists:false}},{'executionScope.realmId':null}]}]}]}]}}}},
    {collection:'generationruns',filter:{...company,$and:[environment,{$or:[{steps:{$elemMatch:{'transaction.entity':entity,'receipt.Id':id}}},{createdTransactions:{$elemMatch:{entity:{$in:types},qboId:id}}}]}]}},
    ...['seedruns','issuepackruns'].map(collection=>({collection,filter:{...company,...environment,createdEntities:{$elemMatch:{entity:{$in:types},qboId:id}}}})),
  ];
}
async function assertNoLegacyOwnership(db,scope,entity,id,session) {
  if (!db || typeof db.collection!=='function') throw Object.assign(new Error('Legacy ownership evidence is unavailable; no record was attributed.'),{status:409,code:'BUSINESS_OWNER_ATTRIBUTION_UNVERIFIED'});
  for (const {collection,filter} of legacyOwnershipQueries(scope,entity,id)) {
    // No owner/connection restriction: reconnecting never transfers another
    // workflow's record. Unknown historical environments conservatively block.
    const rows=await db.collection(collection).find(filter,{projection:{_id:1},maxTimeMS:3000,...(session?{session}:{})}).limit(1).toArray();
    if (!Array.isArray(rows) || rows.length) throw Object.assign(new Error('This record has another or incomplete legacy creation history. It cannot be attributed to this business request.'),{status:409,code:'BUSINESS_OWNER_ATTRIBUTION_UNVERIFIED'});
  }
}
module.exports={legacyOwnershipQueries,assertNoLegacyOwnership};
