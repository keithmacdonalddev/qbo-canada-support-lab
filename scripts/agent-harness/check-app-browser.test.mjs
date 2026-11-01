import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { appOrigin, allowedRequest, safeEnvironment, identifyApp, enforceRequest, checkAppBrowser, launchOwnedChrome, parseArgs } from './check-app-browser.mjs';
const healthy = {app:'test-data-lab',status:'ok',database:'connected'};
const login = '<title>Test Data Lab</title><div id="root"></div>';
async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+instance.address().port,close:()=>new Promise(resolve=>{instance.close(resolve);instance.closeAllConnections();})};
}
async function scratch(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'tdl-readiness-test-'));
  t.after(async()=>{
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tdl-readiness-test-'));
    await fs.rm(resolved,{recursive:true,force:true});
  }); return directory;
}
const fakeFetch = async url => new Response(url.endsWith('/api/health')?JSON.stringify(healthy):login);

test('rejects remote, credentialed, ambiguous and non-origin targets before launching anything', async()=>{
  for(const value of ['https://localhost:5173','http://example.com:5173','http://localhost','http://u:p@localhost:5173','http://localhost:5173/login','http://localhost:5173/?token=x','http://localhost:5173/#x']) {
    assert.throws(()=>appOrigin(value));
    await assert.rejects(checkAppBrowser({origin:value},{launch:()=>assert.fail('must not launch')}));
  }
  assert.equal(appOrigin('http://127.0.0.1:5173/'),'http://127.0.0.1:5173');
  assert.throws(()=>parseArgs(['--headed']));
});
test('health and frontend identity are both required, with bounded response sizes',async t=>{
  let mode='ok';
  const app=await server((req,res)=>{
    if(req.url==='/api/health') res.end(mode==='huge'?'x'.repeat(70000):JSON.stringify(mode==='wrong'?{...healthy,app:'other'}:healthy));
    else res.end(mode==='frontend'?'<title>Other app</title>':login);
  });t.after(app.close);
  await identifyApp(app.origin);
  for(const [value,code]of [['wrong','APP_IDENTITY_MISMATCH'],['frontend','APP_FRONTEND_MISMATCH'],['huge','APP_RESPONSE_TOO_LARGE']]){
    mode=value;await assert.rejects(identifyApp(app.origin),{code});
  }
});
test('identity fetch refuses redirects without contacting their target',async t=>{
  let hits=0;const destination=await server((req,res)=>{hits++;res.end('private');});t.after(destination.close);
  const app=await server((req,res)=>{res.writeHead(302,{Location:destination.origin});res.end();});t.after(app.close);
  await assert.rejects(identifyApp(app.origin),{code:'APP_NOT_READY'});assert.equal(hits,0);
});
test('browser requests are exact-origin GET-only and cannot reach API, auth or other ports',()=>{
  const app='http://localhost:5173',probe='http://127.0.0.1:5001';
  for(const [url,method]of [[app+'/api/company','GET'],[app+'/api','GET'],[app+'/login','POST'],['http://localhost:5174/src/x','GET'],['https://example.com','GET'],[app+'/oauth/callback','GET'],[probe+'/download?secret=x','GET']])assert.equal(allowedRequest(url,method,app,probe),false);
  assert.equal(allowedRequest(app+'/src/App.jsx?t=1','GET',app,probe),true);
  assert.equal(allowedRequest(probe+'/download','GET',app,probe),true);
  const project=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Z]:))/, '$1')),'../..').replaceAll('\\','/');
  assert.equal(allowedRequest(app+'/@fs/'+project+'/node_modules/vite/dist/client/env.mjs','GET',app,probe),true);
  assert.equal(allowedRequest(app+'/@fs/'+project+'/docs/discovery/catalog.v1.json','GET',app,probe),true);
  assert.equal(allowedRequest(app+'/@fs/'+project+'/.env','GET',app,probe),false);
});
test('allowed asset redirect is blocked before following it',async t=>{
  let hits=0,aborted=false,fulfilled=false;
  const target=await server((req,res)=>{hits++;res.end('unrelated');});t.after(target.close);
  const app=await server((req,res)=>{res.writeHead(302,{Location:target.origin});res.end();});t.after(app.close);
  await enforceRequest({request:()=>({url:()=>app.origin+'/src/main.jsx',method:()=> 'GET'}),
    fetch:async options=>{assert.equal(options.maxRedirects,0);const r=await fetch(app.origin+'/src/main.jsx',{redirect:'manual'});return{status:()=>r.status};},
    abort:async()=>{aborted=true;},fulfill:async()=>{fulfilled=true;}
  },app.origin,'http://127.0.0.1:5001');
  assert.equal(hits,0);assert.ok(aborted);assert.equal(fulfilled,false);
});
test('child environment excludes credentials and tool/browser injection settings',()=>{
  assert.deepEqual(safeEnvironment({SystemRoot:'C:/Windows',TEMP:'tmp',OPENAI_API_KEY:'secret',NODE_OPTIONS:'injected',PW_TEST_CONNECT_WS_ENDPOINT:'remote',AGENT_BROWSER_SESSION:'qbo-ops'}),{SystemRoot:'C:/Windows',TEMP:'tmp'});
});
function browserDouble({hangDownload=false,captureFailure=false,cleanupFailure=false,lateContext=false}={},t){
  const state={contextClosed:false,browserClosed:false,nativeClosed:false,authenticated:false,url:'',routes:[]};
  let cancelDownload;
  const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},goto:async url=>{state.url=url;},url:()=>state.url,
    waitForEvent:async()=>({saveAs:async file=>{
      if(hangDownload)return new Promise((resolve,reject)=>{cancelDownload=()=>reject(new Error('closed'));});
      const response=await fetch(new URL('/download',state.url));await fs.writeFile(file,Buffer.from(await response.arrayBuffer()));
    }}),locator:selector=>({click:async()=>{},inputValue:async()=>{assert.ok(['#email','#password'].includes(selector));return '';}}),
    getByRole:()=>({waitFor:async()=>{}}),screenshot:async({path:file})=>{
      if(captureFailure)throw new Error('private-token-do-not-print');
      await fs.writeFile(file,Buffer.from([137,80,78,71,13,10,26,10,1]));
    },reload:async()=>{}};
  const context={route:async(...args)=>state.routes.push(args),routeWebSocket:async()=>{},addInitScript:async()=>{},newPage:async()=>page,
    close:async()=>{state.contextClosed=true;cancelDownload?.();if(cleanupFailure)throw new Error('close failed');}};
  const browser={newContext:async opts=>{assert.equal(opts.serviceWorkers,'block');if(lateContext)await new Promise(r=>setTimeout(r,80));return context;},
    close:async()=>{state.browserClosed=true;cancelDownload?.();},isConnected:()=>!state.browserClosed};
  return {state,adapters:{fetch:fakeFetch,findChrome:async()=> 'owned-chrome',
    launch:async(exe,profile)=>{t?.after(async()=>{const resolved=path.resolve(profile);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('tdl-browser-check-'));await fs.rm(resolved,{recursive:true,force:true});});return({endpoint:'http://127.0.0.1:9999',exited:()=>state.nativeClosed,close:async()=>{state.nativeClosed=true;cancelDownload?.();}});},
    chromium:{connectOverCDP:async()=>browser}}};
}
test('successful readiness requires sign-in and never becomes feature acceptance',async t=>{
  const root=await scratch(t),{state,adapters}=browserDouble({},t);
  const result=await checkAppBrowser({root},adapters);
  assert.equal(result.status,'ready-needs-sign-in');assert.equal(result.authenticationRequired,true);
  assert.equal(result.featureAcceptanceVerified,false);assert.equal(result.readyForAuthenticatedAcceptance,false);
  assert.equal(result.cleanupVerified,true);assert.ok(state.contextClosed&&state.browserClosed&&state.nativeClosed);
  assert.equal((await fs.readFile(path.join(result.artifactDirectory,'result.json'),'utf8')).includes('private-token'),false);
});
test('capture failure retains stage and cleans up without printing raw errors',async t=>{
  const root=await scratch(t),{state,adapters}=browserDouble({captureFailure:true},t);
  const result=await checkAppBrowser({root},adapters);
  assert.equal(result.status,'failed');assert.equal(result.code,'DESKTOP_CAPTURE_FAILED');assert.equal(result.failedStage,'desktop-capture');
  assert.equal(result.cleanupVerified,true);assert.ok(state.nativeClosed);assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('overall timeout cancels a stuck download and verifies owned cleanup',async t=>{
  const root=await scratch(t),{state,adapters}=browserDouble({hangDownload:true},t);
  const result=await checkAppBrowser({root},{...adapters,timeoutMs:150});
  assert.equal(result.code,'BROWSER_CHECK_TIMEOUT');assert.equal(result.status,'failed');assert.equal(result.cleanupVerified,true);
  assert.ok(state.contextClosed&&state.browserClosed&&state.nativeClosed);assert.equal(result.featureAcceptanceVerified,false);
});
test('late context is closed after timeout and cannot turn the result into success',async t=>{
  const root=await scratch(t),{state,adapters}=browserDouble({lateContext:true},t);
  const result=await checkAppBrowser({root},{...adapters,timeoutMs:30});
  assert.equal(result.status,'failed');assert.equal(result.code,'BROWSER_CHECK_TIMEOUT');assert.equal(result.cleanupVerified,true);assert.ok(state.contextClosed);
});
test('uncertain cleanup forces failure even if readiness checks passed',async t=>{
  const root=await scratch(t),{adapters}=browserDouble({cleanupFailure:true},t);
  const result=await checkAppBrowser({root},adapters);assert.equal(result.status,'failed');assert.equal(result.code,'CLEANUP_UNVERIFIED');assert.equal(result.cleanupVerified,false);
});
test('owned launcher uses hidden shell-free arguments and only its own PID for cleanup',async t=>{
  const profile=await scratch(t);await fs.writeFile(path.join(profile,'DevToolsActivePort'),'45678\n/devtools/browser/owned-test\n');
  const child=new EventEmitter();child.pid=987654;const calls=[];
  const owned=await launchOwnedChrome('chrome.exe',profile,{}, {
    spawn:(exe,args,options)=>{calls.push({exe,args,options});child.kill=()=>{child.emit('close');};return child;},
    execFile:(exe,args,options,callback)=>{calls.push({exe,args,options});child.emit('close');callback(null);}
  });await owned.close();
  assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.shell,false);
  assert.ok(calls[0].args.includes('--disable-background-networking'));assert.ok(calls[0].args.includes('--disable-extensions'));
  assert.ok(calls[0].args.includes('--headless=new'));assert.ok(calls[0].args.includes('--user-data-dir='+profile));assert.ok(owned.exited());
  if(process.platform==='win32'){assert.deepEqual(calls[1].args,['/PID','987654','/T','/F']);assert.equal(calls[1].options.windowsHide,true);assert.equal(calls[1].options.shell,false);assert.deepEqual(calls[1].options.env,{});assert.ok(path.isAbsolute(calls[1].exe));assert.equal(path.basename(calls[1].exe),'taskkill.exe');}
});
