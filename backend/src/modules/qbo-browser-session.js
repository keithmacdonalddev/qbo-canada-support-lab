'use strict';
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {REALM,COMPANY,MESSAGES,failure,scopeOk,validActor,ensureLogin}=require('./qbo-browser-login');
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
function createSessionStore(root=ROOT){
 const base=path.join(root,'artifacts/banking'),file=path.join(base,'qbo-session-status.json');
 return {
  read:async()=>{try{const s=JSON.parse(await fs.readFile(file,'utf8'));if(s.version!==1||s.realmId!==REALM||s.environment!=='production'||!['ready','blocked','checking'].includes(s.status))return null;return {version:1,attemptId:/^[a-f0-9-]{36}$/.test(s.attemptId||'')?s.attemptId:null,actor:['app','accountant','claude-code','codex-cli'].includes(s.actor)?s.actor:null,realmId:REALM,environment:'production',status:s.status,code:Object.hasOwn(MESSAGES,s.code)?s.code:null,identityVerified:s.identityVerified===true,companyVerified:s.companyVerified===true,at:Number.isFinite(Date.parse(s.at))?s.at:null};}catch(e){if(e.code==='ENOENT')return null;throw failure('QBO_SIGNIN_REQUIRED');}},
  write:async value=>{await fs.mkdir(base,{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(value,null,2),{flag:'wx'});await fs.rename(tmp,file);await fs.appendFile(path.join(base,'qbo-session-audit.jsonl'),JSON.stringify(value)+'\n');}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}},
 };
}
function createSessionCoordinator({root=ROOT,acquire=()=>acquireSessionLease({root}),store=createSessionStore(root),readCredential=options=>readDedicatedCredential(options),browserFactory=options=>createBrowserTransport({root,...options}),now=()=>new Date().toISOString()}={}){
 async function withSession({actor,scope={realmId:REALM,environment:'production'}},work=async()=>null){
  validActor(actor);if(!scopeOk(scope))throw failure('QBO_COMPANY_MISMATCH');
  const attemptId=crypto.randomUUID(),lease=await acquire();
  const write=(status,code=null,proof=null)=>store.write({version:1,attemptId,actor,realmId:REALM,environment:'production',companyName:COMPANY,status,code,message:code?MESSAGES[code]:status==='ready'?'Dedicated Intuit user and My Business company verified.':'Checking the dedicated QuickBooks sign-in.',identityVerified:proof?.identityVerified===true,companyVerified:proof?.companyVerified===true,at:now()});
  let authenticated=false;
  try{
   await write('checking');
   const proof=await ensureLogin({browser:browserFactory({onChild:lease.trackChild}),readCredential:()=>readCredential({onChild:lease.trackChild})});
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
