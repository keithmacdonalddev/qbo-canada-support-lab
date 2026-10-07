'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { masterRequirements, validateMasterBindings, readBusinessMasters, inspectBusinessMasters } = require('../src/modules/business-master-data');
const { proposalView, validateDraftInput, buildDraftDefinition, draftView } = require('../src/modules/blueprint-draft');
const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) };
const proposal = proposalView();
function fixture() {
  const view = { ...scope, proposal, draft: { ...structuredClone(proposal), contentHash: 'b'.repeat(64), connectionMatches: true, masterBindings: { 'field-client-001': '7' } } };
  const observed = { ...scope, completeness: { Customer: true, Vendor: true, Item: true, Employee: true }, options: { Customer: [{ id: '7', name: 'Fixture', active: true, currency: 'CAD', project: false, accountRefs: {} }], Vendor: [], Item: [], Employee: [] } };
  return { view, observed, inspect() { return inspectBusinessMasters(view, observed); } };
}
test('shared customers keep development at its approved population target and stable identities across scale', () => {
  const small = masterRequirements({ ...proposal.business, volumeProfile: 'development' }), full = masterRequirements(proposal.business);
  assert.equal(small.filter(row => row.entity === 'Customer').length, 12);
  assert.equal(full.filter(row => row.entity === 'Customer').length, 48);
  assert.equal(full.filter(row => row.entity === 'Item').length, 9);
  for (const row of small) assert.deepEqual(row, full.find(item => item.key === row.key));
});
test('bindings accept explicit IDs, reject unknown roles and duplicate physical identities', () => {
  assert.deepEqual(validateMasterBindings(undefined, proposal.business), {});
  assert.deepEqual(validateMasterBindings({ 'field-client-001': '7', 'stock-supplier-1': '7', 'field-client-002': null }, proposal.business), { 'field-client-001': '7', 'stock-supplier-1': '7' });
  for (const bindings of [[], { hacked: '1' }, { 'field-client-001': {} }, { 'field-client-001': '7', 'field-client-002': '7' }]) assert.throws(() => validateMasterBindings(bindings, proposal.business), error => error.status === 400);
  assert.deepEqual(validateMasterBindings({ 'care-client-025': '8' }, { ...proposal.business, volumeProfile: 'development' }), { 'care-client-025': '8' });
});
test('draft snapshots retain exact bindings and older snapshots default to no binding', () => {
  const input = { connectionId: scope.connectionId, requestKey: '11111111-1111-4111-8111-111111111111', baseHash: null, business: proposal.business, mappings: proposal.mappings, masterBindings: { 'field-client-001': '7' } };
  assert.equal(validateDraftInput(input).masterBindings['field-client-001'], '7');
  const definition = buildDraftDefinition(input);
  assert.equal(draftView({ _id: 'fixture', definition, connectionId: scope.connectionId }, scope.connectionId).masterBindings['field-client-001'], '7');
  delete definition.masterBindings;
  assert.deepEqual(draftView({ _id: 'fixture', definition }, scope.connectionId).masterBindings, {});
});
test('names never establish identity or adoption, even when they exactly match a role key', () => {
  const f = fixture(); f.view.draft.masterBindings = {}; f.observed.options.Customer[0].name = 'field-client-001';
  assert.equal(f.inspect().rows.find(row => row.key === 'field-client-001').status, 'unassigned');
  assert.equal(f.inspect().readyToExecute, false);
});
test('scope, incomplete lists, missing IDs, activity and currency must be checked explicitly', () => {
  for (const [status, mutate] of [
    ['unverified', f => { f.observed.completeness.Customer = false; }], ['unavailable', f => { f.observed.options.Customer = []; }],
    ['unavailable', f => { f.observed.options.Customer.push(f.observed.options.Customer[0]); }], ['inactive', f => { f.observed.options.Customer[0].active = false; }],
    ['unverified', f => { f.observed.options.Customer[0].active = null; }], ['incompatible', f => { f.observed.options.Customer[0].currency = 'USD'; }],
    ['unverified', f => { f.observed.options.Customer[0].currency = null; }], ['incompatible', f => { f.observed.options.Customer[0].project = true; }],
    ['unverified', f => { f.view.draft.connectionMatches = false; }],
  ]) { const f = fixture(); mutate(f); assert.equal(f.inspect().rows.find(row => row.key === 'field-client-001').status, status); }
  const f = fixture(); f.observed.realmId = '456'; assert.throws(() => f.inspect(), error => error.status === 409);
});
test('product compatibility requires matching item type and exact mapped accounts', () => {
  const f = fixture(); f.view.draft.masterBindings['workshop-stock-1'] = '9';
  const record = { id: '9', active: true, itemType: 'Inventory', accountRefs: { IncomeAccountRef: '1', AssetAccountRef: '2', ExpenseAccountRef: '3' } };
  f.observed.options.Item.push(record);
  const status = () => f.inspect().rows.find(row => row.key === 'workshop-stock-1').status;
  assert.equal(status(), 'unverified');
  Object.assign(f.view.draft.mappings, { supplyIncome: '1', inventoryAsset: '2', costOfGoods: '3' });
  assert.equal(status(), 'compatible'); record.accountRefs.ExpenseAccountRef = '4'; assert.equal(status(), 'incompatible');
  record.itemType = 'Service'; assert.equal(status(), 'incompatible');
});
test('master inspection is bounded and minimizes private company fields', async () => {
  const calls = [], qbo = { query: async query => { calls.push(query); const entity = /FROM (\w+)/.exec(query)[1]; if (entity === 'Employee') throw new Error('private fixture failure'); return { QueryResponse: { [entity]: [{ Id: '1', DisplayName: 'Fixture', Active: true, PrimaryEmailAddr: { Address: 'private@example.invalid' }, TaxIdentifier: 'sensitive', CurrencyRef: { value: 'CAD' } }] } }; } };
  const result = await readBusinessMasters(qbo, scope);
  assert.equal(calls.length, 4); assert.equal(result.completeness.Employee, false);
  assert.equal(result.options.Customer[0].currency, 'CAD');
  assert.equal(JSON.stringify(result).includes('private'), false); assert.equal(JSON.stringify(result).includes('sensitive'), false);
  assert.ok(calls.every(query => query.includes('MAXRESULTS 1000')));
});
