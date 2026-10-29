'use strict';
const { hash, canonical, date, shift } = require('./business-calendar');
const CHANGE_ON = '2025-04-01', REGIME = 'CA-NS-2025-postpaid';
const SOURCE = 'https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/notice342/nova-scotia-hst-rate-decrease-questions-answers-general-transitional-rules-personal-property-services.html';
const QID = /^\d{1,30}$/;
const CHARGES = new Set(['Estimate', 'PurchaseOrder', 'Invoice', 'Bill', 'SalesReceipt', 'Purchase', 'VendorCredit']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_DATED_TAX_UNVERIFIED' }); }
function exact(value, keys) { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Use the complete supported Nova Scotia tax transition.'); }
function pair(value) { exact(value, ['salesTax', 'purchaseTax']); if (!Object.values(value).every(id => typeof id === 'string' && QID.test(id))) fail('Both tax directions need exact existing code IDs.'); }
function validateDatedTax(value, business, mappings) {
  exact(value, ['version', 'regime', 'salesTax', 'purchaseTax']);
  if (value.version !== 1 || value.regime !== REGIME || ![1, 2].includes(business.activityTemplateVersion ?? 1)) fail('This transition supports the original and continuing postpaid business schedules; customer credits require their original invoice tax.');
  date(business.openingDate); if (business.openingDate >= CHANGE_ON) fail('This historical transition requires a business opening before April 2025.');
  pair({ salesTax: mappings.salesTax, purchaseTax: mappings.purchaseTax }); pair({ salesTax: value.salesTax, purchaseTax: value.purchaseTax });
  if (value.salesTax === mappings.salesTax || value.purchaseTax === mappings.purchaseTax) fail('Choose the separate 14-percent codes after the historical 15-percent codes.');
  return JSON.parse(canonical(value));
}
function bindDatedTax(business, mappings) {
  if (business.datedTax === undefined) return null;
  const value = validateDatedTax(business.datedTax, business, mappings);
  return { version: 1, regime: REGIME, openingDate: business.openingDate, before: { salesTax: mappings.salesTax, purchaseTax: mappings.purchaseTax }, after: { salesTax: value.salesTax, purchaseTax: value.purchaseTax } };
}
function validateDatedTaxContext(value) {
  exact(value, ['version', 'regime', 'openingDate', 'before', 'after']); pair(value.before); pair(value.after);
  validateDatedTax({ version: value.version, regime: value.regime, ...value.after }, { openingDate: value.openingDate, activityTemplateVersion: 2 }, value.before);
  return value;
}
function datedTaxChoice(context, key, on) {
  validateDatedTaxContext(context); date(on);
  if (!['salesTax', 'purchaseTax'].includes(key) || on < context.openingDate) fail('The tax choice is outside the supported business history.');
  return { id: (on < CHANGE_ON ? context.before : context.after)[key], percent: on < CHANGE_ON ? 15 : 14 };
}
function assertDatedTaxPolicy(step, policy) {
  const context = step.details?.datedTax;
  if (context === undefined) { if (policy?.datedTax !== undefined) fail('A tax transition cannot be added to an original unscheduled activity.'); return null; }
  validateDatedTaxContext(context);
  if (!CHARGES.has(step.entity)) fail('A collection or credit cannot be retaxed by its later posting date.');
  const key = ['Estimate', 'Invoice', 'SalesReceipt'].includes(step.entity) ? 'salesTax' : 'purchaseTax', selected = datedTaxChoice(context, key, step.txnDate);
  if (step.details.taxMapping !== key || step.references.filter(row => row.entity === 'TaxCode' && row.key === key && row.id === selected.id).length !== 1) fail('The activity does not retain its exact dated tax choice.');
  if (policy) {
    const lines = policy.readbackTax?.lines;
    if (canonical(policy.datedTax ?? null) !== canonical(context) || policy.tax?.[key] !== selected.id || !Array.isArray(lines) || lines.length !== 1 || lines[0].percent !== selected.percent) fail('The independently observed tax must be 15 percent before April 2025 and 14 percent afterward.');
  }
  return selected;
}
function permitsDatedConversion(step, policy, source, sourceCode, newCode) {
  if (step.details?.datedTax === undefined) return false;
  assertDatedTaxPolicy(step, policy);
  if (!((step.entity === 'Invoice' && source.entity === 'Estimate') || (step.entity === 'Bill' && source.entity === 'PurchaseOrder'))) return false;
  const context = step.details.datedTax, on = source.record.TxnDate, key = step.entity === 'Invoice' ? 'salesTax' : 'purchaseTax';
  if (on >= CHANGE_ON || step.txnDate < CHANGE_ON) return false;
  const before = datedTaxChoice(context, key, on), after = datedTaxChoice(context, key, step.txnDate), taxes = source.record.TxnTaxDetail?.TaxLine, original = source.originalStep, approved = source.originalPolicy;
  if (!original || !approved || original.entity !== source.entity || original.txnDate !== on || hash(original) !== source.fingerprint || approved.stepHash !== source.fingerprint || canonical(original.details.datedTax ?? null) !== canonical(context)) return false;
  assertDatedTaxPolicy(original, approved);
  const { evidenceHash, ...originalPolicy } = approved, expected = approved.readbackTax, amount = value => { const cents = Math.round(value * 100); return typeof value === 'number' && Number.isSafeInteger(cents) && cents >= 0 && Math.abs(value * 100 - cents) < 0.00001 ? cents : null; };
  if (hash(originalPolicy) !== evidenceHash || sourceCode !== before.id || newCode !== after.id || before.id === after.id || !Array.isArray(taxes) || taxes.length !== 1 || expected.lines.length !== 1 || amount(source.record.TxnTaxDetail.TotalTax) !== expected.totalTaxCents) return false;
  const actual = taxes[0], expectedLine = expected.lines[0], detail = actual.TaxLineDetail;
  return actual.DetailType === 'TaxLineDetail' && detail?.PercentBased === true && detail.TaxPercent === before.percent && detail.TaxRateRef?.value === expectedLine.rateId && amount(actual.Amount) === expectedLine.amountCents && amount(detail.NetAmountTaxable) === expectedLine.taxableCents;
}
function datedTaxChoicesReady(context, setup) {
  validateDatedTaxContext(context);
  return setup.completeness.taxCodes === true && ['before', 'after'].every(phase => ['salesTax', 'purchaseTax'].every(key => {
    const rows = setup.options.taxCodes.filter(row => row.id === context[phase][key]), direction = key === 'salesTax' ? 'sales' : 'purchases';
    return rows.length === 1 && rows[0].active === true && rows[0].taxable === true && rows[0][direction] === true;
  }));
}
async function readDatedTaxEvidence(business, mappings, client, now = Date.now()) {
  const context = bindDatedTax(business, mappings); if (!context) return null;
  const cache = new Map();
  const read = async (entity, id) => {
    const key = entity + ':' + id;
    if (!cache.has(key)) {
      if (cache.size >= 12) fail('Tax transition definitions exceed their bounded source budget.');
      const response = await client.read(entity.toLowerCase(), id), record = response?.[entity];
      if (!record || record.Id !== id || typeof record.SyncToken !== 'string' || record.sparse === true || record.Active !== true) fail('Every scheduled tax definition must be complete, active and current.');
      cache.set(key, { entity, id, recordHash: hash(record), record });
    }
    return cache.get(key).record;
  };
  for (const phase of ['before', 'after']) for (const key of ['salesTax', 'purchaseTax']) {
    const code = await read('TaxCode', context[phase][key]), direction = key === 'salesTax' ? 'SalesTaxRateList' : 'PurchaseTaxRateList', details = code[direction]?.TaxRateDetail;
    if (code.Taxable !== true || !Array.isArray(details) || details.length !== 1 || details[0].TaxTypeApplicable !== 'TaxOnAmount' || (details[0].TaxOnTaxOrder != null && details[0].TaxOnTaxOrder !== 0)) fail('This transition requires one ordinary HST rate in each direction.');
    const rateId = details[0].TaxRateRef?.value; if (typeof rateId !== 'string' || !QID.test(rateId)) fail('The scheduled code needs its exact HST rate.');
    const rate = await read('TaxRate', rateId), dates = phase === 'before' ? [context.openingDate, shift(CHANGE_ON, -1)] : [CHANGE_ON];
    for (const on of dates) if (require('./business-tax-policy').applicableRate(rate, on) !== (phase === 'before' ? 15 : 14)) fail('The selected codes do not establish the expected Nova Scotia 15-to-14-percent history.');
  }
  const value = { version: 1, source: SOURCE, context, sources: [...cache.values()] };
  return { ...value, sourceHash: hash(value), observedAt: new Date(now).toISOString() };
}
module.exports = { CHANGE_ON, REGIME, SOURCE, CHARGES, validateDatedTax, bindDatedTax, validateDatedTaxContext, datedTaxChoice, assertDatedTaxPolicy, permitsDatedConversion, datedTaxChoicesReady, readDatedTaxEvidence };
