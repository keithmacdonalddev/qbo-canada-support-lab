'use strict';
// Diagnostics never confer write/retry authority. Only explicitly supplied business detail is retained.
const { createHash } = require('node:crypto');
const { redact, scrubText } = require('./business-agent-transcript');
const MAX_BYTES = 6144, STUCK_MS = 15 * 60000;
const text = (value, max = 600) => scrubText(String(value ?? '')).slice(0, max);
function bounded(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return text(value, 300);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value || typeof value !== 'object') return null;
  if (depth > 5 || seen.has(value)) return '[bounded]';
  seen.add(value);
  return Array.isArray(value) ? value.slice(0, 20).map(v => bounded(v, depth + 1, seen)) :
    Object.fromEntries(Object.entries(value).slice(0, 30).filter(([k]) => !['__proto__','constructor','prototype','stack','request','response','headers','config','body','record','payload'].includes(k)).map(([k,v]) => [text(k,80), bounded(v, depth + 1, seen)]));
}
function checkFrom(error) {
  const frame = String(error?.stack || '').split('\n').slice(1).find(line => /backend[\\/]src[\\/]/.test(line) && !/business-error-detail\.js/.test(line) && !/at (?:fail|invalid|denied) /.test(line)) 
    || String(error?.stack || '').split('\n').slice(1).find(line => /backend[\\/]src[\\/]/.test(line) && !/business-error-detail\.js/.test(line)) || '';
  const match = /at (?:(.*?) \()?((?:[A-Za-z]:)?[^()\n]*?\.js):(\d+):\d+\)?$/.exec(frame.trim());
  const file = match ? match[2].replace(/\\/g,'/').replace(/^.*?(backend\/src\/)/,'$1') : null;
  return { module: file ? file.split('/').at(-1).replace(/\.js$/,'') : 'business', function: text(match?.[1] || 'unknown',100), file, line: match ? Number(match[3]) : null };
}
function businessErrorDetail(error, context = {}) {
  const existing = error?.errorDetail?.version === 1 ? error.errorDetail : error?.version === 1 && error.check ? error : null;
  const source = existing || error;
  const code = /^[A-Z][A-Z0-9_]{2,99}$/.test(source?.code || '') ? source.code : 'BUSINESS_OPERATION_FAILED';
  const known = /^(BUSINESS_|GENERAL_(?:WRITE_|DAY_CLOSE_)|QBO_|AI_|CODEX_)/.test(source?.code || '');
  let detail = bounded(redact(existing?.detail || { ...(context.detail || {}), ...(error?.businessDetail || {}), ...((error?.referenceDiagnostic || error?.diagnostic?.reference) ? { reference: error.referenceDiagnostic || error.diagnostic.reference } : {}) }));
  if (Buffer.byteLength(JSON.stringify(detail)) > 3500) detail = { truncated: true, note: 'Diagnostic detail exceeded its retained budget.' };
  const check = { ...checkFrom(error), ...(existing?.check || context.check || error?.businessCheck || {}) };
  const result = { version:1, code, message:known ? text(source?.message || source?.error || context.message || 'Business work needs attention.') : 'Business work could not finish. Saved progress is retained.',
    check:{module:text(check.module || 'business',100),function:text(check.function || 'unknown',100),file:check.file ? text(check.file,180).replace(/^.*?(backend[\\/]src[\\/])/,'$1') : null,line:Number.isSafeInteger(check.line) && check.line > 0 ? check.line : null},
    operationId:text(existing?.operationId || context.operationId || error?.operationId || '',64) || null,
    logicalKey:text(existing?.logicalKey || context.logicalKey || error?.logicalKey || '',100) || null,
    entity:text(existing?.entity || context.entity || error?.entity || error?.businessDetail?.entity || '',40) || null,
    recordId:text(existing?.recordId || context.recordId || error?.recordId || error?.businessDetail?.recordId || '',64) || null, detail };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) result.detail={truncated:true};
  return existing && JSON.stringify(existing) === JSON.stringify(result) ? existing : result;
}
function attachBusinessError(error, context = {}) { error.errorDetail = businessErrorDetail(error, context); return error; }
const fingerprint = detail => createHash('sha256').update(JSON.stringify([detail.code, detail.message, detail.check, detail.entity, detail.recordId, detail.logicalKey, detail.detail])).digest('hex');
function failureFields(previous, error, context = {}, now = Date.now()) {
  const errorDetail = businessErrorDetail(error, context), key = fingerprint(errorDetail), stamp = new Date(now).toISOString();
  const history = (previous?.errorHistory || []).slice(-19), old = history.find(row => row.key === key);
  const occurrenceId = context.occurrenceId || previous?.executionRequest?.id || null;
  const repeatedBoundary = occurrenceId && old?.occurrenceId === occurrenceId;
  const group = { key, errorDetail, ...(occurrenceId ? { occurrenceId } : {}), count:Math.min(Number.MAX_SAFE_INTEGER,(old?.count || 0)+(repeatedBoundary ? 0 : 1)), firstAt:old?.firstAt || stamp, lastAt:stamp };
  return { errorDetail, errorHistory:[...history.filter(row => row.key !== key),group] };
}
function definitionDifferences(approved, current, prefix = '', out = []) {
  for (const key of new Set([...Object.keys(approved || {}), ...Object.keys(current || {})])) {
    if (out.length >= 20) break;
    const safeA=redact(approved),safeB=redact(current);
    const a=safeA?.[key], b=safeB?.[key], field=prefix+key;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) definitionDifferences(a,b,field+'.',out);
    else out.push({ field, approved:a ?? null, current:b ?? null });
  }
  return bounded(redact(out));
}
function generalAttention(row){
  const entries=Object.entries(row.items||{}),saved=entries.filter(([,item])=>item.outcome==='saved'&&item.qboId),mismatches=entries.filter(([,item])=>item.outcome==='mismatch'&&item.qboId);
  const remaining=require('./general-write-resolution').retiredRemainder(row);
  if(remaining){
    const payments=saved.filter(([,item])=>item.entity==='Payment');
    const depositOnly=remaining.every(op=>op.op==='create'&&op.entity==='Deposit');
    const summary=depositOnly&&payments.length?payments.length+' customer payment'+(payments.length===1?' is':'s are')+' already saved. The remaining bank deposit was not sent and needs a fresh plan.':saved.length+' records are already saved. '+remaining.length+' remaining actions were not sent and need a fresh plan.';
    return {summary,recovery:{state:'replan-remaining',agentId:row.agentAuthority?.agentId||null,ownerId:String(row.ownerId||''),operationId:String(row._id),saved:saved.map(([,i])=>({entity:i.entity,qboId:i.qboId})),remaining:remaining.map(op=>({ref:op.ref,entity:op.entity,op:op.op})),next:'Keep the saved records. The accountant must recheck current evidence and prepare only the unsent work with a new decision identifier.'}};
  }
  if(mismatches.length){
    const differences=[],native=mismatches.map(([,item])=>item.next?.recovery).filter(packet=>packet?.kind==='saved-invoice-estimate-recovery');
    for(const [ref,item]of mismatches){
      const compare=require('./qbo-semantic-compare').matchesQboRequest;
      for(const [key,value]of Object.entries(item.request||{}))if(!compare({[key]:value},item.record||{},{entity:item.entity}))differences.push({entity:item.entity,qboId:item.qboId,ref,field:key,reason:Object.hasOwn(item.record||{},key)?'Saved values differ from the request.':'The requested field was not returned.'});
    }
    return {summary:native.length===mismatches.length?native.length+' invoices are saved, but their estimate conversions are unfinished. The accountant needs a native QuickBooks repair; the saved invoices must be kept.':mismatches.length+' records were saved in QuickBooks, but their verification needs attention. Check those existing records; do not recreate them.',recovery:{state:native.length?'native-repair-required':'check-saved',operationId:String(row._id),saved:mismatches.map(([,i])=>({entity:i.entity,qboId:i.qboId})),differences:differences.slice(0,20),...(native.length?{native}:{}),next:native.length?'Finish the exact estimate links on the existing invoices through the native QuickBooks workflow. Automatic native execution for these records is not installed. A repeated API conversion cannot repair them; retain this recovery task and continue independent business work.':'Inspect the saved record differences and retain the existing QuickBooks identities before any further action.'}};
  }
  return {};
}
const stamp = value => { const n=new Date(value || 0).getTime(); return Number.isFinite(n) ? n : 0; };
function savedDayRefusal(row) {
  const error = row.errorDetail;
  return row.status !== 'unknown' && error?.detail?.qboStage === 'write_admission' && error.detail.outcomeUnknown === false && (error.code === 'GENERAL_WRITE_DAY_CHANGED' || error.code === 'QBO_WRITE_ADMISSION_DENIED' && error.message === 'The business day changed since this general write was prepared. Nothing was sent.');
}
function collectBusinessBlockers({runs=[],steps=[],generalRuns=[],now=Date.now()} = {}) {
  const groups=new Map();
  const add=(row,kind)=>{
    const terminal=kind==='step'?row.state==='verified':kind==='general'?['complete','expired-unsent'].includes(row.status):['verified','retired','stopped','previewed'].includes(row.status);
    if(terminal)return;
    if(kind==='general' && savedDayRefusal(row))return;
    const history=row.errorHistory || [], last=history.at(-1), saved=row.errorDetail || row.verification?.errorDetail || row.executionRequest?.result?.errorDetail;
    const blocked=Boolean(saved || ['blocked','needs-check','rejected','unknown','held','needs-correction'].includes(row.state || row.status));
    const since=stamp(last?.firstAt || row.progressAt || row.dispatch?.at || row.createdAt || row.updatedAt);
    if(!blocked && (!since || now-since<=STUCK_MS))return;
    const errorDetail=saved ? businessErrorDetail(saved) : businessErrorDetail({code:'BUSINESS_PROGRESS_STALLED',message:row.lastError || 'Business work has not progressed for more than fifteen minutes.'},{operationId:String(row.operationId || row._id),logicalKey:row.logicalKey,entity:row.entity,recordId:row.qboId,check:{module:'business-error-detail',function:'collectBusinessBlockers',file:'backend/src/modules/business-error-detail.js',line:null},detail:{state:row.state || row.status,nextOrdinal:row.nextOrdinal ?? null}});
    const key=fingerprint(errorDetail), prior=groups.get(key), count=last?.count || 1, overdue=Boolean(since && now-since>STUCK_MS);
    if(prior){prior.count+=count;prior.overdue ||= overdue;prior.firstAt=new Date(Math.min(stamp(prior.firstAt),since || now)).toISOString();prior.lastAt=new Date(Math.max(stamp(prior.lastAt),stamp(last?.lastAt)||since||now)).toISOString();prior.sources.push({kind,id:String(row._id)});return;}
    groups.set(key,{key,errorDetail,...(kind==='general'?generalAttention(row):{}),count,firstAt:new Date(since || now).toISOString(),lastAt:last?.lastAt || new Date(since || now).toISOString(),overdue,state:row.state || row.status,sources:[{kind,id:String(row._id)}]});
  };
  const stepKeys=new Set(steps.filter(row=>row.state!=='verified'&&row.errorDetail).map(row=>String(row.operationId)+':'+fingerprint(row.errorDetail)));
  for(const row of runs)if(!row.errorDetail || !stepKeys.has(String(row._id)+':'+fingerprint(row.errorDetail)))add(row,'operation');
  for(const row of steps)add(row,'step');
  for(const row of generalRuns)add(row,'general');
  return [...groups.values()].sort((a,b)=>Number(b.overdue)-Number(a.overdue)||a.firstAt.localeCompare(b.firstAt));
}
// Review health and amount evidence are attention items, not new write authority.
function agentBlockers(row,now=Date.now()) {
  if(!row?.settings?.monitoring)return [];
  const out=[],add=(code,message,since,detail={})=>{
    const errorDetail=businessErrorDetail({code,message,businessDetail:detail});
    out.push({key:fingerprint(errorDetail),errorDetail,count:1,firstAt:new Date(since||now).toISOString(),lastAt:new Date(now).toISOString(),overdue:now-(since||now)>STUCK_MS,state:'needs-check',sources:[{kind:'accountant',id:String(row._id)}]});
  };
  const start=stamp(row.reviewProgress?.startedAt||row.activePass?.startedAt);
  const expired=row.leaseToken&&stamp(row.leaseExpiresAt)<=now;
  if(row.status==='reviewing'&&(expired||!row.leaseToken&&start&&now-start>120000))
    add('BUSINESS_REVIEW_ORPHANED','The accountant review has no live lease heartbeat. The watchdog will release it and schedule another review.',start,{attemptId:row.reviewProgress?.attemptId||null});
  else if(row.errorDetail?.code==='BUSINESS_REVIEW_INTERRUPTED')
    add(row.errorDetail.code,row.errorDetail.message,stamp(row.errorDetail.detail?.recoveredAt),row.errorDetail.detail);
  for(const source of row.syncView?.sources||[]){
    if(source.status==='current'&&source.reconcileError)
      add('BUSINESS_COUNT_RECONCILIATION_UNVERIFIED','The nightly '+source.entity+' count comparison could not be verified. Current source data remains available; the comparison needs follow-up.',stamp(source.lastSuccessAt),{entity:source.entity});
  }
  const proof=row.syncView?.amountReconciliation;
  for(const [key,check] of Object.entries(proof?.checks||{})){
    if(!['unverified','error','mismatched','resyncing'].includes(check.status))continue;
    add('BUSINESS_AMOUNT_RECONCILIATION_'+check.status.toUpperCase(),
      check.status==='unverified'||check.status==='error'?'The nightly '+key+' amount comparison is unverified. Current source data and independent governed writes remain available; this needs a follow-up check.':'The nightly '+key+' amount comparison found a difference. Its affected source remains held while the evidence is checked.',
      stamp(check.checkedAt||proof.startedAt),{entity:check.entity,status:check.status,day:proof.day,qboCents:check.qboCents??null,knownCents:check.knownCents??null,mirrorCents:check.mirrorCents??null,differenceCents:check.differenceCents??null});
  }
  return out;
}
async function businessBlockersFor({models,scope,now=Date.now()}) {
  const { scoped }=require('./qbo-write-contract'); scope=scoped(scope);
  async function rows(Model,filter,fields){return Model?.find ? Model.find({...scope,...filter}).select(fields).sort({_id:1}).limit(201).maxTimeMS(3000).lean() : [];}
  const [runs,generalRuns,agents]=await Promise.all([
    rows(models?.Runs,{status:{$nin:['verified','retired','stopped','previewed']}},'_id status nextOrdinal errorDetail errorHistory progressAt createdAt updatedAt executionRequest'),
    rows(models?.GeneralWriteRuns,{status:{$nin:['complete','expired-unsent']}},'_id environment realmId connectionId ownerId actorId agentAuthority status errorDetail errorHistory progressAt createdAt updatedAt lastError retirement plan items'),
    rows(models?.Agents,{},'_id settings.monitoring status leaseToken leaseExpiresAt activePass reviewProgress errorDetail syncView.amountReconciliation syncView.sources'),
  ]);
  const retired=generalRuns.filter(row=>require('./general-write-resolution').retiredRemainder(row));
  const candidates=retired.length&&models?.GeneralWriteRuns?.find?await models.GeneralWriteRuns.find({...scope,status:'complete',ownerId:{$in:retired.map(r=>r.ownerId)},createdAt:{$gte:new Date(Math.min(...retired.map(r=>stamp(r.createdAt))))},'plan.operations.entity':{$in:[...new Set(retired.flatMap(r=>r.plan.operations.map(op=>op.entity)))]}}).select('_id environment realmId connectionId ownerId actorId agentAuthority status createdAt updatedAt plan items').sort({createdAt:-1}).limit(201).maxTimeMS(3000).lean():[];
  const recovery=require('./general-write-resolution').recoverRetiredRuns(generalRuns,candidates,{truncated:generalRuns.length>200||candidates.length>200});
  // Only the newest attempt for each period is current; a later passing proof
  // clears its failure without erasing historical evidence.
  const closes = models?.GeneralDayCloses?.find ? await models.GeneralDayCloses.find({ ...scope, kind: 'period' }).select('_id fromDate throughDate ok errorDetail verifiedAt failures').sort({ verifiedAt: -1, _id: -1 }).limit(201).maxTimeMS(3000).lean() : [];
  const periods = new Map(), closeRuns = [];
  for (const close of closes) {
    const period = close.fromDate + ':' + close.throughDate;
    if (!periods.has(period)) periods.set(period, []);
    periods.get(period).push(close);
  }
  for (const attempts of periods.values()) {
    const latest = attempts[0];
    if (latest.ok || !latest.errorDetail) continue;
    const errorDetail = businessErrorDetail(latest.errorDetail), key = fingerprint(errorDetail);
    const same = [];
    for (const attempt of attempts) {
      if (attempt.ok) break;
      if (attempt.errorDetail && fingerprint(businessErrorDetail(attempt.errorDetail)) === key) same.push(attempt);
    }
    closeRuns.push({ _id: latest._id, status: 'blocked', errorDetail, createdAt: same.at(-1).verifiedAt,
      errorHistory: [{ key, errorDetail, count: same.length, firstAt: new Date(same.at(-1).verifiedAt).toISOString(), lastAt: new Date(latest.verifiedAt).toISOString() }] });
  }
  const steps=await rows(models?.Steps,{$or:[{operationId:{$in:runs.map(row=>row._id)},state:{$ne:'verified'}},{state:{$in:['dispatched','unknown']}}]},'_id operationId logicalKey entity qboId state errorDetail errorHistory progressAt createdAt updatedAt verification dispatch.at');
  return {blockers:[...collectBusinessBlockers({runs:[...runs.slice(0,200), ...closeRuns],steps:steps.slice(0,200),generalRuns:recovery.pending.slice(0,200),now}),...agents.flatMap(row=>agentBlockers(row,now))],recovered:recovery.recovered,complete:[models?.Runs,models?.Steps,models?.GeneralWriteRuns,models?.Agents,models?.GeneralDayCloses].every(Model=>typeof Model?.find==='function'),truncated:[runs,steps,generalRuns,candidates,closes].some(rows=>rows.length>200)};
}
function blockerWork(blocker) { return {key:'business-blocker-'+blocker.key,owner:'accountant',state:'blocked',title:blocker.overdue?'Business work has been stuck for over fifteen minutes':'Business work needs attention',detail:blocker.summary||blocker.errorDetail.message,next:blocker.recovery?.next||'Inspect the failed check and continue independent work.',errorDetail:blocker.errorDetail,count:blocker.count,firstAt:blocker.firstAt,lastAt:blocker.lastAt,href:'/company/live'}; }
function blockerBuild(blocker) {return {key:'business-blocker-'+blocker.key,kind:'capability-request',priority:'high',requirement:'R11',status:'open',title:'Fix blocked business work',missing:blocker.errorDetail.message,feature:'Business execution diagnostics',why:'Saved business work has not progressed for over fifteen minutes.',errorDetail:blocker.errorDetail,count:blocker.count,firstAt:blocker.firstAt,lastAt:blocker.lastAt,at:blocker.lastAt};}
async function escalateBusinessBlockers({store,row,scope,now=Date.now()}) {
  const view=await businessBlockersFor({models:store.models,scope,now});
  for(const blocker of view.blockers.filter(value=>value.overdue)){
    for(const kind of ['attention','capability-request']){
      const { kind: _kind, ...build }=blockerBuild(blocker);
      const data={...build,href:'/company/live'}, key='stuck:'+blocker.key;
      const event=await store.event(row,kind,kind==='attention'?'Business work has been stuck for over fifteen minutes':data.title,blocker.errorDetail.message,data,null,key,'accountant');
      if(store.models?.Events?.updateOne)await store.models.Events.updateOne({_id:event.id,agentId:String(row._id),...scope},{$set:{data,detail:blocker.errorDetail.message}});
    }
  }
  // Resolve only diagnostic build items from a complete current read. Append a
  // review event; the original failure, request and operation remain unchanged.
  if(view.complete&&!view.truncated&&typeof store.capabilityRequests==='function'){
    const current=new Set(view.blockers.map(b=>'business-blocker-'+b.key));
    const requests=require('./business-capability-review').fold(await store.capabilityRequests(row));
    for(const request of requests.filter(r=>r.errorDetail&&r.key==='business-blocker-'+fingerprint(r.errorDetail)&&r.status==='resolved'&&current.has(r.key))){
      const blocker=view.blockers.find(b=>'business-blocker-'+b.key===request.key);
      await store.event(row,'capability-review','Business blocker returned',blocker.errorDetail.message,{key:request.key,status:'reopened',evidence:['The same diagnostic is present in the current complete scoped read.'],errorDetail:blocker.errorDetail,firstAt:blocker.firstAt,lastAt:blocker.lastAt},null,'diagnostic-reopened:'+request.key+':'+String(request.history?.at(-1)?.id||request.at)+':'+blocker.lastAt,'accountant');
    }
    for(const request of requests.filter(r=>r.errorDetail&&r.key==='business-blocker-'+fingerprint(r.errorDetail)&&r.status!=='resolved'&&!current.has(r.key))){
      await store.event(row,'capability-review','Earlier business blocker resolved','Current scoped diagnostics no longer report this blocker. Original failures remain in history.',{key:request.key,status:'resolved',evidence:['Complete scoped diagnostic read',...view.recovered.map(r=>'Saved replacement for '+r.operationId)],reviewedAt:new Date(now).toISOString()},null,'diagnostic-resolved:'+request.key+':'+String(request.at||''),'accountant');
    }
  }
  return view;
}
module.exports={businessErrorDetail,attachBusinessError,failureFields,definitionDifferences,fingerprint,collectBusinessBlockers,generalAttention,agentBlockers,businessBlockersFor,blockerWork,blockerBuild,escalateBusinessBlockers,MAX_BYTES,STUCK_MS};
