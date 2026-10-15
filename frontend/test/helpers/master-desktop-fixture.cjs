'use strict';
process.env.QBO_ENVIRONMENT='production';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const {fixture,scope,ownerId}=require('../../../backend/test/helpers/master-service-fixture');
const {proposalView,draftView,MAPPINGS}=require('../../../backend/src/modules/blueprint-draft');
const {masterRequirements}=require('../../../backend/src/modules/business-master-data');
const {writeBlueprintDraft}=require('../../../backend/src/modules/blueprint-draft-write');
const artifacts=path.resolve(__dirname,'../../../artifacts/intent-ui');
async function desktop(t,work){
 const h=fixture(t),dist=path.resolve(__dirname,'../../dist'),escaped=[],errors=[],reconciliationWarnings=[],writes=[];h.releases=new Set();await fs.mkdir(artifacts,{recursive:true});
 const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://fixture').pathname,file=pathname.startsWith('/assets/')?path.resolve(dist,'.'+pathname):path.join(dist,'index.html');if(!file.startsWith(dist+path.sep))throw Error('outside fixture');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end('Fixture asset unavailable');}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;
 try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('token','isolated-master-fixture-token'));page=await context.newPage();const origin='http://127.0.0.1:'+server.address().port;page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(/same key|unique.*key|Encountered two children/i.test(message.text()))reconciliationWarnings.push(message.text());});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==origin){escaped.push(request.url());return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();
   const key=url.pathname.slice(5),body=request.method()==='POST'?request.postDataJSON():undefined;if(body)writes.push({key,body});let status=200,data;
   try{
    if(key==='auth/me')data={user:{id:h.user.actorId||ownerId,displayName:'Fixture Owner',role:'agent'}};
    else if(key==='qbo/status')data={connected:true,status:'active',...scope,companyName:'Fixture Harbour Business'};
    else if(key==='company/business-setup')data={data:{...scope,companyName:'Fixture Harbour Business',owner:true,storage:{ready:true},coordination:{state:'active',periodControl:h.data.Policies[0].periodControl}}};
    else if(key==='company/business-plan'){
     if(body){const value=await h.transaction(session=>writeBlueprintDraft({...h.models,scope,ownerId,actorId:ownerId,input:body,session}));data={data:{...scope,draft:draftView(value,scope.connectionId)}};}
     else{const saved=[...h.data.Versions].sort((a,b)=>b.version-a.version)[0],draft=draftView(saved,scope.connectionId);data={data:{...scope,companyName:'Fixture Harbour Business',draft,proposal:proposalView(),mappingDefinitions:MAPPINGS,masterDefinitions:Object.fromEntries(['development','flagship'].map(volumeProfile=>[volumeProfile,masterRequirements({...draft.business,volumeProfile})])),activationNeeds:[],permissionToSave:!h.user.actorId,canSave:!h.user.actorId,storage:{ready:true}}};}
    }else if(key.startsWith('company/business-master-preparation')){
     const suffix=key.slice('company/business-master-preparation'.length);let value;
     if(!suffix)value=await h.service.status(h.user);
     else if(suffix==='/history')value=await h.service.history(h.user,body);
     else if(suffix==='/storage/preview')value=await h.service.storagePreview(h.user);
     else if(suffix==='/storage/apply'){value=await h.service.storageApply(h.user,body);h.unprepared=false;}
     else if(suffix==='/prepare'){value=await h.service.prepare(h.user,body);const saved=value.run&&h.data.MasterRuns.find(row=>String(row._id)===value.run.id);if(saved&&!saved.createdAt)saved.createdAt=new Date(h.clock++);}
     else{const parts=suffix.slice(1).split('/'),id=parts.shift(),action=parts.join('/'),method={'apply-review':'applyReview','unknown/review':'attributionReview','unknown/attribute':'attribute'}[action]||action;value=body===undefined?await h.service.inspect(h.user,id):await h.service[method](h.user,id,body);}
     data={data:value};
     if(h.loseApproval&&suffix.endsWith('/approve')){h.loseApproval=false;status=503;data={error:'Fixture lost approval acknowledgement. Check saved progress.'};}
     if(h.loseApply&&suffix.endsWith('/apply')&&!suffix.startsWith('/storage/')){h.loseApply=false;status=503;data={error:'Fixture lost draft acknowledgement. Check saved progress.'};}
     if(h.statusError&&!suffix){status=503;data={error:'Fixture progress read failed.'};}
    }else{status=503;data={error:'Panel outside this isolated master workflow.'};}
   }catch(error){status=[400,403,404,409,503].includes(error.status)?error.status:500;data={error:error.message};}
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  const panel=page.getByRole('region',{name:'Business record preparation'}),plan=page.getByRole('region',{name:'Business plan'});
  const hold=number=>{let release;const promise=new Promise(resolve=>{release=resolve;});h.releases.add(release);h.afterCreate=async()=>{if(h.sent.length===number)await promise;};return()=>{h.releases.delete(release);release();};};
  await work({h,page,panel,plan,context,origin,writes,hold,screenshot:async name=>{await panel.evaluate(element=>window.scrollTo({top:element.getBoundingClientRect().top+window.scrollY-110,behavior:'instant'}));await page.screenshot({path:path.join(artifacts,name.replace('.png','-viewport.png'))});return panel.screenshot({path:path.join(artifacts,name)});}});
  assert.deepEqual(escaped,[]);assert.deepEqual(errors,[]);assert.deepEqual(reconciliationWarnings,[]);assert.equal(await plan.count(),1,'one business-plan panel after setup refreshes');assert.equal(await panel.count(),1,'one record-preparation panel after setup refreshes');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'desktop page has no horizontal overflow');await context.close();
 }catch(error){if(page){await page.screenshot({path:path.join(artifacts,'master-desktop-failure.png'),fullPage:true}).catch(()=>{});console.error(JSON.stringify({fixture:'master-desktop',errors,reconciliationWarnings,body:await page.locator('body').innerText().catch(()=>'(unavailable)')}));}throw error;}finally{for(const release of h.releases)release();await h.service.idle();h.service.close();if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
module.exports={desktop,scope,ownerId,artifacts};
