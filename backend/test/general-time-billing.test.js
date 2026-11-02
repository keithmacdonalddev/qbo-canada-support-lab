'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {incident,scope,clock}=require('./helpers/general-estimate-fixture');
const {buildGeneralBatch,classifyGeneralResponse}=require('../src/modules/general-write-transport');
const {generalRecordsFor,closeGeneralDay}=require('../src/modules/general-write-day-close');
const {evaluateDay}=require('../src/modules/general-write-close');
const {hash}=require('../src/modules/business-calendar');
const clone=v=>structuredClone(v);
function fixture(hours=1,minutes=30){
  const h=incident(),timeId='1073742973',invoiceId='11263',amount=(hours+minutes/60)*125;
  const time={Id:timeId,SyncToken:'0',TxnDate:'2026-11-01',NameOf:'Employee',EmployeeRef:{value:'3'},CustomerRef:{value:'1'},ItemRef:{value:'40'},Hours:hours,Minutes:minutes,Seconds:0,HourlyRate:125,BillableStatus:'Billable',Description:'Fictional scheduled work',MetaData:{CreateTime:'2026-11-01T12:00:00Z',LastUpdatedTime:'2026-11-01T12:00:00Z'}};
  const timePayload={...clone(time)};for(const k of ['Id','SyncToken','MetaData','Seconds'])delete timePayload[k];
  const payload={TxnDate:time.TxnDate,CustomerRef:{value:'1'},Line:[{Amount:amount,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'40'},Qty:hours+minutes/60,UnitPrice:125,TaxCodeRef:{value:'7'}}}],LinkedTxn:[{TxnId:timeId,TxnType:'TimeActivity'}]};
  const invoice={...clone(payload),Id:invoiceId,CurrencyRef:{value:'CAD'},SyncToken:'0',DocNumber:'FIXTURE-'+invoiceId,Line:[{Id:'1',...clone(payload.Line[0])}],TotalAmt:Math.round(amount*114)/100,Balance:Math.round(amount*114)/100,TxnTaxDetail:{TotalTax:Math.round(amount*14)/100,TaxLine:[{Amount:Math.round(amount*14)/100,TaxLineDetail:{TaxRateRef:{value:'8'}}}]},MetaData:{CreateTime:'2026-11-01T12:01:00Z',LastUpdatedTime:'2026-11-01T12:01:00Z'}};
  const currentTime={...clone(time),BillableStatus:'HasBeenBilled',MetaData:{...time.MetaData,LastUpdatedTime:'2026-11-01T12:01:00Z'}},currentInvoice=clone(invoice);
  function compile(run,receipt,ref,entity,body,record){
    const sent={bId:'1',ref,op:'create',operation:'create',entity,payload:clone(body)},batch={index:0,attempt:1,requestId:(entity==='Invoice'?'d':'9').repeat(32),state:'answered',sends:1,items:[sent]},response=[{bId:'1',[entity]:clone(record)}],observed=classifyGeneralResponse(scope,batch,{status:200,json:{BatchItemResponse:response}});
    Object.assign(receipt,{requestHash:buildGeneralBatch(scope,batch).requestHash,observed,general:{runId:run._id,batchIndex:0,requestId:batch.requestId}});batch.transport={receiptId:receipt._id,outcome:'saved',response,items:observed.items};
    Object.assign(run,{status:'complete',day:time.TxnDate,plan:{operations:[{ref,entity,op:'create',payload:clone(body)}]},batches:[batch],items:{[ref]:{entity,op:'create',outcome:'saved',attempt:1,qboId:record.Id,request:clone(body),record:clone(record)}},owned:[{key:entity+':'+record.Id,ref,op:'create'}]});
  }
  const sign=()=>{compile(h.run,h.receipt,'invoice','Invoice',payload,invoice);compile(h.quoteRun,h.quoteReceipt,'time','TimeActivity',timePayload,time);};sign();
  const copy={read:async(_s,e,id)=>clone(e==='TimeActivity'&&id===timeId?currentTime:e==='Invoice'&&id===invoiceId?currentInvoice:null)};
  const gather=()=>generalRecordsFor({Runs:h.models.GeneralWriteRuns,models:h.models,scope,day:time.TxnDate,copy,now:()=>clock});
  const ctx={receivables:'120',get:()=>({Type:'Service',IncomeAccountRef:{value:'400'}}),taxAccount:()=> '210'},ledger={'Invoice:11263':[{accountId:'120',cents:Math.round(invoice.TotalAmt*100)},{accountId:'400',cents:-Math.round(amount*100)},{accountId:'210',cents:-Math.round(invoice.TxnTaxDetail.TotalTax*100)}]};
  return {...h,time,invoice,payload,timePayload,currentTime,currentInvoice,copy,gather,sign,ctx,ledger,day:time.TxnDate};
}
test('the four observed durations close with their one receipt-proved consuming invoice',async()=>{
  for(const [hours,minutes]of [[1,30],[1,0],[0,30],[0,30]]){
    const h=fixture(hours,minutes),original=clone([h.run,h.quoteRun,h.receipt,h.quoteReceipt]),g=await h.gather(),time=g.records.find(r=>r.entity==='TimeActivity');
    assert.equal(time.evidence.accountant.timeBilling.invoiceId,'11263');assert.equal(time.evidence.accountant.originalTimeRecord.BillableStatus,'Billable');
    const result=evaluateDay({records:g.records,ledger:h.ledger,ctx:h.ctx,fromDate:h.day});assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual([h.run,h.quoteRun,h.receipt,h.quoteReceipt],original);
  }
});
test('full time details, token and creation metadata stay strict',async()=>{
  for(const change of [r=>r.CustomerRef.value='2',r=>r.ItemRef.value='2',r=>r.Hours++,r=>r.Minutes++,r=>r.HourlyRate++,r=>r.Description='Altered work',r=>r.SyncToken='1',r=>r.MetaData.CreateTime='2026-11-01T11:00:00Z',r=>r.MetaData.LastUpdatedTime='invalid',r=>r.MetaData.LastUpdatedTime='2026-11-01T11:59:00Z',r=>r.UnexpectedNativeField=true,r=>r.BillableStatus='NotBillable']){
    const h=fixture();change(h.currentTime);const g=await h.gather();assert.equal(g.records.find(r=>r.entity==='TimeActivity').evidence.accountant.timeBilling,undefined);assert.equal(evaluateDay({records:g.records,ledger:h.ledger,ctx:h.ctx,fromDate:h.day}).ok,false);
  }
});
test('a fully authenticated invoice still needs the exact customer, item, duration, rate and amount',async()=>{
  for(const change of [p=>p.CustomerRef.value='2',p=>p.Line[0].SalesItemLineDetail.ItemRef.value='2',p=>p.Line[0].SalesItemLineDetail.Qty=2,p=>p.Line[0].SalesItemLineDetail.UnitPrice=126,p=>p.Line[0].Amount=188,p=>p.LinkedTxn.push(clone(p.LinkedTxn[0])),p=>p.Line[0].LinkedTxn=[clone(p.LinkedTxn[0])]]){
    const h=fixture();change(h.payload);Object.assign(h.invoice,clone(h.payload));Object.assign(h.currentInvoice,clone(h.invoice));h.sign();const g=await h.gather();assert.equal(g.records.find(r=>r.entity==='TimeActivity').evidence.accountant.timeBilling,undefined);
  }
});
test('voids, edits, ambiguous consumers, wrong owners and damaged creation receipts do not explain time billing',async()=>{
  for(const change of [h=>h.currentInvoice.status='Voided',h=>h.currentInvoice.TotalAmt++,h=>h.currentInvoice.CurrencyRef.value='USD',h=>h.quoteReceipt.observed.items[0].responseHash='0'.repeat(64),h=>h.receipt.observed.items[0].responseHash='0'.repeat(64),h=>{h.run.ownerId='f'.repeat(24);h.receipt.ownerId=h.run.ownerId;},h=>h.run.caseAuthority={caseId:'foreign'},h=>{h.run.items.duplicate={...clone(h.run.items.invoice),qboId:'999'};}]){
    const h=fixture();change(h);const g=await h.gather();assert.equal(g.records.find(r=>r.entity==='TimeActivity').evidence.accountant.timeBilling,undefined);
  }
});
test('serialized or invented billing capabilities cannot waive a billable-status request',async()=>{
  const h=fixture(),g=await h.gather(),copy=clone(g.records);assert.equal(evaluateDay({records:copy,ledger:h.ledger,ctx:h.ctx,fromDate:h.day}).ok,false);
  const time=copy.find(r=>r.entity==='TimeActivity');time.evidence.accountant.timeBilling={originalStatus:'HasBeenBilled'};assert.equal(evaluateDay({records:copy,ledger:h.ledger,ctx:h.ctx,fromDate:h.day}).ok,false);
});
test('the real close boundary re-authenticates billing after replay capture serialization',async()=>{
  const h=fixture(),g=await h.gather(),cols=['tx_date','txn_type','debt_amt','credit_amt'].map(ColType=>({ColType}));
  const report={Header:{ReportName:'GeneralLedger',ReportBasis:'Accrual',StartPeriod:h.day,EndPeriod:h.day},Columns:{Column:cols},Rows:{Row:h.ledger['Invoice:11263'].map(p=>({type:'Section',Header:{ColData:[{id:p.accountId}]},Rows:{Row:[{type:'Data',ColData:[{value:h.day},{value:'Invoice',id:'11263'},{value:p.cents>0?(p.cents/100).toFixed(2):''},{value:p.cents<0?(-p.cents/100).toFixed(2):''}]}]}}))}};
  const result=await closeGeneralDay({Runs:h.models.GeneralWriteRuns,models:h.models,scope,day:h.day,copy:h.copy,ledgerReport:report,ctx:h.ctx,gathered:g});assert.equal(result.ok,true,JSON.stringify(result));
  h.currentTime.Description='Changed after gathering';await assert.rejects(closeGeneralDay({Runs:h.models.GeneralWriteRuns,models:h.models,scope,day:h.day,copy:h.copy,ledgerReport:report,ctx:h.ctx,gathered:g}),/billing changed/);
});
