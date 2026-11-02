'use strict';
// Read-only outcome reconciliation. This never changes a run, receipt or write authority.
const { canonical }=require('./business-calendar');
const { canonicalQboValue, matchesQboRequest }=require('./qbo-semantic-compare');
function resolve(value,items){
 if(Array.isArray(value))return value.map(v=>resolve(v,items));
 if(value&&typeof value==='object'){
  if(Object.keys(value).length===1&&typeof value.$ref==='string'){
   const item=items[value.$ref];if(item?.outcome!=='saved'||!/^\d{1,30}$/.test(item.qboId||''))throw Error('Unresolved saved reference');return item.qboId;
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v,items)]));
 }
 return value;
}
const sameScope=(a,b)=>['environment','realmId','connectionId','ownerId','actorId'].every(k=>a[k]!=null&&String(a[k])===String(b[k]))&&String(a.agentAuthority?.agentId||'')===String(b.agentAuthority?.agentId||'');
function retiredRemainder(run){
 const r=run.retirement;
 if(run.status!=='needs-correction'||r?.version!==1||r.retainedSavedEffects!==true||r.batchNoDispatch!==true||r.batchNoReceipts!==true||!r.auditId||!r.requestId||!Array.isArray(run.plan?.operations)||!Object.keys(run.items||{}).length)return null;
 if(Object.values(run.items).some(i=>i.outcome!=='saved'&&i.outcome!=='deleted'))return null;
 const pending=run.plan.operations.filter(op=>!run.items[op.ref]);
 if(!pending.length)return null;
 try{return pending.map(op=>({...op,payload:resolve(op.payload,run.items)}));}catch{return null;}
}
function postingPayload(op){
 const payload=structuredClone(op.payload);
 // For a deposit of exact existing payments, PrivateNote is non-posting commentary.
 // Every accounting field (and every other extra field) stays strict. The original
 // note remains in its original immutable plan/history; no note-copy claim is made.
 if(op.op==='create'&&op.entity==='Deposit'&&Array.isArray(payload.Line)&&payload.Line.length&&payload.Line.every(l=>Array.isArray(l.LinkedTxn)&&l.LinkedTxn.length===1&&l.LinkedTxn[0].TxnType==='Payment'&&/^\d{1,30}$/.test(l.LinkedTxn[0].TxnId||''))&&new Set(payload.Line.map(l=>l.LinkedTxn[0].TxnId)).size===payload.Line.length)delete payload.PrivateNote;
 return canonical(canonicalQboValue(payload,{entity:op.entity}));
}
function recoverRetiredRuns(runs,candidates,{truncated=false}={}){
 const recovered=[],pending=[];
 for(const run of runs){
  const remaining=retiredRemainder(run);
  if(!remaining||truncated){pending.push(run);continue;}
  const matches=[],used=new Set();let resolved=true;
  const originalPayments=new Set(Object.values(run.items||{}).filter(i=>i.entity==='Payment'&&i.outcome==='saved').map(i=>i.qboId));
  for(const op of remaining){
   // Only exact create outcomes can discharge a previously unsent create. Edits,
   // deletes and uncertain requests need their existing dedicated recovery.
   if(op.op!=='create'||op.entity!=='Deposit'){resolved=false;break;}
   if(op.entity==='Deposit'&&(!Array.isArray(op.payload?.Line)||!op.payload.Line.length||op.payload.Line.some(l=>l.LinkedTxn?.length!==1||l.LinkedTxn[0].TxnType!=='Payment'||!originalPayments.has(l.LinkedTxn[0].TxnId))||new Set(op.payload.Line.map(l=>l.LinkedTxn[0].TxnId)).size!==op.payload.Line.length)){resolved=false;break;}
   const found=[];
   for(const other of candidates){
    const retiredAt=Date.parse(run.retirement?.at),createdAt=Date.parse(other.createdAt),savedAt=Date.parse(other.updatedAt);
    if(!Number.isFinite(retiredAt)||!Number.isFinite(createdAt)||!Number.isFinite(savedAt)||createdAt<retiredAt||savedAt<createdAt)continue;
    if(String(other._id)===String(run._id)||other.status!=='complete'||!sameScope(run,other)||new Date(other.createdAt)<new Date(run.retirement?.at||run.updatedAt||run.createdAt))continue;
    if(!Array.isArray(other.plan?.operations)||Object.values(other.items||{}).some(i=>!['saved','deleted'].includes(i.outcome)))continue;
    for(const replacement of other.plan.operations){
     if(replacement.op!==op.op||replacement.entity!==op.entity)continue;
     const item=other.items?.[replacement.ref];
     if(item?.outcome!=='saved'||item.entity!==op.entity||!/^\d{1,30}$/.test(item.qboId||'')||item.record?.Id!==item.qboId||!item.request)continue;
     try{
      const payload=resolve(replacement.payload,other.items);
      if(postingPayload(op)!==postingPayload({...replacement,payload}))continue;
      if(canonical(canonicalQboValue(item.request,{entity:op.entity}))!==canonical(canonicalQboValue(payload,{entity:op.entity})))continue;
      if(!matchesQboRequest(item.request,item.record,{entity:op.entity}))continue;
      found.push({operationId:String(other._id),ref:replacement.ref,entity:op.entity,qboId:item.qboId,at:other.updatedAt});
     }catch{/* Incomplete evidence never resolves work. */}
    }
   }
   if(found.length!==1||used.has(found[0].entity+':'+found[0].qboId)){resolved=false;break;}
   used.add(found[0].entity+':'+found[0].qboId);matches.push({...found[0],originalRef:op.ref});
  }
  if(resolved)recovered.push({operationId:String(run._id),state:'recovered',basis:'saved-replacement-records',replacements:matches,errorDetail:run.errorDetail||null,note:'Posting recovered from exact saved replacement records; the original plan and note remain in history.'});
  else pending.push(run);
 }
 return {pending,recovered};
}
module.exports={resolve,retiredRemainder,recoverRetiredRuns};
