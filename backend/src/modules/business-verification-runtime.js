'use strict';
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { validateCompilation } = require('./business-readback');
const { assertOwnerAttribution } = require('./business-owner-attribution');
const { createBusinessGraphReader } = require('./business-graph-readback');
const { createBusinessTransactionReader, createBusinessReferenceReader } = require('./business-reference');
const { accountPostingEvidence, endpointFor } = require('./business-receivables-route');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, QBO_ID = /^\d{1,30}$/;
const TAXED = new Set(['Estimate', 'Invoice', 'SalesReceipt', 'CreditMemo', 'PurchaseOrder', 'Bill']);
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
  const payload = JSON.parse(compiled.request.body), sales = ['Estimate', 'Invoice', 'SalesReceipt', 'CreditMemo'].includes(compiled.entity);
  const code = policy.tax?.[sales ? 'salesTax' : 'purchaseTax'];
  if (payload.GlobalTaxCalculation !== 'TaxExcluded' || policy.tax?.calculation !== 'TaxExcluded' || typeof code !== 'string' || !QBO_ID.test(code) || !Array.isArray(payload.Line) || !payload.Line.length || payload.Line.some(line => line[line.DetailType]?.TaxCodeRef?.value !== code)) fail('The compiled transaction differs from its approved tax code policy.');
  return { version: 1, totalTaxCents: expected.totalTaxCents, lines: expected.lines.map(line => ({ rateId: line.rateId, percent: line.percent, taxableCents: line.taxableCents, amountCents: line.amountCents })) };
}
// Internal composition only: no routes, startup, storage preparation or activation.
// All models/adapters come from server code; the bound scope and operation cannot
// be overridden by a tool/request payload passed to the returned graph reader.
function createBusinessVerificationRuntime({ scope, operationId, planHash, Steps, Receipts, Authorities, Audits, Writers, transaction, assertReady, access, writerFence, plans, retainSources = false, now = () => Date.now() }) {
  scope = scoped(scope);
  if (!ID.test(operationId || '') || !HASH.test(planHash || '') || !Steps || [transaction, assertReady, access?.authorize, access?.resolveClient, writerFence?.graphSnapshot, plans?.loadIntent, now].some(value => typeof value !== 'function')) throw new TypeError('Verification needs an exact operation and concrete runtime adapters');
  const { authorize, resolveClient } = access, { graphSnapshot } = writerFence, { loadIntent } = plans;
  const checkScope = value => { if (!sameScope(value, scope)) fail('Verification cannot switch its bound company.'); };
  const checkSignal = signal => { if (signal?.aborted) fail('Business verification was cancelled.'); };
  const authority = async (value, action, options = {}) => { checkScope(value); checkSignal(options.signal); const actor = await authorize(scope, action, options); checkSignal(options.signal); return actor; };
  const rawRecord = createBusinessTransactionReader({ authorize: authority, resolveClient, now });
  const references = createBusinessReferenceReader({ authorize: authority, resolveClient, now });
  const readFence = async (value, { signal } = {}) => {
    checkScope(value); checkSignal(signal); await assertReady();
    const actor = await authority(scope, 'operations.read', { signal });
    return transaction(async session => {
      checkSignal(signal); const current = await authority(scope, 'operations.read', { session, signal });
      if (current?.actorId !== actor?.actorId || current?.ownerId !== actor?.ownerId) fail('The graph reader changed.');
      const snapshot = await graphSnapshot({ scope, intent: { operationId, planHash }, session }); checkSignal(signal);
      return { ...snapshot, unresolved: snapshot.unresolved ?? null };
    }, { signal });
  };
  const accountRead = async (value, entity, qboId, { signal } = {}) => {
    const observed = await rawRecord(value, entity, qboId, { signal });
    if (!['Invoice', 'Payment', 'BillPayment'].includes(entity) || observed.record[entity === 'BillPayment' ? 'APAccountRef' : 'ARAccountRef'] !== undefined) return observed;
    // Restrict compatibility to a retained managed save, never an arbitrary invoice.
    const row = await Steps.findOne({ ...scope, entity, qboId }).select('operationId planHash logicalKey entity fingerprint state compilation dispatch receipt qboId').maxTimeMS(3000).lean(); checkSignal(signal);
    const compiled = row?.compilation;
    if (!row || !['saved', 'verified'].includes(row.state) || !ID.test(String(row.operationId)) || !HASH.test(row.planHash || '') || row.entity !== entity || row.qboId !== qboId || compiled?.entity !== entity || compiled.logicalKey !== row.logicalKey || compiled.intentHash !== row.fingerprint || compiled.compilationHash !== row.dispatch?.compilationHash || compiled.request?.requestHash !== row.dispatch?.requestHash || row.receipt?.dispatchKey !== row.dispatch?.key || row.receipt?.requestHash !== row.dispatch?.requestHash || row.receipt?.qboId !== qboId) fail('The omitted invoice account requires its original saved compilation and receipt.');
    validateCompilation(compiled);
    await assertOwnerAttribution({ Receipts, Authorities, Audits }, scope, row);
    const intent = await loadIntent(scope, String(row.operationId), row.logicalKey, { policyHead: row.dispatch.policyAmendmentHash || null }); checkSignal(signal);
    if (!intent || intent.version !== 1 || !sameScope(intent.scope, scope) || intent.operationId !== String(row.operationId) || intent.planHash !== row.planHash || intent.logicalKey !== row.logicalKey || intent.entity !== entity || intent.fingerprint !== row.fingerprint || hash(intent.step) !== row.fingerprint || intent.policy?.status !== 'approved' || intent.policy.stepHash !== row.fingerprint || (row.dispatch.policyHash && row.dispatch.policyHash !== hash(intent.policy))) fail('The original approved invoice account policy changed.');
    const bindings = intent.step.references.filter(binding => binding.entity === 'Account' && binding.key === (entity === 'BillPayment' ? 'accountsPayable' : 'accountsReceivable'));
    if (bindings.length !== 1) fail('The original invoice needs one approved receivables account.');
    const beforeFence = await readFence(scope, { signal }), actor = await authority(scope, 'operations.read', { signal });
    const accountObserved = await references(scope, 'Account', bindings[0].id, { signal }); checkSignal(signal);
    const client = await resolveClient(scope, { signal }); checkSignal(signal);
    const { QBOClient } = require('./qbo-client');
    const expectedBase = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
    const clientScope = () => { if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.apiBase !== expectedBase || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.userId) !== actor.ownerId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active') fail('The receivables report client changed company.'); };
    clientScope(); const reportObservedAt = new Date(now()).toISOString(), endpoint = endpointFor(observed.record, bindings[0].id);
    const reportController = new AbortController(), cancelReport = () => reportController.abort();
    if (signal?.aborted) cancelReport(); else signal?.addEventListener('abort', cancelReport, { once: true });
    const reportTimer = setTimeout(cancelReport, 60000); reportTimer.unref?.();
    let report;
    try {
      report = await new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('The receivables report read was cancelled or exceeded its one-minute budget.'), { status: 409, code: 'BUSINESS_VERIFICATION_UNAVAILABLE' }));
        if (reportController.signal.aborted) { abort(); return; }
        reportController.signal.addEventListener('abort', abort, { once: true });
        const control = { signal: reportController.signal, beforeAttempt: async () => { checkSignal(signal); clientScope(); await authority(scope, 'operations.read', { signal: reportController.signal }); }, onFailure: () => {} };
        Promise.resolve().then(() => client.apiCall('GET', endpoint, undefined, 0, 0, control)).then(resolve, reject).finally(() => reportController.signal.removeEventListener('abort', abort));
      });
    } finally { clearTimeout(reportTimer); signal?.removeEventListener('abort', cancelReport); reportController.abort(); }
    checkSignal(signal); clientScope();
    const after = await rawRecord(scope, entity, qboId, { signal });
    if (after.recordHash !== observed.recordHash) fail('The invoice changed during receivables report verification.');
    const afterFence = await readFence(scope, { signal }), current = await authority(scope, 'operations.read', { signal }); checkSignal(signal);
    if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('The receivables reader changed.');
    const receipt = { ...row.receipt, scope, entity, logicalKey: row.logicalKey };
    const accountRouting = accountPostingEvidence({ compiled, receipt, observed, accountBinding: bindings[0], accountObserved, report, reportObservedAt, beforeFence, afterFence, now: now() });
    return { ...observed, accountRouting };
  };
  const readRecord = async (value, entity, qboId, { signal } = {}) => {
    const observed = await accountRead(value, entity, qboId, { signal });
    if (entity !== 'Invoice' || observed.record.Line?.some(line => line.LinkedTxn !== undefined)) return observed;
    const row = await Steps.findOne({ ...scope, entity, qboId }).select('operationId planHash logicalKey entity fingerprint state compilation dispatch receipt qboId').maxTimeMS(3000).lean(); checkSignal(signal);
    const payload = row?.compilation?.request?.body && JSON.parse(row.compilation.request.body);
    if (!payload?.Line?.some(line => line.LinkedTxn?.some(link => link.TxnType === 'Estimate')) || observed.record.Line?.some(line => line.LinkedTxn !== undefined)) return observed;
    const lineage = await require('./business-link-repair').loadOwnedLinkLineage({ models: { Authorities, Receipts, Audits, Writers }, scope, step: row }) || await require('./business-ui-link-lineage').loadOwnedUiLinkLineage({models:{Authorities,Audits,Writers},scope,step:row}); checkSignal(signal);
    if (!lineage) return observed;
    const before = await readFence(scope, { signal }), source = row.compilation.relationships.find(link => link.entity === 'Estimate'), time = row.compilation.relationships.find(link => link.entity === 'TimeActivity');
    const estimateObserved = await rawRecord(scope, 'Estimate', source.qboId, { signal }), timeObserved = await rawRecord(scope, 'TimeActivity', time.qboId, { signal });
    const after = await rawRecord(scope, 'Invoice', qboId, { signal }), afterFence = await readFence(scope, { signal });
    if (after.recordHash !== observed.recordHash || hash(before) !== hash(afterFence)) fail('The invoice or company changed during full-conversion verification.');
    const receipt = { ...row.receipt, scope, entity, logicalKey: row.logicalKey };
    const estimateConversion = require('./business-estimate-conversion').createEstimateConversionProof({ compiled: row.compilation, receipt, observed, estimateObserved, timeObserved, lineage, now: now() });
    return { ...observed, estimateConversion };
  };
  const loadTaxPolicy = async (value, compiled, { signal } = {}) => {
    checkScope(value); checkSignal(signal); const request = validateCompilation(compiled); checkScope(request.scope);
    const actor = await authority(scope, 'operations.read', { signal });
    // Locate the ORIGINAL operation, including earlier-period steps refreshed by
    // this operation. loadIntent validates its immutable manifest and policy hash.
    const row = await Steps.findOne({ ...scope, logicalKey: compiled.logicalKey }).select('operationId planHash fingerprint entity state dispatch logicalKey receipt qboId').maxTimeMS(3000).lean(); checkSignal(signal);
    if (!row || !['saved', 'verified'].includes(row.state) || !ID.test(String(row.operationId)) || !HASH.test(row.planHash || '') || row.entity !== compiled.entity || row.fingerprint !== compiled.intentHash || row.dispatch?.compilationHash !== compiled.compilationHash || row.dispatch?.requestHash !== request.requestHash) fail('The original managed transaction is unavailable.');
    await assertOwnerAttribution({ Receipts, Authorities, Audits }, scope, row);
    const originalStep = row; // The original scoped lookup already selected the complete dispatch.
    const intent = await loadIntent(scope, String(row.operationId), compiled.logicalKey, { policyHead: originalStep?.dispatch?.policyAmendmentHash || null }); checkSignal(signal);
    if (!intent || intent.version !== 1 || !sameScope(intent.scope, scope) || intent.operationId !== String(row.operationId) || intent.planHash !== row.planHash || intent.logicalKey !== compiled.logicalKey || intent.entity !== compiled.entity || intent.fingerprint !== compiled.intentHash || hash(intent.step) !== compiled.intentHash) fail('The original transaction intent changed.');
    const policy = intent.policy;
    if (originalStep?.dispatch?.policyHash && originalStep.dispatch.policyHash !== hash(policy)) fail('The policy differs from the expectation bound at the original dispatch.');
    if (!policy || policy.version !== 1 || policy.status !== 'approved' || !sameScope(policy.scope, scope) || policy.country !== 'CA' || policy.currency !== 'CAD' || policy.stepHash !== compiled.intentHash || !HASH.test(policy.evidenceHash || '')) fail('The original approved Canadian policy is unavailable.');
    const expectation = taxExpectation(policy, compiled);
    const current = await authority(scope, 'operations.read', { signal }); checkSignal(signal);
    if (current?.actorId !== actor?.actorId || current?.ownerId !== actor?.ownerId) fail('The graph reader changed.');
    return expectation ? { ...expectation,...(intent.step.details?.datedTax?{originalStep:intent.step,originalPolicy:policy}:{}), status: 'approved', scope, compilationHash: compiled.compilationHash, evidenceHash: hash({ scope, operationId: intent.operationId, planHash: intent.planHash, policyHash: hash(policy), compilationHash: compiled.compilationHash, expectation }) } : null;
  };
  const reader = createBusinessGraphReader({ Steps, transaction, assertReady, authorize: authority, readFence, readRecord, loadTaxPolicy, retainSources, now });
  const loadGraphReadback = input => { checkScope(input?.scope); return reader(input); };
  const boundSnapshot = input => {
    checkScope(input?.scope);
    if (input?.intent?.operationId !== operationId || input?.intent?.planHash !== planHash) fail('The verification operation changed.');
    return graphSnapshot(input);
  };
  return { loadGraphReadback, graphSnapshot: boundSnapshot, readRecord, rawRecord, loadTaxPolicy, readFence };
}
module.exports = { createBusinessVerificationRuntime, taxExpectation };
