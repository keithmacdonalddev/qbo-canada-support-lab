'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { assertPeriodControl } = require('./qbo-write-period');
const { MAPPINGS, problem, validateDraftInput } = require('./blueprint-draft');
const { checkBlueprintMappings, assertMappingVersion } = require('./blueprint-mapping-check');
const { masterRequirements, inspectBusinessMasters } = require('./business-master-data');
const { businessDate } = require('./business-activity-preview');
const ID = /^\d{1,30}$/, HASH = /^[a-f0-9]{64}$/;
const ACCOUNTS = Object.freeze({
  operatingBank: ['Bank', 'Checking', 'Operating bank'],
  serviceIncome: ['Income', 'ServiceFeeIncome', 'Field services revenue'],
  supplyIncome: ['Income', 'SalesOfProductIncome', 'Workshop sales revenue'],
  careIncome: ['Income', 'ServiceFeeIncome', 'Care plan revenue'],
  operatingExpense: ['Expense', 'OfficeGeneralAdministrativeExpenses', 'Operating expenses'],
  inventoryAsset: ['Other Current Asset', 'Inventory', 'Workshop inventory'],
  costOfGoods: ['Cost of Goods Sold', 'SuppliesMaterialsCogs', 'Workshop cost of sales'],
});
const fresh = (stamp, now) => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)) && new Date(Date.parse(stamp)).toISOString() === stamp && Date.parse(stamp) <= now && now - Date.parse(stamp) <= 300000;
function validateMasterPreparationInput(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== 'baseHash,connectionId,inventoryStartDate') throw problem('Review the saved business and an explicit inventory starting date; no record overrides are accepted.');
  if (!/^[a-f0-9]{24}$/.test(input.connectionId || '') || !HASH.test(input.baseHash || '')) throw problem('Save and reload the current business draft before preparing records.');
  try { date(input.inventoryStartDate); } catch { throw problem('Choose an explicit inventory starting date.'); }
  return { ...input };
}
function labelFor(key) {
  const match = /^(field-client|care-client|wholesale-client)-(\d{3})$/.exec(key);
  if (match) return ({ 'field-client': 'Field client', 'care-client': 'Care client', 'wholesale-client': 'Wholesale client' })[match[1]] + ' ' + match[2];
  if (/^overhead-supplier-[1-3]$/.test(key)) return ['Premises supplier', 'Utilities supplier', 'Software supplier'][Number(key.slice(-1)) - 1];
  if (/^stock-supplier-[1-3]$/.test(key)) return 'Workshop supplier ' + key.slice(-1);
  if (/^care-plan-[1-3]$/.test(key)) return 'Monthly care tier ' + key.slice(-1);
  if (/^workshop-stock-[1-5]$/.test(key)) return 'Workshop supply ' + key.slice(-1);
  if (key === 'field-service-hour') return 'Field service hour';
  if (key === 'field-technician') return 'Field technician';
  throw problem('The saved business requires an unsupported master role.', 409);
}
function nameFor(business, label) {
  // QBO hierarchy separators are excluded. Names are presentation, never ownership.
  const safeName = business.displayName.normalize('NFC').replace(/[:\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  let prefix = '';
  for (const point of safeName) { if (Buffer.byteLength(prefix + point) > 48) break; prefix += point; }
  prefix = prefix.trim();
  if (!prefix) throw problem('Choose a printable business name before preparing records.');
  return prefix + ' - ' + label;
}
function selectionInventory(setup, masters) {
  return Object.fromEntries([['Account', setup.options.accounts], ...Object.entries(masters.options)].map(([entity, rows]) => {
    const ids = rows.map(row => row.id);
    if (ids.length > 16000 || ids.some(id => !ID.test(id || '')) || new Set(ids).size !== ids.length) throw problem('Complete unique master IDs are required before preparing records.', 409);
    return [entity, [...ids].sort()];
  }));
}
function prepareMasterPlan({ view, input, setup, masters, country, periodControl, ownerId, now = Date.now() }) {
  input = validateMasterPreparationInput(input); assertMappingVersion(view, { connectionId: input.connectionId, baseHash: input.baseHash });
  if (!view.draft || !view.draft.connectionMatches || !/^[a-f0-9]{24}$/.test(view.draft.id || '') || !Number.isSafeInteger(view.draft.version)) throw problem('Save the business draft for this exact company connection before preparing records.', 409);
  const scope = scoped(view), today = businessDate(new Date(now)), blockers = [];
  const block = (key, reason) => blockers.push({ key, reason });
  for (const observed of [setup, masters]) if (!observed || Object.keys(scope).some(key => observed[key] !== scope[key])) throw problem('Company scope changed during record preparation.', 409);
  if (!country || canonical(country.scope) !== canonical(scope) || country.country !== 'CA' || !HASH.test(country.recordHash || '') || !fresh(country.observedAt, now)) block('company', 'Fresh Canadian company settings are required.');
  if (!setup.complete || !Object.values(setup.completeness).every(value => value === true) || !fresh(setup.observedAt, now)) block('setup', 'Read complete fresh accounts, tax codes and preferences before any create.');
  if (!['Customer', 'Vendor', 'Employee', 'Item'].every(entity => masters.completeness[entity] === true) || !fresh(masters.observedAt, now)) block('masters', 'Read all active and inactive customers, suppliers, employees and items before any create.');
  if (setup.observations.homeCurrency !== 'CAD') block('currency', 'This business requires an explicitly verified CAD home currency.');
  try { assertPeriodControl(periodControl, scope, ownerId); } catch { block('periods', 'Record current owner-reviewed protected dates before preparing records.'); }
  const draft = view.draft, mappingCheck = checkBlueprintMappings(view, setup, { connectionId: input.connectionId, baseHash: input.baseHash }), entries = [];
  for (const row of mappingCheck.rows) {
    if (row.id) {
      if (row.status !== 'compatible' && !(MAPPINGS[row.key].entity === 'TaxCode' && row.status === 'review_required' && (() => { const code = setup.options.taxCodes.find(record => record.id === row.id); return code?.[row.key === 'salesTax' ? 'sales' : 'purchases'] === true || code?.taxable === false; })())) block(row.key, row.reason);
      if (!ID.test(row.id)) block(row.key, 'The selected record needs an exact QuickBooks ID.');
    } else if (ACCOUNTS[row.key]) {
      const [type, subtype, label] = ACCOUNTS[row.key];
      entries.push({ ordinal: entries.length, target: 'mapping', key: row.key, entity: 'Account', name: nameFor(draft.business, label), accountType: type, accountSubtype: subtype, dependencies: [] });
    } else block(row.key, 'Explicitly choose an existing ' + row.label + '. System accounts and tax settings are never created automatically.');
  }
  const requirements = masterRequirements(draft.business), inspected = inspectBusinessMasters(view, masters);
  for (const row of inspected.rows) if (row.id && row.status !== 'compatible' && !(row.status === 'unverified' && row.accountMappings && Object.values(row.accountMappings).some(key => !draft.mappings[key]))) block(row.key, row.reason);
  // A selected item with unresolved parents still needs all non-parent compatibility checks.
  for (const requirement of requirements) {
    const id = draft.masterBindings?.[requirement.key];
    if (id) {
      const record = masters.options[requirement.entity].filter(row => row.id === id);
      if (!ID.test(id) || record.length !== 1 || record[0].active !== true || (requirement.currency && record[0].currency !== requirement.currency) || (requirement.entity === 'Customer' && record[0].project) || (requirement.itemType && record[0].itemType !== requirement.itemType)) block(requirement.key, 'The saved record must be available, active and compatible before any preparation.');
      for (const [reference, mapping] of Object.entries(requirement.accountMappings || {})) if (!draft.mappings[mapping] || record[0]?.accountRefs?.[reference] !== draft.mappings[mapping]) block(requirement.key, 'Choose a verified existing account mapping for the selected product before preparing records.');
    } else entries.push({ ordinal: entries.length, target: 'master', key: requirement.key, entity: requirement.entity, name: nameFor(draft.business, labelFor(requirement.key)), ...(requirement.itemType ? { itemType: requirement.itemType } : {}), dependencies: Object.values(requirement.accountMappings || {}).filter(key => !draft.mappings[key]) });
  }
  const inventoryNeeded = entries.some(row => row.entity === 'Item' && row.itemType === 'Inventory');
  if (inventoryNeeded) {
    if (setup.observations.closingDateVerified !== true) block('inventoryStartDate', 'QuickBooks accounting and closing preferences must be explicitly readable before any master create.');
    if (setup.observations.inventoryTracking !== true) block('inventory', 'Quantity-on-hand tracking must already be enabled and verified. This workflow does not change preferences.');
    // The first stock purchase order starts on the opening day. Retain the chosen date exactly.
    if (input.inventoryStartDate > today || input.inventoryStartDate > draft.business.openingDate) block('inventoryStartDate', 'The inventory date must be elapsed and on or before the first planned stock activity (' + draft.business.openingDate + ').');
    for (const cutoff of [setup.observations.closedThrough, periodControl?.closedThrough, periodControl?.reconciledThrough]) {
      if (cutoff != null && cutoff !== '') {
        try { date(cutoff); if (input.inventoryStartDate <= cutoff) block('inventoryStartDate', 'The zero-quantity opening date falls in a protected period ending ' + cutoff + '.'); }
        catch { block('inventoryStartDate', 'A protected accounting date could not be verified.'); }
      }
    }
  }
  if (entries.length > 100) throw problem('Master preparation exceeds the reviewed 100-record limit.', 409);
  const inventoryBefore = selectionInventory(setup, masters);
  // Display names share a namespace for parties; accounts/items have separate namespaces.
  const names = new Map();
  for (const [entity, rows] of [['Account', setup.options.accounts], ...Object.entries(masters.options)]) for (const row of rows) {
    const space = ['Customer', 'Vendor', 'Employee'].includes(entity) ? 'party' : entity, key = space + ':' + String(row.name).normalize('NFC').toLocaleLowerCase('en-CA');
    names.set(key, true);
  }
  for (const entry of entries) {
    const space = ['Customer', 'Vendor', 'Employee'].includes(entry.entity) ? 'party' : entry.entity, key = space + ':' + entry.name.normalize('NFC').toLocaleLowerCase('en-CA');
    if (names.has(key)) block(entry.key, 'A proposed name already exists. Explicitly select or rename the intended record; name matches are never adopted.');
    names.set(key, true);
  }
  const plan = { version: 1, scope, ownerId, source: { id: draft.id, version: draft.version, contentHash: draft.contentHash, business: draft.business, mappings: draft.mappings, masterBindings: draft.masterBindings || {} },
    inventoryStartDate: input.inventoryStartDate, salesTaxable: setup.options.taxCodes.find(row => row.id === draft.mappings.salesTax)?.taxable !== false, entries, inventoryBefore, observedAt: new Date(now).toISOString(), evidence: { setupHash: setup.sourceHash, mastersHash: masters.sourceHash, countryHash: country?.recordHash || null, periodControlHash: periodControl?.contentHash || null }, blockers,
    runnable: blockers.length === 0 && entries.length > 0, proposedQboCreates: entries.length, qboWrites: 0, openingQuantity: 0, openingBalances: false, edits: 0 };
  if (Buffer.byteLength(canonical(plan)) > 2000000) throw problem('Master preparation exceeds its retained evidence budget.', 409);
  return { ...plan, planHash: hash(plan) };
}
function assertMasterPlan(plan) {
  const invalid = () => { throw problem('The exact runnable master preparation plan is required.', 409); };
  const { planHash, ...content } = plan || {};
  if (content.version !== 1 || !HASH.test(planHash || '') || hash(content) !== planHash || content.runnable !== true || !Array.isArray(content.blockers) || content.blockers.length || !Array.isArray(content.entries) || !content.entries.length || content.entries.length > 100 || content.proposedQboCreates !== content.entries.length || content.qboWrites !== 0 || content.edits !== 0 || content.openingBalances !== false || content.openingQuantity !== 0 || typeof content.salesTaxable !== 'boolean' || !/^[a-f0-9]{24}$/.test(content.ownerId || '')) invalid();
  if (canonical(scoped(plan.scope)) !== canonical(plan.scope) || Buffer.byteLength(canonical(plan)) > 2000000) invalid();
  if (Object.keys(content).sort().join(',') !== 'blockers,edits,entries,evidence,inventoryBefore,inventoryStartDate,observedAt,openingBalances,openingQuantity,ownerId,proposedQboCreates,qboWrites,runnable,salesTaxable,scope,source,version') invalid();
  const source = plan.source;
  if (!source || Object.keys(source).sort().join(',') !== 'business,contentHash,id,mappings,masterBindings,version' || !/^[a-f0-9]{24}$/.test(source.id || '') || !HASH.test(source.contentHash || '') || !Number.isSafeInteger(source.version) || source.version < 1 || !Number.isFinite(Date.parse(plan.observedAt)) || new Date(Date.parse(plan.observedAt)).toISOString() !== plan.observedAt) invalid();
  const input = validateDraftInput({ requestKey: '00000000-0000-0000-0000-000000000000', connectionId: plan.scope.connectionId, baseHash: source.contentHash, business: source.business, mappings: source.mappings, masterBindings: source.masterBindings });
  if (canonical(input.business) !== canonical(source.business) || canonical(input.mappings) !== canonical(source.mappings) || canonical(input.masterBindings) !== canonical(source.masterBindings) || Object.values(source.mappings).some(id => id !== null && !ID.test(id)) || Object.values(source.masterBindings).some(id => !ID.test(id))) invalid();
  try { date(plan.inventoryStartDate); } catch { invalid(); }
  if (plan.entries.some(row => row.entity === 'Item' && row.itemType === 'Inventory') && (plan.inventoryStartDate > source.business.openingDate || plan.inventoryStartDate > businessDate(new Date(plan.observedAt)))) invalid();
  if (!plan.evidence || Object.keys(plan.evidence).sort().join(',') !== 'countryHash,mastersHash,periodControlHash,setupHash' || Object.values(plan.evidence).some(value => !HASH.test(value || ''))) invalid();
  if (!plan.inventoryBefore || Object.keys(plan.inventoryBefore).sort().join(',') !== 'Account,Customer,Employee,Item,Vendor') invalid();
  for (const ids of Object.values(plan.inventoryBefore)) if (!Array.isArray(ids) || ids.length > 16000 || ids.some(id => !ID.test(id)) || canonical([...new Set(ids)].sort()) !== canonical(ids)) invalid();
  const expected = [];
  for (const key of Object.keys(MAPPINGS)) {
    if (source.mappings[key]) continue;
    if (!ACCOUNTS[key]) invalid();
    const [accountType, accountSubtype, label] = ACCOUNTS[key];
    expected.push({ ordinal: expected.length, target: 'mapping', key, entity: 'Account', name: nameFor(source.business, label), accountType, accountSubtype, dependencies: [] });
  }
  for (const requirement of masterRequirements(source.business)) {
    if (source.masterBindings[requirement.key]) continue;
    expected.push({ ordinal: expected.length, target: 'master', key: requirement.key, entity: requirement.entity, name: nameFor(source.business, labelFor(requirement.key)), ...(requirement.itemType ? { itemType: requirement.itemType } : {}), dependencies: Object.values(requirement.accountMappings || {}).filter(key => !source.mappings[key]) });
  }
  if (canonical(expected) !== canonical(plan.entries)) invalid();
  return plan;
}
function compileMasterEntry(plan, ordinal, verified = {}) {
  assertMasterPlan(plan);
  const entry = plan.entries[ordinal]; if (!entry || entry.ordinal !== ordinal) throw problem('The exact master record ordinal is required.', 409);
  const resolved = key => {
    if (plan.source.mappings[key]) return plan.source.mappings[key];
    const parent = plan.entries.find(row => row.target === 'mapping' && row.key === key), proof = verified[key];
    if (!parent || parent.ordinal >= ordinal || proof?.state !== 'verified' || !ID.test(proof.qboId || '') || proof.planHash !== plan.planHash || proof.ordinal !== parent.ordinal) throw problem('A required created account needs independent readback before use.', 409);
    return proof.qboId;
  };
  return masterFields(plan, entry, key => ({ value: resolved(key) }));
}
function describeMasterEntry(plan, ordinal) {
  assertMasterPlan(plan); const entry = plan.entries[ordinal];
  if (!entry || entry.ordinal !== ordinal) throw problem('Choose an exact saved master ordinal.', 409);
  return masterFields(plan, entry, key => plan.source.mappings[key] ? { value: plan.source.mappings[key] } : { plannedAccountRole: key });
}
// One field builder serves the owner preview and the strict SDK compiler. A planned
// role is descriptive only; the compiler still requires the verified numeric ID.
function masterFields(plan, entry, accountRef) {
  let payload;
  if (entry.entity === 'Account') payload = { Name: entry.name, Active: true, AccountType: entry.accountType, AccountSubType: entry.accountSubtype, CurrencyRef: { value: 'CAD' } };
  else if (entry.entity === 'Customer' || entry.entity === 'Vendor') payload = { DisplayName: entry.name, Active: true, CurrencyRef: { value: 'CAD' } };
  else if (entry.entity === 'Employee') payload = { DisplayName: entry.name, GivenName: 'Robin', FamilyName: 'Mercer', Active: true };
  else if (entry.entity === 'Item') {
    const requirement = masterRequirements(plan.source.business).find(row => row.key === entry.key);
    if (!requirement || requirement.itemType !== entry.itemType) throw problem('The product role no longer has its original definition.', 409);
    payload = { Name: entry.name, Active: true, Type: entry.itemType, Taxable: plan.salesTaxable, IncomeAccountRef: accountRef(requirement.accountMappings.IncomeAccountRef), SalesTaxCodeRef: { value: plan.source.mappings.salesTax } };
    if (entry.itemType === 'Inventory') {
      const n = Number(entry.key.slice(-1)), cost = 18 + n * 2.5;
      Object.assign(payload, { UnitPrice: cost * 2, PurchaseCost: cost, TrackQtyOnHand: true, QtyOnHand: 0, InvStartDate: plan.inventoryStartDate, AssetAccountRef: accountRef('inventoryAsset'), ExpenseAccountRef: accountRef('costOfGoods'), PurchaseTaxCodeRef: { value: plan.source.mappings.purchaseTax } });
    } else payload.UnitPrice = entry.key === 'field-service-hour' ? 125 : 149 + (Number(entry.key.slice(-1)) - 1) * 50;
  } else throw problem('Unsupported master entity.', 409);
  return { entity: entry.entity, payload };
}
// Retain only intended business fields and identifiers, never addresses, contacts or payroll data.
function verifyMasterReadback(compiled, record, expectedId) {
  if (!record || !ID.test(expectedId || '') || record.Id !== expectedId || typeof record.SyncToken !== 'string' || !/^(0|[1-9]\d{0,63})$/.test(record.SyncToken)) throw problem('The accepted master record needs complete exact-ID readback.', 409);
  const project = (wanted, actual) => Object.fromEntries(Object.entries(wanted).map(([key, value]) => [key, value && typeof value === 'object' ? project(value, actual?.[key]) : actual?.[key] ?? null]));
  const fields = project(compiled.payload, record);
  if (canonical(fields) !== canonical(compiled.payload) || (compiled.entity === 'Customer' && record.IsProject === true)) throw problem('The created master fields do not match the reviewed record.', 409);
  if (compiled.entity === 'Account' && [record.CurrentBalance, record.CurrentBalanceWithSubAccounts].some(value => value != null && value !== 0)) throw problem('The prepared account has a nonzero balance; review it before using it.', 409);
  return { entity: compiled.entity, qboId: record.Id, syncToken: record.SyncToken, fields, projectionHash: hash({ entity: compiled.entity, qboId: record.Id, fields }) };
}
module.exports = { ACCOUNTS, validateMasterPreparationInput, prepareMasterPlan, assertMasterPlan, compileMasterEntry, describeMasterEntry, verifyMasterReadback };
