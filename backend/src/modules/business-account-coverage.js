'use strict';
// Pure mirror analysis. Counts referenced transactions, not GL entries or native reconciliations.
const TRANSACTIONS = Object.freeze(['Invoice','Payment','Bill','BillPayment','SalesReceipt','RefundReceipt','CreditMemo','VendorCredit','Purchase','Deposit','Transfer','CreditCardPayment','TaxPayment','JournalEntry']);
const accountIds = record => {
  const found = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/AccountRef$/.test(key) && child?.value != null) found.add(String(child.value));
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(record); return found;
};
const isCashAccount = a => ['Bank','Credit Card'].includes(a.AccountType) || a.AccountType === 'Other Current Asset' && a.AccountSubType === 'CashOnHand';
const transactionDate = row => row.entity==='TaxPayment'?row.record.PaymentDate:row.record.TxnDate;
const hasMovement = r => [r.TotalAmt,r.Amount,r.PaymentAmount,...(r.Line||[]).map(l=>l.Amount)].some(v=>typeof v==='number'&&Number.isFinite(v)&&v!==0);
const dateBefore = (day,n) => { const d=new Date(day+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-n); return d.toISOString().slice(0,10); };
function flags(record) {
  const found=[];
  function visit(o,path='') { if(!o||typeof o!=='object')return; for(const [k,v] of Object.entries(o)) {const p=path?path+'.'+k:k; if(/^(ClearedStatus|ReconcileStatus|ReconciliationStatus)$/i.test(k)) found.push({path:p,value:v}); else if(v&&typeof v==='object')visit(v,p);} }
  visit(record);return found;
}
function measureAccounts(records,today) {
  const live=records.filter(row=>!row.deleted&&row.record?.status!=='Deleted');
  const tx=live.filter(row=>TRANSACTIONS.includes(row.entity)&&(!transactionDate(row)||transactionDate(row)<=today)).map(row=>({row,ids:accountIds(row.record)}));
  return live.filter(row=>row.entity==='Account'&&isCashAccount(row.record)).map(row=>{
    const id=String(row.qboId),a=row.record,matched=tx.filter(t=>t.ids.has(id)).map(t=>t.row);
    const count=since=>matched.filter(t=>transactionDate(t)>=since&&transactionDate(t)<=today).length;
    const types=since=>matched.filter(t=>!since||transactionDate(t)>=since).reduce((out,t)=>(out[t.entity]=(out[t.entity]||0)+1,out),{});
    return {id,name:a.Name||id,active:a.Active!==false,type:a.AccountType,subtype:a.AccountSubType,currency:a.CurrencyRef?.value||'CAD',balance:a.CurrentBalance??null,balanceObservedAt:row.lastObservedAt||null,
      total:matched.length,last7Days:count(dateBefore(today,6)),last30Days:count(dateBefore(today,29)),undated:matched.filter(t=>!transactionDate(t)).length,
      transactionTypes:types(),transactionTypesLast7Days:types(dateBefore(today,6)),transactionTypesLast30Days:types(dateBefore(today,29)),
      observedFlags:matched.flatMap(t=>flags(t.record).map(f=>({entity:t.entity,id:t.qboId,...f}))),
      flagVisibility:'Absent cleared/reconciled flags are unknown, never uncleared or unreconciled.',
      example:matched.length?{entity:matched[0].entity,id:matched[0].qboId}:null};
  });
}
function reconciliationChecklist(account,today) {
  const balance=typeof account.balance==='number'&&Number.isFinite(account.balance)?account.balance:null;
  return {accountId:account.id,account:account.name,currency:account.currency,statementDate:today,endingBalance:balance,balanceObservedAt:account.balanceObservedAt||null,balanceSource:'Synced Account.CurrentBalance (account currency); test statement target only, not an external statement or historical balance.',
    steps:[
      'In QuickBooks open Accounting > Reconcile and choose '+account.name+' (account '+account.id+').',
      'For this simulated feature test use statement date '+today+' and ending balance '+(balance===null?'unavailable — refresh the account balance first':balance+' '+account.currency)+'; confirm the register balance still agrees before proceeding.',
      'Open the account register. Retain separate eligible examples blank (uncleared), C (cleared), and R (reconciled) using QuickBooks UI; record their transaction IDs and screenshots. Do not alter protected or filed history.',
      'For a completed test reconciliation, select only the intended test transactions, resolve the difference to zero without an invented adjustment, finish and retain the reconciliation report.',
      'Keep a separate incomplete test reconciliation or statement discrepancy if needed for support. Record the statement date, beginning/ending balances and remaining difference. Do not claim an actual bank statement match.'
    ]};
}
module.exports={TRANSACTIONS,accountIds,isCashAccount,measureAccounts,reconciliationChecklist,hasMovement};
