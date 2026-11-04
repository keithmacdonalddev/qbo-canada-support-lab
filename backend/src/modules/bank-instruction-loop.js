'use strict';
// Independent bank clock: no AI, QBO client, browser or native banking operator.
const C=require('./bank-settlement-contract');
const A=require('./business-agent-authority');
const TARGET={environment:'production',realmId:'9130357222392856'};
const clone=v=>JSON.parse(JSON.stringify(v));
const key=(scope,ownerId)=>C.hash({scope,ownerId});
const safeCode=e=>/^(BANKING_|BUSINESS_ACCESS_|BUSINESS_AGENT_)[A-Z_]+$/.test(e?.code||'')?e.code:'BANKING_CLOCK_UNAVAILABLE';
function createBankInstructionLoop({listAgents,listAccounts,execute,now=()=>Date.now(),intervalMs=60000,setTimer=setInterval,clearTimer=clearInterval}) {
  let closed=false,timer=null,pending=null;const states=new Map(),backoff=new Map();
  async function work() {
    const agents=await listAgents();if(closed)return;
    if(!Array.isArray(agents)||agents.length>3)throw Error('Bounded bank owner inventory unavailable');
    for(const row of agents){
      if(closed)break;
      const scope=C.validateScope({environment:row.environment,realmId:String(row.realmId),connectionId:String(row.connectionId)}),ownerId=String(row.ownerId);
      if(scope.environment!==TARGET.environment||scope.realmId!==TARGET.realmId)continue;
      let authority;try{authority=A.agentAuthority({version:1,agentId:String(row._id),ownerId,grantId:row.grant?.id,authorityHash:row.grant?.authorityHash});}catch{continue;}
      if(row.settings?.monitoring!==true||row.settings?.autonomous!==true||String(row.grant?.ownerId)!==ownerId)continue;
      const bound={scope,ownerId,actorId:ownerId,agentAuthority:authority,isActive:()=>!closed},id=key(scope,ownerId),stamp=new Date(now()).toISOString();
      const state={status:'running',lastTickAt:stamp,lastWorkAt:states.get(id)?.lastWorkAt||null,nextTickAt:new Date(now()+intervalMs).toISOString(),scheduled:0,posted:0,monthlyIssued:0,accounts:[],processOnly:true};states.set(id,state);
      try{
        const accounts=await listAccounts(scope);if(!Array.isArray(accounts)||accounts.length>1000||accounts.some(a=>typeof a!=='string'||!/^\d{1,30}$/.test(a)))throw Error('Adopted bank account inventory unavailable');
        for(const accountId of [...new Set(accounts)].sort()){
          if(closed)break;
          const accountKey=id+':'+accountId,prior=backoff.get(accountKey);
          if(prior&&prior.nextAt>now()){state.accounts.push({accountId,status:'waiting',code:prior.code,nextAttemptAt:new Date(prior.nextAt).toISOString()});continue;}
          try{
            const result=await execute(bound,accountId);
            const changed=(result.results||[]).filter(r=>r.changed===true);state.scheduled+=changed.filter(r=>r.status==='pending').length;state.posted+=result.posted||0;state.monthlyIssued+=result.monthlyStatements?.issued?1:0;
            if(changed.length||result.bankOrigins?.posted||result.currentFeed?.published&&!result.currentFeed?.reused||result.monthlyStatements?.issued)state.lastWorkAt=new Date(now()).toISOString();backoff.delete(accountKey);state.accounts.push({accountId,status:'checked',boundedBatch:true,processed:(result.results||[]).length,monthlyStatementStatus:result.monthlyStatements?.status||null});
          }catch(error){const misses=(prior?.misses||0)+1,nextAt=now()+Math.min(900000,60000*2**Math.min(misses-1,4)),code=safeCode(error);backoff.set(accountKey,{misses,nextAt,code});state.accounts.push({accountId,status:'waiting',code,nextAttemptAt:new Date(nextAt).toISOString()});}
        }
        state.status=closed?'stopped':state.accounts.some(a=>a.status==='waiting')?'attention':'waiting';
      }catch(error){state.status=closed?'stopped':'unavailable';state.code=safeCode(error);}
    }
  }
  function tick(){if(closed)return Promise.resolve();if(pending)return pending;pending=Promise.resolve().then(work).catch(()=>{for(const state of states.values()){state.status='unavailable';state.code='BANKING_CLOCK_UNAVAILABLE';}}).finally(()=>{pending=null;});return pending;}
  function start(){if(closed||timer)return;timer=setTimer(()=>{void tick();},intervalMs);timer.unref?.();void tick();}
  function close(){closed=true;if(timer)clearTimer(timer);timer=null;for(const state of states.values()){state.status='stopped';state.nextTickAt=null;}}
  function status(scope,ownerId){const state=states.get(key(C.validateScope(scope),String(ownerId)));return state?clone({...state,status:closed?'stopped':now()-Date.parse(state.lastTickAt)>3*intervalMs?'unobserved':state.status}):{status:closed?'stopped':'unobserved',lastTickAt:null,lastWorkAt:null,nextTickAt:null,processOnly:true};}
  return {tick,start,close,drain:async()=>{if(pending)await pending;},status};
}
function createDefaultBankInstructionLoop(options={}) {
  const Agents=options.Agents||require('../models/BusinessAgent'),Events=options.Events||require('../models/BankingEvent');
  const createAccess=options.createAccess||require('./business-runtime-access').createBusinessRuntimeAccess;
  const fence=options.fence||A.fenceAgentAuthority;
  const makeSettlement=options.makeSettlement||require('./bank-instruction-settlement').createBankInstructionSettlement;
  const authorize=async b=>{
    if(b.isActive && !b.isActive())throw Object.assign(Error('Bank clock is stopped'),{code:'BANKING_CLOCK_STOPPED'});
    await createAccess({ownerId:b.ownerId,actorId:b.actorId}).authorize(b.scope,'periods.manage',{session:b.session});
    if(b.session)return fence({authority:b.agentAuthority,scope:b.scope,ownerId:b.ownerId,actorId:b.actorId,Agents,session:b.session});
    const current=await Agents.findOne({_id:b.agentAuthority.agentId,...b.scope,ownerId:b.ownerId,'settings.monitoring':true,'settings.autonomous':true,'grant.ownerId':b.ownerId}).maxTimeMS(3000).lean();
    if(!current||!A.ownsAgentWork(b.agentAuthority,current))throw Object.assign(Error('Bank clock authorization changed'),{code:'BUSINESS_AGENT_AUTHORITY_REQUIRED'});
  };
  const settlement=makeSettlement({authorize});
  const origin=options.originService||require('./bank-origin-service').createDefaultBankOriginService({authorize:(bound,session)=>authorize({...bound,session}),now:options.now});
  const feeds=options.feedService||require('./bank-feed-service').createDefaultBankFeedService({authorize:(bound,session)=>authorize({...bound,session}),now:options.now});
  const statements=options.statementService||(options.Events?{issue:async()=>({status:'held',reason:'Explicit monthly proof composition is required for an injected bank clock.',qboCalls:0})}:require('./bank-monthly-statement-service').createDefaultBankMonthlyStatementService({authorize:(bound,session)=>authorize({...bound,session}),now:options.now}));
  let peekStore;
  const selectDue=options.selectDue || ((scope,accountId)=>{peekStore ||= require('./banking-workspace-service').createMongoBankingStore({Events,Packages:require('../models/BankingPackage'),connection:require('mongoose').connection});return peekStore.listSettlementInstructions(scope,require('./business-agent-cadence').localParts((options.now||Date.now)()).date,null,accountId);});
  return createBankInstructionLoop({...options,listAgents:()=>Agents.find({...TARGET,'settings.monitoring':true,'settings.autonomous':true,'grant.ownerId':{$type:'string'}}).limit(4).maxTimeMS(3000).lean(),listAccounts:scope=>Events.distinct('accountId',{...scope,kind:'ledger-account',revision:0}).maxTimeMS(3000),execute:async(bound,accountId)=>{await authorize(bound);const bankOrigins=await origin.processDue(bound,{accountId});const due=await selectDue(bound.scope,accountId);const result=due.length?await settlement.settle(bound,{accountId}):{results:[],posted:0,qboCalls:0};const currentFeed=await feeds.publishDue(bound,{accountId});let monthlyStatements;try{monthlyStatements=await statements.issue(bound,{accountId});}catch(error){if(!/^BANKING_/.test(error.code||''))throw error;monthlyStatements={status:'held',reason:error.message,code:error.code,qboCalls:0};}return{...result,monthlyStatements,posted:(result.posted||0)+(bankOrigins.posted||0),bankOrigins,currentFeed};}});
}
let singleton;
function getBankInstructionLoop(){return singleton||=createDefaultBankInstructionLoop();}
function readBankInstructionLoopStatus(scope,ownerId){return singleton?singleton.status(scope,ownerId):{status:'unobserved',lastTickAt:null,lastWorkAt:null,nextTickAt:null,processOnly:true};}
module.exports={createBankInstructionLoop,createDefaultBankInstructionLoop,getBankInstructionLoop,readBankInstructionLoopStatus};
