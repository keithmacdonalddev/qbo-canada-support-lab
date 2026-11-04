'use strict';
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {REALM,COMPANY,MESSAGES,STAGE_MESSAGES,failure,scopeOk,validActor,ensureLogin}=require('./qbo-browser-login');
const {readDedicatedCredential,createBrowserTransport}=require('./qbo-browser-transport');
const ROOT=path.resolve(__dirname,'../../..'),LOCK=path.join(os.tmpdir(),'qbo-terra-live.lock');
async function acquireSessionLease({root=ROOT,directory=LOCK}={}){
 try{await fs.mkdir(directory);}catch{throw failure('QBO_SESSION_BUSY');}
 const name='qbo-signin-'+crypto.randomUUID(),output=path.join(root,'artifacts/terra-live',name+'-'+Date.now());
 const marker='terra-live-'+name+'-'+process.pid+'-'+Math.floor(Date.now()/1000);
 let retain=false;
 try{await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'pids.txt'),process.pid+' node.exe\n',{flag:'wx'});await fs.writeFile(path.join(directory,'owner.txt'),marker+'\n',{flag:'wx'});}
 catch{retain=true;throw failure('QBO_SESSION_UNCERTAIN');}
 return {
  environment:{TDL_QBO_SESSION_OWNER:marker},
  trackChild:(pid,executable='node.exe')=>{const name=/^[a-zA-Z0-9_.-]+\.exe$/.test(executable)?executable:'node.exe';if(Number.isInteger(pid)&&pid>0)syncFs.appendFileSync(path.join(output,'pids.txt'),pid+' '+name+'\n');},
  retain:()=>{retain=true;},
  release:async()=>{if(retain)return false;const owner=await fs.readFile(path.join(directory,'owner.txt'),'utf8');if(owner!==marker+'\n')throw failure('QBO_SESSION_UNCERTAIN');await fs.unlink(path.join(directory,'owner.txt'));await fs.rmdir(directory);return true;},
 };
}
function sessionState(value,{writing=false}={}){
 if(!value||value.version!==1||value.realmId!==REALM||value.environment!=='production'||!['ready','blocked','checking'].includes(value.status)){if(writing)throw failure('QBO_SIGNIN_REQUIRED');return null;}
 let stage=value.stage??null;const validStage=typeof stage==='string'&&Object.hasOwn(STAGE_MESSAGES,stage)&&(value.status==='checking'?!['ready','blocked'].includes(stage):stage===value.status);
 if(stage!==null&&!validStage){if(writing)throw failure('QBO_SIGNIN_REQUIRED');stage=null;}
 let lastStage=value.lastStage??null;if(lastStage!==null&&(typeof lastStage!=='string'||!Object.hasOwn(STAGE_MESSAGES,lastStage))){if(writing)throw failure('QBO_SIGNIN_REQUIRED');lastStage=null;}
 const code=Object.hasOwn(MESSAGES,value.code)?value.code:null,message=code?MESSAGES[code]:stage?STAGE_MESSAGES[stage]:value.status==='ready'?STAGE_MESSAGES.ready:value.status==='blocked'?STAGE_MESSAGES.blocked:STAGE_MESSAGES['checking-sign-in'];
 return{version:1,attemptId:/^[a-f0-9-]{36}$/.test(value.attemptId||'')?value.attemptId:null,actor:['app','accountant','claude-code','codex-cli'].includes(value.actor)?value.actor:null,realmId:REALM,environment:'production',companyName:COMPANY,status:value.status,stage,lastStage,code,message,identityVerified:value.identityVerified===true,companyVerified:value.companyVerified===true,at:Number.isFinite(Date.parse(value.at))?value.at:null};
}
function createSessionStore(root=ROOT){
 const base=path.join(root,'artifacts/banking'),file=path.join(base,'qbo-session-status.json');
 return {
  read:async()=>{try{return sessionState(JSON.parse(await fs.readFile(file,'utf8')));}catch(e){if(e.code==='ENOENT')return null;throw failure('QBO_SIGNIN_REQUIRED');}},
  write:async value=>{const safe=sessionState(value,{writing:true});await fs.mkdir(base,{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(safe,null,2),{flag:'wx'});await fs.rename(tmp,file);await fs.appendFile(path.join(base,'qbo-session-audit.jsonl'),JSON.stringify(safe)+'\n');}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}},
 };
}
function createSessionCoordinator({root=ROOT,acquire=()=>acquireSessionLease({root}),store=createSessionStore(root),readCredential=options=>readDedicatedCredential(options),browserFactory=options=>createBrowserTransport({root,...options}),now=()=>new Date().toISOString()}={}){
 async function withSession({actor,scope={realmId:REALM,environment:'production'}},work=async()=>null){
  validActor(actor);if(!scopeOk(scope))throw failure('QBO_COMPANY_MISMATCH');
  const attemptId=crypto.randomUUID(),lease=await acquire();
  let currentStage='checking-sign-in';
  const write=async(status,code=null,proof=null,stage=status==='ready'?'ready':status==='blocked'?'blocked':'checking-sign-in')=>{await store.write({version:1,attemptId,actor,realmId:REALM,environment:'production',companyName:COMPANY,status,stage,lastStage:status==='blocked'?currentStage:stage,code,message:code?MESSAGES[code]:STAGE_MESSAGES[stage],identityVerified:proof?.identityVerified===true,companyVerified:proof?.companyVerified===true,at:now()});if(status==='checking')currentStage=stage;};
  let authenticated=false;
  try{
   await write('checking');
   const proof=await ensureLogin({browser:browserFactory({onChild:lease.trackChild}),readCredential:()=>readCredential({onChild:lease.trackChild}),onStage:stage=>write('checking',null,null,stage)});
   await write('ready',null,proof);
   // Credential/browser failures above this boundary are privately projected.
   authenticated=true;return await work({...lease,proof});
  }catch(error){
   if(authenticated)throw error;
   const code=Object.hasOwn(MESSAGES,error?.code)?error.code:'QBO_SIGNIN_REQUIRED';
   if(code==='QBO_SESSION_UNCERTAIN')lease.retain();
   await write('blocked',code).catch(()=>{});
   throw failure(code);
  }finally{await lease.release();}
 }
 return {withSession,status:async()=>({credentialConfigured:(await readCredential({presence:true})).configured===true,last:await store.read()})};
}
module.exports={acquireSessionLease,createSessionStore,createSessionCoordinator};
