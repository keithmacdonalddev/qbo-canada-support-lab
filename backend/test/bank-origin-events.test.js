'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const moduleRoot = process.env.BF3_MODULE_ROOT || path.join(__dirname,'../src/modules');
const C = require('../src/modules/bank-settlement-contract');
const {buildSettlementEvents} = require('../src/modules/bank-settlement-engine');
const {buildBankOriginEvents,validateOriginEvent} = require(path.join(moduleRoot,'bank-origin-events'));
const {prepareBankOriginResolution,markerFor,keyFor} = require(path.join(moduleRoot,'bank-origin-resolution'));
const {checkGeneralWrite,grossCents} = require('../src/modules/general-write-guards');
const {postingsOf} = require('../src/modules/general-write-postings');
const history = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/bank-settlement-history.json'),'utf8'));
const base = buildSettlementEvents(history), scope=history.scope, accounts=history.accounts;
const clone = x=>JSON.parse(JSON.stringify(x));
const day='2026-11-02', now=day+'T12:00:00Z';
function scenario(overrides={}) {return {scenarioId:'monthly-fee',kind:'bank-fee',accountId:'123',currency:'CAD',bookDate:day,postingDate:day,amountMinor:2500,creator:'api-accountant',counterpartAccountId:'19',taxTreatment:'out-of-scope',advice:{basis:'simulated',reference:'fee-advice-2026-11'},window:{start:day,end:day,unreconciled:true,evidenceRef:'scenario-window-advice'},...overrides};}
function build(scenarios,extra={}) {return buildBankOriginEvents({scope,accounts,scenarios,settlementDataset:base,...extra});}
const one = s=>build([s]).events[0];
function snapshot(extra={}) {return {scope,observedAt:now,complete:true,records:clone(history.mirror),settlementEvents:clone(base.events),...extra};}
function claims(events) {return events.map(e=>({scope,eventId:e.eventId,accountId:e.accountId,period:e.statementPeriod,creator:e.resolution.designatedCreator==='existing-qbo'?'none':e.resolution.designatedCreator}));}
const accountRecords = accounts.map(a=>({Id:a.id,AccountType:a.type,AccountSubType:a.subtype,CurrencyRef:{value:a.currency},Active:a.Active!==false}));
// Actual production guards + posting calculator, with only an in-memory local copy.
function guardDraft(proposal, extraRecords=[]) {
 const map = new Map([...history.mirror.map(m=>[m.entity+':'+m.qboId,m.record]),...accountRecords.map(a=>['Account:'+a.Id,a]),...extraRecords.map(m=>[m.entity+':'+m.qboId,m.record])]);
 const local={get:(entity,id)=>map.get(entity+':'+id),owned:()=>false};
 const checked=checkGeneralWrite({proposal,local,context:{day,currency:{enabled:true,homeCurrency:'CAD',currencies:['CAD','USD','CNY']}}});
 let bankAmountMinor=null;
 if(checked.ok){const op=proposal.operations[0];const rows=postingsOf(op.entity,op.payload,{get:local.get,receivables:'63',payables:'59',undepositedFunds:'5',taxAccount:()=> '58'}); const bank=op.entity==='Transfer'?op.payload.FromAccountRef.value:op.entity==='Purchase'?op.payload.AccountRef.value:op.payload.Line.map(l=>l.JournalEntryLineDetail?.AccountRef.value).find(id=>['Bank','Credit Card'].includes(local.get('Account',id)?.AccountType)); bankAmountMinor=op.entity==='Purchase'?-grossCents('Purchase',op.payload,{}, {local}):rows.get(bank);}
 return {...checked,bankAmountMinor};
}
function resolve(event,extra={}) {return prepareBankOriginResolution({event,accounts,reservations:claims([event]),mirrorSnapshot:snapshot(),asOf:now,checkDraft:guardDraft,...extra});}
test('real stored history replays all 3789 rows and 1385 receipt links without changing baseline',()=>{
 assert.equal(base.ledgerCrosswalk.length,3789);assert.equal(base.depositLinks.length,1385);
 assert.equal(base.events.find(e=>e.source.entity==='Invoice'&&e.source.id==='486').amountMinor,5000);
 assert.equal(base.events.find(e=>e.source.entity==='Payment'&&e.source.id==='26').amountMinor,342349);
 assert.equal(base.nonSettlements.find(e=>e.entity==='JournalEntry'&&e.id==='200').nativeAmountMinor,0);
 for(const id of ['343','345','483'])assert.equal(base.events.filter(e=>e.source.id===id&&['Transfer','CreditCardPayment'].includes(e.source.entity)).length,2);
 assert.deepEqual(build([]).events,[]);
});
test('stored net Deposit208/Payment206 suppress an already recorded CAD10 processor fee',()=>{
 const net=base.events.find(e=>e.source.entity==='Deposit'&&e.source.id==='208');
 assert.equal(net.amountMinor,10300);assert.equal(net.source.depositLinks[0].receiptId,'206');
 assert.equal(net.source.depositBreakdown.find(l=>l.amountMinor>0).amountMinor,11300);
 const r=build([scenario({kind:'merchant-fee',accountId:'60',amountMinor:1000,includedInSettlement:true,settlementEventId:net.eventId})]);
 assert.equal(r.events.length,0);assert.equal(r.nonEvents[0].code,'fee-already-in-net-deposit');
});
test('unproved net fee stays unresolved and cannot be turned into another withdrawal',()=>{
 const gross=base.events.find(e=>e.source.entity==='Deposit'&&e.source.id!=='208'&&e.status==='resolved');
 const e=one(scenario({kind:'merchant-fee',accountId:gross.accountId,includedInSettlement:true,settlementEventId:gross.eventId}));
 assert.equal(e.resolution.reason.code,'net-deposit-fee-unproved');assert.equal(resolve(e).draft,null);
 const forged=clone(e);forged.status='resolved';forged.resolution.action='Match';assert.throws(()=>resolve(forged),/resolution changed/);
});
test('all explicit fee/interest kinds use exact account-native signs including card debt',()=>{
 for(const kind of ['bank-fee','interest-expense','merchant-fee','card-fee','interest-income']){
 const e=one(scenario({kind,accountId:kind==='card-fee'?'85':'123'}));
 C.validateEvent(e);validateOriginEvent(e);assert.equal(e.amountMinor,kind==='interest-income'?2500:-2500);
 assert.equal(e.cardDebtChangeMinor,kind==='card-fee'?2500:null);
 }
 for(const id of ['1150040002','1150040008']){const a=accounts.find(a=>a.id===id);const e=one(scenario({accountId:id,currency:a.currency}));assert.equal(e.accountCurrency,a.currency);assert.equal(e.amountMinor,-2500);}
});
test('fee and interest drafts pass actual general-write guards and production posting path',()=>{
 for(const kind of ['bank-fee','interest-expense','merchant-fee','interest-income','card-fee']){
 const e=one(scenario({kind,accountId:kind==='card-fee'?'85':'123',counterpartAccountId:kind==='interest-income'?'45':'19'})), r=resolve(e);
 assert.equal(r.status,'accounting-draft',JSON.stringify(r.blockers));assert.equal(r.draft.operations[0].entity,'JournalEntry');
 assert.equal(r.nativeTask.action,'Match-after-sync');assert.equal(r.requiresGovernedExecution,true);
 }
});
test('creator reservation and fresh complete scoped copy are mandatory',()=>{
 const e=one(scenario());
 assert.equal(resolve(e,{reservations:[]}).blockers[0].code,'creator-reservation-required');
 assert.equal(resolve(e,{reservations:[{...claims([e])[0],creator:'native-add'}]}).blockers[0].code,'creator-reservation-conflict');
 for(const patch of [{complete:false},{observedAt:'2026-11-01T00:00:00Z'},{observedAt:'2026-11-03T00:00:00Z'}])assert.equal(resolve(e,{mirrorSnapshot:snapshot(patch)}).blockers[0].code,'complete-current-mirror-required');
 assert.throws(()=>resolve(e,{mirrorSnapshot:snapshot({scope:{...scope,realmId:'other'}})}),/different company/);
 const s=snapshot();s.records[0].scope={...scope,realmId:'other'};assert.throws(()=>resolve(e,{mirrorSnapshot:s}),/different company/);
});
test('native Add is a browser task with exact creator/category/tax instructions, never an API draft',()=>{
 const e=one(scenario({creator:'native-add',taxTreatment:'taxable',taxCodeId:'16',netAmountMinor:2212})); const r=resolve(e);
 assert.equal(r.status,'native-task');assert.equal(r.draft,null);assert.equal(r.nativeTask.operator,'owner-browser-automation');
 assert.equal(r.nativeTask.taxCodeId,'16');assert.equal(r.nativeTask.netAmountMinor,2212);assert.equal(r.nativeTask.taxTreatment,'taxable');assert.equal(r.nativeTask.verified,false);
 for(const taxTreatment of ['', 'whatever'])assert.equal(resolve(one(scenario({creator:'native-add',taxTreatment}))).status,'blocked');
});
test('unknown items never fall through to expense or Add, including tampered resolution',()=>{
 const e=one(scenario({kind:'unknown',amountMinor:-75,creator:'native-add'}));assert.equal(e.status,'unresolved');assert.equal(resolve(e).draft,null);
 const forged=clone(e);forged.status='resolved';forged.resolution.action='Add';assert.throws(()=>resolve(forged),/resolution changed/);
});
test('same advice keeps stable identity across labels and revisions; duplicate advice is rejected',()=>{
 const s=scenario(), e=one(s), renamed=one({...s,scenarioId:'renamed'});assert.equal(e.eventId,renamed.eventId);assert.equal(keyFor(e),keyFor(renamed));
 assert.throws(()=>build([s,{...s,scenarioId:'alias'}]),/only once/);
 const changed=build([{...s,amountMinor:2600}],{priorEvents:[e]}).events[0];assert.equal(changed.eventId,e.eventId);assert.equal(changed.revision,2);
 assert.throws(()=>build([{...s,creator:'native-add'}],{priorEvents:[e]}),/creator cannot be switched/);
});
test('saved/uncertain decisions, marker hits and unmarked same-money records prevent new accounting',()=>{
 const e=one(scenario());
 assert.equal(resolve(e,{decisions:[{scope,decisionKey:keyFor(e),state:'unknown'}]}).blockers[0].code,'decision-already-reserved-or-sent');
 const s=snapshot();s.records.push({scope,entity:'JournalEntry',qboId:'999999',record:{Id:'999999',PrivateNote:markerFor(e)}});
 assert.equal(resolve(e,{mirrorSnapshot:s}).blockers[0].code,'bookkeeping-already-present');
 const m=clone(base.events.find(e=>e.status==='resolved'&&e.accountId==='123'));m.bookDate=day;m.amountMinor=-2500;m.bookAmountMinor=-2500;
 assert.equal(resolve(e,{mirrorSnapshot:snapshot({settlementEvents:[m]})}).blockers[0].code,'possible-existing-bookkeeping');
});
test('bank-initiated transfer uses two reservations and exactly one identical governed draft from either leg',()=>{
 const legs=build([scenario({kind:'bank-transfer',toAccountId:'85',amountMinor:10000})]).events;
 assert.equal(legs.length,2);assert.equal(C.sum(legs.map(e=>e.amountMinor)),0);assert.equal(legs[1].cardDebtChangeMinor,-10000);
 const a=resolve(legs[0],{reservations:claims(legs)}),b=resolve(legs[1],{reservations:claims(legs)});
 assert.equal(a.status,'accounting-draft',JSON.stringify(a.blockers));assert.equal(b.status,'accounting-draft',JSON.stringify(b.blockers));assert.deepEqual(a.draft,b.draft);
 assert.equal(resolve(legs[0]).blockers[0].code,'creator-reservation-required');
 const native=build([scenario({kind:'bank-transfer',toAccountId:'85',creator:'native-add'})]).events;
 const r=resolve(native[0],{reservations:claims(native)});assert.equal(r.nativeTask.action,'Transfer');assert.equal(r.nativeTask.oneAccountingRecordForBothLegs,true);
});
test('FX pairs retain each native currency and remain investigatory through validation',()=>{
 const legs=build([scenario({kind:'bank-transfer',toAccountId:'1150040002',toAmountMinor:1800})]).events;
 for(const e of legs){validateOriginEvent(e);assert.equal(e.status,'unresolved');assert.equal(resolve(e).blockers[0].code,'fx-transfer-requires-governed-currency-proof');}
 assert.equal(legs[1].accountCurrency,'USD');assert.equal(legs[1].amountMinor,1800);
});
test('duplicate-test rows are separate, Exclude-only and compatible with BF4 creator none',()=>{
 const original=base.events.find(e=>e.status==='resolved'&&e.source.nativeStatus!=='R'&&e.accountId==='123');
 const posting=original.actualPostingDate||original.expectedPostingDate;
 const r=build([scenario({kind:'duplicate-test',creator:'existing-qbo',originalEventId:original.eventId,bookDate:original.bookDate,postingDate:posting,window:{start:original.bookDate,end:posting,unreconciled:true,evidenceRef:'duplicate-test-window'}})]);
 assert.equal(r.events.length,0);assert.equal(r.duplicateTests.length,1);
 const task=resolve(r.duplicateTests[0]);assert.equal(task.status,'native-task');assert.equal(task.nativeTask.action,'Exclude');assert.equal(task.nativeTask.createsBookkeeping,false);
});
test('NSF stored settled Payment26 cannot be guessed into an FX receivable correction',()=>{
 const original=base.events.find(e=>e.source.entity==='Payment'&&e.source.id==='26');
 const e=one(scenario({kind:'nsf-return',accountId:'60',amountMinor:342349,originalEventId:original.eventId,receivablesAccountId:'63'}));
 const r=resolve(e);assert.equal(r.status,'blocked');assert.equal(r.blockers[0].code,'nsf-receivable-allocation-unproved');
 const alias=one(scenario({scenarioId:'other-nsf',kind:'nsf-return',advice:{basis:'simulated',reference:'other-nsf-advice'},accountId:'60',amountMinor:342349,originalEventId:original.eventId}));
 assert.equal(e.eventId,alias.eventId);assert.equal(keyFor(e),keyFor(alias));
 assert.throws(()=>build([e.source.advice,{...e.source.advice,scenarioId:'another-return'}]),/only once/);
});
test('NSF exact same-currency principal drafts debit receivables and credit bank, never fee expense',()=>{
 const original=clone(base.events.find(e=>e.source.entity==='Payment'&&e.source.id==='26'));original.eventId='test-direct-payment';original.accountId='123';original.amountMinor=5000;original.bookAmountMinor=5000;original.source.id='999998';original.source.transactionCurrency='CAD';
 const data={...base,events:[original]};const e=build([scenario({kind:'nsf-return',amountMinor:5000,originalEventId:original.eventId,receivablesAccountId:'63'})],{settlementDataset:data}).events[0];
 const p={Id:'999998',DepositToAccountRef:{value:'123'},CurrencyRef:{value:'CAD'},CustomerRef:{value:'999997'},ARAccountRef:{value:'63'},TotalAmt:50};
 const s=snapshot({records:[{scope,entity:'Payment',qboId:p.Id,record:p},{scope,entity:'Customer',qboId:'999997',record:{Id:'999997',CurrencyRef:{value:'CAD'}}}],settlementEvents:[original]});
 const r=resolve(e,{mirrorSnapshot:s,checkDraft:d=>guardDraft(d,s.records)});assert.equal(r.status,'accounting-draft');
 const lines=r.draft.operations[0].payload.Line;assert.equal(lines[0].JournalEntryLineDetail.AccountRef.value,'63');assert.equal(lines[0].JournalEntryLineDetail.PostingType,'Debit');assert.equal(lines[1].JournalEntryLineDetail.AccountRef.value,'123');
 assert.equal(resolve({...e,resolution:{...e.resolution}}, {mirrorSnapshot:s,checkDraft:undefined}).blockers[0].code,'governed-draft-check-required');
});
test('malformed money, currency, history windows, cash and tampering are refused',()=>{
 for(const patch of [{amountMinor:0},{amountMinor:1.5},{currency:'USD'},{accountId:'120'},{window:{start:day,end:day,unreconciled:false,evidenceRef:'no'}},{postingDate:'2026-10-30'}])assert.throws(()=>one(scenario(patch)));
 const e=one(scenario());e.amountMinor=-1;assert.throws(()=>resolve(e));
 const f=one(scenario());f.source.advice.amountMinor=1;assert.throws(()=>resolve(f),/advice changed/);
});
test('draft checks must verify exact bank money as well as guard acceptance',()=>{
 const e=one(scenario());assert.equal(resolve(e,{checkDraft:()=>({ok:true,bankAmountMinor:-2499})}).status,'blocked');
 assert.equal(resolve(e,{checkDraft:()=>({ok:false,problems:['closed day']})}).blockers[0].code,'governed-draft-refused');
});

test('taxable fees use current stored tax rates through the actual guard; gross must equal advice',()=>{
 const f=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/foreign-currency-native.json'),'utf8'));
 const tax=f.records.filter(m=>['TaxCode','TaxRate'].includes(m.entity));
 const e=one(scenario({amountMinor:11400,taxTreatment:'taxable',taxCodeId:'16',netAmountMinor:10000}));
 const r=resolve(e,{checkDraft:d=>guardDraft(d,tax)});assert.equal(r.status,'accounting-draft',JSON.stringify(r.blockers));assert.equal(r.draft.operations[0].entity,'Purchase');
 const wrong=one(scenario({amountMinor:11300,taxTreatment:'taxable',taxCodeId:'16',netAmountMinor:10000}));assert.equal(resolve(wrong,{checkDraft:d=>guardDraft(d,tax)}).status,'blocked');
});
