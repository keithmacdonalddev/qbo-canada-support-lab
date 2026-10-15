'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied, scoped, freezeWriteRequest } = require('./qbo-write-contract');
const { assertMasterPlan, compileMasterEntry, verifyMasterReadback } = require('./business-master-preparation-plan');
const { draftView } = require('./blueprint-draft');
const { assertMasterDispatchEvidence } = require('./business-master-dispatch-evidence');
const { assertMasterReceiptAudits } = require('./business-master-receipt');
const { assertMasterRecordSet } = require('./business-master-record-evidence');
const ID = /^[a-f0-9]{24}$/, QBO_ID = /^\d{1,30}$/;
const same = (a, b) => String(a) === String(b);
const storedScope = row => scoped({ environment: row?.environment, realmId: row?.realmId, connectionId: String(row?.connectionId) });
const validRevision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const dispatchKeyFor = (runId, ordinal, attempt) => hash({ version: 1, masterRunId: runId, ordinal, attempt });
function verifiedParents(run) {
  return Object.fromEntries(run.records.filter(row => row.state === 'verified').map(row => [row.key, { ...row.readback, state: 'verified', ordinal: row.ordinal, planHash: run.planHash, qboId: row.qboId }]));
}
function assertMasterRun(run, scope, ownerId) {
  if (!run || run.contractVersion !== 1 || !ID.test(String(run._id)) || canonical(storedScope(run)) !== canonical(scoped(scope)) || !same(run.ownerId, ownerId) || !validRevision(run.revision)) throw denied('The exact saved master preparation is required.');
  const plan = assertMasterPlan(run.plan);
  if (run.planHash !== plan.planHash || canonical(plan.scope) !== canonical(scoped(scope)) || plan.ownerId !== ownerId || !same(run.sourceDraftId, plan.source.id) || run.sourceDraftHash !== plan.source.contentHash || !Array.isArray(run.records) || run.records.length !== plan.entries.length) throw denied('The master preparation differs from its immutable source.');
  const identities = new Set(), parents = verifiedParents(run);
  for (const [ordinal, record] of run.records.entries()) {
    const entry = plan.entries[ordinal];
    if (record.ordinal !== ordinal || record.key !== entry.key || record.entity !== entry.entity || !Array.isArray(record.attempts) || record.attempts.length > 10 || !['pending', 'reserved', 'possibly-sent', 'saved', 'verified', 'rejected', 'unknown', 'retired'].includes(record.state)) throw denied('Master preparation record history is incomplete.');
    if (record.qboId) {
      const identity = record.entity + ':' + record.qboId;
      if (!QBO_ID.test(record.qboId) || identities.has(identity) || !['saved', 'verified'].includes(record.state)) throw denied('Prepared master identity needs review.');
      identities.add(identity);
    }
    if (record.state === 'verified') {
      if (!record.qboId || record.readback?.entity !== record.entity || record.readback?.qboId !== record.qboId) throw denied('Prepared master verification is incomplete.');
      const proof = verifyMasterReadback(compileMasterEntry(plan, ordinal, parents), { ...record.readback.fields, Id: record.qboId, SyncToken: record.readback.syncToken }, record.qboId);
      if (canonical(proof) !== canonical(record.readback)) throw denied('Prepared master readback changed.');
    }
    const compiled = record.attempts.length ? compileMasterEntry(plan, ordinal, parents) : null;
    for (const [index, attempt] of record.attempts.entries()) {
      if (attempt.number !== index + 1 || attempt.dispatchKey !== dispatchKeyFor(String(run._id), ordinal, index + 1) || canonical(attempt.payload) !== canonical(compiled.payload) || attempt.requestHash !== freezeWriteRequest(scope, 'POST', entry.entity.toLowerCase(), attempt.payload).requestHash || (index < record.attempts.length - 1 && !['rejected', 'proved-unsent'].includes(attempt.state))) throw denied('Prepared master attempts do not match the approved payload.');
    }
    const last = record.attempts.at(-1);
    if (record.state === 'pending' ? Boolean(record.qboId || (last && (last.state !== 'proved-unsent' && !(last.state === 'rejected' && record.retryApproval)))) : record.state === 'retired' ? Boolean(record.qboId || (last && !['rejected', 'proved-unsent'].includes(last.state))) : !last || last.state !== record.state || (record.qboId || null) !== (last.qboId || null)) throw denied('Prepared master progress does not match its retained attempt.');
  }
  return run;
}
function assertMasterApproval(run) {
  const approval = run.approval, { contentHash, ...source } = approval || {};
  if (!approval || source.version !== 1 || canonical(source.scope) !== canonical(storedScope(run)) || source.runId !== String(run._id) || source.ownerId !== String(run.ownerId) || source.planHash !== run.planHash || !ID.test(source.auditId || '') || !Number.isFinite(Date.parse(source.approvedAt)) || source.productionConfirmed !== (run.environment === 'production') || hash(source) !== contentHash) throw denied('The owner must approve this exact master preparation.');
  return approval;
}
function createMasterPreparationTransport({ MasterRuns, Versions, Sequences, Audits, Receipts, assertReady, now = () => Date.now() }) {
  if ([MasterRuns, Versions, Sequences, Audits, Receipts].some(value => !value) || typeof assertReady !== 'function') throw new TypeError('Master transport needs explicit storage and source fencing');
  const read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function fenceSource(run, session) {
    const latest = await Versions.findOne({ realmId: run.realmId, environment: run.environment, contractVersion: 2 }).sort({ version: -1 }).session(session).maxTimeMS(3000).lean();
    if (!latest || !same(latest._id, run.sourceDraftId) || !same(latest.connectionId, run.connectionId) || latest.contentHash !== run.sourceDraftHash || hash(latest.definition) !== run.sourceDraftHash) throw denied('A newer or changed business draft stops further master creates. Review the saved IDs against the current draft.');
    const view = draftView(latest, String(run.connectionId));
    if (canonical({ business: view.business, mappings: view.mappings, masterBindings: view.masterBindings }) !== canonical({ business: run.plan.source.business, mappings: run.plan.source.mappings, masterBindings: run.plan.source.masterBindings })) throw denied('The saved business choices changed before master dispatch.');
    const sequence = await read(Sequences, { _id: run.realmId }, session);
    if (!sequence || !validRevision(sequence.value) || sequence.value < latest.version || !validRevision(sequence.masterPreparationFence ?? 0)) throw denied('The business draft dispatch fence needs recovery.');
    const touched = await Sequences.findOneAndUpdate({ _id: sequence._id, value: sequence.value, ...(sequence.masterPreparationFence === undefined ? { masterPreparationFence: { $exists: false } } : { masterPreparationFence: sequence.masterPreparationFence }) }, { $inc: { masterPreparationFence: 1 } }, { new: true, session }).lean();
    if (!touched) throw denied('The business draft changed before master dispatch.');
  }
  async function assertRetry(run, record, attempt, scope, ownerId, session) {
    if (attempt.number === 1) return;
    const previous = record.attempts[attempt.number - 2], decision = attempt.retryApproval;
    const { contentHash, ...content } = decision || {};
    if (!previous || !['rejected', 'proved-unsent'].includes(previous.state) || !decision || content.version !== 1 || canonical(content.scope) !== canonical(scope) || content.runId !== String(run._id) || content.ownerId !== ownerId || content.planHash !== run.planHash || content.ordinal !== record.ordinal || content.priorAttempt !== previous.number || content.priorDispatchKey !== previous.dispatchKey || content.priorState !== previous.state || content.nextAttempt !== attempt.number || !ID.test(content.auditId || '') || !Number.isFinite(Date.parse(content.confirmedAt)) || hash(content) !== contentHash) throw denied('The owner must review the exact no-effect history before a fresh master attempt.');
    const approved = await read(Audits, { _id: content.auditId, userId: ownerId, realmId: scope.realmId, action: 'Business master no-effect retry approved', outcome: 'success', 'afterState.decisionHash': contentHash, 'afterState.runId': String(run._id), 'afterState.planHash': run.planHash }, session);
    if (!approved) throw denied('The master retry decision audit is unavailable.');
    const priorReceipts = await Receipts.find({ environment: scope.environment, realmId: scope.realmId, $or: [{ dispatchKey: previous.dispatchKey }, { 'workflow.kind': 'master-preparation', 'workflow.runId': String(run._id), 'workflow.ordinal': record.ordinal, 'workflow.attempt': previous.number }] }).limit(2).session(session).maxTimeMS(3000).lean();
    if (previous.state === 'proved-unsent') {
      if (previous.receiptId !== null || priorReceipts.length) throw denied('A retained mandatory receipt prevents treating this master attempt as unsent.');
    } else {
      const receipt = priorReceipts[0];
      if (priorReceipts.length !== 1 || receipt._id !== previous.receiptId || receipt.kind !== 'master-preparation' || canonical(storedScope(receipt)) !== canonical(scope) || !same(receipt.ownerId, ownerId) || receipt.state !== 'rejected' || receipt.requestHash !== previous.requestHash || receipt.dispatchKey !== previous.dispatchKey || receipt.workflow?.runId !== String(run._id) || receipt.workflow?.ordinal !== record.ordinal || receipt.workflow?.attempt !== previous.number || canonical(receipt.observed) !== canonical(previous.outcome) || receipt.observed?.outcome !== 'rejected' || receipt.observed.httpStatus !== 400 || !Array.isArray(receipt.observed.faultCodes) || !receipt.observed.faultCodes.length) throw denied('Only the exact definite master refusal can authorize this fresh attempt.');
      await assertMasterReceiptAudits({ Audits }, receipt, session);
    }
  }
  async function admit({ scope, ownerId, actorId, workflow, request, receiptId, dispatchKey, writer, policy, startAuditId, session }) {
    if (!session?.inTransaction?.() || actorId !== ownerId || workflow?.kind !== 'master-preparation' || request.operation !== 'create') throw denied('Only the current owner can admit a reviewed master create.');
    await assertReady({ scope, ownerId, session });
    const run = assertMasterRun(await read(MasterRuns, { _id: workflow.runId, ...scope, ownerId }, session), scope, ownerId), approval = assertMasterApproval(run);
    const audit = await read(Audits, { _id: approval.auditId, userId: ownerId, realmId: scope.realmId, action: 'Business master preparation approved', outcome: 'success', 'afterState.approvalHash': approval.contentHash, 'afterState.planHash': run.planHash, 'afterState.runId': String(run._id) }, session);
    if (!audit || run.claim !== 'open' || run.state !== 'running' || run.stopRequested || run.leaseToken !== workflow.leaseToken || !Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() <= now() || !same(writer.operationId, run._id) || writer.workflowKind !== 'master-preparation' || writer.planHash !== run.planHash || writer.unresolved !== null) throw denied('The approved master worker, stop state or company ownership changed.');
    const record = run.records[workflow.ordinal], attempt = record?.attempts.at(-1);
    if (!record || record.state !== 'reserved' || attempt?.state !== 'reserved' || attempt.number !== workflow.attempt || attempt.leaseToken !== workflow.leaseToken || attempt.receiptId !== null || attempt.dispatchKey !== dispatchKey || attempt.requestHash !== request.requestHash || request.endpoint !== record.entity.toLowerCase() || request.body !== JSON.stringify(attempt.payload) || run.records.slice(0, workflow.ordinal).some(row => row.state !== 'verified')) throw denied('This exact approved master attempt is not unsent.');
    await assertMasterRecordSet({ Receipts, Audits }, scope, run, run.records.slice(0, workflow.ordinal), session);
    await assertRetry(run, record, attempt, scope, ownerId, session);
    assertMasterDispatchEvidence(run, workflow.ordinal, request.requestHash, attempt.preflight, policy.periodControl, now());
    await fenceSource(run, session);
    attempt.state = record.state = 'possibly-sent'; attempt.receiptId = receiptId;
    const changed = await MasterRuns.findOneAndUpdate({ _id: run._id, ...scope, revision: run.revision, state: 'running', claim: 'open', leaseToken: run.leaseToken, stopRequested: false }, { $set: { records: run.records, lastAuditId: startAuditId }, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!changed) throw denied('Master preparation changed while recording dispatch.');
    return { key: dispatchKey, requestHash: request.requestHash, actorId, entity: request.entity, kind: 'master-preparation', runId: String(run._id), ordinal: workflow.ordinal, attempt: workflow.attempt, transportConsumed: { receiptId, consumedAt: new Date(now()).toISOString() } };
  }
  // Called INSIDE the mandatory receipt transaction. Retain accepted identity before UI/audit callbacks.
  async function settle({ stored, observed, resultAuditId, observedAt, session }) {
    const scope = storedScope(stored), workflow = stored.workflow;
    const run = assertMasterRun(await read(MasterRuns, { _id: workflow?.runId, ...scope, ownerId: stored.ownerId }, session), scope, String(stored.ownerId));
    const record = run.records[workflow.ordinal], attempt = record?.attempts.at(-1);
    if (workflow.kind !== 'master-preparation' || !record || record.state !== 'possibly-sent' || attempt?.state !== 'possibly-sent' || attempt.number !== workflow.attempt || attempt.receiptId !== stored._id || attempt.dispatchKey !== stored.dispatchKey || attempt.requestHash !== stored.requestHash || !['saved', 'rejected', 'unknown'].includes(observed.outcome)) throw denied('The master transport result no longer matches its admitted attempt.', true);
    attempt.state = record.state = observed.outcome; attempt.outcome = observed; attempt.observedAt = observedAt;
    if (observed.outcome === 'saved') { attempt.qboId = record.qboId = observed.qboId; attempt.syncToken = observed.syncToken; }
    const changed = await MasterRuns.findOneAndUpdate({ _id: run._id, ...scope, revision: run.revision, claim: 'open' }, { $set: { records: run.records, lastAuditId: resultAuditId, ...(['unknown', 'rejected'].includes(observed.outcome) ? { state: 'blocked', stopRequested: true } : {}) }, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!changed) throw denied('The master result could not be bound durably.', true);
  }
  return { admit, settle, fenceSource };
}
module.exports = { createMasterPreparationTransport, assertMasterRun, assertMasterApproval, verifiedParents, dispatchKeyFor };
