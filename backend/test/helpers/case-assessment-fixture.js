'use strict';
const C = require('../../src/modules/reproduction-assessment-contract');
const { createCaseAssessment } = require('../../src/modules/reproduction-assessment');
const clone = value => JSON.parse(JSON.stringify(value));
function scenario(purpose = 'symptom') {
  const clock = Date.now(), message = 'Create an invoice for 120. Reported symptom: its remaining balance is 20.';
  const state = { caseContractVersion: 2, provider: 'anthropic', runId: 'run-1', planId: 'plan-1', actorId: 'owner', connectionId: 'connection-1', environment: 'sandbox', status: 'running', revision: 1, checks: [], stopRequested: false };
  const session = { _id: 'case-1', userId: 'owner', realmId: 'realm', messages: [], reproduction: state };
  const plan = { _id: 'plan-1', sessionId: 'case-1', userId: 'owner', realmId: 'realm', steps: [{ stepNumber: 1, toolName: 'createRecord', toolInput: { entityType: 'Invoice', record: { TotalAmt: 120, PrimaryEmailAddr: { Address: 'private@example.invalid' }, PrivateNote: 'private fixture' } }, status: 'completed', result: { success: true, data: { id: '100' } }, executedAt: new Date(clock - 2000) }] };
  state.requestSources = C.requestSources(session, { message, requestId: 'request-123456789', actorId: 'owner' });
  const req = (id, kind, label, expected) => ({ id, kind, timing: 'final', label, measurement: label, channel: 'record', predicate: { operator: 'equal', expected }, sources: [{ requestId: 'request-123456789', start: 0, end: message.length }], after: [] });
  const definition = { purpose, requirements: [req('r1', 'setup', 'Invoice total is 120', 120), ...(purpose === 'symptom' ? [req('r2', 'symptom', 'Invoice still has balance 20', 20)] : [])] };
  state.requestContract = { ...C.contractFrom(definition, state.requestSources), auditId: 'interpret-audit' };
  state.requestContract.origin = { caseId: session._id, runId: state.runId, planId: plan._id, actorId: state.actorId };
  state.startedAt = new Date(clock - 10000);
  state.conditions = definition.requirements.map(row => row.label);
  const check = (label, path, actual, expected) => ({ label, operator: 'equal', expected, actual, aggregate: 'single', available: true, passed: actual === expected, revision: 1, origin: { runId: state.runId, sourceHash: state.requestSources.contentHash, contractHash: state.requestContract.contentHash }, checkedAt: new Date(clock - 1000), sources: [{ entityType: 'Invoice', id: '100', path }] });
  state.checks = [check('Invoice total is 120', 'TotalAmt', 120, 120), ...(purpose === 'symptom' ? [check('Invoice still has balance 20', 'Balance', 20, 20)] : [])];
  const at = new Date(clock).toISOString();
  const proof = () => C.snapshot(session, plan, at);
  const review = () => ({ coverage: 'complete', reason: 'Complete original requirements measured.', requirements: definition.requirements.map(row => ({ id: row.id, relevance: 'supported', checkIds: state.checks.map((check, index) => check.label === row.label ? 'c' + (index + 1) : null).filter(Boolean), actionIds: [], constraintMet: null, reason: 'Exact saved amount and field.' })) });
  return { clock, message, state, session, plan, definition, proof, review, check };
}
async function serviceFixture(options = {}) {
  const f = scenario(), audits = new Map(), calls = [];
  let saved = { session: clone(f.session), plan: clone(f.plan) }, active = true;
  audits.set('interpret-audit', { _id: 'interpret-audit', userId: 'owner', realmId: 'realm', action: 'Case requirements interpreted', outcome: 'success', actionType: 'ai_read', aiDriven: true, approvalEvent: f.plan._id, inputParams: { ...f.state.requestContract.origin, sourceHash: f.state.requestSources.contentHash, contractHash: f.state.requestContract.contentHash }, afterState: { ...f.state.requestContract.origin, sourceHash: f.state.requestSources.contentHash, contractHash: f.state.requestContract.contentHash } });
  const persist = async () => { saved = { session: clone(f.session), plan: clone(f.plan) }; };
  const assertActive = async () => { if (!active || f.state.stopRequested) throw new Error('Stopped or revoked'); };
  const complete = async input => { calls.push(input); if (options.complete) return options.complete(input, f); return { text: JSON.stringify(input.system === C.INTERPRET_SYSTEM ? f.definition : f.review()) }; };
  const audit = async (action, details) => { if (options.failAudit === action) return null; const row = { _id: 'audit-' + audits.size, userId: 'owner', realmId: 'realm', action, aiDriven: true, approvalEvent: f.plan._id, ...clone(details) }; audits.set(row._id, row); return row; };
  const api = createCaseAssessment({ session: f.session, plan: f.plan, complete, assertActive,
    reload: async () => { if (options.onReload) await options.onReload(saved, f); return clone(saved); }, persist,
    audit, loadAudit: async id => audits.get(id) || null, now: () => options.now ? options.now() : Date.now() });
  return { ...f, api, calls, audits, persist, audit, assertActive, deactivate: () => { active = false; }, loadAudit: async id => audits.get(id) || null };
}
module.exports = { scenario, serviceFixture };
