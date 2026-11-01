'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { referenceDefinition, sameCanonicalDefinition, verifyBusinessReference } = require('../src/modules/business-reference');
const { compileBusinessTransactionWithDefinitions } = require('../src/modules/business-transaction-compiler');
const { createBusinessObservationStore } = require('../src/modules/business-observation-store');
const { fixture, scope, now, clone } = require('./helpers/business-transaction-fixtures');
const defaults = { Item: ['DeferredRevenue', 'SalesTaxIncluded', 'PurchaseTaxIncluded', 'TrackQtyOnHand', 'SubItem', 'Taxable', 'PrintGroupedItems'], Customer: ['Job', 'BillWithParent', 'IsProject', 'Taxable'], Vendor: ['Vendor1099', 'T4AEligible', 'T5018Eligible'], TaxCode: ['Hidden', 'Taxable', 'TaxGroup'] };
function record(fields = {}) { return { Id: '55', SyncToken: '0', Active: true, Name: 'Fixture', ...fields }; }
function observation(entity, record) { const recordHash = hash(record); return { scope, entity, record, recordHash, observedAt: new Date(now).toISOString(), source: { version: 1, kind: 'qbo-full-entity-get', scope, entity, id: record.Id, endpoint: entity.toLowerCase() + '/' + record.Id, recordHash } }; }
function retained(entity, record) { const o = observation(entity, record); o.source = { version: 1, kind: 'qbo-retained-mirror', scope, entity, id: record.Id, recordHash: o.recordHash, generation: 'historical', retainedAt: o.observedAt }; return o; }
for (const [entity, fields] of Object.entries(defaults)) test(entity + ' optional flags equate absent/null/false only with authenticated v1/v2 evidence', () => {
 for (const field of fields) for (const left of [undefined, null, false]) for (const right of [undefined, null, false]) for (const version of [1, 2]) {
  const a = record(left === undefined ? {} : { [field]: left }), b = record(right === undefined ? {} : { [field]: right });
  const binding = { key: 'chosen', entity, id: a.Id, syncToken: a.SyncToken, status: 'resolved', definition: referenceDefinition(scope, entity, a, version) }, before = JSON.stringify(binding);
  const observed = observation(entity, b); observed.definitionObservation = retained(entity, a);
  assert.equal(verifyBusinessReference({ scope, binding, observed, now }), b, field); assert.equal(JSON.stringify(binding), before);
  assert.equal(sameCanonicalDefinition(entity, a, { ...b, [field]: true }), false, field);
  for (const malformed of [0, '', 'false', [], {}]) assert.equal(sameCanonicalDefinition(entity, a, { ...b, [field]: malformed }), false, field);
 }
});
test('default compatibility never erases unknown fields, nested values, prices or collections', () => {
 for (const entity of Object.keys(defaults)) for (const field of ['UnknownSetting', 'Description', 'UnitPrice', 'IncomeAccountRef', 'BillAddr', 'SalesTaxRateList']) for (const value of [false, null, '', [], 0, {}]) assert.equal(sameCanonicalDefinition(entity, record(), record({ [field]: value })), false, entity + '.' + field);
 assert.equal(sameCanonicalDefinition('Item', record({ Extension: { DeferredRevenue: null } }), record({ Extension: { DeferredRevenue: false } })), false);
 assert.equal(sameCanonicalDefinition('TaxRate', record(), record({ Hidden: false })), false);
});
test('v2 default drift refuses missing, altered, foreign, future or regressed evidence', () => {
 const approved = record({ DeferredRevenue: null }), binding = { key: 'item', entity: 'Item', id: '55', syncToken: '2', status: 'resolved', definition: referenceDefinition(scope, 'Item', approved, 2) };
 for (const change of [o => { delete o.definitionObservation; }, o => { o.definitionObservation.recordHash = hash('tamper'); }, o => { o.definitionObservation.scope = { ...scope, realmId: '999' }; }, o => { o.definitionObservation.record.UnitPrice = 1; o.definitionObservation = retained('Item', o.definitionObservation.record); }, o => { o.definitionObservation.observedAt = new Date(now + 1).toISOString(); o.definitionObservation.source.retainedAt = o.definitionObservation.observedAt; }, o => { o.record.SyncToken = '1'; const next = observation('Item', o.record); Object.assign(o, next); }]) {
  const observed = observation('Item', record({ SyncToken: '2', DeferredRevenue: false })); observed.definitionObservation = retained('Item', approved); change(observed); assert.throws(() => verifyBusinessReference({ scope, binding, observed, now }), { code: 'BUSINESS_REFERENCE_UNVERIFIED' });
 }
});
test('runtime compiler resolves v2 Item and v1 Customer default drift without rewriting approved hashes', async () => {
 const f = fixture('Estimate'), witnesses = new Map();
 for (const entity of ['Item', 'Customer']) {
  const observed = f.referenceEvidence.find(row => row.entity === entity), field = entity === 'Item' ? 'DeferredRevenue' : 'IsProject';
  observed.record[field] = null; const binding = f.step.references.find(row => row.entity === entity); binding.definition = referenceDefinition(scope, entity, observed.record); witnesses.set(entity, retained(entity, clone(observed.record))); observed.record[field] = false;
 }
 f.refresh(); f.approve(); const before = JSON.stringify(f), calls = [];
 const compiled = await compileBusinessTransactionWithDefinitions(f, { resolveDefinitionObservation: async (s, entity) => { calls.push(entity); return witnesses.get(entity); } });
 assert.equal(compiled.entity, 'Estimate'); assert.deepEqual(calls.sort(), ['Customer', 'Item']); assert.equal(JSON.stringify(f), before);
});
test('retained company witness reader supports customer/vendor without calling a provider or writing', async () => {
 for (const entity of ['Customer', 'Vendor', 'Item', 'TaxCode']) {
  const row = { ...scope, entity, qboId: '55', deleted: false, record: record(), generation: 'original', lastObservedAt: new Date(now - 86400000) };
  const Records = { findOne: filter => { assert.equal(filter.entity, entity); return { maxTimeMS: () => ({ lean: async () => row }) }; } };
  const store = createBusinessObservationStore({ Records, now: () => now }); const witness = await store.definition(scope, entity, '55'); assert.equal(witness.source.kind, 'qbo-retained-mirror'); assert.equal(witness.recordHash, hash(row.record));
 }
});
test('added-role witness comparisons accept default-only changes under either retained hash version', async () => {
 const roles = require('../src/modules/business-added-roles');
 for (const [entity, kind, field] of [['Item', 'item', 'DeferredRevenue'], ['Customer', 'customer', 'IsProject'], ['Vendor', 'supplier', 'T4AEligible']]) for (const version of [1, 2]) {
  const approved = record({ [field]: null, SyncToken: '9' }), observed = { ...approved, [field]: false }, key = 'added-' + kind + '-0123456789ab';
  const role = { key, kind, entity, id: '55', name: 'Fixture', definitionHash: referenceDefinition(scope, entity, approved, version).hash, ...(entity === 'Item' ? { incomeRole: 'careIncome', unit: 'month' } : {}) };
  const activity = entity === 'Item' ? { itemKey: key, incomeRole: 'careIncome', unit: 'month' } : entity === 'Customer' ? { customerKey: key } : { vendorKey: key };
  const input = { scope, registry: { roles: [role], unusable: [] }, batch: { activities: [activity] }, now: () => now, readRecord: async () => observed, readDefinitionWitness: async () => retained(entity, approved) };
  assert.equal((await roles.resolveBatchRoles(input))[0].id, '55'); observed.SyncToken = '8'; await assert.rejects(roles.resolveBatchRoles(input), /changed in QuickBooks/); observed.SyncToken = '9'; observed[field] = true; await assert.rejects(roles.resolveBatchRoles(input), /changed in QuickBooks/);
 }
});
test('tax source verifier accepts known default-only flags and rejects real tax differences', async () => {
 const { verifyBusinessTaxSources } = require('../src/modules/business-tax-policy');
 for (const field of defaults.TaxCode) {
  const approved = record({ [field]: null }), live = { ...approved, [field]: false }, policy = { taxSources: [{ entity: 'TaxCode', id: '55', record: approved, recordHash: hash(approved) }] };
  const client = { read: async () => ({ TaxCode: live }) }; await verifyBusinessTaxSources(policy, client); live[field] = true; await assert.rejects(verifyBusinessTaxSources(policy, client), /changed after/);
 }
});
