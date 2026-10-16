'use strict';
process.env.QBO_ENVIRONMENT='production';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/business-stock-fixture');
test('independent simulated SDK ledger uses unequal-cost FIFO and partial-layer consumption without importing the app calculator',{timeout:120000},async t=>{
 const h=await fixture(t),stock=[...h.records.values()].find(row=>row.entity==='Item'&&row.record.Type==='Inventory').record,item={value:stock.Id},tax={value:h.mappings.purchaseTax};
 // Drive only the explicitly intercepted synthetic SDK ledger. This is not an
 // app-admission test, a real endpoint call or authority to bypass the write gate.
 const post=async(entity,TxnDate,Qty,UnitPrice)=>{
  const purchase=entity==='Bill',detailType=purchase?'ItemBasedExpenseLineDetail':'SalesItemLineDetail',payload={TxnDate,CurrencyRef:{value:'CAD'},GlobalTaxCalculation:'TaxExcluded',Line:[{Amount:Qty*UnitPrice,DetailType:detailType,[detailType]:{ItemRef:item,Qty,UnitPrice,TaxCodeRef:tax}}],...(purchase?{APAccountRef:{value:h.mappings.accountsPayable}}:{DepositToAccountRef:{value:h.mappings.operatingBank}})};
  const result=await h.client.oauthClient.makeApiCall({url:h.client.apiBase+'/'+entity.toLowerCase(),method:'POST',body:JSON.stringify(payload)});return result.json[entity].Id;
 };
 await post('Bill','2026-10-01',20,6);await post('Bill','2026-10-02',30,7);const a=await post('SalesReceipt','2026-10-03',15,10),b=await post('SalesReceipt','2026-10-04',20,10);
 assert.equal(h.saleCosts.get(a),90);assert.equal(h.saleCosts.get(b),135);assert.deepEqual(h.stockLayers.get(stock.Id),[{date:'2026-10-02',quantity:15,cents:700}]);assert.equal(stock.QtyOnHand,15);assert.equal(h.posts,4);assert.equal(h.data.Receipts.filter(row=>row.kind==='business').length,0);
});
