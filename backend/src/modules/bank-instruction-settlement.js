'use strict';
// BANK-2.3: append-only independent bank settlement. No QBO client or service startup.
const C = require('./bank-settlement-contract');
const { DEFAULT_POLICY, postingDate } = require('./bank-settlement-engine');
const { ZONE, localParts } = require('./business-agent-cadence');
const { verifyLedger, balances } = require('./independent-bank-ledger');
const { settlementLegs, nativeAmount } = require('./bank-settlement-financial');
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a,b) => C.canonical(a) === C.canonical(b);
const scopeOf = value => C.validateScope({environment:value.environment,realmId:String(value.realmId),connectionId:String(value.connectionId)});
const check = (ok,message) => { if(!ok) throw Object.assign(new Error(message),{status:409,code:'BANKING_SETTLEMENT_PROOF'}); };
const KIND = 'governed-bank-settlement';
function validateInstruction(row, scope) {
  const p=row?.payload;
  check(row && same(scopeOf(row),scope) && same(p?.scope,scope) && row.kind==='instruction' && row.revision===0 && p.kind==='governed-bank-instruction' && p.version===1 && p.state==='pending','Exact immutable pending instruction required.');
  check(row.eventId==='@instruction:'+p.eventId && row._id===C.hash({scope,kind:'instruction',eventId:row.eventId}) && row.contentHash===C.hash(p) && row.sourceHash===p.source?.signature && p.creator==='api-accountant' && p.expectedResolution==='match','Pending instruction identity or content changed.');
  check(row.accountId===p.accountId && row.accountCurrency===p.accountCurrency && ['Bank','Credit Card'].includes(p.accountType) && /^[A-Z]{3}$/.test(p.accountCurrency) && Number.isSafeInteger(p.amountMinor) && p.amountMinor!==0,'Pending instruction native account or amount changed.');
  C.date(p.bookDate);
  const {signature,receiptId,...lineage}=p.source || {};
  check(signature===C.hash(lineage) && /^[a-f0-9]{24}$/.test(p.source.ownerId || '') && /^[a-f0-9]{24}$/.test(p.deliveryActorId || '') && Number.isFinite(Date.parse(p.receivedAt)) && new Date(p.receivedAt).toISOString()===p.receivedAt,'Pending instruction provenance is invalid.');
  check(p.eventId===C.stableEventId(scope,p.source.entity,p.source.id,p.accountId) && Boolean(p.settlementGroupId)===Boolean(p.pairedEventId),'Pending economic identity or paired leg changed.');
  return p;
}
function scheduleFor(instruction, record) {
  check(C.hash(record)===instruction.source.recordHash,'Original bank instruction record changed.');
  const receivedDate=localParts(Date.parse(instruction.receivedAt)).date;
  const effectiveDate=instruction.bookDate>receivedDate?instruction.bookDate:receivedDate;
  const instrument=record.PaymentType==='Check' || Boolean(record.CheckPayment) ? 'cheque' : instruction.accountType==='Credit Card' ? 'card' : 'electronic';
  const policy=clone(DEFAULT_POLICY),lag=policy[instrument==='cheque'?'chequeLagDays':instrument==='card'?'cardLagDays':'electronicLagDays'];
  return {timeZone:ZONE,receivedDate,effectiveDate,instrument,timingPolicy:policy,expectedPostingDate:postingDate(effectiveDate,lag,policy)};
}
function validateOriginal(p, proof) {
  const record=proof.record,r=proof.routingRecord || record,legs=settlementLegs(p.source.entity,r),leg=legs.find(l=>l.accountId===p.accountId);
  check(leg && C.hash(record)===p.source.recordHash && r.Id===p.source.id && r.TxnDate===p.bookDate && nativeAmount(r,p.accountCurrency,leg.amount,leg.sign,{entity:p.source.entity})===p.amountMinor,'Original instruction native routing, amount or date differs.');
  check(p.logicalKey===C.hash({scope:p.scope,runId:p.source.runId,ref:p.source.ref,accountId:p.accountId}),'Original logical instruction identity changed.');
  const paired=legs.length===2;
  check(p.settlementGroupId===(paired?C.hash({scope:p.scope,runId:p.source.runId,ref:p.source.ref}):null) && p.pairedEventId===(paired?C.stableEventId(p.scope,p.source.entity,p.source.id,legs.find(l=>l.accountId!==p.accountId)?.accountId):null),'Original paired instruction metadata changed.');
  check(!['Payment','SalesReceipt'].includes(p.source.entity) || ![...(r.LinkedTxn || []),...(r.Line || []).flatMap(l=>l.LinkedTxn || [])].some(l=>l.TxnType==='Deposit'),'Deposit-contained receipt cannot settle independently.');
  return record;
}
function validateSchedule(p, schedule) {
  check(schedule?.timeZone===ZONE && same(schedule.timingPolicy,DEFAULT_POLICY) && ['cheque','card','electronic'].includes(schedule.instrument),'Unknown retained bank timing policy.');
  const receivedDate=localParts(Date.parse(p.receivedAt)).date,effectiveDate=p.bookDate>receivedDate?p.bookDate:receivedDate;
  const lag=DEFAULT_POLICY[schedule.instrument==='cheque'?'chequeLagDays':schedule.instrument==='card'?'cardLagDays':'electronicLagDays'];
  check(schedule.receivedDate===receivedDate && schedule.effectiveDate===effectiveDate && schedule.expectedPostingDate===postingDate(effectiveDate,lag,DEFAULT_POLICY),'Retained bank timing changed.');
}
function revisionRow(scope, instruction, payload) {
  const eventId='@instruction:'+instruction.eventId;
  return {...scope,_id:C.hash({scope,eventId,revision:payload.revision}),kind:'revision',eventId,revision:payload.revision,accountId:instruction.accountId,accountCurrency:instruction.accountCurrency,sourceHash:payload.instructionHash,contentHash:C.hash(payload),payload};
}
function pendingRevision(row, schedule) {
  const p=row.payload;
  return {version:1,kind:KIND,scope:clone(p.scope),eventId:p.eventId,revision:1,instructionId:row._id,instructionHash:row.contentHash,previousRevisionHash:null,accountId:p.accountId,accountCurrency:p.accountCurrency,accountType:p.accountType,amountMinor:p.amountMinor,creator:p.creator,expectedResolution:p.expectedResolution,settlementGroupId:p.settlementGroupId,pairedEventId:p.pairedEventId,bookDate:p.bookDate,receivedAt:p.receivedAt,deliveryActorId:p.deliveryActorId,description:p.description,source:clone(p.source),schedule:clone(schedule),state:'pending',disposition:'included',stateHistory:[{state:'pending',date:schedule.receivedDate,evidenceRef:row._id}],postingDate:null,postingBasis:'simulated-policy'};
}
function postedRevision(row, pending, stamp, actorId, postingDate=pending.payload.schedule.expectedPostingDate) {
  const p={...clone(pending.payload),revision:2,previousRevisionHash:pending.contentHash,state:'posted',postingDate,settledAt:stamp,settlementActorId:actorId};
  p.stateHistory.push({state:'posted',date:p.postingDate,evidenceRef:C.hash({scope:p.scope,eventId:'@instruction:'+p.eventId,revision:2})});
  return revisionRow(p.scope,row.payload,p);
}
function rowContent(row) {
  return {...scopeOf(row),...Object.fromEntries(['_id','kind','eventId','revision','accountId','accountCurrency','sourceHash','contentHash','payload'].map(key=>[key,row[key]]))};
}
function validateRevisions(instructionRow, rows, scope) {
  const p=validateInstruction(instructionRow,scope),ordered=[...rows].sort((a,b)=>a.revision-b.revision);
  check(ordered.length<=2 && ordered.every((r,i)=>r.revision===i+1),'Bank settlement revisions are missing or unsupported.');
  if(!ordered.length)return null;
  const first=ordered[0];validateSchedule(p,first.payload?.schedule);
  const expected=pendingRevision(instructionRow,first.payload.schedule);
  check(same(rowContent(first),revisionRow(scope,p,expected)),'Pending settlement revision changed or belongs to another creator.');
  if(ordered.length===2) {
    const last=ordered[1],q=last.payload;
    check(Number.isFinite(Date.parse(q?.settledAt)) && new Date(q.settledAt).toISOString()===q.settledAt && /^[a-f0-9]{24}$/.test(q.settlementActorId || '') && q.postingDate>=q.schedule.expectedPostingDate && localParts(Date.parse(q.settledAt)).date>=q.postingDate,'Posted settlement observation is invalid or premature.');
    check(same(rowContent(last),postedRevision(instructionRow,first,q.settledAt,q.settlementActorId,C.date(q.postingDate))),'Posted settlement revision changed.');
  }
  return ordered.at(-1);
}
function validateBaseline(stored,p,scope) {
  check(stored && same(scopeOf(stored),scope),'Adopted bank ledger unavailable.');
  const ledger=verifyLedger(clone(stored.payload));
  check(same(ledger.scope,scope) && ledger.contentHash===stored.contentHash && ledger.account.accountId===p.accountId && ledger.account.accountCurrency===p.accountCurrency && ledger.account.accountType===p.accountType && !ledger.events.some(e=>e.eventId===p.eventId) && p.bookDate.slice(0,7)>ledger.throughPeriod,'Instruction overlaps or differs from frozen bank baseline.');
  return ledger;
}
function projectInstructionActivity({scope,ledger,instructions,revisions}) {
  scope=C.validateScope(scope);verifyLedger(ledger);check(same(ledger.scope,scope),'Bank projection scope changed.');
  const seen=new Set(),events=[];
  for(const row of instructions) {
    const p=validateInstruction(row,scope);check(!seen.has(p.eventId) && p.accountId===ledger.account.accountId && p.accountCurrency===ledger.account.accountCurrency && p.accountType===ledger.account.accountType && p.bookDate.slice(0,7)>ledger.throughPeriod && !ledger.events.some(e=>e.eventId===p.eventId),'Duplicate or overlapping bank projection.');seen.add(p.eventId);
    const latest=validateRevisions(row,revisions.filter(r=>r.eventId==='@instruction:'+p.eventId),scope);
    events.push(latest?clone(latest.payload):{eventId:p.eventId,accountId:p.accountId,accountCurrency:p.accountCurrency,amountMinor:p.amountMinor,state:'pending',disposition:'included',stateHistory:[{state:'pending',date:localParts(Date.parse(p.receivedAt)).date,evidenceRef:row._id}],description:p.description,source:clone(p.source),bookDate:p.bookDate,receivedAt:p.receivedAt,deliveryActorId:p.deliveryActorId,postingDate:null});
  }
  check(revisions.every(r=>seen.has(r.payload?.eventId)),'Bank projection has an orphan settlement revision.');
  events.sort((a,b)=>(a.postingDate || a.bookDate).localeCompare(b.postingDate || b.bookDate) || a.eventId.localeCompare(b.eventId));
  const balance=balances({account:ledger.account,openingMinor:ledger.balance.balanceMinor,events});
  return {version:1,baselineHash:ledger.contentHash,baselineThroughPeriod:ledger.throughPeriod,baselineBalanceMinor:ledger.balance.balanceMinor,activityMovementMinor:balance.movementMinor,boundedBalanceMinor:balance.balanceMinor,pendingCount:balance.pendingCount,pendingNativeMinor:balance.pendingNativeMinor,postedCount:balance.postedCount,events,coverage:{completeCurrentBalance:false,basis:'Frozen bounded baseline plus received business instructions only. Intervening historical months and the complete current bank/book balance are not established.'}};
}
function createBankInstructionSettlement(options={}) {
  let cachedStore,cachedModels;
  const store=()=>options.store || (cachedStore ||= require('./banking-workspace-service').createMongoBankingStore({Events:require('../models/BankingEvent'),Packages:require('../models/BankingPackage'),connection:require('mongoose').connection}));
  const models=()=>options.models || (cachedModels ||= {GeneralWriteRuns:require('../models/GeneralWriteRun'),Receipts:require('../models/QboWriteReceipt'),Authorities:require('../models/BusinessAuthority')});
  const now=options.now || (()=>Date.now());
  const authorize=options.authorize || (b=>require('./business-runtime-access').createBusinessRuntimeAccess({ownerId:b.ownerId,actorId:b.actorId}).authorize(b.scope,b.action,{session:b.session}));
  async function originalRecord(bound,p,session) {
    if(options.originalRecord)return options.originalRecord(bound,p,session);
    const run=await models().GeneralWriteRuns.findOne({_id:p.source.runId,...bound.scope,ownerId:bound.ownerId}).session(session).maxTimeMS(3000).lean();
    check(run && p.source.ownerId===String(bound.ownerId),'Original owner instruction unavailable.');
    const proof=await require('./bank-instruction-service').proveSource({models:models(),scope:bound.scope,run,ref:p.source.ref,session});
    check(proof.source.signature===p.source.signature,'Current retained instruction proof changed.');
    if(String(proof.receipt._id)!==p.source.receiptId) {
      // Re-prove the preserved first receipt against the exact current batch bytes.
      // This derived view is private; the run, receipt and instruction stay intact.
      const retainedRun=clone(run),batches=retainedRun.batches.filter(b=>b.index===p.source.batchIndex && b.requestId===p.source.requestId && b.items?.some(i=>i.ref===p.source.ref));
      check(batches.length===1,'Original retained instruction batch is unavailable.');
      batches[0].transport.receiptId=p.source.receiptId;
      const retained=await require('./bank-instruction-service').proveSource({models:models(),scope:bound.scope,run:retainedRun,ref:p.source.ref,session});
      check(retained.source.signature===p.source.signature && String(retained.receipt._id)===p.source.receiptId,'Original first-receipt lineage changed.');
    }
    return {record:proof.record,routingRecord:run.items[p.source.ref].record};
  }
  async function settle(bound,command={}) {
    const scope=C.validateScope(bound.scope),instant=new Date(now()),today=localParts(instant.getTime()).date,cutoff=command.cutoff===undefined?today:C.date(command.cutoff);
    check(Object.keys(command).every(k=>['cutoff','eventIds','accountId'].includes(k)) && cutoff<=today,'Settlement cannot simulate a future banking cutoff.');
    check(/^[a-f0-9]{24}$/.test(String(bound.ownerId)) && /^[a-f0-9]{24}$/.test(String(bound.actorId)),'Settlement actor and owner are required.');
    check(command.eventIds===undefined || Array.isArray(command.eventIds) && command.eventIds.length>0 && command.eventIds.length<=100 && new Set(command.eventIds).size===command.eventIds.length && command.eventIds.every(id=>typeof id==='string' && /^bse1_[a-f0-9]{40}$/.test(id)),'Exact bounded bank event identities required.');
    check(command.accountId===undefined || typeof command.accountId==='string' && /^\d{1,30}$/.test(command.accountId),'Exact bank account identity required.');
    await authorize({...bound,action:'periods.manage'});await store().assertReady();
    return store().transaction(async session=>{
      await authorize({...bound,action:'periods.manage',session});
      const rows=command.eventIds ? await Promise.resolve(command.eventIds).then(async ids=>{const result=[];for(const id of ids){const row=await store().getInstruction(scope,id,session);check(row,'Requested bank instruction unavailable.');result.push(row);}return result;}) : await store().listSettlementInstructions(scope,cutoff,session,command.accountId);
      check(rows.length<=100,'Settlement batch exceeds bounded capacity.');
      check(!command.accountId || rows.every(row=>row.accountId===command.accountId),'Requested bank instruction belongs to another account.');
      const groups=new Map();
      for(const row of rows){const p=validateInstruction(row,scope);check(p.source.ownerId===String(bound.ownerId),'Bank instruction belongs to another owner.');groups.set(p.eventId,row);if(p.pairedEventId){const pair=await store().getInstruction(scope,p.pairedEventId,session);check(pair,'Both transfer instructions are required.');groups.set(p.pairedEventId,pair);}}
      check(groups.size<=200,'Paired settlement batch exceeds bounded capacity.');
      const instructions=[...groups.values()],accounts=new Map();
      for(const row of instructions){const p=validateInstruction(row,scope);check(p.source.ownerId===String(bound.ownerId),'Paired bank instruction belongs to another owner.');const old=accounts.get(p.accountId);check(!old || old===p.accountCurrency,'Bank account currency conflict.');accounts.set(p.accountId,p.accountCurrency);}
      for(const [accountId,currency] of [...accounts].sort((a,b)=>a[0].localeCompare(b[0])))await store().fenceAccount(scope,accountId,currency,session);
      const prepared=new Map();
      for(const row of instructions){const p=row.payload;validateBaseline(await store().getLedger(scope,p.accountId,session),p,scope);const reservation=await store().getReservation(scope,p.eventId,session);check(reservation && same(scopeOf(reservation),scope) && reservation.kind==='reservation' && reservation.revision===0 && reservation.eventId===p.eventId && reservation._id===C.hash({scope,eventId:p.eventId,revision:0}) && reservation.sourceHash===reservation.contentHash && reservation.accountId===p.accountId && reservation.accountCurrency===p.accountCurrency && reservation.contentHash===C.hash(reservation.payload) && same(reservation.payload,{scope,eventId:p.eventId,accountId:p.accountId,creator:'api-accountant'}),'Instruction creator reservation changed.');check(Date.parse(p.receivedAt)<=instant.getTime(),'Bank instruction receipt is in the future.');const proof=await originalRecord(bound,p,session),record=validateOriginal(p,proof);const revisions=await store().getSettlementRevisions(scope,p.eventId,session);const latest=validateRevisions(row,revisions,scope);let pending=revisions.find(r=>r.revision===1);const schedule=scheduleFor(p,record);if(pending)check(same(pending.payload.schedule,schedule),'Retained instruction timing disagrees with its original record.');else pending=revisionRow(scope,p,pendingRevision(row,schedule));prepared.set(p.eventId,{row,p,pending,latest});}
      for(const entry of prepared.values())if(entry.p.pairedEventId){const peer=prepared.get(entry.p.pairedEventId);check(peer && peer.p.pairedEventId===entry.p.eventId && peer.p.settlementGroupId===entry.p.settlementGroupId && peer.p.source.signature===entry.p.source.signature && peer.p.accountId!==entry.p.accountId && peer.p.accountCurrency===entry.p.accountCurrency && C.sum([peer.p.amountMinor,entry.p.amountMinor])===0,'Paired bank settlement is not one proven same-currency transfer.');check(Boolean(peer.latest?.payload.state==='posted')===Boolean(entry.latest?.payload.state==='posted'),'Paired transfer has a partial posted state.');if(entry.latest?.payload.state==='posted'){const due=[entry.pending.payload.schedule.expectedPostingDate,peer.pending.payload.schedule.expectedPostingDate].sort().at(-1);check(entry.latest.payload.postingDate===due && peer.latest.payload.postingDate===due,'Paired transfer posted dates differ from their joint due date.');}}
      const results=[],stamp=instant.toISOString();
      for(const entry of prepared.values()){
        const {row,p,pending,latest}=entry;
        if(latest?.payload.state==='posted'){results.push({eventId:p.eventId,accountId:p.accountId,status:'posted',changed:false,revision:2,postingDate:latest.payload.postingDate});continue;}
        await store().putEvent(pending,session);
        const peer=p.pairedEventId?prepared.get(p.pairedEventId):null,due=pending.payload.schedule.expectedPostingDate<=cutoff && (!peer || peer.pending.payload.schedule.expectedPostingDate<=cutoff);
        if(due){const posted=postedRevision(row,pending,stamp,String(bound.actorId),peer?[pending.payload.schedule.expectedPostingDate,peer.pending.payload.schedule.expectedPostingDate].sort().at(-1):pending.payload.schedule.expectedPostingDate);await store().putEvent(posted,session);results.push({eventId:p.eventId,accountId:p.accountId,status:'posted',changed:true,revision:2,postingDate:posted.payload.postingDate});}
        else results.push({eventId:p.eventId,accountId:p.accountId,status:'pending',changed:!latest,revision:1,expectedPostingDate:pending.payload.schedule.expectedPostingDate});
      }
      return {cutoff,timeZone:ZONE,results,posted:results.filter(r=>r.status==='posted'&&r.changed).length,qboCalls:0};
    });
  }
  return {settle};
}
module.exports={createBankInstructionSettlement,projectInstructionActivity,validateInstruction,validateRevisions,scheduleFor,KIND};
