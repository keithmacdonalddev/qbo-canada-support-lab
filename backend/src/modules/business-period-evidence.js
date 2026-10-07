'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { assertRun, assertRunApproval, validatePeriodProof } = require('./business-period-store');
const { evaluateBooks } = require('./book-evidence');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_PERIOD_EVIDENCE_UNVERIFIED' }); }
const same = (a, b) => String(a) === String(b);
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => same(a?.[key], b?.[key]));
// Internal collector and immutable proof store. No external verification flags or
// caller-provided report results are accepted by prepareEvidence.
function createBusinessPeriodEvidence({ Runs, Plans, Steps, Evidence, transaction, access, assertReady, writerFence, steps, readReports, writeAudit, now = () => Date.now() }) {
  if ([Runs, Plans, Steps, Evidence].some(value => !value) || [transaction, access?.authorize, assertReady, writerFence?.graphSnapshot, writerFence?.assertSettled, steps?.verifyGraph, readReports, writeAudit, now].some(value => typeof value !== 'function')) throw new TypeError('Period evidence requires concrete stores and verification adapters');
  const read = (model, filter, session) => model.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function authority(scope, options = {}) { await assertReady(scope); const actor = await access.authorize(scope, 'operations.verify', options); if (!ID.test(actor?.actorId || '') || !ID.test(actor?.ownerId || '')) fail('Current period verification authority is required.'); return actor; }
  function own(run, scope, leaseToken) {
    assertRun(run, scope); assertRunApproval(run);
    if (run.status !== 'awaiting-evidence' || run.nextOrdinal !== run.recordCount || !leaseToken || run.leaseToken !== leaseToken || !Number.isFinite(new Date(run.leaseExpiresAt).getTime()) || new Date(run.leaseExpiresAt).getTime() <= now()) fail('The completed record plan and current worker lease are required.');
  }
  async function snapshot(scope, operationId, leaseToken, actor, session, records = false) {
    const current = await authority(scope, { session }); if (current.actorId !== actor.actorId || current.ownerId !== actor.ownerId) fail('The period verifier changed.');
    const run = await read(Runs, { _id: operationId, ...scope }, session); own(run, scope, leaseToken);
    const plan = await read(Plans, { _id: run.planId, ...scope, operationId, planHash: run.planHash }, session), manifest = plan?.manifest;
    if (!manifest || hash(manifest) !== run.planHash || !Array.isArray(manifest.records) || manifest.records.length !== run.recordCount || manifest.recordCount !== run.recordCount || new Set(manifest.records.map(row => row.logicalKey)).size !== run.recordCount || manifest.records.some(row => !HASH.test(row.logicalKey || '') || !HASH.test(row.fingerprint || ''))) fail('The complete original period plan is required.');
    if (!sameScope(manifest.scope, scope) || ['businessKey', 'blueprintHash', 'baselineHash', 'fromDate', 'throughDate', 'expectedCursor', 'expectedRevision', 'expectedRecordSetHash', 'requiredAssertions'].some(key => canonical(manifest[key]) !== canonical(run[key])) || !same(manifest.blueprintId, run.blueprintId)) fail('Operation fields differ from the original saved manifest.');
    const fence = await writerFence.graphSnapshot({ scope, intent: { operationId, planHash: run.planHash }, session });
    if (!records) return { run, manifest, fence };
    const found = new Map();
    for (let offset = 0; offset < manifest.records.length; offset += 200) {
      const keys = manifest.records.slice(offset, offset + 200).map(row => row.logicalKey);
      const rows = await Steps.find({ ...scope, logicalKey: { $in: keys } }).select('logicalKey entity fingerprint state qboId receipt dispatch verification lastAuditId revision dependencies').limit(201).session(session).maxTimeMS(3000).lean();
      if (rows.length !== keys.length) fail('Managed period records are missing or duplicated.');
      for (const row of rows) { if (found.has(row.logicalKey) || !keys.includes(row.logicalKey)) fail('Period records are duplicated or unrelated.'); found.set(row.logicalKey, row); }
    }
    const observed = manifest.records.map(expected => {
      const row = found.get(expected.logicalKey), proof = row?.verification, stamp = Date.parse(proof?.observedAt);
      if (!row || row.entity !== expected.entity || row.fingerprint !== expected.fingerprint || row.state !== 'verified' || !row.lastAuditId || !row.qboId || row.receipt?.qboId !== row.qboId || proof?.kind !== 'business-readback' || !HASH.test(proof.graphEvidenceHash || '') || !HASH.test(proof.observedHash || '') || !HASH.test(proof.evidenceHash || '') || !HASH.test(row.dispatch?.compilationHash || '') || proof.compilationHash !== row.dispatch.compilationHash || !Number.isFinite(stamp) || stamp > now() || now() - stamp > 300000 || !Array.isArray(proof.relationships) || canonical(proof.relationships.map(link => link.logicalKey).sort()) !== canonical([...(expected.relationships || [])].sort())) fail('Every period record needs fresh exact persisted graph evidence.');
      return { logicalKey: row.logicalKey, entity: row.entity, fingerprint: row.fingerprint, qboId: row.qboId, state: 'verified', observedHash: proof.observedHash, syncToken: proof.syncToken, observedAt: proof.observedAt, auditId: row.lastAuditId, relationships: structuredClone(proof.relationships) };
    }).sort((a, b) => a.logicalKey.localeCompare(b.logicalKey));
    return { run, manifest, fence, records: observed };
  }
  async function prepareEvidence({ scope, operationId, leaseToken, signal }) {
    scope = scoped(scope); if (!ID.test(operationId || '')) fail('Choose an exact operation.');
    const check = () => { if (signal?.aborted) fail('Period verification was cancelled.'); };
    check(); const actor = await authority(scope, { signal });
    const initial = await transaction(session => snapshot(scope, operationId, leaseToken, actor, session)); check();
    const covered = new Set(), keys = initial.manifest.records.map(row => row.logicalKey);
    while (covered.size < keys.length) {
      const roots = keys.filter(key => !covered.has(key)).slice(0, 100);
      const graph = await steps.verifyGraph(scope, operationId, roots, { signal }); check();
      if (graph?.complete !== true || graph.persisted !== true || !Array.isArray(graph.records) || roots.some(key => !graph.records.some(row => row.logicalKey === key))) fail('The complete period graph is not verified.');
      for (const row of graph.records) if (keys.includes(row.logicalKey)) covered.add(row.logicalKey);
    }
    const observed = await transaction(session => snapshot(scope, operationId, leaseToken, actor, session, true)); check();
    const run = observed.run, recordSetHash = hash(observed.records), sources = await readReports(scope, { fromDate: run.fromDate, throughDate: run.throughDate }, { signal }); check();
    const { sourceHash, evaluation: ignored, ...source } = sources || {};
    const start = Date.parse(source.startedAt), end = Date.parse(source.observedAt);
    if (source.version !== 1 || !sameScope(source.scope, scope) || canonical(source.period) !== canonical({ fromDate: run.fromDate, throughDate: run.throughDate }) || hash(source) !== sourceHash || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now() || now() - start > 300000 || observed.records.some(row => Date.parse(row.observedAt) > start) || !Array.isArray(source.accounts)) fail('Report evidence does not follow these exact record observations.');
    // Re-evaluate retained raw sources; a supplied passed flag is never authority.
    const evaluation = evaluateBooks(source.reports || {}, source.period, {}, { records: source.accounts });
    const assertions = [], unavailable = [];
    const types = { 'trial-balance': 'accrual-ledger', 'balance-sheet': 'accrual-ledger', receivables: 'open-balances-at-date', payables: 'open-balances-at-date' };
    for (const requirement of run.requiredAssertions) {
      const recordCheck = ['records', 'record-readback'].includes(requirement.key) && requirement.evidenceType === 'record-readback' && requirement.basis == null;
      const reportCheck = types[requirement.key] === requirement.evidenceType && (requirement.evidenceType === 'accrual-ledger' ? requirement.basis === 'Accrual' : requirement.basis == null) && evaluation.checks.some(row => row.key === requirement.key && row.status === 'passed');
      if (requirement.currency !== 'CAD' || (!recordCheck && !reportCheck)) { unavailable.push(requirement.key); continue; }
      assertions.push({ ...requirement, status: 'passed', recordSetHash, sourceHash: recordCheck ? hash(observed.records) : sourceHash, observedAt: source.observedAt, fromDate: run.fromDate, throughDate: run.throughDate });
    }
    if (unavailable.length) return { prepared: false, unavailable };
    const proof = { version: 1, ...scope, operationId, planHash: run.planHash, blueprintHash: run.blueprintHash, baselineHash: run.baselineHash, fromDate: run.fromDate, throughDate: run.throughDate, expectedRecordSetHash: run.expectedRecordSetHash, complete: true, observedAt: source.observedAt, records: observed.records, assertions };
    const evidenceHash = hash(proof), sourcesToSave = { ...source, sourceHash };
    if (Buffer.byteLength(canonical({ proof, sources: sourcesToSave })) > 12000000) fail('Retained period proof exceeds its storage budget.');
    return transaction(async session => {
      check(); const current = await snapshot(scope, operationId, leaseToken, actor, session, true); check();
      if (current.run.evidenceRevision !== run.evidenceRevision || canonical(current.fence) !== canonical(observed.fence) || canonical(current.records) !== canonical(observed.records)) fail('Company records changed during report verification.');
      if (!Number.isSafeInteger(run.evidenceRevision) || run.evidenceRevision < 0 || run.evidenceRevision >= Number.MAX_SAFE_INTEGER) fail('Period evidence revision is invalid.');
      const evidenceRevision = run.evidenceRevision + 1;
      validatePeriodProof({ ...current.run, evidenceRevision, verificationCandidateHash: evidenceHash }, proof, now());
      await writerFence.assertSettled(current.run, scope, session);
      const eventKey = 'business-period-evidence:' + operationId + ':' + evidenceRevision;
      const audit = await writeAudit(eventKey, { ...scope, actorId: actor.actorId, operationId, evidenceHash, sourceHash, evidenceRevision, recordCount: proof.records.length }, session);
      if (audit?.eventKey !== eventKey || typeof audit.id !== 'string' || !audit.id) fail('Period evidence audit was not saved.');
      await Evidence.create([{ _id: hash({ scope, operationId, evidenceRevision }).slice(0, 24), contractVersion: 1, ...scope, operationId, planHash: run.planHash, evidenceRevision, evidenceHash, proof, sources: sourcesToSave, actorId: actor.actorId, auditId: audit.id }], { session });
      const saved = await Runs.findOneAndUpdate({ _id: operationId, ...scope, status: 'awaiting-evidence', planHash: run.planHash, leaseToken, leaseExpiresAt: current.run.leaseExpiresAt, evidenceRevision: run.evidenceRevision }, { $set: { evidenceRevision, verificationCandidateHash: evidenceHash } }, { new: true, session }).lean();
      check(); if (!saved) fail('Period ownership changed before evidence persistence.');
      return { prepared: true, evidenceHash, evidenceRevision, recordCount: proof.records.length };
    });
  }
  async function loadProof(requestedRun) {
    const scope = scoped({ realmId: requestedRun?.realmId, environment: requestedRun?.environment, connectionId: String(requestedRun?.connectionId) }), operationId = String(requestedRun?._id);
    if (!ID.test(operationId)) fail('Choose an exact retained operation.');
    const actor = await authority(scope);
    return transaction(async session => {
      const current = await authority(scope, { session }); if (current.actorId !== actor.actorId || current.ownerId !== actor.ownerId) fail('The evidence reader changed.');
      const run = await read(Runs, { _id: operationId, ...scope }, session); assertRun(run, scope);
      if (run.planHash !== requestedRun.planHash || run.evidenceRevision !== requestedRun.evidenceRevision || run.verificationCandidateHash !== requestedRun.verificationCandidateHash) fail('The retained evidence candidate changed.');
      const row = await read(Evidence, { ...scope, operationId, planHash: run.planHash, evidenceRevision: run.evidenceRevision, evidenceHash: run.verificationCandidateHash }, session);
      if (!row || row.contractVersion !== 1 || !row.auditId || hash(row.proof) !== row.evidenceHash) fail('The exact retained period evidence is unavailable.');
      if (Buffer.byteLength(canonical({ proof: row.proof, sources: row.sources })) > 12000000) fail('Retained period sources exceed their budget.');
      const { sourceHash, ...source } = row.sources || {};
      if (source.version !== 1 || hash(source) !== sourceHash || !sameScope(source.scope, scope) || canonical(source.period) !== canonical({ fromDate: run.fromDate, throughDate: run.throughDate }) || !Array.isArray(source.accounts) || row.proof.assertions.some(check => check.sourceHash !== (check.evidenceType === 'record-readback' ? hash(row.proof.records) : sourceHash))) fail('The original retained report sources changed.');
      validatePeriodProof(run, row.proof, now()); return structuredClone(row.proof);
    });
  }
  return { prepareEvidence, loadProof };
}
module.exports = { createBusinessPeriodEvidence };
