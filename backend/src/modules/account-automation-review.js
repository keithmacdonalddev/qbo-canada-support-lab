'use strict';
const {createHash}=require('node:crypto');
const {assertAccountEligible,isReservedAccount,accountVersion}=require('./account-policy');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
function defaultSources(){
  const model=name=>require('../models/'+name);
  return [
    {key:'cases',label:'Reproduction cases',Model:model('AISession'),filter:id=>({mode:'reproduce',$or:[{userId:id},{'reproduction.actorId':id}]}),fields:'_id realmId status reproduction.status reproduction.runId reproduction.actorId reproduction.environment reproduction.connectionId reproduction.outcomeUnknown reproduction.stopRequested updatedAt'},
    {key:'business',label:'Business operations',Model:model('OperationRun'),filter:id=>({$or:[{createdBy:id},{'approval.actorId':id},{'executionRequest.ownerId':id},{'executionRequest.actorId':id}]}),fields:'_id realmId environment connectionId status planHash createdBy executionRequest approval.actorId executionRevision updatedAt'},
    {key:'plans',label:'Legacy AI plans',Model:model('AIPlan'),filter:id=>({$or:[{userId:id},{approvedBy:id}]}),fields:'_id realmId status approvedBy approvedAt steps.stepNumber steps.status steps.executionScope steps.writeDispatch.receiptId steps.result.outcomeUnknown updatedAt'},
    {key:'generation',label:'Legacy generation runs',Model:model('GenerationRun'),filter:id=>({userId:id}),fields:'_id realmId environment connectionId status leaseExpiresAt progress completedAt createdAt'},
    {key:'seed',label:'Legacy seed runs',Model:model('SeedRun'),filter:id=>({userId:id}),fields:'_id realmId status progress completedAt createdAt'},
    {key:'issuepacks',label:'Legacy issue-pack runs',Model:model('IssuePackRun'),filter:id=>({userId:id}),fields:'_id realmId status completedAt createdAt'},
  ];
}
function createAccountAutomationReview({Users,Audits,transaction,sources=defaultSources()}){
  const readAccount=(id,session)=>Users.findById(id).select('_id email role authVersion accessPolicyVersion automationAccessPolicyVersion automationReviewHash connectionSwitchVersion').session(session).maxTimeMS(3000).lean();
  function eligible(account,id){if(!account||String(account._id)!==String(id))fail('Current account is unavailable.',403);assertAccountEligible(account);}
  async function snapshot(id,session){
    const account=await readAccount(id,session);eligible(account,id);
    if(!isReservedAccount(account)||account.automationAccessPolicyVersion===1)return {required:false,enabled:true,groups:[]};
    const retained=[],groups=[];
    for(const source of sources){
      const sourceHash=createHash('sha256'),entries=[],history={};let cursor=null,total=0;
      for(;;){
        const filter=cursor?{$and:[source.filter(id),{_id:{$gt:cursor}}]}:source.filter(id);
        const rows=await source.Model.find(filter).select(source.fields).sort({_id:1}).limit(250).session(session).maxTimeMS(3000).lean();
        for(const row of rows){
          sourceHash.update(JSON.stringify(row)+'\n');total++;
          const status=row.reproduction?.status||row.status||'unknown';history[status]=(history[status]||0)+1;
          const pending=row.executionRequest?.pending===true||['pending','in_progress','running','executing','reserved'].includes(status);
          const uncertain=row.reproduction?.outcomeUnknown===true||row.steps?.some(step=>step.result?.outcomeUnknown||step.status==='executing')||false;
          const authorized=pending||uncertain||(source.key==='business'&&['approved','blocked','awaiting-evidence','committing'].includes(status))||(source.key==='plans'&&['approved','partially_approved'].includes(status));
          if(authorized)entries.push({id:String(row._id),realmId:row.realmId,environment:row.environment||row.reproduction?.environment||'not retained',status,pending,uncertain,planHash:row.planHash||null});
        }
        if(rows.length<250)break;
        const next=rows.at(-1)._id;if(String(next)===String(cursor))fail('Retained history pagination did not advance. Automation remains paused.');cursor=next;
      }
      retained.push({key:source.key,total,contentHash:sourceHash.digest('hex')});
      groups.push({key:source.key,label:source.label,total,history,entries});
    }
    const basis={version:1,id:String(id),authVersion:accountVersion(account),role:account.role,connectionSwitchVersion:account.connectionSwitchVersion??0,retained};
    return {required:true,enabled:false,reviewHash:digest(basis),groups,notice:'The history counts include completed entries; the list shows pending, authorized or uncertain work. Enabling automation permits already authorized work to continue if its existing company, calendar and safety checks pass. It does not approve new plans or clear uncertain writes. Stop any work you no longer want on its own page before enabling.'};
  }
  async function enable(id,body){
    if(body?.acknowledgeRetainedWork!==true||!/^[a-f0-9]{64}$/.test(body?.reviewHash||''))fail('Review retained work and explicitly acknowledge that existing authorizations may continue.',400);
    return transaction(async session=>{
      const previous=await readAccount(id,session);eligible(previous,id);
      if(isReservedAccount(previous)&&previous.automationAccessPolicyVersion===1&&previous.automationReviewHash===body.reviewHash)return {required:false,enabled:true,reused:true,groups:[]};
      const current=await snapshot(id,session);
      if(!current.required||current.reviewHash!==body.reviewHash)fail('Retained work or account access changed. Review the current list again.');
      const account=await readAccount(id,session);
      const changed=await Users.updateOne({_id:id,email:account.email,role:account.role,authVersion:account.authVersion,accessPolicyVersion:1,automationAccessPolicyVersion:account.automationAccessPolicyVersion===undefined?{$exists:false}:account.automationAccessPolicyVersion},{$set:{automationAccessPolicyVersion:1,automationReviewHash:body.reviewHash},$inc:{connectionSwitchVersion:1}},{session});
      if(changed.matchedCount!==1)fail('Current account access changed.');
      await Audits.create([{userId:id,realmId:'account:'+String(id),action:'Retained automation explicitly enabled after account recovery',actionType:'auth',outcome:'success',inputParams:{reviewHash:current.reviewHash,acknowledgeRetainedWork:true},afterState:{authVersion:accountVersion(account),automationAccessPolicyVersion:1,groups:current.groups.map(group=>({key:group.key,total:group.total}))}}],{session});
      return {required:false,enabled:true,groups:current.groups};
    });
  }
  return {review:snapshot,enable};
}
let service;
function accountAutomationReview(){if(!service){const mongoose=require('mongoose');service=createAccountAutomationReview({Users:require('../models/User'),Audits:require('../models/AuditLog'),transaction:require('./business-transaction').createBusinessTransaction(mongoose.connection)});}return service;}
module.exports={createAccountAutomationReview,accountAutomationReview,defaultSources};
