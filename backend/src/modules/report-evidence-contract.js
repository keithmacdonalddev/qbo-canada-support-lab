'use strict';
const { hash, canonical, date } = require('./business-calendar');
const { businessDate } = require('./business-activity-preview');
const { scoped } = require('./qbo-write-contract');
const OBSERVATION = 'Manual report check recorded', WITHDRAWAL = 'Manual report check withdrawn';
const OBS_KIND = 'manual-report-observation-v1', WITHDRAW_KIND = 'manual-report-withdrawal-v1';
const LEVELS = Object.freeze(['availability', 'population', 'plausibility', 'reconciliation']);
const STATUSES = Object.freeze(['not-checked', 'passed', 'failed', 'not-applicable']);
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'REPORT_EVIDENCE_UNAVAILABLE' }); }
function exact(value, keys) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function bounded(value, limit) { try { if (Buffer.byteLength(canonical(value)) > limit) fail('This report check exceeds its retained size budget.', 400); } catch (error) { if (error.code === 'REPORT_EVIDENCE_UNAVAILABLE') throw error; fail('Use a plain bounded report-check request.', 400); } return value; }
function text(value, min, max) { return typeof value === 'string' && value.trim().length >= min && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value); }
function sameScope(a, b) { return canonical(a) === canonical(b); }
function identity(scope, ownerId, requestKey) { return hash({ kind: OBS_KIND, scope, ownerId, requestKey: requestKey.toLowerCase() }).slice(0, 24); }
function withdrawalId(id) { return hash({ kind: WITHDRAW_KIND, observationId: id }).slice(0, 24); }
function envelope(input, scope) {
  bounded(input, 24000);
  if (!exact(input, ['requestKey','scopeHash','catalogHash','reportKey','period','basis','filters','observedOn','checks','assertions','source','confirmManual']) || !UUID.test(input.requestKey || '') || input.scopeHash !== hash(scope) || !HASH.test(input.catalogHash || '') || typeof input.reportKey !== 'string' || !/^report\.[a-z0-9-]{1,100}$/.test(input.reportKey) || input.confirmManual !== true) fail('Use the exact company and report-check request you reviewed.', 400);
  return hash(input);
}
function assertionDefinitions(definition) {
  const definitionHash = hash(definition);
  return definition.assertions.map((value, ordinal) => ({ key: hash({ reportKey: definition.key, definitionHash, ordinal, text: value }), text: value }));
}
function outcome(value) { return exact(value, ['status','note']) && STATUSES.includes(value.status) && text(value.note, value.status === 'not-checked' ? 0 : 20, 1000); }
function validateRequest(input, definition, scope, now) {
  envelope(input, scope); bounded(definition, 8000);
  if (!definition || definition.key !== input.reportKey || !Array.isArray(definition.assertions) || definition.assertions.length > 20 || definition.assertions.some(value => !text(value, 1, 1000))) fail('The exact server-owned report definition is unavailable.');
  try { date(input.period?.fromDate); date(input.period?.throughDate); date(input.observedOn); }
  catch { fail('Use valid report and observation dates.', 400); }
  if (!exact(input.period, ['fromDate','throughDate']) || input.period.fromDate > input.period.throughDate || date(input.period.throughDate) - date(input.period.fromDate) > 3660 * 86400000 || input.observedOn > businessDate(new Date(now)) || !['Accrual','Cash','Not applicable'].includes(input.basis) || !text(input.filters, 3, 1000)) fail('Use an exact report period, basis, filters and a past or current observation date.', 400);
  if (!exact(input.checks, LEVELS) || LEVELS.some(key => !outcome(input.checks[key]))) fail('Each report level needs its own result and a concrete note for every checked outcome.', 400);
  const assertions = assertionDefinitions(definition);
  if (!Array.isArray(input.assertions) || input.assertions.length !== assertions.length || input.assertions.some((value, index) => !exact(value, ['key','status','note']) || value.key !== assertions[index].key || !outcome({ status: value.status, note: value.note }))) fail('Review every exact assertion from this saved report definition.', 400);
  if ([...LEVELS.map(key => input.checks[key]), ...input.assertions].every(value => value.status === 'not-checked')) fail('Record at least one observed result; unchecked fields are not evidence.', 400);
  if (!exact(input.source, ['reference','procedure','finding']) || !text(input.source.reference, 3, 1000) || !text(input.source.procedure, 20, 2000) || !text(input.source.finding, 30, 3000)) fail('Keep a concrete source reference, the procedure followed and the finding.', 400);
  return input;
}
function eventBase(row, scope, ownerId, action, kind) {
  try { if (!sameScope(scope, scoped(scope))) throw Error(); } catch { fail('The retained report company scope changed.'); }
  if (!row || String(row.userId) !== ownerId || (row.actorUserId != null && String(row.actorUserId) !== ownerId) || row.realmId !== scope.realmId || row.action !== action || row.actionType !== 'manual' || row.outcome !== 'success' || row.aiDriven !== false || row.approvalEvent !== 'explicit-manual-report-check' || row.afterState?.version !== 1 || row.afterState.kind !== kind || !sameScope(row.afterState.scope, scope)) fail('The retained manual report event is unavailable or differs from its company.');
  bounded(row.afterState, 24000);
  return row.afterState.payload;
}
function timestamp(row, payload) {
  if (typeof payload.recordedAt !== 'string' || !Number.isFinite(Date.parse(payload.recordedAt)) || new Date(payload.recordedAt).toISOString() !== payload.recordedAt || new Date(row.createdAt).toISOString() !== payload.recordedAt) fail('The retained manual report timestamp changed.');
}
function validateObservation(row, scope, ownerId) {
  const p = eventBase(row, scope, ownerId, OBSERVATION, OBS_KIND), a = row.afterState;
  if (!exact(a, ['version','kind','scope','requestHash','evidenceHash','payload']) || !exact(p, ['version','kind','scope','ownerId','requestHash','request','definition','definitionHash','catalog','recordedAt']) || p.version !== 1 || p.kind !== OBS_KIND || p.ownerId !== ownerId || !sameScope(p.scope, scope) || a.evidenceHash !== hash(p) || a.requestHash !== p.requestHash || p.requestHash !== hash(p.request) || p.definitionHash !== hash(p.definition) || !exact(p.catalog, ['version','asOfDate','hash']) || !text(p.catalog.version, 1, 100) || !HASH.test(p.catalog.hash || '') || p.catalog.hash !== p.request.catalogHash || !ID.test(String(row._id)) || String(row._id) !== identity(scope, ownerId, p.request.requestKey)) fail('The retained manual report source or request changed.');
  timestamp(row, p); validateRequest(p.request, p.definition, scope, Date.parse(p.recordedAt)); date(p.catalog.asOfDate);
  return p;
}
function validateWithdrawal(row, scope, ownerId) {
  const p = eventBase(row, scope, ownerId, WITHDRAWAL, WITHDRAW_KIND), a = row.afterState;
  if (!exact(a, ['version','kind','scope','requestHash','decisionHash','payload']) || !exact(p, ['version','kind','scope','ownerId','observationId','observationHash','requestHash','request','reason','recordedAt']) || p.version !== 1 || p.kind !== WITHDRAW_KIND || p.ownerId !== ownerId || !sameScope(p.scope, scope) || a.decisionHash !== hash(p) || a.requestHash !== p.requestHash || p.requestHash !== envelope(p.request, scope) || !text(p.reason, 20, 2000) || p.observationId !== identity(scope, ownerId, p.request.requestKey) || String(row._id) !== withdrawalId(p.observationId) || (p.observationHash !== null && !HASH.test(p.observationHash || ''))) fail('The retained manual report withdrawal changed.');
  timestamp(row, p); return p;
}
function isReportEvidenceEvent(row) { return [OBSERVATION, WITHDRAWAL].includes(row?.action) || [OBS_KIND, WITHDRAW_KIND].includes(row?.afterState?.kind); }
function publicAuditEvent(row) {
  if (!isReportEvidenceEvent(row)) return row;
  const value = typeof row.toObject === 'function' ? row.toObject() : row;
  return Object.fromEntries([...['_id','userId','actorUserId','realmId','action','actionType','outcome','aiDriven','createdAt'].filter(key => value[key] !== undefined).map(key => [key, value[key]]), ['reportEvidence', { details: '/reports', message: 'Open Reports to inspect this manual check in its company scope.' }]]);
}
module.exports = { OBSERVATION, WITHDRAWAL, OBS_KIND, WITHDRAW_KIND, LEVELS, STATUSES, ID, HASH, fail, exact, bounded, text, sameScope, identity, withdrawalId, envelope, assertionDefinitions, validateRequest, validateObservation, validateWithdrawal, isReportEvidenceEvent, publicAuditEvent };
