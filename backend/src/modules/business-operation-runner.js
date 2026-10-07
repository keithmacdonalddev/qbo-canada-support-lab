'use strict';
const { scoped } = require('./qbo-write-contract');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_RUN_UNVERIFIED' }); }
// Runs an already-approved durable operation. No timers truncate a POST and no
// in-memory cursor authorizes replay. A process restart reads the saved ordinal.
function createBusinessOperationRunner({ state, plans, steps, dispatch, periods, prepareEvidence }) {
  if ([state?.inspect, state?.claim, state?.renew, state?.advance, state?.release, plans?.page, steps?.verifyGraph, dispatch, periods?.reserve, periods?.finish, periods?.repair, prepareEvidence].some(value => typeof value !== 'function')) throw new TypeError('Operation runner requires durable runtime and evidence adapters');
  return async function run(scope, operationId, { signal } = {}) {
    scope = scoped(scope); if (!ID.test(operationId || '')) fail('Choose an exact saved operation.');
    const result = (value, reason) => ({ operationId, state: reason || value.status, complete: Boolean(value.completion), completedRecords: value.nextOrdinal, recordCount: value.recordCount, ...(value.completion ? { throughDate: value.completion.throughDate, evidenceHash: value.completion.evidenceHash } : {}) });
    let current = await state.inspect(scope, operationId), leaseToken;
    if (current.status === 'verified' && current.completion) return result(current, 'verified');
    if (current.status === 'committing' || current.status === 'verified') { await periods.repair(scope); current = await state.inspect(scope, operationId); return result(current, current.completion ? 'verified' : 'recovery_required'); }
    if (current.status === 'previewed') return result(current, 'approval_required');
    if (current.status === 'stopped') return result(current);
    if (signal?.aborted) return result(current, 'interrupted');
    if (current.status === 'approved') { await periods.reserve(operationId, scope); current = await state.inspect(scope, operationId); }
    current = await state.claim(scope, operationId); leaseToken = current.leaseToken;
    const planHash = current.planHash;
    const reconcileOutstanding = async () => {
      const latest = await state.inspect(scope, operationId);
      if (latest.unresolved) {
        const key = latest.unresolved.logicalKey;
        if (!HASH.test(key || '')) fail('The outstanding company request requires explicit recovery.');
        // This explicit recovery mode cannot create records or start graph reads.
        await dispatch(scope, operationId, key, { leaseToken, recoveryOnly: true });
      }
      return state.inspect(scope, operationId);
    };
    const release = async reason => { current = await state.release(scope, operationId, leaseToken, reason); leaseToken = null; return current; };
    try {
      let page;
      for (;;) {
        current = await state.renew(scope, operationId, leaseToken);
        if (current.planHash !== planHash) fail('The approved plan changed during execution.');
        if (signal?.aborted || current.stopRequested) {
          current = await reconcileOutstanding();
          const stop = current.stopRequested && !current.unresolved;
          await release(stop ? 'stopped' : current.unresolved ? 'blocked' : 'yield');
          return result(current, stop ? 'stopped' : current.unresolved ? 'recovery_required' : 'interrupted');
        }
        if (current.status === 'awaiting-evidence') break;
        if (current.status !== 'running' || current.nextOrdinal >= current.recordCount) fail('Operation progress does not match its runnable state.');
        const ordinal = current.nextOrdinal;
        if (!page || ordinal < page.offset || ordinal >= page.offset + page.entries.length) {
          page = await plans.page(scope, operationId, ordinal, 50);
          if (!page || page.operationId !== operationId || page.planHash !== planHash || page.recordCount !== current.recordCount || page.offset !== ordinal || !Array.isArray(page.entries) || !page.entries.length || page.entries.length > 50 || page.offset + page.entries.length > page.recordCount) fail('The saved plan page changed or is incomplete.');
        }
        const entry = page.entries[ordinal - page.offset], key = entry?.step?.logicalKey;
        if (!HASH.test(key || '') || !['create', 'existing'].includes(entry.kind)) fail('The saved activity disposition is invalid.');
        let verified;
        if (entry.kind === 'existing') {
          const proof = await steps.verifyGraph(scope, operationId, [key], { signal });
          verified = proof?.complete === true && proof.persisted === true;
        } else {
          const saved = await dispatch(scope, operationId, key, { signal, leaseToken });
          verified = saved?.complete === true && saved.state === 'verified';
          if (!verified && !signal?.aborted) { current = await state.inspect(scope, operationId); await release('blocked'); return result(current, saved?.state === 'recovery_required' ? 'recovery_required' : 'unverified'); }
        }
        if (signal?.aborted) continue;
        if (!verified) { await release('blocked'); return result(current, 'unverified'); }
        current = await state.advance(scope, operationId, leaseToken, ordinal, key);
      }
      // All individual receipts are insufficient to complete a business period.
      // The collector must freeze fresh whole-record and named report evidence;
      // the period store independently validates it before advancing the date.
      const proof = await prepareEvidence({ scope, operationId, leaseToken, signal });
      current = await state.renew(scope, operationId, leaseToken);
      if (signal?.aborted || current.stopRequested) {
        await release(current.stopRequested ? 'stopped' : 'yield'); return result(current, current.stopRequested ? 'stopped' : 'interrupted');
      }
      if (proof?.prepared !== true) { await release('yield'); return result(current, 'awaiting-evidence'); }
      await periods.finish(operationId, scope, { leaseToken });
      current = await state.inspect(scope, operationId);
      if (!current.completion) fail('The period completion receipt is not verified.');
      leaseToken = null; return result(current, 'verified');
    } catch (error) {
      // A failed/ambiguous completion acknowledgement is repaired from the saved
      // calendar receipt, never by creating transactions again.
      try {
        current = await state.inspect(scope, operationId);
        if (['committing', 'verified'].includes(current.status)) { await periods.repair(scope); current = await state.inspect(scope, operationId); if (current.completion) { leaseToken = null; return result(current, 'verified'); } }
        if (current.leaseToken === leaseToken) {
          current = await reconcileOutstanding();
          await release(current.stopRequested && !current.unresolved ? 'stopped' : signal?.aborted && !current.unresolved ? 'yield' : 'blocked');
          return { ...result(current, current.unresolved ? 'recovery_required' : current.status === 'stopped' ? 'stopped' : signal?.aborted ? 'interrupted' : 'blocked'), error: 'The operation could not finish. Saved progress is retained.', code: error?.code || 'BUSINESS_RUN_UNVERIFIED' };
        }
      } catch { /* The durable lease/barrier remains authoritative if storage failed. */ }
      throw error;
    }
  };
}
module.exports = { createBusinessOperationRunner };
