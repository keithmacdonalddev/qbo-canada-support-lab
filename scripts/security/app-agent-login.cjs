#!/usr/bin/env node
'use strict';
// Local enrollment and login. No credential/JWT is accepted in argv or printed.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const {execFile}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),rq=createRequire(path.join(ROOT,'backend/package.json'));
const access=require('../../backend/src/modules/agent-app-access');
const {privateRun}=require('../../backend/src/modules/qbo-browser-transport');
const VAULT=path.join(os.homedir(),'AppData/Local/TestDataLab/agent-access'),META=path.join(VAULT,'current.json');
const ORIGINS=new Set(['http://localhost:5173','http://127.0.0.1:5173']);
function argumentsFor(argv) {
  const [command,...rest]=argv,options={command};
  if(!['enroll','login','status','revoke'].includes(command))throw Error('Use enroll, login, status or revoke.');
  for(let i=0;i<rest.length;i+=2){
    const key=rest[i],value=rest[i+1];
    if(!['--user-id','--realm-id','--session','--path','--actor'].includes(key)||!value||value.startsWith('--')||Object.hasOwn(options,key.slice(2)))throw Error('Invalid options. Never pass credentials.');
    options[key.slice(2)]=value;
  }
  if(command==='enroll'&&(!access.ID.test(options['user-id']||'')||!/^[0-9]{5,30}$/.test(options['realm-id']||'')))throw Error('Enrollment requires the exact existing --user-id and --realm-id.');
  if(command==='login'){
    options.session=options.session||'tdl-agent-'+require('node:crypto').randomUUID();
    if(!/^[a-z0-9][a-z0-9_-]{2,90}$/i.test(options.session)||['default','qbo-ops'].includes(options.session))throw Error('Use a unique owned app browser session.');
    options.path=options.path||'/company/bank';
    if(options.path==='/dashboard')options.path='/company';
    if(!/^\/(?:company(?:\/[a-z0-9_-]+)*|dashboard|settings)$/.test(options.path))throw Error('Use an ordinary app page path.');
    options.actor=options.actor||'local-agent';
    if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(options.actor))throw Error('Invalid actor label.');
  }
  return options;
}
async function vault(action,credentialId,record){
  if(process.platform!=='win32'||!access.UUID.test(credentialId||''))throw Error('Windows private credential storage required.');
  const script=await fs.readFile(path.join(__dirname,'app-agent-vault.ps1'),'utf8');
  const raw=await privateRun('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script],
    {input:JSON.stringify({action,credentialId,...(record?{record}:{})}),timeoutMs:15000});
  const result=JSON.parse(raw.replace(/^\uFEFF/,''));
  if(result.error)throw Error('Private app credential unavailable.');
  return result;
}
async function metadata(){
  const stat=await fs.lstat(META);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('Invalid agent metadata.');
  const m=JSON.parse(await fs.readFile(META,'utf8'));
  if(!access.ID.test(m.accountId||'')||!access.UUID.test(m.credentialId||'')||!ORIGINS.has(m.origin)||!/^[a-f0-9]{64}$/.test(m.targetFingerprint||''))throw Error('Invalid agent metadata.');
  return m;
}
async function publish(value){
  await fs.mkdir(VAULT,{recursive:true});
  const temp=META+'.'+require('node:crypto').randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});await fs.rename(temp,META);}
  finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function withStorage(work){
  rq('dotenv').config({path:path.join(ROOT,'.env'),quiet:true});
  const config=require('../../backend/src/config'),m=rq('mongoose'),target=require('../../backend/src/modules/storage-target');
  target.configureDatabaseDns();
  try{
    await m.connect(config.mongoUri,{autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:5000,connectTimeoutMS:5000});
    return await work({config,m,targetFingerprint:target.storageTarget(config.mongoUri).fingerprint,
      Users:require('../../backend/src/models/User'),Connections:require('../../backend/src/models/Connection'),
      service:access.createAgentAccess({Users:require('../../backend/src/models/User'),Connections:require('../../backend/src/models/Connection'),
        Audits:require('../../backend/src/models/AuditLog'),transaction:require('../../backend/src/modules/business-transaction').createBusinessTransaction(m.connection),
        environment:config.qbo.environment})});
  }finally{await m.disconnect();}
}
async function enroll(options){
  await fs.mkdir(VAULT,{recursive:true});
  // The transaction's exact-account CAS serializes enrollment; immutable UUID
  // files need no persistent process lock that could strand crash recovery.
  return await withStorage(async({Users,Connections,service,config,targetFingerprint})=>{
    const accountId=options['user-id'],realmId=options['realm-id'];
    const user=await Users.findById(accountId).select('+agentCredentialHash').lean();
    if(!require('../../backend/src/modules/account-policy').accountEligible(user))throw Error('Existing account is not eligible.');
    const connection=await Connections.findOne({userId:accountId,status:'active'}).sort({updatedAt:-1}).select('realmId').lean();
    if(connection?.realmId!==realmId)throw Error('Existing active company mismatch.');
    let credential,reused=false;
    if(user.agentCredentialId){
      credential=await vault('read',user.agentCredentialId);
      if(credential.accountId!==accountId||credential.realmId!==realmId||credential.targetFingerprint!==targetFingerprint||!access.matches(user,credential))throw Error('Existing credential needs explicit recovery; it was not replaced.');
      reused=true;
    }else{
      credential={...access.newCredential(),accountId,realmId,environment:config.qbo.environment,targetFingerprint};
      // Durable encrypted staging precedes the DB transaction. A lost result is
      // recovered from the exact DB credential UUID on the next enrollment.
      await vault('write',credential.credentialId,credential);
      await service.enroll({accountId,realmId,credential});
    }
    await publish({version:1,accountId,realmId,environment:config.qbo.environment,targetFingerprint,credentialId:credential.credentialId,origin:'http://localhost:5173'});
    credential.secret='';
    return {configured:true,credentialReused:reused,accountId,realmEnding:realmId.slice(-4),ownerPasswordChanged:false};
  });
}
function browserPageLogin(payload){
  return (async()=>{
    if(window!==window.top||location.origin!==payload.origin)throw Error('APP_ORIGIN_MISMATCH');
    const verify=async token=>{
      const headers={Authorization:'Bearer '+token};
      const me=await fetch('/api/auth/me',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
      const context=await fetch('/api/qbo/status',{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!me.ok||!context.ok)return false;
      const personal=await me.json(),company=await context.json();
      return personal.user?._id===payload.accountId&&company.realmId===payload.realmId&&company.environment===payload.environment;
    };
    const existing=localStorage.getItem('token');
    if(existing&&await verify(existing))return {authenticated:true,accountMatches:true,companyMatches:true,sessionReused:true};
    const response=await fetch('/api/auth/agent-login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',redirect:'error',
      signal:AbortSignal.timeout(10000),body:JSON.stringify({accountId:payload.accountId,credentialId:payload.credentialId,secret:payload.secret,actor:payload.actor})});
    if(!response.ok)throw Error('APP_AGENT_LOGIN_REJECTED');
    const data=await response.json();
    if(location.origin!==payload.origin||data.user?._id!==payload.accountId||typeof data.token!=='string'||!await verify(data.token))throw Error('APP_SCOPE_MISMATCH');
    localStorage.setItem('token',data.token);
    return {authenticated:true,accountMatches:true,companyMatches:true,sessionReused:false};
  })();
}

function publicBrowserCommand(file,args,timeoutMs){
  // Match the working CLI launch for ordinary commands. Only eval --stdin and
  // vault operations use the private input transport below.
  return new Promise((resolve,reject)=>{
    execFile(file,args,{cwd:ROOT,windowsHide:true,shell:false,timeout:timeoutMs,maxBuffer:262144},(error,stdout)=>{
      if(error)return reject(Object.assign(Error('App browser command failed.'),{browserCode:error.killed?'BROWSER_COMMAND_TIMEOUT':'BROWSER_COMMAND_FAILED'}));
      resolve(stdout);
    });
  });
}
async function login(options){
  const meta=await metadata(),credential=await vault('read',meta.credentialId);
  if(credential.accountId!==meta.accountId||credential.realmId!==meta.realmId||credential.targetFingerprint!==meta.targetFingerprint||!access.SECRET.test(credential.secret||''))throw Error('Private credential does not match metadata.');
  const bin=path.join(os.homedir(),'AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-'+process.arch+'.exe');
  const command=async(args,input='',timeoutMs=45000)=>{
    const argv=['--session',options.session,...args,'--json'];
    const raw=input?await privateRun(bin,argv,{input,timeoutMs}):await publicBrowserCommand(bin,argv,timeoutMs);
    const result=JSON.parse(raw);if(result.success!==true)throw Error('App browser command failed.');return result.data;
  };
  let phase='open-login-page';
  try{
    await command(['open',meta.origin+'/login'],'',120000);
    phase='exchange-private-credential';
    const payload={...credential,origin:meta.origin,actor:options.actor};
    const proof=(await command(['eval','--stdin'],'('+browserPageLogin.toString()+')('+JSON.stringify(payload)+')')).result;
    if(proof?.authenticated!==true||proof.accountMatches!==true||proof.companyMatches!==true)throw Error('App sign-in proof missing.');
    phase='open-authenticated-page';
    await command(['open',meta.origin+options.path]);
    phase='wait-for-app-page';
    await command(['wait','--fn','location.pathname === '+JSON.stringify(options.path)+' && document.querySelector("main") !== null']);
    phase='verify-app-page';
    const final=(await command(['eval','--stdin'],"({origin:location.origin,path:location.pathname,hasAppSession:!!localStorage.getItem('token')})")).result;
    if(final?.origin!==meta.origin||final.path!==options.path||final.hasAppSession!==true)throw Error('Authenticated app page did not open.');
    return {...proof,session:options.session,url:meta.origin+options.path,realmEnding:meta.realmId.slice(-4)};
  }catch(error){
    let cleanupConfirmed=false;
    try{await command(['close']);cleanupConfirmed=(await command(['session','info'])).active===false;}catch{/* Report uncertainty; never close another session. */}
    throw Object.assign(Error('Agent app login failed. No credential or session token was exposed. Check app health and enrollment.'),{code:'APP_AGENT_LOGIN_FAILED',phase,browserCode:error.browserCode,cleanupConfirmed});
  }finally{credential.secret='';}
}
async function main(argv=process.argv.slice(2)){
  const options=argumentsFor(argv);
  let result;
  if(options.command==='enroll')result=await enroll(options);
  else if(options.command==='login')result=await login(options);
  else if(options.command==='status'){
    try{const m=await metadata();const c=await vault('read',m.credentialId);result={configured:access.SECRET.test(c.secret||''),accountId:m.accountId,realmEnding:m.realmId.slice(-4)};c.secret='';}
    catch{result={configured:false};}
  }else{
    const m=await metadata();result=await withStorage(({service,targetFingerprint,config})=>{
      if(targetFingerprint!==m.targetFingerprint||config.qbo.environment!==m.environment)throw Error('Agent storage target changed.');
      return service.revoke({accountId:m.accountId,credentialId:m.credentialId});
    });
    await fs.unlink(META);
  }
  console.log(JSON.stringify(result));
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({error:'Agent app access failed. Private storage and credential details suppressed.',...(error.code==='APP_AGENT_LOGIN_FAILED'?{phase:error.phase,cleanupConfirmed:error.cleanupConfirmed,...(error.browserCode?{browserCode:error.browserCode}:{})}:{})}));process.exitCode=1;});
module.exports={argumentsFor,vault,metadata,enroll,browserPageLogin,login,main};
