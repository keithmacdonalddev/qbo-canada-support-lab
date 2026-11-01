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
async function acquireOperatorLease(directory=path.join(os.tmpdir(),'qbo-banking-operator.lock')) {
  try { await fs.mkdir(directory); } catch(e) { if(e.code==='EEXIST') throw Object.assign(new Error('Another banking operator is running or needs recovery'),{code:'BANKING_OPERATOR_BUSY'}); throw e; }
  await fs.writeFile(path.join(directory,'owner.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  return async()=>{await fs.unlink(path.join(directory,'owner.json'));await fs.rmdir(directory);};
}
function createTerraRunner({root=ROOT,bankingRoot=path.join(root,'artifacts/banking'),bashPath='C:/Program Files/Git/bin/bash.exe',timeoutMs=1250000,cleanupGraceMs=16000,spawnProcess=spawn,exec=execFile}={}) {
  check(Number.isSafeInteger(cleanupGraceMs) && cleanupGraceMs>=1 && cleanupGraceMs<=16000,'Bounded cleanup grace required');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs>=1000 && timeoutMs<=1250000,'Bounded Terra timeout required');
  const artifacts=path.join(root,'artifacts/terra-live');
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
    const taskDirectory=path.join(bankingRoot,'operator-tasks',runId); await fs.mkdir(taskDirectory,{recursive:true});
    const taskFile=path.join(taskDirectory,'task.txt'); await fs.writeFile(taskFile,task.prompt,{flag:'wx'});
    const startedMs=Date.now();
    // terra-live.sh owns the all-Terra lock, fixed model and 20-minute timeout.
    // --flow/--desktop are wrapper modes, not Codex CLI flags.
    const result=await new Promise((resolve,reject)=>{
      let child,stdout='',stderr='',timedOut=false,cleanupError=null,overflow=false,closing=false,timer,cleanupTimer;
      const done=(code,signal)=>{if(closing)return;closing=true;clearTimeout(timer);clearTimeout(cleanupTimer);resolve({code,signal,stdout,stderr,timedOut,cleanupError,overflow});};
      const terminate=()=>{if(timedOut)return;timedOut=true;cleanupTimer=setTimeout(()=>done(null,'cleanup-unconfirmed'),cleanupGraceMs); if(process.platform==='win32') exec('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:15000},e=>{cleanupError=e?e.message:null;}); else child.kill('SIGTERM');};
      child=spawnProcess(bashPath,[path.join(root,SCRIPT),'--'+mode,runId,taskFile,'medium'],{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      timer=setTimeout(terminate,timeoutMs);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>2000000){overflow=true;stdout=stdout.slice(-2000000);terminate();}});
      child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-10000);});
      child.once('close',done);
    });
    const cleanupConfirmed=!result.timedOut && !result.overflow && /this run's processes: none left/.test(result.stdout) && !/cleanup NOT confirmed|could not check|processes still alive/.test(result.stdout);
    const outputs=[...result.stdout.matchAll(/files in (artifacts\/terra-live\/[A-Za-z0-9._-]+)/g)];
    check(outputs.length===1,'Terra output directory unconfirmed; retain execution lock');
    const outputDirectory=await fs.realpath(path.join(root,outputs[0][1])), base=await fs.realpath(artifacts);
    check(outputDirectory.startsWith(base+path.sep) && path.basename(outputDirectory).startsWith(runId+'-'),'Unexpected Terra output directory');
    const replyPath=path.join(outputDirectory,'reply.txt'), reply=await fs.readFile(replyPath,'utf8');
    const audit=/^--- command audit: shell=(\d+); flagged=(\d+) ---$/m.exec(result.stdout.split('--- Terra reply ---')[0]);
    const commandAudit=audit?{shell:Number(audit[1]),flagged:Number(audit[2])}:null;
    const commandsPath=path.join(outputDirectory,'commands.txt');
    const settings=result.stdout.split('--- effective settings (thread ').at(-1).split('--- cleanup ---')[0];
    const model=result.stdout.includes('--- effective settings (thread ') && /"model":"gpt-6\.1-terra"/.test(settings)?'gpt-6.1-terra':null;
    return {exitCode:result.code,cleanupConfirmed,model,reply,replyPath,commandsPath,commandAudit,outputDirectory,startedMs};
  }
  return {run,retainInput,retainEvidence};
}
// Importing starts nothing; caller injects authorized BF4 and sync/report readers.
function createDefaultBankingOperator({root=ROOT,workspace,getAccount,readVerification,authorize,resolveRows,...options}) {
  return createBankingOperator({workspace,getAccount,readVerification,resolveRows,readReportArtifact:createArtifactReader(path.join(root,'artifacts/banking')),authorize:authorize || (async ({user,scope,action})=>require('./business-runtime-access').createBusinessRuntimeAccess({actorId:String(user.actorId || user.id),ownerId:String(user.id)}).authorize(scope,action)),runner:createTerraRunner({root}),journal:createFileJournal(path.join(root,'artifacts/banking/operator-journal')),lease:()=>acquireOperatorLease(),...options});
}
module.exports={acquireOperatorLease,createTerraRunner,createDefaultBankingOperator};
