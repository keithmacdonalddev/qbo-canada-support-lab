'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/business-governance-fixture');
const config=require('../src/config');const previous=config.qbo.environment;test.before(()=>{config.qbo.environment='sandbox';});test.after(()=>{config.qbo.environment=previous;});
const choices=(key)=>({decisionKey:'cash-expense-and-credit-'+key,purpose:'Pay a software charge from the bank and record a supplier credit for overbilled premises.',activities:[
 {type:'paid-cash-expense',vendorKey:'overhead-supplier-3',category:'software',amountCents:4500,purpose:'Monthly team software seat paid from the operating bank.'},
 {type:'supplier-credit',vendorKey:'overhead-supplier-1',category:'premises',amountCents:2000,purpose:'Credit from the landlord for an overbilled service charge.'}]});
async function calendar(h,throughDate,key){const p=await h.service.prepare(h.user,{requestKey:key,throughDate});await h.service.approve(h.user,p.operationId,{planHash:p.planHash});const result=await h.runtime(p.operationId).execute();assert.equal(result.complete,true,JSON.stringify(result));return p;}
async function batch(h,key){const prepared=await h.service.prepareActivityBatch(h.user,choices(key));await h.service.approve(h.user,prepared.operationId,{planHash:prepared.planHash});return h.runtime(prepared.operationId).execute();}
test('cash expenses and supplier credits post exactly, the next period balances, and a changed save is never verified',{timeout:180000},async()=>{
 const h=fixture({activityTemplateVersion:2,openingDate:'2026-11-01'});await h.publish();await calendar(h,'2026-11-30','expense-november-period-001');
 const posts=h.posts,result=await batch(h,'001');
 assert.equal(result.complete,true,JSON.stringify(result));assert.equal(h.posts,posts+2);
 const saved=entity=>[...h.records.values()].filter(row=>row.entity===entity).map(row=>row.record);
 const [purchase]=saved('Purchase'),[credit]=saved('VendorCredit');
 assert.equal(purchase.PaymentType,'Cash');assert.equal(purchase.AccountRef.value,h.mappings.operatingBank);assert.equal(purchase.EntityRef.type,'Vendor');assert.equal(purchase.GlobalTaxCalculation,'TaxExcluded');
 assert.deepEqual(Object.keys(purchase.Line[0].AccountBasedExpenseLineDetail).sort(),['AccountRef','BillableStatus','TaxCodeRef']);
 assert.equal(purchase.Line[0].AccountBasedExpenseLineDetail.AccountRef.value,h.mappings.operatingExpense);assert.equal(purchase.Line[0].AccountBasedExpenseLineDetail.TaxCodeRef.value,h.mappings.purchaseTax);assert.equal(purchase.Line[0].Amount,45);
 assert.equal(credit.APAccountRef.value,h.mappings.accountsPayable);assert.equal(credit.Line[0].AccountBasedExpenseLineDetail.AccountRef.value,h.mappings.operatingExpense);assert.equal(credit.Line[0].Amount,20);assert.equal(credit.Balance,credit.TotalAmt);
 for(const record of [purchase,credit])for(const key of ['CustomerRef','ProcessPayment','DueDate','LinkedTxn'])assert.equal(record[key],undefined,key);
 // The next calendar period reconciles bank, payables and operating expense including both records.
 await calendar(h,'2026-12-01','close-december-first-after-expense');assert.equal(h.data.Calendars[0].verifiedThrough,'2026-12-01');
 // Next business day: QuickBooks saves something other than the request; it is never verified.
 h.clock+=86400000;
 h.afterPost=async(opts,record)=>{if(new URL(opts.url).pathname.endsWith('/purchase')){h.afterPost=null;record.Line[0].AccountBasedExpenseLineDetail.BillableStatus='Billable';}};
 const changed=await batch(h,'002');assert.notEqual(changed.complete,true);assert.equal(h.data.Calendars[0].verifiedThrough,'2026-12-01');
});
