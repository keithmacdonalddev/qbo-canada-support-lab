'use strict';
const { hash, date } = require('./business-calendar');
const { lifecyclePolicy } = require('./business-lifecycle-policy');
const TAXED = new Set(['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_TAX_UNVERIFIED' }); }
function rateDate(value) {
  if (typeof value !== 'string') fail('A dated tax definition is required.');
  // The SDK permits dateTime. Keep its explicit local business date rather than
  // shifting midnight to the previous/next date through the host timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { date(value); return value; }
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('The tax timestamp needs an unambiguous midnight business-date boundary.');
  date(value.slice(0, 10)); return value.slice(0, 10);
}
function applicableRate(record, txnDate) {
  date(txnDate);
  if (!record || typeof record.Id !== 'string' || typeof record.SyncToken !== 'string' || record.Active !== true) fail('The selected tax rate is not an active complete record.');
  const values = record.EffectiveTaxRate;
  if (!Array.isArray(values) || !values.length || values.length > 100) fail('Dated tax-rate history is required for this business period.');
  const ordered = values.map(rate => ({ rate, start: rateDate(rate.EffectiveDate), end: rate.EndDate == null ? null : rateDate(rate.EndDate) })).sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i], next = ordered[i + 1];
    if ((item.end && item.end < item.start) || (next && (next.start === item.start || (item.end && item.end > next.start)))) fail('The tax-rate history has overlapping or ambiguous boundaries.');
  }
  // A later effective start replaces the earlier value for the SAME TaxRate ID.
  // Retain the original date/time definitions in policy evidence for review.
  const selected = ordered.filter(item => item.start <= txnDate).at(-1);
  if (!selected || (selected.end && txnDate >= selected.end) || typeof selected.rate.RateValue !== 'number' || !Number.isFinite(selected.rate.RateValue) || selected.rate.RateValue < 0 || selected.rate.RateValue > 100 || !/^\d+(?:\.\d{1,6})?$/.test(String(selected.rate.RateValue))) fail('Exactly one supported effective tax rate is required.');
  return selected.rate.RateValue;
}
// Integer half-up rounding, using six decimal places of a percentage. Expected
// tax is derived from company tax definitions, never from the created response.
function taxCents(base, percent) {
  if (!Number.isSafeInteger(base) || base < 0 || base > 1000000000000) fail('Taxable amount exceeds its reviewed budget.');
  const micros = BigInt(Math.round(percent * 1000000));
  return Number((BigInt(base) * micros + 50000000n) / 100000000n);
}
async function deriveBusinessPolicies(assembly, client, authorityHash, now = Date.now()) {
  const cache = new Map(), sources = [];
  async function read(entity, id) {
    const key = entity + ':' + id;
    if (!cache.has(key)) {
      if (cache.size >= 25) fail('Tax definitions exceed their read budget.');
      const response = await client.read(entity.toLowerCase(), id), record = response?.[entity];
      if (!record || record.Id !== id || typeof record.SyncToken !== 'string' || record.sparse === true) fail('A complete tax definition could not be read.');
      cache.set(key, record); sources.push({ entity, id, recordHash: hash(record), record });
    }
    return cache.get(key);
  }
  const policies = [];
  for (const entry of assembly.candidate.entries) {
    if (entry.kind !== 'create') continue;
    const step = entry.step, refs = Object.fromEntries(step.references.filter(ref => ref.entity === 'TaxCode').map(ref => [ref.key, ref.id]));
    const lifecycle = lifecyclePolicy(step);
    const policy = { ...(lifecycle ? { lifecycle } : {}), version: 1, scope: assembly.candidate.scope, status: 'approved', country: 'CA', currency: 'CAD', fromDate: assembly.candidate.fromDate, throughDate: assembly.candidate.throughDate, stepHash: hash(step), authorityHash,
      tax: { calculation: 'TaxExcluded', ...refs } };
    if (TAXED.has(step.entity)) {
      const sales = ['Estimate', 'Invoice', 'SalesReceipt'].includes(step.entity), codeId = refs[sales ? 'salesTax' : 'purchaseTax'];
      if (!codeId) fail('The activity has no exact Canadian tax code.');
      const code = await read('TaxCode', codeId), list = code[sales ? 'SalesTaxRateList' : 'PurchaseTaxRateList']?.TaxRateDetail;
      if (code.Active !== true || !Array.isArray(list) || list.length > 5 || (code.Taxable !== false && !list.length)) fail('The selected tax code lacks complete applicable rates.');
      const lines = [], ids = new Set(), base = step.details.lines.reduce((sum, line) => sum + line.amountCents, 0);
      for (const detail of list) {
        const id = detail.TaxRateRef?.value;
        if (typeof id !== 'string' || !/^\d{1,30}$/.test(id) || ids.has(id) || detail.TaxTypeApplicable !== 'TaxOnAmount' || (detail.TaxOnTaxOrder != null && detail.TaxOnTaxOrder !== 0)) fail('Compound or ambiguous tax rules require a reviewed policy.');
        ids.add(id); const rate = await read('TaxRate', id), percent = applicableRate(rate, step.txnDate);
        lines.push({ rateId: id, percent, taxableCents: base, amountCents: taxCents(base, percent) });
      }
      policy.readbackTax = { version: 1, totalTaxCents: lines.reduce((sum, line) => sum + line.amountCents, 0), lines };
      policy.taxSources = sources.filter(source => (source.entity === 'TaxCode' && source.id === codeId) || (source.entity === 'TaxRate' && ids.has(source.id))).map(source => ({ ...source }));
    }
    policy.derivedAt = new Date(now).toISOString();
    policy.evidenceHash = hash(policy);
    policies.push({ logicalKey: step.logicalKey, policy });
  }
  return policies;
}
async function verifyBusinessTaxSources(policy, client) {
  if (!policy.taxSources) return;
  for (const source of policy.taxSources) {
    if (!['TaxCode', 'TaxRate'].includes(source.entity) || hash(source.record) !== source.recordHash) fail('Retained tax policy evidence changed.');
    const response = await client.read(source.entity.toLowerCase(), source.id);
    if (hash(response?.[source.entity] || null) !== source.recordHash) fail('Tax definitions changed after this operation was reviewed. Prepare a new operation.');
  }
}
module.exports = { applicableRate, taxCents, deriveBusinessPolicies, verifyBusinessTaxSources };
