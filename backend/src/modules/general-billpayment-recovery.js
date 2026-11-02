'use strict';
// Read-only proof for the sole omitted AP header on a saved CAD cheque payment.
const {hash,canonical}=require('./business-calendar');
const {matchesQboRequest,sameQboValue}=require('./qbo-semantic-compare');
const {creationSourceOf}=require('./general-estimate-recovery');
const {postingsOf,compareLedger}=require('./general-write-postings');
const KIND='saved-billpayment-ap-ledger-proof',proofs=new WeakSet(),QID=/^\d{1,30}$/;
const clone=v=>JSON.parse(JSON.stringify(v));
const check=(ok,message)=>{if(!ok)throw Error(message);};
const one=(Model,filter,session)=>{let q=Model.findOne(filter);if(session)q=q.session(session);return q.maxTimeMS(3000).lean();};
function sourceOf(run,ref,receipt){
  const item=run.items?.[ref],view=item?.outcome==='saved'&&item.originalSavedRecord?{...run,items:{...run.items,[ref]:{...item,outcome:'mismatch',record:item.originalSavedRecord}}}:run;
  const s=creationSourceOf(view,ref,receipt,'BillPayment','mismatch');if(!s||s.original.APAccountRef!==undefined||!QID.test(s.wanted.APAccountRef?.value||'')||s.wanted.PayType!=='Check'||s.original.CurrencyRef?.value!=='CAD'||!QID.test(s.wanted.CheckPayment?.BankAccountRef?.value||'')||s.wanted.APAccountRef.value===s.wanted.CheckPayment.BankAccountRef.value||!Number.isFinite(s.wanted.TotalAmt)||s.wanted.TotalAmt<=0)return null;
  const line=s.wanted.Line;if(!Array.isArray(line)||line.length!==1||line[0].Amount!==s.wanted.TotalAmt||line[0].LinkedTxn?.length!==1||line[0].LinkedTxn[0].TxnType!=='Bill'||!QID.test(line[0].LinkedTxn[0].TxnId||''))return null;
  const {APAccountRef,...rest}=s.wanted;return matchesQboRequest(rest,s.original,{entity:'BillPayment'})?s:null;
}
function exactRows(request,rows){
  const expected=postingsOf('BillPayment',request,{}),comparison=compareLedger(expected,rows||[]);
  return comparison.ok&&Array.isArray(rows)&&rows.length===2&&new Set(rows.map(r=>r.accountId)).size===2&&rows.every(r=>Number.isSafeInteger(r.cents)&&r.cents!==0&&expected.get(r.accountId)===r.cents);
}
function readLedger(report,day,through=day,payments=null){
  const {ledgerEndpoint,parseLedger}=require('./general-write-day-close'),observed=require('./book-evidence').inspectReport('GeneralLedger',report,{fromDate:day,throughDate:through});
  check(observed.scopeMatches&&observed.currency==='CAD'&&observed.status==='populated','A complete CAD accrual General Ledger for the exact payment date is required');
  const parsed=parseLedger(report,day,through),exactDates=payments?new Map(payments.map(p=>[p.Id,p.TxnDate])):null;
  check(parsed.unknown.length===0,'The General Ledger contains an unattributed nonzero posting');
  const columns=report.Columns.Column,typeAt=columns.findIndex(c=>c.ColType==='txn_type'),dateAt=columns.findIndex(c=>c.ColType==='tx_date'),debitAt=columns.findIndex(c=>c.ColType==='debt_amt'),creditAt=columns.findIndex(c=>c.ColType==='credit_amt');
  for(const row of require('./book-evidence').rowsOf(report)){
    if(row.type!=='Data'||!['Bill Payment (Cheque)','Bill Payment (Check)','Bill Payment (Credit Card)'].includes(row.ColData?.[typeAt]?.value))continue;
    const id=row.ColData[typeAt].id;if(exactDates&&!exactDates.has(id))continue;
    check(!exactDates||['Bill Payment (Cheque)','Bill Payment (Check)'].includes(row.ColData[typeAt].value),'A cheque payment has a different ledger transaction type');
    const debit=Number(row.ColData[debitAt].value||0),credit=Number(row.ColData[creditAt].value||0),dated=row.ColData[dateAt].value;
    const exactDate=exactDates?dated===exactDates.get(id):dated>=day&&dated<=through;
    check(exactDate&&debit>=0&&credit>=0&&!(debit&&credit),'A bill-payment ledger row lacks its exact date or single posting side');
  }
  return {endpoint:ledgerEndpoint(day),parsed};
}
function unchanged(source,current){return current?.APAccountRef===undefined&&current.Id===source.original.Id&&current.SyncToken===source.original.SyncToken&&sameQboValue(source.original,current,{entity:'BillPayment'});}
async function assess({models,scope,run,bound,copy,fence,ledgerFor,readersFor=null,now=()=>Date.now()}){
  if((!ledgerFor&&!readersFor)||!copy?.fetch||!models.Authorities||!models.Audits)return null;
  const sources=[];
  for(const [ref,item] of Object.entries(run.items||{})){if(item.entity!=='BillPayment'||item.outcome!=='mismatch')continue;const batch=run.batches.find(b=>b.attempt===item.attempt&&b.items.some(i=>i.ref===ref));if(!batch?.transport?.receiptId)continue;const receipt=await one(models.Receipts,{_id:batch.transport.receiptId,...scope});const s=sourceOf(run,ref,receipt);if(s)sources.push(s);}
  if(!sources.length||sources.length>8)return null;
  const graph=[...new Map(sources.flatMap(s=>[{entity:'BillPayment',id:s.item.qboId},{entity:'Bill',id:s.wanted.Line[0].LinkedTxn[0].TxnId}]).map(r=>[r.entity+':'+r.id,r])).values()];
  const snapshot=await fence.start(scope,run,bound,{graph});if(!snapshot)return null;
  const reader=readersFor?await readersFor(scope,2*sources.length+new Set(sources.map(s=>s.original.TxnDate)).size):null;
  const freshCopy=reader?.copy||copy,readLedgerFor=reader?.ledgerFor||ledgerFor;
  try{
  const first=[];for(const s of sources){const current=await freshCopy.fetch(scope,'BillPayment',s.item.qboId);if(!unchanged(s,current))return null;first.push(current);}
  const reports=new Map();for(const day of new Set(sources.map(s=>s.original.TxnDate))){const report=await readLedgerFor(scope,day);readLedger(report,day,day,sources.filter(s=>s.original.TxnDate===day).map(s=>s.original));reports.set(day,report);}
  const second=[];for(const s of sources){const current=await freshCopy.fetch(scope,'BillPayment',s.item.qboId);if(!unchanged(s,current))return null;second.push(current);}
  if(canonical(first)!==canonical(second))return null;
  const entries=sources.map((s,i)=>({ref:s.ref,paymentId:s.item.qboId,receiptId:s.receiptId,requestHash:s.requestHash,originalRecordHash:hash(s.original),paymentHash:hash(second[i]),record:second[i],day:s.original.TxnDate,apAccountId:s.wanted.APAccountRef.value,bankAccountId:s.wanted.CheckPayment.BankAccountRef.value}));
  for(const [i,s] of sources.entries())if(!exactRows(s.wanted,readLedger(reports.get(s.original.TxnDate),s.original.TxnDate,s.original.TxnDate,[s.original]).parsed.byRecord['BillPayment:'+s.item.qboId]))return null;
  const payload={version:1,kind:KIND,scope,operationId:String(run._id),ownerId:String(run.ownerId),actorId:String(run.actorId),agentAuthorityHash:hash(run.agentAuthority||null),payments:entries,reports:[...reports].map(([day,report])=>({day,endpoint:require('./general-write-day-close').ledgerEndpoint(day),reportHash:hash(report),report})),observedAt:new Date(now()).toISOString()},contentHash=hash(payload),authorityId=contentHash.slice(0,24),auditId=hash({authorityId,contentHash}).slice(0,24),items={};
  check(Buffer.byteLength(canonical(payload))<8000000,'Saved payment proof exceeds its evidence budget');
  for(const [i,s] of sources.entries()){const {next,errorDetail,...saved}=s.item;items[s.ref]={...saved,outcome:'saved',complete:true,originalSavedRecord:s.original,record:second[i],version:second[i].SyncToken,reconciliation:{version:1,kind:KIND,authorityId,authorityHash:contentHash,ref:s.ref,paymentId:s.item.qboId,receiptId:s.receiptId,requestHash:s.requestHash,paymentHash:hash(second[i])}};}
  return {snapshot,items,sources,payload,authorityId,contentHash,auditId};
  }finally{reader?.close();}
}
async function commit({assessment:a,models,scope,run,session}){
  for(const s of a.sources){const receipt=await one(models.Receipts,{_id:s.receiptId,...scope},session),fresh=sourceOf(run,s.ref,receipt);check(fresh&&fresh.requestHash===s.requestHash&&hash(fresh.original)===hash(s.original),'Original payment source changed');}
  await models.Authorities.create([{_id:a.authorityId,contractVersion:1,...scope,contentHash:a.contentHash,payload:a.payload,actorId:String(run.actorId),auditId:a.auditId}],{session});
  await models.Audits.create([{_id:a.auditId,userId:run.ownerId,...(String(run.actorId)!==String(run.ownerId)?{actorUserId:run.actorId}:{}),realmId:scope.realmId,action:'Verified saved bill payments against General Ledger',actionType:'ai_executed',aiDriven:true,tool:'verification',outcome:'success',afterState:{operationId:String(run._id),authorityHash:a.contentHash,paymentIds:a.sources.map(s=>s.item.qboId)}}],{session});
}
async function loadProof({models,scope,run,ref,receipt,current,session=null}){
  const item=run.items?.[ref],r=item?.reconciliation;if(r?.kind!==KIND||!models.Authorities?.findOne||!receipt||!current)return null;
  const s=sourceOf(run,ref,receipt);if(!s)return null;
  const a=await one(models.Authorities,{_id:r.authorityId,...scope},session),p=a?.payload;
  if(!a||a.contentHash!==r.authorityHash||a.contentHash!==hash(p)||p.kind!==KIND||p.operationId!==String(run._id)||p.ownerId!==String(run.ownerId)||p.actorId!==String(run.actorId)||String(a.actorId)!==String(run.actorId)||p.agentAuthorityHash!==hash(run.agentAuthority||null)||['environment','realmId','connectionId'].some(k=>String(p.scope?.[k])!==String(scope[k])))return null;
  const entries=p.payments.filter(e=>e.ref===ref&&e.paymentId===item.qboId);if(entries.length!==1)return null;const e=entries[0];
  if(e.receiptId!==s.receiptId||e.requestHash!==s.requestHash||e.originalRecordHash!==hash(s.original)||e.paymentHash!==hash(current)||r.paymentHash!==e.paymentHash||hash(item.record)!==e.paymentHash||!unchanged(s,current)||e.apAccountId!==s.wanted.APAccountRef.value||e.bankAccountId!==s.wanted.CheckPayment.BankAccountRef.value||e.day!==s.original.TxnDate)return null;
  const reports=p.reports.filter(r=>r.day===e.day);if(reports.length!==1||reports[0].reportHash!==hash(reports[0].report)||reports[0].endpoint!==require('./general-write-day-close').ledgerEndpoint(e.day)||!exactRows(s.wanted,readLedger(reports[0].report,e.day,e.day,[current]).parsed.byRecord['BillPayment:'+e.paymentId]))return null;
  const proof=Object.freeze({operationId:String(run._id),ref,paymentId:e.paymentId,paymentHash:e.paymentHash,apAccountId:e.apAccountId,authorityId:String(a._id),authorityHash:a.contentHash});proofs.add(proof);return proof;
}
function accountingView(record,proof){return proof&&proofs.has(proof)&&record?.Id===proof.paymentId&&hash(record)===proof.paymentHash&&record.APAccountRef===undefined?{...record,APAccountRef:{value:proof.apAccountId}}:null;}
// Replay capture serializes plain data. Reload durable authority after that boundary
// instead of trusting a serialized capability or weakening the pure comparison.
async function resolveProof({models,scope,proof,current}){
  if(accountingView(current,proof))return proof;
  if(!models.GeneralWriteRuns?.findOne||!models.Receipts?.findOne||!proof?.operationId||!proof.ref)return null;
  const run=await one(models.GeneralWriteRuns,{_id:proof.operationId,...scope});
  const item=run?.items?.[proof.ref];if(!item||item.qboId!==current?.Id||item.reconciliation?.authorityId!==proof.authorityId||item.reconciliation?.authorityHash!==proof.authorityHash)return null;
  const receipt=await one(models.Receipts,{_id:item.reconciliation.receiptId,...scope});
  return loadProof({models,scope,run,ref:proof.ref,receipt,current});
}
function createBoundedReader({access,scope,maxAttempts}){
  check(access&&Number.isSafeInteger(maxAttempts)&&maxAttempts>0&&maxAttempts<=24,'Exact saved-payment read authority is required');
  const controller=new AbortController(),deadline=Date.now()+55000,timer=setTimeout(()=>controller.abort(),55000);timer.unref?.();let attempts=0;
  const read=async(endpoint,permission)=>{
    const client=await access.resolveClient(scope);
    return client.apiCall('GET',endpoint,undefined,0,0,{signal:controller.signal,beforeAttempt:async()=>{
      check(!controller.signal.aborted&&Date.now()<deadline,'Saved-payment verification deadline reached');
      check(attempts<maxAttempts,'Saved-payment verification attempt budget reached');attempts++;
      await access.authorize(scope,permission);
    },onFailure:()=>{}});
  };
  return {copy:{fetch:async(_scope,entity,id)=>{check(entity==='BillPayment'&&QID.test(id),'Exact bill-payment read required');return (await read('billpayment/'+id,'operations.read'))?.BillPayment||null;}},ledgerFor:async(_scope,day)=>read(require('./general-write-day-close').ledgerEndpoint(day),'reports.observe'),close:()=>{clearTimeout(timer);controller.abort();}};
}
module.exports={KIND,sourceOf,assess,commit,loadProof,resolveProof,accountingView,exactRows,createBoundedReader,validateLedgerForPayments:readLedger};
