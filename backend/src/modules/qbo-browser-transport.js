'use strict';
const path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const {spawn,execFile}=require('node:child_process');
const {failure,LOGIN,QBO,normalizeUser}=require('./qbo-browser-login');
const ROOT=path.resolve(__dirname,'../../..');
function privateRun(file,args,{input='',timeoutMs=45000,spawnProcess=spawn,exec=execFile,onChild=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  let child,output='',closed=false,failed=false,timer,grace;
  const done=(error)=>{if(closed)return;closed=true;clearTimeout(timer);clearTimeout(grace);if(error)reject(error);else resolve(output);output='';};
  try{child=spawnProcess(file,args,{cwd:ROOT,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});onChild(child.pid);}catch{if(child?.pid){if(process.platform==='win32')exec('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:2000},()=>{});else child.kill('SIGTERM');}done(failure(child?.pid?'QBO_SESSION_UNCERTAIN':'QBO_BROWSER_UNAVAILABLE'));return;}
  const stop=()=>{if(failed||closed)return;failed=true;grace=setTimeout(()=>done(failure('QBO_SESSION_UNCERTAIN')),3000);if(process.platform==='win32')exec('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:2000},()=>{});else child.kill('SIGTERM');};
  timer=setTimeout(stop,timeoutMs);
  child.once('error',()=>done(failure('QBO_BROWSER_UNAVAILABLE')));
  child.stdout.on('data',b=>{if(output.length+b.length>65536)stop();else output+=b.toString();});
  child.stderr.on('data',()=>{}); // Never expose provider/credential/browser diagnostics.
  child.once('close',code=>done(failed?failure('QBO_SESSION_UNCERTAIN'):code===0?null:failure('QBO_BROWSER_UNAVAILABLE')));
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function readWindowsCredential({root=ROOT,presence=false,run=privateRun,onChild}={}){
 if(process.platform!=='win32')throw failure('QBO_CREDENTIAL_MISSING');
 let raw;
 try{const script=await fs.readFile(path.join(root,'scripts/banking/read-qbo-credential.ps1'),'utf8');raw=await run('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command','[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'+(presence?' -Presence':'')],{input:script,timeoutMs:15000,onChild});const value=JSON.parse(raw.replace(/^\uFEFF/,''));if(presence)return {configured:value.configured===true};if(!normalizeUser(value.username)||typeof value.password!=='string'||!value.password)throw failure('QBO_CREDENTIAL_MISSING');return {username:value.username,password:value.password};}
 catch(error){if(error?.code==='QBO_SESSION_UNCERTAIN')throw failure('QBO_SESSION_UNCERTAIN');if(presence)return {configured:false};throw failure('QBO_CREDENTIAL_MISSING');}finally{raw='';}
}
// Only this fixed function enters page scope. Input values travel through stdin,
// and the caller discards all raw browser output/errors. No screenshots/recordings.
async function pageAction(action,value=''){
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const main=window===window.top,origin=location.origin,url=origin+location.pathname;
 const text=String(document.body?.innerText||'');
 const inputs=[...document.querySelectorAll('input')].filter(visible),buttons=[...document.querySelectorAll('button')].filter(visible);
 const password=inputs.filter(e=>e.type==='password'),username=inputs.filter(e=>e.id==='iux-identifier-first-international-email-user-id-input'||['email','username'].includes(e.autocomplete)||e.type==='email');
 const challenge=inputs.some(e=>e.autocomplete==='one-time-code'||/otp|verification.?code/i.test(e.name+' '+e.id))||[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha/i.test(e.title+' '+e.src))||[...document.querySelectorAll('h1,h2,[role=heading]')].some(e=>visible(e)&&/check your (phone|email)|verify your identity|enter.*code|security check|use your passkey/i.test(e.textContent));
 const rejected=[...document.querySelectorAll('[role=alert]')].some(e=>visible(e)&&/incorrect|invalid password|couldn.t sign|try again/i.test(e.textContent));
 const remembered=buttons.find(e=>/^Use a different account/i.test(e.textContent.trim()));
 if(action==='inspect')return {url,challenge,rejected,phase:password.length?'password':username.length?'username':remembered?'remembered':'transition'};
 if(['identity','identity-open','identity-close'].includes(action)){
  if(!main||origin!=='https://qbo.intuit.com')return {loaded:false,matches:false};
  const menus=[...document.querySelectorAll('button')].filter(e=>visible(e)&&/^Intuit account \([^)]+\)$/.test(e.getAttribute('aria-label')||''));
  const dialogs=[...document.querySelectorAll('[aria-label="Intuit account"] .iam-access-point-detail[role="dialog"]')].filter(visible);
  if(menus.length!==1||dialogs.length>1)return {loaded:false,matches:false};
  if(action==='identity-open'){if(!dialogs.length)menus[0].click();return {loaded:true};}
  if(action==='identity-close'){if(dialogs.length)menus[0].click();return {loaded:true};}
  if(dialogs.length!==1)return {loaded:false,matches:false};
  const widget=dialogs[0],manage=[...widget.querySelectorAll('a.iam-access-point-oiam-link')].filter(e=>visible(e)&&e.textContent.trim()==='Manage your Intuit Account'),logout=[...widget.querySelectorAll('button')].filter(e=>visible(e)&&e.textContent.trim()==='Sign out');
  const principals=[...widget.querySelectorAll('h2[class*="AccessPointDetailStyles__Subtitle-"]')].filter(visible);
  const loaded=manage.length===1&&logout.length===1&&principals.length===1;
  return {loaded,matches:loaded&&principals[0].textContent.trim().toLowerCase()===value.trim().toLowerCase()};
 }
 if(action==='company'){
  if(!main||origin!=='https://qbo.intuit.com'||!location.pathname.startsWith('/app/'))return null;
  const rawId=/Company\s*ID(?:\s+is)?\s*[:#]?\s*([0-9][0-9 \u00a0]{8,30}[0-9])/i.exec(text)?.[1];
  const id=rawId?.replace(/\D/g,'');
  return {realmId:id||null,name:text.includes('My Business')?'My Business':null};
 }
 if(!main||origin!=='https://accounts.intuit.com'||location.pathname!=='/app/sign-in'||challenge||rejected)throw new Error('QBO_SIGNIN_REQUIRED');
 if(action==='username-matches'){
  const target=value.trim().toLowerCase();
  return [...document.querySelectorAll('input')].some(e=>e.type!=='password'&&String(e.value).trim().toLowerCase()===target)||[...document.querySelectorAll('span,p,div')].some(e=>visible(e)&&e.children.length===0&&e.textContent.trim().toLowerCase()===target);
 }
 if(action==='different'){if(!remembered)throw new Error('QBO_SIGNIN_REQUIRED');remembered.click();return true;}
 const field=action==='password'?password:action==='username'?username:[];
 if(field.length!==1)throw new Error('QBO_SIGNIN_REQUIRED');
 const form=field[0].closest('form');
 if(field[0].form!==form)throw new Error('QBO_SIGNIN_REQUIRED');
 if(form){const destination=new URL(form.getAttribute('action')||location.href,location.href);if(destination.origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');}
 const submit=buttons.filter(e=>/^(Sign in|Continue|Next)$/i.test(e.textContent.trim())&&(!form||form.contains(e)));
 if(submit.length!==1||submit[0].form!==form||(form&&!form.contains(submit[0])))throw new Error('QBO_SIGNIN_REQUIRED');
 if(submit[0].formAction&&new URL(submit[0].formAction,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
 // The origin, form, field and submit checks cannot be separated by navigation.
 const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
 setter.call(field[0],value);field[0].dispatchEvent(new Event('input',{bubbles:true}));field[0].dispatchEvent(new Event('change',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,100));
 if(submit[0].disabled||window!==window.top||location.origin!==origin||!field[0].isConnected||!submit[0].isConnected||field[0].closest('form')!==form||field[0].form!==form||submit[0].form!==form||(form&&!form.contains(submit[0])))throw new Error('QBO_SIGNIN_REQUIRED');
 if(form&&new URL(form.getAttribute('action')||location.href,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
 if(submit[0].formAction&&new URL(submit[0].formAction,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
 submit[0].click();return true;
}
function createBrowserTransport({root=ROOT,run=privateRun,onChild=()=>{},delay=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const bin=path.join(process.env.APPDATA||path.join(os.homedir(),'AppData/Roaming'),'npm/node_modules/agent-browser/bin/agent-browser.js');
 const profile=path.join(os.homedir(),'.qbo-automation-profile');
 const command=async(args,options={})=>{
  let raw;try{raw=await run(process.execPath,[bin,'--session','qbo-ops',...args,'--json'],{onChild,...options});const result=JSON.parse(raw);if(result.success!==true)throw failure('QBO_BROWSER_UNAVAILABLE');return result.data;}finally{raw='';}
 };
 const evaluate=async(action,value)=>{
  let input='('+pageAction.toString()+')('+JSON.stringify(action)+','+JSON.stringify(value||'')+')';
  try{return (await command(['eval','--stdin'],{input})).result;}finally{input='';}
 };
 return {
  open:async()=>{await command(['--profile',profile,'open',QBO+'/app/homepage'],{timeoutMs:120000});},
  inspect:()=>evaluate('inspect'),
  differentAccount:async()=>{await evaluate('different');await delay(350);},
  enterUsername:async value=>{await evaluate('username',value);await delay(500);},
  enterPassword:async value=>{await evaluate('password',value);await delay(1000);},
  usernameMatches:value=>evaluate('username-matches',value),
  settle:()=>delay(500),
  verifyIdentity:async username=>{for(let n=0;n<20;n++){await evaluate('identity-open');const identity=await evaluate('identity',username);if(identity.loaded){await evaluate('identity-close');return identity.matches;}await delay(500);}return false;},
  verifyCompany:async()=>{
   await command(['open',QBO+'/app/homepage']);
   let proof=null;
   for(let n=0;n<20;n++){proof=await evaluate('company');if(proof?.name==='My Business')break;await delay(500);}
   if(proof?.name!=='My Business')return proof;
   await command(['press','Control+Alt+Shift+/']);
   for(let n=0;n<20;n++){proof=await evaluate('company');if(proof?.realmId)break;await delay(500);}
   if(!proof?.realmId){await command(['press','Escape']);await command(['open',QBO+'/app/billing']);for(let n=0;n<20;n++){proof=await evaluate('company');if(proof?.realmId)break;await delay(500);}}
   await command(['press','Escape']);await command(['open',QBO+'/app/homepage']);return proof;
  }
 };
}
module.exports={privateRun,readWindowsCredential,pageAction,createBrowserTransport};
