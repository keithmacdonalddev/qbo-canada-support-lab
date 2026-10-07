'use strict';
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { validateCompilation } = require('./business-readback');
const { createBusinessGraphReader } = require('./business-graph-readback');
const { createBusinessTransactionReader } = require('./business-reference');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/;
const TAXED = new Set(['Estimate', 'Invoice', 'SalesReceipt', 'PurchaseOrder', 'Bill']);
const sameScope = (a, b) => ['environment', 'realmId', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_VERIFICATION_UNAVAILABLE' }); }
const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000000;
// The expectation must have been retained inside the approved immutable policy.
// Never learn expected tax from the actual QBO response being checked.
function taxExpectation(policy, compiled) {
  if (!TAXED.has(compiled.entity)) return null;
  const expected = policy.readbackTax;
  if (expected === undefined) return null;
  if (!expected || expected.version !== 1 || !cents(expected.totalTaxCents) || !Array.isArray(expected.lines) || expected.lines.length > 100) fail('Approved tax expectations are malformed.');
  let sum = 0;
  for (const line of expected.lines) {
    if (!line || typeof line.rateId !== 'string' || !QBO_ID.test(line.rateId) || typeof line.percent !== 'number' || !Number.isFinite(line.percent) || line.percent < 0 || line.percent > 100 || !cents(line.taxableCents) || !cents(line.amountCents)) fail('Approved tax line expectations are malformed.');
    sum += line.amountCents;
  }
  if (sum !== expected.totalTaxCents) fail('Approved tax lines do not match their expected total.');
  const payload = JSON.parse(compiled.request.body), sales = ['Estimate', 'Invoice', 'SalesReceipt'].includes(compiled.entity);
  const code = policy.tax?.[sales ? 'salesTax' : 'purchaseTax'];
  if (payload.GlobalTaxCalculation !== 'TaxExcluded' || policy.tax?.calculation !== 'TaxExcluded' || typeof code !== 'string' || !QBO_ID.test(code) || !Array.isArray(payload.Line) || !payload.Line.length || payload.Line.some(line => line[line.DetailType]?.TaxCodeRef?.value !== code)) fail('The compiled transaction differs from its approved tax code policy.');
  return { version: 1, totalTaxCents: expected.totalTaxCents, lines: expected.lines.map(line => ({ rateId: line.rateId, percent: line.percent, taxableCents: line.taxableCents, amountCents: line.amountCents })) };
}
// Internal composition only: no routes, startup, storage preparation or activation.
// All models/adapters come from server code; the bound scope and operation cannot
// be overridden by a tool/request payload passed to the returned graph reader.
function createBusinessVerificationRuntime({ scope, operationId, planHash, Steps, transaction, assertReady, access, writerFence, plans, now = () => Date.now() }) {
  scope = scoped(scope);
  if (!ID.test(operationId || '') || !HASH.test(planHash || '') || !Steps || [transaction, assertReady, access?.authorize, access?.resolveClient, writerFence?.graphSnapshot, plans?.loadIntent, now].some(value => typeof value !== 'function')) throw new TypeError('Verification needs an exact operation and concrete runtime adapters');
  const { authorize, resolveClient } = access, { graphSnapshot } = writerFence, { loadIntent } = plans;
  const checkScope = value => { if (!sameScope(value, scope)) fail('Verification cannot switch its bound company.'); };
  const checkSignal = signal => { if (signal?.aborted) fail('Business verification was cancelled.'); };
  const authority = async (value, action, options = {}) => { checkScope(value); checkSignal(options.signal); const actor = await authorize(scope, action, options); checkSignal(options.signal); return actor; };
  const readRecord = createBusinessTransactionReader({ authorize: authority, resolveClient, now });
  const readFence = async (value, { signal } = {}) => {
    checkScope(value); checkSignal(signal); await assertReady();
    const actor = await authority(scope, 'operations.read', { signal });
    return transaction(async session => {
      checkSignal(signal); const current = await authority(scope, 'operations.read', { session, signal });
      if (current?.actorId !== actor?.actorId || current?.ownerId !== actor?.ownerId) fail('The graph reader changed.');
      const snapshot = await graphSnapshot({ scope, intent: { operationId, planHash }, session }); checkSignal(signal);
      return { ...snapshot, unresolved: null };
    }, { signal });
  };
  const loadTaxPolicy = async (value, compiled, { signal } = {}) => {
    checkScope(value); checkSignal(signal); const request = validateCompilation(compiled); checkScope(request.scope);
    const actor = await authority(scope, 'operations.read', { signal });
    // Locate the ORIGINAL operation, including earlier-period steps refreshed by
    // this operation. loadIntent validates its immutable manifest and policy hash.
    const row = await Steps.findOne({ ...scope, logicalKey: compiled.logicalKey }).select('operationId planHash fingerprint entity state dispatch').maxTimeMS(3000).lean(); checkSignal(signal);
    if (!row || !['saved', 'verified'].includes(row.state) || !ID.test(String(row.operationId)) || !HASH.test(row.planHash || '') || row.entity !== compiled.entity || row.fingerprint !== compiled.intentHash || row.dispatch?.compilationHash !== compiled.compilationHash || row.dispatch?.requestHash !== request.requestHash) fail('The original managed transaction is unavailable.');
    const intent = await loadIntent(scope, String(row.operationId), compiled.logicalKey); checkSignal(signal);
    if (!intent || intent.version !== 1 || !sameScope(intent.scope, scope) || intent.operationId !== String(row.operationId) || intent.planHash !== row.planHash || intent.logicalKey !== compiled.logicalKey || intent.entity !== compiled.entity || intent.fingerprint !== compiled.intentHash || hash(intent.step) !== compiled.intentHash) fail('The original transaction intent changed.');
    const policy = intent.policy;
    if (!policy || policy.version !== 1 || policy.status !== 'approved' || !sameScope(policy.scope, scope) || policy.country !== 'CA' || policy.currency !== 'CAD' || policy.stepHash !== compiled.intentHash || !HASH.test(policy.evidenceHash || '')) fail('The original approved Canadian policy is unavailable.');
    const expectation = taxExpectation(policy, compiled);
    const current = await authority(scope, 'operations.read', { signal }); checkSignal(signal);
    if (current?.actorId !== actor?.actorId || current?.ownerId !== actor?.ownerId) fail('The graph reader changed.');
    return expectation ? { ...expectation, status: 'approved', scope, compilationHash: compiled.compilationHash, evidenceHash: hash({ scope, operationId: intent.operationId, planHash: intent.planHash, policyHash: hash(policy), compilationHash: compiled.compilationHash, expectation }) } : null;
  };
  const reader = createBusinessGraphReader({ Steps, transaction, assertReady, authorize: authority, readFence, readRecord, loadTaxPolicy, now });
  const loadGraphReadback = input => { checkScope(input?.scope); return reader(input); };
  const boundSnapshot = input => {
    checkScope(input?.scope);
    if (input?.intent?.operationId !== operationId || input?.intent?.planHash !== planHash) fail('The verification operation changed.');
    return graphSnapshot(input);
  };
  return { loadGraphReadback, graphSnapshot: boundSnapshot, readRecord, loadTaxPolicy, readFence };
}
module.exports = { createBusinessVerificationRuntime, taxExpectation };
