'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
// Codes that may involve re-entering the password or a person's verification keep the
// slow, capped retry (repeated password attempts could lock the Intuit account).
const NEEDS_PERSON=new Set(['QBO_VERIFICATION_REQUIRED','QBO_CREDENTIAL_MISSING','QBO_IDENTITY_UNVERIFIED','QBO_SIGNIN_REQUIRED']);
function currentPackages(rows){const map=new Map();for(const p of rows){const key=p.accountId+':'+p.period;if(!map.has(key)||p.revision>map.get(key).revision)map.set(key,p);}return [...map.values()].sort((a,b)=>a.period.localeCompare(b.period)||a.accountId.localeCompare(b.accountId,undefined,{numeric:true}));}
// A monthly statement is reconciled, then attached. Its lines reach QuickBooks
// through the daily current-feed uploads, so the month's CSV is not uploaded
// again (that would put every line into For Review twice).
function nextStep(pkg,status){
  const runs=status.steps || [];
  // A month whose own CSV was already imported still has its rows reviewed first.
  if(pkg.evidence.imports.some(i=>i.status==='uploaded')){const row=pkg.snapshot.rows.find(r=>!['matched','added','excluded'].some(k=>pkg.evidence.rows[r.rowId]?.[k]));if(row)return {type:'review',rowId:row.rowId};}
  if(!runs.some(r=>r.step.type==='reconcile' && r.status==='completed'))return {type:'reconcile'};
  return {type:'attach'};
}
// One month worth working per account: the month after the latest one already
// reconciled in the app; for an account with none, its latest statement (its
// first QuickBooks reconciliation covers everything before it). Older history
// never blocks current months.
function workablePackages(packages){
  const byAccount=new Map();
  for(const p of currentPackages(packages)){if(!byAccount.has(p.accountId))byAccount.set(p.accountId,[]);byAccount.get(p.accountId).push(p);}
  const out=[];
  for(const list of byAccount.values()){
    const done=list.filter(p=>p.summary.reconciled).map(p=>p.period).sort().at(-1);
    const open=list.filter(p=>!p.summary.reconciled);
    // QuickBooks reconciles in date order: after a reconciled month, the next one.
    const next=done?open.filter(p=>p.period>done)[0]:open.at(-1);
    if(next)out.push(next);
  }
  return out;
}
// Explicit lifecycle, no import-time timers. One tick executes one step of the
// newest workable account-month; the next tick re-reads current controls and durable state.
function createBankingOperatorLoop({workspace,operator,listUsers,enabled=()=>false,isTerraBusy,pauseStore,stateStore=null,readSignInStatus=()=>require('./qbo-browser-session').createSessionStore().read(),now=()=>new Date().toISOString(),intervalMs=60000,setTimer=setInterval,clearTimer=clearInterval}){
  if(!workspace || !operator || typeof listUsers!=='function' || !isTerraBusy || !pauseStore)throw new TypeError('Banking loop needs scoped adapters, global lock inspection and durable pause storage');
  let timer=null,pending=null,closed=false,last={status:'disabled'};const localPauses=new Map();
  let heartbeat={lastTickAt:null,lastRunAt:null,lastOutcome:null},signInRetry=null,stateLoaded=false;
  async function publish(value){last=value;heartbeat.lastOutcome=value;await stateStore?.write({...heartbeat,...value,signInRetry});return value;}
  async function tick(){
    heartbeat.lastTickAt=now();
    if(pending){try{await stateStore?.write({...heartbeat,...last,signInRetry});}catch{/* The owning tick persists its final outcome. */}return pending;}
    pending=(async()=>{
      if(!stateLoaded){const previous=await stateStore?.read();heartbeat.lastRunAt=previous?.lastRunAt || null;signInRetry=previous?.signInRetry || null;stateLoaded=true;}
      await stateStore?.write({...heartbeat,status:'checking',signInRetry});
      if(closed || !enabled())return last={status:'disabled'};
      // A stop pauses only its own account; other accounts keep working.
      const stored=pauseStore.list?await pauseStore.list():[await pauseStore.read()].filter(Boolean);
      const pauses=[...stored,...[...localPauses.values()].filter(l=>!stored.some(p=>p.accountId===l.accountId))];
      const open=[];let resolvedNow=null;
      for(const paused of pauses){
        let resolved=false;
        if(operator.resolvePause && pauseStore.clear && !localPauses.has(paused.accountId)){
          for(const user of await listUsers()){
            const list=await workspace.list(user);
            if(!list.packages.some(p=>p.id===paused.packageId))continue;
            try{const recovery=await operator.resolvePause(user,{packageId:paused.packageId,pause:paused,automatic:true,clearPause:value=>pauseStore.clear(value)});resolved=recovery.resolved===true;if(resolved)resolvedNow=recovery;else paused.automaticRetry=recovery.automaticRetry;}
            catch(error){paused.recoveryReason=error.message;}
            break;
          }
        }
        if(!resolved)open.push(paused);
      }
      // A resolved stop is reported on its own tick; the next tick re-reads everything.
      if(resolvedNow)return last={status:'resolved',...resolvedNow};
      if(open.some(p=>!p.accountId))return last={status:'blocked',...open.find(p=>!p.accountId)};
      const pausedAccounts=new Set(open.map(p=>p.accountId));
      // Authentication is not a native banking outcome and must not create an
      // unresumable package pause. Persist bounded retry state separately.
      if(signInRetry){
        let fresh=null;try{fresh=await readSignInStatus();}catch{/* Only a fresh success may reset retry history. */}
        if(fresh?.status==='ready' && fresh.identityVerified===true && fresh.companyVerified===true && Date.parse(fresh.at)>Date.parse(signInRetry.failedAt))signInRetry=null;
        else if(signInRetry.attempts>=3 && NEEDS_PERSON.has(signInRetry.code) || Date.parse(now())<Date.parse(signInRetry.nextRetryAt))return last={status:'blocked',requiresSignIn:true,reason:signInRetry.reason,code:signInRetry.code,signInRetry};
      }
      let selected=null;
      for(const user of await listUsers()){
        const list=await workspace.list(user);if(list.truncated)throw new Error('Complete banking package inventory required');
        for(const p of workablePackages(list.packages).filter(p=>!pausedAccounts.has(p.accountId))){
          if(!selected || p.period>selected.pkg.period || p.period===selected.pkg.period && p.accountId.localeCompare(selected.pkg.accountId,undefined,{numeric:true})<0)selected={user,pkg:p}; // newest month first
        }
      }
      if(!selected)return last=open.length?{status:'blocked',...open[0],pausedAccounts:[...pausedAccounts]}:{status:'idle'};
      const {user}=selected,pkg=await workspace.detail(user,selected.pkg.id);
      const initialStatus=await operator.status(user,pkg.id);
      const priorStarted=initialStatus.steps?.map(r=>r.startedAt).filter(v=>Number.isFinite(Date.parse(v))).sort().at(-1);
      if(priorStarted && (!heartbeat.lastRunAt || Date.parse(priorStarted)>Date.parse(heartbeat.lastRunAt)))heartbeat.lastRunAt=priorStarted;
      const stopped=initialStatus.reasons?.find(r=>r.nativeStatus==='stopped');
      if(stopped)throw Object.assign(new Error(stopped.reason),{packageId:pkg.id,accountId:pkg.accountId});
      if(await isTerraBusy())return last={status:'waiting',reason:'Another Terra run holds the shared lock'};
      try{await operator.recover?.(user,pkg.id);}catch(error){if(error.code==='BANKING_OPERATOR_BUSY')return last={status:'waiting',reason:error.message};throw error;}
      const status=await operator.status(user,pkg.id);
      if(status.blocked || pkg.summary.needsReview || pkg.evidence.supersededBy || pkg.snapshot.blockers.length || pkg.evidence.imports.some(i=>['started','interrupted'].includes(i.status)))throw Object.assign(new Error(status.reasons?.[0]?.reason || pkg.snapshot.blockers.join('; ') || 'Banking history/import requires inspection'),{packageId:pkg.id,accountId:pkg.accountId});
      if(!enabled() || await isTerraBusy())return last={status:'waiting',reason:'Operator disabled or Terra lock held'};
      const step=nextStep(pkg,status);
      heartbeat.lastRunAt=now();await publish({status:'running',packageId:pkg.id,accountId:pkg.accountId,period:pkg.period,step});
      try {const result=await operator.execute(user,{packageId:pkg.id,step});if(result.status==='stopped' || result.evidence?.result?.status==='stopped')throw new Error('stopped at: '+(result.reason || result.evidence.result.reason));return last={status:'progress',packageId:pkg.id,accountId:pkg.accountId,period:pkg.period,step,runId:result.runId};}
      catch(error){if(error.code==='BANKING_OPERATOR_BUSY')return last={status:'waiting',reason:error.message};throw Object.assign(error,{packageId:pkg.id,accountId:pkg.accountId});}
    })().then(publish).catch(async error=>{
      if(error.qboSignInBeforeAdmission===true && /^QBO_/.test(error.code || '')){
        if(error.code==='QBO_SESSION_BUSY')return publish({status:'waiting',reason:'Another operator owns the automation browser'});
        const attempts=Math.min(3,(signInRetry?.attempts || 0)+1);
        const code=Object.hasOwn(require('./qbo-browser-login').MESSAGES,error.code)?error.code:'QBO_SIGNIN_REQUIRED';
        // A person must act on a verification challenge or missing login: 15 minutes, three tries.
        // Anything else (a slow page, a flaky check, a busy browser) retries every two minutes.
        signInRetry={attempts,failedAt:now(),nextRetryAt:new Date(Date.parse(now())+(NEEDS_PERSON.has(code)?15:2)*60000).toISOString(),code,reason:require('./qbo-browser-login').MESSAGES[code]};
        return publish({status:'blocked',requiresSignIn:true,reason:signInRetry.reason,code,signInRetry});
      }
      const value={reason:error.message,packageId:error.packageId || null,accountId:error.accountId || null,at:now()};let saved=value;try{await pauseStore.write(value);localPauses.delete(value.accountId);}catch(persistenceError){saved={...value,persistenceError:'Durable banking pause could not be saved; no further native work on this account in this process'};localPauses.set(value.accountId,saved);}last={status:'blocked',...saved};heartbeat.lastOutcome=last;try{await stateStore?.write({...heartbeat,...last,signInRetry});}catch{}return last;}).finally(()=>{pending=null;});
    return pending;
  }
  function start(){if(closed || timer)return;timer=setTimer(()=>{void tick();},intervalMs);timer.unref?.();void tick();}
  function close(){closed=true;if(timer)clearTimer(timer);timer=null;}
  return {tick,start,close,drain:async()=>{if(pending)await pending;},status:()=>({...last,...heartbeat})};
}
function filePauseStore(file){return {clear:async expected=>{const current=JSON.parse(await fs.readFile(file,'utf8'));if(require('./banking-workspace-service').hash(current)!==require('./banking-workspace-service').hash(expected))throw Object.assign(new Error('Banking pause changed; inspect the current stop'),{code:'BANKING_RESUME_BLOCKED',status:409});await fs.unlink(file);},read:async()=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},write:async v=>{await fs.mkdir(path.dirname(file),{recursive:true});try{await fs.writeFile(file,JSON.stringify(v,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}};}
// One pause file per account (operator-loop-paused/<accountId>.json). The older
// single global file is still read and cleared so an existing stop is kept.
function accountPauseStore(directory,legacyFile=null){
  const H=value=>require('./banking-workspace-service').hash(value);
  const fileFor=accountId=>path.join(directory,(/^[0-9]{1,30}$/.test(accountId||'')?accountId:'unknown')+'.json');
  async function entries(){
    const out=[];
    if(legacyFile){const v=await filePauseStore(legacyFile).read();if(v)out.push({file:legacyFile,value:v});}
    let names=[];try{names=(await fs.readdir(directory)).filter(n=>/^([0-9]{1,30}|unknown)\.json$/.test(n)).sort();}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const n of names){const v=await filePauseStore(path.join(directory,n)).read();if(v)out.push({file:path.join(directory,n),value:v});}
    return out;
  }
  return {
    list:async()=>(await entries()).map(e=>e.value),
    read:async packageId=>{const all=await entries();return (packageId?all.find(e=>e.value.packageId===packageId):all[0])?.value || null;},
    write:async value=>filePauseStore(fileFor(value?.accountId)).write(value),
    clear:async expected=>{const match=(await entries()).find(e=>H(e.value)===H(expected));if(!match)throw Object.assign(new Error('Banking pause changed; inspect the current stop'),{code:'BANKING_RESUME_BLOCKED',status:409});await fs.unlink(match.file);}
  };
}
function defaultPauseStore(root){return accountPauseStore(path.join(root,'artifacts/banking/operator-loop-paused'),path.join(root,'artifacts/banking/operator-loop-paused.json'));}
function fileStateStore(file){
  let pending=Promise.resolve();
  return {read:filePauseStore(file).read,write:value=>{
    const bytes=JSON.stringify(value,null,2);
    const write=pending.catch(()=>{}).then(async()=>{
      await fs.mkdir(path.dirname(file),{recursive:true});
      const tmp=file+'.'+process.pid+'.'+require('node:crypto').randomUUID()+'.tmp';
      try{await fs.writeFile(tmp,bytes,{flag:'wx'});await fs.rename(tmp,file);}
      finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    });pending=write;return write;
  }};
}
async function terraBusy(directory=path.join(os.tmpdir(),'qbo-terra-live.lock')){
  if(directory===path.join(os.tmpdir(),'qbo-terra-live.lock'))return (await require('./banking-operator-recovery').recoverBankingLocks()).busy;
  try{await fs.stat(directory);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
async function readBankingLoopStatus({packages=[],root=path.resolve(__dirname,'../../..'),enabled=process.env.BANKING_OPERATOR_ENABLED==='true'}={}){
  let pause,pauses=[];try{pauses=await defaultPauseStore(root).list();pause=pauses.find(p=>packages.some(k=>k.id===p.packageId)) || pauses[0] || null;}catch{return {status:'blocked',paused:true,enabled,lastTickAt:null,lastRunAt:null,lastOutcome:null,reason:'Banking pause diagnostics could not be read. Inspect local storage before enabling the operator.'};}
  let state;try{state=await fileStateStore(path.join(root,'artifacts/banking/operator-loop-state.json')).read();}catch{return {status:'blocked',paused:true,enabled,reason:'Banking heartbeat diagnostics could not be read',lastTickAt:null,lastRunAt:null,lastOutcome:null};}
  const stateVisible=state && packages.some(p=>p.id===state.packageId);
  const lastOutcome=state?.lastOutcome ? stateVisible || !state.lastOutcome.packageId ? state.lastOutcome : {status:state.lastOutcome.status,reason:'Inspect the retained local operator diagnostics.'} : null;
  const visible=pause && packages.some(p=>p.id===pause.packageId);
  let automaticRetry=null,requiresInspection=true;
  const pkg=visible && packages.find(p=>p.id===pause.packageId);
  if(pkg?.snapshot?.scope){
    try{
      const O=require('./banking-operator'),R=require('./banking-operator-resolution');
      const runs=await O.createFileJournal(path.join(root,'artifacts/banking/operator-journal')).list(pkg.snapshot.scope,pkg.accountId);
      const entry=runs.find(r=>r.packageId===pkg.id && !R.settled(r));
      if(entry){let result=entry.result;if(!result){const retained=await require('./banking-operator-recovery').readRetainedTerraResult(root,entry);if(retained)result=O.parseTerraReply(retained.reply,{data:{...entry,account:{id:entry.accountId,currency:pkg.accountCurrency}}});}
        automaticRetry=R.retryPolicy({...entry,result},runs,new Date().toISOString());requiresInspection=!R.noNativeEffect(entry,result);
      }
    }catch{/* Missing evidence keeps manual inspection required. */}
  }
  return {pausedAccounts:[...new Set(pauses.map(p=>p.accountId).filter(Boolean))],requiresSignIn:state?.requiresSignIn===true,signInRetry:state?.signInRetry || null,automaticRetry,recoveryReason:pause && stateVisible ? state?.lastOutcome?.recoveryReason || null : null,requiresInspection,resumeAvailable:Boolean(visible),status:pause&&(!enabled||pauses.some(p=>!p.accountId))?'blocked':enabled?(state?.status || 'scheduled'):'disabled',lastTickAt:state?.lastTickAt || null,lastRunAt:state?.lastRunAt || null,lastOutcome,paused:Boolean(pause),enabled,reason:pause ? visible ? pause.reason : 'Scheduled banking is paused. Inspect the retained local operator diagnostics.' : state?.requiresSignIn ? state.reason : null,packageId:visible?pause.packageId:null,accountId:visible?pause.accountId:null,at:pause?.at || null,recovery:pause?'Observe native state, preserve accepted actions and resolve the block before explicitly clearing the pause. Never replay an uncertain upload or Add.':null};
}
module.exports={readBankingLoopStatus,createBankingOperatorLoop,currentPackages,workablePackages,nextStep,filePauseStore,accountPauseStore,defaultPauseStore,fileStateStore,terraBusy};
