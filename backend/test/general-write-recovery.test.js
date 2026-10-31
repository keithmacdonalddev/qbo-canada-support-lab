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

const {createGeneralCloseGate}=require('../src/modules/general-write-close-gate');
const chain=value=>({select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>structuredClone(value)});
function dirtyGate({failFixed=false}={}){
 const before={Id:'77',SyncToken:'0',TxnDate:'2026-10-29',Description:'old'},current={...before,SyncToken:'1',Description:'corrected'};
 const run={_id:'f'.repeat(24),revision:1,day:'2026-10-31',status:'complete',updatedAt:'2026-10-31T18:00:00Z',dirty:[{date:'2026-10-29'},{date:'2026-11-01'}],plan:{operations:[{ref:'fix',before,op:'update',entity:'TimeActivity',id:'77',payload:{Description:'corrected'}}]},items:{fix:{outcome:'saved',op:'update',entity:'TimeActivity',qboId:'77',before,record:current,request:{Description:'corrected'}}},batches:[]},closes=[];
 const models={GeneralWriteRuns:{find:()=>chain([run]),findOneAndUpdate:async(filter,update)=>{assert.deepEqual(filter.dirty,run.dirty);run.dirty=update.$set.dirty;run.revision++;return chain(run);}},GeneralDayCloses:{findOne:()=>chain(null),create:async rows=>{closes.push(...structuredClone(rows));}},Records:{find:()=>chain([])}};
 // Query method returns a chain synchronously, as Mongoose does.
 models.GeneralWriteRuns.findOneAndUpdate=(filter,update)=>{assert.deepEqual(filter.dirty,run.dirty);run.dirty=update.$set.dirty;run.revision++;return chain(run);};
 const gate=createGeneralCloseGate({models,copy:{read:async()=>structuredClone(current)},now:()=>clock});
 const options={verifiedThrough:'2026-10-30',openingDate:'2026-10-01',mappings:{},references:[source({fromDate:'2026-10-29',throughDate:'2026-10-30'},'2026-10-30T18:00:00Z')],readReports:async period=>source(period),readLedger:async(from,through)=>ledger(through),verifyFixedDay:async()=>{if(failFixed)throw Error('fixed record changed');return [];},guard:async()=>{},transaction:async work=>work({fixture:true})};
 return {run,closes,gate,options};
}
test('dirty history clears transactionally only after every daily proof, retaining uncovered markers',async()=>{const h=dirtyGate();await h.gate.reverifyDirty(scope,h.options);assert.deepEqual(h.run.dirty,[{date:'2026-11-01'}]);assert.equal(h.closes.filter(row=>row.history?.day).length,2);assert.equal(h.closes.at(-1).history.days.length,2);});
test('a changed fixed record keeps every history marker and prevents false clearance',async()=>{const h=dirtyGate({failFixed:true});await assert.rejects(h.gate.reverifyDirty(scope,h.options),/fixed record changed/);assert.equal(h.run.dirty.length,2);assert.equal(h.closes.length,0);});

test('failed general closes retry a fresh ledger, then stop retrying after a newer pass',async()=>{
 let tick=clock,reads=0;const closes=[],record={Id:'8',SyncToken:'0',TxnDate:'2026-10-29',Amount:10,FromAccountRef:{value:'1'},ToAccountRef:{value:'2'}};
 const run={_id:'retry',day:record.TxnDate,dirty:[],batches:[],items:{transfer:{outcome:'saved',op:'create',entity:'Transfer',qboId:'8',record,request:{Amount:10}}},plan:{operations:[{ref:'transfer',op:'create',entity:'Transfer'}]}};
 const models={GeneralWriteRuns:{find:()=>chain([run])},Records:{find:()=>chain([])},GeneralDayCloses:{find:()=>chain([...closes].reverse()),findOne:filter=>chain(closes.find(row=>row.ok===filter.ok&&row.snapshotHash===filter.snapshotHash)||null),create:async rows=>closes.push(...rows)}};
 const gate=createGeneralCloseGate({models,copy:{read:async()=>record},now:()=>++tick});
 const readLedger=async day=>{reads++;const report=ledger(day);report.Rows.Row=['1','2'].map(id=>({type:'Section',Header:{ColData:[{id,value:id}]},Rows:{Row:[{type:'Data',ColData:[{value:day},{id:'8',value:'Transfer'},{value:id==='2'?'10.00':''},{value:id==='1'?'10.00':''}]}]}}));return report;};
 const options={fromDate:record.TxnDate,throughDate:record.TxnDate,verifiedThrough:'2026-10-28',mappings:{},readLedger};
 await gate.assertPeriodReady(scope,options);closes.push({...closes[0],_id:'failed',ok:false,verifiedAt:new Date(++tick)});
 assert.equal((await gate.retryFailed(scope,options))[0].ok,true);assert.equal(reads,2,'retry cannot use the older passing close');assert.deepEqual(await gate.retryFailed(scope,options),[]);assert.equal(reads,2);
});
test('an exact durable validation refusal has no record effect; unknown outcomes stay held',async()=>{
 const {generalRecordsFor}=require('../src/modules/general-write-day-close');
 const run={_id:'refused',day:'2026-10-31',plan:{operations:[{ref:'fix',op:'update',entity:'Transfer',id:'8',before:{TxnDate:'2026-10-29'}}]},dirty:[],items:{fix:{outcome:'fault',entity:'Transfer',op:'update',attempt:1,fault:[{code:'2010'}]}},batches:[{attempt:1,state:'answered',items:[{ref:'fix',bId:'1'}],transport:{receiptId:'receipt',items:[{ref:'fix',bId:'1',outcome:'rejected',faultCodes:['2010']}]}}]};
 const input={Runs:{find:()=>chain([run])},scope,day:'2026-10-29',copy:{read:async()=>assert.fail('refusal creates no record')}};
 assert.equal((await generalRecordsFor(input)).records.length,0);run.batches[0].transport.items[0].outcome='unknown';await assert.rejects(generalRecordsFor(input),/unresolved item/);
});

test('a date-moved record proves zero postings on its old day and current postings on its new day',()=>{
 const {evaluateDay,versionHash}=require('../src/modules/general-write-close');
 const before={Id:'8',TxnDate:'2026-10-29',Amount:10,FromAccountRef:{value:'1'},ToAccountRef:{value:'2'}},current={...before,TxnDate:'2026-10-30'};
 const records=[{entity:'Transfer',id:'8',before,current,evidence:{accountant:{record:current,versionHash:versionHash(current),request:{TxnDate:'2026-10-30'}}}}];
 assert.equal(evaluateDay({records,ledger:{},ctx:{},fromDate:'2026-10-29'}).ok,true);
 assert.equal(evaluateDay({records,ledger:{'Transfer:8':[{accountId:'1',cents:-1000},{accountId:'2',cents:1000}]},ctx:{},fromDate:'2026-10-30'}).ok,true);
 assert.equal(evaluateDay({records,ledger:{'Transfer:8':[{accountId:'1',cents:-1000},{accountId:'2',cents:1000}]},ctx:{},fromDate:'2026-10-29'}).ok,false);
});
