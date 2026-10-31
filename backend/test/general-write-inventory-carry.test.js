'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {hash}=require('../src/modules/business-calendar');
const {emptyStockState,calculateStockCost,summarizeStockState}=require('../src/modules/business-stock-cost');
const {acceptedGeneralItem,sourceFor,generalPurchaseOrigin,readGeneralStockRows}=require('../src/modules/business-stock-general-history');
const {buildGeneralBatch,classifyGeneralResponse}=require('../src/modules/general-write-transport');
const {stockLines,replayStockRecords,checkPurchaseReceipts}=require('../src/modules/business-stock-general');
const {stockBillIds,projectStockRecord,validateStockSource}=require('../src/modules/business-stock-source');
const scope={environment:'sandbox',realmId:'123456',connectionId:'a'.repeat(24)};
const identity={itemKey:'stock-one',itemId:'101',assetAccountId:'9',costAccountId:'10'};
const opening=()=>emptyStockState({scope,rootHash:hash('accepted root'),throughDate:'2026-09-30',items:[identity]});
const query=value=>({session(){return this;},select(){return this;},sort(){return this;},limit(){return this;},maxTimeMS(){return this;},lean:async()=>value});
function fixture(){
 const payload={TxnDate:'2026-10-01',CurrencyRef:{value:'CAD'},GlobalTaxCalculation:'TaxExcluded',VendorRef:{value:'30'},AccountRef:{value:'50'},PaymentType:'Cash',Line:[{Amount:12,DetailType:'ItemBasedExpenseLineDetail',ItemBasedExpenseLineDetail:{Qty:2,UnitPrice:6,ItemRef:{value:'101'},TaxCodeRef:{value:'8'}}}]};
 const record={...payload,Id:'201',SyncToken:'0',TotalAmt:12,TxnTaxDetail:{TotalTax:0}};
 const run={_id:'b'.repeat(24),ownerId:'c'.repeat(24),actorId:'c'.repeat(24),plan:{operations:[{ref:'buy',op:'create',entity:'Purchase',payload}]},items:{buy:{op:'create',entity:'Purchase',outcome:'saved',attempt:1,qboId:'201',request:payload,record}}};
 const batch={index:0,attempt:1,sends:1,requestId:'d'.repeat(32),state:'answered',items:[{bId:'1',ref:'buy',entity:'Purchase',op:'create',operation:'create',payload}]};
 const response=[{bId:'1',Purchase:record}],request=buildGeneralBatch(scope,batch),observed=classifyGeneralResponse(scope,batch,{status:200,json:{BatchItemResponse:response}});
 const dispatchKey=hash({version:1,kind:'general-write',runId:run._id,batchIndex:0,sends:1}),receiptId=hash({scope,dispatchKey});
 const startId=hash({receiptId,event:'started'}).slice(0,24),resultId=hash({receiptId,event:'response',observed}).slice(0,24);
 const receipt={_id:receiptId,...scope,kind:'general-write',ownerId:run.ownerId,actorId:run.actorId,state:'saved',general:{runId:run._id,batchIndex:0,requestId:batch.requestId},requestHash:request.requestHash,dispatchKey,observed,startAuditId:startId,resultAuditId:resultId,periodProof:{kind:'general-period-proof',runId:run._id,batchIndex:0}};
 batch.transport={receiptId,response,items:observed.items};run.batches=[batch];
 const params={environment:scope.environment,connectionId:scope.connectionId,dispatchKey,requestHash:request.requestHash,entity:'batch',operation:'create'};
 const audits=[{_id:startId,userId:run.ownerId,realmId:scope.realmId,action:'QuickBooks write dispatch recorded',actionType:'manual',outcome:'partial',inputParams:params,afterState:{state:'possibly-sent',receiptId}},{_id:resultId,userId:run.ownerId,realmId:scope.realmId,action:'QuickBooks write response recorded',actionType:'manual',outcome:'success',inputParams:params,afterState:{state:'saved',receiptId,...observed}}];
 const models={Receipts:{findOne:()=>query(receipt)},Audits:{findOne:filter=>query(audits.find(a=>a._id===filter._id))},GeneralWriteRuns:{findOne:()=>query(run),find:()=>query([run])}};
 return {models,run,record,batch,receipt,audits};
}
test('native general Purchase is reconstructed into prior activity, survives next-day FIFO carry and typed source readback',async t=>{
 const f=fixture();assert.equal(f.receipt.observed.items[0].outcome,'saved');
 const accepted=await acceptedGeneralItem(f.models,scope,f.run,'buy');
 const rows=stockLines('Purchase',f.record,opening(),i=>sourceFor(scope,f.run,'buy',accepted,i));
 const history=require('../src/modules/business-stock-history');t.mock.method(history,'readCommittedStockOpening',async()=>({state:opening()}));
 const loaded=await readGeneralStockRows(f.models,{value:{scope},calendar:{verifiedThrough:'2026-09-30'}});assert.deepEqual(loaded,rows);
 const active={value:{scope},calendar:{verifiedThrough:'2026-09-30'}};
 assert.deepEqual(await history.readSameDayStockRows({...f.models,Runs:{find:()=>query([])}},active),rows);
 const generalModel=require('../src/models/GeneralWriteRun');t.mock.method(generalModel,'find',()=>query([f.run]));
 const {GeneralWriteRuns,...defaults}=f.models;
 assert.deepEqual(await history.readSameDayStockRows({...defaults,Runs:{modelName:'OperationRun',find:()=>query([])}},active),rows);
 const today=calculateStockCost(opening(),rows,{fromDate:'2026-10-01',throughDate:'2026-10-01'});
 assert.equal(today.closing.orderingVersion,2);assert.equal(summarizeStockState(today.closing).valueCents,1200);
 const origin=await generalPurchaseOrigin(f.models,today.closing,'201',today.closing.items[0].lots);
 assert.equal(origin.qboId,'Purchase:201');assert.deepEqual(stockBillIds(today.closing),['Purchase:201']);
 const sale={entity:'Invoice',txnDate:'2026-10-02',itemId:'101',quantity:1,source:{...rows[0].source,entity:undefined,logicalKey:hash('next sale'),qboId:'202'}};delete sale.source.entity;
 const next=calculateStockCost(today.closing,[sale],{fromDate:'2026-10-02',throughDate:'2026-10-02'});assert.equal(next.costOfSalesCents,600);assert.equal(summarizeStockState(next.closing).valueCents,600);
 const stockSource={version:2,scope,startedAt:'2026-10-01T00:00:00Z',observedAt:'2026-10-01T00:00:01Z',fiscalYearStartMonth:1,companyRecordHash:hash('CA fiscal company'),items:[{Id:'101',SyncToken:'0'}],bills:[],purchases:[{entity:'Purchase',record:projectStockRecord('Purchase',f.record)}]};
 assert.doesNotThrow(()=>validateStockSource({...stockSource,sourceHash:hash(stockSource)},scope,[identity],['Purchase:201']));
});
test('native response, receipt and audits cannot be substituted with changed stock costs',async()=>{
 for(const mutate of [f=>f.record.Line[0].ItemBasedExpenseLineDetail.UnitPrice=7,f=>f.receipt.observed.items[0].responseHash=hash('changed'),f=>f.audits[0].afterState={state:'saved'},f=>f.receipt.general.runId='e'.repeat(24)]){const f=fixture();mutate(f);await assert.rejects(acceptedGeneralItem(f.models,scope,f.run,'buy'),/stock|Stock/);}
});
test('Bill and Purchase numeric IDs may overlap; missing PO backlinks still count forward receipts',()=>{
 const f=fixture(),bill={...f.record},records=[{entity:'Bill',record:bill},{entity:'Purchase',record:f.record}];
 assert.equal(summarizeStockState(replayStockRecords({opening:opening(),records,period:{fromDate:'2026-10-01',throughDate:'2026-10-01'}}).calculation.closing).quantity,4);
 const po={Id:'400',TxnDate:'2026-09-29',POStatus:'Open',VendorRef:{value:'30'},Line:[{Id:'1',ItemBasedExpenseLineDetail:{Qty:3,ItemRef:{value:'101'}}}]};
 bill.Line=structuredClone(bill.Line);bill.Line[0].LinkedTxn=[{TxnType:'PurchaseOrder',TxnId:'400',TxnLineId:'1'}];
 const local={get:(entity,id)=>entity==='PurchaseOrder'&&id==='400'?po:null};
 assert.throws(()=>checkPurchaseReceipts([{entity:'Bill',after:bill}],local,{receiptHistory:[{entity:'Bill',record:bill}]}),/remaining quantity/);
 const header={...bill,Line:structuredClone(bill.Line),LinkedTxn:[{TxnType:'PurchaseOrder',TxnId:'400'}]};delete header.Line[0].LinkedTxn;
 assert.throws(()=>checkPurchaseReceipts([{entity:'Bill',after:header}],local),/exact line/);
 assert.throws(()=>checkPurchaseReceipts([{entity:'Bill',after:bill}],local,{receiptHistory:[{entity:'Bill',record:header}]}),/no complete forward/);
});
