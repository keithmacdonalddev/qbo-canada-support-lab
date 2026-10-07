'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAPPINGS, readDraftSetup } = require('../src/modules/blueprint-draft');
const { validateMappingRequest, checkBlueprintMappings } = require('../src/modules/blueprint-mapping-check');
function fixture() {
  const scope = { realmId: '123', environment: 'sandbox', connectionId: '000000000000000000000002' };
  const input = { connectionId: scope.connectionId, baseHash: 'a'.repeat(64) };
  const mappings = Object.fromEntries(Object.keys(MAPPINGS).map((key, i) => [key, String(i + 1)]));
  const view = { ...scope, draft: { contentHash: input.baseHash, version: 1, connectionMatches: true, mappings } };
  const setup = { ...scope, completeness: { accounts: true, taxCodes: true, preferences: true }, options: {
    accounts: Object.entries(MAPPINGS).filter(([, value]) => value.entity === 'Account').map(([key, value]) => ({ id: mappings[key], name: key, active: true, type: value.types[0], subtype: value.subtypes?.[0] || null, currency: 'CAD' })),
    taxCodes: ['salesTax', 'purchaseTax'].map(key => ({ id: mappings[key], name: key, active: true, sales: true, purchases: true })),
  }, observations: { homeCurrency: 'CAD' }, observedAt: '2026-10-06T12:00:00.000Z', sourceHash: 'b'.repeat(64) };
  return { view, setup, input, check() { return checkBlueprintMappings(view, setup, input); } };
}
test('compatible account structures never imply approved tax treatment or activation', () => {
  const f = fixture(), result = f.check();
  assert.equal(result.compatibleAccounts, 10); assert.equal(result.unresolvedMappings, 2);
  assert.equal(result.readyToActivate, false); assert.equal(result.currency.status, 'compatible');
  assert.equal(result.rows.find(row => row.key === 'salesTax').status, 'review_required');
  assert.equal(result.source.blueprintHash, f.input.baseHash); assert.equal(result.sourceHash, f.setup.sourceHash);
});
test('strict mapping request rejects user data, missing version, scope and connection overrides', () => {
  const f = fixture();
  for (const body of [null, {}, { ...f.input, realmId: 'other' }, { ...f.input, mappings: {} }, { connectionId: f.input.connectionId }, { ...f.input, baseHash: 'bad' }]) assert.throws(() => validateMappingRequest(body), error => error.status === 400);
  for (const key of ['realmId', 'environment', 'connectionId']) { const g = fixture(); g.setup[key] = 'other'; assert.throws(() => g.check(), error => error.status === 409); }
  f.input.baseHash = 'c'.repeat(64); assert.throws(() => f.check(), error => error.status === 409);
});
test('each observed incompatibility remains explicit, not a pass', () => {
  const cases = [
    ['inactive', record => { record.active = false; }], ['unverified', record => { record.active = null; }],
    ['incompatible', record => { record.type = 'Income'; }], ['incompatible', record => { record.currency = 'USD'; }],
    ['unverified', record => { record.currency = null; }],
  ];
  for (const [status, mutate] of cases) { const f = fixture(); mutate(f.setup.options.accounts[0]); assert.equal(f.check().rows[0].status, status); }
  const f = fixture(); f.setup.options.accounts.find(record => record.name === 'inventoryAsset').subtype = 'OtherCurrentAssets';
  assert.equal(f.check().rows.find(row => row.key === 'inventoryAsset').status, 'incompatible');
});
test('incomplete list, duplicate ID, absent record, and earlier connection cannot be validated', () => {
  for (const [status, mutate] of [
    ['unverified', f => { f.setup.completeness.accounts = false; }],
    ['unavailable', f => { f.setup.options.accounts.push({ ...f.setup.options.accounts[0] }); }],
    ['unavailable', f => { f.setup.options.accounts.shift(); }],
    ['unverified', f => { f.view.draft.connectionMatches = false; }],
  ]) { const f = fixture(); mutate(f); assert.equal(f.check().rows[0].status, status); }
});
test('unsaved proposal is identified and all missing mappings remain unassigned', () => {
  const f = fixture(); f.view.proposal = { mappings: {} }; f.view.draft = null; f.input.baseHash = null;
  const result = f.check(); assert.equal(result.source.kind, 'proposal'); assert.equal(result.unresolvedMappings, 12);
  assert.ok(result.rows.every(row => row.status === 'unassigned'));
});
test('missing, foreign and incompletely read home currency never pass', () => {
  for (const [currency, complete, status] of [[null, true, 'unverified'], ['CAD', false, 'unverified'], ['USD', true, 'incompatible']]) {
    const f = fixture(); f.setup.observations.homeCurrency = currency; f.setup.completeness.preferences = complete; assert.equal(f.check().currency.status, status);
  }
});
test('tax direction without rate references needs review even if another direction is populated', () => {
  const f = fixture(); f.setup.options.taxCodes[0].sales = false;
  assert.match(f.check().rows.find(row => row.key === 'salesTax').reason, /No complete sales/);
});
test('setup preserves inactive records and does not mistake empty or malformed tax lists for rates', async () => {
  const taxCodes = [
    { Id: '1', Active: false, SalesTaxRateList: {} },
    { Id: '2', Active: true, SalesTaxRateList: { TaxRateDetail: [] } },
    { Id: '3', Active: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '' } }] } },
    { Id: '4', Active: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '5' } }] }, PurchaseTaxRateList: {} },
  ];
  const qbo = { query: async query => query.includes('TaxCode') ? { QueryResponse: { TaxCode: taxCodes } } : query.includes('Account') ? { QueryResponse: { Account: [{ Id: '1', Active: false }, { Id: '2' }] } } : { QueryResponse: { Preferences: [{}] } } };
  const result = await readDraftSetup(qbo, {});
  assert.deepEqual(result.options.taxCodes.map(row => row.sales), [false, false, false, true]);
  assert.equal(result.options.taxCodes[3].purchases, false);
  assert.equal(result.options.accounts[0].active, false); assert.equal(result.options.accounts[1].active, null);
});

test('control-account mappings require exact account types, detail types and CAD where applicable', () => {
  for (const key of ['accountsReceivable', 'accountsPayable', 'undepositedFunds']) {
    for (const [field, value, expected] of [['type', 'Income', 'incompatible'], ['subtype', 'OtherCurrentAssets', 'incompatible'], ['subtype', null, 'unverified']]) {
      const f = fixture(); f.setup.options.accounts.find(row => row.id === f.view.draft.mappings[key])[field] = value;
      assert.equal(f.check().rows.find(row => row.key === key).status, expected, key + ':' + field);
    }
  }
  for (const key of ['accountsReceivable', 'accountsPayable']) for (const [currency, expected] of [['USD', 'incompatible'], [null, 'unverified']]) {
    const f = fixture(); f.setup.options.accounts.find(row => row.id === f.view.draft.mappings[key]).currency = currency;
    assert.equal(f.check().rows.find(row => row.key === key).status, expected);
  }
});
test('old drafts preserve previous choices and expose missing control accounts as unassigned', () => {
  const f = fixture(); const bank = f.view.draft.mappings.operatingBank;
  for (const key of ['accountsReceivable', 'accountsPayable', 'undepositedFunds']) delete f.view.draft.mappings[key];
  const result = f.check();
  assert.equal(result.rows.find(row => row.key === 'operatingBank').id, bank);
  assert.equal(result.unresolvedMappings, 5);
  assert.ok(result.rows.filter(row => ['accountsReceivable', 'accountsPayable', 'undepositedFunds'].includes(row.key)).every(row => row.status === 'unassigned' && row.id === null));
});
