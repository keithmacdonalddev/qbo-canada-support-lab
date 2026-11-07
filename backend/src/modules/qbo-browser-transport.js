'use strict';
const path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const {spawn,execFile}=require('node:child_process');
const {failure,LOGIN,QBO,normalizeUser,loginOrigin,qboOrigin}=require('./qbo-browser-login');
const ROOT=path.resolve(__dirname,'../../..');
function privateRun(file,args,{input='',timeoutMs=45000,spawnProcess=spawn,exec=execFile,onChild=()=>{},nativeCliCompletion=false}={}){
 return new Promise((resolve,reject)=>{
  let child,output='',outputBytes=0,closed=false,failed=false,timer,grace,parentExited=false,parentExitCode=null,completionQueued=false;
  const terminalJson=()=>{try{const value=JSON.parse(output);return value!==null&&!Array.isArray(value)&&typeof value==='object'&&typeof value.success==='boolean';}catch{return false;}};
  // A failed command is finished when the browser answered it (element not found,
  // unknown ref, a page wait that timed out, a script error). Trouble reaching the
  // daemon or Chrome (connect, socket, CDP, busy, CLI timeouts) leaves it possibly
  // still acting, so that stays uncertain. The error text is never returned here.
  const pageAnswered=()=>{if(parentExitCode===0)return true;try{const e=String(JSON.parse(output).error||'');return Boolean(e)&&!/daemon|connect|websocket|\bcdp\b|socket|not responding|proxy request|gateway|retries|failed to start|tool execution timed out|^timed out after|unresponsive|busy/i.test(e);}catch{return false;}};
  const done=(error)=>{if(closed)return;closed=true;clearTimeout(timer);clearTimeout(grace);if(error)reject(error);else resolve(output);output='';};
  const closeOwnedPipes=()=>{for(const stream of [child.stdin,child.stdout,child.stderr])try{stream.destroy?.();}catch{}};
  // The native CLI may leave its persistent browser daemon holding inherited
  // pipes. Only its successful parent exit plus a complete JSON protocol reply
  // can release our pipe handles; generic subprocesses still require close.
  // A command that fails still exits and prints its JSON reply ({success:false});
  // the caller reads that. Only a still-running command is uncertain.
  const completeNative=()=>{if(!nativeCliCompletion||closed||failed||!parentExited||!terminalJson()||!pageAnswered()||completionQueued)return;completionQueued=true;setImmediate(()=>{completionQueued=false;if(closed||failed||!parentExited||!terminalJson()||!pageAnswered())return;done(null);closeOwnedPipes();});};
  try{child=spawnProcess(file,args,{cwd:ROOT,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});onChild(child.pid,path.basename(file));}catch{if(child?.pid){if(process.platform==='win32')exec('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:2000},()=>{});else child.kill('SIGTERM');}done(failure(child?.pid?'QBO_SESSION_UNCERTAIN':'QBO_BROWSER_UNAVAILABLE'));return;}
  const stop=()=>{if(failed||closed)return;failed=true;if(nativeCliCompletion&&parentExited){done(failure('QBO_SESSION_UNCERTAIN'));closeOwnedPipes();return;}grace=setTimeout(()=>done(failure('QBO_SESSION_UNCERTAIN')),3000);if(process.platform==='win32')exec('taskkill.exe',['/T','/F','/PID',String(child.pid)],{windowsHide:true,timeout:2000},()=>{});else child.kill('SIGTERM');};
  timer=setTimeout(stop,timeoutMs);
  child.once('error',()=>done(failure('QBO_BROWSER_UNAVAILABLE')));
  // A QuickBooks page snapshot is ~200 KB; a small cap stopped good commands and
  // falsely held the shared browser lock as 'cleanup unverified'.
  child.stdout.on('data',b=>{if(closed)return;if((nativeCliCompletion?outputBytes:output.length)+b.length>(nativeCliCompletion?8388608:65536))stop();else{outputBytes+=b.length;output+=b.toString();completeNative();}});
  child.stderr.on('data',()=>{}); // Never expose provider/credential/browser diagnostics.
  child.once('exit',code=>{parentExited=true;parentExitCode=code;completeNative();});
  child.once('close',code=>done(failed?failure('QBO_SESSION_UNCERTAIN'):nativeCliCompletion?parentExited&&terminalJson()&&pageAnswered()?null:failure('QBO_SESSION_UNCERTAIN'):code===0?null:failure('QBO_BROWSER_UNAVAILABLE')));
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function readDedicatedCredential({presence=false,file=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'TestDataLab/qbo-ai-login.json'),readFile=fs.readFile,lstat=fs.lstat}={}){
 let raw='',value;
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<2||info.size>16384)throw failure('QBO_CREDENTIAL_MISSING');raw=await readFile(file,'utf8');value=JSON.parse(raw.replace(/^\uFEFF/,''));const username=normalizeUser(value?.email);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)||typeof value.password!=='string'||!value.password||value.password.length>4096)throw failure('QBO_CREDENTIAL_MISSING');return presence?{configured:true}:{username,password:value.password};}
 catch{if(presence)return{configured:false};throw failure('QBO_CREDENTIAL_MISSING');}finally{raw='';if(value&&typeof value==='object'){value.password='';value.email='';}}
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
 if(action==='navigate-home'||action==='navigate-billing'){
  if(!main||!(location.href==='about:blank'||origin==='https://accounts.intuit.com'||origin==='https://qbo.intuit.com'))throw new Error('QBO_SIGNIN_REQUIRED');
  const target=action==='navigate-home'?'https://qbo.intuit.com/app/homepage':'https://qbo.intuit.com/app/billing';
  setTimeout(()=>location.assign(target),0);return true;
 }
 const text=String(document.body?.innerText||'');
 const inputs=[...document.querySelectorAll('input')].filter(visible),buttons=[...document.querySelectorAll('button')].filter(visible);
 const password=inputs.filter(e=>e.type==='password'),username=inputs.filter(e=>e.id==='iux-identifier-first-international-email-user-id-input'||['email','username'].includes(e.autocomplete)||e.type==='email');
 const captchaNow=()=>[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/captcha/i.test(e.title+' '+e.src));
 const challengeNow=()=>[...document.querySelectorAll('input')].filter(visible).some(e=>e.autocomplete==='one-time-code'||/otp|verification.?code/i.test(e.name+' '+e.id))||captchaNow()||[...document.querySelectorAll('h1,h2,[role=heading]')].some(e=>visible(e)&&/check your (phone|email)|verify your identity|enter.*code|security check|use your passkey/i.test(e.textContent));
 const rejectedNow=()=>[...document.querySelectorAll('[role=alert]')].some(e=>visible(e)&&/incorrect|invalid password|couldn.t sign|try again/i.test(e.textContent));
 const captcha=captchaNow(),challenge=challengeNow(),rejected=rejectedNow();
 const choices=()=>[...document.querySelectorAll('button,a,[role=button]')].filter(e=>visible(e)&&/^Enter password\s*,?\s*$/.test(String(e.innerText||e.textContent||'').trim()));
 const enabled=e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true';
 const passwordChoice=main&&origin==='https://accounts.intuit.com'&&location.pathname==='/app/account-manager'&&!captcha&&choices().length===1&&enabled(choices()[0]);
 const remembered=buttons.find(e=>/^Use a different account/i.test(e.textContent.trim()));
 if(action==='inspect')return {url,challenge,captcha,rejected,passwordChoice,phase:password.length?'password':username.length?'username':remembered?'remembered':passwordChoice?'password-choice':'transition'};
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
 // Both routes share the existing atomic form guard, but only the live picker
 // closure can authorize the account-manager password form.
 async function submitField(field,secret,boundDocument=document,boundPath=location.pathname){
  const sameContext=()=>window===window.top&&document===boundDocument&&location.origin===origin&&location.pathname===boundPath;
  if(!sameContext()||challengeNow()||rejectedNow()||field.length!==1||!visible(field[0])||field[0].disabled)throw new Error('QBO_SIGNIN_REQUIRED');
  const form=field[0].closest('form');if(field[0].form!==form)throw new Error('QBO_SIGNIN_REQUIRED');
  if(form&&new URL(form.getAttribute('action')||location.href,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
  const submit=[...document.querySelectorAll('button')].filter(e=>visible(e)&&/^(Sign in|Continue|Next)$/i.test(e.textContent.trim())&&(!form||form.contains(e)));
  if(submit.length!==1||submit[0].disabled||submit[0].form!==form||(form&&!form.contains(submit[0])))throw new Error('QBO_SIGNIN_REQUIRED');
  if(submit[0].formAction&&new URL(submit[0].formAction,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
  // Recheck the original context immediately before placing the secret.
  if(!sameContext())throw new Error('QBO_SIGNIN_REQUIRED');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(field[0],secret);field[0].dispatchEvent(new Event('input',{bubbles:true}));field[0].dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,100));
  if(!sameContext()||challengeNow()||rejectedNow()||submit[0].disabled||!visible(field[0])||!visible(submit[0])||!field[0].isConnected||!submit[0].isConnected||field[0].closest('form')!==form||field[0].form!==form||submit[0].form!==form||(form&&!form.contains(submit[0])))throw new Error('QBO_SIGNIN_REQUIRED');
  if(form&&new URL(form.getAttribute('action')||location.href,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
  if(submit[0].formAction&&new URL(submit[0].formAction,location.href).origin!==origin)throw new Error('QBO_SIGNIN_REQUIRED');
  submit[0].click();return true;
 }
 if(action==='password-from-picker'){
  try{
   if(!main||origin!=='https://accounts.intuit.com'||location.pathname!=='/app/account-manager'||captcha||rejected||!value||typeof value.username!=='string'||typeof value.password!=='string'||!value.password)throw new Error('QBO_SIGNIN_REQUIRED');
   const documentBefore=document,pathBefore=location.pathname,target=value.username.trim().toLowerCase();
   const methods=[...document.querySelectorAll('button,a,[role=button]')].filter(e=>visible(e)&&/^Email a code(?:\s|,|$)/i.test(String(e.innerText||e.textContent||'').trim()));
   const emails=methods.length===1?(String(methods[0].innerText||methods[0].textContent||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]):[];
   const options=choices();if(!target||emails.length!==1||emails[0].toLowerCase()!==target||options.length!==1||options[0].isConnected!==true||!enabled(options[0]))throw new Error('QBO_IDENTITY_UNVERIFIED');
   const href=options[0].getAttribute('href');if(href!==null){const destination=new URL(href,location.href);if(destination.origin!==origin||destination.pathname!==pathBefore||destination.username||destination.password)throw new Error('QBO_SIGNIN_REQUIRED');}
   if(window!==window.top||document!==documentBefore||location.origin!==origin||location.pathname!==pathBefore||captchaNow()||rejectedNow()||options[0].isConnected!==true||!visible(options[0])||!enabled(options[0]))throw new Error('QBO_SIGNIN_REQUIRED');
   options[0].click();let field=null;
   for(let n=0;n<50;n++){
    if(window!==window.top||document!==documentBefore||location.origin!==origin||location.pathname!==pathBefore||captchaNow()||rejectedNow())throw new Error('QBO_SIGNIN_REQUIRED');
    const found=[...document.querySelectorAll('input')].filter(e=>visible(e)&&e.type==='password');if(found.length){field=found;break;}await new Promise(resolve=>setTimeout(resolve,100));
   }
   if(!field)throw new Error('QBO_SIGNIN_REQUIRED');
   await submitField(field,value.password,documentBefore,pathBefore);
   return{targetVerifiedOnPicker:true,passwordSelected:true,passwordSubmitted:true};
  }finally{if(value&&typeof value==='object'){value.username='';value.password='';}}
 }
 if(!main||origin!=='https://accounts.intuit.com'||location.pathname!=='/app/sign-in'||challenge||rejected)throw new Error('QBO_SIGNIN_REQUIRED');
 if(action==='username-matches'){
  const target=value.trim().toLowerCase();
  return [...document.querySelectorAll('input')].some(e=>e.type!=='password'&&String(e.value).trim().toLowerCase()===target)||[...document.querySelectorAll('span,p,div')].some(e=>visible(e)&&e.children.length===0&&e.textContent.trim().toLowerCase()===target);
 }
 if(action==='different'){if(!remembered)throw new Error('QBO_SIGNIN_REQUIRED');remembered.click();return true;}
 const field=action==='password'?password:action==='username'?username:[];
 return submitField(field,value);
}
function createBrowserTransport({root=ROOT,run=privateRun,onChild=()=>{},delay=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const bin=path.join(process.env.APPDATA||path.join(os.homedir(),'AppData/Roaming'),'npm/node_modules/agent-browser/bin/agent-browser.js');
 const profile=path.join(os.homedir(),'.qbo-automation-profile').split(path.sep).join('/');
 const native=process.platform==='win32',executable=native?path.join(path.dirname(bin),'agent-browser-win32-'+process.arch+'.exe'):process.execPath,prefix=native?[]:[bin];
 const command=async(args,options={})=>{
  let raw;try{raw=await run(executable,[...prefix,'--session','qbo-ops','--profile',profile,...args,'--json'],{onChild,nativeCliCompletion:native,...options});const result=JSON.parse(raw);if(result.success!==true)throw failure('QBO_BROWSER_UNAVAILABLE');return result.data;}finally{raw='';}
 };
 const evaluate=async(action,value)=>{
  let input='('+pageAction.toString()+')('+JSON.stringify(action)+','+JSON.stringify(value||'')+')';
  try{return (await command(['eval','--stdin'],{input})).result;}finally{input='';}
 };
 return {
  open:async()=>{
   // Launch the persistent profile without waiting for an authentication redirect's load event.
   await command(['open'],{timeoutMs:120000});
   let state=await evaluate('inspect');if(loginOrigin(state?.url)||qboOrigin(state?.url))return;
   await evaluate('navigate-home');
   for(let n=0;n<20;n++){state=await evaluate('inspect');if(loginOrigin(state?.url)||qboOrigin(state?.url))return;await delay(500);}
   throw failure('QBO_SIGNIN_REQUIRED');
  },
  inspect:()=>evaluate('inspect'),
  navigateHome:async()=>{await evaluate('navigate-home');await delay(500);},
  differentAccount:async()=>{await evaluate('different');await delay(350);},
  enterUsername:async value=>{await evaluate('username',value);await delay(500);},
  enterPassword:async value=>{await evaluate('password',value);await delay(1000);},
  enterPasswordFromPicker:async value=>{try{const proof=await evaluate('password-from-picker',value);await delay(1000);return proof;}finally{value.username='';value.password='';}},
  usernameMatches:value=>evaluate('username-matches',value),
  settle:()=>delay(500),
  verifyIdentity:async username=>{for(let n=0;n<20;n++){await evaluate('identity-open');const identity=await evaluate('identity',username);if(identity.loaded){await evaluate('identity-close');return identity.matches;}await delay(500);}return false;},
  verifyCompany:async()=>{
   await evaluate('navigate-home');
   let proof=null;
   // A freshly opened browser can take well over ten seconds to render the homepage.
   for(let n=0;n<60;n++){proof=await evaluate('company');if(proof?.name==='My Business')break;await delay(500);}
   if(proof?.name!=='My Business')return proof;
   // The shortcut is ignored until the freshly loaded homepage registers it,
   // so press it again (bounded) rather than falling back immediately.
   for(let press=0;press<4 && !proof?.realmId;press++){
    await command(['press','Control+Alt+Shift+/']);
    for(let n=0;n<10;n++){proof=await evaluate('company');if(proof?.realmId)break;await delay(500);}
    if(!proof?.realmId){await command(['press','Escape']);await delay(1500);}
   }
   if(!proof?.realmId){await command(['press','Escape']);await evaluate('navigate-billing');for(let n=0;n<20;n++){proof=await evaluate('company');if(proof?.realmId)break;await delay(500);}}
   await command(['press','Escape']);await evaluate('navigate-home');return proof;
  }
 };
}
module.exports={privateRun,readDedicatedCredential,readWindowsCredential,pageAction,createBrowserTransport};
