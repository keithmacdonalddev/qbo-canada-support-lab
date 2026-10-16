'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const {fixture,scope,ownerId}=require('../../backend/test/helpers/business-stock-fixture');
const {createBusinessExecutionService}=require('../../backend/src/modules/business-execution-service');
const {draftView,proposalView}=require('../../backend/src/modules/blueprint-draft');
const dist=path.resolve(__dirname,'../dist'),artifacts=path.resolve(__dirname,'../../artifacts/intent-ui');
async function desktop(t,h,{allowReview=false}={}){
 const service=createBusinessExecutionService({models:h.models,transaction:h.transaction,assertReady:h.assertReady,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,...scope}}),accessFor:h.accessFor,runtimeFor:input=>h.runtime(input.operationId),now:()=>h.clock});
 const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://fixture').pathname,file=pathname.startsWith('/assets/')?path.resolve(dist,'.'+pathname):path.join(dist,'index.html');if(!file.startsWith(dist+path.sep))throw Error('Outside fixture');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end('Fixture asset unavailable');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser; t.after(async()=>{await browser?.close();service.close();await service.idle();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}); browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}}),origin='http://127.0.0.1:'+server.address().port,escaped=[],errors=[],writes=[];
 await context.addInitScript(()=>localStorage.setItem('token','isolated-stock-cost-ui'));const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin){escaped.push(request.url());return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();
  let status=200,body;const key=url.pathname.slice(5);
  try{
   if(request.method()!=='GET'){
    writes.push(key);if(allowReview&&request.method()==='POST'&&key==='company/business-governance/publication/review')body={data:await h.service.reviewPublication(h.user,request.postDataJSON())};else{status=403;body={error:'Outside isolated read/review surface'};}
   }else if(key==='auth/me')body={user:{id:ownerId,role:'agent',displayName:'Fixture Owner'}};
   else if(key==='qbo/status')body={connected:true,status:'active',...scope,companyName:'Fixture Harbour Business'};
   else if(key==='business-operations')body={data:await service.list(h.user)};
   else if(key.startsWith('business-operations/'))body={data:await service.inspect(h.user,key.split('/')[1])};
   else if(key==='company/business-governance')body={data:await h.service.status(h.user)};
   else if(key==='company/business-plan')body={data:{...scope,proposal:proposalView(),draft:draftView(h.data.Versions.at(-1),scope.connectionId),mappingDefinitions:{},masterDefinitions:{},activationNeeds:[],storage:{ready:true},permissionToSave:true,canSave:true}};
   else if(key==='company/business-baseline')body={data:{scope,records:h.data.Baselines.map(row=>({id:String(row._id),...row.payload})),canCapture:false,next:null}};
   else{status=503;body={error:'Outside isolated stock inspection'};}
  }catch(error){status=error.status||500;body={error:error.message};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await fs.mkdir(artifacts,{recursive:true});const screenshot=async(name,panel)=>{await panel.evaluate(el=>window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-100,behavior:'instant'}));await page.screenshot({path:path.join(artifacts,name)});};
 return{page,origin,escaped,errors,writes,screenshot};
}
test('desktop original operation shows failed, passed and integrity-unavailable stock evidence with no browser accounting writes',{timeout:180000},async t=>{
 const h=await fixture(t);await h.publish();const p=await h.service.prepare(h.user,{requestKey:'stock-rendered-flow-0001',throughDate:'2026-10-08'});await h.service.approve(h.user,p.operationId,{planHash:p.planHash,confirmProduction:true});let changed=false,original=null,id=null;
 h.afterPost=(_opts,record)=>{if(!changed&&h.saleCosts.has(record.Id)){changed=true;id=record.Id;original=h.saleCosts.get(id);h.saleCosts.set(id,original+1);}};const runtime=h.runtime(p.operationId);assert.equal((await runtime.execute()).complete,false);const posts=h.posts,ui=await desktop(t,h);
 try{
  await ui.page.goto(ui.origin+'/company');const operations=ui.page.getByRole('region',{name:'Business operations',exact:true});await operations.getByRole('button',{name:/Inspect operation/}).first().focus();await ui.page.keyboard.press('Enter');const panel=operations.getByRole('region',{name:'Stock cost evidence',exact:true});
  await panel.getByRole('heading',{name:'Stock costs · failed',exact:true}).waitFor();assert.equal(await panel.getByRole('row').count(),9);await panel.getByRole('cell',{name:'-$1.00',exact:true}).waitFor();await panel.getByText(/oldest purchases/).waitFor();await ui.screenshot('business-stock-failed-viewport.png',panel);
  h.afterPost=null;h.saleCosts.set(id,original);assert.equal((await runtime.execute()).complete,true);assert.equal(h.posts,posts);await operations.getByRole('button',{name:'Refresh operations',exact:true}).click();await panel.getByRole('heading',{name:'Stock costs · passed',exact:true}).waitFor();assert.equal(await panel.getByRole('cell',{name:'$0.00',exact:true}).count()>=2,true);await ui.screenshot('business-stock-passed-viewport.png',panel);
  const row=h.data.Evidence.at(-1);h.data.Audits=h.data.Audits.filter(a=>a._id!==row.auditId);await operations.getByRole('button',{name:'Refresh operations',exact:true}).click();await panel.getByRole('heading',{name:'Stock costs · evidence unavailable',exact:true}).waitFor();await panel.getByText(/Progress and Stop remain available/).waitFor();assert.equal(await panel.getByRole('row').count(),0);assert.equal(await panel.getByRole('heading',{name:'Stock costs · passed',exact:true}).count(),0);await ui.screenshot('business-stock-unavailable-viewport.png',panel);
  assert.deepEqual(ui.errors,[]);assert.deepEqual(ui.escaped,[]);assert.deepEqual(ui.writes,[]);assert.equal(h.posts,posts);
 }catch(error){await ui.page.screenshot({path:path.join(artifacts,'business-stock-ui-failure.png')});await fs.writeFile(path.join(artifacts,'business-stock-ui-failure.txt'),await ui.page.locator('body').innerText());throw error;}
});
test('desktop method/tax inputs are explicit and a removed policy clears exact publication review and consent',{timeout:180000},async t=>{
 const h=await fixture(t);await h.capture();const ui=await desktop(t,h,{allowReview:true});
 try{
  await ui.page.goto(ui.origin+'/company');const plan=ui.page.getByRole('region',{name:'Business plan',exact:true}),group=plan.getByRole('group',{name:'Stock costs',exact:true}),save=plan.getByRole('button',{name:'Save new draft version',exact:true});
  await group.getByLabel('Where you confirmed FIFO in QuickBooks',{exact:true}).waitFor();const reference=group.getByLabel('Where you confirmed FIFO in QuickBooks',{exact:true}),before=await reference.inputValue();await reference.fill('');assert.equal(await save.isDisabled(),true);await group.getByText(/Complete both evidence references and dates/).waitFor();await reference.fill(before);assert.equal(await save.isEnabled(),true);
  const enabled=group.getByRole('checkbox',{name:'Require stock value and cost-of-sales checks before the calendar advances',exact:true});await enabled.uncheck();await group.getByText('Stock-cost verification is not included in this draft.',{exact:true}).waitFor();await enabled.check();assert.equal(await save.isDisabled(),true);
  await group.getByLabel('Where you confirmed FIFO in QuickBooks',{exact:true}).fill('Owner inspected inventory method in company settings');await group.getByLabel('Method checked on',{exact:true}).fill('2026-10-15');await group.getByLabel('Purchase-tax treatment evidence',{exact:true}).fill('Owner confirmed fully recoverable HST for stock purchases');await group.getByLabel('Tax treatment confirmed on',{exact:true}).fill('2026-10-15');await group.getByRole('checkbox',{name:'Purchase tax is fully recoverable and adds no cost to these products',exact:true}).check();assert.equal(await save.isEnabled(),true);await ui.screenshot('business-stock-policy-viewport.png',group);
  const maintenance=ui.page.getByRole('region',{name:'Business publication and calendar',exact:true});await maintenance.getByLabel('Opening observation',{exact:true}).selectOption(String(h.data.Baselines[0]._id));await maintenance.getByRole('button',{name:'Review publication',exact:true}).click();await maintenance.getByRole('heading',{name:'Stock-cost checking included',exact:true}).waitFor();const accept=maintenance.getByRole('checkbox',{name:/I accept these starting balances/});await accept.check();await ui.screenshot('business-stock-publication-viewport.png',maintenance);
  const next=h.saveRevision({stockCosting:undefined});await maintenance.getByRole('button',{name:'Refresh business state',exact:true}).click();await maintenance.getByText('Saved business: '+next.definition.publicSafeIdentity.displayName+' · version '+next.version+' · opens '+next.definition.calendar.openingDate+'.',{exact:true}).waitFor();assert.equal(await maintenance.getByRole('heading',{name:'Review the starting point',exact:true}).count(),0);assert.equal(await maintenance.getByRole('heading',{name:'Stock-cost checking included',exact:true}).count(),0);assert.equal(await maintenance.getByRole('checkbox',{name:/I accept these starting balances/}).count(),0);await ui.screenshot('business-stock-review-cleared-viewport.png',maintenance);
  assert.deepEqual(ui.errors,[]);assert.deepEqual(ui.escaped,[]);assert.deepEqual(ui.writes,['company/business-governance/publication/review']);assert.equal(h.posts,0);
 }catch(error){await ui.page.screenshot({path:path.join(artifacts,'business-stock-policy-ui-failure.png')});await fs.writeFile(path.join(artifacts,'business-stock-policy-ui-failure.txt'),await ui.page.locator('body').innerText());throw error;}
});
