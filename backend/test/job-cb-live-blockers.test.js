'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {fixture,scope}=require('./general-write-unsent-job-u.test');
const {createGeneralWriteService}=require('../src/modules/general-write-service');
const {failureFields}=require('../src/modules/business-error-detail');
const amounts=require('../src/modules/business-agent-reconciliation');
const clock=()=>Date.parse('2026-11-01T12:00:00Z');
const error=()=>Object.assign(Error('Exact refused source reason'),{code:'QBO_WRITE_ADMISSION_DENIED',qboStage:'write_admission',outcomeUnknown:false,businessDetail:{qboStage:'write_admission',outcomeUnknown:false}});
function refused(h,n=3){for(let i=0;i<n;i++)Object.assign(h.run,failureFields(h.run,error(),{},clock()+i));}
test('third identical unsent refusal retires atomically and execute never reaches transport again',async()=>{
 const h=fixture({day:'2026-11-01'}); let attempts=0;
 const api=createGeneralWriteService({models:h.models,copy:{},contextFor:async()=>{throw Error('guard unexpected');},now:clock,dispatchEnabled:()=>true,transport:{sendBatch:async()=>{attempts++;throw error();}}});
 for(let i=0;i<2;i++)await assert.rejects(api.execute({scope},h.run._id),/Exact refused source/);
 const result=await api.execute({scope},h.run._id);
 assert.equal(result.status,'expired-unsent');assert.equal(result.next.action,'replan');assert.match(result.next.reason,/3 identical.*Exact refused source/);
 assert.equal(attempts,3);assert.equal(h.audits.length,1);assert.equal(h.run.batches[0].sends,0);
 await api.execute({scope},h.run._id);assert.equal(attempts,3);assert.equal(h.audits.length,1);
});
for(const barrier of ['receipt','claim','unknown','lost'])test('refusal cap retains '+barrier+' barrier without retirement',async()=>{
 const h=fixture({day:'2026-11-01'});refused(h);
 if(barrier==='receipt')h.receipts.push({...scope,kind:'general-write',general:{runId:h.run._id,batchIndex:0,requestId:h.run.batches[0].requestId}});
 if(barrier==='claim')h.writers[0].resourceClaims=[{runId:h.run._id}];
 if(barrier==='unknown')h.run.status='unknown';
 if(barrier==='lost')h.run.batches[0].state='lost';
 assert.notEqual((await h.retirement.retire(scope,h.run)).status,'expired-unsent');assert.equal(h.audits.length,0);
});
test('changed-balance refusal retires immediately with exact diagnostic, not three attempts',async()=>{
 const h=fixture({day:'2026-11-01'});Object.assign(h.run,failureFields(h.run,Object.assign(error(),{code:'GENERAL_WRITE_REPLAN_REQUIRED'}),{},clock()));
 const result=await h.retirement.retire(scope,h.run);assert.equal(result.status,'expired-unsent');assert.equal(result.retirement.errorDetail.code,'GENERAL_WRITE_REPLAN_REQUIRED');assert.equal(h.audits.length,1);
});
test('mixed saved/unsent refusal retires only the remainder and retains accepted ids/receipts',async()=>{
 const h=fixture({day:'2026-11-01'});h.run.plan.operations.unshift({ref:'accepted',op:'create',entity:'Invoice',payload:{}});
 h.run.items={accepted:{entity:'Invoice',outcome:'saved',qboId:'123'}};h.run.owned=[{key:'Invoice:123',op:'create'}];
 h.run.batches[0].index=1;h.run.batches.unshift({index:0,state:'answered',requestId:'previous',transport:{receiptId:'accepted-receipt'}});
 h.receipts.push({...scope,kind:'general-write',general:{runId:h.run._id,batchIndex:0,requestId:'previous'},_id:'accepted-receipt'});
 const before=structuredClone({items:h.run.items,receipts:h.receipts});refused(h);let sent=0,enabled=true;
 const api=createGeneralWriteService({models:h.models,copy:{},contextFor:async()=>{},now:clock,dispatchEnabled:()=>enabled,transport:{sendBatch:async()=>sent++}});
 const result=await api.execute({scope},h.run._id);assert.equal(result.status,'needs-correction');assert.equal(result.next.action,'replan-remaining');assert.match(result.next.reason,/Saved records.*do not recreate.*deposit/);
 assert.equal(h.run.retirement.noDispatch,undefined);assert.equal(h.run.retirement.batchNoDispatch,true);
 enabled=false;await api.execute({scope},h.run._id);enabled=true;await api.execute({scope},h.run._id);assert.equal(sent,0);assert.equal(h.audits.length,1);assert.deepEqual({items:h.run.items,receipts:h.receipts},before);
});
test('different refusal record details do not share the identical-error cap',async()=>{
 const h=fixture({day:'2026-11-01'});refused(h);Object.assign(h.run,failureFields(h.run,Object.assign(error(),{businessDetail:{recordId:'another'}}),{},clock()));
 assert.equal((await h.retirement.retire(scope,h.run)).status,'prepared');
});
const row=(id,record)=>({qboId:id,record});
const line=(amount,type,id)=>({Amount:amount,LinkedTxn:[{TxnType:type,TxnId:id}]});
function mirror(){return Object.fromEntries(amounts.agingEntities('Invoice').concat(amounts.agingEntities('Bill')).map(e=>[e,[]]));}
function company(){const by=mirror();by.Account=[row('60',{AccountType:'Bank'}),row('63',{AccountType:'Accounts Receivable'}),row('59',{AccountType:'Accounts Payable'})];return by;}
function purchase(id,amount,account){return row(id,{CurrencyRef:{value:'CAD'},AccountRef:{value:'60'},Line:[{Amount:amount,DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:{value:account}}}]});}
function deposit(id,amount){return row(id,{CurrencyRef:{value:'CAD'},DepositToAccountRef:{value:'60'},Line:[{Amount:amount,DepositLineDetail:{AccountRef:{value:'59'}}}]});}
test('stored AR case: Purchases354/385 less Payments383/455/543 exactly explain CAD904.57 gap',()=>{
 const by=company();by.Invoice=[row('subtotal',{Balance:93523.24})];by.CreditMemo=[row('subtotal',{RemainingCredit:9000})];by.Payment=[row('subtotal',{UnappliedAmt:4164.95}),...[[383,500],[455,75.65],[543,19.78]].map(([id,a])=>row(String(id),{UnappliedAmt:0,Line:[line(a,'Expense','385')]}))];
 by.JournalEntry=[row('517',{Line:[{Amount:100,DetailType:'JournalEntryLineDetail',JournalEntryLineDetail:{PostingType:'Debit',AccountRef:{value:'63'},Entity:{Type:'Customer',EntityRef:{value:'19'}}}}]})];by.Purchase=[purchase('354',500,'63'),purchase('385',1000,'63')];
 const proof=amounts.agingMirrorTotal('Invoice',by,'CAD');assert.equal(proof.components.purchases.cents,90457);assert.equal(proof.mirrorCents,8136286);assert.deepEqual(proof.limitations,[]);
 by.Payment.push(row('duplicate',{UnappliedAmt:0,Line:[line(500,'Expense','385')]}));assert.equal(amounts.agingMirrorTotal('Invoice',by,'CAD').mirrorCents,null);
});
test('stored AP case: direct applications cancel, open deposits344 less foreign unapplied264.35 explain79.65',()=>{
 const by=company();by.Bill=[row('subtotal',{Balance:11339.15})];by.VendorCredit=[row('subtotal',{Balance:320.34})];by.Deposit=[deposit('381',1250),deposit('446',300),deposit('452',44)];by.Purchase=[purchase('379',1000,'59'),purchase('380',250,'59')];
 by.BillPayment=[row('445',{TotalAmt:627.15,Line:[line(627.15,'Bill','423'),line(1250,'Deposit','381'),line(1000,'Purchase','379'),line(250,'Purchase','380')]}),row('561',{TotalAmt:1100,CurrencyRef:{value:'USD'},ExchangeRate:1.3552454,Line:[line(904.94,'Bill','546')]})];
 const proof=amounts.agingMirrorTotal('Bill',by,'CAD');assert.equal(proof.mirrorCents,1109846);assert.equal(proof.components.unappliedBillPayments.cents,-26435);assert.equal(proof.components.deposits.cents,34400);assert.equal(proof.components.purchases.cents,0);
});
test('live dependencies/projection retain linked Payment, item accounts, Credit, and foreign rate evidence',async()=>{
 assert.ok(amounts.agingEntities('Bill').includes('Payment'));let selected;
 const Records={find:()=>({select(s){selected=s;return this;},maxTimeMS(){return this;},lean:async()=>[]})};await amounts.readAmountMirror(Records,scope,'Purchase');
 for(const field of ['record.Credit','record.ExchangeRate','record.Line','record.ExpenseAccountRef','record.AssetAccountRef','record.IncomeAccountRef'])assert.ok(selected.split(' ').includes(field));
 const by=company();by.Purchase=[purchase('credit',10,'63')];by.Purchase[0].record.Credit=true;assert.equal(amounts.agingMirrorTotal('Invoice',by,'CAD').mirrorCents,null);
});
