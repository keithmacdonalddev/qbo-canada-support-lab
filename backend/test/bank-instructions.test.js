'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/modules/bank-settlement-contract');
const {balances}=require('../src/modules/independent-bank-ledger');
const {buildGeneralBatch,itemRequest,classifyGeneralResponse}=require('../src/modules/general-write-transport');
const {createBankInstructionService,acceptedSourceHash}=require('../src/modules/bank-instruction-service');
const clone=v=>structuredClone(v),scope={environment:'sandbox',realmId:'123',connectionId:'a'.repeat(24)},ownerId='b'.repeat(24),bound={scope,ownerId,actorId:ownerId};
const at=(row,key)=>key.split('.').reduce((v,k)=>v?.[k],row);
const matches=(row,filter)=>Object.entries(filter).every(([k,w])=>w && typeof w==='object' && '$in' in w?w.$in.includes(at(row,k)):at(row,k)===w);
const chain=value=>({session(){return this;},select(){return this;},maxTimeMS(){return this;},sort(){return this;},limit(n){if(Array.isArray(value))value=value.slice(0,n);return this;},lean:async()=>clone(value)});
function fixture() {
  const runs=new Map(),receipts=new Map(),events=new Map(),ledgers=new Map(),accounts=new Map(),authorities=new Map(),calls=[],fences=[];
  let sequence=0,failEvent=null,loseCommit=false,queue=Promise.resolve();
  const models={GeneralWriteRuns:{findOne:f=>chain([...runs.values()].find(r=>matches(r,f)) || null),find:f=>chain([...runs.values()].filter(r=>matches(r,f))),findOneAndUpdate:(f,u)=>{const row=[...runs.values()].find(r=>matches(r,f));if(row){Object.assign(row,clone(u.$set));row.revision+=(u.$inc?.revision || 0);}return chain(row || null);}},Receipts:{findOne:f=>chain([...receipts.values()].find(r=>matches(r,f)) || null)},Authorities:{findOne:f=>chain([...authorities.values()].find(r=>matches(r,f)) || null)}};
  const event=(kind,id)=>[...events.values()].find(e=>e.kind===kind && e.eventId===id) || null;
  const store={assertReady:async()=>{},transaction(work){const task=queue.then(async()=>{const before={events:clone(events),runs:clone(runs)};try{const result=await work({inTransaction:()=>true});if(loseCommit){loseCommit=false;throw Object.assign(Error('commit reply lost'),{committed:true});}return result;}catch(e){if(!e.committed){events.clear();for(const pair of before.events)events.set(...pair);runs.clear();for(const pair of before.runs)runs.set(...pair);}throw e;}});queue=task.catch(()=>{});return task;},fenceAccount:async(_s,id)=>fences.push(id),getLedger:async(_s,id)=>clone(ledgers.get(id) || null),getInstruction:async(_s,id)=>clone(event('instruction','@instruction:'+id)),getInstructionByLogical:async(_s,id,key)=>clone([...events.values()].find(e=>e.kind==='instruction'&&e.accountId===id&&e.payload.logicalKey===key) || null),getReservation:async(_s,id)=>clone(event('reservation',id)),putEvent:async row=>{if(failEvent===row.accountId&&row.kind==='instruction')throw Error('injected bank write failure');const old=events.get(row._id);if(old)assert.equal(old.contentHash,row.contentHash);else events.set(row._id,clone(row));},listInstructions:async(_s,id)=>{const rows=[...events.values()].filter(e=>e.kind==='instruction'&&e.accountId===id);return {rows:clone(rows),count:rows.length};}};
  function account(id,type='Bank',currency='CAD') {
    const a={Id:id,Name:'Fictional '+id,AccountType:type,CurrencyRef:{value:currency}};accounts.set(id,a);
    const ledger={scope,ledgerId:'ledger-'+id,account:{accountId:id,accountCurrency:currency,accountType:type,accountName:a.Name,balanceConvention:type==='Credit Card'?'card-amount-owed':'bank-balance'},openingMinor:10000,throughPeriod:'2026-10',events:[],packages:[]};ledger.balance=balances(ledger);ledger.contentHash=C.hash(ledger);ledger.adoption={ownerId,actorId:ownerId,at:'2026-11-01T00:00:00Z'};
    ledgers.set(id,{...scope,kind:'ledger-account',accountId:id,accountCurrency:currency,contentHash:ledger.contentHash,payload:ledger});return a;
  }
  account('50');account('85','Credit Card');
  function createRun(operations=[{ref:'payment',entity:'Payment',payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'50'},TotalAmt:51.23}}]) {
    sequence++;const runId=sequence.toString(16).padStart(24,'0'),receiptId=C.hash({receipt:runId}),ops=operations.map(o=>({op:'create',...clone(o)}));
    const batch={index:0,attempt:1,requestId:C.hash({runId}).slice(0,32),state:'answered',sends:1,items:ops.map((o,n)=>({bId:String(n+1),ref:o.ref,entity:o.entity,op:o.op,operation:o.op,payload:clone(o.payload)}))};
    const response=ops.map((o,n)=>o.fault?{bId:String(n+1),Fault:{type:'ValidationFault',Error:[{code:'6000'}]}}:{bId:String(n+1),[o.entity==='CreditCardPayment'?'CreditCardPaymentTxn':o.entity]:{...clone(o.payload),...(o.record || {}),Id:o.qboId || String(100+sequence*10+n),SyncToken:'0',MetaData:{CreateTime:'2026-11-04T12:00:00Z',LastUpdatedTime:'2026-11-04T12:00:00Z'}}});
    for(const [n,o] of ops.entries())if(o.omit)for(const key of o.omit)delete response[n][o.entity][key];
    const observed=classifyGeneralResponse(scope,batch,{status:200,json:{BatchItemResponse:response}}),requestHash=buildGeneralBatch(scope,batch).requestHash;
    const receipt={_id:receiptId,contractVersion:1,...scope,ownerId,actorId:ownerId,operationId:runId,kind:'general-write',state:'saved',entity:'batch',operation:'create',requestHash,dispatchKey:C.hash({version:1,kind:'general-write',runId,batchIndex:0,sends:1}),workflow:{version:1,kind:'general-write',runId,batchIndex:0,sends:1},general:{version:1,contract:'general-write-v1',runId,batchIndex:0,requestId:batch.requestId,sends:1,decisionKey:'business-'+runId,items:batch.items.map(i=>({bId:i.bId,ref:i.ref,entity:i.entity,operation:i.op,requestHash:itemRequest(scope,i).requestHash}))},observed,observedAt:new Date('2026-11-04T12:00:00Z')};
    batch.transport={receiptId,outcome:'saved',response,items:observed.items};
    const run={_id:runId,contract:'general-write-v1',...scope,ownerId,actorId:ownerId,decisionKey:receipt.general.decisionKey,status:ops.some(o=>o.fault)?'needs-correction':'complete',plan:{operations:ops.map(({op,ref,entity,payload})=>({op,ref,entity,payload}))},batches:[batch],items:Object.fromEntries(ops.map((o,n)=>[o.ref,o.fault?{outcome:'fault',entity:o.entity,op:o.op}:{outcome:'saved',complete:true,entity:o.entity,op:o.op,attempt:1,request:clone(o.payload),qboId:response[n][o.entity==='CreditCardPayment'?'CreditCardPaymentTxn':o.entity].Id,record:clone(response[n][o.entity==='CreditCardPayment'?'CreditCardPaymentTxn':o.entity])}])),revision:0};
    run.bankDelivery={version:1,status:'pending',sourceHash:acceptedSourceHash(run.items),queuedAt:'2026-11-04T12:00:00Z',attempts:0,results:[]};runs.set(runId,run);receipts.set(receiptId,receipt);return {run,receipt,batch};
  }
  const service=createBankInstructionService({models,store,now:()=>Date.parse('2026-11-04T13:00:00Z'),getAccount:async(_s,id)=>clone(accounts.get(id) || null),authorize:async b=>calls.push({action:b.action,actorId:b.actorId,session:Boolean(b.session)})});
  return {service,models,store,runs,receipts,events,ledgers,accounts,authorities,calls,fences,createRun,account,instructions:()=>[...events.values()].filter(e=>e.kind==='instruction'),fail:id=>failEvent=id,loseCommit:()=>loseCommit=true};
}
test('an accepted direct receipt is independently pending once; baseline and posted balance stay frozen',async()=>{
 const h=fixture(),{run}=h.createRun(),baseline=clone(h.ledgers.get('50'));
 assert.equal((await h.service.deliver(bound,run._id)).status,'complete');const event=h.instructions()[0];assert.equal(event.payload.state,'pending');assert.equal(event.payload.amountMinor,5123);assert.equal(event.eventId,'@instruction:'+event.payload.eventId);assert.equal(event.revision,0);assert.equal(h.events.size,2);assert.equal(h.instructions().length,1);assert.deepEqual(h.ledgers.get('50'),baseline);assert.equal(baseline.payload.balance.balanceMinor,10000);assert.equal(event.payload.source.originalActorId,ownerId);assert.equal(event.payload.source.record,undefined);
 for(let i=0;i<3;i++)assert.equal((await h.service.deliver(bound,run._id)).status,'complete');assert.equal(h.instructions().length,1);
});
test('duplicate delivery under a new receipt retains the first provenance; commit-reply loss creates no duplicate',async()=>{
 const h=fixture(),{run,receipt,batch}=h.createRun();h.loseCommit();await h.service.deliver(bound,run._id);const first=clone(h.instructions()[0]);
 const replay=clone(receipt);replay._id=C.hash('new-receipt');replay.general.sends=2;replay.workflow.sends=2;replay.dispatchKey=C.hash({version:1,kind:'general-write',runId:run._id,batchIndex:0,sends:2});h.receipts.set(replay._id,replay);const current=h.runs.get(run._id);current.batches[0].transport.receiptId=replay._id;current.batches[0].sends=2;current.bankDelivery.status='pending';
 assert.equal((await h.service.deliver({...bound,actorId:'c'.repeat(24)},run._id)).status,'complete');assert.deepEqual(h.instructions()[0],first);assert.equal(first.payload.source.receiptId,receipt._id);
});
test('purchase, card credit, deposit, refund and bill payment retain native integer signs',async()=>{
 const shapes=[['Purchase',{AccountRef:{value:'85'},TotalAmt:10},-1000],['Purchase',{AccountRef:{value:'85'},TotalAmt:10,Credit:true},1000],['Deposit',{DepositToAccountRef:{value:'50'},TotalAmt:9.01},901],['RefundReceipt',{DepositToAccountRef:{value:'50'},TotalAmt:7},-700],['BillPayment',{CheckPayment:{BankAccountRef:{value:'50'}},TotalAmt:8},-800]];
 for(const [entity,body,amount] of shapes){const h=fixture(),{run}=h.createRun([{ref:'one',entity,payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},...body}}]);assert.equal((await h.service.deliver(bound,run._id)).status,'complete',entity);assert.equal(h.instructions()[0].payload.amountMinor,amount);}
});
test('both transfer/card-payment legs are atomic; no half transfer on missing ledger, currency or bank failure',async()=>{
 for(const entity of ['Transfer','CreditCardPayment']){const h=fixture(),body=entity==='Transfer'?{FromAccountRef:{value:'50'},ToAccountRef:{value:'85'}}:{BankAccountRef:{value:'50'},CreditCardAccountRef:{value:'85'}},{run}=h.createRun([{ref:'transfer',entity,payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},Amount:22,...body}}]);assert.equal((await h.service.deliver(bound,run._id)).status,'complete');assert.deepEqual(h.instructions().map(e=>e.payload.amountMinor),[-2200,2200]);assert.equal(h.instructions()[0].payload.pairedEventId,h.instructions()[1].payload.eventId);}
 for(const failure of ['missing','currency','write']){const h=fixture(),{run}=h.createRun([{ref:'transfer',entity:'Transfer',payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},Amount:22,FromAccountRef:{value:'50'},ToAccountRef:{value:'85'}}}]);if(failure==='missing')h.ledgers.delete('85');if(failure==='currency')h.accounts.get('85').CurrencyRef.value='USD';if(failure==='write')h.fail('85');const result=await h.service.deliver(bound,run._id);assert.ok(['held','failed'].includes(result.status));assert.equal(h.instructions().length,0,failure);assert.equal(h.events.size,0,failure);}
});
test('own immutable proof fails closed for scope, actor, request, response, batch and unknown state tampering',async()=>{
 const tamper=[h=>h.receipt.actorId='f'.repeat(24),h=>h.receipt.realmId='999',h=>h.receipt.general.items[0].requestHash='0'.repeat(64),h=>h.receipt.observed.items[0].responseHash='0'.repeat(64),h=>h.receipt.state='unknown',h=>h.receipt.observed.items[0].outcome='unknown',h=>h.batch.items[0].ref='different',h=>h.run.plan.operations[0].payload.TotalAmt=12,h=>h.run.items.payment.record.TotalAmt=12];
 for(const change of tamper){const h=fixture(),entry=h.createRun();change(entry);assert.equal((await h.service.deliver(bound,entry.run._id)).status,'failed');assert.equal(h.instructions().length,0);}
});
test('undeposited and deposit-contained receipts create no bank event; accepted siblings survive a definite fault',async()=>{
 for(const kind of ['undeposited','contained']){const h=fixture();h.accounts.set('99',{Id:'99',AccountType:'OtherCurrentAsset',AccountSubType:'UndepositedFunds',CurrencyRef:{value:'CAD'}});const body={TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},TotalAmt:40,DepositToAccountRef:{value:kind==='undeposited'?'99':'50'},...(kind==='contained'?{LinkedTxn:[{TxnType:'Deposit',TxnId:'8'}]}:{})},{run}=h.createRun([{ref:'payment',entity:'Payment',payload:body}]);assert.equal((await h.service.deliver(bound,run._id)).status,'complete');assert.equal(h.instructions().length,0);}
 const h=fixture(),{run}=h.createRun([{ref:'good',entity:'Deposit',payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},TotalAmt:40,DepositToAccountRef:{value:'50'}}},{ref:'bad',entity:'Customer',payload:{DisplayName:'Refused fictional party'},fault:true}]);assert.equal((await h.service.deliver(bound,run._id)).status,'complete');assert.equal(h.instructions().length,1);assert.equal(h.runs.get(run._id).status,'needs-correction');
});
test('case and non-create work cannot emit instructions; bank-origin counterparts and frozen dates remain visibly held',async()=>{
 for(const kind of ['case','update','origin-key','origin-marker','frozen']){const h=fixture(),{run,receipt}=h.createRun();if(kind==='case')run.caseAuthority={caseId:'case'};if(kind==='update')run.items.payment.op='update';if(kind==='origin-key'){run.decisionKey='bank_origin_example';receipt.general.decisionKey=run.decisionKey;}if(kind==='origin-marker')run.items.payment.request.PrivateNote='[bank-origin:existing]';if(kind==='frozen')run.items.payment.record.TxnDate='2026-10-01';run.bankDelivery.sourceHash=acceptedSourceHash(run.items);const result=await h.service.deliver(bound,run._id);assert.equal(h.instructions().length,0,kind);assert.ok(['held','failed','complete'].includes(result.status));if(kind.startsWith('origin'))assert.equal(result.status,'held');}
});
test('bank-only recovery never touches active financial execution or scans unmarked historical runs',async()=>{
 const h=fixture(),{run}=h.createRun();run.status='sending';const before=clone(run);assert.equal((await h.service.deliver(bound,run._id)).status,'waiting');assert.deepEqual(h.runs.get(run._id),before);assert.equal(h.events.size,0);
 run.status='complete';delete run.bankDelivery;assert.equal((await h.service.recover(bound)).results.length,0);assert.equal(h.events.size,0);
});
test('economic and original logical identities both prevent a second event under another instruction',async()=>{
 const h=fixture(),first=h.createRun();await h.service.deliver(bound,first.run._id);const duplicate=h.createRun([{ref:'another',entity:'Payment',qboId:first.run.items.payment.qboId,payload:clone(first.run.items.payment.request)}]);assert.equal((await h.service.deliver(bound,duplicate.run._id)).status,'failed');assert.equal(h.instructions().length,1);
 const original=h.runs.get(first.run._id);original.bankDelivery.status='pending';original.items.payment.qboId='999';original.items.payment.record.Id='999';original.bankDelivery.sourceHash=acceptedSourceHash(original.items);assert.equal((await h.service.deliver(bound,first.run._id)).status,'failed');assert.equal(h.instructions().length,1);
});
test('interrupted bank storage can recover using the accepted receipt alone with a distinct retry actor',async()=>{
 const h=fixture(),{run}=h.createRun();h.fail('50');assert.equal((await h.service.deliver(bound,run._id)).status,'failed');assert.equal(h.runs.get(run._id).items.payment.outcome,'saved');h.fail(null);const result=await h.service.recover({...bound,actorId:'c'.repeat(24)},{runId:run._id});assert.equal(result.qboCalls,0);assert.equal(result.results[0].status,'complete');assert.equal(h.instructions().length,1);assert.equal(h.instructions()[0].payload.deliveryActorId,'c'.repeat(24));assert.equal(h.instructions()[0].payload.source.originalActorId,ownerId);
});

test('accepted omitted-AP BillPayment consumes only its original immutable ledger authority, without new reads or fabricated fields',async()=>{
 const recovery=require('../src/modules/general-billpayment-recovery');
 for(const tamper of [false,true]) {
  const h=fixture(),payload={TxnDate:'2026-11-04',VendorRef:{value:'2'},CurrencyRef:{value:'CAD'},APAccountRef:{value:'59'},PayType:'Check',CheckPayment:{BankAccountRef:{value:'50'}},TotalAmt:25,Line:[{Amount:25,LinkedTxn:[{TxnId:'777',TxnType:'Bill'}]}]},entry=h.createRun([{ref:'pay',entity:'BillPayment',payload,omit:['APAccountRef']}]),{run,receipt}=entry,item=run.items.pay;
  item.originalSavedRecord=clone(item.record);
  const columns=['tx_date','txn_type','doc_num','name','memo','split_acc','debt_amt','credit_amt'].map(ColType=>({ColType,ColTitle:ColType}));
  const row=debit=>({type:'Data',ColData:[{value:payload.TxnDate},{value:'Bill Payment (Cheque)',id:item.qboId},{value:''},{value:''},{value:''},{value:''},{value:debit?'25.00':''},{value:debit?'':'25.00'}]});
  const report={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:payload.TxnDate,EndPeriod:payload.TxnDate},Columns:{Column:columns},Rows:{Row:['59','50'].map((id,n)=>({type:'Section',Header:{ColData:[{value:'Fictional account',id}]},Rows:{Row:[row(n===0)]}}))}};
  const payment={ref:'pay',paymentId:item.qboId,receiptId:receipt._id,requestHash:receipt.requestHash,originalRecordHash:C.hash(item.record),paymentHash:C.hash(item.record),record:clone(item.record),day:payload.TxnDate,apAccountId:'59',bankAccountId:'50'},proofPayload={version:1,kind:recovery.KIND,scope,operationId:run._id,ownerId,actorId:ownerId,agentAuthorityHash:C.hash(null),payments:[payment],reports:[{day:payload.TxnDate,endpoint:require('../src/modules/general-write-day-close').ledgerEndpoint(payload.TxnDate),reportHash:C.hash(report),report}],observedAt:'2026-11-04T12:30:00Z'},authorityHash=C.hash(proofPayload),authorityId=authorityHash.slice(0,24);
  h.authorities.set(authorityId,{_id:authorityId,...scope,actorId:ownerId,contentHash:authorityHash,payload:proofPayload});
  item.reconciliation={version:1,kind:recovery.KIND,authorityId,authorityHash,ref:'pay',paymentId:item.qboId,receiptId:receipt._id,requestHash:receipt.requestHash,paymentHash:C.hash(item.record)};
  run.bankDelivery.sourceHash=acceptedSourceHash(run.items);
  if(tamper)proofPayload.payments[0].apAccountId='999';
  const result=await h.service.deliver(bound,run._id);
  assert.equal(result.status,tamper?'failed':'complete');assert.equal(h.instructions().length,tamper?0:1);
  assert.equal(h.runs.get(run._id).items.pay.record.APAccountRef,undefined);assert.equal(receipt.observed.items[0].mismatch,true);
  if(!tamper)assert.equal(h.instructions()[0].payload.amountMinor,-2500);
 }
});
test('a genuine accepted frozen-date instruction is held even when absent from adopted event history',async()=>{
 const h=fixture(),{run}=h.createRun([{ref:'old',entity:'Deposit',payload:{TxnDate:'2026-10-31',CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'50'},TotalAmt:99}}]);
 const result=await h.service.deliver(bound,run._id);assert.equal(result.status,'held');assert.match(result.results[0].reason,/frozen/);assert.equal(h.instructions().length,0);
});
test('changed canonical QBO identity cannot reuse an already consumed original logical instruction',async()=>{
 const h=fixture(),{run,receipt}=h.createRun();await h.service.deliver(bound,run._id);const current=h.runs.get(run._id),batch=current.batches[0];current.items.payment.qboId='999';current.items.payment.record.Id='999';batch.transport.response[0].Payment.Id='999';
 const observed=classifyGeneralResponse(scope,batch,{status:200,json:{BatchItemResponse:batch.transport.response}});receipt.observed=observed;batch.transport.items=observed.items;current.bankDelivery.status='pending';current.bankDelivery.sourceHash=acceptedSourceHash(current.items);
 assert.equal((await h.service.deliver(bound,run._id)).status,'failed');assert.equal(h.instructions().length,1);
});

test('temporarily absent bank Account mirror is held durably and can deliver after bank-only recovery',async()=>{
 for(const entity of ['Payment','SalesReceipt']) {
  const h=fixture(),account=clone(h.accounts.get('50')),{run}=h.createRun([{ref:'receipt',entity,payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'50'},TotalAmt:40}}]);h.accounts.delete('50');
  const held=await h.service.deliver(bound,run._id);assert.equal(held.status,'held');assert.match(held.results[0].reason,/account evidence is unavailable/);assert.equal(h.instructions().length,0);assert.equal(h.runs.get(run._id).bankDelivery.status,'held');
  h.accounts.set('50',account);const recovered=await h.service.recover(bound,{runId:run._id});assert.equal(recovered.qboCalls,0);assert.equal(recovered.results[0].status,'complete');assert.equal(h.instructions().length,1);assert.equal(h.instructions()[0].payload.amountMinor,4000);
 }
 const h=fixture();h.accounts.set('99',{Id:'99',AccountType:'OtherCurrentAsset',AccountSubType:'OtherCurrentAssets',CurrencyRef:{value:'CAD'}});const {run}=h.createRun([{ref:'unknown-asset',entity:'Payment',payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'99'},TotalAmt:10}}]);assert.equal((await h.service.deliver(bound,run._id)).status,'held');assert.equal(h.instructions().length,0);
});

test('inline delivery also waits for a concurrent later batch and cannot change active QBO run metadata',async()=>{
 const h=fixture(),{run}=h.createRun();run.status='sending';run.batches.push({index:1,attempt:2,state:'sending',requestId:'f'.repeat(32),items:[]});const before=clone(run);
 const waiting=await h.service.deliver(bound,run._id,{inline:true});assert.equal(waiting.status,'waiting');assert.deepEqual(h.runs.get(run._id),before);assert.equal(h.events.size,0);
 run.batches.pop();assert.equal((await h.service.deliver(bound,run._id,{inline:true})).status,'complete');assert.equal(h.instructions().length,1);
});

test('Undeposited Funds classification requires exact returned account identity and native currency evidence',async()=>{
 for(const account of [{Id:'different',AccountType:'OtherCurrentAsset',AccountSubType:'UndepositedFunds',CurrencyRef:{value:'CAD'}},{Id:'99',AccountType:'OtherCurrentAsset',AccountSubType:'UndepositedFunds',CurrencyRef:{value:'USD'}},{Id:'99',AccountType:'OtherCurrentAsset',AccountSubType:'UndepositedFunds'}]){
  const h=fixture();h.accounts.set('99',account);const {run}=h.createRun([{ref:'receipt',entity:'Payment',payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'99'},TotalAmt:10}}]);assert.equal((await h.service.deliver(bound,run._id)).status,'held');assert.equal(h.instructions().length,0);
 }
});

test('native spaced Other Current Asset Undeposited Funds receipts are excluded for both receipt types',async()=>{
 for(const entity of ['Payment','SalesReceipt']) {
  const h=fixture();h.accounts.set('5',{Id:'5',AccountType:'Other Current Asset',AccountSubType:'UndepositedFunds',CurrencyRef:{value:'CAD'}});
  const {run}=h.createRun([{ref:'native-undeposited',entity,payload:{TxnDate:'2026-11-04',CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'5'},TotalAmt:40}}]);
  const result=await h.service.deliver(bound,run._id);assert.equal(result.status,'complete');assert.equal(result.results[0].status,'excluded');assert.match(result.results[0].reason,/Observed Undeposited Funds/);assert.equal(h.instructions().length,0);
 }
});
