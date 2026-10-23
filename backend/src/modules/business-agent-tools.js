'use strict';
const { hash, shift, date } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const { fail, ID } = require('./business-agent-policy');
const READ_NAMES = Object.freeze(['lookupCustomer','lookupInvoice','searchEntities','getEntityDetail','getTransactionChain','runReport']);
const SPECIALIST_TYPES = Object.freeze({receivables:['Customer','Invoice','Payment','CreditMemo','Deposit','Estimate'],payables:['Vendor','Bill','BillPayment','VendorCredit','Purchase','PurchaseOrder'],inventory:['Item','PurchaseOrder','Bill','SalesReceipt','Invoice']});
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string'}, id={type:'string',pattern:'^[a-f0-9]{24}$'}, digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const EXTRA_TOOLS = Object.freeze([
  {name:'getBusinessState',description:'Inspect current synchronization, published policy, retained work, accounting checks, owner decisions and blockers before acting.',input_schema:schema()},
  {name:'getObligations',description:'Read currently mirrored unpaid invoices or bills with dates and amounts. Results are explicitly provisional when source synchronization is incomplete.',input_schema:schema({area:{type:'string',enum:['receivables','payables']},overdueOnly:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:50}},['area'])},
  {name:'inspectBusinessOperation',description:'Read the immutable saved accounting plan and its retained verification/recovery state.',input_schema:schema({operationId:id,offset:{type:'integer',minimum:0,maximum:1000}},['operationId'])},
  {name:'prepareBusinessPeriod',description:'Prepare an elapsed period under the published business policy. Retained existing history and unresolved operations must be settled first. This creates no QBO records.',input_schema:schema({throughDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}},['throughDate'])},
  {name:'executeBusinessPeriod',description:'Approve and queue the exact retained accounting plan covered by the current standing owner authority. Every write retains its native accounting checks, receipts and current pause gate.',input_schema:schema({operationId:id,planHash:digest,reason:text},['operationId','planHash','reason'])},
  {name:'resumeBusinessOperation',description:'Review and resume the exact stopped operation belonging to this agent grant, preserving original saved records, then queue its continuation under standing authority.',input_schema:schema({operationId:id,planHash:digest,reason:text},['operationId','planHash','reason'])},
  {name:'recordBusinessDecision',description:'Retain a business-management decision and its evidence, or ask the owner for a factual/policy decision that cannot be made under current authority. Never repeatedly ask for an already answered decision.',input_schema:schema({issueKey:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{2,79}$'},title:text,detail:text,requiresOwner:{type:'boolean'},area:{type:'string',enum:['business','accounting','receivables','payables','inventory','troubleshooting']}},['issueKey','title','detail','requiresOwner','area'])},
  {name:'rememberBusinessContext',description:'Save a concise operating handoff for the next pass: decisions, unfinished obligations and the next safe action. It cannot replace original QBO evidence.',input_schema:schema({memory:text},['memory'])},
  {name:'linkReproductionCase',description:'Attach an existing company-scoped troubleshooting case to this business-management activity. Does not start or mutate a case.',input_schema:schema({sessionId:id,reason:text},['sessionId','reason'])},
]);
// The advertised model schema is also enforced here; unknown nested keys fail closed.
function validateArguments(value,definition,path='input') {
  if(definition.enum&&!definition.enum.includes(value))fail(path+' is outside the supported choices.',400);
  switch(definition.type){
    case 'object':
      if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail(path+' must be an object.',400);
      if(Object.keys(value).some(key=>!Object.hasOwn(definition.properties||{},key)))fail(path+' contains an unsupported field.',400);
      for(const key of definition.required||[])if(!Object.hasOwn(value,key))fail(path+'.'+key+' is required.',400);
      for(const [key,item] of Object.entries(value))validateArguments(item,definition.properties[key],path+'.'+key);break;
    case 'string': if(typeof value!=='string'||value.length>6000||(definition.pattern&&!new RegExp(definition.pattern).test(value)))fail(path+' must be supported bounded text.',400);break;
    case 'integer': if(!Number.isSafeInteger(value))fail(path+' must be a whole number.',400); // falls through
    case 'number': if(typeof value!=='number'||!Number.isFinite(value)||(definition.minimum!==undefined&&value<definition.minimum)||(definition.maximum!==undefined&&value>definition.maximum))fail(path+' is outside the supported numeric range.',400);break;
    case 'boolean':if(typeof value!=='boolean')fail(path+' must be true or false.',400);break;
    case 'array':if(!Array.isArray(value)||value.length>100)fail(path+' must be a bounded list.',400);value.forEach(item=>validateArguments(item,definition.items,path+'[]'));break;
    default:fail(path+' has no supported contract.',400);
  }
}
function operationAllowed(run,row) {const origin=run?.agentAuthority;return Boolean(run&&String(run.createdBy)===String(row.ownerId)&&origin?.version===1&&origin.agentId===String(row._id)&&origin.grantId===row.grant?.id&&origin.authorityHash===row.grant?.authorityHash&&origin.ownerId===String(row.ownerId));}
function createBusinessAgentTools({row,role='accountant',passId,scope,store,access,user,guard,persistMemory,signal,now=()=>Date.now(),governanceFor,execution,readTools,clientFor,linkCase}={}) {
  const native=readTools||require('./ai-tools');
  const definitions=[...native.toolDefinitions.filter(tool=>READ_NAMES.includes(tool.name)),...EXTRA_TOOLS.filter(tool=>role==='accountant'||!['prepareBusinessPeriod','executeBusinessPeriod','resumeBusinessOperation'].includes(tool.name))];
  const byName=new Map(definitions.map(tool=>[tool.name,tool]));let qbo=null,calls=0,readAttempts=0;
  async function readClient(){
    if(qbo)return qbo;
    const client=await (clientFor?clientFor():access.resolveClient(scope,{signal}));
    const control={signal,beforeAttempt:async()=>{await guard();if(++readAttempts>48)fail('This business review used its read allowance; its next pass will continue.');},onFailure:()=>{}};
    qbo={query:async query=>{await guard();return client.query(query,control);},read:async(entity,id)=>{await guard();return client.apiCall('GET',entity+'/'+encodeURIComponent(id),undefined,0,0,control);},apiCall:async(method,endpoint)=>{await guard();if(method!=='GET'||typeof endpoint!=='string'||!endpoint.startsWith('reports/'))fail('Only the supported report read is allowed.');return client.apiCall('GET',endpoint,undefined,0,0,control);}};
    return qbo;
  }
  async function execute(name,input={}){
    if(++calls>24)fail('This decision pass reached its tool allowance. Saved work continues in the next pass.');
    await guard();const definition=byName.get(name);if(!definition)fail('This role cannot use that business tool.',400);validateArguments(input,definition.input_schema);
    if(role!=='accountant'&&SPECIALIST_TYPES[role]){
      const type=input.type||input.entityType;if(type&&!SPECIALIST_TYPES[role].includes(type))fail('This record type belongs to another specialist responsibility.',403);
      if(name==='getObligations'&&input.area!==role)fail('This obligations queue belongs to another responsibility.',403);
    }
    let result;
    if(READ_NAMES.includes(name))result=await native.toolHandlers[name](input,{qbo:await readClient(),userId:String(row.ownerId),realmId:scope.realmId,connection:{_id:scope.connectionId}});
    else if(name==='getBusinessState')result={success:true,data:{business:await store.business(scope),sync:row.syncView,ownerInstructions:row.settings.instructions,decisions:await store.decisions(row),capabilities:businessAgentCapabilities()}};
    else if(name==='getObligations'){
      const today=businessDate(new Date(now())),entity=input.area==='receivables'?'Invoice':'Bill';
      const rows=await store.models.Records.find({...scope,entity,deleted:false,'summary.balanceCents':{$gt:0},...(input.overdueOnly?{'summary.dueDate':{$lt:today}}:{})}).select('entity qboId summary lastObservedAt').sort({'summary.dueDate':1,_id:1}).limit(input.limit||20).maxTimeMS(3000).lean();
      result={success:true,data:{asOf:row.syncView?.lastSuccessAt||null,provisional:row.syncView?.status!=='current',records:rows.map(item=>({entity:item.entity,id:item.qboId,...item.summary,observedAt:item.lastObservedAt})),mayHaveMore:rows.length===(input.limit||20)}};
    }else if(name==='inspectBusinessOperation')result={success:true,data:await governanceFor(null).reviewOperation(user,input.operationId,input.offset||0)};
    else if(name==='prepareBusinessPeriod'){
      const business=await store.business(scope);if(business.blockers.length)fail(business.blockers[0].detail);
      const from=business.verifiedThrough?shift(business.verifiedThrough,1):business.openingDate;
      if(!from||input.throughDate<from||input.throughDate>businessDate(new Date(now()))||date(input.throughDate)-date(from)>30*86400000)fail('Choose the next uninterrupted elapsed business period, at most 31 days.');
      await guard(true);const origin={version:1,agentId:String(row._id),grantId:row.grant.id,authorityHash:row.grant.authorityHash,ownerId:String(row.ownerId)};
      result={success:true,data:await governanceFor(origin).prepare(user,{requestKey:hash({agentId:row._id,grantId:row.grant.id,passId,throughDate:input.throughDate}),throughDate:input.throughDate},{signal})};
    }else if(name==='executeBusinessPeriod'){
      await guard(true);const run=await store.run(scope,input.operationId);if(!operationAllowed(run,row)||run.planHash!==input.planHash)fail('Only exact retained plans belonging to this agent grant can be executed.');
      const origin=run.agentAuthority;await store.event(row,'plan-decision','Main accountant approved a business period',input.reason.slice(0,3000),{operationId:input.operationId,planHash:input.planHash,grantId:row.grant.id,authorityHash:row.grant.authorityHash,approvalSource:'standing-owner-grant'},null,hash({passId,operationId:input.operationId,phase:'approve'}),role);
      await guard(true);await governanceFor(origin).approve(user,input.operationId,{planHash:input.planHash,...(scope.environment==='production'?{confirmProduction:true}:{})});
      await guard(true);result={success:true,data:await execution.request(user,input.operationId,{planHash:input.planHash,requestKey:hash({passId,operationId:input.operationId,phase:'execute'})})};
    }else if(name==='resumeBusinessOperation'){
      await guard(true);const run=await store.run(scope,input.operationId);if(!operationAllowed(run,row)||run.planHash!==input.planHash)fail('Only the exact retained operation belonging to this standing grant can resume.');
      if(input.reason.trim().length<20||input.reason.length>2000)fail('Record the exact recovery reason in 20–2000 characters.',400);
      const governor=governanceFor(run.agentAuthority);
      if(run.status==='stopped'){const reviewed=await governor.reviewResume(user,input.operationId,{planHash:input.planHash});await guard(true);await governor.resume(user,input.operationId,{planHash:input.planHash,reviewHash:reviewed.reviewHash,reason:input.reason.trim()});}
      else if(!['approved','reserved','running','blocked','awaiting-evidence'].includes(run.status))fail('This operation is not awaiting a supported continuation.');
      await guard(true);await store.event(row,'plan-decision','Main accountant continued retained business work',input.reason,{operationId:input.operationId,planHash:input.planHash,grantId:row.grant.id,approvalSource:'standing-owner-grant'},null,hash({passId,operationId:input.operationId,phase:'resume',revision:run.executionRevision||0}),role);
      await guard(true);result={success:true,data:await execution.request(user,input.operationId,{planHash:input.planHash,requestKey:hash({passId,operationId:input.operationId,phase:'resume-execute',revision:run.executionRevision||0})})};
    }else if(name==='recordBusinessDecision'){
      if(input.title.length>160||input.detail.length>5000)fail('Keep the decision title and evidence concise.',400);
      const kind=input.requiresOwner?'decision':role==='accountant'?'management-decision':'specialist-report';
      result={success:true,data:await store.event(row,kind,input.title,input.detail,{area:input.area,issueKey:input.issueKey,...(role==='accountant'?{}:{reportsTo:'accountant'})},null,hash({grantId:row.grant?.id||null,issueKey:input.issueKey,kind}),role)};
    }else if(name==='rememberBusinessContext'){
      if(input.memory.length>4000)fail('Keep the operating handoff within 4000 characters.',400);await persistMemory(input.memory);result={success:true,data:{saved:true}};
    }else if(name==='linkReproductionCase'){
      const session=linkCase?await linkCase(input.sessionId):await require('../models/AISession').findOne({_id:input.sessionId,userId:row.ownerId,realmId:scope.realmId,mode:'reproduce'}).select('_id').maxTimeMS(3000).lean();
      if(!session||!ID.test(String(session._id)))fail('This troubleshooting case does not belong to the selected company.');
      result={success:true,data:await store.event(row,'case-linked','Troubleshooting case linked',input.reason.slice(0,3000),{sessionId:input.sessionId,href:'/cases/'+input.sessionId},null,hash({passId,sessionId:input.sessionId}),role)};
    }
    await guard();const bytes=Buffer.byteLength(JSON.stringify(result));if(bytes>100000)return {success:false,error:'This result is too large for one review. Use smaller record/report pages; no complete observation is claimed.',truncated:true};return result;
  }
  return {definitions,execute,stats:()=>({calls,readAttempts})};
}
function businessAgentCapabilities(){return {reads:['company records','linked transaction chains','financial reports','receivables and payables obligations'],actions:['prepare and execute exact published-policy business periods','retain decisions and operating memory','link existing troubleshooting cases'],specialists:['receivables','payables','inventory'],boundaries:['Published activity uses its saved dated business rules; the agent cannot invent unsupported transaction policies.','Protected dates, original-record ownership and uncertain-write recovery remain enforced.','Troubleshooting cases are distinct scoped workflows; linking a case does not run it.']};}
module.exports={createBusinessAgentTools,businessAgentCapabilities,validateArguments,operationAllowed,READ_NAMES,EXTRA_TOOLS};
