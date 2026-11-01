'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../src/modules/business-calendar');
const {emptyStockState,summarizeStockState}=require('../src/modules/business-stock-cost');
const {replayStockRecords,checkStockPlan,readGeneralStockContext,STOCK_ENTITIES}=require('../src/modules/business-stock-general');
const {nativeReturnValuations,compareItemValuation,evidence,retainedValuations,createValuationReader}=require('../src/modules/business-stock-valuation');
const {postingsOf}=require('../src/modules/general-write-postings');
const {detail,summary}=require('./helpers/inventory-reports');
const scope={environment:'sandbox',realmId:'123456',connectionId:'a'.repeat(24)},day='2026-10-01';
const identity={itemKey:'stock-one',itemId:'101',assetAccountId:'9',costAccountId:'10'};
const zero=()=>emptyStockState({scope,rootHash:hash('root'),throughDate:'2026-09-29',items:[identity]});
const record=(entity,id,on,qty,price)=>{const buy=['Bill','VendorCredit'].includes(entity),type=buy?'ItemBasedExpenseLineDetail':'SalesItemLineDetail';return{Id:id,SyncToken:'0',TxnDate:on,CurrencyRef:{value:'CAD'},GlobalTaxCalculation:'TaxExcluded',...(buy?{VendorRef:{value:'30'}}:{CustomerRef:{value:'1'}}),...(entity==='RefundReceipt'?{DepositToAccountRef:{value:'50'}}:{}),Line:[{Id:'1',Amount:qty*price,DetailType:type,[type]:{ItemRef:{value:'101'},Qty:qty,UnitPrice:price}}]};};
const opening=()=>replayStockRecords({opening:zero(),records:[{entity:'Bill',record:record('Bill','200','2026-09-30',5,6)}],period:{fromDate:'2026-09-30',throughDate:'2026-09-30'}}).calculation.closing;
const replay=(state,records,returnValuations={})=>replayStockRecords({opening:state,records,returnValuations,period:{fromDate:day,throughDate:day}});
const query=v=>({session(){return this},sort(){return this},maxTimeMS(){return this},limit(){return this},lean:async()=>v});
test('native customer returns restore quantity/value and reverse COGS; supplier returns reduce quantity/purchases without COGS',()=>{
 for(const entity of ['CreditMemo','RefundReceipt','VendorCredit']){
  const value=record(entity,'201',day,2,entity==='VendorCredit'?6:20),records=[{entity,record:value}],report=detail(day,entity,'201','101',entity==='VendorCredit'?-2:2,entity==='VendorCredit'?-1200:1200),proof=nativeReturnValuations(report,day,records,opening()),calc=replay(opening(),records,proof).calculation;
  assert.equal(summarizeStockState(calc.closing).quantity,entity==='VendorCredit'?3:7);assert.equal(summarizeStockState(calc.closing).valueCents,entity==='VendorCredit'?1800:4200);
  assert.equal(calc.purchaseCents,entity==='VendorCredit'?-1200:0);assert.equal(calc.costOfSalesCents,entity==='VendorCredit'?0:-1200);
  const basis={records,replay:replay(opening(),records,proof)},ctx={inventory:{enabled:true,entities:{[entity]:true}},get:()=>({Type:'Inventory',AssetAccountRef:{value:'9'},ExpenseAccountRef:{value:'10'},IncomeAccountRef:{value:'11'}}),receivables:'12',payables:'13',stockCost:(e,r,i)=>require('../src/modules/business-stock-general').stockPostingCost(basis,e,r,i)};
  const posting=postingsOf(entity,value,ctx);assert.equal(posting.get('9'),entity==='VendorCredit'?-1200:1200);assert.equal(posting.get('10')||0,entity==='VendorCredit'?0:-1200);
 }
});
test('native return proof rejects wrong identity, date, sign, amount, mixed native layers and mixed carried layers',()=>{
 const value=record('CreditMemo','201',day,2,20),records=[{entity:'CreditMemo',record:value}],base=detail(day,'CreditMemo','201','101',2,1200);
 for(const mutate of [r=>r.Header.EndPeriod='2026-10-02',r=>r.Rows.Row[0].Header.ColData[0].id='102',r=>r.Rows.Row[0].Rows.Row[0].ColData[1].id='999',r=>r.Rows.Row[0].Rows.Row[0].ColData[2].value='-2',r=>r.Rows.Row[0].Rows.Row[0].ColData[3].value='12.001']){const r=structuredClone(base);mutate(r);assert.throws(()=>nativeReturnValuations(r,day,records,opening()));}
 const mixed=structuredClone(base),row=mixed.Rows.Row[0].Rows.Row[0];row.ColData[2].value='1';row.ColData[3].value='5.00';const second=structuredClone(row);second.ColData[3].value='7.00';mixed.Rows.Row[0].Rows.Row.push(second);assert.throws(()=>nativeReturnValuations(mixed,day,records,opening()),/mixed cost/);
 const proof=nativeReturnValuations(base,day,records,opening());const buy=record('Bill','202',day,3,8);assert.throws(()=>replay(opening(),[...records,{entity:'Bill',record:buy}],proof),/Mixed-cost/);
 const changed=structuredClone(base);changed.Header.Time='2026-11-01T00:05:00Z';assert.deepEqual(nativeReturnValuations(changed,day,records,opening()),proof);
});
test('prefix guard admits current customer and supplier returns; sold-out return cannot authorize an unpriced dependent sale',()=>{
 const local={get:()=>null},stock={opening:opening(),records:[],period:{fromDate:day,throughDate:day}},entry=(entity,id,qty,price)=>({entity,ref:id,order:0,after:record(entity,id,day,qty,price)});
 for(const e of ['CreditMemo','RefundReceipt','VendorCredit'])assert.equal(checkStockPlan([entry(e,'201',2,e==='VendorCredit'?6:20)],local,stock),true);
 assert.throws(()=>checkStockPlan([entry('VendorCredit','201',6,6)],local,stock),/negative stock/);
 const sell=entry('Invoice','202',6,20),ret=entry('CreditMemo','201',2,20);assert.throws(()=>checkStockPlan([sell,ret],local,stock),/negative stock/);assert.equal(checkStockPlan([ret,sell],local,stock),true);
 const empty=emptyStockState({scope,rootHash:hash('root'),throughDate:'2026-09-30',items:[identity]}),out={...stock,opening:empty};assert.equal(checkStockPlan([ret],local,out),true);assert.throws(()=>checkStockPlan([ret,entry('RefundReceipt','205',1,20)],local,out),/Wait for native valuation/);assert.throws(()=>checkStockPlan([ret,entry('VendorCredit','204',1,0)],local,out),/Wait for native valuation/);assert.throws(()=>checkStockPlan([ret,entry('Invoice','203',1,20)],local,out),/Wait for native valuation/);
});
test('per-item native summary catches offsetting value and quantity errors; retained reports reparse exact original records',async()=>{
 const state=opening(),items=summarizeStockState(state).items,report=summary(day,items);assert.equal(compareItemValuation(report,day,state)[0].status,'passed');
 const changed=structuredClone(report);changed.Rows.Row[0].ColData[2].value='29.99';assert.throws(()=>compareItemValuation(changed,day,state),/Per-item/);
 const value=record('CreditMemo','201',day,2,20),records=[{entity:'CreditMemo',record:value}],raw=detail(day,'CreditMemo','201','101',2,1200),saved=evidence(scope,day,records,raw),models={GeneralDayCloses:{findOne:()=>query({stock:{returns:saved}})}};
 assert.deepEqual(await retainedValuations(models,scope,day,records,state),nativeReturnValuations(raw,day,records,state));saved.reportJson=saved.reportJson.replace('12.00','11.00');await assert.rejects(retainedValuations(models,scope,day,records,state),/retained native/);
});
test('transactional admission never starts native report network work',async()=>{
 let called=false;const read=createValuationReader({access:{authorize:async()=>{called=true}}});await assert.rejects(read({scope,day,records:[],session:{}}),/before transactional/);assert.equal(called,false);
});
test('live complete-day path binds native return and per-item valuation without provider/database writes',async t=>{
 const state=opening(),value=record('CreditMemo','201',day,2,20),records=[{entity:'CreditMemo',record:value}],native=detail(day,'CreditMemo','201','101',2,1200),proof=nativeReturnValuations(native,day,records,state),expected=replay(state,records,proof).calculation.closing;
 const item={Id:'101',Type:'Inventory',Active:true,TrackQtyOnHand:true,InvStartDate:'2026-09-01',QtyOnHand:7,AssetAccountRef:{value:'9'},ExpenseAccountRef:{value:'10'}};
 const sources=Object.fromEntries(['Item',...STOCK_ENTITIES].map(e=>[e,{status:'current',phase:'incremental',generation:'test',mode:'cdc',since:new Date(Date.now()-2000),lastSuccessAt:new Date(Date.now()-1000),everyMs:60000}]));
 t.mock.method(require('../src/modules/business-stock-history'),'readCommittedStockOpening',async()=>({state}));
 const input={scope,day,verifyValuation:true,active:{value:{stockRoot:{zeroSource:{items:[item]}}}},models:{Agents:{findOne:()=>query({sync:{sources}})},Receipts:{findOne:()=>query(null)},Records:{find:f=>query(f.entity==='Item'?[{qboId:'101',record:item}]:f.entity==='CreditMemo'?[{qboId:'201',record:value}]:[])}},observations:{read:async(s,e)=>({record:e==='Item'?item:value})},readValuation:async()=>({InventoryValuationDetail:native,InventoryValuationSummary:summary(day,summarizeStockState(expected).items)})};
 const result=await readGeneralStockContext(input);assert.equal(result.valuationChecks[0].status,'passed');assert.equal(result.returnEvidence.records[0].record.Id,'201');
 input.readValuation=async()=>({InventoryValuationDetail:native,InventoryValuationSummary:summary(day,[{itemId:'101',quantity:7,valueCents:4201}])});await assert.rejects(readGeneralStockContext(input),/Per-item/);
});

test('scoped native valuation warms before admission and resumes from exact cache without network in transaction',async t=>{
 const {QBOClient}=require('../src/modules/qbo-client'),client=Object.create(QBOClient.prototype),actor={actorId:'b'.repeat(24),ownerId:'c'.repeat(24)};
 client.realmId=scope.realmId;Object.defineProperty(client,'apiBase',{value:'https://sandbox-quickbooks.api.intuit.com/v3/company/'+scope.realmId});client.connection={_id:scope.connectionId,realmId:scope.realmId,userId:actor.ownerId,status:'active'};
 let calls=0;t.mock.method(QBOClient.prototype,'apiCall',async()=>{calls++;return detail(day,'CreditMemo','201','101',2,1200)});
 const access={authorize:async()=>actor,resolveClient:async()=>client},value=record('CreditMemo','201',day,2,20),input={scope,day,records:[{entity:'CreditMemo',record:value}]};
 const read=createValuationReader({access});await read(input);assert.equal(calls,1);await read({...input,session:{}});assert.equal(calls,1);
 const restarted=createValuationReader({access});await assert.rejects(restarted({...input,session:{}}),/before transactional/);assert.equal(calls,1);await restarted(input);await restarted({...input,session:{}});assert.equal(calls,2);
 const changed=structuredClone(input);changed.records[0].record.Line[0].SalesItemLineDetail.Qty=3;await assert.rejects(read({...changed,session:{}}),/before transactional/);client.connection.realmId='999';await assert.rejects(createValuationReader({access})(input),/authority changed/);assert.equal(calls,2);
});

test('calendar close and fixed-workflow return proof use native quantity/value checks even with admission flags off',async t=>{
 const state=opening(),value=record('CreditMemo','201',day,2,20);value.TotalAmt=40;value.RemainingCredit=40;
 const item={Id:'101',Type:'Inventory',Active:true,TrackQtyOnHand:true,InvStartDate:'2026-09-01',QtyOnHand:7,AssetAccountRef:{value:'9'},ExpenseAccountRef:{value:'10'},IncomeAccountRef:{value:'11'}};
 const native=detail(day,'CreditMemo','201','101',2,1200),summ=summary(day,[{itemId:'101',quantity:7,valueCents:4200}]),closes=[];
 const run={_id:'b'.repeat(24),day,contract:'general-write-v1',dirty:[],plan:{operations:[{ref:'ret',op:'create',entity:'CreditMemo'}]},items:{ret:{outcome:'saved',op:'create',entity:'CreditMemo',qboId:'201',record:value}}};
 const sources=Object.fromEntries(['Item',...STOCK_ENTITIES].map(e=>[e,{status:'current',phase:'incremental',generation:'test',mode:'cdc',since:new Date(Date.now()-2000),lastSuccessAt:new Date(Date.now()-1000),everyMs:60000}]));
 const q=v=>({...query(v),select(){return this}}),models={GeneralWriteRuns:{find:()=>q([run])},GeneralDayCloses:{findOne:()=>q(null),create:async([row])=>closes.push(row)},Agents:{findOne:()=>q({sync:{sources}})},Receipts:{findOne:()=>q(null)},Records:{find:f=>q(f.entity==='Account'?[]:f.entity==='Item'?[{qboId:'101',record:item}]:f.entity==='CreditMemo'?[{qboId:'201',record:value}]:[])}};
 const copy={read:async(s,e)=>e==='Item'?item:value},active={value:{scope,stockRoot:{zeroSource:{items:[item]}}},calendar:{verifiedThrough:'2026-09-30'}};
 t.mock.method(require('../src/modules/business-runtime'),'loadModels',()=>({}));t.mock.method(require('../src/modules/business-authority'),'readPublishedBusiness',async()=>active);t.mock.method(require('../src/modules/business-stock-history'),'readCommittedStockOpening',async()=>({state}));t.mock.method(require('../src/modules/business-observation-store'),'createBusinessObservationStore',()=>({read:async(s,e)=>({record:e==='Item'?item:value})}));
 const gate=require('../src/modules/general-write-close-gate').createGeneralCloseGate({models,copy,readValuation:async()=>({InventoryValuationDetail:native,InventoryValuationSummary:summ})});
 assert.equal((await gate.retainStockReturns(scope,{day,mappings:{accountsReceivable:'12'}})).required,true);assert.equal(closes[0].kind,'inventory');assert.equal(closes[0].stock.checks[0].actualValueCents,4200);
 const rows=[['9',1200],['10',-1200],['11',4000],['12',-4000]].map(([id,cents])=>({type:'Section',Header:{ColData:[{id}]},Rows:{Row:[{type:'Data',ColData:[{value:day},{value:'Credit Memo',id:'201'},{value:cents>0?(cents/100).toFixed(2):''},{value:cents<0?(-cents/100).toFixed(2):''}]}]}}));
 const ledger={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',StartPeriod:day,EndPeriod:day},Columns:{Column:['tx_date','txn_type','debt_amt','credit_amt'].map(ColType=>({ColType}))},Rows:{Row:rows}};
 assert.equal((await gate.assertPeriodReady(scope,{fromDate:day,throughDate:day,verifiedThrough:'2026-09-30',mappings:{accountsReceivable:'12'},readLedger:async()=>ledger})).results[0].ok,true);assert.equal(closes.at(-1).kind,'period');assert.equal(closes.at(-1).stock.returns.records[0].record.Id,'201');
 summ.Rows.Row[0].ColData[2].value='42.01';await assert.rejects(gate.assertPeriodReady(scope,{fromDate:day,throughDate:day,verifiedThrough:'2026-09-30',mappings:{accountsReceivable:'12'},readLedger:async()=>ledger}),/Per-item/);
});
