'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {createArtifactReader,hash}=require('./banking-workspace-service');
const {createFileJournal,createBankingOperator}=require('./banking-operator');
const ROOT=path.resolve(__dirname,'../../..');
const SCRIPT='.claude/skills/qbo-team-delivery/scripts/terra-live.sh';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
function draftIdentity(expected){
  const url=new URL(location.href);
  if(url.origin!=='https://qbo.intuit.com'||url.pathname!=='/app/invoice'||url.searchParams.get('txnId')!==expected.invoiceId)return {matches:false};
  const text=String(document.body?.innerText||''),values=[...document.querySelectorAll('input,textarea')].filter(e=>e.type!=='password').map(e=>String(e.value||''));
  const raw=/Company\s*ID(?:\s+is)?\s*[:#]?\s*([0-9][0-9 \u00a0]{8,30}[0-9])/i.exec(text)?.[1];
  return {realmId:raw?.replace(/\D/g,'')||null,customerMatches:values.includes(expected.customerName)||text.includes(expected.customerName),amountMatches:text.replace(/,/g,'').includes(Number(expected.total).toFixed(2)),descriptionMatches:!expected.description||values.includes(expected.description)};
}
async function acquireOperatorLease(directory=path.join(os.tmpdir(),'qbo-banking-operator.lock')) {
  if(directory===path.join(os.tmpdir(),'qbo-banking-operator.lock')) {const recovered=await require('./banking-operator-recovery').recoverBankingLocks();if(recovered.busy)throw Object.assign(new Error('Another banking/Terra process is live'),{code:'BANKING_OPERATOR_BUSY'});}
  try { await fs.mkdir(directory); } catch(e) { if(e.code==='EEXIST') throw Object.assign(new Error('Another banking operator is running or needs recovery'),{code:'BANKING_OPERATOR_BUSY'}); throw e; }
  await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  return async()=>{await fs.unlink(path.join(directory,'owner.json'));await fs.rmdir(directory);};
}
function createTerraRunner({root=ROOT,bankingRoot=path.join(root,'artifacts/banking'),bashPath='C:/Program Files/Git/bin/bash.exe',timeoutMs=1250000,cleanupGraceMs=16000,spawnProcess=spawn,exec=execFile,coordinator=null}={}) {
  check(Number.isSafeInteger(cleanupGraceMs) && cleanupGraceMs>=1 && cleanupGraceMs<=16000,'Bounded cleanup grace required');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs>=1000 && timeoutMs<=1250000,'Bounded Terra timeout required');
  const artifacts=path.join(root,'artifacts/terra-live');
  let activeSession=null;
  const sessions=()=>coordinator || (coordinator=require('./qbo-browser-session').createSessionCoordinator({root}));
  async function withSession(context,work){
    if(activeSession)throw require('./qbo-browser-login').failure('QBO_SESSION_BUSY');
    return sessions().withSession(context,async lease=>{activeSession=lease;try{return await work();}finally{activeSession=null;}});
  }
  async function assertAvailable(){
    const browser=path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'npm/node_modules/agent-browser/bin/agent-browser.js');
    check((await fs.stat(browser)).isFile() && (await fs.stat(path.join(root,SCRIPT))).isFile(),'Installed native browser helper is unavailable');
  }
  async function assertNoDraft(){
    const ownsLease=!activeSession,lease=activeSession||await require('./qbo-browser-session').acquireSessionLease({root});
    try{
      const browser=path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'npm/node_modules/agent-browser/bin/agent-browser.js');
      const raw=await require('./qbo-browser-transport').privateRun(process.execPath,[browser,'--session','qbo-ops','tab','list','--json'],{onChild:lease.trackChild});
      const result=JSON.parse(raw),tabs=result?.data?.tabs;
      check(result.success===true && Array.isArray(tabs) && tabs.length===1 && tabs[0].url==='https://qbo.intuit.com/app/homepage','Native no-effect recovery requires the sole browser page to be the unchanged homepage, with no draft');
      return {onlyHomepage:true,tabCount:1,observedAt:new Date().toISOString()};
    }catch(error){if(error.code==='QBO_SESSION_UNCERTAIN')lease.retain();throw error;}finally{if(ownsLease)await lease.release();}
  }
  async function discardOwnedDraft({invoiceId,runId,scope,customerName,total,description,beforeDiscard}){
    check(/^\d{1,30}$/.test(invoiceId||'')&&/^bf7-[a-f0-9-]{36}$/.test(runId||''),'Exact owned draft identity required');
    check(scope?.environment==='production'&&scope.realmId===require('./qbo-browser-login').REALM&&typeof customerName==='string'&&customerName.length>0&&Number.isFinite(total)&&typeof beforeDiscard==='function','Exact scoped original draft witness required');
    const ownsLease=!activeSession,lease=activeSession||await require('./qbo-browser-session').acquireSessionLease({root});
    const browser=path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'npm/node_modules/agent-browser/bin/agent-browser.js');
    const command=async(args,input='')=>{const result=JSON.parse(await require('./qbo-browser-transport').privateRun(process.execPath,[browser,'--session','qbo-ops',...args,'--json'],{onChild:lease.trackChild,input}));check(result.success===true,'Owned draft cleanup command failed');return result.data;};
    try{
      const before=await command(['tab','list']),tabs=before?.tabs;check(Array.isArray(tabs)&&tabs.length===1,'Cleanup requires the sole task-owned editor');
      const url=new URL(tabs[0].url);check(url.origin==='https://qbo.intuit.com'&&url.pathname==='/app/invoice'&&url.searchParams.get('txnId')===invoiceId,'Cleanup cannot navigate away from another record');
      check(typeof tabs[0].tabId==='string'&&typeof tabs[0].targetId==='string','Owned browser target identity required');
      let identity;
      try{await command(['press','Control+Alt+Shift+/']);identity=(await command(['eval','--stdin'],'('+draftIdentity.toString()+')('+JSON.stringify({invoiceId,customerName,total,description})+')')).result;}
      finally{await command(['press','Escape']);}
      check(identity?.realmId===scope.realmId&&identity.customerMatches===true&&identity.amountMatches===true&&identity.descriptionMatches===true,'Current native company/customer/amount/draft does not match the original task');
      const current=await command(['tab','list']);check(current?.tabs?.length===1&&current.tabs[0].tabId===tabs[0].tabId&&current.tabs[0].targetId===tabs[0].targetId&&current.tabs[0].url===tabs[0].url,'Owned draft browser target changed');
      const witness={invoiceId,runId,realmId:identity.realmId,tabId:tabs[0].tabId,targetId:tabs[0].targetId,customerHash:hash(customerName),total,descriptionHash:hash(description||''),observedAt:new Date().toISOString()};
      await beforeDiscard(witness);
      // Navigation discards this run-owned, explicitly unsaved draft. No Save,
      // Delete, transaction API or other editor is ever selected.
      await command(['open','https://qbo.intuit.com/app/homepage']);
      const after=await command(['tab','list']);check(after?.tabs?.length===1&&after.tabs[0].url==='https://qbo.intuit.com/app/homepage','Owned draft cleanup is not confirmed');
      return {onlyHomepage:true,invoiceId,runId,witness,method:'discard-owned-unsaved-draft-by-navigation',observedAt:new Date().toISOString()};
    }catch(error){if(error.code==='QBO_SESSION_UNCERTAIN')lease.retain();throw error;}finally{if(ownsLease)await lease.release();}
  }
  async function retainInput(file,bytes) {
    check(digest(bytes)===file.sha256,'Input artifact hash changed');
    await createArtifactReader(bankingRoot)({path:file.path,sha256:file.sha256});
    return path.join(bankingRoot,file.path);
  }
  async function retainEvidence(execution,relative,{scope,accountId,runId}) {
    check(typeof relative==='string' && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes(':') && !relative.split('/').includes('..') && /\.(jpg|jpeg|png)$/i.test(relative),'Evidence must be a retained screenshot inside this run');
    const base=await fs.realpath(execution.outputDirectory), target=await fs.realpath(path.join(base,relative));
    check(target.startsWith(base+path.sep),'Screenshot escapes run');
    const stat=await fs.stat(target); check(stat.isFile() && stat.size>0 && stat.size<=20000000 && stat.mtimeMs>=execution.startedMs-2000,'Screenshot missing, stale or oversized');
    const bytes=await fs.readFile(target); check(bytes.subarray(0,3).equals(Buffer.from([255,216,255])) || bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Invalid screenshot bytes');
    const sha256=digest(bytes), dest=hash(scope)+'/'+accountId+'/operator/'+runId+'/'+sha256+path.extname(relative).toLowerCase();
    const absolute=path.join(bankingRoot,dest); await fs.mkdir(path.dirname(absolute),{recursive:true});
    try {await fs.writeFile(absolute,bytes,{flag:'wx'});} catch(e){if(e.code!=='EEXIST')throw e; check(digest(await fs.readFile(absolute))===sha256,'Evidence hash collision');}
    return {path:dest,sha256};
  }
  async function run({task,runId,mode='flow'}) {
    check(/^bf7-[a-f0-9-]{36}$/.test(runId) && ['flow','desktop'].includes(mode),'Invalid Terra invocation');
    if(spawnProcess===spawn && !activeSession)throw require('./qbo-browser-login').failure('QBO_SIGNIN_REQUIRED');
    const taskDirectory=path.join(bankingRoot,'operator-tasks',runId); await fs.mkdir(taskDirectory,{recursive:true});
    const taskFile=path.join(taskDirectory,'task.txt'); await fs.writeFile(taskFile,task.prompt,{flag:'wx'});
    const startedMs=Date.now();
    const native=task.nativeRepair;
    if(native)check(mode==='flow' && /^[a-f0-9]{64}$/.test(native.actionId||'') && /^[a-f0-9]{64}$/.test(native.authorityHash||''),'Invalid exact native-repair authority');
    const nativeArgs=native?['--native-estimate-repair',native.actionId,native.authorityHash]:[];
    // terra-live.sh owns the all-Terra lock, fixed model and 20-minute timeout.
    // --flow/--desktop are wrapper modes, not Codex CLI flags.
    const result=await new Promise((resolve,reject)=>{
      let child,stdout='',stderr='',timedOut=false,cleanupError=null,overflow=false,closing=false,timer,cleanupTimer;
      const done=(code,signal)=>{if(closing)return;closing=true;clearTimeout(timer);clearTimeout(cleanupTimer);resolve({code,signal,stdout,stderr,timedOut,cleanupError,overflow});};
      const terminate=()=>{if(timedOut)return;timedOut=true;cleanupTimer=setTimeout(()=>done(null,'cleanup-unconfirmed'),cleanupGraceMs); if(process.platform==='win32') exec('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:15000},e=>{cleanupError=e?e.message:null;}); else child.kill('SIGTERM');};
      child=spawnProcess(bashPath,[path.join(root,SCRIPT),'--'+mode,runId,taskFile,'medium',...nativeArgs],{cwd:root,windowsHide:true,shell:false,env:{...process.env,...(activeSession?.environment || {})},stdio:['ignore','pipe','pipe']});
      timer=setTimeout(terminate,timeoutMs);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>2000000){overflow=true;stdout=stdout.slice(-2000000);terminate();}});
      child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-10000);});
      child.once('close',done);
      try{activeSession?.trackChild(child.pid);}catch{activeSession?.retain();terminate();}
    }).catch(()=>{activeSession?.retain();throw require('./qbo-browser-login').failure('QBO_SESSION_UNCERTAIN');});
    const cleanupConfirmed=!result.timedOut && !result.overflow && /this run's processes: none left/.test(result.stdout) && !/cleanup NOT confirmed|could not check|processes still alive/.test(result.stdout);
    if(!cleanupConfirmed)activeSession?.retain();
    const outputs=[...result.stdout.matchAll(/files in (artifacts\/terra-live\/[A-Za-z0-9._-]+)/g)];
    check(outputs.length===1,'Terra output directory unconfirmed; retain execution lock');
    const outputDirectory=await fs.realpath(path.join(root,outputs[0][1])), base=await fs.realpath(artifacts);
    check(outputDirectory.startsWith(base+path.sep) && path.basename(outputDirectory).startsWith(runId+'-'),'Unexpected Terra output directory');
    const replyPath=path.join(outputDirectory,'reply.txt');
    let reply;try{reply=await fs.readFile(replyPath,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;reply=(await require('./banking-operator-recovery').readRetainedTerraResult(root,{runId}))?.reply || '';}
    const audit=/^--- command audit: shell=(\d+); flagged=(\d+) ---$/m.exec(result.stdout.split('--- Terra reply ---')[0]);
    const commandAudit=audit?{shell:Number(audit[1]),flagged:Number(audit[2])}:null;
    const commandsPath=path.join(outputDirectory,'commands.txt');
    const settings=result.stdout.split('--- effective settings (thread ').at(-1).split('--- cleanup ---')[0];
    const model=result.stdout.includes('--- effective settings (thread ') && /"model":"gpt-6\.1-terra"/.test(settings)?'gpt-6.1-terra':null;
    let execution={exitCode:result.code,cleanupConfirmed,model,reply,replyPath,commandsPath,commandAudit,outputDirectory,startedMs};
    if(native){
      const retained=await require('../../../scripts/banking/native-estimate-execution.cjs').readReceipt(root,{runId,promptHash:require('./business-calendar').hash(task.prompt),nativeRepair:native});
      check(retained && retained.exitCode===result.code && retained.cleanupConfirmed===cleanupConfirmed && retained.reply===reply && JSON.stringify(retained.commandAudit)===JSON.stringify(commandAudit),'Native child completion evidence is missing or differs');
      execution=retained;
    }
    const body={runId,promptHash:require('./business-calendar').hash(task.prompt),execution};
    await fs.writeFile(path.join(taskDirectory,'runner-result.json'),JSON.stringify({body,contentHash:require('./business-calendar').hash(body)}),{flag:'wx'});
    return execution;
  }
  async function readExecution({runId,promptHash,nativeRepair}) {
    check(/^bf7-[a-f0-9-]{36}$/.test(runId) && /^[a-f0-9]{64}$/.test(promptHash),'Invalid retained native run');
    const taskDirectory=path.join(bankingRoot,'operator-tasks',runId);let retained;
    try{retained=JSON.parse(await fs.readFile(path.join(taskDirectory,'runner-result.json'),'utf8'));}catch(error){if(error.code==='ENOENT'){const execution=await require('../../../scripts/banking/native-estimate-execution.cjs').readReceipt(root,{runId,promptHash,nativeRepair});if(execution)await require('./banking-operator-recovery').verifyRetainedRunStopped(root,{runId});return execution;}throw error;}
    const {body,contentHash}=retained;
    check(contentHash===require('./business-calendar').hash(body) && body.runId===runId && body.promptHash===promptHash && require('./business-calendar').hash(await fs.readFile(path.join(taskDirectory,'task.txt'),'utf8'))===promptHash,'Retained execution identity changed');
    if(nativeRepair){
      const execution=await require('../../../scripts/banking/native-estimate-execution.cjs').readReceipt(root,{runId,promptHash,nativeRepair});
      check(execution && require('./business-calendar').hash(execution)===require('./business-calendar').hash(body.execution),'Native retained result differs from child evidence');
      await require('./banking-operator-recovery').verifyRetainedRunStopped(root,{runId});return execution;
    }
    const execution=body.execution,base=await fs.realpath(artifacts),actual=await fs.realpath(execution.outputDirectory);
    check(actual.startsWith(base+path.sep) && path.basename(actual).startsWith(runId+'-') && path.resolve(execution.replyPath)===path.join(actual,'reply.txt') && (await fs.readFile(execution.replyPath,'utf8'))===execution.reply,'Retained native result changed');
    await require('./banking-operator-recovery').verifyRetainedRunStopped(root,{runId});
    return execution;
  }
  return {run,retainInput,retainEvidence,withSession,readExecution,assertAvailable,assertNoDraft,discardOwnedDraft,sessionProof:()=>activeSession?.environment?.TDL_QBO_SESSION_OWNER?require('./business-calendar').hash(activeSession.environment.TDL_QBO_SESSION_OWNER):null};
}
// Importing starts nothing; caller injects authorized BF4 and sync/report readers.
function createDefaultBankingOperator({root=ROOT,workspace,getAccount,readVerification,authorize,resolveRows,...options}) {
  return createBankingOperator({workspace,getAccount,readVerification,resolveRows,readReportArtifact:createArtifactReader(path.join(root,'artifacts/banking')),authorize:authorize || (async ({user,scope,action})=>require('./business-runtime-access').createBusinessRuntimeAccess({actorId:String(user.actorId || user.id),ownerId:String(user.id)}).authorize(scope,action)),runner:createTerraRunner({root}),journal:createFileJournal(path.join(root,'artifacts/banking/operator-journal')),verifyRunStopped:entry=>require('./banking-operator-recovery').verifyRetainedRunStopped(root,entry),readRetainedResult:entry=>require('./banking-operator-recovery').readRetainedTerraResult(root,entry),lease:()=>acquireOperatorLease(),...options});
}
module.exports={acquireOperatorLease,createTerraRunner,createDefaultBankingOperator};
