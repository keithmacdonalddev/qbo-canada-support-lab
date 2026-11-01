'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os'),vm=require('node:vm');
const modules=path.resolve(process.cwd(),'src/modules');
const L=require(path.join(modules,'qbo-browser-login'));
const T=require(path.join(modules,'qbo-browser-transport'));
const S=require(path.join(modules,'qbo-browser-session'));
function loginHarness(changes={}){
 const credential={username:'robot@example.invalid',password:'fake-private-password'},calls=[];
 let index=0;const states=[{url:L.LOGIN+'/app/sign-in',phase:'remembered'},{url:L.LOGIN+'/app/sign-in',phase:'username'},{url:L.LOGIN+'/app/sign-in',phase:'password'},{url:L.QBO+'/app/homepage'}];
 const browser={open:async()=>calls.push('open'),inspect:async()=>states[Math.min(index++,states.length-1)],differentAccount:async()=>calls.push('different'),enterUsername:async()=>calls.push('username'),usernameMatches:async()=>true,enterPassword:async()=>calls.push('password'),settle:async()=>calls.push('settle'),verifyIdentity:async()=>true,verifyCompany:async()=>({realmId:L.REALM,name:L.COMPANY}),...changes};
 return {credential,calls,browser,run:()=>L.ensureLogin({browser,readCredential:async()=>credential})};
}
test('dedicated login handles remembered, username and password once and proves live identity/company',async()=>{const h=loginHarness(),r=await h.run();assert.equal(r.status,'ready');assert.equal(r.authenticated,true);assert.deepEqual(h.calls,['open','different','username','password']);assert.equal(h.credential.password,'');assert.equal(h.credential.username,'');assert.ok(!JSON.stringify(r).includes('fake-private'));});
for(const url of ['http://accounts.intuit.com/app/sign-in','https://accounts.intuit.com.evil.invalid/app/sign-in','https://evil.invalid/','https://x@accounts.intuit.com/app/sign-in'])test('refuses credential origin '+url,async()=>{const h=loginHarness({inspect:async()=>({url,phase:'password'})});await assert.rejects(h.run(),e=>e.code==='QBO_SIGNIN_REQUIRED');assert.ok(!h.calls.includes('password'));});
for(const phase of ['username','password'])test('extra verification stops before '+phase,async()=>{const h=loginHarness({inspect:async()=>({url:L.LOGIN+'/app/sign-in',phase,challenge:true})});await assert.rejects(h.run(),e=>e.code==='QBO_VERIFICATION_REQUIRED');assert.deepEqual(h.calls,['open']);});
test('wrong signed-in user never grants a task',async()=>{const h=loginHarness({inspect:async()=>({url:L.QBO+'/app/homepage'}),verifyIdentity:async()=>false});await assert.rejects(h.run(),e=>e.code==='QBO_IDENTITY_UNVERIFIED');assert.ok(!h.calls.includes('password'));});
test('current company needs actual ID and name, never account-name fallback',async()=>{for(const proof of [{name:L.COMPANY},{realmId:'wrong',name:L.COMPANY},{realmId:L.REALM,name:'other'}]){const h=loginHarness({verifyCompany:async()=>proof});await assert.rejects(h.run(),e=>e.code==='QBO_COMPANY_MISMATCH');}});
test('password page must match the dedicated username',async()=>{const h=loginHarness({usernameMatches:async()=>false});await assert.rejects(h.run(),e=>e.code==='QBO_IDENTITY_UNVERIFIED');assert.ok(!h.calls.includes('password'));});
test('bad password is not retried and raw errors are not propagated',async()=>{let pass=0;const h=loginHarness({enterPassword:async()=>{pass++;throw Error('fake-private-password');}});await assert.rejects(h.run(),e=>!e.message.includes('fake-private')&&e.code==='QBO_BROWSER_UNAVAILABLE');assert.equal(pass,1);assert.equal(h.credential.password,'');});
test('missing credential does not open the browser',async()=>{let open=false;await assert.rejects(L.ensureLogin({browser:{open:async()=>{open=true;}},readCredential:async()=>{throw Error('secret');}}),e=>e.code==='QBO_CREDENTIAL_MISSING');assert.equal(open,false);});
test('transitions have a bounded number of attempts',async()=>{const h=loginHarness({inspect:async()=>({url:L.LOGIN+'/app/sign-in',phase:'transition'})});await assert.rejects(h.run(),e=>e.code==='QBO_SIGNIN_REQUIRED');assert.equal(h.calls.filter(c=>c==='settle').length,12);});
function pageFixture({origin=L.LOGIN,action=L.LOGIN+'/app/sign-in',frame=false,duplicate=false,buttonAction='',challenge=false,changeOrigin=false,changeForm=false,changeButton=false,moveButton=false,overrideField=false,overrideButton=false}={}){
 let fills=0,clicked=0;
 class Input{constructor(){this.type='password';this.id='password';this.name='';this.autocomplete='';this.children=[];this.isConnected=true;}getBoundingClientRect(){return {width:30,height:20};}closest(){return form;}dispatchEvent(){if(changeOrigin)location.origin='https://evil.invalid';if(changeForm)action='https://evil.invalid/post';if(changeButton)button.formAction='https://evil.invalid/post';if(moveButton)button.form={getAttribute:()=> 'https://evil.invalid/post'};}}
 Object.defineProperty(Input.prototype,'value',{set(v){this.current=v;fills++;},get(){return this.current;}});
 const location={origin,pathname:'/app/sign-in',href:origin+'/app/sign-in'},form={getAttribute:()=>action,contains:()=>true},input=new Input();
 input.form=overrideField?{}:form;
 const button={form:overrideButton?{}:form,textContent:'Sign in',children:[],disabled:false,isConnected:true,formAction:buttonAction,getBoundingClientRect:()=>({width:30,height:20}),click:()=>{clicked++;}};
 const document={body:{innerText:''},querySelectorAll:selector=>selector==='input'?(duplicate?[input,new Input()]:[input]):selector==='button'?[button]:selector==='iframe'&&challenge?[{title:'captcha',src:'https://example.invalid',getBoundingClientRect:()=>({width:100,height:100})}]:[]};
 const window={};window.top=frame?{}:window;
 const context={window,location,document,HTMLInputElement:Input,getComputedStyle:()=>({display:'block',visibility:'visible'}),URL,Event:class{},setTimeout:fn=>fn(),Promise};
 return {input,get fills(){return fills;},get clicked(){return clicked;},run:value=>vm.runInNewContext('('+T.pageAction.toString()+')("password",'+JSON.stringify(value)+')',context)};
}
for(const options of [{origin:'https://evil.invalid'},{action:'https://evil.invalid/post'},{frame:true},{duplicate:true},{buttonAction:'https://evil.invalid/post'},{challenge:true}])test('atomic password gate rejects '+JSON.stringify(options),async()=>{const p=pageFixture(options);await assert.rejects(p.run('fake-secret'));assert.equal(p.fills,0);assert.equal(p.clicked,0);});
test('password is only placed in the verified form; quotes and newlines remain data',async()=>{const p=pageFixture(),secret='fake"; throw Error("injected")\npassword';assert.equal(await p.run(secret),true);assert.equal(p.input.current,secret);assert.equal(p.clicked,1);});
test('navigation during input cannot submit credentials to a changed origin',async()=>{const p=pageFixture({changeOrigin:true});await assert.rejects(p.run('fake-secret'));assert.equal(p.clicked,0);});
test('browser transport uses stdin, not arguments, and never returns raw command diagnostics',async()=>{const seen=[];const b=T.createBrowserTransport({run:async(file,args,opts)=>{seen.push({file,args,input:opts.input});return JSON.stringify({success:true,data:{result:true}});},delay:async()=>{}});await b.enterPassword('fake-secret');assert.ok(!seen[0].args.join(' ').includes('fake-secret'));assert.ok(seen[0].args.includes('--stdin'));assert.ok(seen[0].input.includes('fake-secret'));});
function coordinatorHarness({failLogin=false,workError=false}={}){
 let held=false,releases=0,retained=false;const statuses=[];const lease={environment:{TDL_QBO_SESSION_OWNER:'fixed'},trackChild:()=>{},retain:()=>{retained=true;},release:async()=>{releases++;held=false;}};
 const h=loginHarness(failLogin?{verifyIdentity:async()=>false}:{});
 const c=S.createSessionCoordinator({acquire:async()=>{assert.equal(held,false);held=true;return lease;},store:{write:async s=>statuses.push(s),read:async()=>null},readCredential:async()=>h.credential,browserFactory:()=>h.browser});
 return {c,statuses,get held(){return held;},get releases(){return releases;},get retained(){return retained;}};
}
test('shared lease remains held for authentication and the entire task callback',async()=>{const h=coordinatorHarness();await h.c.withSession({actor:'codex-cli'},async lease=>{assert.equal(h.held,true);assert.ok(lease.environment.TDL_QBO_SESSION_OWNER);assert.equal(h.statuses.at(-1).status,'ready');});assert.equal(h.releases,1);assert.equal(h.held,false);});
test('failed login never reaches banking work and has a sanitized durable outcome',async()=>{const h=coordinatorHarness({failLogin:true});let called=false;await assert.rejects(h.c.withSession({actor:'app'},async()=>{called=true;}));assert.equal(called,false);assert.equal(h.releases,1);assert.equal(h.statuses.at(-1).code,'QBO_IDENTITY_UNVERIFIED');assert.ok(!JSON.stringify(h.statuses).includes('fake-private'));});
test('banking errors retain their original diagnostic rather than becoming login errors',async()=>{const h=coordinatorHarness(),err=Object.assign(Error('banking proof'),{code:'BANKING_PROOF_REQUIRED'});await assert.rejects(h.c.withSession({actor:'app'},async()=>{throw err;}),e=>e===err);assert.equal(h.statuses.at(-1).status,'ready');});
test('wrong company and actor are refused before any lease or credential access',async()=>{const h=coordinatorHarness();for(const context of [{actor:'attacker'},{actor:'app',scope:{realmId:'other',environment:'production'}},{actor:'app',scope:{realmId:L.REALM,environment:'sandbox'}}])await assert.rejects(h.c.withSession(context));assert.equal(h.statuses.length,0);assert.equal(h.releases,0);});
test('real filesystem lease is exclusive and records process identity for existing recovery',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'signin-lease-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const lock=path.join(dir,'lock'),a=await S.acquireSessionLease({root:dir,directory:lock});await assert.rejects(S.acquireSessionLease({root:dir,directory:lock}),e=>e.code==='QBO_SESSION_BUSY');assert.match(a.environment.TDL_QBO_SESSION_OWNER,/^terra-live-qbo-signin-/);assert.equal(await a.release(),true);await fs.mkdir(lock);});
test('retained uncertain process lease is never removed',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'signin-retain-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const lock=path.join(dir,'lock'),a=await S.acquireSessionLease({root:dir,directory:lock});a.retain();assert.equal(await a.release(),false);assert.ok(await fs.stat(lock));});
test('status reads whitelist fields and never echo tampered local text',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'signin-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=S.createSessionStore(dir);await store.write({version:1,realmId:L.REALM,environment:'production',status:'ready',password:'fake-secret',message:'fake-secret',actor:'codex-cli'});const result=await store.read();assert.ok(!JSON.stringify(result).includes('fake-secret'));});

for(const options of [{changeForm:true},{changeButton:true}])test('destination changed by input handler cannot receive password '+JSON.stringify(options),async()=>{const p=pageFixture(options);await assert.rejects(p.run('fake-secret'));assert.equal(p.clicked,0);});
test('native formatted Company ID is parsed exactly, without an account-name substitute',async()=>{
 const window={};window.top=window;const context={window,location:{origin:L.QBO,pathname:'/app/homepage'},document:{body:{innerText:'My Business\nYour Company ID is 9130 3572 2239 2856\nKeyboard Shortcuts'},querySelectorAll:()=>[]},getComputedStyle:()=>({display:'block'}),URL};
 const proof=await vm.runInNewContext('('+T.pageAction.toString()+')("company")',context);assert.equal(proof.realmId,L.REALM);assert.equal(proof.name,L.COMPANY);
});
test('current principal comes only from the native QBO account dialog, not contact text',async()=>{
 const visible={getBoundingClientRect:()=>({width:100,height:20})};let shown=false,principal='other@example.invalid',origin=L.QBO;
 const menu={...visible,textContent:'A',getAttribute:()=> 'Intuit account (A)',click:()=>{shown=!shown;}};
 const manage={...visible,textContent:'Manage your Intuit Account'},logout={...visible,textContent:'Sign out'};
 const widget={getBoundingClientRect:()=>({width:shown?100:0,height:20}),querySelectorAll:s=>s==='a.iam-access-point-oiam-link'?[manage]:s==='button'?[logout]:[{...visible,textContent:principal}]};
 const window={};window.top=window;const location={origin,pathname:'/app/homepage'};
 const context={window,location,document:{body:{innerText:'robot@example.invalid'},querySelectorAll:s=>s==='button'?[menu]:s.includes('iam-access-point-detail')?[widget]:[]},getComputedStyle:()=>({display:'block',visibility:'visible'}),URL};
 const evaluate=action=>vm.runInNewContext('('+T.pageAction.toString()+')('+JSON.stringify(action)+',"robot@example.invalid")',context);
 assert.equal((await evaluate('identity')).loaded,false);await evaluate('identity-open');assert.equal((await evaluate('identity')).matches,false);
 principal='robot@example.invalid';assert.equal((await evaluate('identity')).matches,true);await evaluate('identity-close');assert.equal(shown,false);
 location.origin=L.LOGIN;await evaluate('identity-open');assert.equal(shown,false);assert.equal((await evaluate('identity')).loaded,false);
});
test('unconfirmed credential child cleanup survives transport, credential reader and coordinator',async()=>{
 const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');let retained=false,released=false,work=false;
 const run=(file,args,options)=>T.privateRun(file,args,{...options,timeoutMs:5,spawnProcess:()=>{const child=new EventEmitter();child.pid=32123;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();setTimeout(()=>child.emit('close',0),20);return child;},exec:(_file,_args,_opts,callback)=>callback(null)});
 const c=S.createSessionCoordinator({store:{write:async()=>{}},acquire:async()=>({trackChild:()=>{},environment:{},retain:()=>retained=true,release:async()=>{released=true;assert.equal(retained,true);}}),readCredential:opts=>T.readWindowsCredential({root:path.resolve(__dirname,'../..'),run,...opts}),browserFactory:()=>({open:async()=>{throw Error('must never open browser');}})});
 // The credential script is a local static input; this fake child never invokes CredRead.
 await assert.rejects(c.withSession({actor:'app'},async()=>{work=true;}),e=>e.code==='QBO_SESSION_UNCERTAIN');assert.equal(work,false);assert.equal(retained,true);assert.equal(released,true);
});
test('Windows pipe explicitly round-trips synthetic Unicode as UTF-8', {skip:process.platform!=='win32'},async()=>{
 const script="[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::Out.Write((@{username='robot-é';password='fake-漢字'} | ConvertTo-Json -Compress))";
 const raw=await T.privateRun('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command','[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))'],{input:script});const value=JSON.parse(raw);assert.equal(value.username,'robot-é');assert.equal(value.password,'fake-漢字');
});


test('runner dispatch rejection retains the shared browser lease',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'signin-runner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let retained=false;
 const {createTerraRunner}=require(path.join(modules,'banking-terra-runner'));
 const lease={environment:{TDL_QBO_SESSION_OWNER:'lease-marker'},trackChild:()=>{},retain:()=>retained=true};
 const runner=createTerraRunner({root:dir,coordinator:{withSession:async(_context,work)=>work(lease)},spawnProcess:()=>{throw Error('fake dispatch failure');}});
 await assert.rejects(runner.withSession({actor:'app'},()=>runner.run({task:{prompt:'read only'},runId:'bf7-11111111-1111-1111-1111-111111111111'})),e=>e.code==='QBO_SESSION_UNCERTAIN');assert.equal(retained,true);
});
test('CLI task entry refuses arbitrary files and only reads retained task text',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'signin-cli-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const id='11111111-1111-1111-1111-111111111111',relative='artifacts/terra-live/tasks/'+id+'/task.txt';await fs.mkdir(path.dirname(path.join(dir,relative)),{recursive:true});await fs.writeFile(path.join(dir,relative),'Observe the approved company only');
 const {readTask}=require(path.resolve(process.cwd(),'../scripts/banking/qbo-session.cjs'));
 assert.equal(await readTask(relative,dir),'Observe the approved company only');for(const input of ['.env','C:/private.txt','artifacts/terra-live/tasks/../task.txt',relative.replace('.txt','.js')])await assert.rejects(readTask(input,dir));
});

for(const options of [{moveButton:true},{overrideField:true},{overrideButton:true}])test('form association changes cannot submit a password '+JSON.stringify(options),async()=>{const p=pageFixture(options);await assert.rejects(p.run('fake-secret'));assert.equal(p.clicked,0);});
