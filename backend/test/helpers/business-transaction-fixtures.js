'use strict';
const { compileBusinessTransaction } = require('../../src/modules/business-transaction-compiler');
const { bindBusinessReference } = require('../../src/modules/business-reference');
const { hash } = require('../../src/modules/business-calendar');
const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
const now = Date.parse('2026-10-06T12:00:00.000Z');
const clone = value => structuredClone(value);
function referenceObservation(entity, record) {
  const recordHash = hash(record);
  return { scope, entity, record, recordHash, observedAt: new Date(now).toISOString(), source: { version: 1, kind: 'qbo-full-entity-get', scope, entity, id: record.Id, endpoint: entity.toLowerCase() + '/' + record.Id, recordHash } };
}
function fixture(entity = 'Invoice') {
  const records = [
    ['Customer', 'client', { Id: '10', CurrencyRef: { value: 'CAD' } }], ['Vendor', 'supplier', { Id: '20', CurrencyRef: { value: 'CAD' } }], ['Employee', 'worker', { Id: '30' }],
    ['Account', 'operatingBank', { Id: '600', AccountType: 'Bank', CurrencyRef: { value: 'CAD' } }],
    ['Account', 'accountsReceivable', { Id: '601', AccountType: 'Accounts Receivable', AccountSubType: 'AccountsReceivable', CurrencyRef: { value: 'CAD' } }],
    ['Account', 'accountsPayable', { Id: '602', AccountType: 'Accounts Payable', AccountSubType: 'AccountsPayable', CurrencyRef: { value: 'CAD' } }],
    ['Account', 'undepositedFunds', { Id: '603', AccountType: 'Other Current Asset', AccountSubType: 'UndepositedFunds' }],
    ['Account', 'serviceIncome', { Id: '604', AccountType: 'Income' }], ['Account', 'supplyIncome', { Id: '605', AccountType: 'Income' }],
    ['Account', 'inventoryAsset', { Id: '606', AccountType: 'Other Current Asset', AccountSubType: 'Inventory' }], ['Account', 'costOfGoods', { Id: '607', AccountType: 'Cost of Goods Sold' }],
    ['TaxCode', 'salesTax', { Id: '900' }], ['TaxCode', 'purchaseTax', { Id: '901' }],
    ['Item', 'field-service-hour', { Id: '100', Type: 'Service', IncomeAccountRef: { value: '604' } }],
    ['Item', 'stock', { Id: '101', Type: 'Inventory', IncomeAccountRef: { value: '605' }, AssetAccountRef: { value: '606' }, ExpenseAccountRef: { value: '607' }, QtyOnHand: 12 }],
  ].map(([entity, key, record]) => ({ entity, key, record: { ...record, Active: true, SyncToken: '0' } }));
  const itemLine = (purchase, sale = false) => { const kind = purchase ? 'ItemBasedExpenseLineDetail' : 'SalesItemLineDetail'; return { Id: '1', DetailType: kind, Amount: purchase ? 246 : sale ? 492 : 250, [kind]: { ItemRef: { value: purchase || sale ? '101' : '100' }, Qty: purchase || sale ? 12 : 2, UnitPrice: purchase ? 20.5 : sale ? 41 : 125, TaxCodeRef: { value: purchase ? '901' : '900' } } }; };
  const parentRecords = {
    Estimate: { Id: '1000', TxnStatus: 'Accepted', CustomerRef: { value: '10' }, GlobalTaxCalculation: 'TaxExcluded', Line: [itemLine(false)], TotalAmt: 282.5 },
    TimeActivity: { Id: '1001', CustomerRef: { value: '10' }, ItemRef: { value: '100' }, EmployeeRef: { value: '30' }, Hours: 2, Minutes: 0, BillableStatus: 'Billable' },
    PurchaseOrder: { Id: '1002', VendorRef: { value: '20' }, GlobalTaxCalculation: 'TaxExcluded', POStatus: 'Open', Line: [{ ...itemLine(true), Received: 0 }], TotalAmt: 277.98 },
    Invoice: { Id: '1003', CustomerRef: { value: '10' }, ARAccountRef: { value: '601' }, TotalAmt: 282.5, Balance: 282.5 },
    Bill: { Id: '1004', VendorRef: { value: '20' }, APAccountRef: { value: '602' }, TotalAmt: 277.98, Balance: 277.98, Line: [itemLine(true)] },
    Payment: { Id: '1005', CustomerRef: { value: '10' }, DepositToAccountRef: { value: '603' }, TotalAmt: 282.5, UnappliedAmt: 0 },
  };
  const kinds = { Estimate: [], TimeActivity: ['Estimate'], Invoice: ['Estimate', 'TimeActivity'], Payment: ['Invoice'], Deposit: ['Payment'], PurchaseOrder: [], Bill: ['PurchaseOrder'], SalesReceipt: ['Bill'], BillPayment: ['Bill'] }[entity];
  const parents = kinds.map(type => { const record = { ...parentRecords[type], TxnDate: '2026-10-05', CurrencyRef: { value: 'CAD' }, SyncToken: '0' }; return { scope, logicalKey: hash(type), entity: type, qboId: record.Id, syncToken: record.SyncToken, state: 'verified', fingerprint: hash('intent ' + type), observedAt: new Date(now).toISOString(), recordHash: hash(record), record }; });
  const purchase = ['PurchaseOrder', 'Bill'].includes(entity), stock = purchase || entity === 'SalesReceipt', settlement = ['Payment', 'Deposit', 'BillPayment'].includes(entity);
  const details = { version: 1, currency: 'CAD', policyStatus: 'proposed', references: parents.map(value => ({ logicalKey: value.logicalKey, entity: value.entity })), lines: [], baseAmountCents: null };
  if (entity === 'TimeActivity') Object.assign(details, { customerKey: 'client', workerKey: 'worker', itemKey: 'field-service-hour', hours: 2, billable: true, amountRule: 'time_only' });
  else if (settlement) Object.assign(details, { ...(entity === 'BillPayment' ? { vendorKey: 'supplier', fundingSource: 'operating_bank' } : { customerKey: 'client', destination: entity === 'Payment' ? 'undeposited_funds' : 'operating_bank' }), bankMapping: 'operatingBank', amountRule: 'saved_originating_total', amountSourceKey: parents[0].logicalKey });
  else Object.assign(details, { ...(purchase ? { vendorKey: 'supplier' } : { customerKey: 'client' }), ...(entity === 'SalesReceipt' ? { bankMapping: 'operatingBank' } : {}), amountRule: 'lines_before_tax', taxMapping: purchase ? 'purchaseTax' : 'salesTax', baseAmountCents: purchase ? 24600 : stock ? 49200 : 25000, lines: [{ key: 'primary', itemKey: stock ? 'stock' : 'field-service-hour', quantity: stock ? 12 : 2, unitPriceCents: purchase ? 2050 : stock ? 4100 : 12500, amountCents: purchase ? 24600 : stock ? 49200 : 25000, accountMapping: purchase ? 'inventoryAsset' : stock ? 'supplyIncome' : 'serviceIncome' }] });
  const step = { logicalKey: hash('new ' + entity), entity, txnDate: '2026-10-06', calendarFingerprint: hash('calendar'), details,
    references: records.map(value => bindBusinessReference({ scope, entity: value.entity, key: value.key, observed: referenceObservation(value.entity, value.record), now })), dependencies: parents.map(value => ({ logicalKey: value.logicalKey, entity: value.entity, fingerprint: value.fingerprint })) };
  const f = { scope, step, parents, now, referenceEvidence: records.map(value => referenceObservation(value.entity, value.record)), policy: { version: 1, scope, status: 'approved', country: 'CA', currency: 'CAD', fromDate: '2026-10-01', throughDate: '2026-10-06', evidenceHash: hash('policy approval'), tax: { calculation: 'TaxExcluded', salesTax: '900', purchaseTax: '901' } } };
  f.observationFence = { scope, operationId: 'b'.repeat(24), writerRevision: 4, observedAt: new Date(now).toISOString() };
  for (const value of [...f.parents, ...f.referenceEvidence]) { value.operationId = f.observationFence.operationId; value.writerRevision = 4; }
  if (entity === 'Deposit') f.parents[0].availability = { scope, observedAt: new Date(now).toISOString(), kind: 'undeposited_payment', status: 'available', operationId: f.observationFence.operationId, writerRevision: 4, recordHash: f.parents[0].recordHash, evidenceHash: hash('current deposit availability') };
  f.approve = () => { step.detailsHash = hash({ calendarFingerprint: step.calendarFingerprint, details }); f.policy.stepHash = hash(step); };
  f.refresh = () => { for (const value of [...f.parents, ...f.referenceEvidence]) { value.recordHash = hash(value.record); if (value.source) value.source.recordHash = value.recordHash; if (value.availability) value.availability.recordHash = value.recordHash; } };
  f.compile = () => compileBusinessTransaction(f); f.approve(); return f;
}

module.exports = { fixture, scope, now, clone };
