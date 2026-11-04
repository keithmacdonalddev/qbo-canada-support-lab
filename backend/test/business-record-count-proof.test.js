'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../src/modules/business-calendar');
const count=require('../src/modules/business-record-count-proof');
const {buildGeneralBatch,classifyGeneralResponse}=require('../src/modules/general-write-transport');
const scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},owner='b'.repeat(24),day='2026-11-01',clock=Date.parse('2026-11-04T12:00:00Z');
const chain=value=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(value)});
function fixture(){
 const entries=[['invoice','Invoice',{TxnDate:day,CustomerRef:{value:'2'},ARAccountRef:{value:'120'},TotalAmt:100,Balance:100,Line:[{Amount:100,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'3'},Qty:1,UnitPrice:100}}]}],['customer','Customer',{DisplayName:'Fictional customer',Active:true}]];
 const batch={index:0,attempt:1,state:'answered',requestId:'1'.repeat(32),items:entries.map(([ref,entity,payload],i)=>({ref,entity,payload,bId:String(i+1),op:'create',operation:'create'}))};
 const response={BatchItemResponse:batch.items.map((item,i)=>({bId:item.bId,[item.entity]:{...structuredClone(item.payload),Id:String(i+10),SyncToken:'0',MetaData:{CreateTime:'2026-11-01T12:00:00Z',LastUpdatedTime:'2026-11-01T12:00:00Z'}}}))};
 const observed=classifyGeneralResponse(scope,batch,{status:200,json:response}),run={_id:'c'.repeat(24),contract:'general-write-v1',...scope,ownerId:owner,actorId:owner,agentAuthority:{agentId:'d'.repeat(24)},day,revision:1,plan:{operations:batch.items.map(i=>({ref:i.ref,entity:i.entity,op:'create',payload:structuredClone(i.payload)}))},items:Object.fromEntries(batch.items.map((i,n)=>[i.ref,{op:'create',entity:i.entity,outcome:'saved',attempt:1,qboId:String(n+10),request:structuredClone(i.payload),record:response.BatchItemResponse[n][i.entity]}])),batches:[batch]};
 const receipt={_id:'e'.repeat(64),...scope,ownerId:owner,actorId:owner,kind:'general-write',state:'saved',requestHash:buildGeneralBatch(scope,batch).requestHash,general:{runId:run._id,batchIndex:0,requestId:batch.requestId},observed};
 batch.transport={receiptId:receipt._id,outcome:'saved',response:response.BatchItemResponse,items:observed.items};
 const data=()=>({scope,runs:[run],current:new Map(Object.values(run.items).map(i=>[i.entity+':'+i.qboId,structuredClone(i.record)])),effective:new Map(Object.entries(run.items).map(([ref,i])=>[i.entity+':'+i.qboId,{identity:count.effectiveIdentity(run,ref,i),revision:run.revision,outcome:i.outcome}]))});
 const first=data(),last=data(),before={},after={};count.rememberGeneralCountInputs(before,first);count.rememberGeneralCountInputs(after,last);
 let reads=0;const Receipts={find:filter=>{reads++;assert.deepEqual(filter._id.$in,[receipt._id]);return chain([receipt]);}};
 const args={scope,fromDate:day,throughDate:day,snapshotHash:'f'.repeat(64),ledgerHash:'1'.repeat(64),before,after,closed:{ok:true,records:[{key:'Invoice:10',kind:'accountant'}]},Receipts,now:()=>clock};
 return{run,receipt,batch,first,last,args,reads:()=>reads,capture:()=>count.captureGeneralCountProof(args)};
}
test('authentic per-create proof separates native-readback and financial applicability without new native calls',async()=>{
 const h=fixture(),p=await h.capture();assert.equal(p.status,'current');assert.equal(p.members.length,2);assert.equal(h.reads(),1);
 assert.equal(p.members.filter(m=>m.readbackValidated).length,2);assert.equal(p.members.filter(m=>m.ledgerCovered).length,1);
 const customer=p.members.find(m=>m.key==='Customer:11');assert.equal(customer.accountingApplicable,false);assert.equal(customer.ledgerCovered,false);
 const row={...scope,kind:'period',ok:true,fromDate:day,throughDate:day,snapshotHash:h.args.snapshotHash,ledgerHash:h.args.ledgerHash,countProof:p};
 assert.equal(count.validGeneralCountProof(row,scope),p);const tampered=structuredClone(row);tampered.countProof.members[0].origin.ref='wrong';assert.equal(count.validGeneralCountProof(tampered,scope),null);
 assert.equal(count.validGeneralCountProof({...row,countProof:undefined,records:[{key:'Invoice:10',kind:'accountant'}]},scope),null,'legacy identities/opaque snapshot alone are never upgraded');
});
test('count capture follows financial success and cannot swallow financial/auth/storage source failures',async()=>{
 const h=fixture();h.args.closed.ok=false;await assert.rejects(h.capture(),/financial success/);assert.equal(h.reads(),0);
 h.args.closed.ok=true;h.args.Receipts={find(){throw Object.assign(Error('not authorized'),{code:13});}};await assert.rejects(h.capture(),e=>e.code===13);
 const beforeHash=hash(h.args.before);assert.deepEqual(Object.keys(h.args.before),[]);assert.equal(hash(h.args.before),beforeHash,'private sidecar does not alter accounting/replay snapshots');
});
test('wrong owner/ref/receipt/native identity cannot acquire per-create membership',async()=>{
 for(const change of [h=>h.receipt.ownerId='f'.repeat(24),h=>h.receipt.requestHash='0'.repeat(64),h=>h.receipt.observed.items[0].responseHash='0'.repeat(64),h=>h.run.items.invoice.qboId='900',h=>h.run.plan.operations[0].payload.TotalAmt=999,h=>h.run.items.invoice.request.TotalAmt=999,h=>h.batch.transport.outcome='unknown']){
  const h=fixture();change(h);const p=await h.capture();assert.equal(p.members.some(m=>m.key==='Invoice:10'),false);assert.ok(p.unresolved.length);
 }
});
test('metadata-only token/hash/revision and unrelated delivery drift are provenance; same-token financial/link drift is not',async()=>{
 const h=fixture();h.last.current.get('Invoice:10').SyncToken='9';h.last.current.get('Invoice:10').MetaData.LastUpdatedTime='2026-11-04T11:00:00Z';h.run.revision=99;h.run.bankDelivery={status:'pending'};
 const p=await h.capture();assert.equal(p.members.length,2);assert.equal(p.members.find(m=>m.key==='Invoice:10').native.syncToken,'9');
 for(const mutate of [r=>r.Balance=50,r=>r.LinkedTxn=[{TxnType:'Payment',TxnId:'70'}]]){
  const bad=fixture();mutate(bad.last.current.get('Invoice:10'));const proof=await bad.capture();assert.equal(proof.members.some(m=>m.key==='Invoice:10'),false);assert.ok(proof.unresolved.some(r=>r.key==='Invoice:10'));
 }
});
test('current source completion/watermark covers unchanged old records across a stable incremental generation',()=>{
 const row={...scope,entity:'Invoice',qboId:'10',generation:'stable',deleted:false,lastObservedAt:'2023-09-01T00:00:00Z',record:{Id:'10',SyncToken:'0',Balance:100}},agent={...scope,sync:{sources:{Invoice:{entity:'Invoice',mode:'cdc',phase:'incremental',status:'current',generation:'stable',startedAt:'2023-09-01T00:00:00Z',since:new Date(clock-120000).toISOString(),lastSuccessAt:new Date(clock-60000).toISOString(),everyMs:60000}}}};
 const input={scope,agent,row,entity:'Invoice',id:'10',now:()=>clock};assert.equal(count.currentMirror(input),row.record);
 for(const mutate of [a=>a.sync.sources.Invoice.phase='bootstrap',a=>a.sync.sources.Invoice.status='resyncing',a=>a.sync.sources.Invoice.generation='different',a=>a.sync.sources.Invoice.lastSuccessAt=new Date(clock-600000).toISOString()]){
  const changed=structuredClone(agent);mutate(changed);assert.equal(count.currentMirror({...input,agent:changed}),null);
 }
});
test('default composition has no database or native-call escape when count storage/input is unavailable',async()=>{
 const qbo=require('../src/modules/qbo-client'),original=qbo.QBOClient.prototype.apiCall;let native=0;qbo.QBOClient.prototype.apiCall=()=>{native++;throw Error('QBO tripwire');};
 try{assert.deepEqual(await count.captureGeneralCountProof({scope,fromDate:day,throughDate:day,closed:{ok:true},before:{},after:{},now:()=>clock}),{version:1,status:'unavailable',reason:'native-count-inputs-unavailable'});assert.equal(native,0);}finally{qbo.QBOClient.prototype.apiCall=original;}
});

function atPath(value,parts){if(!parts.length)return Array.isArray(value)?value:[value];if(Array.isArray(value))return value.flatMap(v=>atPath(v,parts));return atPath(value?.[parts[0]],parts.slice(1));}
function matching(row,filter){return Object.entries(filter).every(([key,want])=>{
 if(key==='$or')return want.some(v=>matching(row,v));
 const values=atPath(row,key.split('.'));
 if(want&&typeof want==='object'&&!Array.isArray(want)&&!(want instanceof Date))return Object.entries(want).every(([op,v])=>op==='$in'?values.some(x=>v.some(y=>String(x)===String(y))):op==='$lte'?values.some(x=>x<=v):op==='$gte'?values.some(x=>x>=v):op==='$exists'?values.some(x=>x!==undefined)===v:false);
 return values.some(v=>String(v)===String(want));
});}
function fakeModel(rows){return{rows,find(filter){let n=Infinity;return{select(){return this;},limit(v){n=v;return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(rows.filter(r=>matching(r,filter)).slice(0,n))};},findOne(filter){return{select(){return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(rows.find(r=>matching(r,filter))||null)}}};}
async function consumerFixture(){
 const h=fixture(),p=await h.capture();h.run.owned=Object.values(h.run.items).map(i=>({key:i.entity+':'+i.qboId,op:'create'}));h.run.status='complete';h.run.createdAt=new Date(clock);
 const agent={_id:'d'.repeat(24),...scope,ownerId:owner,sync:{sources:{}}};
 for(const entity of ['Invoice','Customer'])agent.sync.sources[entity]={entity,mode:'cdc',phase:'incremental',status:'current',generation:'stable',startedAt:'2023-09-01T00:00:00Z',since:new Date(clock-120000).toISOString(),lastSuccessAt:new Date(clock-1000).toISOString(),everyMs:60000};
 const mirrors=[...h.last.current].map(([key,record])=>({ ...scope,entity:key.split(':')[0],qboId:record.Id,generation:'stable',deleted:false,record:structuredClone(record),lastObservedAt:new Date('2023-09-01T00:00:00Z')}));
 const close={_id:'f'.repeat(24),...scope,kind:'period',ok:true,fromDate:day,throughDate:day,snapshotHash:h.args.snapshotHash,ledgerHash:h.args.ledgerHash,verifiedAt:new Date(clock),countProof:p};
 const models={Agents:fakeModel([agent]),GeneralWriteRuns:fakeModel([h.run]),Runs:fakeModel([]),Receipts:fakeModel([h.receipt]),Steps:fakeModel([]),Evidence:fakeModel([]),GeneralDayCloses:fakeModel([close]),Records:fakeModel(mirrors),Audits:fakeModel([])};
 const activity={runs:[{id:h.run._id,hourlyActivity:true,status:'retired',recordCount:2}],receipts:Object.entries(h.run.items).map(([ref,i])=>({operationId:h.run._id,logicalKey:ref,entity:i.entity}))};
 return{...h,models,agent,mirrors,close,activity,read:()=>count.readLocalProofCounts({models,scope,agentId:agent._id,ownerId:owner,day,activity,now:()=>clock})};
}
test('bounded local General counts use exact independent membership and keep terminal reservation semantics',async()=>{
 const h=await consumerFixture(),before=structuredClone(h.activity),result=await h.read();
 assert.deepEqual([result.saved,result.readbackValidated,result.accountingVerified,result.nonfinancial,result.status],[2,2,1,1,'current']);assert.deepEqual(h.activity,before);
 h.run.revision=99;h.run.bankDelivery={state:'settled'};h.mirrors[0].record.SyncToken='9';h.mirrors[0].record.MetaData.LastUpdatedTime='2026-11-04T12:00:00Z';
 assert.equal((await h.read()).accountingVerified,1,'metadata/delivery revisions alone are not new financial versions');
 h.mirrors[0].record.Balance=25;assert.deepEqual([(await h.read()).readbackValidated,(await h.read()).accountingVerified],[1,0],'same-token financial drift affects only proof, not the saved outcome');
});
test('legacy/dirty/failed/truncated source coverage never becomes false General accounting success',async()=>{
 const legacy=await consumerFixture();delete legacy.close.countProof;let result=await legacy.read();assert.deepEqual([result.saved,result.readbackValidated,result.accountingVerified,result.status],[2,0,0,'partial']);
 const dirty=await consumerFixture();dirty.run.dirty=[{date:day}];result=await dirty.read();assert.deepEqual([result.readbackValidated,result.accountingVerified],[2,0]);
 const failed=await consumerFixture();failed.models.GeneralDayCloses.rows.push({...failed.close,_id:'9'.repeat(24),ok:false,verifiedAt:new Date(clock+1)});result=await failed.read();assert.equal(result.accountingVerified,0);
 const missing=await consumerFixture();missing.models.Records.rows.splice(0,1);result=await missing.read();assert.equal(result.saved,2);assert.equal(result.accountingVerified,0);
 const wrong=await consumerFixture();wrong.models.Agents.rows[0].ownerId='a'.repeat(24);await assert.rejects(wrong.read(),e=>e.code==='COUNT_SCOPE_CHANGED');
});
async function addFixed(h,{futureMetadata=false}={}){
 const {makeActivityBatch,buildBatchActivity}=require('../src/modules/business-activity-batch'),businessKey='count-fixture',activityBatch=makeActivityBatch({scope,businessKey,day,choices:{decisionKey:'fixed-count-fixture-001',purpose:'Invoice a completed customer service on agreed payment terms.',activities:[{type:'invoice-on-terms',customerKey:'care-client-001',itemKey:'care-plan-1',quantity:1,unitPriceCents:10000,termsDays:30,purpose:'Completed monthly service invoiced on agreed terms.'}]}});
 const activity=buildBatchActivity(activityBatch,scope,businessKey);assert.equal(activity.events.length+activity.prerequisites.length,1);
 const id='f'.repeat(24),logicalKey=activity.events[0].logicalKey,planHash='a'.repeat(64),fingerprint=hash(activity.events[0]),compilationHash='e'.repeat(64),record={...structuredClone(h.run.items.invoice.record),Id:'90'},observedHash=hash(record),observedAt='2026-11-01T23:00:00.000Z';
 const step={...scope,operationId:id,planHash,logicalKey,entity:'Invoice',fingerprint,state:'verified',revision:3,qboId:'90',dispatch:{key:'a'.repeat(64),requestHash:'f'.repeat(64),compilationHash},receipt:{qboId:'90',requestHash:'f'.repeat(64)},verification:{kind:'business-readback',compilationHash,observedHash,evidenceHash:'b'.repeat(64),syncToken:'0',observedAt}};
 const details={...scope,actorId:owner,operationId:id,logicalKey,phase:'verify',revision:3,qboId:'90'},eventKey='business-step:'+hash({scope,operationId:id,planHash,logicalKey,revision:3,phase:'verify'}),auditId=hash({scope,actorId:owner,ownerId:owner,eventKey}).slice(0,24);step.lastAuditId=auditId;
 if(futureMetadata){const payload={version:1,projectionVersion:1,observedHash,accountingHash:count.accountingHash('Invoice',record)};step.verification.countReadback={...payload,proofHash:hash(payload)};Object.assign(details,{countReadbackHash:hash(payload),countProjectionVersion:1,countObservedHash:observedHash,countAccountingHash:payload.accountingHash});}
 const audit={_id:auditId,userId:owner,realmId:scope.realmId,action:'Business operation evidence recorded',actionType:'manual',outcome:'success',inputParams:{eventKey,...scope,details}};
 const member={logicalKey,entity:'Invoice',fingerprint,qboId:'90',state:'verified',observedHash,syncToken:'0',observedAt,auditId,relationships:[]},expectedRecordSetHash=hash([{logicalKey,entity:'Invoice',fingerprint,relationships:[]}]),blueprintHash=hash('blueprint'),baselineHash=hash('baseline'),requiredAssertions=[{key:'records',evidenceType:'record-readback',currency:'CAD'},{key:'trial-balance',evidenceType:'accrual-ledger',currency:'CAD',basis:'Accrual'}];
 const {fixture:reportsFixture,accounts}=require(process.cwd()+'/backend/test/helpers/business-report-fixtures'),{packReport}=require('../src/modules/business-report-source'),reports=reportsFixture({critical:true});for(const value of Object.values(reports)){value.Header.StartPeriod=day;value.Header.EndPeriod=day;}for(const name of ['GeneralLedger','CashFlow'])reports[name]=packReport(name,reports[name]);
 const source={version:2,scope,period:{fromDate:day,throughDate:day},startedAt:observedAt,observedAt,reports,accounts:accounts.records},sourceHash=hash(source),records=[member],assertions=requiredAssertions.map(requirement=>({...requirement,status:'passed',recordSetHash:hash(records),sourceHash:requirement.evidenceType==='record-readback'?hash(records):sourceHash,observedAt,fromDate:day,throughDate:day}));
 const proof={version:1,...scope,operationId:id,planHash,blueprintHash,baselineHash,expectedRecordSetHash,fromDate:day,throughDate:day,complete:true,observedAt,records,assertions},evidenceHash=hash(proof),evidence={_id:hash({scope,operationId:id,evidenceRevision:1}).slice(0,24),contractVersion:1,...scope,operationId:id,planHash,evidenceRevision:1,evidenceHash,proof,sources:{...source,sourceHash},actorId:owner};
 const run={_id:id,contractVersion:1,...scope,createdBy:owner,businessKey,blueprintId:'1'.repeat(24),agentAuthority:{version:1,agentId:h.agent._id,ownerId:owner,grantId:'2'.repeat(64),authorityHash:'3'.repeat(64)},activityBatch,status:'awaiting-evidence',verification:null,planHash,blueprintHash,baselineHash,fromDate:day,throughDate:day,expectedCursor:'2026-10-31',expectedRevision:1,expectedRecordSetHash,recordCount:1,requiredAssertions,evidenceRevision:1,verificationCandidateHash:evidenceHash};
 const receipt={_id:'7'.repeat(64),...scope,ownerId:owner,actorId:owner,operationId:id,logicalKey,kind:'business',operation:'create',state:'saved',dispatchKey:step.dispatch.key,requestHash:step.dispatch.requestHash,observed:{qboId:'90'}};
 h.models.Runs.rows.push(run);h.models.Steps.rows.push(step);h.models.Evidence.rows.push(evidence);h.models.Receipts.rows.push(receipt);h.models.Audits.rows.push(audit);h.models.Records.rows.push({...scope,entity:'Invoice',qboId:'90',generation:'stable',deleted:false,record,lastObservedAt:new Date('2023-09-01')});
 const session={inTransaction:()=>true},transaction=async work=>work(session),Audits={findOne:filter=>({session(){return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(h.models.Audits.rows.find(a=>matching(a,filter))||null)}),create:async rows=>h.models.Audits.rows.push(...structuredClone(rows))};
 const writeAudit=require('../src/modules/business-runtime-audit').createBusinessAuditWriter({scope,actorId:owner,ownerId:owner,Audits,transaction,access:{authorize:async()=>({actorId:owner,ownerId:owner})}});
 const observedKey='business-period-evidence:'+id+':1';evidence.auditId=(await writeAudit(observedKey,{...scope,actorId:owner,operationId:id,evidenceHash,sourceHash,evidenceRevision:1,recordCount:1})).id;
 const calendar={_id:'sandbox:123',...scope,businessKey,blueprintId:run.blueprintId,blueprintHash,baseline:{status:'verified',evidenceHash:baselineHash},verifiedThrough:run.expectedCursor,revision:1,currentOperationId:id,stopRequested:false,pendingCommit:null};
 const memory=value=>({findOne:filter=>({session(){return this;},lean:async()=>matching(value,filter)?structuredClone(value):null}),findOneAndUpdate:(filter,change)=>({lean:async()=>{if(!matching(value,filter))return null;Object.assign(value,structuredClone(change.$set||{}));for(const [key,n]of Object.entries(change.$inc||{}))value[key]=(value[key]||0)+n;return structuredClone(value);}})});
 const periods=require('../src/modules/business-period-store').createBusinessPeriodStore({Calendars:memory(calendar),Runs:memory(run),Writer:{reserve:async()=>{},assertSettled:async()=>{},release:async()=>{}},loadProof:async()=>structuredClone(proof),authorize:async()=>({actorId:owner}),writeAudit,assertReady:async()=>{},transaction,now:()=>Date.parse(observedAt)});
 await periods.finish(id,scope);assert.equal(run.status,'verified');assert.ok(run.verification.completionAuditId);
 h.activity.runs.push({id,status:'verified',hourlyActivity:false});h.activity.receipts.push({operationId:id,logicalKey,entity:'Invoice'});
 return{run,step,audit,evidence,completionAudit:h.models.Audits.rows.find(a=>a._id===run.verification.completionAuditId),mirror:h.models.Records.rows.at(-1)};
}
test('fixed and General proof cohorts use the same source, dirty and financial-current checks; fixed legacy raw drift is unknown',async()=>{
 const h=await consumerFixture(),fixed=await addFixed(h);let value=await h.read();assert.deepEqual([value.saved,value.readbackValidated,value.accountingVerified],[3,3,2]);
 fixed.mirror.record.SyncToken='7';fixed.mirror.record.MetaData.LastUpdatedTime='2026-11-04T11:00:00Z';value=await h.read();assert.deepEqual([value.saved,value.readbackValidated,value.accountingVerified],[3,2,1],'legacy lacks a historical financial projection; raw drift cannot be guessed');
 const future=await consumerFixture(),f=await addFixed(future,{futureMetadata:true});f.mirror.record.SyncToken='7';f.mirror.record.MetaData.LastUpdatedTime='2026-11-04T11:00:00Z';value=await future.read();assert.deepEqual([value.readbackValidated,value.accountingVerified],[3,2],'original audit-bound projection survives metadata-only drift');
 f.mirror.record.Balance=25;const changed={...f.step.verification.countReadback,accountingHash:count.accountingHash('Invoice',f.mirror.record)};delete changed.proofHash;f.step.verification.countReadback={...changed,proofHash:hash(changed)};
 value=await future.read();assert.deepEqual([value.saved,value.readbackValidated,value.accountingVerified],[3,2,1],'recomputed mutable self-hash cannot replace the original audited projection');
});
test('local counter composition performs zero QBO/provider calls and source age is not record age',async()=>{
 const h=await consumerFixture(),qbo=require('../src/modules/qbo-client'),original=qbo.QBOClient.prototype.apiCall;let calls=0;qbo.QBOClient.prototype.apiCall=()=>{calls++;throw Error('native tripwire');};
 try{assert.equal((await h.read()).accountingVerified,1);assert.equal(calls,0);h.agent.sync.sources.Invoice.phase='bootstrap';assert.equal((await h.read()).accountingVerified,0);assert.equal(calls,0);}finally{qbo.QBOClient.prototype.apiCall=original;}
});

test('known saved mismatches and pending transitive writes retain saved count without inventing current proof',async()=>{
 const capture=fixture();capture.run.items.customer.outcome='mismatch';capture.last.effective.get('Customer:11').outcome='mismatch';const p=await capture.capture();assert.equal(p.members.some(m=>m.key==='Customer:11'),false);
 const pending=await consumerFixture();pending.models.Receipts.rows.push({...scope,_id:'0'.repeat(64),kind:'general-write',state:'unknown',entity:'batch',periodProof:{proofs:[{evidence:{records:[{entity:'Invoice',id:'10'}]}}]}});const counts=await pending.read();assert.equal(counts.saved,2);assert.equal(counts.accountingVerified,0);assert.equal(counts.readbackValidated,1);
});


async function closeGateFixture(countError=null){
 const h=fixture(),closes=[];let nativeReads=0,reports=0;
 const Runs={find:()=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>structuredClone([h.run])})};
 const models={GeneralWriteRuns:Runs,GeneralDayCloses:{findOne:()=>chain(null),create:async([row])=>closes.push(row)},Records:{find:()=>chain([])},Receipts:countError?{find(){throw countError;}}:fakeModel([h.receipt])};
 const copy={read:async(_s,entity,id)=>{nativeReads++;return entity==='Item'?{Id:id,Type:'Service',IncomeAccountRef:{value:'400'}}:structuredClone(h.last.current.get(entity+':'+id)||null);}};
 const columns=['tx_date','txn_type','doc_num','name','memo','split_acc','debt_amt','credit_amt'].map(ColType=>({ColType})),row=(debit,credit)=>({type:'Data',ColData:[{value:day},{value:'Invoice',id:'10'},{},{},{},{},{value:debit},{value:credit}]}),section=(id,rows)=>({type:'Section',Header:{ColData:[{id}]},Rows:{Row:rows}});
 const readLedger=async()=>{reports++;return{Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:day,EndPeriod:day},Columns:{Column:columns},Rows:{Row:[section('120',[row('100.00','')]),section('400',[row('','100.00')])]}};};
 const gate=require('../src/modules/general-write-close-gate').createGeneralCloseGate({models,copy,now:()=>clock});
 await gate.assertPeriodReady(scope,{fromDate:day,throughDate:day,verifiedThrough:'2026-10-31',openingDate:'2026-10-01',mappings:{accountsReceivable:'120'},readLedger});
 return{reports,nativeReads,closes};
}
test('normal GeneralCloseGate persists authenticated count membership only after unchanged financial success',async()=>{
 const {reports,nativeReads,closes}=await closeGateFixture();
 assert.equal(reports,1);assert.equal(nativeReads,6);assert.equal(closes.length,1);assert.equal(closes[0].ok,true);assert.equal(closes[0].countProof.status,'current');assert.equal(closes[0].countProof.members.length,2);
});
test('post-financial count timeout persists the passing close; count auth errors still reject',async()=>{
 const {reports,nativeReads,closes}=await closeGateFixture(Object.assign(Error('count deadline'),{name:'MongoServerError',code:50}));
 assert.equal(reports,1);assert.equal(nativeReads,6);assert.equal(closes.length,1);assert.equal(closes[0].ok,true);assert.equal(closes[0].countProof.status,'unavailable');
 await assert.rejects(closeGateFixture(Object.assign(Error('count auth denied'),{name:'MongoServerError',code:13})),e=>e.code===13);
});

test('bounded reader reports count-unknown rather than accepting a truncated proof set',async()=>{
 const h=await consumerFixture();h.models.GeneralDayCloses.rows.splice(0,1,...Array.from({length:1001},(_,i)=>({...h.close,_id:String(i)})));const result=await h.read();assert.equal(result.status,'unknown');assert.equal(result.reason,'count-enumeration-incomplete');assert.equal(result.saved,2);
});


test('optional count-read timeout cannot convert successful accounting into failed close',async()=>{
 const h=fixture();h.args.Receipts={find(){throw Object.assign(Error('count maxTimeMS elapsed'),{name:'MongoServerError',code:50});}};
 const result=await h.capture();assert.equal(result.status,'unavailable');assert.equal(h.args.closed.ok,true);
 const local=await consumerFixture();local.models.Records.find=()=>{throw Object.assign(Error('count connection unavailable'),{name:'MongoNetworkError'});};const unknown=await local.read();assert.equal(unknown.status,'unknown');assert.equal(unknown.saved,2);
});
test('fixed accounting count requires the original committed and observed period authority',async()=>{
 const h=await consumerFixture(),fixed=await addFixed(h);delete fixed.run.verification.completionAuditId;assert.equal((await h.read()).accountingVerified,1,'fixed proof without immutable completion authority is unknown');
});

test('fixed completion, observation, assertion and report bindings fail closed when absent or tampered',async()=>{
 const changes=[f=>f.run.verification.recordSetHash='0'.repeat(64),f=>f.run.verification.evidenceRevision++,f=>f.run.verification.throughDate='2026-10-31',f=>f.completionAudit.inputParams.eventKey+='-changed',f=>f.completionAudit.action='different action',f=>f.completionAudit.inputParams.details.throughDate='2026-10-31',f=>f.completionAudit.actorUserId='0'.repeat(24),f=>f.evidence.auditId='0'.repeat(24),f=>f.evidence.sources.sourceHash='0'.repeat(64),f=>f.evidence.sources.reports.TrialBalance.Header.Currency='USD',f=>f.evidence.proof.assertions=[],f=>f.evidence.proof.records[0].observedHash='0'.repeat(64)];
 for(const change of changes){const h=await consumerFixture(),fixed=await addFixed(h);change(fixed);assert.equal((await h.read()).accountingVerified,1,'tampered fixed authority remains outside known General minimum');}
 const h=await consumerFixture();h.models.Records.find=()=>{throw Object.assign(Error('count denied'),{name:'MongoServerError',code:13});};await assert.rejects(h.read(),e=>e.code===13);
});
