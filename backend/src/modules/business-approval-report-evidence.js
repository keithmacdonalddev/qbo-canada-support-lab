'use strict';
const { hash, canonical } = require('./business-calendar');
const { evaluateReportSources } = require('./book-evidence');
const { reportComplete } = require('./business-financial-summary');
const { assertRunApproval } = require('./business-period-store');
const { MAX_SOURCE_BYTES } = require('./business-report-source');
const KIND = 'business-approval-reports', HASH = /^[a-f0-9]{64}$/;
const scopeOf = run => ({ realmId: run.realmId, environment: run.environment, connectionId: String(run.connectionId) });
function fail() { throw Object.assign(Error('The exact retained seven-report approval evidence is unavailable or changed.'), { status: 409, code: 'BUSINESS_APPROVAL_REPORT_UNVERIFIED' }); }
function validateApprovalReports(payload, scope, operationId, planHash, actorId, ownerId, approvedAt) {
  if (!payload || payload.version !== 1 || payload.kind !== KIND || canonical(payload.scope) !== canonical(scope) || payload.operationId !== operationId || payload.planHash !== planHash || payload.actorId !== actorId || payload.ownerId !== ownerId) fail();
  const source = payload.sources, started = Date.parse(source?.startedAt), ended = Date.parse(source?.observedAt), approved = Date.parse(approvedAt);
  if (!source || ![2, 3].includes(source.version) || canonical(source.scope) !== canonical(scope) || canonical(source.period) !== canonical(payload.period) || !HASH.test(payload.sourceHash || '') || hash(source) !== payload.sourceHash || Buffer.byteLength(canonical(source)) > MAX_SOURCE_BYTES || !Number.isFinite(started) || !Number.isFinite(ended) || !Number.isFinite(approved) || ended < started || ended - started > 180000 || ended > approved || approved - started > 300000) fail();
  const evaluation = evaluateReportSources(source, { allowExplicitZero: true });
  if (evaluation.status !== 'checks-passed' || !reportComplete(evaluation, source)) fail();
  return evaluation;
}
async function retainApprovalReports({ models, scope, operationId, planHash, actorId, ownerId, sources, session, now }) {
  if (!session?.inTransaction?.()) fail();
  const { sourceHash, evaluation: ignored, ...source } = sources;
  const payload = { version: 1, kind: KIND, scope, operationId, planHash, actorId, ownerId, period: source.period, sourceHash, sources: source };
  validateApprovalReports(payload, scope, operationId, planHash, actorId, ownerId, new Date(now).toISOString());
  const evidenceHash = hash(payload), auditId = hash({ approvalReports: evidenceHash }).slice(0, 24);
  // Reuse the append-only, indexed candidate collection with an explicit kind.
  // The immutable operation-candidate reader rejects this payload structure.
  const row = { _id: hash({ scope, evidenceHash }).slice(0, 24), contractVersion: 1, ...scope, candidateHash: evidenceHash, payload, actorId, auditId };
  if (require('mongoose').mongo.BSON.calculateObjectSize({ ...row, createdAt: new Date(now), __v: 0 }) > 15000000) fail();
  const existing = await models.Candidates.findOne({ ...scope, candidateHash: evidenceHash }).session(session).maxTimeMS(3000).lean();
  if (existing) fail();
  await models.Candidates.create([row], { session });
  await models.Audits.create([{ _id: auditId, userId: ownerId, ...(actorId !== ownerId ? { actorUserId: actorId } : {}), realmId: scope.realmId, action: 'Business approval report observation retained', actionType: 'manual', outcome: 'success', afterState: { ...scope, operationId, planHash, reportEvidenceHash: evidenceHash, reportSourceHash: sourceHash, observedAt: source.observedAt, reports: 7 } }], { session });
  return { version: 1, sourceVersion: source.version, evidenceHash, sourceHash, observedAt: source.observedAt };
}
function auditIdentity(audit, ownerId, actorId, scope, action, actionType = 'manual') {
  return audit && String(audit.userId) === ownerId && String(audit.actorUserId || audit.userId) === actorId && audit.realmId === scope.realmId && audit.action === action && audit.actionType === actionType && audit.outcome === 'success';
}
async function readApprovalReports({ models, run, ownerId, session }) {
  if (!run.approval) return null;
  assertRunApproval(run);
  const scope = scopeOf(run), operationId = String(run._id), actorId = run.approval.actorId;
  const approved = await models.Audits.findOne({ _id: run.approval.auditId }).session(session).maxTimeMS(3000).lean();
  const eventKey = 'business-plan:' + operationId + ':approved', params = approved?.inputParams, details = params?.details;
  // The audit writer records an approval under the owner's standing agent grant as 'ai_plan'.
  const agentDecision = details?.decisionSource === 'agent-standing-authority';
  if (agentDecision !== (run.approval.decisionSource === 'agent-standing-authority')) fail();
  if (!auditIdentity(approved, ownerId, actorId, scope, 'Business operation evidence recorded', agentDecision ? 'ai_plan' : 'manual') || params?.eventKey !== eventKey || ['realmId', 'environment', 'connectionId'].some(key => params[key] !== scope[key]) || details?.operationId !== operationId || details.planHash !== run.planHash || details.actorId !== actorId || details.phase !== 'approved' || ['realmId', 'environment', 'connectionId'].some(key => details[key] !== scope[key])) fail();
  const pointer = run.approval.reportEvidence;
  // An immutable approval event distinguishes genuine earlier decisions from a
  // damaged mutable run. Removing the pointer cannot downgrade a new approval.
  const marked = details.reportEvidenceHash !== undefined || details.reportSourceHash !== undefined;
  if (!marked) { if (pointer !== undefined) fail(); return null; }
  if (!pointer || pointer.version !== 1 || ![2, 3].includes(pointer.sourceVersion) || !HASH.test(pointer.evidenceHash || '') || !HASH.test(pointer.sourceHash || '') || details.reportEvidenceHash !== pointer.evidenceHash || details.reportSourceHash !== pointer.sourceHash) fail();
  const row = await models.Candidates.findOne({ ...scope, candidateHash: pointer.evidenceHash }).session(session).maxTimeMS(3000).lean();
  if (!row || row.contractVersion !== 1 || String(row.actorId) !== actorId || !row.auditId || hash(row.payload) !== pointer.evidenceHash || row.payload.sourceHash !== pointer.sourceHash || row.payload.sources?.version !== pointer.sourceVersion || row.payload.sources?.observedAt !== pointer.observedAt || canonical(row.payload.period) !== canonical({ fromDate: run.fromDate, throughDate: run.throughDate })) fail();
  const evaluation = validateApprovalReports(row.payload, scope, operationId, run.planHash, actorId, ownerId, run.approval.approvedAt);
  const observation = await models.Audits.findOne({ _id: row.auditId }).session(session).maxTimeMS(3000).lean();
  const expected = { ...scope, operationId, planHash: run.planHash, reportEvidenceHash: pointer.evidenceHash, reportSourceHash: pointer.sourceHash, observedAt: pointer.observedAt, reports: 7 };
  if (!auditIdentity(observation, ownerId, actorId, scope, 'Business approval report observation retained') || canonical(observation.afterState) !== canonical(expected)) fail();
  return { ...pointer, period: row.payload.period, reports: evaluation.reportCoverage.required, available: evaluation.reportCoverage.available };
}
module.exports = { KIND, validateApprovalReports, retainApprovalReports, readApprovalReports };
