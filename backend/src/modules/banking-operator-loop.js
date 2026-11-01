'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
function currentPackages(rows){const map=new Map();for(const p of rows){const key=p.accountId+':'+p.period;if(!map.has(key)||p.revision>map.get(key).revision)map.set(key,p);}return [...map.values()].sort((a,b)=>a.period.localeCompare(b.period)||a.accountId.localeCompare(b.accountId,undefined,{numeric:true}));}
function nextStep(pkg,status){
  const runs=status.steps || [];
  const csv=pkg.snapshot.files.find(f=>f.kind==='csv' && !pkg.evidence.imports.some(i=>i.fileId===f.fileId && i.status==='uploaded'));
  if(csv)return {type:'upload',fileId:csv.fileId}; // execute always performs a fresh Rules pre-flight
  const row=pkg.snapshot.rows.find(r=>!['matched','added','excluded'].some(k=>pkg.evidence.rows[r.rowId]?.[k]));
  if(row)return {type:'review',rowId:row.rowId};
  if(!runs.some(r=>r.step.type==='reconcile' && r.status==='completed'))return {type:'reconcile'};
  return {type:'attach'};
}
// Explicit lifecycle, no import-time timers. One tick executes one step of the
// oldest account-month; the next tick re-reads current controls and durable state.
function createBankingOperatorLoop({workspace,operator,listUsers,enabled=()=>false,isTerraBusy,pauseStore,intervalMs=60000,setTimer=setInterval,clearTimer=clearInterval}){
  if(!workspace || !operator || typeof listUsers!=='function' || !isTerraBusy || !pauseStore)throw new TypeError('Banking loop needs scoped adapters, global lock inspection and durable pause storage');
  let timer=null,pending=null,closed=false,last={status:'disabled'},localPause=null;
  async function tick(){
    if(pending)return pending;
    pending=(async()=>{
      if(closed || !enabled())return last={status:'disabled'};
      const paused=localPause || await pauseStore.read();if(paused)return last={status:'blocked',...paused};
      if(await isTerraBusy())return last={status:'waiting',reason:'Another Terra run holds the shared lock'};
      let selected=null;
      for(const user of await listUsers()){
        const list=await workspace.list(user);if(list.truncated)throw new Error('Complete banking package inventory required');
        for(const p of currentPackages(list.packages).filter(p=>!p.summary.reconciled)){
          if(!selected || p.period<selected.pkg.period || p.period===selected.pkg.period && p.accountId.localeCompare(selected.pkg.accountId,undefined,{numeric:true})<0)selected={user,pkg:p};
        }
      }
      if(!selected)return last={status:'idle'};
      const {user}=selected,pkg=await workspace.detail(user,selected.pkg.id),status=await operator.status(user,pkg.id);
      if(status.blocked || pkg.summary.needsReview || pkg.evidence.supersededBy || pkg.snapshot.blockers.length || pkg.evidence.imports.some(i=>['started','interrupted'].includes(i.status)))throw Object.assign(new Error(status.reasons?.[0]?.reason || pkg.snapshot.blockers.join('; ') || 'Banking history/import requires inspection'),{packageId:pkg.id,accountId:pkg.accountId});
      if(!enabled() || await isTerraBusy())return last={status:'waiting',reason:'Operator disabled or Terra lock held'};
      const step=nextStep(pkg,status);
      try {const result=await operator.execute(user,{packageId:pkg.id,step});return last={status:'progress',packageId:pkg.id,accountId:pkg.accountId,period:pkg.period,step,runId:result.runId};}
      catch(error){if(error.code==='BANKING_OPERATOR_BUSY')return last={status:'waiting',reason:error.message};throw Object.assign(error,{packageId:pkg.id,accountId:pkg.accountId});}
    })().catch(async error=>{const value={reason:error.message,packageId:error.packageId || null,accountId:error.accountId || null,at:new Date().toISOString()};localPause=value;try{await pauseStore.write(value);}catch(persistenceError){localPause={...value,persistenceError:'Durable banking pause could not be saved; no further native work in this process'};}return last={status:'blocked',...localPause};}).finally(()=>{pending=null;});
    return pending;
  }
  function start(){if(closed || timer)return;timer=setTimer(()=>{void tick();},intervalMs);timer.unref?.();void tick();}
  function close(){closed=true;if(timer)clearTimer(timer);timer=null;}
  return {tick,start,close,drain:async()=>{if(pending)await pending;},status:()=>last};
}
function filePauseStore(file){return {read:async()=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},write:async v=>{await fs.mkdir(path.dirname(file),{recursive:true});try{await fs.writeFile(file,JSON.stringify(v,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}};}
async function terraBusy(directory=path.join(os.tmpdir(),'qbo-terra-live.lock')){try{await fs.stat(directory);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function readBankingLoopStatus({packages=[],root=path.resolve(__dirname,'../../..'),enabled=process.env.BANKING_OPERATOR_ENABLED==='true'}={}){
  let pause;try{pause=await filePauseStore(path.join(root,'artifacts/banking/operator-loop-paused.json')).read();}catch{return {status:'blocked',paused:true,reason:'Banking pause diagnostics could not be read. Inspect local storage before enabling the operator.'};}
  const visible=pause && packages.some(p=>p.id===pause.packageId);
  return {status:pause?'blocked':enabled?'scheduled':'disabled',paused:Boolean(pause),enabled,reason:pause ? visible ? pause.reason : 'Scheduled banking is paused. Inspect the retained local operator diagnostics.' : null,packageId:visible?pause.packageId:null,accountId:visible?pause.accountId:null,at:pause?.at || null,recovery:pause?'Observe native state, preserve accepted actions and resolve the block before explicitly clearing the pause. Never replay an uncertain upload or Add.':null};
}
module.exports={readBankingLoopStatus,createBankingOperatorLoop,currentPackages,nextStep,filePauseStore,terraBusy};
