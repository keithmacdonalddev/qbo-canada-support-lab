'use strict';
// BANK-2.2: consume already accepted business creates. This module has no QBO client.
const C = require('./bank-settlement-contract');
const { nativeAmount, settlementLegs } = require('./bank-settlement-financial');
const { buildGeneralBatch, itemRequest } = require('./general-write-transport');
const { matchesRequest } = require('./general-write-recovery');
const crypto = require('node:crypto');
const KEYS = ['environment','realmId','connectionId'];
const SUPPORTED = new Set(['Payment','SalesReceipt','Deposit','Invoice','RefundReceipt','Purchase','BillPayment','Transfer','CreditCardPayment','TaxPayment']);
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a,b) => C.canonical(a) === C.canonical(b);
const check = (ok,message,code='BANKING_INSTRUCTION_PROOF') => { if(!ok) throw Object.assign(new Error(message),{status:409,code}); };
const sameScope = (a,b) => KEYS.every(k=>String(a?.[k])===String(b?.[k]));
const one = (Model,filter,session) => { let q=Model.findOne(filter); if(session)q=q.session(session); return q.maxTimeMS(3000).lean(); };
const rawHash = body => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
function acceptedSourceHash(items) {
  return C.hash(Object.fromEntries(Object.entries(items || {}).filter(([,item])=>item?.outcome==='saved' && item.complete===true)));
}
function externalReady(run) { return ['complete','needs-correction'].includes(run.status) && run.batches.every(b=>b.state==='answered'); }
function deliveryReady(run,inline) { return run.batches.every(b=>b.state==='answered') && (inline || externalReady(run)); }
function deliveryView(run) {
  const d=run.bankDelivery;
  return {runId:String(run._id),status:d?.status || 'not-queued',attempts:d?.attempts || 0,lastAttemptAt:d?.lastAttemptAt || null,results:clone(d?.results || [])};
}
async function proveSource({models,scope,run,ref,session}) {
  const item=run.items[ref],ops=run.plan?.operations?.filter(op=>op.ref===ref) || [];
  check(ops.length===1 && ops[0].op==='create' && item.op==='create' && item.entity===ops[0].entity,'The original instruction plan changed.');
  const batches=run.batches.filter(b=>b.attempt===item.attempt && b.state==='answered' && b.items?.some(s=>s.ref===ref));
  check(batches.length===1,'The original answered instruction batch is required.');
  const batch=batches[0],sentItems=batch.items.filter(s=>s.ref===ref),transport=batch.transport;
  check(sentItems.length===1 && transport?.outcome==='saved','The instruction batch is not proven saved.');
  const sent=sentItems[0],request=buildGeneralBatch(scope,batch),receipt=await one(models.Receipts,{_id:transport.receiptId,...scope},session),proof=receipt?.observed;
  check(receipt && sameScope(receipt,scope) && receipt.contractVersion===1 && receipt.kind==='general-write' && receipt.state==='saved' && ['ownerId','actorId'].every(k=>String(receipt[k])===String(run[k])) && String(receipt.operationId)===String(run._id) && receipt.requestHash===request.requestHash && receipt.entity==='batch' && receipt.operation==='create','The original scoped instruction receipt is required.');
  const g=receipt.general,w=receipt.workflow;
  check(g?.version===1 && g.contract==='general-write-v1' && g.runId===String(run._id) && g.batchIndex===batch.index && g.requestId===batch.requestId && g.decisionKey===run.decisionKey && Number.isSafeInteger(g.sends) && g.sends>0 && w?.version===1 && w.kind==='general-write' && w.runId===String(run._id) && w.batchIndex===batch.index && w.sends===g.sends && receipt.dispatchKey===C.hash({version:1,kind:'general-write',runId:String(run._id),batchIndex:batch.index,sends:g.sends}),'The admitted instruction identity changed.');
  check(proof?.entity==='batch' && proof.operation==='create' && proof.outcome==='saved' && Number.isInteger(proof.httpStatus) && proof.httpStatus>=200 && proof.httpStatus<300,'The original instruction response is not successful.');
  const rows=transport.response;
  check(Array.isArray(rows) && rows.length===batch.items.length && new Set(rows.map(r=>r?.bId)).size===rows.length && g.items?.length===rows.length && proof.items?.length===rows.length && transport.items?.length===rows.length,'Instruction batch evidence is incomplete.');
  for(const original of batch.items) {
    const ids=g.items.filter(p=>p.bId===original.bId),answers=rows.filter(p=>p.bId===original.bId),observed=proof.items.filter(p=>p.bId===original.bId);
    check(ids.length===1 && ids[0].ref===original.ref && ids[0].entity===original.entity && ids[0].operation===original.operation && ids[0].requestHash===itemRequest(scope,original).requestHash && answers.length===1 && observed.length===1 && observed[0].ref===original.ref,'Instruction item provenance changed.');
    const {bId,...body}=answers[0];
    check(observed[0].responseHash===rawHash(body),'The original instruction response hash changed.');
  }
  const answer=rows.find(row=>row.bId===sent.bId),wire=sent.entity==='CreditCardPayment'?'CreditCardPaymentTxn':sent.entity,record=answer?.[wire],observed=proof.items.find(p=>p.bId===sent.bId),gated=transport.items.filter(p=>p.bId===sent.bId);
  check(sent.entity===item.entity && sent.op==='create' && sent.operation==='create' && same(sent.payload,item.request) && gated.length===1 && gated[0].ref===ref && gated[0].outcome==='saved' && observed.outcome==='saved' && observed.operation==='create' && observed.entity===item.entity.toLowerCase() && sent.payload.Id===undefined && !answer.Fault && record && /^\d{1,30}$/.test(record.Id || '') && record.Id===item.qboId && gated[0].qboId===record.Id && observed.qboId===record.Id,'The accepted instruction item is not proven saved.');
  const ids=Object.fromEntries(Object.entries(run.items).filter(([,i])=>i.outcome==='saved').map(([key,i])=>[key,i.qboId]));
  check(same(require('./general-write-service').resolve(ops[0].payload,ids),sent.payload),'The resolved instruction changed from its original plan.');
  let recovered=false;
  if(item.entity==='BillPayment' && item.reconciliation?.kind===require('./general-billpayment-recovery').KIND) {
    recovered=Boolean(await require('./general-billpayment-recovery').loadProof({models,scope,run,ref,receipt,current:item.record,session}));
    check(recovered && same(record,item.originalSavedRecord),'Saved bill-payment authority is unavailable or changed.');
  }
  check(recovered || (!observed.mismatch && !gated[0].mismatch && same(record,item.record) && matchesRequest(sent.payload,record,item.entity)),'The accepted instruction differs from its receipt.');
  const lineage={runId:String(run._id),ref,batchIndex:batch.index,requestId:batch.requestId,bId:sent.bId,requestHash:request.requestHash,itemRequestHash:itemRequest(scope,sent).requestHash,responseHash:observed.responseHash,recordHash:C.hash(record),entity:item.entity,id:record.Id,ownerId:String(run.ownerId),originalActorId:String(run.actorId)};
  return {record,sent,receipt,source:{...lineage,signature:C.hash(lineage),receiptId:String(receipt._id)},ref};
}
function createBankInstructionService(options={}) {
  let cachedStore,cachedModels;
  const models=()=>options.models || (cachedModels ||= {GeneralWriteRuns:require('../models/GeneralWriteRun'),Receipts:require('../models/QboWriteReceipt'),Authorities:require('../models/BusinessAuthority')});
  const store=()=>options.store || (cachedStore ||= require('./banking-workspace-service').createMongoBankingStore({Events:require('../models/BankingEvent'),Packages:require('../models/BankingPackage'),connection:require('mongoose').connection}));
  const now=options.now || (()=>Date.now()),stamp=()=>new Date(now()).toISOString();
  const authorize=options.authorize || (bound=>require('./business-runtime-access').createBusinessRuntimeAccess({ownerId:bound.ownerId,actorId:bound.actorId}).authorize(bound.scope,bound.action,{session:bound.session}));
  async function load(bound,runId,session) {
    check(/^[a-f0-9]{24}$/.test(runId || ''),'Exact original run required.');
    const run=await one(models().GeneralWriteRuns,{_id:runId,...bound.scope},session);
    check(run && sameScope(run,bound.scope) && String(run.ownerId)===String(bound.ownerId) && run.contract==='general-write-v1','Original owner/company instruction is unavailable.');return run;
  }
  async function getAccount(scope,accountId,session) {
    if(options.getAccount)return options.getAccount(scope,accountId,session);
    return (await one(require('../models/CompanySyncRecord'),{...scope,entity:'Account',qboId:accountId,deleted:false},session))?.record || null;
  }
  async function deliver(bound,runId,{inline=false,force=false}={}) {
    let run=await load(bound,runId);
    if(!run.bankDelivery || !['pending','failed','held'].includes(run.bankDelivery.status) || run.bankDelivery.status==='held' && !force)return deliveryView(run);
    if(!deliveryReady(run,inline))return {...deliveryView(run),status:'waiting',note:'Bank-only recovery waits until financial execution finishes.'};
    await authorize({...bound,action:'periods.manage'});
    try {
      await store().assertReady();
      return await store().transaction(async session=>{
        run=await load(bound,runId,session);
        if(!deliveryReady(run,inline))return {...deliveryView(run),status:'waiting',note:'Bank-only recovery waits until financial execution finishes.'};
        if(!['pending','failed','held'].includes(run.bankDelivery?.status))return deliveryView(run);
        check(run.bankDelivery.sourceHash===acceptedSourceHash(run.items),'Accepted instruction queue evidence changed.');
        await authorize({...bound,action:'periods.manage',session});
        const results=[];
        for(const [ref,item] of Object.entries(run.items || {})) {
          if(item.outcome!=='saved' || item.complete!==true)continue;
          if(run.caseAuthority || item.op!=='create') { results.push({ref,status:'excluded',reason:'Only governed business creates enter ongoing bank activity.'});continue; }
          if(!SUPPORTED.has(item.entity))continue;
          if(/^bank_origin_/.test(run.decisionKey) || /\[bank-origin:/.test(item.request?.PrivateNote || '') || /\[bank-origin:/.test(item.record?.PrivateNote || '')) {results.push({ref,status:'held',reason:'Existing bank-origin activity needs its original event linkage; no second bank event was created.'});continue;}
          const source=await proveSource({models:models(),scope:bound.scope,run,ref,session}),r=source.record;
          C.date(r.TxnDate);
          if(['Payment','SalesReceipt'].includes(item.entity) && [...(r.LinkedTxn || []),...(r.Line || []).flatMap(l=>l.LinkedTxn || [])].some(l=>l.TxnType==='Deposit')) {results.push({ref,status:'excluded',reason:'Receipt is contained in a deposit; only that deposit enters bank activity.'});continue;}
          const legs=settlementLegs(item.entity,r);
          if(!legs.length)continue;
          const accounts=[];
          // Mongo transactions require sequential operations on their shared session.
          for(const leg of legs)accounts.push(leg.accountId?await getAccount(bound.scope,leg.accountId,session):null);
          if(['Payment','SalesReceipt'].includes(item.entity) && accounts[0] && String(accounts[0].Id || accounts[0].id)===legs[0].accountId && /^[A-Z]{3}$/.test(accounts[0].CurrencyRef?.value || accounts[0].currency || '') && (accounts[0].CurrencyRef?.value || accounts[0].currency)===r.CurrencyRef?.value && ['Other Current Asset','OtherCurrentAsset'].includes(accounts[0].AccountType || accounts[0].type) && (accounts[0].AccountSubType || accounts[0].subtype)==='UndepositedFunds') {results.push({ref,status:'excluded',reason:'Observed Undeposited Funds receipt creates no bank activity.'});continue;}
          if(accounts.some(a=>!a)) {results.push({ref,accountIds:legs.map(l=>l.accountId).filter(Boolean),status:'held',reason:'Bank account evidence is unavailable. Wait for account sync, then retry bank delivery; no instruction was discarded.'});continue;}
          let reason=null;
          if(legs.length===2 && (legs[0].accountId===legs[1].accountId || accounts.some(a=>!a)))reason='Both distinct transfer accounts must be available; neither leg was created.';
          const eligible=[];
          for(const [index,leg] of legs.entries()) {
            const account=accounts[index],currency=account?.CurrencyRef?.value || account?.currency,type=account?.AccountType || account?.type;
            if(!account || String(account.Id || account.id)!==leg.accountId || !['Bank','Credit Card'].includes(type) || ['CashOnHand','Cash on hand'].includes(account.AccountSubType || account.subtype)) {reason ||= 'Account is not an eligible bank or card account.';continue;}
            const amountMinor=nativeAmount(r,currency,leg.amount,leg.sign,{entity:item.entity});
            if(amountMinor===null) {reason ||= 'Exact native currency is required; foreign-exchange conversion is unavailable.';continue;}
            if(amountMinor===0)continue;
            const stored=await store().getLedger(bound.scope,leg.accountId,session);
            if(!stored) {reason ||= 'Adopt an evidenced independent ledger for this account before instruction delivery.';continue;}
            const ledger=require('./independent-bank-ledger').verifyLedger(clone(stored.payload));
            check(sameScope(stored,bound.scope) && sameScope(ledger.scope,bound.scope) && ledger.account.accountId===leg.accountId && ledger.account.accountCurrency===currency && ledger.account.accountType===type && stored.contentHash===ledger.contentHash,'Adopted bank account boundary changed.');
            const eventId=C.stableEventId(bound.scope,item.entity,r.Id,leg.accountId);
            if(ledger.events.some(e=>e.eventId===eventId)) {eligible.push({covered:true,leg,eventId});continue;}
            if(r.TxnDate.slice(0,7)<=ledger.throughPeriod) {reason ||= 'Instruction overlaps the frozen adopted history; no new pending event was created.';continue;}
            eligible.push({leg,eventId,currency,type,amountMinor});
          }
          if(eligible.length===2 && eligible.some(e=>e.covered) && !eligible.every(e=>e.covered)) reason ||= 'Transfer spans frozen and new activity; neither new leg was created.';
          if(reason || legs.length===2 && eligible.length!==2) {results.push({ref,accountIds:legs.map(l=>l.accountId).filter(Boolean),status:'held',reason:reason || 'Both transfer legs must be eligible; neither leg was created.'});continue;}
          // Account fences serialize both the economic and original-instruction identities.
          for(const entry of eligible.filter(e=>!e.covered).sort((a,b)=>a.leg.accountId.localeCompare(b.leg.accountId))) await store().fenceAccount(bound.scope,entry.leg.accountId,entry.currency,session);
          const pair=eligible.length===2?C.hash({scope:bound.scope,runId:String(run._id),ref}):null;
          for(const entry of eligible) {
            if(entry.covered) {results.push({ref,accountId:entry.leg.accountId,eventId:entry.eventId,status:'baseline-covered'});continue;}
            const {leg,eventId,currency,type,amountMinor}=entry,logicalKey=C.hash({scope:bound.scope,runId:String(run._id),ref,accountId:leg.accountId}),envelopeId='@instruction:'+eventId;
            const old=await store().getInstruction(bound.scope,eventId,session),logical=await store().getInstructionByLogical(bound.scope,leg.accountId,logicalKey,session);
            check(!logical || logical.payload.eventId===eventId,'Original bank instruction already names a different economic event.');
            if(old) {
              check(old.contentHash===C.hash(old.payload) && old.payload.logicalKey===logicalKey && old.payload.source.signature===source.source.signature && old.payload.accountId===leg.accountId && old.payload.amountMinor===amountMinor && old.payload.accountCurrency===currency,'Bank event already belongs to different original instruction evidence.');
              results.push({ref,accountId:leg.accountId,eventId,status:'pending',reused:true});continue;
            }
            const reservation=await store().getReservation(bound.scope,eventId,session);
            if(reservation)check(reservation.payload.creator==='api-accountant' && reservation.accountId===leg.accountId && reservation.accountCurrency===currency && reservation.payload.period===undefined,'A creator or historical-period reservation already owns this event.');
            else {
              const payload={scope:bound.scope,eventId,accountId:leg.accountId,creator:'api-accountant'};
              await store().putEvent({...bound.scope,_id:C.hash({scope:bound.scope,eventId,revision:0}),kind:'reservation',eventId,revision:0,accountId:leg.accountId,accountCurrency:currency,sourceHash:C.hash(payload),contentHash:C.hash(payload),payload},session);
            }
            const payload={version:1,kind:'governed-bank-instruction',scope:bound.scope,eventId,logicalKey,state:'pending',accountId:leg.accountId,accountCurrency:currency,accountType:type,amountMinor,bookDate:r.TxnDate,description:item.entity+' #'+r.Id,creator:'api-accountant',expectedResolution:'match',settlementGroupId:pair,pairedEventId:pair?eligible.find(e=>e.eventId!==eventId).eventId:null,source:source.source,receivedAt:stamp(),deliveryActorId:String(bound.actorId)};
            await store().putEvent({...bound.scope,_id:C.hash({scope:bound.scope,kind:'instruction',eventId:envelopeId}),kind:'instruction',eventId:envelopeId,revision:0,accountId:leg.accountId,accountCurrency:currency,sourceHash:source.source.signature,contentHash:C.hash(payload),payload},session);
            results.push({ref,accountId:leg.accountId,eventId,status:'pending',reused:false});
          }
        }
        const bankDelivery={...run.bankDelivery,status:results.some(r=>r.status==='held')?'held':'complete',attempts:(run.bankDelivery.attempts || 0)+1,lastAttemptAt:stamp(),lastDeliveryActorId:String(bound.actorId),results};
        const saved=await models().GeneralWriteRuns.findOneAndUpdate({_id:run._id,...bound.scope,revision:run.revision,status:run.status},{$set:{bankDelivery},$inc:{revision:1}},{new:true,session}).lean();
        check(saved,'Financial execution changed during bank-only delivery.');return deliveryView(saved);
      });
    } catch(error) {
      // This separate projection cannot roll back or re-send an accepted QBO record.
      const fresh=await load(bound,runId);
      if(fresh.bankDelivery?.status==='complete')return deliveryView(fresh);
      if(deliveryReady(fresh,inline) && fresh.bankDelivery?.sourceHash===run.bankDelivery?.sourceHash && ['pending','failed','held'].includes(fresh.bankDelivery?.status)) {
        const bankDelivery={...fresh.bankDelivery,status:'failed',attempts:(fresh.bankDelivery.attempts || 0)+1,lastAttemptAt:stamp(),lastDeliveryActorId:String(bound.actorId),results:[{status:'failed',reason:'Accepted QuickBooks records are retained. Bank-only delivery could not be confirmed; retry bank delivery.',code:/^BANKING_[A-Z_]+$/.test(error.code || '')?error.code:'BANKING_INSTRUCTION_FAILED'}]};
        const saved=await models().GeneralWriteRuns.findOneAndUpdate({_id:fresh._id,...bound.scope,revision:fresh.revision,status:fresh.status},{$set:{bankDelivery},$inc:{revision:1}},{new:true}).lean();
        if(saved)return deliveryView(saved);
      }
      return {...deliveryView(fresh),status:'waiting',note:'Financial execution changed; pending bank delivery remains durable.'};
    }
  }
  async function status(bound) {
    await authorize({...bound,action:'periods.read'});
    const runs=await models().GeneralWriteRuns.find({...bound.scope,ownerId:bound.ownerId,'bankDelivery.status':{$in:['pending','failed','held']}}).sort({updatedAt:1}).limit(101).maxTimeMS(5000).lean();
    return {count:Math.min(runs.length,100),truncated:runs.length>100,runs:runs.slice(0,100).map(deliveryView),qboCalls:0};
  }
  async function recover(bound,{runId}={}) {
    await authorize({...bound,action:'periods.manage'});
    const runs=runId?[await load(bound,runId)]:await models().GeneralWriteRuns.find({...bound.scope,ownerId:bound.ownerId,'bankDelivery.status':{$in:['pending','failed']}}).sort({updatedAt:1}).limit(10).maxTimeMS(5000).lean();
    const results=[];for(const run of runs)results.push(await deliver(bound,String(run._id),{force:Boolean(runId)}));
    return {results,qboCalls:0,note:'Only accepted bank instruction delivery was retried. Pending events do not change posted balances.'};
  }
  return {deliver,recover,status};
}
module.exports={createBankInstructionService,acceptedSourceHash,proveSource,externalReady};
