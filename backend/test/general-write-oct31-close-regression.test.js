'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseLedger, closeGeneralDay } = require('../src/modules/general-write-day-close');
const { createGeneralCloseGate } = require('../src/modules/general-write-close-gate');
const { businessErrorDetail, businessBlockersFor } = require('../src/modules/business-error-detail');
const cadence = require('../src/modules/business-agent-cadence');
const day = '2026-10-31', scope = {environment:'production',realmId:'123',connectionId:'a'.repeat(24)};
const chain = rows => ({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(rows)});
const data = (date,type,id,debit='',credit='') => ({type:'Data',ColData:[{value:date},{value:type,...(id?{id}:{})},{},{},{},{},{value:debit},{value:credit}]});
const section = (id,rows) => ({type:'Section',Header:{ColData:[{value:id?'Account':'Not Specified',...(id?{id}:{})}]},Rows:{Row:rows}});
const report = rows => ({Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',Currency:'CAD',StartPeriod:day,EndPeriod:day},Columns:{Column:['tx_date','txn_type','doc_num','name','memo','split_acc','debt_amt','credit_amt'].map(ColType=>({ColType}))},Rows:{Row:rows}});

test('October 31 report shape: opening balances and an accountless zero-cash application are not movements',()=>{
 const actual=parseLedger(report([section('68',[data('Beginning Balance','','')]),section(null,[data(day,'Payment','11132')]),section('63',[data(day,'Invoice','700','100.00')])]),day);
 assert.deepEqual(actual,{byRecord:{'Invoice:700':[{accountId:'63',cents:10000}]},unknown:[]});
});
test('opening-balance wording cannot hide a transaction, a movement, or an out-of-period date',()=>{
 for(const row of [data('Beginning Balance','Payment','11132'),data('Beginning Balance','','','1.00'),data('2026-10-30','Invoice','700','1.00')])assert.throws(()=>parseLedger(report([section('63',[row])]),day),{code:'GENERAL_DAY_CLOSE_UNVERIFIED'});
 for(const row of [data(day,'Payment','11132','1.00'),data(day,'Payment','11132','1.00','1.00')])assert.throws(()=>parseLedger(report([section(null,[row])]),day),/no account section/);
});
test('the full day close still compares each record own lines against all its GL accounts',async()=>{
 const current={Id:'11132',SyncToken:'0',TxnDate:day,TotalAmt:0},hash=require('../src/modules/business-calendar').hash;
 const gathered={records:[{entity:'Payment',id:'11132',current,evidence:{accountant:{record:current,versionHash:hash(current),request:{}}}}],dirty:[]};
 const args={scope,day,ctx:{accountKey:id=>id},gathered};
 assert.equal((await closeGeneralDay({...args,ledgerReport:report([section(null,[data(day,'Payment','11132')])])})).ok,true);
 const wrong=await closeGeneralDay({...args,ledgerReport:report([section('63',[data(day,'Payment','11132','','1.00')])])});
 assert.equal(wrong.ok,false);assert.equal(wrong.failures[0].key,'Payment:11132');assert.deepEqual(wrong.failures[0].differences,[{accountId:'63',expectedCents:0,actualCents:-100}]);
});
test('pre-operation close failures retain their precise record, date difference and source in blockers; a passing retry clears them',async()=>{
 const closes=[],saved={Id:'11132',SyncToken:'0',TxnDate:day,TotalAmt:0},runs=[{_id:'run',day,status:'complete',plan:{operations:[{ref:'payment',entity:'Payment',op:'create',payload:{}}]},items:{payment:{entity:'Payment',op:'create',outcome:'saved',qboId:'11132',record:saved}}}];
 const models={GeneralWriteRuns:{find:()=>chain(runs)},GeneralDayCloses:{findOne:()=>chain(null),create:async rows=>closes.push(...rows),find:filter=>{assert.equal(filter.realmId,scope.realmId);return chain([...closes].reverse());}},Records:{find:()=>chain([])}};
 let clock=Date.parse('2026-11-01T03:41Z');const gate=createGeneralCloseGate({models,copy:{read:async()=>saved},now:()=>clock});
 const args={fromDate:day,throughDate:day,verifiedThrough:'2026-10-30',mappings:{},readLedger:async()=>report([section('63',[data('2026-10-30','Payment','11132')])])};
 await assert.rejects(gate.assertPeriodReady(scope,args),error=>{const d=businessErrorDetail(error);assert.equal(d.code,'GENERAL_DAY_CLOSE_UNVERIFIED');assert.match(d.message,/dated outside/);assert.equal(d.recordId,'11132');assert.equal(d.entity,'Payment');assert.match(d.check.file,/general-write-day-close.js$/);assert.ok(d.check.line);assert.equal(d.detail.differences[0].field,'tx_date');return true;});
 let feed=await businessBlockersFor({models,scope,now:clock});assert.equal(feed.blockers.length,1);assert.equal(feed.blockers[0].errorDetail.recordId,'11132');
 clock+=60000;await gate.assertPeriodReady(scope,{...args,readLedger:async()=>report([section(null,[data(day,'Payment','11132')])])});
 feed=await businessBlockersFor({models,scope,now:clock});assert.equal(feed.blockers.length,0);
});
test('October 31 failed close leaves November 1 sales, collections and bills actionable on their own cadence',()=>{
 const now=Date.parse('2026-11-01T04:22Z'),agent={id:'accountant',grant:{id:'grant',authorityHash:'authority'}},state={day:'2026-11-01',lastKind:'catch-up',misses:3,lastReviewAt:'2026-11-01T04:21:00Z'};
 const today=cadence.summarizeToday({rhythm:cadence.dayRhythm('2026-11-01'),runs:[],receipts:[],now});
 const business={published:true,verifiedThrough:'2026-10-30',openingDate:'2023-09-01',blockers:[]};
 const sales=cadence.decide({now,business,agent,state,today});assert.equal(sales.kind,'slice');assert.equal(sales.callModel,true);assert.ok(today.dueSlot.records>=5);
 const duties=cadence.decide({now,business,agent,state,today:{...today,dueSlot:null},obligations:{count:2}});assert.equal(duties.kind,'obligations');assert.equal(duties.callModel,true);
 const close={operationId:'close',status:'blocked',throughDate:day,agentAuthority:{agentId:agent.id,grantId:agent.grant.id,authorityHash:agent.grant.authorityHash}};
 assert.equal(cadence.decide({now,business:{...business,currentOperation:close,blockers:[{code:'current-operation'}]},agent,state,today}).kind,'slice');
});

test('repeated pre-operation failures retain their first failure time and count until a passing close',async()=>{
 const d=businessErrorDetail(Object.assign(new Error('A General Ledger row is dated outside 2026-10-31.'),{code:'GENERAL_DAY_CLOSE_UNVERIFIED',businessDetail:{entity:'Payment',recordId:'11132'}}));
 const at=Date.parse('2026-11-01T04:00Z');
 const attempts=[0,5,10,20].map((minutes,i)=>({_id:'attempt'+i,fromDate:day,throughDate:day,ok:false,errorDetail:d,verifiedAt:new Date(at-minutes*60000)}));
 const models={GeneralDayCloses:{find:()=>chain(attempts)}};
 const b=(await businessBlockersFor({models,scope,now:at})).blockers[0];
 assert.equal(b.count,4);assert.equal(b.firstAt,'2026-11-01T03:40:00.000Z');assert.equal(b.overdue,true);
 attempts.splice(2,0,{_id:'passed',fromDate:day,throughDate:day,ok:true,verifiedAt:new Date(at-7*60000)});
 const recent=(await businessBlockersFor({models,scope,now:at})).blockers[0];assert.equal(recent.count,2);assert.equal(recent.overdue,false);
});
test('diagnostic persistence failure does not replace the original verification error',async()=>{
 const saved={Id:'11132',SyncToken:'0',TxnDate:day,TotalAmt:0};
 const models={GeneralWriteRuns:{find:()=>chain([{_id:'run',day,status:'complete',plan:{operations:[{ref:'p',entity:'Payment',op:'create'}]},items:{p:{entity:'Payment',op:'create',outcome:'saved',qboId:'11132',record:saved}}}])},GeneralDayCloses:{findOne:()=>chain(null),create:async()=>{throw new Error('store unavailable');}},Records:{find:()=>chain([])}};
 const gate=createGeneralCloseGate({models,copy:{read:async()=>saved}});
 await assert.rejects(gate.assertPeriodReady(scope,{fromDate:day,throughDate:day,mappings:{},readLedger:async()=>report([section('63',[data('2026-10-30','Payment','11132')])])}),e=>{assert.equal(e.code,'GENERAL_DAY_CLOSE_UNVERIFIED');assert.match(e.message,/dated outside/);assert.equal(e.errorDetail.detail.diagnosticPersistence,'unavailable');assert.equal(e.errorDetail.recordId,'11132');return true;});
});

test('cached passing accounting proof records recovery after a more recent failed attempt',async()=>{
 const closes=[],saved={Id:'11132',SyncToken:'0',TxnDate:day,TotalAmt:0};let clock=Date.parse('2026-11-01T03:41Z'),reads=0;
 const models={GeneralWriteRuns:{find:()=>chain([{_id:'run',day,status:'complete',plan:{operations:[{ref:'p',entity:'Payment',op:'create'}]},items:{p:{entity:'Payment',op:'create',outcome:'saved',qboId:'11132',record:saved}}}])},GeneralDayCloses:{findOne:filter=>chain(closes.find(c=>c.ok&&c.snapshotHash===filter.snapshotHash)||null),create:async rows=>closes.push(...rows),find:()=>chain([...closes].reverse())},Records:{find:()=>chain([])}};
 const gate=createGeneralCloseGate({models,copy:{read:async()=>saved},now:()=>clock});
 const args={fromDate:day,throughDate:day,mappings:{},readLedger:async()=>{reads++;return report([section(null,[data(day,'Payment','11132')])]);}};
 await gate.assertPeriodReady(scope,args);clock+=60000;
 closes.push({_id:'failure',fromDate:day,throughDate:day,ok:false,errorDetail:businessErrorDetail({code:'GENERAL_DAY_CLOSE_UNVERIFIED',message:'Temporary close failure.'}),verifiedAt:new Date(clock)});
 assert.equal((await businessBlockersFor({models,scope,now:clock})).blockers.length,1);
 clock+=60000;await gate.assertPeriodReady(scope,args);
 assert.equal(reads,1);assert.equal(closes.at(-1).ok,true);assert.equal((await businessBlockersFor({models,scope,now:clock})).blockers.length,0);
});

test('V2 stored October 31 GL Payment11132 uses .00, and fractional cents remain exact',()=>{
 const parsed=parseLedger(report([section(null,[data(day,'Payment','11132','.00','.00')]),section('63',[data(day,'Invoice','700','.35')]),section('68',[data(day,'Invoice','700','','.35')])]),day);
 assert.deepEqual(parsed.byRecord['Invoice:700'],[{accountId:'63',cents:35},{accountId:'68',cents:-35}]);
 for(const amount of ['.001','1e2','1,000.00','1.2.3','.',null,' 0.00','0.00 '])assert.throws(()=>parseLedger(report([section('63',[data(day,'Invoice','700',amount)])]),day),/not exact money/);
});
