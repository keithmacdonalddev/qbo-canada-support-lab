'use strict';
const { hash } = require('./business-calendar');
const { readSource } = require('./coverage');
const SOURCE = { Customer: 'customers', Vendor: 'vendors', Item: 'items', Employee: 'employees' };
function fail(message) { return Object.assign(new Error(message), { status: 400, businessPlanError: true }); }
function masterRequirements(business) {
  // Deferred to keep the draft validator independent of activity module initialization.
  const { activityDefinition } = require('./business-activity-preview');
  const { economicsFor } = require('./business-activity-details');
  const rows = new Map();
  const add = row => { if (!rows.has(row.key)) rows.set(row.key, row); };
  for (const rule of activityDefinition(business).rules) {
    const value = economicsFor(rule.key);
    add({ key: value.customerKey, entity: 'Customer', purpose: rule.divisionKey, currency: 'CAD' });
    if (value.vendorKey) add({ key: value.vendorKey, entity: 'Vendor', purpose: 'Inventory supplier', currency: 'CAD' });
    const stock = value.cohort === 'supply-order';
    add({ key: value.itemKey, entity: 'Item', purpose: rule.divisionKey, itemType: stock ? 'Inventory' : 'Service',
      accountMappings: { IncomeAccountRef: value.incomeMapping, ...(stock ? { AssetAccountRef: 'inventoryAsset', ExpenseAccountRef: 'costOfGoods' } : {}) } });
    if (value.cohort === 'field-job') add({ key: 'field-technician', entity: 'Employee', purpose: 'Time-entry worker' });
  }
  return [...rows.values()].sort((a, b) => a.entity.localeCompare(b.entity) || a.key.localeCompare(b.key));
}
function validateMasterBindings(bindings, business) {
  if (bindings === undefined) return {};
  if (!bindings || Object.getPrototypeOf(bindings) !== Object.prototype) throw fail('Business record choices must be an object.');
  const requirements = new Map(masterRequirements({ ...business, volumeProfile: 'flagship' }).map(row => [row.key, row]));
  const result = {}, physical = new Set();
  for (const [key, id] of Object.entries(bindings)) {
    if (!requirements.has(key) || (id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)))) throw fail('Business record choices contain an unsupported role or record ID.');
    if (id) {
      const identity = requirements.get(key).entity + ':' + id;
      if (physical.has(identity)) throw fail('Each distinct business identity needs its own company record.');
      physical.add(identity); result[key] = id;
    }
  }
  return result;
}
async function readBusinessMasters(qbo, scope, now = () => Date.now()) {
  const budget = { pages: 16, records: 16000, deadline: now() + 60000 }, options = {}, completeness = {};
  await Promise.all(Object.entries(SOURCE).map(async ([entity, source]) => {
    const observed = await readSource(qbo, source, null, budget);
    const valid = record => record && typeof record.Id === 'string' && record.Id.length > 0;
    completeness[entity] = !observed.error && !observed.truncated && observed.records.every(valid);
    options[entity] = observed.records.filter(valid).map(record => ({ id: record.Id, name: String(record.DisplayName || record.Name || ''),
      active: typeof record.Active === 'boolean' ? record.Active : null, currency: record.CurrencyRef?.value || null,
      itemType: record.Type || null, project: record.IsProject === true,
      accountRefs: Object.fromEntries(['IncomeAccountRef', 'AssetAccountRef', 'ExpenseAccountRef'].map(key => [key, record[key]?.value || null])),
      syncToken: record.SyncToken == null ? null : String(record.SyncToken) }));
  }));
  return { ...scope, observedAt: new Date(now()).toISOString(), options, completeness, sourceHash: hash({ options, completeness }) };
}
function inspectBusinessMasters(view, observed) {
  if (['realmId', 'environment', 'connectionId'].some(key => view[key] !== observed[key])) throw Object.assign(fail('The company changed. Reload before checking business records.'), { status: 409 });
  const source = view.draft || view.proposal, requirements = masterRequirements(source.business), bindings = source.masterBindings || {};
  const rows = requirements.map(requirement => {
    const id = bindings[requirement.key] || null;
    const result = (status, reason, record) => ({ ...requirement, id, name: record?.name || null, status, reason });
    if (!id) return result('unassigned', 'Choose an existing record explicitly or prepare a new one. Names do not establish ownership.');
    if (view.draft?.connectionMatches === false || observed.completeness[requirement.entity] !== true) return result('unverified', 'The saved connection or company list needs to be checked again.');
    const matches = observed.options[requirement.entity].filter(record => record.id === id);
    if (matches.length !== 1) return result('unavailable', 'The selected record was not found exactly once.');
    const record = matches[0];
    if (record.active !== true) return result(record.active === false ? 'inactive' : 'unverified', 'The selected record must be confirmed active.', record);
    if (requirement.currency && record.currency !== requirement.currency) return result(record.currency ? 'incompatible' : 'unverified', 'This role requires an explicitly verified CAD record.', record);
    if (requirement.entity === 'Customer' && record.project) return result('incompatible', 'Choose the customer identity; project setup is a separate requirement.', record);
    if (requirement.itemType && record.itemType !== requirement.itemType) return result('incompatible', 'This role requires item type ' + requirement.itemType + '.', record);
    for (const [reference, mapping] of Object.entries(requirement.accountMappings || {})) {
      if (!source.mappings[mapping]) return result('unverified', 'First assign the business account for ' + mapping + '.', record);
      if (record.accountRefs[reference] !== source.mappings[mapping]) return result('incompatible', 'The product account does not match the saved ' + mapping + ' choice.', record);
    }
    return result('compatible', 'Observed fields fit this role. Selection does not approve balances, ownership, tax or historical use.', record);
  });
  return { ...observed, rows, source: { kind: view.draft ? 'saved_draft' : 'proposal', blueprintHash: view.draft?.contentHash || null },
    totals: Object.fromEntries(Object.keys(SOURCE).map(entity => [entity, rows.filter(row => row.entity === entity).length])),
    unresolved: rows.filter(row => row.status !== 'compatible').length, readyToExecute: false,
    limitations: ['These requirements cover the current activity template, not the full business population or project and dimension setup.', 'Explicit saved selections identify intended use only. Origin, inventory starting quantities, tax treatment and baseline approval remain separate.'] };
}
module.exports = { masterRequirements, validateMasterBindings, readBusinessMasters, inspectBusinessMasters };
