'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../src/modules/business-calendar');
const { readDraftSetup } = require('../src/modules/blueprint-draft');
const { masterRequirements, inspectBusinessMasters, readBusinessMasters } = require('../src/modules/business-master-data');
const { checkBlueprintMappings } = require('../src/modules/blueprint-mapping-check');
const { prepareMasterPlan, compileMasterEntry, verifyMasterReadback, assertMasterPlan } = require('../src/modules/business-master-preparation-plan');
const { fixture, scope } = require('./helpers/business-master-preparation-fixture');
test('prepares only bounded missing business roles, with no financial writes or existing-record edits', () => {
  const f = fixture(), plan = prepareMasterPlan(f);
  assert.deepEqual(plan.blockers, []); assert.equal(plan.runnable, true); assert.equal(plan.entries.length, 32);
  assert.equal(plan.qboWrites, 0); assert.equal(plan.edits, 0); assert.equal(plan.openingBalances, false); assert.equal(plan.openingQuantity, 0);
  assert.equal(plan.entries.filter(row => row.entity === 'Account').length, 7);
  assert.equal(plan.entries.filter(row => row.entity === 'Customer').length, 12);
  assert.ok(!plan.entries.some(row => ['accountsReceivable', 'accountsPayable', 'undepositedFunds', 'salesTax', 'purchaseTax'].includes(row.key)));
  assertMasterPlan(plan);
});
test('created records pass normal mapping and master validators only after independent ID readback', () => {
  const f = fixture(), plan = prepareMasterPlan(f), verified = {}, next = structuredClone(f.view); let id = 100;
  for (const entry of plan.entries) {
    const compiled = compileMasterEntry(plan, entry.ordinal, verified), record = { ...structuredClone(compiled.payload), Id: String(id++), SyncToken: '0' };
    const proof = verifyMasterReadback(compiled, record, record.Id);
    if (entry.target === 'mapping') {
      next.draft.mappings[entry.key] = record.Id;
      f.setup.options.accounts.push({ id: record.Id, name: record.Name, active: record.Active, type: record.AccountType, subtype: record.AccountSubType, currency: record.CurrencyRef.value });
    } else {
      next.draft.masterBindings[entry.key] = record.Id;
      f.masters.options[entry.entity].push({ id: record.Id, name: record.DisplayName || record.Name, active: record.Active, currency: record.CurrencyRef?.value || null, itemType: record.Type || null, project: false, accountRefs: Object.fromEntries(['IncomeAccountRef', 'ExpenseAccountRef', 'AssetAccountRef'].map(key => [key, record[key]?.value || null])) });
    }
    verified[entry.key] = { ...proof, state: 'verified', planHash: plan.planHash, ordinal: entry.ordinal };
  }
  const mapping = checkBlueprintMappings(next, f.setup, { connectionId: scope.connectionId, baseHash: next.draft.contentHash });
  assert.equal(mapping.compatibleAccounts, 10); assert.equal(mapping.rows.filter(row => row.status === 'review_required').length, 2);
  assert.equal(inspectBusinessMasters(next, f.masters).unresolved, 0);
  const repeat = prepareMasterPlan({ ...f, view: next }); assert.equal(repeat.entries.length, 0); assert.equal(repeat.runnable, false);
});
for (const [label, change, key] of [
  ['inactive employee inventory omitted', f => { f.masters.completeness.Employee = false; }, 'masters'],
  ['incomplete accounts', f => { f.setup.complete = false; f.setup.completeness.accounts = false; }, 'setup'],
  ['stale evidence', f => { f.masters.observedAt = '2026-10-15T11:54:59.000Z'; }, 'masters'],
  ['non-CAD company', f => { f.setup.observations.homeCurrency = 'USD'; }, 'currency'],
  ['non-Canadian company', f => { f.country.country = 'US'; }, 'company'],
  ['unrecorded protection', f => { f.periodControl = null; }, 'periods'],
  ['disabled inventory', f => { f.setup.observations.inventoryTracking = false; }, 'inventory'],
  ['future inventory date', f => { f.input.inventoryStartDate = '2026-10-16'; }, 'inventoryStartDate'],
  ['date later than first stock activity', f => { f.input.inventoryStartDate = '2023-10-02'; }, 'inventoryStartDate'],
  ['QBO closed date', f => { f.setup.observations.closedThrough = '2023-10-01'; }, 'inventoryStartDate'],
  ['missing AR choice', f => { f.view.draft.mappings.accountsReceivable = null; }, 'accountsReceivable'],
  ['invalid existing bank', f => { f.view.draft.mappings.operatingBank = '1'; }, 'operatingBank'],
  ['inactive existing customer', f => { f.view.draft.masterBindings['field-client-001'] = '45'; f.masters.options.Customer.push({ id: '45', name: 'Fixture client', active: false, currency: 'CAD' }); }, 'field-client-001'],
]) test(label + ' blocks the entire plan before unrelated creates', () => {
  const f = fixture(); change(f); const plan = prepareMasterPlan(f); assert.equal(plan.runnable, false); assert.ok(plan.blockers.some(row => row.key === key)); assert.throws(() => compileMasterEntry(plan, 0), /runnable/);
});
test('owner closed and reconciled dates are both checked without shifting the inventory date', () => {
  for (const key of ['closedThrough', 'reconciledThrough']) {
    const f = fixture(); const { contentHash, ...control } = f.periodControl; control[key] = '2023-10-01'; f.periodControl = { ...control, contentHash: hash(control) };
    const plan = prepareMasterPlan(f); assert.equal(plan.runnable, false); assert.equal(plan.inventoryStartDate, '2023-10-01'); assert.ok(plan.blockers.some(row => /protected period/.test(row.reason)));
  }
});
test('name matches across all parties, including inactive records, block instead of adopting IDs', () => {
  const f = fixture(), first = prepareMasterPlan(f).entries.find(row => row.entity === 'Customer');
  f.masters.options.Vendor.push({ id: '45', name: first.name.toUpperCase(), active: false, currency: 'CAD' });
  const plan = prepareMasterPlan(f); assert.equal(plan.runnable, false); assert.ok(plan.blockers.some(row => row.key === first.key && /never adopted/.test(row.reason))); assert.deepEqual(f.view.draft.masterBindings, {});
});
test('dependent products refuse unverified, wrong-plan and wrong-ordinal account evidence', () => {
  const plan = prepareMasterPlan(fixture()), item = plan.entries.find(row => row.itemType === 'Inventory');
  assert.throws(() => compileMasterEntry(plan, item.ordinal), /independent readback/);
  const verified = Object.fromEntries(plan.entries.filter(row => row.entity === 'Account').map(row => [row.key, { state: 'verified', qboId: String(100 + row.ordinal), planHash: plan.planHash, ordinal: row.ordinal }]));
  const output = compileMasterEntry(plan, item.ordinal, verified); assert.equal(output.payload.QtyOnHand, 0); assert.equal(output.payload.InvStartDate, '2023-10-01');
  verified.inventoryAsset.state = 'saved'; assert.throws(() => compileMasterEntry(plan, item.ordinal, verified));
  verified.inventoryAsset.state = 'verified'; verified.inventoryAsset.planHash = hash('other'); assert.throws(() => compileMasterEntry(plan, item.ordinal, verified));
  verified.inventoryAsset.planHash = plan.planHash; verified.inventoryAsset.ordinal++; assert.throws(() => compileMasterEntry(plan, item.ordinal, verified));
});
test('exact-ID readback rejects a different accepted ID, inactive or changed record and nonzero opening balance', () => {
  const plan = prepareMasterPlan(fixture()), compiled = compileMasterEntry(plan, 0), record = { ...compiled.payload, Id: '101', SyncToken: '0', PrimaryEmailAddr: { Address: 'private@example.com' } };
  assert.throws(() => verifyMasterReadback(compiled, record, '102'));
  assert.throws(() => verifyMasterReadback(compiled, { ...record, Active: false }, '101'));
  assert.throws(() => verifyMasterReadback(compiled, { ...record, CurrentBalance: 12 }, '101'));
  const proof = verifyMasterReadback(compiled, record, '101'); assert.ok(!JSON.stringify(proof).includes('private@example.com'));
});
test('tampered plan bytes, scope changes, proposal-only and raw payload overrides are refused', () => {
  const f = fixture(), plan = prepareMasterPlan(f); plan.entries[0].accountType = 'Equity'; assert.throws(() => assertMasterPlan(plan));
  assert.throws(() => prepareMasterPlan({ ...f, input: { ...f.input, payload: {} } }), /overrides/);
  const changed = structuredClone(f); changed.masters.realmId = '456'; assert.throws(() => prepareMasterPlan(changed), /scope/);
  const unsaved = structuredClone(f); unsaved.view.draft = null; assert.throws(() => prepareMasterPlan(unsaved));
  const duplicate = structuredClone(f); duplicate.masters.options.Employee = [{ id: '100', name: 'A' }, { id: '100', name: 'B' }]; assert.throws(() => prepareMasterPlan(duplicate), /unique/);
});
test('real source readers request inactive employees and explicitly project quantity tracking', async () => {
  const queries = [], qbo = { query: async query => { queries.push(query); const entity = /FROM (\w+)/.exec(query)[1]; return { QueryResponse: { [entity]: entity === 'Preferences' ? [{ ProductAndServicesPrefs: { QuantityOnHand: true }, CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } }] : [] } }; } };
  await readBusinessMasters(qbo, scope); const setup = await readDraftSetup(qbo, scope); assert.ok(queries.some(query => /FROM Employee WHERE Active IN \(true, false\)/.test(query))); assert.equal(setup.observations.inventoryTracking, true);
});
test('flagship preparation remains bounded and uses distinct identities for every required role', () => {
  const f = fixture(); f.view.draft.business.volumeProfile = 'flagship'; const plan = prepareMasterPlan(f); assert.equal(plan.runnable, true); assert.ok(plan.entries.length <= 100);
  assert.equal(plan.entries.filter(row => row.target === 'master').length, masterRequirements(f.view.draft.business).length);
  const names = plan.entries.filter(row => ['Customer', 'Vendor', 'Employee'].includes(row.entity)).map(row => row.name); assert.equal(new Set(names).size, names.length);
});

test('explicit active non-taxable codes supported by publication can prepare exempt products', () => {
  const f = fixture(); Object.assign(f.setup.options.taxCodes[0], { taxable: false, sales: false, purchases: false });
  const plan = prepareMasterPlan(f); assert.equal(plan.runnable, true); assert.equal(plan.salesTaxable, false);
  const product = plan.entries.find(row => row.key === 'field-service-hour'), parent = plan.entries.find(row => row.key === 'serviceIncome');
  const compiled = compileMasterEntry(plan, product.ordinal, { serviceIncome: { state: 'verified', ordinal: parent.ordinal, planHash: plan.planHash, qboId: '101' } });
  assert.equal(compiled.payload.Taxable, false); assert.equal(compiled.payload.SalesTaxCodeRef.value, '4');
});

test('a newly computed hash cannot grant unsupported account, payload, owner, evidence or role authority', () => {
  for (const change of [
    p => { p.entries[0].accountType = 'Equity'; },
    p => { p.entries[0].payload = { OpeningBalance: 10 }; },
    p => { p.entries[0].key = 'accountsReceivable'; },
    p => { p.entries[7].entity = 'TaxRate'; },
    p => { p.ownerId = 'unknown'; },
    p => { p.source.contentHash = 'unknown'; },
    p => { p.evidence.periodControlHash = null; },
    p => { p.inventoryBefore.Employee = ['100', '100']; },
    p => { p.edits = 1; },
  ]) {
    const plan = prepareMasterPlan(fixture()); change(plan); const { planHash, ...content } = plan; plan.planHash = hash(content); assert.throws(() => assertMasterPlan(plan));
  }
});

test('Unicode identity boundaries never produce a broken or oversized QBO name', () => {
  const f = fixture(); f.view.draft.business.displayName = 'A'.repeat(47) + '🌲' + 'Forest';
  const plan = prepareMasterPlan(f); assertMasterPlan(plan);
  for (const entry of plan.entries) {
    assert.ok(Buffer.byteLength(entry.name) < 100);
    assert.ok(![...entry.name].some(point => { const code = point.codePointAt(0); return code >= 0xd800 && code <= 0xdfff; }));
  }
});

test('existing stock and missing parties remain runnable when the unused inventory date is later', () => {
  const f = fixture(); let id = 100;
  for (const [key, [type, subtype]] of Object.entries(require('../src/modules/business-master-preparation-plan').ACCOUNTS)) {
    const accountId = String(id++); f.view.draft.mappings[key] = accountId;
    f.setup.options.accounts.push({ id: accountId, name: key, active: true, type, subtype, currency: 'CAD' });
  }
  for (const requirement of masterRequirements(f.view.draft.business).filter(row => row.itemType === 'Inventory')) {
    const itemId = String(id++); f.view.draft.masterBindings[requirement.key] = itemId;
    f.masters.options.Item.push({ id: itemId, name: requirement.key, active: true, itemType: 'Inventory', accountRefs: Object.fromEntries(Object.entries(requirement.accountMappings).map(([reference, mapping]) => [reference, f.view.draft.mappings[mapping]])) });
  }
  f.input.inventoryStartDate = '2026-10-01'; const plan = prepareMasterPlan(f);
  assert.equal(plan.runnable, true); assert.ok(!plan.entries.some(row => row.itemType === 'Inventory')); assertMasterPlan(plan);
  for (const entry of plan.entries) assert.ok(compileMasterEntry(plan, entry.ordinal).payload);
});

test('unreadable accounting preferences block before any unrelated master create', () => {
  const f = fixture(); f.setup.observations.closingDateVerified = false; const plan = prepareMasterPlan(f);
  assert.equal(plan.runnable, false); assert.ok(plan.blockers.some(row => /closing preferences/.test(row.reason)));
});

test('closing preference projection distinguishes explicit absence from malformed falsy values', async () => {
  for (const [accounting, verified, closed] of [
    [undefined, false, null], [[], false, null], [{}, true, null],
    [{ BookCloseDate: '' }, true, null], [{ BookCloseDate: null }, true, null],
    [{ BookCloseDate: '2023-09-30' }, true, '2023-09-30'],
    [{ BookCloseDate: false }, false, false], [{ BookCloseDate: 0 }, false, 0], [{ BookCloseDate: '2023-02-30' }, false, '2023-02-30'],
  ]) {
    const qbo = { query: async query => { const entity = /FROM (\w+)/.exec(query)[1]; return { QueryResponse: { [entity]: entity === 'Preferences' ? [{ AccountingInfoPrefs: accounting, ProductAndServicesPrefs: { QuantityOnHand: true }, CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } }] : [] } }; } };
    const observed = await readDraftSetup(qbo, scope); assert.equal(observed.observations.closingDateVerified, verified); assert.equal(observed.observations.closedThrough, closed);
  }
});
