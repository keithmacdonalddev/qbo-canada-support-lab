'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const config=require('../src/config');config.qbo.environment='sandbox';
const {fixture,scope,ownerId,actorId}=require('./helpers/period-close-fixture');
const C=require('../src/modules/period-close-contract');
const {validatePeriodDecision}=require('../src/modules/period-close-proof');
const {hash}=require('../src/modules/business-calendar');
const {freezeWriteRequest}=require('../src/modules/qbo-write-contract');
const {assertWritePeriod}=require('../src/modules/qbo-write-period');
const clone=value=>structuredClone(value);
function event(h,id){return h.data.Audits.find(row=>String(row._id)===id);}
test('exact decimal arithmetic rejects coercion, rounding, unsafe amounts and hidden adjustments',()=>{
  for(const value of ['1e2','1.001','+1','01.00',' 1','1,000.00',1,Infinity,'9007199254740993'])assert.throws(()=>C.cents(value));
  assert.equal(C.cents('-0.01'),-1);assert.equal(C.cents('100.1'),10010);
  assert.throws(()=>C.sum([Number.MAX_SAFE_INTEGER,1]));
});
test('current inventory reads use the original bounded SDK GETs and never infer dated balances from CurrentBalance',async()=>{
  const h=fixture(),value=await h.service.accounts(h.user);
  assert.equal(value.accounts.length,2);assert.equal(value.accounts.find(row=>row.id==='999').active,false);assert.equal(value.qboReadAttempts,4);assert.equal(h.posts,0);assert.ok(h.events.every(row=>row.method==='GET'));assert.ok(!JSON.stringify(value).includes('CurrentBalance'));assert.ok(!JSON.stringify(value).includes('999999999'));
  const before=h.events.length;const status=await h.service.status(h.user);assert.equal(h.events.length,before);assert.equal(status.qboReads,0);assert.equal(status.protection.closedThrough,null);
});
test('record-only, close and reopening retain distinct outcomes and preserve calendar, original sources and actual QBO protection',async()=>{
  const h=fixture(),request=await h.make('record'),control=clone(h.data.Policies[0].periodControl),record=await h.service.apply(h.user,await h.reviewInput(request));
  assert.equal(record.mode,'record');assert.deepEqual(h.data.Policies[0].periodControl,control);
  const calendar=clone(h.calendar()),sources=JSON.stringify(h.data.Audits.filter(row=>row.action==='Manual report check recorded'));
  request.mode='close';request.advanceReconciled=true;request.requestKey='cccccccc-1111-4111-8111-111111111111';const value=await h.reviewInput(request),closed=await h.service.apply(h.user,value);
  assert.equal(closed.current,true);assert.equal(h.data.Policies[0].periodControl.closedThrough,'2026-09-30');assert.equal(h.data.Policies[0].periodControl.reconciledThrough,'2026-09-30');assert.equal(h.data.Calendars[0].verifiedThrough,calendar.verifiedThrough);assert.equal(h.data.Calendars[0].revision,calendar.revision);assert.equal(h.data.Calendars[0].stopRequested,true);assert.equal(h.data.Calendars[0].authorityRevision,calendar.authorityRevision+1);
  h.closedThrough='2026-09-15';const reopening=h.reopen(),review=await h.service.review(h.user,reopening);
  assert.equal(review.review.dateEffect.after.effectiveThrough,'2026-09-15');assert.equal(review.review.dateEffect.newlyWritableFrom,'2026-09-16');assert.equal(review.qboReadAttempts,2);
  const opened=await h.service.apply(h.user,{request:reopening,reviewHash:review.reviewHash});assert.equal(opened.current,true);assert.equal(h.closedThrough,'2026-09-15');assert.equal(h.data.Calendars[0].verifiedThrough,calendar.verifiedThrough);assert.equal(JSON.stringify(h.data.Audits.filter(row=>row.action==='Manual report check recorded')),sources);
  const retry=await h.service.apply(h.user,value);assert.equal(retry.id,closed.id);assert.equal(retry.current,false);assert.equal(h.data.Policies[0].periodControl.closedThrough,'2026-08-31');assert.equal((await h.service.status(h.user)).current.mode,'reopen');
});
test('all thirteen current critical reports need full-company exact-period Accrual sources and mandatory balance checks cannot be waived',async()=>{
  const h=fixture(),request=await h.make();assert.equal(request.reportChecks.length,13);
  let changed=clone(request);changed.reportChecks=changed.reportChecks.slice(0,7);let review=await h.service.review(h.user,changed);assert.equal(review.review.readyToApply,false);assert.match(review.review.blockers.join(' '),/13 required/);
  changed=clone(request);const selected=changed.reportChecks.find(row=>row.key==='report.balance-sheet'),row=event(h,selected.id),original=clone(row);
  for(const mutate of [p=>p.request.filters='Customer selected',p=>p.request.basis='Cash',p=>p.request.period.throughDate='2026-09-29',p=>p.request.observedOn='2026-09-29']){
    Object.assign(row,clone(original));mutate(row.afterState.payload);row.afterState.payload.requestHash=hash(row.afterState.payload.request);row.afterState.requestHash=row.afterState.payload.requestHash;row.afterState.evidenceHash=hash(row.afterState.payload);selected.evidenceHash=row.afterState.evidenceHash;
    await assert.rejects(h.service.review(h.user,changed),/full-company|exact elapsed/);
  }
  Object.assign(row,original);const body=clone(h.reportInputs.find(row=>row.reportKey==='report.balance-sheet'));body.requestKey='dddddddd-1111-4111-8111-111111111111';body.checks.availability={status:'not-applicable',note:'Fixture owner claims this mandatory balance check does not apply.'};const saved=await h.manual.save(h.user,body);
  changed=clone(request);Object.assign(changed.reportChecks.find(row=>row.key===body.reportKey),{id:saved.id,evidenceHash:saved.evidenceHash});review=await h.service.review(h.user,changed);assert.equal(review.review.readyToApply,false);
});
test('bank/card signs, item references, posted-correction attestations, exclusions and unsupported currencies remain explicit',async()=>{
  const h=fixture(),request=await h.make();const bank=request.bankChecks.find(row=>row.accountId!=='999'),card=request.bankChecks.find(row=>row.accountId==='999');
  bank.items=[{kind:'receipt',date:'2026-09-29',reference:'Fixture deposit in transit',amount:'100.25'},{kind:'payment',date:'2026-09-28',reference:'Fixture outstanding cheque',amount:'25.10'}];bank.bookBalance='1075.15';
  card.items=[{kind:'receipt',date:'2026-09-30',reference:'Fixture uncleared card charge',amount:'20.00'},{kind:'payment',date:'2026-09-30',reference:'Fixture uncleared card payment',amount:'5.00'}];card.bookBalance='240.00';
  let review=await h.service.review(h.user,request);assert.equal(review.review.readyToApply,true);assert.ok(review.review.bankResults.every(row=>row.differenceCents===0));assert.equal(review.review.bankResults.find(row=>row.accountId==='999').orientation,'positive-amount-owed');
  bank.confirmPosted=false;review=await h.service.review(h.user,request);assert.equal(review.review.readyToApply,false);bank.confirmPosted=true;
  bank.bookBalance='1075.16';review=await h.service.review(h.user,request);assert.equal(review.review.bankResults.find(row=>row.accountId===bank.accountId).differenceCents,1);assert.equal(review.review.readyToApply,false);
  bank.bookBalance='1075.15';card.status='excluded';card.items=[];card.statementBalance='';card.bookBalance='';card.confirmMatched=false;card.confirmPosted=false;review=await h.service.review(h.user,request);assert.equal(review.review.readyToApply,false);request.advanceReconciled=false;review=await h.service.review(h.user,request);assert.equal(review.review.readyToApply,true);assert.equal(review.review.exceptions[0].kind,'account-excluded');assert.equal(review.review.dateEffect.after.reconciledThrough,null);
  request.bankChecks[0].items.push({kind:'adjustment',date:'2026-09-30',reference:'Unposted balancing amount',amount:'1.00'});await assert.rejects(h.service.review(h.user,request),/outstanding/);
});
test('current account additions/currency changes and changed report/catalog/closing facts invalidate review',async()=>{
  const h=fixture(),request=await h.make(),value=await h.reviewInput(request);
  h.records.get('account:999').record.CurrencyRef.value='USD';await assert.rejects(h.service.apply(h.user,value),/inventory changed/);assert.equal(h.data.Policies[0].periodControl.closedThrough,null);h.records.get('account:999').record.CurrencyRef.value='CAD';
  h.closedThrough='2026-08-31';await assert.rejects(h.service.apply(h.user,value),/reviewed evidence/);h.closedThrough=null;
  h.reportDefinitions.find(row=>row.key==='report.trial-balance').lastVerified='2026-10-16';await assert.rejects(h.service.apply(h.user,value),/current critical/);
});
test('source withdrawal is rechecked in the owner-fenced transaction and later withdrawal preserves protection with changed support',async()=>{
  const h=fixture(),request=await h.make(),value=await h.reviewInput(request),body=h.reportInputs.find(row=>row.reportKey==='report.trial-balance');
  await h.manual.withdraw(h.user,{request:body,reason:'Fixture owner withdrew this exact report source after reviewing its evidence.'});
  await assert.rejects(h.service.apply(h.user,value),/withdrawn/);assert.equal(h.data.Policies[0].periodControl.closedThrough,null);
  const second=fixture(),request2=await second.make(),saved=await second.service.apply(second.user,await second.reviewInput(request2));await second.manual.withdraw(second.user,{request:second.reportInputs[0],reason:'Fixture owner withdraws a supporting manual report after the period decision.'});
  const detail=await second.service.detail(second.user,saved.id);assert.equal(detail.current,true);assert.equal(detail.support.status,'support-changed');assert.equal(second.data.Policies[0].periodControl.closedThrough,'2026-09-30');
});
test('previewed plans, unsettled steps/receipts, pending calendar commits and legacy/master workers block before accounting reads',async()=>{
  const h=fixture(),request=await h.make(),base=clone(h.data),legacy=clone(h.legacy),calendar=h.calendar();
  const cases=[()=>h.data.Runs.push({_id:'1'.repeat(24),...scope,status:'previewed'}),()=>h.data.Steps.push({_id:'2'.repeat(24),...scope,state:'sending'}),()=>h.data.Receipts.push({_id:'3'.repeat(24),...scope,state:'unknown'}),()=>h.data.Writers[0].unresolved={unknown:true},()=>h.data.Calendars[0].pendingCommit={pending:true},()=>h.legacy.masterpreparationruns.push({_id:'4'.repeat(24),...scope,claim:'open',state:'complete'}),()=>h.legacy.generationruns.push({_id:'5'.repeat(24),realmId:scope.realmId,status:'in_progress'})];
  const initial=clone(h.data);
  for(const setup of cases){h.data=clone(initial);h.legacy=clone(legacy);setup();const reads=h.events.length;await assert.rejects(h.service.review(h.user,request),/Finish|uncertain|work/);assert.equal(h.events.length,reads);}
  assert.equal(calendar.verifiedThrough,'2026-09-30');assert.equal(base.Policies[0].periodControl.closedThrough,null);
});
test('lost acknowledgements and concurrent exact confirmations retain one decision; conflicting identities cannot replay',async()=>{
  const h=fixture(),request=await h.make(),value=await h.reviewInput(request);h.loseReply=true;
  const first=await h.service.apply(h.user,value),again=await h.service.apply(h.user,value);assert.equal(first.id,again.id);assert.equal(h.data.Audits.filter(row=>row.action===C.ACTION).length,1);
  const changed=clone(value);changed.request.reason+=' Different decision.';await assert.rejects(h.service.apply(h.user,changed),/identity belongs/);
});
test('cancelling during pending SDK reads prevents late apply without changing writer ownership; applied decisions cannot become fake cancellations',async()=>{
  const h=fixture(),request=await h.make(),value=await h.reviewInput(request),original=h.client.oauthClient.axiosInstance;
  let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  h.client.oauthClient.axiosInstance=async(...args)=>{entered();await gate;return original(...args);};
  const applying=h.service.apply(h.user,value);await started;const writer=clone(h.data.Writers[0]),cancelled=await h.service.cancel(h.user,{input:value,reason:'Fixture owner cancels this exact unconfirmed period decision.'});assert.equal(cancelled.status,'cancelled');assert.deepEqual(h.data.Writers[0],writer);release();const result=await applying;assert.equal(result.status,'cancelled');assert.equal(h.data.Policies[0].periodControl.closedThrough,null);assert.equal(h.data.Audits.filter(row=>row.action===C.ACTION).length,1);
  h.client.oauthClient.axiosInstance=original;const second=clone(request);second.requestKey='eeeeeeee-1111-4111-8111-111111111111';const next=await h.reviewInput(second),applied=await h.service.apply(h.user,next);h.data.Writers[0].operationId='f'.repeat(24);const before=clone(h.data.Writers[0]),terminal=await h.service.cancel(h.user,{input:next,reason:'Fixture owner tries cancellation after an applied decision.'});assert.equal(terminal.status,'applied');assert.equal(terminal.id,applied.id);assert.deepEqual(h.data.Writers[0],before);
});
test('reader cancellation rejects a stalled original SDK result and never admits later account pages',async()=>{
  const h=fixture(),original=h.client.oauthClient.axiosInstance,controller=new AbortController();let entered,release;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  h.client.oauthClient.axiosInstance=async(...args)=>{entered();await gate;return original(...args);};
  const pending=h.service.accounts(h.user,{signal:controller.signal});await started;controller.abort();await assert.rejects(pending,/cancelled/);release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.ok(h.events.length<=1);assert.equal(h.data.Audits.length,0);
});
test('malformed preferences, incomplete/repeated account pages and changed matching scans fail closed',async()=>{
  for(const prefs of [[],null,'bad']){
    const h=fixture(),original=h.client.oauthClient.axiosInstance;h.client.oauthClient.axiosInstance=async(url,options)=>{const result=await original(url,options);if(new URL(url).searchParams.get('query')?.includes('FROM Preferences'))result.data.QueryResponse.Preferences[0].AccountingInfoPrefs=prefs;return result;};
    await assert.rejects(h.service.accounts(h.user),/preferences are unavailable/);assert.equal(h.data.Audits.length,0);
  }
  const h=fixture(),original=h.client.oauthClient.axiosInstance;let scans=0;
  h.client.oauthClient.axiosInstance=async(url,options)=>{const result=await original(url,options);if(new URL(url).searchParams.get('query')?.includes('FROM Account') && ++scans===2)result.data.QueryResponse.Account[0].Name+=' changed';return result;};
  await assert.rejects(h.service.accounts(h.user),/changed during review/);
});
test('audit failure, calendar admission conflict and crossing final evidence expiry roll all protection changes back',async()=>{
  for(const kind of ['audit','calendar','expiry']){
    const h=fixture(),request=await h.make();h.calendar();const value=await h.reviewInput(request),before=clone(h.data.Policies[0]),calendar=clone(h.data.Calendars[0]);
    if(kind==='audit')h.failCreate='Audits';
    if(kind==='calendar')h.models.Calendars.findOneAndUpdate=()=>({lean:async()=>null});
    if(kind==='expiry'){const update=h.models.Policies.findOneAndUpdate;h.models.Policies.findOneAndUpdate=(...args)=>{const q=update(...args),lean=q.lean;q.lean=async()=>{const result=await lean.call(q);h.clock+=180001;return result;};return q;};}
    await assert.rejects(h.service.apply(h.user,value));assert.deepEqual(h.data.Policies[0],before);assert.deepEqual(h.data.Calendars[0],calendar);assert.equal(h.data.Audits.filter(row=>row.action===C.ACTION).length,0);
  }
});
test('rehashed retained source/control drift, foreign actors and oversized envelopes fail historical reads and terminal replay',async()=>{
  const h=fixture(),request=await h.make(),value=await h.reviewInput(request),saved=await h.service.apply(h.user,value),original=clone(event(h,saved.id));
  const changes=[row=>{const s=row.afterState.payload.observations;s.preferences.closedThrough='2026-01-01';const {sourceHash,...body}=s;s.sourceHash=hash(body);},row=>row.afterState.payload.resultingControl.closedThrough='2026-08-31',row=>row.actorUserId=actorId,row=>row.afterState.payload.extra='x'.repeat(C.MAX_DECISION_BYTES)];
  for(const change of changes){Object.assign(event(h,saved.id),clone(original));const row=event(h,saved.id);change(row);row.afterState.decisionHash=hash(row.afterState.payload);await assert.rejects(h.service.detail(h.user,saved.id));await assert.rejects(h.service.apply(h.user,value));}
  Object.assign(event(h,saved.id),original);const history=await h.service.status(h.user);assert.equal(history.history.items[0].verified,false);assert.deepEqual(Object.keys(history.history.items[0]).sort(),['id','message','recordedAt','verified']);
});
test('current member, owner, connection and storage authority gate decisions; read-only evidence does not resolve QBO clients',async()=>{
  const h=fixture(),request=await h.make(),value=await h.reviewInput(request);h.data.Memberships[0].role='reviewer';const reads=h.events.length,status=await h.service.status(h.user);assert.equal(status.canManage,false);assert.equal(h.events.length,reads);await assert.rejects(h.service.apply(h.user,value),/permission/);h.data.Memberships[0].role='lab-owner';
  await assert.rejects(h.service.review({id:ownerId,actorId},request),/permission|owner/);h.connected=false;await assert.rejects(h.service.apply(h.user,value),/Connect/);h.connected=true;h.notReady=true;await assert.rejects(h.service.apply(h.user,value),/unprepared/);
});
test('closing reuses central protected-period enforcement and reopening cannot lower QuickBooks own cutoff',async()=>{
  const h=fixture(),request=await h.make(),saved=await h.service.apply(h.user,await h.reviewInput(request));assert.ok(saved.current);
  const control=h.data.Policies[0].periodControl,write=freezeWriteRequest(scope,'POST','invoice',{TxnDate:'2026-09-30',CustomerRef:{value:'1'},Line:[]}),startedAt=new Date(h.clock).toISOString(),source={version:2,autoApplyCredit:false,scope,coordination:null,requestHash:write.requestHash,startedAt,observedAt:startedAt,directDates:['2026-09-30'],affectedDates:['2026-09-30'],records:[],preferencesHash:hash('fixture-prefs'),qboClosedThrough:null},evidence={...source,evidenceHash:hash(source)};
  assert.throws(()=>assertWritePeriod(write,evidence,control,h.clock,ownerId),/closed or reconciled/);
  h.closedThrough='2026-09-30';const reopen=h.reopen(),review=await h.service.review(h.user,reopen);assert.equal(review.review.dateEffect.newlyWritableFrom,null);await h.service.apply(h.user,{request:reopen,reviewHash:review.reviewHash});const later={...source,qboClosedThrough:'2026-09-30'};assert.throws(()=>assertWritePeriod(write,{...later,evidenceHash:hash(later)},h.data.Policies[0].periodControl,h.clock,ownerId),/closed or reconciled/);
});

test('combined request, complete current inventory and report snapshots exceed the explicit close cap without changing protection',async()=>{
  const h=fixture();await h.seedReports();
  for(const [index,body] of h.reportInputs.entries()){
    const next=clone(body);next.requestKey=String(index+401).padStart(8,'0')+'-1111-4111-8111-111111111111';
    const mandatory=['report.balance-sheet','report.trial-balance'].includes(next.reportKey);
    for(const row of [...Object.values(next.checks),...next.assertions]){row.status=mandatory?'passed':'not-applicable';row.note='Fixture owner retains a detailed source-specific checked result or explicit close exception. '.padEnd(1000,'x');}
    h.clock+=1000;await h.manual.save(h.user,next);
  }
  for(let i=0;i<372;i++){const id=String(2000+i);h.records.set('account:'+id,{entity:'Account',record:{Id:id,SyncToken:'0',Active:true,Name:('Fixture '+id+' ').padEnd(500,'x'),AccountType:i<62?'Bank':'Income',CurrencyRef:{value:'CAD'}}});}
  const request=await h.make(),bank=request.bankChecks.find(row=>row.accountId!=='999');bank.items=Array.from({length:128},(_,i)=>({kind:'receipt',date:'2026-09-30',reference:('Fixture independent timing source '+i+' ').padEnd(300,'x'),amount:'1.00'}));bank.bookBalance='1128.00';
  assert.ok(Buffer.byteLength(JSON.stringify(request))<96000,'The request alone fits; its combined retained sources must exceed the close budget.');
  const control=clone(h.data.Policies[0]);
  await assert.rejects(h.service.review(h.user,request),/size budget/);assert.deepEqual(h.data.Policies[0],control);assert.equal(h.data.Audits.filter(row=>row.action===C.ACTION).length,0);assert.equal(h.posts,0);
  assert.throws(()=>C.bounded({payload:'x'.repeat(C.MAX_DECISION_BYTES)}),/size budget/);
});

test('new-review readiness is separate from exact recovery, and missing/corrupt protection never becomes an absent-cutoff claim',async()=>{
  const h=fixture();h.data.Policies=[];h.data.Writers=[];let status=await h.service.status(h.user);
  assert.equal(status.canManage,true);assert.equal(status.canReview,false);assert.equal(status.protectionStatus,'unprepared');
  const other=fixture(),request=await other.make(),input=await other.reviewInput(request),saved=await other.service.apply(other.user,input);
  other.data.Policies[0].periodControl.closedThrough='2026-08-31';status=await other.service.status(other.user);
  assert.equal(status.canManage,true);assert.equal(status.canReview,false);assert.equal(status.protection,null);assert.equal(status.protectionStatus,'unavailable');assert.equal(status.current.current,false);
  const terminal=await other.service.cancel(other.user,{input,reason:'Fixture owner resolves the old pending decision while current protection needs recovery.'});assert.equal(terminal.id,saved.id);assert.equal(terminal.status,'applied');assert.equal(terminal.current,false);
});
test('reconciliation advancement cannot skip an earlier unreviewed bank period, and reopening never raises either cutoff',async()=>{
  const h=fixture();h.period={fromDate:'2026-10-01',throughDate:'2026-10-15'};
  const original=h.data.Policies[0].periodControl,{contentHash,...before}=original;
  const value={...before,closedThrough:'2026-09-30',reconciledThrough:'2026-08-31'};h.data.Policies[0].periodControl={...value,contentHash:hash(value)};
  const request=await h.make();let review=await h.service.review(h.user,request);assert.equal(review.review.readyToApply,false);assert.match(review.review.blockers.join(' '),/gap after previous reconciliation/);
  request.advanceReconciled=false;review=await h.service.review(h.user,request);assert.equal(review.review.readyToApply,true);assert.equal(review.review.dateEffect.after.reconciledThrough,'2026-08-31');
  const reopening=h.reopen();reopening.closedThrough='2026-10-01';await assert.rejects(h.service.review(h.user,reopening),/only lower/);
});
