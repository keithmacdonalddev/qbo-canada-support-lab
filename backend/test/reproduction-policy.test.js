'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkSavedRecord, checkWrite, conditionResults, classifyOutcome } = require('../src/modules/reproduction-policy');
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
  assert.equal(classifyOutcome('reproduced', [label], checks, 7), 'unverified');
  assert.equal(classifyOutcome('not_reproduced', [label], checks, 7), 'not_reproduced');
});

test('changing expected quantity cannot erase a prior failing target', () => {
  const checks = [check(qty, 3.5, 5), check(qty, 5, 5)];
  assert.equal(conditionResults([label], checks, 7)[0].passed, false);
});

test('every established measurement needs a current read after a write', () => {
  const checks = [check(qty, 3.5, 3.5, 7), check(link, '1', '1', 8)];
  assert.equal(conditionResults([label], checks, 8)[0].available, false);
  assert.equal(classifyOutcome('reproduced', [label], checks, 8), 'unverified');
  checks.push(check(qty, 3.5, 3.5, 8));
  assert.equal(classifyOutcome('reproduced', [label], checks, 8), 'reproduced');
});

test('public case results correct historical last-check-wins claims without changing stored data', () => {
  const { publicState } = require('../src/modules/reproduction-runner');
  const saved = { _id: 'fixture', reproduction: { status: 'completed', outcome: 'reproduced', summary: 'Old result',
    conditions: [label], revision: 7, checks: [check(qty, 3.5, 5), check(link, '1', '1')] } };
  const view = publicState(saved);
  assert.equal(view.reproduction.outcome, 'unverified');
  assert.equal(view.reproduction.conditionResults[0].passed, false);
  assert.equal(view.reproduction.conditionResults[0].checks.length, 2);
  assert.equal(saved.reproduction.outcome, 'reproduced');
  assert.equal(saved.reproduction.conditionResults, undefined);
});
