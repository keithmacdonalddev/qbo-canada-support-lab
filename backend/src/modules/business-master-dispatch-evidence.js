'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { denied, scoped } = require('./qbo-write-contract');
const { assertPeriodControl } = require('./qbo-write-period');
const { MAPPINGS } = require('./blueprint-draft');
const { businessDate } = require('./business-activity-preview');
const HASH = /^[a-f0-9]{64}$/;
const fresh = (value, now) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value && Date.parse(value) <= now && now - Date.parse(value) <= 300000;
function expectedMappings(run) {
  return Object.fromEntries(Object.keys(MAPPINGS).map(key => [key, run.plan.source.mappings[key] || run.records.find(row => row.key === key && row.entity === 'Account' && row.state === 'verified')?.qboId || null]).filter(([, id]) => id));
}
function assertSelections(run, selections) {
  const expected = expectedMappings(run);
  if (!selections || Object.keys(selections).sort().join(',') !== Object.keys(expected).sort().join(',')) throw denied('Every assigned master prerequisite needs current exact-ID evidence.');
  for (const [key, id] of Object.entries(expected)) {
    const definition = MAPPINGS[key], record = selections[key];
    if (!record || record.id !== id || record.active !== true || (definition.types && !definition.types.includes(record.type)) || (definition.subtypes && !definition.subtypes.includes(record.subtype)) || (definition.currency && record.currency !== definition.currency) || (definition.entity === 'TaxCode' && record[key === 'salesTax' ? 'sales' : 'purchases'] !== true && record.taxable !== false)) throw denied('The current ' + definition.label + ' no longer fits the approved business.');
  }
  if ((selections.salesTax.taxable !== false) !== run.plan.salesTaxable) throw denied('The selected sales tax code changed taxable status after review.');
}
function assertMasterDispatchEvidence(run, ordinal, requestHash, proof, controls, now = Date.now()) {
  const scope = scoped({ environment: run.environment, realmId: run.realmId, connectionId: String(run.connectionId) });
  assertPeriodControl(controls, scope, String(run.ownerId));
  const { evidenceHash, ...content } = proof || {};
  if (!HASH.test(evidenceHash || '') || hash(content) !== evidenceHash || content.version !== 1 || canonical(content.scope) !== canonical(scope) || content.runId !== String(run._id) || content.planHash !== run.planHash || content.ordinal !== ordinal || content.requestHash !== requestHash || content.periodControlHash !== controls.contentHash || !fresh(content.setupObservedAt, now) || !fresh(content.countryObservedAt, now) || !fresh(content.observedAt, now) || !HASH.test(content.setupHash || '') || !HASH.test(content.countryHash || '') || content.country !== 'CA' || content.setupComplete !== true || content.homeCurrency !== 'CAD') throw denied('Fresh complete Canadian master-dispatch evidence is required.');
  assertSelections(run, content.selections);
  const stockRemains = run.plan.entries.some(entry => entry.entity === 'Item' && entry.itemType === 'Inventory' && run.records[entry.ordinal].state !== 'verified');
  if (stockRemains) {
    if (content.qboClosingVerified !== true) throw denied('QuickBooks closing preferences must remain explicitly readable before any master create.');
    if (content.inventoryTracking !== true || run.plan.inventoryStartDate > businessDate(new Date(now)) || run.plan.inventoryStartDate > run.plan.source.business.openingDate) throw denied('Inventory tracking and the original elapsed opening date must remain available.');
    for (const cutoff of [content.qboClosedThrough, controls.closedThrough, controls.reconciledThrough]) {
      if (cutoff != null && cutoff !== '') {
        try { date(cutoff); } catch { throw denied('Current protected accounting dates could not be verified.'); }
        if (run.plan.inventoryStartDate <= cutoff) throw denied('The approved inventory date is now protected. No unrelated master create is allowed.');
      }
    }
  }
  return proof;
}
function prepareMasterDispatchEvidence({ run, ordinal, requestHash, setup, country, controls, now = Date.now() }) {
  const scope = scoped({ environment: run.environment, realmId: run.realmId, connectionId: String(run.connectionId) });
  if (!setup || Object.keys(scope).some(key => setup[key] !== scope[key]) || !country || canonical(country.scope) !== canonical(scope)) throw denied('The company changed while reading master prerequisites.');
  const selections = {};
  for (const [key, id] of Object.entries(expectedMappings(run))) {
    const rows = setup.options[MAPPINGS[key].entity === 'Account' ? 'accounts' : 'taxCodes'].filter(row => row.id === id);
    if (rows.length !== 1) throw denied('A selected master prerequisite was not returned exactly once.');
    const record = rows[0];
    selections[key] = Object.fromEntries(['id', 'active', 'type', 'subtype', 'currency', 'taxable', 'sales', 'purchases', 'syncToken'].filter(field => record[field] !== undefined).map(field => [field, record[field]]));
  }
  const content = { version: 1, scope, runId: String(run._id), planHash: run.planHash, ordinal, requestHash, periodControlHash: controls?.contentHash || null,
    setupObservedAt: setup.observedAt, countryObservedAt: country.observedAt, observedAt: new Date(now).toISOString(), setupHash: setup.sourceHash, countryHash: country.recordHash, country: country.country,
    setupComplete: setup.complete === true && ['accounts', 'taxCodes', 'preferences'].every(key => setup.completeness[key] === true), homeCurrency: setup.observations.homeCurrency, inventoryTracking: setup.observations.inventoryTracking, qboClosedThrough: setup.observations.closedThrough || null, qboClosingVerified: setup.observations.closingDateVerified === true, selections };
  return assertMasterDispatchEvidence(run, ordinal, requestHash, { ...content, evidenceHash: hash(content) }, controls, now);
}
module.exports = { prepareMasterDispatchEvidence, assertMasterDispatchEvidence };
