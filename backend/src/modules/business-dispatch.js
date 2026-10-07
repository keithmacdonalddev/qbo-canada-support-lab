'use strict';
const { hash } = require('./business-calendar');
const { scoped, withBusinessWritePermit } = require('./qbo-write-contract');
const { compileBusinessTransaction } = require('./business-transaction-compiler');
const { runAsActor } = require('./actor-context');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => String(a?.[key]) === String(b?.[key]));
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_DISPATCH_BLOCKED' }); }
// Internal runner boundary. No startup, approval, storage preparation or retry loop.
// Every provider write still passes through the existing client's durable gate.
function createBusinessDispatcher({ steps, loadIntent, loadCompilationEvidence, resolveClient, authorize, assertReady, now = () => Date.now() }) {
  if (['evidence', 'claim', 'beginDispatch', 'recover', 'verifyGraph'].some(key => typeof steps?.[key] !== 'function') || [loadIntent, loadCompilationEvidence, resolveClient, authorize, assertReady, now].some(fn => typeof fn !== 'function')) throw new TypeError('Business dispatch requires explicit runtime adapters');
  return async function dispatch(scope, operationId, logicalKey, { signal, leaseToken, recoveryOnly = false } = {}) {
    scope = scoped(scope);
    if (typeof recoveryOnly !== 'boolean' || (leaseToken !== undefined && (typeof leaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(leaseToken))) || !ID.test(operationId || '') || !HASH.test(logicalKey || '')) fail('An exact saved operation and activity are required.', 400);
    const check = () => { if (signal?.aborted) fail('Business dispatch was cancelled before sending.'); };
    check(); await assertReady(scope); check();
    const actor = await authorize(scope, 'operations.read');
    if (!ID.test(actor?.actorId || '')) fail('Current company access is required.', 403);
    const actorId = actor.actorId;
    const authority = async action => { const value = await authorize(scope, action); if (value?.actorId !== actorId) fail('The operation actor changed.', 403); };
    return runAsActor(actorId, async () => {
      const summary = (state, extra = {}) => ({ operationId, logicalKey, state, complete: false, replayAllowed: false, ...extra });
      const reconcile = async () => {
        let evidence = await steps.evidence(scope, operationId, logicalKey);
        if (['dispatched', 'unknown'].includes(evidence.state)) {
          // Read the original correlated transport receipt, never search by name/amount.
          await authority('operations.recover');
          const recovery = await steps.recover(scope, operationId, logicalKey);
          if (!recovery.recovered) return summary('recovery_required');
          evidence = await steps.evidence(scope, operationId, logicalKey);
        }
        if (evidence.state === 'rejected') return summary('rejected');
        if (!['saved', 'verified'].includes(evidence.state)) fail('The activity has no settled saved record.');
        // A later child write can change this record while its saved proof is still
        // within the freshness window. Reconcile the current graph on every resume.
        // Cancellation never interrupts recording the outcome of a possibly-sent write.
        if (recoveryOnly || signal?.aborted) return summary('saved', { qboId: evidence.qboId });
        await authority('operations.verify');
        const proof = await steps.verifyGraph(scope, operationId, [logicalKey], { signal });
        if (proof.complete !== true || proof.persisted !== true) return summary('unverified', { qboId: evidence.qboId });
        const verified = await steps.evidence(scope, operationId, logicalKey);
        if (verified.state !== 'verified' || verified.fresh !== true || verified.qboId !== evidence.qboId) fail('Saved activity verification changed before completion.');
        return summary('verified', { qboId: verified.qboId, complete: true });
      };
      const existing = await steps.evidence(scope, operationId, logicalKey); check();
      if (['dispatched', 'unknown', 'saved', 'verified', 'rejected'].includes(existing.state)) return reconcile();
      if (recoveryOnly) fail('Recovery cannot create a missing activity.');
      if (!['unrecorded', 'claimed'].includes(existing.state)) fail('The activity state is unsupported.');
      await authority('operations.execute'); check();
      const intent = structuredClone(await loadIntent(scope, operationId, logicalKey));
      if (!intent || intent.version !== 1 || intent.kind !== 'create' || !sameScope(intent.scope, scope) || intent.operationId !== operationId || intent.logicalKey !== logicalKey || !HASH.test(intent.planHash || '') || intent.step?.logicalKey !== logicalKey || intent.entity !== intent.step?.entity || intent.fingerprint !== hash(intent.step)) fail('Only an exact approved creation intent can be dispatched.');
      const client = await resolveClient(scope, { signal }); check();
      const { QBOClient } = require('./qbo-client');
      const checkClient = () => {
        const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
        if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall || client.realmId !== scope.realmId || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active' || !ID.test(String(client.connection?.userId || '')) || client.apiBase !== base) fail('The QuickBooks client does not match this company connection.');
      };
      checkClient();
      // Claim precedes observation: claiming changes the writer revision. An expired
      // claim can be replaced by the store; a possibly-sent request cannot.
      const handle = await steps.claim(scope, operationId, logicalKey, 300000, { runLeaseToken: leaseToken }); check();
      const observations = await loadCompilationEvidence({ scope, operationId, logicalKey, intent: structuredClone(intent), signal }); check();
      const compiled = compileBusinessTransaction({ scope, step: intent.step, policy: intent.policy, referenceEvidence: observations?.referenceEvidence, parents: observations?.parents, observationFence: observations?.observationFence, now: now() });
      if (compiled.dispatchEvidence.operationId !== operationId || compiled.intentHash !== intent.fingerprint) fail('Compiled observations belong to another operation.');
      await authority('operations.execute'); check(); checkClient();
      // A thrown/ambiguous marker commit never grants permission to send.
      const marked = await steps.beginDispatch(scope, operationId, logicalKey, handle, compiled.dispatchEvidence, { runLeaseToken: leaseToken });
      const request = compiled.request, dispatchKey = hash({ ...scope, operationId, logicalKey, fingerprint: intent.fingerprint, requestHash: request.requestHash });
      if (marked?.dispatch?.key !== dispatchKey || marked.dispatch.requestHash !== request.requestHash || marked.dispatch.actorId !== actorId) fail('The committed dispatch differs from its compiled request.');
      // Once the marker exists, every failure is reconciled from durable state.
      // Do not race the request against a timer or forward cancellation to a POST.
      try {
        check(); checkClient();
        await withBusinessWritePermit({ scope, operationId, logicalKey, dispatchKey, requestHash: request.requestHash, ...(leaseToken !== undefined ? { leaseToken } : {}) }, () => client.apiCall(request.method, request.endpoint, JSON.parse(request.body)));
      } catch { /* A raw result/error cannot prove whether a transaction was saved. */ }
      return reconcile();
    });
  };
}
module.exports = { createBusinessDispatcher };
