'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied } = require('./qbo-write-contract');
const { assertMasterReceiptAudits, masterProgressHash } = require('./business-master-receipt');
const same = (a, b) => String(a) === String(b);
function createMasterPreparationRecovery(d) {
  const { models, scope, ownerId, transaction, now, token, activeLease, load, authorize, coordination, touchPolicy, change, audit, owns, updateWriter, transport } = d;
  const { Receipts } = models, company = { environment: scope.environment, realmId: scope.realmId };
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  function inactive(run) { if (run.claim !== 'open' || activeLease(run, now())) throw denied('Stop the current worker and wait for it to settle before recovery.'); }
  async function attemptReceipts(run, row, session) {
    const attempt = row.attempts.at(-1);
    return Receipts.find({ ...company, $or: [{ dispatchKey: attempt.dispatchKey }, { 'workflow.kind': 'master-preparation', 'workflow.runId': String(run._id), 'workflow.ordinal': row.ordinal, 'workflow.attempt': attempt.number }] }).limit(2).session(session).maxTimeMS(3000).lean();
  }
  async function exactReceipt(run, row, session) {
    const attempt = row.attempts.at(-1), rows = await attemptReceipts(run, row, session), receipt = rows[0];
    if (rows.length !== 1 || !receipt || !same(receipt._id, attempt.receiptId) || receipt.contractVersion !== 1 || receipt.kind !== 'master-preparation' || receipt.environment !== scope.environment || receipt.realmId !== scope.realmId || !same(receipt.connectionId, scope.connectionId) || !same(receipt.ownerId, ownerId) || !same(receipt.actorId, ownerId) || receipt.operation !== 'create' || receipt.entity !== row.entity.toLowerCase() || receipt.requestHash !== attempt.requestHash || receipt.dispatchKey !== attempt.dispatchKey || receipt.workflow?.runId !== String(run._id) || receipt.workflow?.ordinal !== row.ordinal || receipt.workflow?.attempt !== attempt.number || receipt.workflow?.leaseToken !== attempt.leaseToken) throw denied('The exact mandatory master receipt needs review.');
    await assertMasterReceiptAudits(models, receipt, session); return receipt;
  }
  async function proveNoEffect(run, row, session) {
    const attempt = row.attempts.at(-1);
    if (!attempt) return;
    if (['reserved', 'proved-unsent'].includes(attempt.state)) {
      if (attempt.receiptId !== null || (await attemptReceipts(run, row, session)).length) throw denied('A retained mandatory receipt prevents declaring this attempt unsent.');
      row.state = 'pending'; attempt.state = 'proved-unsent'; return;
    }
    if (attempt.state !== 'rejected') throw denied('An uncertain or accepted create cannot be treated as unsent.');
    const receipt = await exactReceipt(run, row, session);
    if (receipt.state !== 'rejected' || canonical(receipt.observed) !== canonical(attempt.outcome) || receipt.observed?.outcome !== 'rejected' || receipt.observed.httpStatus !== 400 || !receipt.observed.faultCodes?.length) throw denied('Only the exact definite ValidationFault refusal has no-effect proof.');
  }
  async function claimRecovery(id) {
    return transaction(async session => {
      await authorize('operations.recover', session); const run = await load(id, session); inactive(run);
      const { policy, writer } = await coordination(session); owns(writer, run); await touchPolicy(policy, session);
      const first = run.records.find(row => row.state !== 'verified');
      if (first && first.state !== 'saved') throw denied('Recover an exact accepted ID before any new creates; this ordinal has no confirmed ID.');
      const leaseToken = token(), lastAuditId = await audit(run, 'Business master readback recovery claimed', { leaseTokenHash: hash(leaseToken), qboWrites: 0 }, session);
      return change(run, { leaseToken, leaseExpiresAt: new Date(now() + 300000), stopRequested: true, state: 'running', lastFailure: null, lastAuditId }, session);
    });
  }
  async function retry(id, ordinal, planHash, confirmNoEffect, reviewHash) {
    return transaction(async session => {
      await authorize('operations.execute', session); const run = await load(id, session); inactive(run);
      const row = run.records[ordinal], previous = row?.attempts.at(-1);
      const priorDecision = row?.retryApproval?.reviewHash === reviewHash || row?.attempts.some(value => value.retryApproval?.reviewHash === reviewHash);
      if (run.planHash !== planHash || confirmNoEffect !== true || !/^[a-f0-9]{64}$/.test(reviewHash || '')) throw denied('Confirm the exact reviewed no-effect attempt.');
      if (priorDecision) return run;
      if (masterProgressHash(run) !== reviewHash) throw denied('This retry review no longer matches the saved progress.');
      if (run.planHash !== planHash || confirmNoEffect !== true || !row || row.qboId || !previous || !['reserved', 'rejected', 'proved-unsent', 'pending'].includes(row.state) || row.attempts.length >= 10 || run.records.slice(0, ordinal).some(value => value.state !== 'verified')) throw denied('Review the exact first no-effect attempt before approving another request.');
      if (row.state === 'pending' && row.retryApproval) return run;
      const { policy, writer } = await coordination(session, true); owns(writer, run);
      if (writer.unresolved !== null) throw denied('An unresolved company request prevents a retry decision.');
      await touchPolicy(policy, session); await transport.fenceSource(run, session); await proveNoEffect(run, row, session);
      const auditId = hash({ runId: String(run._id), ordinal, priorAttempt: previous.number, phase: 'retry' }).slice(0, 24);
      const content = { version: 1, scope, runId: String(run._id), ownerId, planHash, reviewHash, ordinal, priorAttempt: previous.number, priorDispatchKey: previous.dispatchKey, priorState: previous.state, nextAttempt: previous.number + 1, confirmedAt: new Date(now()).toISOString(), auditId };
      const decision = { ...content, contentHash: hash(content) };
      await models.Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: 'Business master no-effect retry approved', actionType: 'manual', outcome: 'success', afterState: { runId: String(run._id), planHash, decisionHash: decision.contentHash, ordinal, priorAttempt: previous.number, nextAttempt: content.nextAttempt, qboWrites: 0 } }], { session });
      row.state = 'pending'; row.retryApproval = decision;
      return change(run, { records: run.records, state: 'stopped', stopRequested: true, leaseToken: null, leaseExpiresAt: null, lastAuditId: auditId }, session);
    });
  }
  async function closeRecords(run, writer, session) {
    inactive(run);
    const own = same(writer.operationId, run._id);
    if (writer.unresolved && !own) throw denied('Another workflow has an unresolved company request.');
    if (own) owns(writer, run);
    for (const row of run.records) {
      if (['possibly-sent', 'unknown'].includes(row.state)) throw denied('Uncertain master work must keep its claim and company barrier.');
      if (row.qboId) {
        const receipt = await exactReceipt(run, row, session);
        if (receipt.state !== 'saved' || receipt.observed?.qboId !== row.qboId || !['saved', 'verified'].includes(row.state)) throw denied('Every retained master ID needs its exact accepted receipt.');
      } else {
        await proveNoEffect(run, row, session); row.state = 'retired';
      }
    }
    if (writer.unresolved) {
      const row = run.records.find(value => value.attempts.at(-1)?.dispatchKey === writer.unresolved.key), attempt = row?.attempts.at(-1);
      if (!row?.qboId || writer.unresolved.transportConsumed?.receiptId !== attempt.receiptId || row.state !== 'saved' || writer.unresolved.requestHash !== attempt.requestHash || writer.unresolved.actorId !== ownerId || writer.unresolved.entity !== row.entity.toLowerCase() || writer.unresolved.kind !== 'master-preparation' || writer.unresolved.runId !== String(run._id) || writer.unresolved.ordinal !== row.ordinal || writer.unresolved.attempt !== attempt.number) throw denied('Only the exact known accepted-ID barrier may be retained unassigned.');
    }
    if (own) await updateWriter(writer, { operationId: null, planHash: null, workflowKind: null, unresolved: null, lastReleasedOperationId: run._id }, session);
    else if (writer.operationId !== null || writer.planHash !== null) throw denied('Wait for the other company operation before closing master work.');
  }
  async function retain(id, planHash, confirmRetain, reviewHash) {
    return transaction(async session => {
      await authorize('operations.recover', session); const run = await load(id, session);
      if (run.planHash !== planHash || confirmRetain !== true) throw denied('Confirm retaining these exact IDs unassigned and retiring only the unsent tail.');
      if (run.claim === 'closed') { if (run.disposition?.kind !== 'retained-unassigned' || run.disposition.reviewHash !== reviewHash) throw denied('A different closing decision already exists.'); return run; }
      if (masterProgressHash(run) !== reviewHash) throw denied('Review the exact current retained IDs and unsent tail before closing.');
      const { policy, writer } = await coordination(session); await touchPolicy(policy, session); await closeRecords(run, writer, session);
      const disposition = { version: 1, kind: 'retained-unassigned', reviewHash, confirmedAt: new Date(now()).toISOString(), ids: run.records.filter(row => row.qboId).map(row => ({ ordinal: row.ordinal, entity: row.entity, qboId: row.qboId, verified: row.state === 'verified' })) };
      const lastAuditId = await audit(run, 'Business master records retained unassigned', { ...disposition, qboWrites: 0 }, session);
      return change(run, { claim: 'closed', state: 'closed', records: run.records, disposition, stopRequested: true, leaseToken: null, leaseExpiresAt: null, lastAuditId }, session);
    });
  }
  return { claimRecovery, retry, retain, closeRecords, exactReceipt, inactive };
}
module.exports = { createMasterPreparationRecovery };
