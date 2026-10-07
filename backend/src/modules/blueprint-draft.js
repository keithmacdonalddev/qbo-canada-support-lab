'use strict';
const { hash, date } = require('./business-calendar');
const { createDefinitionsService } = require('./rebuild-definitions');
const { readSource } = require('./coverage');
const MAPPINGS = Object.freeze({
  operatingBank: { label: 'Operating bank', entity: 'Account', types: ['Bank'], currency: 'CAD' },
  accountsReceivable: { label: 'Accounts receivable', entity: 'Account', types: ['Accounts Receivable'], subtypes: ['AccountsReceivable'], currency: 'CAD' },
  accountsPayable: { label: 'Accounts payable', entity: 'Account', types: ['Accounts Payable'], subtypes: ['AccountsPayable'], currency: 'CAD' },
  undepositedFunds: { label: 'Undeposited funds', entity: 'Account', types: ['Other Current Asset'], subtypes: ['UndepositedFunds'] },
  serviceIncome: { label: 'Service income', entity: 'Account', types: ['Income'] },
  supplyIncome: { label: 'Supply income', entity: 'Account', types: ['Income'] },
  careIncome: { label: 'Care-plan income', entity: 'Account', types: ['Income'] },
  operatingExpense: { label: 'Operating expense', entity: 'Account', types: ['Expense'] },
  inventoryAsset: { label: 'Inventory asset', entity: 'Account', types: ['Other Current Asset'], subtypes: ['Inventory'] },
  costOfGoods: { label: 'Cost of goods sold', entity: 'Account', types: ['Cost of Goods Sold'] },
  salesTax: { label: 'Sales tax code', entity: 'TaxCode' },
  purchaseTax: { label: 'Purchase tax code', entity: 'TaxCode' },
});
function problem(message, status = 400) { return Object.assign(new Error(message), { status, businessPlanError: true }); }
function strict(value, keys, name) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) throw problem(name + ' contains unsupported fields');
}
function validateDraftInput(input) {
  strict(input, ['requestKey', 'connectionId', 'baseHash', 'business', 'mappings', 'masterBindings'], 'Business plan');
  if (typeof input.requestKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestKey)) throw problem('A save request identifier is required');
  if (typeof input.connectionId !== 'string' || !/^[a-f0-9]{24}$/.test(input.connectionId)) throw problem('Reload the business plan before saving it');
  if (input.baseHash !== null && (typeof input.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseHash))) throw problem('The previously loaded plan version is required');
  strict(input.business, ['displayName', 'openingDate', 'historicalMonths', 'fiscalYearStartMonth', 'volumeProfile'], 'Business settings');
  const business = input.business;
  if (typeof business.displayName !== 'string' || business.displayName.trim().length < 2 || business.displayName.length > 120 || /[\u0000-\u001f]/.test(business.displayName)) throw problem('Use a business name of 2 to 120 characters');
  try { date(business.openingDate); } catch { throw problem('Choose a valid business opening date'); }
  if (!business.openingDate.endsWith('-01')) throw problem('The historical business calendar must start on the first day of a month');
  if (!Number.isInteger(business.historicalMonths) || business.historicalMonths < 1 || business.historicalMonths > 60) throw problem('Choose 1 to 60 months of planned history');
  if (!Number.isInteger(business.fiscalYearStartMonth) || business.fiscalYearStartMonth < 1 || business.fiscalYearStartMonth > 12) throw problem('Choose a valid fiscal-year starting month');
  if (!['development', 'flagship'].includes(business.volumeProfile)) throw problem('Choose a supported business volume');
  strict(input.mappings, Object.keys(MAPPINGS), 'Company mappings');
  const mappings = {};
  for (const key of Object.keys(MAPPINGS)) {
    const value = input.mappings[key] ?? null;
    if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value))) throw problem('Mappings must contain a record ID or remain unassigned');
    mappings[key] = value;
  }
  const masterBindings = require('./business-master-data').validateMasterBindings(input.masterBindings, business);
  return { masterBindings, requestKey: input.requestKey.toLowerCase(), connectionId: input.connectionId, baseHash: input.baseHash, business: { ...business, displayName: business.displayName.trim() }, mappings };
}
function buildDraftDefinition(input, proposal = createDefinitionsService().getFlagshipProfile()) {
  const value = validateDraftInput(input);
  return {
    publicSafeIdentity: { ...proposal.publicSafeIdentity, displayName: value.business.displayName, legalName: value.business.displayName },
    calendar: { openingDate: value.business.openingDate, historicalMonths: value.business.historicalMonths, fiscalYearStartMonth: value.business.fiscalYearStartMonth, timeZone: 'America/Halifax' },
    divisions: proposal.divisions.map(division => ({ ...division })), realismRules: [...proposal.realismRules],
    generationSeed: proposal.generationSeed, volumeProfile: value.business.volumeProfile, mappings: value.mappings, masterBindings: value.masterBindings,
  };
}
function draftView(doc, connectionId) {
  if (!doc) return null;
  const definition = doc.definition;
  return { id: String(doc._id), version: doc.version, contentHash: doc.contentHash, savedAt: doc.createdAt, status: 'draft', connectionMatches: String(doc.connectionId) === String(connectionId),
    business: { displayName: definition.publicSafeIdentity.displayName, openingDate: definition.calendar.openingDate, historicalMonths: definition.calendar.historicalMonths, fiscalYearStartMonth: definition.calendar.fiscalYearStartMonth, volumeProfile: definition.volumeProfile },
    mappings: definition.mappings, masterBindings: definition.masterBindings || {}, divisions: definition.divisions,
  };
}
function proposalView() {
  const proposal = createDefinitionsService().getFlagshipProfile();
  return { business: { displayName: proposal.publicSafeIdentity.displayName, openingDate: proposal.calendar.openingDate, historicalMonths: proposal.calendar.historicalMonths, fiscalYearStartMonth: proposal.calendar.fiscalYearStartMonth, volumeProfile: 'flagship' }, masterBindings: {}, mappings: Object.fromEntries(Object.keys(MAPPINGS).map(key => [key, null])), divisions: proposal.divisions };
}
function hasRates(list) {
  return Array.isArray(list?.TaxRateDetail) && list.TaxRateDetail.length > 0 && list.TaxRateDetail.every(detail => typeof detail?.TaxRateRef?.value === 'string' && detail.TaxRateRef.value.trim().length > 0);
}
async function readDraftSetup(qbo, scope, now = () => Date.now()) {
  const budget = { pages: 12, records: 12000, deadline: now() + 60000 };
  const sources = {};
  await Promise.all(['accounts', 'taxCodes', 'preferences'].map(async name => { sources[name] = await readSource(qbo, name, null, budget); }));
  const validRecord = record => record && typeof record.Id === 'string' && record.Id.length > 0;
  for (const name of ['accounts', 'taxCodes']) if (sources[name].records.some(record => !validRecord(record))) sources[name].truncated = true;
  const accountOptions = sources.accounts.records.filter(record => validRecord(record)).map(record => ({ id: String(record.Id), name: String(record.Name || ''), active: typeof record.Active === 'boolean' ? record.Active : null, type: record.AccountType || null, subtype: record.AccountSubType || null, currency: record.CurrencyRef?.value || null, syncToken: record.SyncToken == null ? null : String(record.SyncToken) }));
  const taxOptions = sources.taxCodes.records.filter(record => validRecord(record)).map(record => ({ id: String(record.Id), name: String(record.Name || ''), active: typeof record.Active === 'boolean' ? record.Active : null, taxable: record.Taxable ?? null, sales: hasRates(record.SalesTaxRateList), purchases: hasRates(record.PurchaseTaxRateList), syncToken: record.SyncToken == null ? null : String(record.SyncToken) }));
  const preferences = sources.preferences.records[0];
  const observations = { homeCurrency: preferences?.CurrencyPrefs?.HomeCurrency?.value || null, multicurrency: preferences?.CurrencyPrefs?.MultiCurrencyEnabled ?? null, classes: preferences?.AccountingInfoPrefs?.ClassTrackingPerTxnLine ?? null, locations: preferences?.AccountingInfoPrefs?.TrackDepartments ?? null };
  const completeness = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, !source.error && !source.truncated && (key !== 'preferences' || source.records.length === 1)]));
  const options = { accounts: accountOptions, taxCodes: taxOptions };
  return { ...scope, observedAt: new Date(now()).toISOString(), complete: Object.values(completeness).every(Boolean), completeness, options, observations, sourceHash: hash({ options, observations, completeness }), limitations: ['These are observed setup choices, not approved accounting or tax mappings.', 'Activation also requires verified business activity rules, record ownership and a reviewed starting baseline.'] };
}
module.exports = { MAPPINGS, validateDraftInput, buildDraftDefinition, draftView, proposalView, readDraftSetup, problem };
