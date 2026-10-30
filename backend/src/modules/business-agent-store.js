'use strict';
const { hash } = require('./business-calendar');
const { fail, DEFAULT_SETTINGS, businessBlockers } = require('./business-agent-policy');
const { createBusinessTransaction } = require('./business-transaction');
const { randomUUID } = require('node:crypto');
function loadModels() { return {
  Agents:require('../models/BusinessAgent'), Events:require('../models/BusinessAgentEvent'), Records:require('../models/CompanySyncRecord'),
  Users:require('../models/User'), Connections:require('../models/Connection'), Memberships:require('../models/CompanyMembership'), Audits:require('../models/AuditLog'),
  Calendars:require('../models/BusinessCalendar'), Writers:require('../models/CompanyWriter'), Policies:require('../models/CompanyWritePolicy'),
  Runs:require('../models/OperationRun'), Jobs:require('../models/BusinessPopulationJob'), Authorities:require('../models/BusinessAuthority'), Baselines:require('../models/BusinessBaseline'),
}; }
const scopeOf=row=>({environment:row.environment,realmId:row.realmId,connectionId:String(row.connectionId)});
const publicEvent=row=>({id:String(row._id),kind:row.kind,role:row.role,title:row.title,detail:row.detail,at:new Date(row.at).toISOString(),...(row.data||{})});
function createBusinessAgentStore({models=loadModels(),connection=require('mongoose').connection,transaction=createBusinessTransaction(connection),now=()=>Date.now()}={}) {
  const {Agents,Events}=models;const completedCounts=new Map();
  const get=(scope,session)=>Agents.findOne(scope).session(session).maxTimeMS(3000).lean();
  async function setup(){ for(const Model of [Agents,Events,models.Records]){await Model.createCollection();await Model.createIndexes();} }
  async function event(row,kind,title,detail='',data={},session,key=randomUUID(),role='accountant') {
    if(typeof title!=='string'||!title||title.length>160||typeof detail!=='string'||detail.length>6000||Buffer.byteLength(JSON.stringify(data))>16000)fail('Agent activity exceeds its retained evidence size.');
    const id=hash({agentId:String(row._id),kind,key}).slice(0,24),existing=await Events.findOne({_id:id,agentId:String(row._id)}).session(session).maxTimeMS(3000).lean();
    if(existing)return publicEvent(existing);
    const value={_id:id,agentId:String(row._id),...scopeOf(row),ownerId:row.ownerId,role,kind,title,detail,data,at:new Date(now())};
    await Events.create([value],{session}); return publicEvent(value);
  }
  async function fenceAccess(bound,session){
    await bound.access.authorize(bound.scope,bound.action||'operations.execute',{session});
    for(const id of new Set([bound.ownerId,bound.actorId])) if((await models.Users.updateOne({_id:id,role:{$in:['agent','supervisor']}},{$inc:{connectionSwitchVersion:1}},{session})).matchedCount!==1)fail('Current account changed.');
    if((await models.Connections.updateOne({_id:bound.scope.connectionId,userId:bound.ownerId,realmId:bound.scope.realmId,status:'active'},{$inc:{businessSetupVersion:1}},{session})).matchedCount!==1)fail('The company selection changed.');
    if((await models.Memberships.updateOne({userId:bound.actorId,realmId:bound.scope.realmId,status:'active'},{$inc:{businessSetupVersion:1}},{session})).matchedCount!==1)fail('Active company membership is required.');
  }
  async function control(bound,input,reduce){
    const id=hash(bound.scope).slice(0,24),requestHash=hash(input),eventId=hash({agentId:id,kind:'control',key:input.requestKey}).slice(0,24);
    return transaction(async session=>{
      await fenceAccess(bound,session);
      const prior=await Events.findOne({_id:eventId,agentId:id}).session(session).maxTimeMS(3000).lean();
      if(prior){if(prior.data.requestHash!==requestHash)fail('This request identifier already belongs to another decision.');return get(bound.scope,session);}
      let row=await get(bound.scope,session);
      if(!row&&input.command!=='enable-monitoring')fail('Enable company monitoring first.');
      if((row?.revision||0)!==input.expectedRevision)fail('Another decision changed the business controls. Refresh before trying again.');
      if(row&&String(row.ownerId)!==bound.ownerId)fail('The saved workspace owner changed.');
      if(!row)row={_id:id,version:1,...bound.scope,ownerId:bound.ownerId,revision:0,settings:{...DEFAULT_SETTINGS,specialists:[]},grant:null};
      if(input.command==='respond-decision'){
        const decision=await Events.findOne({_id:input.decisionId,agentId:id,kind:'decision'}).session(session).maxTimeMS(3000).lean();
        if(!decision)fail('The selected owner decision is unavailable.');
        if(await Events.findOne({agentId:id,kind:'decision-response','data.decisionId':input.decisionId}).session(session).maxTimeMS(3000).lean())fail('This decision already has an owner response.');
      }
      const changes={...(await reduce(row,session)),leaseToken:null,leaseExpiresAt:null,currentWork:''};
      let saved;
      if(row.createdAt)saved=await Agents.findOneAndUpdate({_id:id,...bound.scope,revision:input.expectedRevision},{$set:changes,$inc:{revision:1}},{new:true,session}).lean();
      else { const docs=await Agents.create([{...row,...changes,revision:1}],{session}); saved=docs[0].toObject?docs[0].toObject():docs[0]; }
      if(!saved)fail('The agent control changed while saving.');
      const controlDescriptions={ 'enable-monitoring':'Continuous read-only company monitoring is enabled.', 'enable-autonomy':'The owner granted ongoing business-management authority.', pause:'The accountant is paused. Company monitoring continues.', 'stop-monitoring':'Company monitoring and autonomous work are stopped.', resume:'The accountant can continue under its retained authority.', 'sync-now':'A fresh company read was requested.', 'run-now':'A business review was requested.', 'configure-specialists':'Specialist responsibilities were updated.', configure:'Monitoring and review frequency were updated.', 'configure-usage':'Monthly AI usage limits were updated.', 'retry-plan-limit':'The owner requested another check of the ChatGPT plan limit.', 'respond-decision':'The owner response is saved for the next review.' };
    const data={command:input.command,requestHash,revision:saved.revision,...(input.command==='enable-autonomy'?{grant:saved.grant,approvalSource:'standing-owner-grant'}:{})};
      await event(saved,'control',input.command==='enable-autonomy'?'Owner enabled autonomous business management':'Owner changed business controls',input.command==='save-instructions'?'Owner instructions updated. They apply to the next business decision.':controlDescriptions[input.command],data,session,input.requestKey,'owner');
      if(input.command==='respond-decision')await event(saved,'decision-response','Owner '+(input.choice==='accept'?'accepted':'declined')+' a decision',input.note,{decisionId:input.decisionId,choice:input.choice},session,input.requestKey,'owner');
      await models.Audits.create([{_id:eventId,userId:bound.ownerId,realmId:bound.scope.realmId,action:input.command==='enable-autonomy'?'Business agent standing authority granted':'Business agent control changed',actionType:'manual',outcome:'success',inputParams:{...bound.scope,agentId:id,command:input.command,requestHash},afterState:{revision:saved.revision,monitoring:saved.settings.monitoring,autonomous:saved.settings.autonomous,...(saved.grant?{grantId:saved.grant.id,authorityHash:saved.grant.authorityHash}:{})}}],{session});
      return saved;
    });
  }
  async function business(scope){
    const calendar=await models.Calendars.findOne(scope).select('authorityHash openingDate verifiedThrough adoption currentOperationId stopRequested pendingCommit lastActivityOperationId lastActivityAt').maxTimeMS(3000).lean();
    const writer=await models.Writers.findOne(scope).select('populationDelegation operationId unresolved').maxTimeMS(3000).lean();
    const policy=await models.Policies.findOne(scope).select('state').maxTimeMS(3000).lean();
    const job=await models.Jobs.findOne(scope).sort({createdAt:-1}).select('_id status throughDate createdThrough counts updatedAt').maxTimeMS(3000).lean();
    const run=calendar?.currentOperationId?await models.Runs.findOne({_id:calendar.currentOperationId,...scope}).select('_id status fromDate throughDate recordCount nextOrdinal planHash lastError agentAuthority executionRequest activityBatch').maxTimeMS(3000).lean():null;
    const observation=await models.Baselines.findOne(scope).sort({createdAt:-1}).select('payload.period payload.observedAt payload.evaluation.status payload.evaluation.checks').maxTimeMS(3000).lean();
    let recordCount=job?.counts?.saved??null;
    if(recordCount===null&&job&&['populated','populated-with-gaps','adopted'].includes(job.status)){
      const key=String(job._id)+':'+String(job.updatedAt);
      if(!completedCounts.has(key)){const rows=await models.Jobs.aggregate([{$match:{_id:job._id}},{$project:{count:{$size:'$manifest'}}}]).option({maxTimeMS:3000});if(Number.isSafeInteger(rows[0]?.count)){if(completedCounts.size>=20)completedCounts.clear();completedCounts.set(key,rows[0].count);}}
      recordCount=completedCounts.get(key)??null;
    }
    const blockers=businessBlockers({calendar,writer,job,run,policy});
    return {scope,published:Boolean(calendar?.authorityHash),authorityHash:calendar?.authorityHash||null,openingDate:calendar?.openingDate||null,verifiedThrough:calendar?.verifiedThrough||null,verificationBasis:require('./business-calendar').calendarCursor(calendar).basis,adoptedThrough:require('./business-calendar').calendarCursor(calendar).adoptedThrough,lastActivityAt:calendar?.lastActivityAt?new Date(calendar.lastActivityAt).toISOString():null,lastActivityOperationId:calendar?.lastActivityOperationId?String(calendar.lastActivityOperationId):null,recordsThrough:job?.createdThrough||null,recordCount,populationStatus:job?.status||null,currentOperation:run?{operationId:String(run._id),status:run.status,fromDate:run.fromDate,throughDate:run.throughDate,recordCount:run.recordCount,completedRecords:run.nextOrdinal||0,planHash:run.planHash,agentAuthority:run.agentAuthority||null,activityBatch:run.activityBatch?{decisionKey:run.activityBatch.decisionKey,purpose:run.activityBatch.purpose,day:run.activityBatch.day}:null,executionPending:run.executionRequest?.pending===true}:null,bookChecks:observation?{period:observation.payload?.period,observedAt:observation.payload?.observedAt,status:observation.payload?.evaluation?.status,checks:observation.payload?.evaluation?.checks?.map(check=>({key:check.key,label:check.label,status:check.status}))}:null,blockers};
  }
  async function events(row){const rows=await Events.find({agentId:String(row._id)}).sort({at:-1,_id:-1}).limit(40).maxTimeMS(3000).lean();return rows.map(publicEvent);}
  async function decisions(row){
    const agentId=String(row._id);
    const rows=await Events.aggregate([
      {$match:{agentId,kind:'decision'}},
      {$lookup:{from:Events.collection.name,let:{decisionId:'$_id'},pipeline:[{$match:{agentId,kind:'decision-response',$expr:{$eq:['$data.decisionId','$$decisionId']}}},{$sort:{at:-1,_id:-1}},{$limit:1}],as:'responses'}},
      {$addFields:{answered:{$gt:[{$size:'$responses'},0]}}},{$sort:{answered:1,at:-1,_id:-1}},{$limit:20},
    ]).option({maxTimeMS:3000});
    return rows.map(value=>{const response=value.responses[0];return {...publicEvent(value),status:response?response.data.choice:'pending',response:response?publicEvent(response):null};});
  }
  async function decision(row,id){
    if(!/^[a-f0-9]{24}$/.test(id||''))fail('Choose a saved business decision.',400);
    const value=await Events.findOne({_id:id,agentId:String(row._id),kind:'decision'}).maxTimeMS(3000).lean();
    if(!value)fail('This decision does not belong to the selected business.');
    const response=await Events.findOne({agentId:String(row._id),kind:'decision-response','data.decisionId':id}).maxTimeMS(3000).lean();
    return {...publicEvent(value),status:response?response.data.choice:'pending',response:response?publicEvent(response):null};
  }
  async function due(limit=20){return Agents.find({'settings.monitoring':true,nextWakeAt:{$lte:new Date(now())},$or:[{leaseToken:null},{leaseExpiresAt:{$lte:new Date(now())}}]}).select('_id').sort({nextWakeAt:1,_id:1}).limit(limit).maxTimeMS(3000).lean();}
  async function claim(id,token,leaseMs){return Agents.findOneAndUpdate({_id:id,'settings.monitoring':true,nextWakeAt:{$lte:new Date(now())},$or:[{leaseToken:null},{leaseExpiresAt:{$lte:new Date(now())}}]},{$set:{leaseToken:token,leaseExpiresAt:new Date(now()+leaseMs),currentWork:'Checking the current business state'}},{new:true}).lean();}
  async function current(row,token){const value=await Agents.findOne({_id:row._id,...scopeOf(row),revision:row.revision,leaseToken:token,'settings.monitoring':true,leaseExpiresAt:{$gt:new Date(now())}}).maxTimeMS(3000).lean();if(!value)fail('The business worker was paused, changed or lost its lease.');return value;}
  async function update(row,token,changes){const saved=await Agents.findOneAndUpdate({_id:row._id,...scopeOf(row),revision:row.revision,leaseToken:token,'settings.monitoring':true,leaseExpiresAt:{$gt:new Date(now())}},{$set:changes},{new:true}).lean();if(!saved)fail('The business worker changed before its progress was saved.');return saved;}
  async function release(row,token,changes){return Agents.findOneAndUpdate({_id:row._id,...scopeOf(row),revision:row.revision,leaseToken:token},{$set:{...changes,leaseToken:null,leaseExpiresAt:null,currentWork:''}},{new:true}).lean();}
  async function ownedRuns(scope,agentId){return models.Runs.find({...scope,'agentAuthority.agentId':agentId,status:{$nin:['verified','retired','stopped']}}).select('_id status').limit(100).maxTimeMS(3000).lean();}
  async function run(scope,id){return models.Runs.findOne({_id:id,...scope}).select('_id planHash status createdBy agentAuthority fromDate throughDate recordCount executionRevision').maxTimeMS(3000).lean();}
  return {models,get,setup,control,business,events,decisions,decision,event,due,claim,current,update,release,run,ownedRuns,scopeOf};
}
module.exports={createBusinessAgentStore,loadModels,scopeOf,publicEvent};
