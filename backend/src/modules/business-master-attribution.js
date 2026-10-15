'use strict';
const { hash, canonical } = require('./business-calendar');
const { denied, scoped } = require('./qbo-write-contract');
const { verifyMasterReadback, compileMasterEntry } = require('./business-master-preparation-plan');
const { createMasterQboAccess } = require('./business-master-qbo-access');
const { assertMasterReceiptAudits, assertMasterBarrier, masterProgressHash } = require('./business-master-receipt');
const { assertNoLegacyOwnership } = require('./business-recovery-ownership');
const SOURCE = 'owner-attributed-master-readback', ACTION = 'Uncertain master creation attributed by owner';
const same = (a, b) => String(a) === String(b), read = (Model, filter, session) => Model.findOne(filter).session(session).maxTimeMS(3000).lean();
async function masterTerminal(models, receipt, session) {
  if (!receipt) throw denied('The exact terminal master receipt is unavailable.');
  await assertMasterReceiptAudits(models, receipt, session);
  if (receipt.state !== 'unknown') throw denied('Only a terminal unknown master request can be attributed.');
  const scope = scoped({ environment: receipt.environment, realmId: receipt.realmId, connectionId: String(receipt.connectionId) });
  const source = { version: 1, scope, receiptId: String(receipt._id), dispatchKey: receipt.dispatchKey, requestHash: receipt.requestHash, kind: receipt.observed.transportFailure === true ? 'sdk-failure' : 'http-response', endedAt: new Date(receipt.observedAt).toISOString(), observedHash: hash(receipt.observed) };
  const contentHash = hash(source), auditId = hash({ terminalHash: contentHash }).slice(0, 24);
  if (canonical(receipt.terminal) !== canonical({ ...source, contentHash, auditId })) throw denied('An unfinished master request has no terminal outcome evidence.');
  const audit = await read(models.Audits, { _id: auditId, realmId: scope.realmId, userId: receipt.ownerId, action: 'QuickBooks write attempt ended without a confirmed outcome', outcome: 'partial' }, session);
  if (!audit || audit.actionType !== 'manual' || canonical(audit.afterState) !== canonical({ ...source, contentHash })) throw denied('The original master transport completion audit is unavailable.');
  return { ...source, contentHash, sentAt: new Date(receipt.sentAt).toISOString() };
}
async function assertMasterAttribution(models, scope, run, row, session) {
  const attempt = row.attempts.at(-1), value = attempt?.ownerAttribution;
  if (!value) { if (attempt?.outcome?.outcome === 'unknown') throw denied('The unknown master result requires its retained owner attribution.'); return null; }
  const { contentHash, auditId, ...content } = value;
  if (content.version !== 1 || content.source !== SOURCE || canonical(content.scope) !== canonical(scoped(scope)) || content.runId !== String(run._id) || content.ownerId !== String(run.ownerId) || content.planHash !== run.planHash || content.ordinal !== row.ordinal || content.attempt !== attempt.number || content.dispatchKey !== attempt.dispatchKey || content.requestHash !== attempt.requestHash || content.receiptId !== attempt.receiptId || content.qboId !== row.qboId || content.qboId !== attempt.qboId || content.proof?.qboId !== row.qboId || canonical(content.proof) !== canonical(row.readback) || canonical(content.proof) !== canonical(attempt.readback) || attempt.syncToken !== content.proof.syncToken || hash(content.review) !== content.reviewHash || canonical(content.review?.candidate) !== canonical({ proof: content.proof, createdAt: content.createdAt }) || content.review?.runId !== String(run._id) || content.review?.ordinal !== row.ordinal || content.review?.attempt !== attempt.number || content.review?.qboId !== row.qboId || content.review?.terminalHash !== content.terminalHash || content.confirmOwnership !== true || typeof content.reason !== 'string' || content.reason.length < 30 || content.reason.length > 2000 || hash(content) !== contentHash || auditId !== hash({ masterAttribution: contentHash }).slice(0, 24)) throw denied('The saved master owner attribution changed.');
  const receipt = await read(models.Receipts, { _id: content.receiptId, ...scope, kind: 'master-preparation', 'workflow.runId': String(run._id), 'workflow.ordinal': row.ordinal, 'workflow.attempt': attempt.number }, session), terminal = await masterTerminal(models, receipt, session);
  if (attempt.outcome?.outcome !== 'unknown' || canonical(attempt.outcome) !== canonical(receipt.observed) || terminal.contentHash !== content.terminalHash || receipt.dispatchKey !== content.dispatchKey || receipt.requestHash !== content.requestHash || !same(receipt.operationId, run._id) || receipt.workflow?.kind !== 'master-preparation' || receipt.workflow?.leaseToken !== attempt.leaseToken || !same(receipt.ownerId, content.ownerId) || canonical(receipt.ownerRecovery) !== canonical({ version: 1, source: SOURCE, qboId: row.qboId, contentHash, auditId, reviewHash: content.reviewHash })) throw denied('The unknown master receipt no longer names this owner decision.');
  const audit = await read(models.Audits, { _id: auditId, realmId: scope.realmId, userId: content.ownerId, action: ACTION, outcome: 'success' }, session);
  if (!audit || audit.actionType !== 'manual' || canonical(audit.afterState) !== canonical(value)) throw denied('The exact master attribution audit is unavailable.');
  return value;
}
function createMasterAttribution(d) {
  const { models, scope, ownerId, actorId, access, assertReady, db, transaction, now, load, authorize, coordination, touchPolicy, change, recovery, updateWriter, verifiedParents } = d;
  const qbo = createMasterQboAccess({ scope, ownerId, authorize: access.authorize, clientFor: access.resolveClient });
  async function readable() { if (actorId !== ownerId) throw denied('Only the current company owner can identify an uncertain master creation.'); await assertReady(); await access.authorize(scope, 'operations.recover'); }
  async function unowned(run, row, qboId, session) {
    if (run.plan.inventoryBefore[row.entity].includes(qboId)) throw denied('This ID existed before preparation and cannot be attributed to a later create.');
    const company = { environment: scope.environment, realmId: scope.realmId };
    if (await read(models.MasterRuns, { ...company, records: { $elemMatch: { entity: row.entity, qboId } } }, session) || await read(models.Steps, { ...company, entity: row.entity, qboId }, session)) throw denied('This record already belongs to another managed creation.');
    const receipts = await models.Receipts.find({ ...company, entity: row.entity.toLowerCase(), $or: [{ 'observed.qboId': qboId }, { 'reconciliation.qboId': qboId }, { 'ownerRecovery.qboId': qboId }] }).limit(2).session(session).maxTimeMS(3000).lean();
    if (receipts.some(value => String(value._id) !== row.attempts.at(-1).receiptId)) throw denied('This record already has a different transport or recovery owner.');
    await assertNoLegacyOwnership(db, scope, row.entity, qboId, session);
  }
  async function inspect(id, ordinal, qboId, session) {
    const run = await load(id, session); recovery.inactive(run); const row = run.records[ordinal], attempt = row?.attempts.at(-1);
    if (!/^\d{1,30}$/.test(qboId || '') || !row || row.state !== 'unknown' || attempt?.state !== 'unknown' || row.qboId || run.records.slice(0, ordinal).some(value => value.state !== 'verified')) throw denied('Choose the exact first terminal unknown master ordinal and candidate ID.');
    const { policy, writer } = await coordination(session), receipt = await recovery.exactReceipt(run, row, session), terminal = await masterTerminal(models, receipt, session), barrier = writer.unresolved;
    if (!same(writer.operationId, run._id) || writer.workflowKind !== 'master-preparation' || writer.planHash !== run.planHash || !barrier || barrier.key !== attempt.dispatchKey || barrier.requestHash !== attempt.requestHash || barrier.actorId !== ownerId || barrier.kind !== 'master-preparation' || barrier.runId !== String(run._id) || barrier.ordinal !== ordinal || barrier.attempt !== attempt.number || barrier.transportConsumed?.receiptId !== attempt.receiptId || receipt.ownerRecovery || Date.parse(terminal.endedAt) > now()) throw denied('The exact terminal master request must still own its company barrier.');
    assertMasterBarrier(run, row, writer);
    await unowned(run, row, qboId, session);
    const state = { version: 1, scope, runId: String(run._id), ownerId, planHash: run.planHash, ordinal, attempt: attempt.number, qboId, progressHash: masterProgressHash(run), writerRevision: writer.revision, policyRevision: policy.revision, barrierHash: hash(barrier), receiptId: attempt.receiptId, terminalHash: terminal.contentHash };
    return { run, row, attempt, writer, policy, receipt, terminal, state };
  }
  async function observe(current, qboId) {
    const { run, row, terminal } = current, body = await qbo.read('operations.recover', client => client.apiCall('GET', row.entity.toLowerCase() + '/' + qboId)), record = body?.[row.entity];
    const created = Date.parse(record?.MetaData?.CreateTime), tolerance = 900000;
    if (!Number.isFinite(created) || created < Date.parse(terminal.sentAt) - tolerance || created > Date.parse(terminal.endedAt) + tolerance || created > now() + tolerance) throw denied('The candidate creation time is outside this attempt’s local ±15-minute review window. Matching times do not establish request identity.');
    const proof = verifyMasterReadback(compileMasterEntry(run.plan, row.ordinal, verifiedParents(run)), record, qboId);
    return { proof, createdAt: new Date(created).toISOString(), observedAt: new Date(now()).toISOString() };
  }
  async function review(id, ordinal, qboId) {
    if (!/^[a-f0-9]{24}$/.test(id || '') || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 99) throw denied('A canonical master run and ordinal are required.');
    await readable(); const current = await inspect(id, ordinal, qboId), observed = await observe(current, qboId); await readable(); const after = await inspect(id, ordinal, qboId);
    if (canonical(current.state) !== canonical(after.state)) throw denied('The master request changed during attribution review.');
    const content = { ...current.state, candidate: { proof: observed.proof, createdAt: observed.createdAt } };
    return { ...content, reviewHash: hash(content), observedAt: observed.observedAt, qboWrites: 0, provenance: SOURCE, limitation: 'Matching fields and creation time do not prove which request created this record or rule out duplicates. Confirm only using your own identification evidence. Original transport uncertainty remains in history.' };
  }
  async function confirm(id, ordinal, input) {
    if (!/^[a-f0-9]{24}$/.test(id || '') || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 99 || !input || Object.keys(input).sort().join(',') !== 'confirmOwnership,qboId,reason,reviewHash' || input.confirmOwnership !== true || !/^\d{1,30}$/.test(input.qboId || '') || !/^[a-f0-9]{64}$/.test(input.reviewHash || '') || typeof input.reason !== 'string' || input.reason.trim().length < 30 || input.reason.length > 2000) throw denied('Confirm the exact reviewed ID with a reason of 30 to 2000 characters.');
    await readable();
    async function repeated(session) {
      const run = await load(id, session), row = run.records[ordinal], value = row?.attempts.at(-1)?.ownerAttribution;
      if (!value) return null;
      if (value.qboId !== input.qboId || value.reviewHash !== input.reviewHash || value.reason !== input.reason.trim()) throw denied('A different owner attribution already exists for this ordinal.');
      await assertMasterAttribution(models, scope, run, row, session); return run;
    }
    const prior = await repeated(); if (prior) return prior;
    const observed = await review(id, ordinal, input.qboId);
    if (observed.reviewHash !== input.reviewHash) throw denied('The candidate or master request changed after review.');
    return transaction(async session => {
      await authorize('operations.recover', session); const prior = await repeated(session); if (prior) return prior;
      const current = await inspect(id, ordinal, input.qboId, session), { candidate, reviewHash, observedAt, qboWrites, provenance, limitation, ...state } = observed; void qboWrites; void provenance; void limitation;
      if (canonical(current.state) !== canonical(state) || now() - Date.parse(observedAt) > 300000) throw denied('The attribution observation or saved company request changed.');
      const content = { version: 1, source: SOURCE, scope, ownerId, runId: String(current.run._id), planHash: current.run.planHash, ordinal, attempt: current.attempt.number, receiptId: current.attempt.receiptId, dispatchKey: current.attempt.dispatchKey, requestHash: current.attempt.requestHash, terminalHash: current.terminal.contentHash, qboId: input.qboId, proof: candidate.proof, createdAt: candidate.createdAt, reviewHash, review: { ...state, candidate }, reason: input.reason.trim(), confirmOwnership: true, confirmedAt: new Date(now()).toISOString() };
      const contentHash = hash(content), auditId = hash({ masterAttribution: contentHash }).slice(0, 24), value = { ...content, contentHash, auditId };
      await touchPolicy(current.policy, session);
      const pointer = { version: 1, source: SOURCE, qboId: input.qboId, contentHash, auditId, reviewHash };
      const receipt = await models.Receipts.findOneAndUpdate({ _id: current.receipt._id, ...scope, state: 'unknown', ownerRecovery: current.receipt.ownerRecovery ?? null }, { $set: { ownerRecovery: pointer } }, { new: true, session }).lean();
      if (!receipt) throw denied('The original unknown receipt changed during owner confirmation.');
      current.row.state = current.attempt.state = 'verified'; current.row.qboId = current.attempt.qboId = input.qboId; current.row.readback = current.attempt.readback = candidate.proof; current.attempt.syncToken = candidate.proof.syncToken; current.attempt.ownerAttribution = value;
      await updateWriter(current.writer, { unresolved: null }, session);
      await models.Audits.create([{ _id: auditId, userId: ownerId, realmId: scope.realmId, action: ACTION, actionType: 'manual', outcome: 'success', afterState: value }], { session });
      return change(current.run, { records: current.run.records, state: 'stopped', stopRequested: true, leaseToken: null, leaseExpiresAt: null, lastFailure: null, lastAuditId: auditId }, session);
    });
  }
  return { review, confirm };
}
module.exports = { createMasterAttribution, assertMasterAttribution, masterTerminal, SOURCE, ACTION };
