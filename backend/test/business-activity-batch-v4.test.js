'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/business-governance-fixture');
const config=require('../src/config');const previous=config.qbo.environment;test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
const choices=key=>({decisionKey:'credit-refund-journal-'+key,purpose:'Credit and refund a field client for a short visit and accrue a bank charge through the journal.',activities:[
 {type:'customer-credit',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:1,unitPriceCents:9000,purpose:'Goodwill credit for a visit that ran short.'},
 {type:'customer-refund',customerKey:'field-client-001',itemKey:'field-service-hour',quantity:1,unitPriceCents:8000,purpose:'Refund for a cancelled visit paid in advance.'},
 {type:'journal-entry',lines:[{accountKey:'operatingExpense',postingType:'Debit',amountCents:3000},{accountKey:'operatingBank',postingType:'Credit',amountCents:3000}],purpose:'Monthly bank service charge recorded from the statement.'}]});
async function calendar(h,throughDate,key){const p=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});const result=await h.runtime(p.operationId).execute();assert.equal(result.complete,true,JSON.stringify(result));return p;}
async function batch(h,key){const prepared=await h.service.prepareActivityBatch(h.user,choices(key));await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});return h.runtime(prepared.operationId).execute();}
test('customer credits, refunds and journal entries post exactly and the next period balances',{timeout:180000},async()=>{
 const h=fixture({activityTemplateVersion:2,openingDate:'2026-11-01',omitCreditMemoAr:true});await h.publish();await calendar(h,'2026-11-30','credit-november-period-001');
 const posts=h.posts,result=await batch(h,'001');
 assert.equal(result.complete,true,JSON.stringify(result));assert.equal(h.posts,posts+3);
 const saved=entity=>[...h.records.values()].filter(row=>row.entity===entity).map(row=>row.record);
 const [credit]=saved('CreditMemo'),[refund]=saved('RefundReceipt'),[journal]=saved('JournalEntry');
 // QuickBooks omits the credit's receivables account in its responses; the ledger proves it.
 assert.equal(h.data.Steps.find(row=>row.entity==='CreditMemo').verification.accountRouting.kind,'creditmemo-receivables-ledger');assert.equal(credit.RemainingCredit,credit.TotalAmt);assert.equal(credit.Line[0].Amount,90);assert.equal(credit.Line[0].SalesItemLineDetail.TaxCodeRef.value,h.mappings.salesTax);assert.equal(credit.LinkedTxn,undefined);
 assert.equal(refund.DepositToAccountRef.value,h.mappings.operatingBank);assert.equal(refund.Line[0].Amount,80);assert.equal(refund.GlobalTaxCalculation,'TaxExcluded');
 assert.deepEqual(journal.Line.map(line=>[line.JournalEntryLineDetail.PostingType,line.JournalEntryLineDetail.AccountRef.value,line.Amount]),[['Debit',h.mappings.operatingExpense,30],['Credit',h.mappings.operatingBank,30]]);
 for(const record of [credit,refund,journal])for(const key of ['VendorRef','ProcessPayment','DueDate'])assert.equal(record[key],undefined,key);
 await calendar(h,'2026-12-01','close-december-first-after-credit');assert.equal(h.data.Calendars[0].verifiedThrough,'2026-12-01');
 h.clock+=86400000;
 h.afterPost=async(opts,record)=>{if(new URL(opts.url).pathname.endsWith('/journalentry')){h.afterPost=null;record.Line[0].Amount=31;}};
 const changed=await batch(h,'002');assert.notEqual(changed.complete,true);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-12-01');
});
