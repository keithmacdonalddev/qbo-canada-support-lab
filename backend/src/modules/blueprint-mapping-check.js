'use strict';
const { MAPPINGS, problem } = require('./blueprint-draft');
function validateMappingRequest(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['connectionId', 'baseHash'].includes(key))) throw problem('Mapping check contains unsupported fields.');
  if (typeof input.connectionId !== 'string' || !/^[a-f0-9]{24}$/.test(input.connectionId) || (input.baseHash !== null && (typeof input.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseHash)))) throw problem('Reload the business plan before checking its mappings.');
  return input;
}
function assertMappingVersion(view, input) {
  validateMappingRequest(input);
  if (view.connectionId !== input.connectionId || (view.draft?.contentHash || null) !== input.baseHash) throw problem('The company or saved plan changed. Reload before checking mappings.', 409);
}
function checkBlueprintMappings(view, setup, input) {
  assertMappingVersion(view, input);
  if (['realmId', 'environment', 'connectionId'].some(key => setup[key] !== view[key])) throw problem('The company changed while checking mappings. Reload the business plan.', 409);
  const source = view.draft || view.proposal;
  const rows = Object.entries(MAPPINGS).map(([key, definition]) => {
    const id = source.mappings[key];
    const result = (status, reason, record) => ({ key, label: definition.label, id: id || null, name: record?.name || null, status, reason });
    if (!id) return result('unassigned', 'Choose and save a company record for this role.');
    if (view.draft?.connectionMatches === false) return result('unverified', 'This saved choice belongs to an earlier connection. Save it for the current connection before validation.');
    const group = definition.entity === 'Account' ? 'accounts' : 'taxCodes';
    if (setup.completeness[group] !== true) return result('unverified', 'The company list could not be read completely. Retry the check.');
    const matches = setup.options[group].filter(record => record.id === id);
    if (matches.length !== 1) return result('unavailable', 'The saved record was not found exactly once in the current company list.');
    const record = matches[0];
    if (record.active === false) return result('inactive', 'The saved record is inactive.', record);
    if (record.active !== true) return result('unverified', 'The record’s active status was not returned by QuickBooks.', record);
    if (definition.types && !definition.types.includes(record.type)) return result('incompatible', 'This role requires account type ' + definition.types.join(' or ') + '.', record);
    if (definition.subtypes && !definition.subtypes.includes(record.subtype)) return result(record.subtype ? 'incompatible' : 'unverified', 'This role requires detail type ' + definition.subtypes.join(' or ') + '.', record);
    if (definition.currency && record.currency !== definition.currency) return result(record.currency ? 'incompatible' : 'unverified', 'This role requires an explicitly verified ' + definition.currency + ' account.', record);
    if (definition.entity === 'TaxCode') {
      const direction = key === 'salesTax' ? 'sales' : 'purchases';
      if (record[direction] !== true) return result('review_required', 'No complete ' + direction + ' tax-rate references were returned. Confirm how this code applies, including any exemption.', record);
      return result('review_required', 'The code has ' + direction + ' rate references. Rates, place of supply, exemptions and recoverability still need an approved transaction tax policy.', record);
    }
    return result('compatible', 'The observed account matches this role’s structural requirements; its balances and business use still need baseline review.', record);
  });
  const currency = setup.completeness.preferences !== true || !setup.observations.homeCurrency
    ? { status: 'unverified', reason: 'Company home currency could not be verified.' }
    : setup.observations.homeCurrency === 'CAD'
      ? { status: 'compatible', reason: 'Company home currency is CAD.' }
      : { status: 'incompatible', reason: 'The flagship Canadian business plan requires CAD home currency.' };
  return { realmId: view.realmId, environment: view.environment, connectionId: view.connectionId,
    source: { kind: view.draft ? 'saved_draft' : 'proposal', blueprintHash: view.draft?.contentHash || null, version: view.draft?.version || null },
    observedAt: setup.observedAt, sourceHash: setup.sourceHash, rows, currency,
    compatibleAccounts: rows.filter(row => row.status === 'compatible').length,
    unresolvedMappings: rows.filter(row => row.status !== 'compatible').length,
    readyToActivate: false,
    remaining: ['Approve transaction-specific Canadian tax treatment.', 'Review starting balances and decide which existing records belong to the business.', 'Complete transaction details, activity execution and report verification before activation.'],
  };
}
module.exports = { validateMappingRequest, assertMappingVersion, checkBlueprintMappings };
