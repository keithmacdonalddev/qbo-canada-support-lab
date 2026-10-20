import test from 'node:test'
import assert from 'node:assert/strict'
import { featureGroup, featureName, featureRecordType, featureState, filterFeatureAreas } from './coverage-features.mjs'

test('older transaction data remains feature coverage', () => {
  const billable = { key: 'billable-expenses', kind: 'activity', status: 'stale', count: 2, last: '2026-01-30' }
  assert.equal(featureState(billable), 'available')
  assert.equal(featureGroup(billable), 'available')
})
test('a missed volume target preserves existing feature data', () => {
  const customers = { key: 'active-customers', kind: 'setup', status: 'missing', count: 4, min: 10 }
  assert.equal(featureName(customers), 'Customers')
  assert.equal(featureState(customers), 'limited')
  assert.equal(featureGroup(customers), 'available')
  assert.equal(featureState({ ...customers, count: 0 }), 'missing')
})
test('failed and manual reads cannot be described as missing functionality', () => {
  assert.equal(featureState({ status: 'error', count: 0 }), 'unverified')
  assert.equal(featureState({ status: 'manual' }), 'manual')
  assert.equal(featureGroup({ status: 'error' }), 'verification')
  assert.equal(featureState({ status: 'stale', count: 0 }), 'unverified')
  assert.equal(featureState({ status: 'unexpected' }), 'unverified')
})
test('one province or one dimension does not establish multi-province or multi-dimension coverage', () => {
  for (const key of ['customer-provinces', 'classes', 'locations']) {
    const signal = { key, kind: 'setup', status: 'missing', count: 1, min: 2 }
    assert.equal(featureState(signal), 'incomplete')
    assert.equal(featureGroup(signal), 'missing')
  }
})
test('absent prerequisites remain setup dependencies', () => {
  assert.equal(featureState({ status: 'missing', blockedBy: 'Enable multicurrency' }), 'blocked')
  assert.equal(featureGroup({ status: 'missing', blockedBy: 'Enable multicurrency' }), 'verification')
})
test('search and filters retain named features without changing source results', () => {
  const areas = [{ key: 'sales', name: 'Sales and receivables', domain: 'sales', signals: [
    { key: 'invoices', label: 'Invoices', status: 'ok' },
    { key: 'refund-receipts', label: 'Refund receipts', status: 'missing' },
  ] }, { key: 'bank', name: 'Banking', domain: 'banking', signals: [{ key: 'reconciled', label: 'Reconciliation', status: 'manual' }] }]
  const original = structuredClone(areas)
  assert.deepEqual(filterFeatureAreas(areas, { query: 'refund' })[0].signals.map(s => s.key), ['refund-receipts'])
  assert.equal(filterFeatureAreas(areas, { query: 'sales' })[0].signals.length, 2)
  assert.equal(filterFeatureAreas(areas, { view: 'verification' })[0].key, 'bank')
  assert.equal(filterFeatureAreas(areas, { domain: 'sales', view: 'missing' })[0].signals[0].key, 'refund-receipts')
  assert.deepEqual(filterFeatureAreas(areas, { query: 'not a feature' }), [])
  assert.deepEqual(areas, original)
})
test('record links use known entity types and leave unsupported types unlinked', () => {
  assert.equal(featureRecordType({ key: 'partly-paid-bills' }), 'Bill')
  assert.equal(featureRecordType({ key: 'po-to-bill' }), 'Bill')
  assert.equal(featureRecordType({ key: 'bill-payments' }), 'BillPayment')
  assert.equal(featureRecordType({ key: 'bank-reconciled' }), null)
})
