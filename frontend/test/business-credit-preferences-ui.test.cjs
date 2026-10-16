'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const {fixture,scope,ownerId}=require('../../backend/test/helpers/business-governance-fixture');
const {createBusinessExecutionService}=require('../../backend/src/modules/business-execution-service');
const {draftView,proposalView}=require('../../backend/src/modules/blueprint-draft');
const {AUTOMATIC_CREDITS_MESSAGE}=require('../../backend/src/modules/qbo-write-period');
const config=require('../../backend/src/config'),dist=path.resolve(__dirname,'../dist'),artifacts=path.resolve(__dirname,'../../artifacts/intent-ui');
test('desktop owner sees the automatic-credit refusal and explicitly continues the same saved operation after correcting the setting',{timeout:120000},async()=>{
 const previous=config.qbo.environment;config.qbo.environment='sandbox';const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true,originalSdkTransport:true});await h.publish();
 const plan=await h.service.prepare(h.user,{requestKey:'credit-preference-desktop-001',throughDate:'2026-10-08'});await h.service.approve(h.user,plan.operationId,{planHash:plan.planHash});h.autoApplyCredit=true;let invoicePosts=0;h.beforePost=async opts=>{if(opts.url.endsWith('/invoice'))invoicePosts++;};
 const service=createBusinessExecutionService({models:h.models,transaction:h.transaction,assertReady:h.assertReady,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,...scope}}),accessFor:h.accessFor,runtimeFor:input=>h.runtime(input.operationId),now:()=>h.clock});
 await fs.mkdir(artifacts,{recursive:true});const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://fixture').pathname,file=pathname.startsWith('/assets/')?path.resolve(dist,'.'+pathname):path.join(dist,'index.html');if(!file.startsWith(dist+path.sep))throw Error('outside fixture');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end('Fixture asset unavailable');}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;const escaped=[],errors=[],executions=[],unexpected=[];
 try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('token','isolated-credit-preference-ui'));page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));const origin='http://127.0.0.1:'+server.address().port;
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){escaped.push(req.url());return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();let status=200,body;const key=url.pathname.slice(5);
   try{
    if(req.method()==='POST'){
     if(key!=='business-operations/'+plan.operationId+'/execute'){unexpected.push(key);status=403;body={error:'Outside isolated owner execution'};}
     else{const input=req.postDataJSON();executions.push(input);body={data:await service.request(h.user,plan.operationId,input)};}
    }else if(req.method()!=='GET'){unexpected.push(key);status=403;body={error:'Outside isolated workflow'};}
    else if(key==='auth/me')body={user:{id:ownerId,role:'agent',displayName:'Fixture Owner'}};
    else if(key==='qbo/status')body={connected:true,status:'active',...scope,companyName:'Fixture Harbour Business'};
    else if(key==='business-operations')body={data:await service.list(h.user)};
    else if(key==='business-operations/'+plan.operationId)body={data:await service.inspect(h.user,plan.operationId)};
    else if(key==='company/business-governance')body={data:await h.service.status(h.user)};
    else if(key==='company/business-plan')body={data:{...scope,proposal:proposalView(),draft:draftView(h.data.Versions[0],scope.connectionId),mappingDefinitions:{},masterDefinitions:{},activationNeeds:[],storage:{ready:true},permissionToSave:false,canSave:false}};
    else if(key==='company/business-baseline')body={data:{scope,records:[],canCapture:false,next:null}};
    else{status=503;body={error:'Outside isolated credit-preference workflow'};}
   }catch(error){status=error.status||500;body={error:error.message,code:error.code};}await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(origin+'/company');const operations=page.getByRole('region',{name:'Business operations',exact:true});await operations.getByRole('button',{name:/Inspect operation/}).first().click();const detail=operations.getByRole('region',{name:'Selected operation',exact:true});await detail.getByRole('button',{name:'Run saved operation',exact:true}).waitFor();
  let reply=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/execute'));await detail.getByRole('button',{name:'Run saved operation',exact:true}).focus();await page.keyboard.press('Enter');await reply;await service.idle();await operations.getByRole('button',{name:'Refresh operations',exact:true}).click();await detail.getByText(AUTOMATIC_CREDITS_MESSAGE,{exact:true}).waitFor();await detail.getByText('Needs attention',{exact:true}).waitFor();assert.equal(invoicePosts,0);assert.equal(h.data.Writers[0].unresolved,null);assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(await detail.getByText(/A QuickBooks request still needs its outcome checked/).count(),0);assert.equal(executions.length,1);
  const capture=async name=>{await detail.evaluate(el=>window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-100,behavior:'instant'}));await page.screenshot({path:path.join(artifacts,name)});};await capture('business-credit-preference-refused-viewport.png');
  const posts=h.posts;h.autoApplyCredit=false;await service.idle();assert.equal(h.posts,posts);assert.equal(invoicePosts,0);reply=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/execute'));await detail.getByRole('button',{name:'Continue saved operation',exact:true}).click();await reply;await service.idle();await operations.getByRole('button',{name:'Refresh operations',exact:true}).click();await detail.getByText('Verified',{exact:true}).waitFor();await detail.getByText('Selected account movements · passed',{exact:true}).waitFor();assert.equal(executions.length,2);assert.notEqual(executions[0].requestKey,executions[1].requestKey);assert.equal(h.posts,h.data.Plans[0].manifest.createCount);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-08');assert.equal(await detail.getByText(AUTOMATIC_CREDITS_MESSAGE,{exact:true}).count(),0);await capture('business-credit-preference-completed-viewport.png');
  const completed=h.posts;await page.reload();await operations.getByRole('button',{name:/Inspect operation/}).first().click();await detail.getByText('Verified',{exact:true}).waitFor();assert.equal(h.posts,completed);assert.deepEqual(escaped,[]);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 }catch(error){if(page){await page.screenshot({path:path.join(artifacts,'business-credit-preference-ui-failure.png')});await fs.writeFile(path.join(artifacts,'business-credit-preference-ui-failure.txt'),await page.locator('body').innerText());}throw error;}
 finally{await browser?.close();service.close();await service.idle();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});config.qbo.environment=previous;}
});
