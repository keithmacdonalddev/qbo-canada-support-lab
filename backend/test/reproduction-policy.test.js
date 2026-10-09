'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSavedRecord, checkWrite, conditionResults, classifyOutcome, measurementKey } = require('../src/modules/reproduction-policy');
const owned = [{ entityType: 'Bill', id: '10' }, { entityType: 'Vendor', id: '20' }];
const metadata = { CreateTime: '2026-10-05T12:00:00Z', LastUpdatedTime: '2026-10-05T12:01:00Z', LastModifiedByRef: { value: 'system-user' } };

test('saved root metadata does not block a case bill but outgoing metadata stays refused', () => {
  const record = { Id: '10', SyncToken: '2', VendorRef: { value: '20' }, MetaData: metadata };
  const body = checkSavedRecord(record, owned, 'Bill');
  assert.equal(body.SyncToken, '2');
  assert.equal(body.MetaData, undefined);
  assert.deepEqual(record.MetaData, metadata, 'original readback remains intact');
  assert.throws(() => checkWrite('updateRecord', { entityType: 'Bill', id: '10', changes: { MetaData: metadata } }, owned), /read-only/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Bill', record: { MetaData: {} } }, owned), /read-only/);
});

test('metadata exception cannot exempt accounting relationships or nested metadata lookalikes', () => {
  assert.throws(() => checkSavedRecord({ MetaData: metadata, VendorRef: { value: '999' } }, owned, 'Bill'), /Counterparty/);
  assert.throws(() => checkSavedRecord({ MetaData: metadata, Line: [{ LinkedTxn: [{ TxnId: '999', TxnType: 'PurchaseOrder' }] }] }, owned, 'Bill'), /Transaction links/);
  assert.throws(() => checkSavedRecord({ Line: [{ MetaData: { LastModifiedByRef: { value: '999' } } }] }, owned, 'Bill'), /Unsupported relationship/);
  assert.throws(() => checkSavedRecord({ LastModifiedByRef: { value: '999' } }, owned, 'Bill'), /Unsupported relationship/);
});

function check(path, expected, actual, revision = 7) {
  return { label: '3.5 hours with PO link retained', sources: [{ entityType: 'Bill', id: '10', path }],
    expected, actual, aggregate: 'single', operator: 'equal', available: true, passed: expected === actual, revision };
}
const label = '3.5 hours with PO link retained';
const qty = 'Line.0.ItemBasedExpenseLineDetail.Qty';
const link = 'Line.0.LinkedTxn.0.TxnLineId';

test('matching line ID cannot overwrite the failed quantity comparison', () => {
  const checks = [check(qty, 3.5, 5), check(link, '1', '1')];
  const result = conditionResults([label], checks, 7)[0];
  assert.equal(result.checks.length, 2);
  assert.equal(result.passed, false);
  assert.equal(classifyOutcome('completed', [label], checks, 7), 'unverified');
  // Symptom outcomes trust the model's direction once evidence is complete.
  assert.equal(classifyOutcome('reproduced', [label], checks, 7), 'reproduced');
  assert.equal(classifyOutcome('not_reproduced', [label], checks, 7), 'not_reproduced');
});

test('changing expected quantity cannot erase a prior failing target', () => {
  const checks = [check(qty, 3.5, 5), check(qty, 5, 5)];
  assert.equal(conditionResults([label], checks, 7)[0].passed, false);
});

test('an older passing reading is superseded by current passing readings; an older failure still blocks', () => {
  const checks = [check(qty, 3.5, 3.5, 7), check(link, '1', '1', 8)];
  const result = conditionResults([label], checks, 8)[0];
  assert.equal(result.available, true); assert.equal(result.passed, true);
  assert.equal(result.checks.find((c) => c.revision === 7).superseded, true);
  assert.equal(classifyOutcome('completed', [label], checks, 8), 'completed');
  const failedEarlier = [check(qty, 3.5, 5, 7), check(link, '1', '1', 8)];
  assert.equal(conditionResults([label], failedEarlier, 8)[0].available, false);
  assert.equal(classifyOutcome('completed', [label], failedEarlier, 8), 'unverified');
  failedEarlier.push(check(qty, 3.5, 3.5, 8));
  assert.equal(classifyOutcome('completed', [label], failedEarlier, 8), 'completed');
  // Without any current reading nothing supersedes the old one.
  assert.equal(classifyOutcome('completed', [label], [check(qty, 3.5, 3.5, 7)], 8), 'unverified');
});

test('a historical reading keeps counting after later changes', () => {
  const before = { ...check('Balance', 100, 100, 3), historical: true };
  assert.equal(classifyOutcome('completed', [label], [before], 9), 'completed');
  assert.notEqual(measurementKey(before), measurementKey({ ...before, historical: undefined }));
  assert.equal(classifyOutcome('completed', [label], [{ ...before, actual: 90, passed: false }], 9), 'unverified');
  assert.equal(classifyOutcome('not_reproduced', [label], [{ ...before, actual: 90, passed: false }], 9), 'not_reproduced');
});

test('public case results correct historical last-check-wins claims without changing stored data', () => {
  const { publicState } = require('../src/modules/reproduction-runner');
  const saved = { _id: 'fixture', reproduction: { status: 'completed', outcome: 'completed', summary: 'Old result',
    conditions: [label], revision: 7, checks: [check(qty, 3.5, 5), check(link, '1', '1')] } };
  const view = publicState(saved);
  assert.equal(view.reproduction.outcome, 'unverified');
  assert.equal(view.reproduction.conditionResults[0].passed, false);
  assert.equal(view.reproduction.conditionResults[0].checks.length, 2);
  assert.equal(saved.reproduction.outcome, 'completed');
  assert.equal(saved.reproduction.conditionResults, undefined);
});

test('public case results keep a pending question and verify a completed build', () => {
  const { publicState } = require('../src/modules/reproduction-runner');
  const waiting = publicState({ _id: 'fixture', reproduction: { status: 'completed', outcome: 'needs_input', summary: 'Which account?',
    awaitingOperator: { question: 'Which account?', options: [] }, conditions: [], checks: [], revision: 0 } });
  assert.equal(waiting.reproduction.outcome, 'needs_input');
  assert.equal(waiting.reproduction.summary, 'Which account?');
  const built = { status: 'completed', outcome: 'completed', summary: 'Built', conditions: [label], revision: 7, checks: [check(qty, 3.5, 3.5)] };
  assert.equal(publicState({ _id: 'fixture', reproduction: built }).reproduction.outcome, 'completed');
  const stale = publicState({ _id: 'fixture', reproduction: { ...built, revision: 8 } }).reproduction;
  assert.equal(stale.outcome, 'unverified');
  assert.match(stale.summary, /not supported/);
});

const { writeFailureIsDefinite, findReportCell, reportNumber } = require('../src/modules/reproduction-policy');
const caseParties = [{ entityType: 'Customer', id: '30' }, { entityType: 'Vendor', id: '20' }, { entityType: 'Invoice', id: '40' }];

test('journal entry entities take their type from the line Entity and must belong to the case', () => {
  const line = (type, id, entityRef = { value: id }) => ({ DetailType: 'JournalEntryLineDetail', Amount: 10,
    JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '1' }, Entity: { Type: type, EntityRef: entityRef } } });
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'JournalEntry', record: { Line: [line('Vendor', '20'), line('Customer', '30')] } }, caseParties));
  assert.throws(() => checkWrite('createRecord', { entityType: 'JournalEntry', record: { Line: [line('Vendor', '999')] } }, caseParties), /belong to this case/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'JournalEntry', record: { Line: [line(undefined, '20')] } }, caseParties), /include EntityRef\.type/);
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'Purchase', record: { EntityRef: { value: '20', type: 'Vendor' } } }, caseParties));
  assert.throws(() => checkWrite('createRecord', { entityType: 'Purchase', record: { EntityRef: { value: '20' } } }, caseParties), /include EntityRef\.type/);
  const saved = { Id: '50', SyncToken: '0', MetaData: metadata, Line: [{ ...line('Vendor', '20', { value: '20', name: 'REPRO vendor' }), Id: '0' }] };
  assert.doesNotThrow(() => checkSavedRecord(saved, caseParties, 'JournalEntry'));
});

test('a saved Canadian invoice with server-populated tax and account references passes', () => {
  const invoice = {
    Id: '40', SyncToken: '1', MetaData: metadata, DocNumber: '1001', TxnDate: '2026-04-21',
    CurrencyRef: { value: 'CAD', name: 'Canadian Dollar' }, CustomerRef: { value: '30', name: 'REPRO customer' },
    SalesTermRef: { value: '3' }, DepositToAccountRef: { value: '4' }, LinkedTxn: [], GlobalTaxCalculation: 'TaxExcluded',
    Line: [
      { Id: '1', LineNum: 1, Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {
        ItemRef: { value: '5', name: 'Services' }, UnitPrice: 100, Qty: 1, ItemAccountRef: { value: '79', name: 'Services' },
        TaxCodeRef: { value: '7' }, TaxClassificationRef: { value: 'EUC-99990101' } } },
      { Amount: 100, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
    ],
    TxnTaxDetail: { TxnTaxCodeRef: { value: '7' }, TotalTax: 13, TaxLine: [{ Amount: 13, DetailType: 'TaxLineDetail',
      TaxLineDetail: { TaxRateRef: { value: '12' }, PercentBased: true, TaxPercent: 13, NetAmountTaxable: 100 } }] },
    TotalAmt: 113, Balance: 113,
  };
  assert.doesNotThrow(() => checkSavedRecord(invoice, caseParties, 'Invoice'));
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'Invoice', record: { CustomerRef: { value: '30' }, ShipMethodRef: { value: 'UPS' },
    SalesTermRef: { value: '3' }, Line: invoice.Line, TxnTaxDetail: invoice.TxnTaxDetail } }, caseParties));
});

test('list references may be existing records; party, project and transaction references may not', () => {
  const create = (record, entityType = 'Invoice') => checkWrite('createRecord', { entityType, record }, caseParties);
  for (const record of [{ TermRef: { value: '1' } }, { DefaultTaxCodeRef: { value: '1' } }, { CustomerTypeRef: { value: '1' } },
    { DiscountAccountRef: { value: '1' } }, { PriceLevelRef: { value: '1' } }, { RecurDataRef: { value: '1' } }]) {
    assert.doesNotThrow(() => create(record), JSON.stringify(record));
  }
  assert.throws(() => create({ ProjectRef: { value: '999' } }), /Counterparty/);
  assert.doesNotThrow(() => create({ ProjectRef: { value: '30' } }));
  assert.throws(() => create({ PrefVendorRef: { value: '999' } }, 'Item'), /Counterparty/);
  for (const key of ['SalesRepRef', 'PayeeRef', 'ReimburseChargeRef', 'InvoiceRef', 'CreatedByRef']) {
    assert.throws(() => create({ [key]: { value: '999' } }), /Unsupported relationship/, key);
  }
});

test('shared lists can use existing parents; customers cannot', () => {
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'Account', record: { Name: 'Owner Distributions', SubAccount: true, ParentRef: { value: '35' } } }, caseParties));
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'Class', record: { Name: 'REPRO', ParentRef: { value: '2' } } }, caseParties));
  assert.throws(() => checkWrite('createRecord', { entityType: 'Customer', record: { DisplayName: 'Job', ParentRef: { value: '999' } } }, caseParties), /Parent records/);
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'Customer', record: { DisplayName: 'Job', ParentRef: { value: '30' } } }, caseParties));
});

test('only failures that cannot have reached QuickBooks are definite', () => {
  assert.equal(writeFailureIsDefinite(new Error('x'), false), true);
  for (const stage of ['refresh', 'refresh_response', 'storage_read', 'storage_save', 'conflict', 'write_admission']) {
    assert.equal(writeFailureIsDefinite({ qboStage: stage }, true), true, stage);
  }
  assert.equal(writeFailureIsDefinite({ qboStage: 'api', status: 400 }, true), true);
  assert.equal(writeFailureIsDefinite({ qboStage: 'api', status: 502 }, true), false);
  assert.equal(writeFailureIsDefinite({ qboStage: 'api' }, true), false);
  assert.equal(writeFailureIsDefinite({ qboStage: 'write_receipt', status: 503, outcomeUnknown: true }, true), false);
  assert.equal(writeFailureIsDefinite({ qboStage: 'api', status: 400, outcomeUnknown: true }, true), false);
});

test('report cells are located by row, section and column, and numbers parse report formatting', () => {
  const report = { Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Apr 2026' }, { ColTitle: 'Total' }] }, Rows: { Row: [
    { Header: { ColData: [{ value: 'Expenses' }, { value: '' }, { value: '' }] }, Rows: { Row: [
      { ColData: [{ value: 'Rent' }, { value: '1,200.00' }, { value: '2,400.00' }] },
    ] }, Summary: { ColData: [{ value: 'Total Expenses' }, { value: '1,200.00' }, { value: '2,400.00' }] } },
  ] } };
  assert.deepEqual(findReportCell(report, { row: 'Rent' }), { available: true, text: '2,400.00', column: 'Total' });
  assert.equal(findReportCell(report, { row: ' rent ', column: 'apr 2026' }).text, '1,200.00');
  assert.equal(findReportCell(report, { row: 'Rent', section: 'Income' }).available, false);
  assert.equal(findReportCell(report, { row: 'Expenses' }).available, false, 'an empty section heading is not a value');
  assert.equal(reportNumber('$40,000.00'), 40000);
  assert.equal(reportNumber('(12.50)'), -12.5);
  assert.equal(reportNumber('-3'), -3);
  assert.equal(reportNumber(''), null);
  assert.equal(reportNumber('n/a'), null);
});

test('deposit line entities, employees and conflicting entity types cannot reach existing parties', () => {
  const owned = [{ entityType: 'Customer', id: '30' }, { entityType: 'Employee', id: '60' }];
  const deposit = (entity) => ({ DepositToAccountRef: { value: '4' }, Line: [{ Amount: 50, DetailType: 'DepositLineDetail',
    DepositLineDetail: { AccountRef: { value: '79' }, Entity: entity } }] });
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'Deposit', record: deposit({ value: '30', type: 'Customer' }) }, owned));
  assert.throws(() => checkWrite('createRecord', { entityType: 'Deposit', record: deposit({ value: '999', type: 'Customer' }) }, owned), /belong to this case/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'Deposit', record: deposit({ value: '30' }) }, owned), /include Entity\.type/);
  assert.throws(() => checkSavedRecord({ Id: '70', MetaData: metadata, ...deposit({ value: '999', type: 'Vendor', name: 'Real vendor' }) }, owned, 'Deposit'), /belong to this case/);
  assert.throws(() => checkWrite('createRecord', { entityType: 'TimeActivity', record: { EmployeeRef: { value: '999' }, Hours: 2 } }, owned), /Counterparty/);
  assert.doesNotThrow(() => checkWrite('createRecord', { entityType: 'TimeActivity', record: { EmployeeRef: { value: '60' }, Hours: 2 } }, owned));
  assert.throws(() => checkWrite('createRecord', { entityType: 'JournalEntry', record: { Line: [{ JournalEntryLineDetail: {
    Entity: { Type: 'Vendor', EntityRef: { value: '30', type: 'Customer' } } } }] } }, owned), /disagree/);
});
