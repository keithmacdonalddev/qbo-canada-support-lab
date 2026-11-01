'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { settlementEvidence } = require('../src/modules/general-write-day-close');
const { explainedByOwnSettlements } = require('../src/modules/general-write-close');
const key = 'BillPayment:900', target = 'Bill:700';
const bill = { Id:'700', SyncToken:'0', TotalAmt:115, Balance:115, VendorRef:{value:'3'} };
const paid = { ...bill, SyncToken:'1', Balance:0, LinkedTxn:[{TxnType:'BillPayment',TxnId:'900'}] };
const payment = { Id:'900', SyncToken:'0', TotalAmt:115, VendorRef:{value:'3'}, Line:[{Amount:115, LinkedTxn:[{TxnType:'Bill',TxnId:'700'}]}] };
function explains(record) {
  const evidence = settlementEvidence({ ownSettlements:[{key,targets:[target]}], settlementVersions:[{key,current:record}] });
  return explainedByOwnSettlements(bill, paid, new Map(evidence.map(row=>[row.key,row])), 'Bill');
}
test('target metadata alone cannot explain a bill; exact current supplier payment body can', () => {
  assert.equal(explains(null), false);
  assert.equal(explains(payment), true);
});
test('retained target metadata cannot authorize wrong settlement type or inconsistent current payment totals', () => {
  assert.equal(explains({...payment,TotalAmt:100}), false);
  assert.equal(explains({...payment,UnappliedAmt:1}), false);
  assert.equal(explains({...payment,Line:[{Amount:115,LinkedTxn:[{TxnType:'Invoice',TxnId:'700'}]}]}), false);
});
