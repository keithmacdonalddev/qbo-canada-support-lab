'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const cap=require('../src/modules/business-capability-review');
const beliefs=require('../src/modules/business-agent-beliefs');
const accountability=require('../src/modules/business-agent-accountability');
const {createBusinessAgentTools}=require('../src/modules/business-agent-tools');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},row={_id:'b'.repeat(24),ownerId:'c'.repeat(24),settings:{},grant:{id:'d'.repeat(64),authorityHash:'e'.repeat(64)}};
const query=value=>({select(){return this},sort(){return this},limit(){return this},maxTimeMS(){return this},lean:async()=>structuredClone(value)});
test('append-only lifecycle supports repeated resolution, reopening and evidence without invented verification',()=>{
 let entries=[{id:'request',at:'2026-10-31T00:00:00Z',kind:'capability-request',key:'sales',status:'open'}];let keys=[];
 for(const [i,status]of ['in-progress','resolved','reopened','resolved'].entries()){
  const prior=cap.fold(entries)[0],value=cap.reviewEvent({status,evidence:['commit abc'],outcomeVerified:true},prior);keys.push(value.key);entries.push({id:String(i),at:'2026-10-31T0'+(i+1)+':00:00Z',kind:'capability-review',...value.data});
 }
 assert.equal(new Set(keys).size,4);assert.equal(cap.fold(entries)[0].status,'resolved');assert.equal(cap.fold(entries)[0].outcomeVerified,false);assert.equal(entries[0].status,'open');
 assert.throws(()=>cap.reviewEvent({status:'resolved'},entries[0]),/evidence/);
});
test('reopened action failures survive broad release/module availability',async()=>{
 const entries=[{id:'1',kind:'capability-request',key:'foreign-currency-bills',at:'1'},{id:'2',kind:'capability-review',key:'foreign-currency-bills',status:'reopened',at:'2'}];let events=0;
 await cap.reconcile({requests:entries,checks:{roles:[]},models:{},scope,toolNames:['manageQboRecord'],event:async()=>events++});assert.equal(events,0);
});
test('unavailable diagnostics and stale mirror never assert cleared blockers',async()=>{
 const state=await beliefs.checkBeliefs({models:{},scope,ownerId:row.ownerId,business:{diagnosticsUnavailable:true},sync:{status:'stale'}});
 assert.equal(state.blockersKnown,false);assert.doesNotMatch(beliefs.memoryForReview('Validation repairs still block sales',state),/report no blockers/);assert.match(beliefs.memoryForReview('old claim',state),/expires/);
});
test('all new tools dispatch, preserve checklist manual boundaries and scope',async()=>{
 let calls=[],events=[];const store={models:{Runs:{find:filter=>{assert.equal(filter.realmId,scope.realmId);assert.equal(filter['agentAuthority.agentId'],row._id);return query([])}}},capabilityRequests:async()=>[{id:'r',kind:'capability-request',key:'test-tool',at:'1'}],event:async(target,kind,title,detail,data)=>{events.push({kind,data});return {id:'f'.repeat(24),...data}}};
 const tools=createBusinessAgentTools({row,scope,passId:'pass',store,user:{id:row.ownerId},guard:async()=>{},access:{authorize:async()=>{}},readTools:{toolDefinitions:[]},governanceFor:()=>({getCloseChecklist:async(u,i)=>{calls.push(i);return {items:[]}},recordCloseChecklistEvidence:async(u,i)=>{calls.push(i);assert.equal(i.attestation,null);return {id:'e'}}})});
 assert.equal((await tools.execute('findBusinessOperation',{decisionKey:'same-exact-key'})).data.operations.length,0);
 assert.equal((await tools.execute('getCloseChecklist',{period:'2026-10'})).success,true);
 await tools.execute('reviewCapability',{key:'test-tool',status:'in-progress',evidence:['tool check']});assert.ok(events.some(e=>e.kind==='capability-review'));
 await tools.execute('recordCloseChecklistEvidence',{period:'2026-10',contextHash:'1'.repeat(64),accountId:null,checkKey:'records',expectedRevision:0,requestKey:'request-checklist-01',note:'Reviewed the original retained company evidence.',disposition:'review',evidenceReferences:[]});
 assert.equal(calls.length,2);assert.ok(events.some(e=>e.kind==='accountant-write-decision'));
 const specialist=createBusinessAgentTools({row,scope,role:'receivables',readTools:{toolDefinitions:[]}});assert.equal(specialist.definitions.some(t=>['reviewCapability','recordCloseChecklistEvidence'].includes(t.name)),false);
});
test('write rationale preserves explicit plan intent and never chooses an unrelated first change',()=>{
 const d=accountability.decisionData({name:'manageQboRecord',input:{decisionKey:'same-key',purpose:'Collect overdue balances'},plan:{id:'plan',changes:[{change:'Buy unrelated stock'}]},day:'2026-10-31'});
 assert.equal(d.decisionKey,'same-key');assert.doesNotMatch(d.planItem,/Buy unrelated/);assert.match(d.reason,/Collect/);
 const explicit=accountability.decisionData({name:'manageQboRecord',input:{purpose:'Collect',decision:{goal:'Cash collection',planItem:'AR-3'}},day:'2026-10-31'});assert.equal(explicit.goal,'Cash collection');assert.equal(explicit.planItem,'AR-3');
});
test('durable result keeps saved QBO ids without raw payloads and retains empty lookup outcomes',async()=>{
 let events=[];const store={models:{Runs:{find:()=>query([])},GeneralWriteRuns:{find:()=>query([{_id:'run',status:'complete',items:{sale:{entity:'Invoice',qboId:'123',outcome:'saved',record:{secret:'private'}}}}])}},event:async(r,k,t,detail,data)=>events.push({k,data})};
 await accountability.retainOutcome({store,row,scope,decision:{id:'intent',decisionKey:'key',reason:'Real sale'}});assert.equal(events[0].data.records[0].id,'123');assert.doesNotMatch(JSON.stringify(events),/private/);
});
test('scorecard distinguishes unknown data, a missing baseline and real coverage growth',()=>{
 const snapshot={asOf:'2026-10-31T12:00:00Z',situations:{rows:[{key:'partial',presentAtAll:true,evidence:{complete:true}},{key:'unknown',presentAtAll:true,evidence:{complete:false}}]},weekly:{rows:[{status:'unknown'},{status:'missing'}]},collections:{count:2,cents:30000}};
 const args={day:'2026-10-31',today:{saved:10,verified:9,target:220},snapshot,blockers:{unavailable:true},business:{verifiedThrough:'2026-10-30'}};
 const first=accountability.scorecard(args);assert.equal(first.situations.newlyCovered,null);assert.equal(first.blockers,null);assert.equal(first.collections.count,2);assert.equal(accountability.scorecard({...args,prior:{coveredKeys:[]}}).situations.newlyCovered,1);
});
test('owner intent reader caches by mtime and fails soft to the complete embedded owner intent',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{createOwnerIntentReader,FALLBACK}=require('../src/modules/business-owner-intent');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qbo-intent-test-')),file=path.join(dir,'AGENTS.md');try{const get=createOwnerIntentReader(file);assert.equal(get(),FALLBACK);await fs.writeFile(file,'## Owner intent\n1. First intent\n## Other\nprivate');assert.match(get(),/First intent/);await fs.writeFile(file,'## Owner intent\n1. Changed intent\n## Other\nprivate');await fs.utimes(file,new Date(),new Date(Date.now()+2000));assert.match(get(),/Changed intent/);assert.doesNotMatch(get(),/private/);}finally{await fs.rm(dir,{recursive:true,force:true})}
});

test('deleted records stay in situation analysis but cannot inflate volume, aging or collections',async()=>{
 const management=require('../src/modules/business-management-review'),day='2026-10-31';
 const rows=[{entity:'Payment',qboId:'1',deleted:true,record:{Id:'1',TxnDate:day,TotalAmt:300}},{entity:'Invoice',qboId:'2',record:{Id:'2',TxnDate:day,Balance:200,TotalAmt:200,status:'Deleted'}}];
 const snapshot=await management.snapshotFor({...scope,realmId:'deleted-test'},{Records:{find:()=>query(rows)},nowMs:Date.parse(day+'T15:00:00Z'),refresh:true});assert.equal(snapshot.collections.count,0);assert.equal(snapshot.measures.today.records,0);assert.equal(snapshot.measures.receivables.open,0);
});

test('an interrupted QBO-id chunk cannot mark a pending decision reconciled',async()=>{
 const events=[],store={models:{Runs:{find:()=>query([])},GeneralWriteRuns:{find:()=>query([{_id:'run',status:'complete',items:Object.fromEntries(Array.from({length:101},(_,i)=>['ref'+i,{qboId:String(i+1),entity:'Invoice',outcome:'saved'}]))}])}},event:async(r,kind,title,detail,data)=>{if(kind==='accountant-write-outcome'&&data.offset===100)throw new Error('storage temporarily unavailable');events.push({kind,data})}};
 await assert.rejects(accountability.retainOutcome({store,row,scope,decision:{id:'pending',decisionKey:'original-key',reason:'Real sale'}}),/storage/);assert.ok(!events.some(e=>e.kind==='accountant-write-outcome-complete'));
});
