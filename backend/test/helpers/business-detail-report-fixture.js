'use strict';
// Independent double-entry projections of accepted simulated QBO records. This
// fixture never reads the application's plan, tax policy or verification flags.
function detailReports({transactions,mappings,saleCosts,period,closingBank,earningsPostings}){
 const ledger=[];let cashChange=0;
 const post=(r,account,label,debit,credit)=>ledger.push({type:'Data',ColData:[{value:r.TxnDate},{id:r.Id,value:r.DocNumber||r.Id},{id:account,value:label},{value:r.CustomerRef?.name||r.VendorRef?.name||''},{value:r.PrivateNote||''},{value:debit?debit.toFixed(2):''},{value:credit?credit.toFixed(2):''}]});
 const income=(r,net)=>{const saved=earningsPostings?.get(r.Id)?.filter(row=>row.kind==='income');if(saved?.length)for(const line of saved)post(r,line.accountId,'Income',Math.max(-line.amountCents,0)/100,Math.max(line.amountCents,0)/100);else post(r,'971','Income',Math.max(-net,0),Math.max(net,0));};
 const posting=transactions.filter(row=>['Invoice','SalesReceipt','CreditMemo','Bill','Payment','BillPayment','Deposit','Purchase','VendorCredit'].includes(row.entity)&&row.record.TxnDate>=period.fromDate&&row.record.TxnDate<=period.throughDate);
 for(const {entity,record:r}of posting){const net=(r.Line||[]).reduce((sum,line)=>sum+(line.Amount||0),0),tax=r.TxnTaxDetail?.TotalTax||0,gross=r.TotalAmt||0;
  if(entity==='Invoice'){post(r,mappings.accountsReceivable,'Receivables',gross,0);income(r,net);post(r,'970','Sales tax',0,tax);}
  if(entity==='CreditMemo'){post(r,mappings.accountsReceivable,'Receivables',0,gross);income(r,-net);post(r,'970','Sales tax',tax,0);}
  if(entity==='Bill'){for(const line of r.Line||[])post(r,line.DetailType==='AccountBasedExpenseLineDetail'?line.AccountBasedExpenseLineDetail.AccountRef.value:mappings.inventoryAsset,line.DetailType==='AccountBasedExpenseLineDetail'?'Operating expense':'Stock',line.Amount,0);post(r,'970','Input tax',tax,0);post(r,mappings.accountsPayable,'Payables',0,gross);}
  if(entity==='SalesReceipt'){post(r,mappings.operatingBank,'Bank',gross,0);income(r,net);post(r,'970','Sales tax',0,tax);const cost=saleCosts.get(r.Id)||0;post(r,mappings.costOfGoods,'Cost of goods',cost,0);post(r,mappings.inventoryAsset,'Stock',0,cost);cashChange+=gross;}
  if(entity==='Payment'){post(r,r.DepositToAccountRef.value,'Receipt destination',gross,0);post(r,mappings.accountsReceivable,'Receivables',0,gross);if(r.DepositToAccountRef.value===mappings.operatingBank)cashChange+=gross;}
  if(entity==='BillPayment'){post(r,mappings.accountsPayable,'Payables',gross,0);post(r,mappings.operatingBank,'Bank',0,gross);cashChange-=gross;}
  if(entity==='Purchase'){for(const line of r.Line||[])post(r,line.AccountBasedExpenseLineDetail.AccountRef.value,'Operating expense',line.Amount,0);post(r,'970','Input tax',tax,0);post(r,r.AccountRef.value,'Bank',0,gross);cashChange-=gross;}
  if(entity==='VendorCredit'){post(r,mappings.accountsPayable,'Payables',gross,0);for(const line of r.Line||[])post(r,line.AccountBasedExpenseLineDetail.AccountRef.value,'Operating expense',0,line.Amount);post(r,'970','Input tax',0,tax);}
  if(entity==='Deposit'){post(r,mappings.operatingBank,'Bank',gross,0);post(r,mappings.undepositedFunds,'Undeposited',0,gross);cashChange+=gross;}
 }
 const report=(name,columns,rows)=>({Header:{ReportName:name,StartPeriod:period.fromDate,EndPeriod:period.throughDate,ReportBasis:'Accrual',Currency:'CAD'},Columns:{Column:columns.map(ColTitle=>({ColTitle}))},Rows:{Row:rows}}),amount=(label,value)=>({type:'Data',ColData:[{value:label},{value:value.toFixed(2)}]});
 const GeneralLedger=report('GeneralLedger',['Date','Transaction','Account','Name','Memo','Debit','Credit'],ledger);if(!ledger.length)GeneralLedger.Header.Option=[{Name:'NoReportData',Value:'true'}];
 const CashFlow=report('CashFlow',['Activity','Total'],[amount('Opening cash',closingBank-cashChange),amount('Net change in cash',cashChange),amount('Closing cash',closingBank)]);
 if(!posting.length&&closingBank===0){CashFlow.Rows.Row=[];CashFlow.Header.Option=[{Name:'NoReportData',Value:'true'}];}
 return{GeneralLedger,CashFlow};
}
module.exports={detailReports};
