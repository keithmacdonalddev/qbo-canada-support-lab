'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {query,model,matches}=require('./memory.cjs');
const {normalize,digest}=require('./loader.cjs');
const {checkChoices,replayDataset}=require('./harness.cjs');
const {createRuntime,classify,safeError}=require('./runtime.cjs');
const root=path.resolve(__dirname,'../../..');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)};
const at=Date.parse('2026-10-31T23:00:00.000Z');
function choicesFixture() {
 const entities=['Account','TaxCode','Preferences','Customer','Vendor','Employee','Item'];
 const records={
   Account:{Id:'1',SyncToken:'0',Active:true,AccountType:'Bank',CurrencyRef:{value:'CAD'}},
   TaxCode:{Id:'1',SyncToken:'0',Active:true,Taxable:false},
   Preferences:{Id:'1',AccountingInfoPrefs:{},CurrencyPrefs:{HomeCurrency:{value:'CAD'}}},
   Customer:{Id:'1',SyncToken:'0',Active:true,DisplayName:'Synthetic customer',MetaData:{CreateTime:new Date(at-1000)}},
   Vendor:{Id:'1',SyncToken:'0',Active:true,DisplayName:'Synthetic vendor'},
   Employee:{Id:'1',SyncToken:'0',Active:true,DisplayName:'Synthetic worker'},
   Item:{Id:'1',SyncToken:'0',Active:true,Name:'Synthetic service',Type:'Service'}
 };
 const run={_id:'c'.repeat(24),...scope,createdBy:'b'.repeat(24),status:'blocked',createdAt:new Date(at)};
 return {root,data:{operationruns:[run],generalwriteruns:[],
   companysyncrecords:entities.map(entity=>({...scope,entity,qboId:'1',record:records[entity],deleted:false,generation:'g',lastObservedAt:new Date(at-1000)})),
   businessagents:[{...scope,sync:{sources:Object.fromEntries(entities.map(entity=>[entity,{status:'current',generation:'g',lastSuccessAt:new Date(at-1000).toISOString(),everyMs:60000}]))}}]
 },capturedAt:new Date(at)};
}
test('single-use lean thenables match Mongoose, and .exec caches a Promise',async()=>{
 const q=query([{id:1}]);assert.deepEqual(await q,[{id:1}]);await assert.rejects(async()=>await q,/already executed/);
 const promise=query([{id:2}]).lean().exec();assert.deepEqual(await promise,await promise);
});
test('memory storage refuses mutation unless explicitly isolated',async()=>{
 assert.throws(()=>model([]).create([{}]),{code:'REPLAY_STORAGE_WRITE_FORBIDDEN'});
 const m=model([],{writable:true});await m.create([{_id:'x'}]);assert.equal((await m.findOne({_id:'x'}))._id,'x');
});
test('scope and nested predicates preserve identity boundaries',()=>{
 assert.ok(matches({...scope,items:[{id:'1'}]},{...scope,'items.id':'1'}));
 assert.ok(!matches(scope,{...scope,realmId:'456'}));
 assert.throws(()=>matches({id:1},{id:{$where:'anything'}}),{code:'REPLAY_UNSUPPORTED_QUERY'});
});
test('BSON ids become strings, dates remain dates until the QBO envelope boundary',()=>{
 const input={_id:{_bsontype:'ObjectId',toHexString:()=>scope.connectionId},record:{MetaData:{CreateTime:new Date(at)}}};
 const out=normalize(input);assert.equal(out._id,scope.connectionId);assert.ok(out.record.MetaData.CreateTime instanceof Date);
});
test('current production activity readers consume concurrent queries and plain JSON',async()=>{
 const result=await checkChoices(choicesFixture());assert.equal(result.status,'passed');assert.match(result.sourceHash,/^[a-f0-9]{64}$/);
});
const oldQueryBug=(filename,source)=>filename.endsWith('business-activity-choice-client.js')?
 source.replace("maxTimeMS(3000).lean().exec();","maxTimeMS(3000).lean();"):source;
test('96fe35a test double: re-awaiting the single-use source query is caught',async()=>{
 await assert.rejects(checkChoices({...choicesFixture(),transform:oldQueryBug}),{code:'REPLAY_ACTIVITY_CHOICES_UNAVAILABLE'});
});
test('96fe35a test double: preserving Mongo Date values is caught by real canonical()',async()=>{
 const transform=(filename,source)=>filename.endsWith('business-activity-choice-client.js')?
   source.replace('JSON.parse(JSON.stringify(row.record))','structuredClone(row.record)'):source;
 await assert.rejects(checkChoices({...choicesFixture(),transform}));
});
test('same report classifier fails the gate on the activity-choice regression',async()=>{
 const f=choicesFixture(),report=await replayDataset({root,bundle:{data:f.data,capturedAt:f.capturedAt,captureHash:digest(f.data)},transform:oldQueryBug});
 assert.equal(report.passed,false);assert.equal(report.preflight[0].status,'errored');
});
test('missing as-of bodies are never substituted from a later mirror row',async()=>{
 const f=choicesFixture();f.data.companysyncrecords[0].lastObservedAt=new Date(at+1);
 const rt=createRuntime({...f,run:f.data.operationruns[0],at});
 assert.equal(rt.getRecord('Account','1'),undefined);
 await assert.rejects(rt.client.apiCall('GET','account/1'),{code:'REPLAY_AS_OF_RECORD_MISSING'});
 await assert.rejects(rt.client.apiCall('POST','invoice'),{code:'REPLAY_TRANSPORT_SEND_FORBIDDEN'});
});
test('classifies changes, refuses incomplete coverage and unresolved infrastructure',()=>{
 assert.equal(classify('accepted',[]),'same outcome');
 assert.equal(classify('accepted',[{code:'BUSINESS_REFUSED',refused:true}]),'newly refused');
 assert.equal(classify('refused',[]),'newly accepted');
 assert.equal(classify('refused',[{code:'BUSINESS_REFUSED',refused:true}]),'same outcome');
 assert.equal(classify('accepted',[{code:'REPLAY_AS_OF_RECORD_MISSING',refused:false}]),'errored');
 assert.equal(classify('accepted',[{code:'TypeError',refused:false}]),'errored');
});
test('safe error detail contains no private message, record or URI',()=>{
 const e=Object.assign(Error('secret mongodb://private.example/customer'),{code:'MONGO_TEST',record:{private:true}});
 const out=JSON.stringify(safeError(e,'fixture'));assert.ok(!out.includes('private'));assert.ok(!out.includes('mongodb'));assert.ok(!out.includes('secret'));
});
test('empty and explicitly missing selections fail instead of reporting a vacuous pass',async()=>{
 const report=await replayDataset({root,bundle:{data:{},capturedAt:new Date(at),missing:['d'.repeat(24)],captureHash:digest({})}});
 assert.equal(report.passed,false);assert.deepEqual(report.missing,['d'.repeat(24)]);
});
test('CLI parser enforces bounded IDs and unambiguous UTC selection',async()=>{
 const {parseArgs}=await import('../../../scripts/agent-harness/replay-gate.mjs');
 assert.equal(parseArgs([],at).since,'2026-10-28T23:00:00.000Z');
 assert.deepEqual(parseArgs(['--ops','c'.repeat(24),'--json'],at).ops,['c'.repeat(24)]);
 for(const args of [['--days','0'],['--since','2026-02-30'],['--since','2099-01-01'],['--ops','bad'],['--bogus'],['--days','2','--since','2026-10-30']])assert.throws(()=>parseArgs(args,at));
});
test('worker blocks network and returns only a report using actual current code',async()=>{
 const {runOffline}=await import('../../../scripts/agent-harness/replay-gate.mjs'), f=choicesFixture();
 const result=await runOffline({root,bundle:{data:f.data,capturedAt:f.capturedAt,captureHash:digest(f.data)}},15000);
 assert.equal(result.preflight[0].status,'passed',JSON.stringify(result.preflight));
 assert.equal(result.operations[0].outcome,'errored'); // Incomplete synthetic run is never approval proof.
});

test('a blocked run with a saved plan still has an accepted preparation baseline',()=>{
 const {baselineFor}=require('./harness.cjs');
 assert.equal(baselineFor({status:'blocked',planId:'a'.repeat(24)},'fixed'),'accepted');
 assert.equal(baselineFor({status:'needs-correction',plan:{operations:[{}]}},'general'),'accepted');
});
test('a newly compiled wrong amount fails against the real verification matcher',()=>{
 const {assertCompiledResponse}=require('./harness.cjs'),f=choicesFixture();
 const rt=createRuntime({...f,run:f.data.operationruns[0],at});
 const good={TxnDate:'2026-10-31',TotalAmt:10,CustomerRef:{value:'1'},Line:[{Amount:10,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'1'},Qty:1,UnitPrice:10}}]};
 const compile=payload=>({request:{body:JSON.stringify(payload)}});
 assert.doesNotThrow(()=>assertCompiledResponse(rt,compile(good),{...good,Id:'55',SyncToken:'0'}));
 const bad=structuredClone(good);bad.Line[0].Amount=20;bad.Line[0].SalesItemLineDetail.UnitPrice=20;bad.TotalAmt=20;
 assert.throws(()=>assertCompiledResponse(rt,compile(bad),good),{code:'BUSINESS_COMPILED_RESPONSE_UNVERIFIED'});
});
test('a stale pre-run mirror cannot be relabelled fresh by replay',()=>{
 const f=choicesFixture();f.data.companysyncrecords[0].lastObservedAt=new Date(at-300001);
 const rt=createRuntime({...f,run:f.data.operationruns[0],at});
 assert.equal(rt.getRecord('Account','1'),undefined);
});
test('offline worker timeout waits for child exit',async()=>{
 const {runOffline}=await import('../../../scripts/agent-harness/replay-gate.mjs'),f=choicesFixture();
 await assert.rejects(runOffline({root,bundle:{data:f.data,capturedAt:f.capturedAt}},1),{code:'REPLAY_TIMEOUT'});
});

test('saved to rejected batch items fail even without a returned QBO id',()=>{
 const {assertResponseOutcomes}=require('./harness.cjs');
 assert.throws(()=>assertResponseOutcomes({items:{sale:{outcome:'saved',qboId:'55'}}},[{ref:'sale',outcome:'rejected'}]),
   {code:'GENERAL_RESPONSE_REFUSED'});
});
test('blocked preparations cannot become successful replay stages',()=>{
 const {assertPreparedReferences}=require('./harness.cjs');
 assert.throws(()=>assertPreparedReferences({steps:[{references:[{status:'unverified'}]}]}),{code:'BUSINESS_PREPARATION_CHANGED'});
});
test('stage baselines distinguish saved compilation from an unsent failed attempt',()=>{
 const {stageBaseline,classifyStages}=require('./harness.cjs');
 const run={_id:'c'.repeat(24),status:'blocked'};
 assert.equal(stageBaseline(run,'fixed','compilation:key',{operationsteps:[{operationId:run._id,logicalKey:'key',compilation:{}}]}),'accepted');
 assert.equal(stageBaseline(run,'fixed','compilation:key',{operationsteps:[]}),'unresolved');
 assert.equal(classifyStages([],[{baseline:'accepted',code:'BUSINESS_REFUSED',refused:true}]),'newly refused');
 assert.equal(classifyStages([{baseline:'refused',status:'passed'}],[]),'newly accepted');
 assert.equal(classifyStages([],[{baseline:'unresolved',code:'BUSINESS_REFUSED',refused:true}]),'errored');
});

test('general close baselines require the same company and covered business day',()=>{
 const {stageBaseline}=require('./harness.cjs');
 const run={_id:'c'.repeat(24),...scope,day:'2026-10-31',createdAt:new Date(at-1000),items:{sale:{entity:'Invoice',qboId:'55'}}};
 const close={...scope,ok:true,fromDate:'2026-10-31',throughDate:'2026-10-31',verifiedAt:new Date(at),records:[{key:'Invoice:55'}]};
 const baseline=c=>stageBaseline(run,'general','after-save-readback-and-ledger',{generaldaycloses:[c]});
 assert.equal(baseline(close),'accepted');
 assert.equal(baseline({...close,realmId:'456'}),'unresolved');
 assert.equal(baseline({...close,fromDate:'2026-11-01',throughDate:'2026-11-01'}),'unresolved');
 assert.equal(baseline({...close,verifiedAt:new Date(at-2000)}),'unresolved');
});
