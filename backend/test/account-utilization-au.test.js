'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const coverage=require('../src/modules/coverage');
const account=require('../src/modules/business-account-coverage');
const {checkGeneralWrite}=require('../src/modules/general-write-guards');
const {postingsOf}=require('../src/modules/general-write-postings');
const {createGeneralWriteService,createGeneralWriteContext}=require('../src/modules/general-write-service');
const {entitySchema}=require('../src/modules/qbo-entity-schema');
const native=JSON.parse(fs.readFileSync(require.resolve('./fixtures/foreign-currency-native.json'),'utf8'));
const stored=process.env.QBO_AU_REPLAY?JSON.parse(fs.readFileSync(process.env.QBO_AU_REPLAY,'utf8')):null;
const DAY='2026-11-01',NOW=new Date('2026-11-01T04:00:00Z');
const row=(entity,id,record)=>({entity,qboId:String(id),record:{Id:String(id),...record},deleted:false});
const source={phase:'incremental',status:'current',lastSuccessAt:NOW.toISOString(),everyMs:21600000};
const snapshot=records=>({records,sources:Object.fromEntries(require('../src/modules/business-agent-sync').ENTITIES.concat('CreditCardPayment','TaxPayment').map(e=>[e,{...source}]))});
const bank=(id,name,currency='CAD',type='Bank',sub='Checking')=>row('Account',id,{Name:name,AccountType:type,AccountSubType:sub,Active:true,CurrencyRef:{value:currency},CurrentBalance:0});
const ref=value=>({value});
const options={today:DAY,now:NOW};
test('every bank/card/cash account has independent weekly evidence, including nested account refs',()=>{
 const s=snapshot([bank(1,'Used'),bank(2,'Idle'),bank(3,'Card','CAD','Credit Card'),bank(4,'Cash','AUD','Bank','CashOnHand'),row('Purchase',5,{TxnDate:DAY,TotalAmt:20,PaymentType:'Cash',AccountRef:ref('1'),Line:[{AccountBasedExpenseLineDetail:{AccountRef:ref('1')}}]}),row('BillPayment',6,{TxnDate:'2026-10-01',CheckPayment:{BankAccountRef:ref('2')}})]);
 const c=coverage.situations(s,options),w=coverage.weekly(s,options);
 assert.equal(c.accounts.length,4);assert.equal(c.accounts.find(a=>a.id==='1').last7Days,1);assert.equal(c.accounts.find(a=>a.id==='2').total,1);
 assert.equal(w.rows.find(r=>r.key==='Account.1.weekly-use').count,1);assert.equal(w.rows.find(r=>r.key==='Account.2.weekly-use').status,'missing');
 assert.ok(c.rows.find(r=>r.key==='Account.3.card-credit'));assert.ok(c.rows.find(r=>r.key==='Account.4.foreign-rate'));
 s.sources.Purchase.status='stale';assert.equal(coverage.weekly(s,options).rows.find(r=>r.key==='Account.2.weekly-use').status,'unknown');
});
test('measurement includes windows, type breakdown, undated references and visible flags without inventing flags',()=>{
 const s=[bank(1,'Bank'),row('Purchase',2,{TxnDate:'2026-10-26',AccountRef:ref('1'),ClearedStatus:'Cleared'}),row('Deposit',3,{TxnDate:'2026-10-03',DepositToAccountRef:ref('1')}),row('Purchase',4,{AccountRef:ref('1')}),row('Purchase',5,{TxnDate:'2026-11-02',AccountRef:ref('1')})];
 const m=account.measureAccounts(s,DAY)[0];assert.equal(m.total,3);assert.equal(m.last7Days,1);assert.equal(m.last30Days,2);assert.equal(m.undated,1);assert.equal(m.transactionTypesLast7Days.Purchase,1);assert.equal(m.observedFlags[0].value,'Cleared');
});
test('reconciliation stays unknown/manual and gives exact account-currency test target',()=>{
 const a=bank(1,'AUD cash','AUD');a.record.CurrentBalance=5000;const c=coverage.situations(snapshot([a]),options);
 const r=c.rows.find(r=>r.key==='Account.1.reconciled');assert.equal(r.status,'unknown');assert.equal(r.reachability,'needs-owner-setting');assert.match(r.needed,/Needs owner in QuickBooks UI/);assert.equal(r.checklist.endingBalance,5000);assert.equal(r.checklist.statementDate,DAY);assert.equal(r.checklist.currency,'AUD');
 assert.match(r.checklist.balanceSource,/not an external statement/);assert.equal(c.accounts[0].observedFlags.length,0);
});
const query=value=>({select(){return this},session(){return this},sort(){return this},limit(){return this},maxTimeMS(){return this},lean:async()=>structuredClone(value)});
function harness(t){
 const records=new Map((stored?.records||native.records).filter(r=>!r.deleted).map(r=>[r.entity+':'+r.qboId,structuredClone(r.record)])),runs=new Map();
 // The sanitized foreign-currency fixture predates AU's CAD card-account cases.
 // Keep private stored replay inputs exact; complete only the local fallback fixture.
 if(!stored&&!records.has('Account:85'))records.set('Account:85',{Id:'85',SyncToken:'0',Active:true,Name:'Fixture CAD card',AccountType:'Credit Card',AccountSubType:'CreditCard',CurrencyRef:{value:'CAD'}});
 t.mock.method(require('../src/modules/business-authority'),'readPublishedBusiness',async()=>({view:{mappings:{salesTax:'16',purchaseTax:'16'},business:{}}}));
 const models={GeneralWriteRuns:{findOne:f=>query(f._id?runs.get(f._id)||null:null),create:async rows=>{for(const r of rows)runs.set(r._id,{items:{},batches:[],owned:[],dirty:[],revision:0,...structuredClone(r)})}},Steps:{findOne:()=>query(null)},Calendars:{findOne:()=>query({verifiedThrough:'2026-10-31'})},Policies:{findOne:()=>query({periodControl:{}})},Records:{find:()=>query([...records].filter(([k])=>/^(Account|Preferences):/.test(k)).map(([k,record])=>({entity:k.split(':')[0],qboId:record.Id,record})))}};
 const rateReads=[];const contextFor=createGeneralWriteContext({models,now:()=>NOW.getTime(),readRate:async(s,code,day)=>{rateReads.push(code);return {SourceCurrencyCode:code,TargetCurrencyCode:'CAD',AsOfDate:day,Rate:{USD:1.4,AUD:0.9,CNY:0.2}[code]}}});
 let sends=0;const api=createGeneralWriteService({models,contextFor,copy:{read:async(s,e,id)=>structuredClone(records.get(e+':'+id)||null)},now:()=>NOW.getTime(),dispatchEnabled:()=>true,transport:{sendBatch:async()=>{sends++;throw Error('Offline replay cannot send')}}});
 const bound={scope:{environment:'production',realmId:'9130357222392856',connectionId:'6a18e43d0b392890a1303e03'},ownerId:'b'.repeat(24),actorId:'b'.repeat(24)};
 return {records,runs,rateReads,sends:()=>sends,prepare:async(op,key='au-banking-replay')=>api.prepare(bound,{decisionKey:key,purpose:'Deliberate account utilization offline replay',operations:Array.isArray(op)?op:[op]})};
}
const purchase=(paymentType,id,code='CAD',credit=false)=>({ref:'expense',entity:'Purchase',op:'create',payload:{TxnDate:DAY,PaymentType:paymentType,AccountRef:ref(id),CurrencyRef:ref(code),Credit:credit,GlobalTaxCalculation:'TaxExcluded',Line:[{Amount:20,DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:ref('24'),TaxCodeRef:ref('16')}}]}});
const messages=r=>(r.problems||[]).map(p=>p.message).join(' | ');
test('real account IDs prepare Cash/Check/card/refund and USD/CNY/AUD transfers/deposits through live context and service',async t=>{
 const h=harness(t);let i=0;
 // Expense account 24 is in the native replay; choose an observed expense in a private replay.
 const expense=[...h.records.values()].find(r=>r.AccountType==='Expense'&&r.Active!==false);assert.ok(expense);
 for(const [type,id,code,credit] of [['Cash','60','CAD',false],['Check','60','CAD',false],['CreditCard','85','CAD',false],['CreditCard','85','CAD',true],['Cash','68','AUD',false],['Cash','1150040008','CNY',false]]){
  if(!h.records.has('Account:'+id))continue;const op=purchase(type,id,code,credit);op.payload.Line[0].AccountBasedExpenseLineDetail.AccountRef=ref(expense.Id);
  const result=await h.prepare(op,'au-purchase-'+i++);assert.equal(result.status,'prepared',messages(result));
  const payload=h.runs.get(result.runId).plan.operations[0].payload;if(code!=='CAD')assert.ok(payload.ExchangeRate>0);
 }
 for(const [id,code]of [['1150040002','USD'],['1150040008','CNY'],['68','AUD']]){
  if(!h.records.has('Account:'+id))continue;
  for(const reverse of [false,true]){const result=await h.prepare({ref:'sweep',op:'create',entity:'Transfer',payload:{TxnDate:DAY,CurrencyRef:ref(code),FromAccountRef:ref(reverse?id:'60'),ToAccountRef:ref(reverse?'60':id),Amount:25}},'au-transfer-'+i++);assert.equal(result.status,'prepared',messages(result));}
  const income=[...h.records.values()].find(r=>['Income','Other Income'].includes(r.AccountType)&&r.Active!==false);
  const result=await h.prepare({ref:'deposit',op:'create',entity:'Deposit',payload:{TxnDate:DAY,CurrencyRef:ref(code),DepositToAccountRef:ref(id),Line:[{Amount:20,DetailType:'DepositLineDetail',DepositLineDetail:{AccountRef:ref(income.Id)}}]}},'au-deposit-'+i++);assert.equal(result.status,'prepared',messages(result));
 }
 const card=await h.prepare({ref:'payment',op:'create',entity:'Transfer',payload:{TxnDate:DAY,FromAccountRef:ref('60'),ToAccountRef:ref('85'),Amount:50}},'au-card-payment');assert.equal(card.status,'prepared',messages(card));assert.equal(h.sends(),0);
});
test('Purchase invalid payment account, currency, Credit and invented reconciliation fields are refused',async t=>{
 const h=harness(t),expense=[...h.records.values()].find(r=>r.AccountType==='Expense'&&r.Active!==false);let i=0;
 for(const mutate of [op=>op.payload.AccountRef=ref('85'),op=>op.payload.PaymentType='Wire',op=>op.payload.Credit='true',op=>op.payload.Credit=true,op=>op.payload.ClearedStatus='Reconciled',op=>{op.payload.AccountRef=ref('1150040002');op.payload.CurrencyRef=ref('CAD')}]){
  const op=purchase('Cash','60');op.payload.Line[0].AccountBasedExpenseLineDetail.AccountRef=ref(expense.Id);mutate(op);const r=await h.prepare(op,'au-invalid-'+i++);assert.equal(r.status,'refused',messages(r));
 }
 assert.deepEqual(entitySchema('CreditCardPayment').operations,['create']);assert.equal(h.sends(),0);
});
test('foreign purchases, credits and transfers retain exact balanced CAD posting proof',()=>{
 const ctx={get:()=>null,taxAccount:()=> '58'};
 for(const credit of [false,true]) { const r=purchase('CreditCard','85','USD',credit).payload;r.ExchangeRate=1.4;r.TotalAmt=20;
 const p=postingsOf('Purchase',r,ctx);assert.equal(p.get('85'),credit?2800:-2800);assert.equal(p.get('24'),credit?-2800:2800);assert.equal([...p.values()].reduce((a,b)=>a+b,0),0); }
});
test('real stored failing utilization replays via the Coverage route scorer offline',{skip:!stored},async()=>{
 const seen=[];const models={Records:{find:f=>(seen.push(f),query(stored.records))},Agents:{findOne:f=>(seen.push(f),query({sync:{sources:stored.sources}}))}};
 const r=await coverage.getMirrorCoverage(stored.scope,{...models,now:new Date(stored.capturedAt),refresh:true});
 assert.equal(r.evidence.qboRequests,0);assert.equal(r.evidence.recordsScanned,stored.records.length);assert.equal(r.situations.accounts.length,16);
 const used=r.situations.accounts.filter(a=>a.last7Days>0);assert.deepEqual(used.map(a=>a.id),['123']);assert.equal(used[0].last7Days,60);
 assert.equal(r.weekly.rows.filter(a=>a.key.startsWith('Account.')&&a.key.endsWith('.weekly-use')&&a.count===0).length,15);
 assert.ok(r.situations.rows.find(a=>a.key==='Account.121.merchant-net'));assert.equal(r.situations.rows.filter(a=>a.checklist).length,80);assert.equal(seen.length,2);
});

test('voided transactions cannot establish weekly account use',()=>{const s=snapshot([bank(1,'Bank'),row('Purchase',2,{TxnDate:DAY,AccountRef:ref('1'),TotalAmt:0,PrivateNote:'Voided original purchase'})]);const w=coverage.weekly(s,options);assert.equal(w.rows.find(r=>r.key==='Account.1.weekly-use').count,0);});

test('foreign Purchase cannot bypass AR/AP settlement or bank/card transfer protections',async t=>{const h=harness(t);let i=0;for(const type of ['Accounts Receivable','Accounts Payable','Bank','Credit Card']) {const category=[...h.records.values()].find(r=>r.AccountType===type&&r.Active!==false);assert.ok(category);const op=purchase('Cash','1150040002','USD');op.payload.Line[0].AccountBasedExpenseLineDetail.AccountRef=ref(category.Id);const result=await h.prepare(op,'au-control-bypass-'+i++);assert.equal(result.status,'refused');assert.match(messages(result),/cannot bypass/);}assert.equal(h.sends(),0);});

test('existing stored undeposited Payment can prepare one Square net-of-fee Deposit',{skip:!stored},async t=>{const h=harness(t),payment=h.records.get('Payment:11089');assert.ok(payment);assert.equal(payment.DepositToAccountRef.value,'5');const fee=[...h.records.values()].find(r=>r.AccountType==='Expense'&&r.Active!==false);const r=await h.prepare({ref:'merchant',op:'create',entity:'Deposit',payload:{TxnDate:DAY,DepositToAccountRef:ref('121'),Line:[{Amount:payment.TotalAmt,LinkedTxn:[{TxnType:'Payment',TxnId:'11089',TxnLineId:'0'}]},{Amount:-3,DetailType:'DepositLineDetail',DepositLineDetail:{AccountRef:ref(fee.Id)}}]}},'au-square-net-fee');assert.equal(r.status,'prepared',messages(r));const p=postingsOf('Deposit',{TotalAmt:166.86,...h.runs.get(r.runId).plan.operations[0].payload},{undepositedFunds:'5'});assert.equal(p.get('121'),16686);assert.equal(p.get('5'),-16986);assert.equal(p.get(fee.Id),300);assert.equal(h.sends(),0);});

test('monthly interest/card payment situations do not create weekly mandates; checklists render in needed text',()=>{const s=snapshot([bank(1,'Savings'),bank(2,'Card','CAD','Credit Card'),row('Account',3,{Name:'Interest income',AccountType:'Other Income',Active:true}),row('Deposit',4,{TxnDate:'2026-10-15',TotalAmt:10,DepositToAccountRef:ref('1'),Line:[{Amount:10,DepositLineDetail:{AccountRef:ref('3')}}]})]);const c=coverage.situations(s,options),w=coverage.weekly(s,options);assert.equal(c.rows.find(r=>r.key==='Account.1.interest').status,'present');assert.equal(w.rows.some(r=>r.key==='Account.2.card-payment'),false);assert.match(c.rows.find(r=>r.key==='Account.1.reconciled').needed,/statement date 2026-11-01 and ending balance 0 CAD/);s.sources.Purchase.status='stale';assert.equal(coverage.situations(s,options).accounts[0].evidence.complete,false);assert.ok(coverage.situations(s,options).accounts[0].evidence.incompleteSources.includes('Purchase'));});

test('native card payment prepares, builds documented wrapper, classifies and recovers with no send',async t=>{
 const h=harness(t),op={ref:'cardpay',entity:'CreditCardPayment',op:'create',payload:{TxnDate:DAY,BankAccountRef:ref('60'),CreditCardAccountRef:ref('85'),Amount:100}};
 const r=await h.prepare(op,'au-native-card-payment');assert.equal(r.status,'prepared',messages(r));assert.equal(h.runs.get(r.runId).plan.exposureCents,10000);
 const scope={environment:'production',realmId:'9130357222392856',connectionId:'6a18e43d0b392890a1303e03'};
 const item={...op,operation:'create',bId:'cardpay'},batch={requestId:'a'.repeat(32),items:[item]};
 const transport=require('../src/modules/general-write-transport'),request=transport.buildGeneralBatch(scope,batch);
 assert.deepEqual(JSON.parse(request.body).BatchItemRequest[0].CreditCardPaymentTxn,op.payload);
 const record={Id:'483',SyncToken:'0',MetaData:{CreateTime:DAY+'T10:00:00Z',LastUpdatedTime:DAY+'T10:00:00Z'},...op.payload};const response={status:200,json:{BatchItemResponse:[{bId:'cardpay',CreditCardPaymentTxn:record}]}};
 assert.equal(transport.classifyGeneralResponse(scope,batch,response).items[0].outcome,'saved');assert.equal(transport.classifyGeneralResponse(scope,batch,response).items[0].mismatch,undefined);const wrong=structuredClone(response);wrong.json.BatchItemResponse[0].CreditCardPaymentTxn.Amount=101;assert.equal(transport.classifyGeneralResponse(scope,batch,wrong).items[0].mismatch,true);
 const recovery=require('../src/modules/general-write-recovery');assert.equal(recovery.itemOutcomes(batch,response.json.BatchItemResponse).items[0].outcome,'saved');assert.equal(recovery.itemOutcomes(batch,null).next.requestId,batch.requestId);
 assert.equal(require('../src/modules/general-write-merge').isComplete('CreditCardPayment',record,op.payload),true);
 const p=postingsOf('CreditCardPayment',record,{});assert.equal(p.get('60'),-10000);assert.equal(p.get('85'),10000);
 const period=require('../src/modules/qbo-write-period');const single=require('../src/modules/qbo-write-contract').freezeWriteRequest(scope,'POST','creditcardpayment',op.payload);
 const proof=await period.readWritePeriodEvidence(single,{query:async()=>({QueryResponse:{Preferences:[{Id:'1',AccountingInfoPrefs:{}}]}})},()=>NOW.getTime());assert.ok(proof);
 for(const mutate of [x=>x.payload.Amount=-1,x=>x.payload.Amount=0,...[null,'60',[],{}, {value:[]}].map(value=>x=>x.payload.BankAccountRef=value),x=>x.payload.BankAccountRef=ref('85'),x=>x.payload.CreditCardAccountRef=ref('60'),x=>x.payload.BankAccountRef=ref('1150040002')]) {const bad=structuredClone(op);mutate(bad);assert.equal((await h.prepare(bad,'au-native-invalid-'+JSON.stringify(bad).length)).status,'refused');}
 assert.equal(h.sends(),0);
});

test('earlier-created wrong payment account cannot bypass native account types',async t=>{const h=harness(t);for(const type of ['Expense','Bank']){const bankCreate={ref:'newaccount',entity:'Account',op:'create',payload:{Name:'Offline wrong '+type,AccountType:type}};const op={ref:'cardpay',entity:'CreditCardPayment',op:'create',payload:{TxnDate:DAY,BankAccountRef:ref('60'),CreditCardAccountRef:{value:{$ref:'newaccount'}},Amount:100}};const result=await h.prepare([bankCreate,op],'au-placeholder-'+type);assert.equal(result.status,'refused');assert.match(messages(result),/Bank source and Credit Card destination/);}assert.equal(h.sends(),0);});
