'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { buildGeneralBatch, classifyGeneralResponse } = require('../src/modules/general-write-transport');
const { createGeneralWriteService } = require('../src/modules/general-write-service');
const recovery = require('../src/modules/general-billpayment-recovery');
const { incident, scope, ownerId, clock } = require('./helpers/general-estimate-fixture');
const clone = value => structuredClone(value);
const chain = value => ({select(){return this;},sort(){return this;},limit(){return this;},session(){return this;},maxTimeMS(){return this;},lean:async()=>clone(value)});
function fixture() {
  const base=incident(), run=base.run, receipt=base.receipt, models=base.models, authorities=[], audits=[];
  const payments=['11357','11358'].map((id,n)=>{
    const payload={TxnDate:'2026-11-01',VendorRef:{value:'2'},CurrencyRef:{value:'CAD'},APAccountRef:{value:'59'},PayType:'Check',CheckPayment:{BankAccountRef:{value:'50'}},TotalAmt:n?957.60:834.48,Line:[{Amount:n?957.60:834.48,LinkedTxn:[{TxnId:String(11000+n),TxnType:'Bill'}]}]};
    const record={...clone(payload),Id:id,SyncToken:'0',Line:[{Id:'1',...clone(payload.Line[0])}],MetaData:{CreateTime:'2026-11-01T04:00:00Z',LastUpdatedTime:'2026-11-01T04:00:00Z'}};delete record.APAccountRef;
    return {ref:'pay'+n,payload,record};
  });
  const batch={index:0,attempt:1,requestId:'d'.repeat(32),state:'answered',sends:1,items:payments.map((p,n)=>({bId:String(n+1),ref:p.ref,op:'create',operation:'create',entity:'BillPayment',payload:clone(p.payload)}))};
  const response=payments.map((p,n)=>({bId:String(n+1),BillPayment:clone(p.record)}));
  const observed=classifyGeneralResponse(scope,batch,{status:200,json:{BatchItemResponse:response}});
  Object.assign(receipt,{observed,requestHash:buildGeneralBatch(scope,batch).requestHash});
  batch.transport={receiptId:receipt._id,outcome:'saved',response,items:observed.items};
  Object.assign(run,{day:'2026-11-01',plan:{operations:payments.map(p=>({ref:p.ref,op:'create',entity:'BillPayment',payload:clone(p.payload)})),layers:[payments.map(p=>p.ref)]},batches:[batch],items:Object.fromEntries(payments.map(p=>[p.ref,{outcome:'mismatch',entity:'BillPayment',op:'create',attempt:1,qboId:p.record.Id,version:'0',request:clone(p.payload),record:clone(p.record)}])),owned:payments.map(p=>({key:'BillPayment:'+p.record.Id,ref:p.ref,op:'create'}))});
  models.GeneralWriteRuns.find=()=>chain([run]);
  models.Authorities={findOne:f=>chain(authorities.find(a=>a._id===f._id)||null),create:async rows=>{authorities.push(...clone(rows));return clone(rows);}};
  models.Audits={create:async rows=>{audits.push(...clone(rows));return clone(rows);}};
  const columns=['tx_date','txn_type','doc_num','name','memo','split_acc','debt_amt','credit_amt'].map(ColType=>({ColType,ColTitle:ColType}));
  const row=(p,debit)=>({type:'Data',ColData:[{value:p.record.TxnDate},{value:'Bill Payment (Cheque)',id:p.record.Id},{value:''},{value:''},{value:''},{value:''},{value:debit?p.payload.TotalAmt.toFixed(2):''},{value:debit?'':p.payload.TotalAmt.toFixed(2)}]});
  const report={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:run.day,EndPeriod:run.day},Columns:{Column:columns},Rows:{Row:['59','50'].map((id,n)=>({type:'Section',Header:{ColData:[{value:'Fictional account',id}]},Rows:{Row:payments.map(p=>row(p,n===0))}}))}};
  let reads=0,reports=0,sends=0,onFetch=()=>{},ordinary=false;
  const copy={read:async(_s,_e,id)=>clone(payments.find(p=>p.record.Id===id)?.record||null),fetch:async(_s,_e,id)=>{reads++;onFetch(reads);return clone(payments.find(p=>p.record.Id===id)?.record||null);}};
  const api=()=>createGeneralWriteService({models,copy,recoveryLedger:async()=>{reports++;return clone(report);},now:()=>clock,dispatchEnabled:()=>ordinary,authorizeRecovery:async()=>{},transaction:async work=>{const original=clone(run),writer=clone(base.writer),as=clone(authorities),au=clone(audits);try{return await work({inTransaction:()=>true});}catch(e){Object.assign(run,original);Object.assign(base.writer,writer);authorities.splice(0,authorities.length,...as);audits.splice(0,audits.length,...au);throw e;}},contextFor:async()=>{throw Error('No new preparation');},transport:{sendBatch:async()=>{sends++;if(!ordinary)throw Error('No dispatch');run.batches[0].transport={receiptId:receipt._id,outcome:'saved',response:clone(response),items:clone(observed.items)};return clone(response);}}});
  return {run,receipt,models,payments,report,authorities,audits,copy,base,executeFirst:async()=>{ordinary=true;run.day='2026-11-02';run.status='sending';run.items={};run.owned=[];run.batches[0].state='sending';run.batches[0].sends=0;delete run.batches[0].transport;return api().execute({scope,ownerId,actorId:ownerId},run._id);},onFetch:fn=>{onFetch=fn;},counts:()=>({reads,reports,sends}),execute:()=>api().reconcileSaved({scope,ownerId,actorId:ownerId},run._id)};
}
test('two saved payments are verified from one exact ledger report without changing receipts or issuing payments',async()=>{
  const h=fixture(),originalBatches=clone(h.run.batches),originalReceipt=clone(h.receipt),originalRequests=h.payments.map(p=>clone(p.payload));
  const result=await h.execute();assert.equal(result.status,'complete');assert.deepEqual(h.counts(),{reads:4,reports:1,sends:0});
  assert.deepEqual(h.run.batches,originalBatches);assert.deepEqual(h.receipt,originalReceipt);assert.deepEqual(h.payments.map(p=>p.payload),originalRequests);
  assert.equal(h.authorities.length,1);assert.equal(h.audits.length,1);
  for(const p of h.payments){const item=h.run.items[p.ref];assert.equal(item.outcome,'saved');assert.equal(item.record.APAccountRef,undefined);assert.equal(item.originalSavedRecord.APAccountRef,undefined);assert.equal(item.request.APAccountRef.value,'59');assert.equal(item.qboId,p.record.Id);}
  await h.execute();assert.deepEqual(h.counts(),{reads:4,reports:1,sends:0});
});
test('receipt-authenticated proof supplies only the requested AP to day close and still needs a fresh exact ledger',async()=>{
  const h=fixture();await h.execute();const {generalRecordsFor,parseLedger}=require('../src/modules/general-write-day-close'),{evaluateDay}=require('../src/modules/general-write-close');
  const gathered=await generalRecordsFor({Runs:h.models.GeneralWriteRuns,scope,day:h.run.day,copy:h.copy,models:h.models,now:()=>clock});
  const ledger=parseLedger(h.report,h.run.day).byRecord,ctx={payables:'999'};
  const result=evaluateDay({records:gathered.records,ledger,ctx,fromDate:h.run.day});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.movements.some(r=>JSON.stringify(r).includes('59')));
  const wrong=clone(ledger);wrong['BillPayment:11357'][0].accountId='999';assert.equal(evaluateDay({records:gathered.records,ledger:wrong,ctx,fromDate:h.run.day}).ok,false);
  const offset=clone(ledger);offset['BillPayment:11357'].push({accountId:'50',cents:100},{accountId:'50',cents:-100});assert.equal(evaluateDay({records:gathered.records,ledger:offset,ctx,fromDate:h.run.day}).ok,false);
  const forged=clone(gathered.records);assert.equal(evaluateDay({records:forged,ledger,ctx,fromDate:h.run.day}).ok,false,'serialized or caller-created objects cannot waive an AP request');
});
test('a changed request, original receipt, scope, unknown sibling or returned financial field cannot acquire an omission proof',()=>{
  for(const change of [h=>h.receipt.observed.items[0].responseHash='0'.repeat(64),h=>h.receipt.ownerId='f'.repeat(24),h=>h.receipt.connectionId='f'.repeat(24),h=>h.run.items.pay0.request.APAccountRef.value='999',h=>h.run.items.pay0.record.TotalAmt++,h=>h.run.items.other={outcome:'unknown'},h=>h.run.items.pay0.record.APAccountRef={value:'999'}]){const h=fixture();change(h);assert.equal(recovery.sourceOf(h.run,'pay0',h.receipt),null);}
});
test('wrong account, bank, debit, currency, duplicate or offset ledger rows cannot clear the saved mismatch',async()=>{
  for(const change of [h=>h.report.Rows.Row[0].Header.ColData[0].id='999',h=>h.report.Rows.Row[1].Header.ColData[0].id='999',h=>h.report.Rows.Row[0].Rows.Row[0].ColData[6].value='834.49',h=>h.report.Rows.Row[0].Rows.Row.push(clone(h.report.Rows.Row[0].Rows.Row[0])),h=>{const r=clone(h.report.Rows.Row[0].Rows.Row[0]);r.ColData[6].value='1.00';h.report.Rows.Row[0].Rows.Row.push(r);const q=clone(r);q.ColData[6].value='';q.ColData[7].value='1.00';h.report.Rows.Row[0].Rows.Row.push(q);}]){const h=fixture();change(h);assert.equal((await h.execute()).status,'needs-correction');assert.equal(h.authorities.length,0);assert.equal(h.counts().sends,0);}
  const h=fixture();h.report.Header.Currency='USD';await assert.rejects(h.execute(),/complete CAD/);assert.equal(h.run.items.pay0.outcome,'mismatch');
});
test('changing payments or a concurrent writer and revoked membership retain the original saved mismatch',async()=>{
  const changed=fixture();changed.onFetch(n=>{if(n===3)changed.payments[0].record.CheckPayment.BankAccountRef.value='999';});assert.equal((await changed.execute()).status,'needs-correction');
  const racing=fixture();racing.onFetch(n=>{if(n===4)racing.base.writer.revision++;});await assert.rejects(racing.execute(),/writer changed/);assert.equal(racing.run.items.pay0.outcome,'mismatch');assert.equal(racing.authorities.length,0);
  const revoked=fixture();revoked.models.Memberships.findOneAndUpdate=()=>chain(null);await assert.rejects(revoked.execute(),/permission changed/);assert.equal(revoked.run.items.pay0.outcome,'mismatch');
  const unknown=fixture();unknown.base.overlap();assert.equal((await unknown.execute()).status,'needs-correction');assert.deepEqual(unknown.counts(),{reads:0,reports:0,sends:0});
});
test('tampered retained authority or changed current payment cannot be consumed at close',async()=>{
  const {generalRecordsFor}=require('../src/modules/general-write-day-close');
  for(const change of [h=>h.authorities[0].payload.payments[0].apAccountId='999',h=>h.run.items.pay0.originalSavedRecord.TotalAmt++,h=>h.payments[0].record.VendorRef.value='999']){const h=fixture();await h.execute();change(h);await assert.rejects(generalRecordsFor({Runs:h.models.GeneralWriteRuns,scope,day:h.run.day,copy:h.copy,models:h.models,now:()=>clock}),/proof is unavailable/);}
});
test('saved-only reconciliation leaves an unsent sibling prepared without dispatching it',async()=>{
  const h=fixture();h.run.plan.operations.push({ref:'later',op:'create',entity:'Customer',payload:{DisplayName:'Fictional unsent customer'}});const result=await h.execute();assert.equal(result.status,'prepared');assert.equal(h.run.items.later,undefined);assert.equal(h.counts().sends,0);
});

test('unknown postings, missing payment dates and two-sided net rows cannot mint a proof',async()=>{
  for(const change of [h=>{const r=clone(h.report.Rows.Row[0].Rows.Row[0]);r.ColData[1]={value:'Unrecognized kind',id:'999'};h.report.Rows.Row[0].Rows.Row.push(r);},h=>h.report.Rows.Row[0].Rows.Row[0].ColData[0].value='',h=>{const r=h.report.Rows.Row[0].Rows.Row[0];r.ColData[6].value='844.48';r.ColData[7].value='10.00';}]){const h=fixture();change(h);await assert.rejects(h.execute(),/unattributed|exact date|single posting side/);assert.equal(h.authorities.length,0);assert.equal(h.run.items.pay0.outcome,'mismatch');}
});

test('fresh day-close reports reject omitted dates, two-sided net rows and wrong report currency',async()=>{
  const {generalRecordsFor,closeGeneralDay}=require('../src/modules/general-write-day-close');
  const h=fixture();await h.execute();const gathered=await generalRecordsFor({Runs:h.models.GeneralWriteRuns,scope,day:h.run.day,copy:h.copy,models:h.models,now:()=>clock});
  const close=ledgerReport=>closeGeneralDay({Runs:h.models.GeneralWriteRuns,scope,day:h.run.day,copy:h.copy,gathered,models:h.models,ledgerReport,ctx:{payables:'999'},verifiedThrough:'2026-10-31',openingDate:'2026-10-01'});
  const result=await close(h.report);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal((await closeGeneralDay({Runs:h.models.GeneralWriteRuns,models:h.models,scope,day:h.run.day,copy:h.copy,ledgerReport:h.report,ctx:{payables:'999'}})).ok,true,'direct close hydrates from explicit offline stores');
  for(const change of [r=>r.Rows.Row[0].Rows.Row[0].ColData[0].value='',r=>{r.Rows.Row[0].Rows.Row[0].ColData[6].value='844.48';r.Rows.Row[0].Rows.Row[0].ColData[7].value='10.00';},r=>r.Header.Currency='USD']){const report=clone(h.report);change(report);await assert.rejects(close(report),/exact date|single posting side|complete CAD/);}
});

test('credit-card-labelled rows cannot verify a cheque payment in recovery or fresh close',async()=>{
  const h=fixture();h.report.Rows.Row[0].Rows.Row[0].ColData[1].value='Bill Payment (Credit Card)';await assert.rejects(h.execute(),/different ledger transaction type/);assert.equal(h.authorities.length,0);
  const good=fixture();await good.execute();const {generalRecordsFor,closeGeneralDay}=require('../src/modules/general-write-day-close');const gathered=await generalRecordsFor({Runs:good.models.GeneralWriteRuns,scope,day:good.run.day,copy:good.copy,models:good.models,now:()=>clock});good.report.Rows.Row[0].Rows.Row[0].ColData[1].value='Bill Payment (Credit Card)';
  await assert.rejects(closeGeneralDay({Runs:good.models.GeneralWriteRuns,models:good.models,scope,day:good.run.day,copy:good.copy,gathered,ledgerReport:good.report,ctx:{payables:'999'}}),/different ledger transaction type/);
});
test('one bounded reader shares the attempt allowance and abort cleanup across payment and report GETs',async()=>{
  const attempts=[],permissions=[];let signal;
  const client={apiCall:async(method,endpoint,_body,_a,_b,control)=>{assert.equal(method,'GET');signal=control.signal;await control.beforeAttempt();attempts.push(endpoint);return endpoint.startsWith('billpayment/')?{BillPayment:{Id:'11357'}}:{Header:{}};}};
  const reader=recovery.createBoundedReader({access:{resolveClient:async()=>client,authorize:async(_s,p)=>{permissions.push(p);}},scope,maxAttempts:2});
  try{await reader.copy.fetch(scope,'BillPayment','11357');await reader.ledgerFor(scope,'2026-11-01');await assert.rejects(reader.copy.fetch(scope,'BillPayment','11357'),/attempt budget/);}finally{reader.close();}
  assert.equal(attempts.length,2);assert.deepEqual(permissions,['operations.read','reports.observe']);assert.equal(signal.aborted,true);
});

test('ordinary enabled execution verifies its first saved payment batch and returns before an unsent sibling',async()=>{
  const h=fixture();h.run.plan.operations.push({ref:'later',op:'create',entity:'Customer',payload:{DisplayName:'Fictional unsent customer'}});
  const result=await h.executeFirst();assert.equal(result.status,'prepared');assert.equal(h.run.items.pay0.outcome,'saved');assert.equal(h.run.items.pay1.outcome,'saved');assert.equal(h.run.items.later,undefined);assert.deepEqual(h.counts(),{reads:4,reports:1,sends:1});
});

test('production close-gate defaults reload saved payment receipts and authority across capture',async t=>{
  const h=fixture();await h.execute();const closes=[],queries=[];
  const defaults={GeneralWriteRuns:'GeneralWriteRun',Receipts:'QboWriteReceipt',Authorities:'BusinessAuthority'};
  for(const [key,file] of Object.entries(defaults)) for(const method of ['find','findOne']) if(h.models[key][method]) {
    t.mock.method(require('../src/models/'+file),method,filter=>{queries.push({key,filter});return h.models[key][method](filter);});
  }
  t.mock.method(require('../src/models/CompanySyncRecord'),'find',()=>chain([]));
  const Closes=require('../src/models/GeneralDayClose');
  t.mock.method(Closes,'find',()=>chain(closes));
  t.mock.method(Closes,'findOne',filter=>chain(closes.find(row=>row.kind===filter.kind&&row.ok===filter.ok&&row.fromDate===filter.fromDate&&row.throughDate===filter.throughDate)||null));
  t.mock.method(Closes,'create',async rows=>{closes.push(...clone(rows));return clone(rows);});
  const {createGeneralCloseGate}=require('../src/modules/general-write-close-gate');
  const gate=createGeneralCloseGate({copy:h.copy,now:()=>clock});
  let reports=0;
  const args={fromDate:h.run.day,throughDate:h.run.day,verifiedThrough:'2026-10-31',openingDate:'2026-10-01',mappings:{accountsPayable:'999'},readLedger:async()=>{reports++;return clone(h.report);}};
  const result=await gate.assertPeriodReady(scope,args);
  assert.equal(result.results[0].ok,true);
  assert.equal(closes[0].recordCount,2);
  await gate.assertPeriodReady(scope,args);
  assert.equal(reports,1,'unchanged close reuses its proved ledger');
  for(const key of ['Receipts','Authorities'])assert.ok(queries.some(q=>q.key===key),'default '+key+' was read');
  assert.ok(queries.filter(q=>['Receipts','Authorities'].includes(q.key)).every(q=>['environment','realmId','connectionId'].every(k=>q.filter[k]===scope[k])),'proof reads keep exact company scope');
  h.authorities[0].payload.payments[0].apAccountId='999';
  await assert.rejects(gate.assertPeriodReady(scope,args),/proof is unavailable/);
  assert.deepEqual(h.counts(),{reads:4,reports:1,sends:0});
});
