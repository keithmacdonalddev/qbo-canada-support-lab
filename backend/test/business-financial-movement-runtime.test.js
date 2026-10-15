'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope}=require('./helpers/business-governance-fixture');
const {hash}=require('../src/modules/business-calendar');
const config=require('../src/config'),previous=config.qbo.environment;
test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
async function prepare(h,throughDate,key){const p=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});return {p,runtime:h.runtime(p.operationId)};}
const proof=h=>h.data.Evidence.at(-1).proof;
const cents=value=>Math.round(Number(value)*100);
test('normal v1 and v2 operations derive exact original accepted movements, retain limited proof and never copy shared policies',{timeout:120000},async()=>{
 for(const version of [1,2]){
  const h=fixture({activityTemplateVersion:version,openingCash:1250,copyOnWriteTransactions:true});await h.publish();
  const {p,runtime}=await prepare(h,'2026-10-08','financial-normal-version-'+version),candidate=h.data.Plans[0].manifest;
  assert.ok(candidate.requiredAssertions.some(row=>row.key==='financial-movements'));assert.equal(candidate.financialExpectation.opening.operatingBank,125000);
  const outcome=await runtime.execute();assert.equal(outcome.complete,true,JSON.stringify(outcome));
  const stored=proof(h),basis=stored.financialBasis,creates=candidate.records.filter(row=>row.kind==='create');assert.equal(basis.length,creates.length);assert.equal(new Set(basis.map(row=>row.logicalKey)).size,basis.length);
  for(const row of basis){assert.equal(row.operationId,p.operationId);assert.equal(row.policyHash,h.data.Steps.find(step=>step.logicalKey===row.logicalKey).dispatch.policyHash);assert.equal(row.policy,undefined);assert.equal(row.compilation,undefined);assert.equal(row.receiptSource,h.data.Steps.find(step=>step.logicalKey===row.logicalKey).receipt.source);assert.ok(['create-response','request-correlated-readback'].includes(row.receiptSource));}
  const summary=(await runtime.inspect()).financialMovements;assert.equal(summary.status,'passed');assert.equal(summary.complete,true);assert.equal(summary.checks.length,4);assert.ok(summary.checks.every(row=>row.differenceCents===0));
  const tb=h.reportSources({fromDate:'2026-10-01',throughDate:'2026-10-08'}).reports.TrialBalance;
  for(const row of summary.checks){const cells=tb.Rows.Row.find(record=>record.ColData?.[0].id===row.accountId).ColData;assert.equal(row.actualCents,cents(cells[1].value)-cents(cells[2].value));}
  const before=h.posts;assert.equal((await runtime.execute()).complete,true);assert.equal(h.posts,before);
 }
});
test('balanced wrong bank movement retains a failed visible observation, cannot advance, and corrected reports close without repeating writes',async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true});await h.publish();const saved=await prepare(h,'2026-10-08','financial-wrong-bank-0001'),read=h.reportSources;let corrupt=true;
 h.reportSources=period=>{const source=read(period);if(corrupt&&h.posts){const report=source.reports.TrialBalance,bank=report.Rows.Row.find(row=>row.ColData?.[0].id===h.mappings.operatingBank),equity=report.Rows.Row.find(row=>row.ColData?.[0].id==='972'),total=report.Rows.Row.at(-1).Summary.ColData;bank.ColData[1].value=(Number(bank.ColData[1].value)+5).toFixed(2);equity.ColData[2].value=(Number(equity.ColData[2].value)+5).toFixed(2);for(const i of [1,2])total[i].value=(Number(total[i].value)+5).toFixed(2);for(const row of source.reports.BalanceSheet.Rows.Row){if(row.ColData)row.ColData[1].value=(Number(row.ColData[1].value)+5).toFixed(2);if(row.Summary)row.Summary.ColData[1].value=(Number(row.Summary.ColData[1].value)+5).toFixed(2);}}return source;};
 const result=await saved.runtime.execute();assert.equal(result.complete,false);assert.equal(result.state,'awaiting-evidence');assert.equal(h.data.Calendars[0].verifiedThrough,null);assert.equal(h.data.Runs[0].verificationCandidateHash,null);assert.equal(proof(h).complete,false);
 const visible=(await saved.runtime.inspect()).financialMovements;assert.equal(visible.status,'failed');assert.equal(visible.complete,false);assert.equal(visible.checks.find(row=>row.key==='operatingBank').differenceCents,500);assert.ok(visible.checks.filter(row=>row.key!=='operatingBank').every(row=>row.status==='passed'));
 const posts=h.posts;corrupt=false;assert.equal((await saved.runtime.execute()).complete,true);assert.equal(h.posts,posts);assert.equal(h.data.Evidence.length,2);assert.equal(h.data.Evidence[0].proof.complete,false);assert.equal((await saved.runtime.inspect()).financialMovements.complete,true);
});
test('unavailable complete-TB account layout is retained visibly and never converted into guessed zero',async()=>{
 const h=fixture({activityTemplateVersion:2});await h.publish();const saved=await prepare(h,'2026-10-04','financial-unknown-layout-001'),read=h.reportSources;
 h.reportSources=period=>{const source=read(period);if(h.posts){const tb=source.reports.TrialBalance,zero=tb.Rows.Row.find(row=>row.ColData?.[0].id===h.mappings.undepositedFunds);zero.ColData[0].id='99999';}return source;};
 const result=await saved.runtime.execute();assert.equal(result.complete,false);assert.equal(h.data.Calendars[0].verifiedThrough,null);const visible=(await saved.runtime.inspect()).financialMovements;assert.equal(visible.status,'unavailable');assert.match(visible.reason,/unknown/);assert.ok(visible.checks.every(row=>row.actualCents===null&&row.status==='unavailable'));assert.ok(visible.sourceHash);assert.equal(proof(h).complete,false);
});
test('dependency-only Stop and resume cannot bypass starting-bank drift before the first create',async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true});await h.publish();const first=await prepare(h,'2026-10-03','financial-dependency-prior-001');assert.equal((await first.runtime.execute()).complete,true);
 const next=await h.service.prepare(h.user,{requestKey:'financial-dependency-next-001',throughDate:'2026-10-04'});await h.service.approve(h.user,next.operationId,{planHash:next.planHash});const manifest=h.data.Plans.find(row=>row.operationId===next.operationId).manifest;assert.equal(manifest.records[0].kind,'existing');
 const posts=h.posts,base=h.transaction;let stopped=false,runtime;h.transaction=async work=>{const result=await base(work),run=h.data.Runs.find(row=>row._id===next.operationId);if(!stopped&&run?.nextOrdinal>0&&h.posts===posts){stopped=true;await runtime.stop();}return result;};runtime=h.runtime(next.operationId);
 assert.equal((await runtime.execute()).state,'stopped');assert.equal(stopped,true);assert.equal(h.posts,posts);assert.ok(h.data.Runs.find(row=>row._id===next.operationId).nextOrdinal>0);
 const input={planHash:next.planHash},review=await h.service.reviewResume(h.user,next.operationId,input);await h.service.resume(h.user,next.operationId,{...input,reviewHash:review.reviewHash,reason:'Owner reviewed stopped dependency-only progress before continuing.'});
 const read=h.reportSources;h.reportSources=period=>{const source=read(period),tb=source.reports.TrialBalance,bank=tb.Rows.Row.find(row=>row.ColData?.[0].id===h.mappings.operatingBank),equity=tb.Rows.Row.find(row=>row.ColData?.[0].id==='972'),total=tb.Rows.Row.at(-1).Summary.ColData;bank.ColData[1].value=(Number(bank.ColData[1].value)+1).toFixed(2);equity.ColData[2].value=(Number(equity.ColData[2].value)+1).toFixed(2);for(const i of [1,2])total[i].value=(Number(total[i].value)+1).toFixed(2);return source;};
 assert.equal((await runtime.inspect()).financialMovements,null);
 const result=await runtime.execute();assert.equal(result.complete,false);assert.match(result.error,/balances changed after preparation/);assert.equal(h.posts,posts);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-10-03');
});
test('historical account proof survives later legitimate settlements and verification refresh but denies original identity and basis tampering',{timeout:120000},async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true});await h.publish();const first=await prepare(h,'2026-10-08','financial-history-prior-001');assert.equal((await first.runtime.execute()).complete,true);const before=(await first.runtime.inspect()).financialMovements,old=structuredClone(h.data.Evidence[0]);
 const next=await prepare(h,'2026-10-31','financial-history-next-001');assert.equal((await next.runtime.execute()).complete,true);h.clock+=600000;
 assert.deepEqual((await first.runtime.inspect()).financialMovements,before,'immutable past observation does not require current parent SyncToken or report recollection');
 const item=h.data.Steps.find(row=>old.proof.financialBasis.some(b=>b.logicalKey===row.logicalKey)),original=structuredClone(item),originalEvidence=structuredClone(h.data.Evidence[0]);
 for(const mutate of [row=>{row.dispatch.policyHash=hash('wrong');},row=>{row.dispatch.compilationHash=hash('wrong');},row=>{row.dispatch.evidenceHash=hash('wrong');},row=>{row.receipt.version=2;},row=>{row.receipt.dispatchKey=hash('wrong');},row=>{row.receipt.requestHash=hash('wrong');},row=>{row.qboId='99999';},row=>{row.dispatch.policyAmendmentHash=hash('missing-head');}]){mutate(item);assert.equal((await first.runtime.inspect()).financialMovements.status,'integrity-unavailable');Object.keys(item).forEach(key=>delete item[key]);Object.assign(item,structuredClone(original));}
 h.data.Evidence[0].proof.financialBasis[0].postings.operatingBank++;h.data.Evidence[0].evidenceHash=hash(h.data.Evidence[0].proof);assert.equal((await first.runtime.inspect()).financialMovements.status,'integrity-unavailable');h.data.Evidence[0]=originalEvidence;
 assert.deepEqual((await first.runtime.inspect()).financialMovements,before);
});

function execution(h, runtimeFor = input=>h.runtime(input.operationId)) {
 const {createBusinessExecutionService}=require('../src/modules/business-execution-service');
 return createBusinessExecutionService({models:h.models,transaction:h.transaction,assertReady:h.assertReady,resolveContext:async()=>({environment:scope.environment,connection:{connected:true,...scope}}),accessFor:h.accessFor,runtimeFor,now:()=>h.clock});
}
test('a zero-opening company prepares and runs with an explicit empty TB before any managed create',async()=>{
 const h=fixture({activityTemplateVersion:2,openingCash:0}),read=h.reportSources;h.reportSources=period=>{const source=read(period);if(!h.posts){source.reports.TrialBalance.Rows.Row=[];source.reports.TrialBalance.Header.Option=[{Name:'NoReportData',Value:'true'}];const{sourceHash,...raw}=source;source.sourceHash=hash(raw);}return source;};
 await h.publish();const saved=await prepare(h,'2026-10-04','financial-empty-opening-001');assert.equal((await saved.runtime.execute()).complete,true);assert.equal((await saved.runtime.inspect()).financialMovements.status,'passed');assert.equal(h.data.Plans[0].manifest.financialExpectation.opening.operatingBank,0);
});
test('expired final starting-report observation cannot mark or send the first compiled create',async()=>{
 const h=fixture({activityTemplateVersion:2});await h.publish();const saved=await prepare(h,'2026-10-04','financial-expired-opening-001');let expired=false;
 h.onGet=opts=>{if(!expired&&opts.url.includes('/reports/')&&h.data.Steps.some(row=>row.state==='claimed')){expired=true;h.clock+=180001;}};
 const result=await saved.runtime.execute();assert.equal(result.complete,false);assert.equal(expired,true);assert.equal(h.posts,0);assert.ok(h.data.Steps.every(row=>!row.dispatch));assert.equal(h.data.Receipts.length,0);
});
test('shared long tax histories remain in original intents while compact period basis stays within its fixed capacity',{timeout:120000},async()=>{
 const sizes=[];
 for(const long of [false,true]){
  const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true});
  if(long){h.records.get('taxrate:950').record.Description='Retained tax definition '.repeat(160);h.records.get('taxrate:950').record.EffectiveTaxRate=Array.from({length:100},(_,i)=>({EffectiveDate:new Date(Date.parse('2020-01-01T00:00:00Z')+i*86400000).toISOString(),RateValue:13}));}
  await h.publish();const saved=await prepare(h,'2026-10-04','financial-history-capacity-001');const result=await saved.runtime.execute();assert.equal(result.complete,true,JSON.stringify(result));
  sizes.push({basis:Buffer.byteLength(JSON.stringify(proof(h).financialBasis)),intent:Buffer.byteLength(JSON.stringify(h.data.Intents)),proof:Buffer.byteLength(JSON.stringify(h.data.Evidence[0]))});
 }
 assert.equal(sizes[0].basis,sizes[1].basis);assert.ok(sizes[1].intent>sizes[0].intent+25000);assert.ok(sizes[1].proof<12000000);
});
test('incomplete evidence with unavailable PNL remains readable; rehashed completion, missing audits and corrupt basis lose assurance while Stop still settles',async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true});await h.publish();const saved=await prepare(h,'2026-10-04','financial-proof-assurance-001'),read=h.reportSources;
 h.reportSources=period=>{const source=read(period);if(h.posts)source.reports.ProfitAndLoss.Header.Currency='USD';return source;};
 const result=await saved.runtime.execute();assert.equal(result.complete,false);const service=execution(h);
 try{
  let inspected=await service.inspect(h.user,saved.p.operationId);assert.equal(inspected.financialMovements.status,'passed');assert.equal(inspected.financialMovements.complete,false);assert.ok(inspected.permissions.stop);
  const row=h.data.Evidence.at(-1),original=structuredClone(row),auditIndex=h.data.Audits.findIndex(item=>item._id===row.auditId),audit=structuredClone(h.data.Audits[auditIndex]);
  row.proof.complete=true;row.evidenceHash=hash(row.proof);assert.equal((await service.inspect(h.user,saved.p.operationId)).financialMovements.status,'integrity-unavailable');Object.keys(row).forEach(key=>delete row[key]);Object.assign(row,structuredClone(original));
  h.data.Audits.splice(auditIndex,1);inspected=await service.inspect(h.user,saved.p.operationId);assert.equal(inspected.financialMovements.status,'integrity-unavailable');assert.equal(inspected.financialMovements.complete,false);assert.equal(inspected.financialMovements.checks.length,0);assert.ok(inspected.permissions.stop);
  const posts=h.posts;await service.stop(h.user,saved.p.operationId);await service.idle();inspected=await service.inspect(h.user,saved.p.operationId);assert.equal(inspected.status,'stopped');assert.equal(h.posts,posts);assert.equal(inspected.execution.pending,false);assert.equal(inspected.financialMovements.status,'integrity-unavailable');h.data.Audits.push(audit);
 }finally{service.close();await service.idle();}
});

test('a failed optional financial Run lookup preserves actual public inspection and queued Stop after core bind succeeds',async()=>{
 const h=fixture({activityTemplateVersion:2,copyOnWriteTransactions:true});await h.publish();const saved=await prepare(h,'2026-10-04','financial-optional-read-001'),read=h.reportSources;
 h.reportSources=period=>{const source=read(period);if(h.posts)source.reports.ProfitAndLoss.Header.Currency='USD';return source;};assert.equal((await saved.runtime.execute()).complete,false);
 let checking=false,reads=0,failures=0;h.onRead=name=>{if(checking&&name==='Runs'&&++reads===2){failures++;throw Error('Fixture optional financial Run read unavailable');}};
 const runtimeFor=input=>{const runtime=h.runtime(input.operationId);return{...runtime,inspect:async()=>{checking=true;reads=0;try{return await runtime.inspect();}finally{checking=false;}}};};
 const service=execution(h,runtimeFor);
 try{const detail=await service.inspect(h.user,saved.p.operationId);assert.equal(detail.financialMovements.status,'integrity-unavailable');assert.equal(detail.permissions.stop,true);assert.ok(failures);const posts=h.posts;await service.stop(h.user,saved.p.operationId);await service.idle();const final=await service.inspect(h.user,saved.p.operationId);assert.equal(final.status,'stopped');assert.equal(final.execution.pending,false);assert.equal(final.financialMovements.status,'integrity-unavailable');assert.equal(h.posts,posts);}finally{service.close();await service.idle();}
});
test('an already active v1 business can continue with an unused inactive child under its explicitly reported mapped bank',async()=>{
 const h=fixture({activityTemplateVersion:1,copyOnWriteTransactions:true});await h.publish();const first=await prepare(h,'2026-10-03','financial-parent-v1-prior-001');assert.equal((await first.runtime.execute()).complete,true);
 h.records.set('account:973',{entity:'Account',record:{Id:'973',SyncToken:'0',Active:false,AccountType:'Bank',Name:'Unused inactive child',ParentRef:{value:h.mappings.operatingBank},CurrencyRef:{value:'CAD'},CurrentBalance:0}});
 const next=await prepare(h,'2026-10-04','financial-parent-v1-next-001');assert.equal((await next.runtime.execute()).complete,true);assert.equal((await next.runtime.inspect()).financialMovements.status,'passed');
});
