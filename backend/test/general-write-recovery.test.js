'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,scope}=require('./helpers/business-governance-fixture');
const {hash}=require('../src/modules/business-calendar');
const {recheckSavedOperations,reverifyHistory,compareHistoryBalances,historyMovements}=require('../src/modules/general-write-recovery');
const clock=Date.parse('2026-10-31T19:00:00Z');
function source(period,observedAt=new Date(clock).toISOString()) {const row=fixture().reportSources(period);row.startedAt=observedAt;row.observedAt=observedAt;const {sourceHash,...raw}=row;return {...raw,sourceHash:hash(raw)};}
function ledger(day){return {Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',StartPeriod:day,EndPeriod:day},Columns:{Column:['tx_date','txn_type','debt_amt','credit_amt'].map(ColType=>({ColType}))},Rows:{Row:[]}};}
test('saved checks queue at one-minute intervals; pending and stopped work stays untouched',async()=>{
 const requested=[],runs=[{operationId:'saved',status:'awaiting-evidence',recheckAvailable:true},{operationId:'recent',status:'blocked',recheckAvailable:true,executionRequestedAt:new Date(clock-59999).toISOString()},{operationId:'pending',status:'running',recheckAvailable:true,executionPending:true},{operationId:'stopped',status:'stopped',recheckAvailable:true}];
 assert.equal(await recheckSavedOperations({runs,now:clock,guard:async()=>{},request:async(run,key)=>requested.push([run.operationId,key])}),1);assert.equal(requested[0][0],'saved');assert.match(requested[0][1],/^saved-check-/);
});
test('revoked recovery authority queues nothing',async()=>{await assert.rejects(recheckSavedOperations({runs:[{recheckAvailable:true,status:'blocked'}],now:clock,guard:async()=>{throw Error('revoked');},request:async()=>assert.fail('queued')}),/revoked/);});
function history({baseline=false,failDay,mutate}={}){
 const days=[],saved=[],from='2026-10-29',through='2026-10-30',references=[source({fromDate:from,throughDate:through},'2026-10-30T18:00:00Z')];
 if(baseline)references.push(source({fromDate:'2026-10-01',throughDate:'2026-10-28'},'2026-10-28T18:00:00Z'));
 const input={scope,range:{from,through,baseline},runs:[],references,context:{},now:()=>clock,readReports:async period=>{const row=source(period);if(mutate)mutate(row);return row;},verifyDay:async day=>{days.push(day);return {ok:day!==failDay,failures:[{reason:'wrong posting'}],records:[],ledgerReport:ledger(day)};},save:async row=>saved.push(row)};
 return {input,days,saved};
}
test('fresh history proof covers every closed day through the cursor',async()=>{const h=history();assert.equal((await reverifyHistory(h.input)).ok,true);assert.deepEqual(h.days,['2026-10-29','2026-10-30']);assert.equal(h.saved.length,2);});
test('a pre-opening change checks the opening baseline before every downstream day',async()=>{const h=history({baseline:true});await reverifyHistory(h.input);assert.deepEqual(h.days,['2026-10-28','2026-10-29','2026-10-30']);assert.equal(h.saved[0].baseline,true);});
test('a failed day retains the hold and cannot claim later days complete',async()=>{const h=history({failDay:'2026-10-29'});await assert.rejects(reverifyHistory(h.input),/unverified records/);assert.equal(h.saved.length,0);});
test('wrong-company, stale and forged report evidence is refused',async()=>{for(const mutate of [row=>{row.scope={...scope,realmId:'wrong'};},row=>{row.observedAt='2026-01-01T00:00:00Z';},row=>{row.reports.TrialBalance.Header.Currency='USD';}]){const h=history({mutate});await assert.rejects(reverifyHistory(h.input));assert.equal(h.saved.length,0);}});
test('a missing endpoint observation prevents history clearance',async()=>{const h=history();h.input.references=[];await assert.rejects(reverifyHistory(h.input),/current cursor/);assert.equal(h.saved.length,0);});
test('all-account proof detects balanced account substitutions',()=>{const period={fromDate:'2026-10-29',throughDate:'2026-10-30'},original=source(period),ids=original.accounts.slice(0,2).map(row=>row.Id);const result=compareHistoryBalances(original,source(period),[{date:period.throughDate,accountId:ids[0],cents:1},{date:period.throughDate,accountId:ids[1],cents:-1}]);assert.equal(result.ok,false);assert.equal(result.differences.length,2);});
test('a moved historical transfer reverses its old date and posts its new date',()=>{const before={Id:'8',TxnDate:'2026-10-28',Amount:10,FromAccountRef:{value:'1'},ToAccountRef:{value:'2'}},after={...before,TxnDate:'2026-10-30',Amount:15};const run={updatedAt:'2026-10-31T18:00:00Z',plan:{operations:[{ref:'move',before}]},items:{move:{outcome:'saved',op:'update',entity:'Transfer',before,record:after,request:{Amount:15,TxnDate:after.TxnDate}}}};assert.deepEqual(historyMovements([run],'2026-10-30T18:00:00Z',{}),[{date:'2026-10-28',accountId:'1',cents:1000},{date:'2026-10-28',accountId:'2',cents:-1000},{date:'2026-10-30',accountId:'1',cents:-1500},{date:'2026-10-30',accountId:'2',cents:1500}]);});
