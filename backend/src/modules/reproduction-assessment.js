'use strict';
const contract = require('./reproduction-assessment-contract');
const { hash } = require('./business-calendar');
const { drainCompletion } = require('./codex-inference-output');
const idOf = row => String(row?._id || row?.id || '');
const positive = value => ['completed', 'reproduced', 'not_reproduced'].includes(value);
async function auditMatches(loadAudit, id, action, session, values, origin) {
  if (!id || !origin || origin.caseId !== String(session._id) || !origin.runId || !origin.planId || !origin.actorId) return false;
  const row = await loadAudit(id), owner = String(session.userId);
  const actorMatches = origin.actorId === owner ? row?.actorUserId == null : String(row?.actorUserId) === origin.actorId;
  return row && String(row.userId) === owner && String(row.realmId) === String(session.realmId) && row.action === action && row.outcome === 'success' && row.actionType === 'ai_read' && row.aiDriven === true && String(row.approvalEvent) === origin.planId && actorMatches &&
    Object.entries(origin).every(([key, value]) => row.inputParams?.[key] === value && row.afterState?.[key] === value) &&
    Object.entries(values).every(([key, value]) => row.afterState?.[key] === value && (key === 'outcome' || row.inputParams?.[key] === value));
}

async function readAssessment(session, plan, loadAudit) {
  const run = session.reproduction, saved = run?.assessment;
  try {
    if (run?.caseContractVersion !== 2 || !saved?.auditId || !saved.payload || hash(saved.payload) !== saved.contentHash) throw Error();
    const value = saved.payload, proof = contract.snapshot(session, plan, value.observedAt);
    if (value.runId !== run.runId || value.origin?.runId !== run.runId || value.origin?.planId !== String(plan._id) || value.origin?.actorId !== String(run.actorId) || value.snapshotHash !== proof.contentHash || value.sourceHash !== run.requestSources.contentHash || value.contractHash !== run.requestContract.contentHash) throw Error();
    const result = contract.verdict(proof, value.response);
    if (hash(result) !== hash(value.result) || result.outcome !== run.outcome) throw Error();
    if (!await auditMatches(loadAudit, run.requestContract.auditId, 'Case requirements interpreted', session, { sourceHash: value.sourceHash, contractHash: value.contractHash }, run.requestContract.origin)) throw Error();
    if (!await auditMatches(loadAudit, saved.auditId, 'Case evidence independently assessed', session, { sourceHash: value.sourceHash, contractHash: value.contractHash, snapshotHash: value.snapshotHash, assessmentHash: saved.contentHash, outcome: result.outcome }, value.origin)) throw Error();
    return { valid: true, trust: 'independent-model-assessment', observedAt: value.observedAt, ...result };
  } catch {
    return { valid: false, trust: 'assessment-unavailable', outcome: 'unverified', setupComplete: false, requirements: [], reason: 'The saved independent assessment cannot be verified against its original request, checks, action receipts and audit.' };
  }
}
function createCaseAssessment({ session, plan, complete, assertActive, reload, persist, audit, loadAudit, now = () => Date.now() }) {
  const state = session.reproduction;
  async function call(system, data, deadline) {
    const prompt = JSON.stringify(contract.bounded(data, 800000)), timeoutMs = Math.min(60000, deadline - now());
    if (timeoutMs < 1) throw new Error('The independent assessment reached its time budget.');
    await assertActive();
    const controller = new AbortController();
    let checking = false;
    const stop = () => controller.abort();
    const timer = setTimeout(stop, timeoutMs);
    const poll = setInterval(async () => {
      if (checking) return; checking = true;
      try { await assertActive(); } catch { stop(); } finally { checking = false; }
    }, 750);
    try {
      const result = await drainCompletion(Promise.resolve().then(() => complete({ system, prompt, timeoutMs, signal: controller.signal, maxOutputBytes: 32768, inferenceOnly: true, maxTokens: 8192 })), { signal: controller.signal });
      await assertActive();
      controller.signal.throwIfAborted();
      return contract.parse(result?.text);
    } finally { clearTimeout(timer); clearInterval(poll); controller.abort(); }
  }
  async function ensureContract({ deadline }) {
    contract.assertSources(state.requestSources, contract.scopeOf(session));
    if (state.requestContract?.payload?.sourceHash === state.requestSources.contentHash) {
      contract.assertContract(state);
      if (!await auditMatches(loadAudit, state.requestContract.auditId, 'Case requirements interpreted', session, { sourceHash: state.requestSources.contentHash, contractHash: state.requestContract.contentHash }, state.requestContract.origin)) throw new Error('The retained requirement interpretation audit is unavailable.');
      state.conditions = state.requestContract.payload.requirements.map(row => row.label);
      return;
    }
    state.phase = 'interpreting'; await persist();
    let interpreted, lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await call(contract.INTERPRET_SYSTEM, { sources: state.requestSources.payload, previousRequirements: state.requestContract?.payload || null, ...(lastError ? { correction: lastError } : {}) }, deadline);
        interpreted = contract.contractFrom(response, state.requestSources); break;
      } catch (error) {
        lastError = error.code === 'CASE_ASSESSMENT_REQUIRED' ? error.message.slice(0, 250) : 'The interpretation service was unavailable.';
        if (error.code !== 'CASE_ASSESSMENT_REQUIRED' || error.name === 'AbortError' || now() >= deadline) throw error;
      }
    }
    if (!interpreted) throw new Error('The original request could not be interpreted completely. No new case writes were started.');
    const current = await reload();
    if (current.session.reproduction.requestSources?.contentHash !== state.requestSources.contentHash) throw new Error('The original case request changed during interpretation.');
    if (state.requestContract) {
      state.requirementHistory ||= [];
      if (state.requirementHistory.length >= 40) throw new Error('The retained requirement history reached its limit.');
      state.requirementHistory.push(contract.plain(state.requestContract));
    }
    const origin = { caseId: String(session._id), runId: state.runId, planId: String(plan._id), actorId: String(state.actorId) };
    const recorded = await audit('Case requirements interpreted', { actionType: 'ai_read', outcome: 'success',
      inputParams: { ...origin, sourceHash: state.requestSources.contentHash, contractHash: interpreted.contentHash }, afterState: { ...origin, sourceHash: state.requestSources.contentHash, contractHash: interpreted.contentHash, requirementCount: interpreted.payload.requirements.length } });
    if (!idOf(recorded)) throw new Error('The interpreted requirements could not be audited.');
    state.requestContract = { ...interpreted, origin, auditId: idOf(recorded) };
    state.conditions = interpreted.payload.requirements.map(row => row.label);
    state.assessment = null;
    state.phase = 'preparing'; await persist();
  }
  async function reviewFinish({ deadline }) {
    const observedAt = new Date(now()).toISOString(), proof = contract.snapshot(session, plan, observedAt);
    state.phase = 'assessing'; await persist();
    let response;
    try {
      response = await call(contract.REVIEW_SYSTEM, { sources: state.requestSources.payload, requirements: state.requestContract.payload, evidence: proof.payload }, deadline);
      contract.reviewResponse(response, proof);
      const current = await reload();
      const fresh = contract.snapshot(current.session, current.plan, observedAt);
      if (fresh.contentHash !== proof.contentHash) throw new Error('Case evidence or authority changed during independent assessment.');
    } catch (error) {
      if (error.code === 'AI_ASSESSMENT_CLEANUP_UNCONFIRMED') state.assessmentCleanup = 'unconfirmed';
      await assertActive();
      return { outcome: 'unverified', setupComplete: false, requirements: [], coverage: 'uncertain', reason: 'The independent evidence assessment was unavailable. Saved records remain; no further writes were authorized.' };
    }
    const result = contract.verdict(proof, response);
    const origin = { caseId: String(session._id), runId: state.runId, planId: String(plan._id), actorId: String(state.actorId) };
    const payload = { version: 2, runId: state.runId, origin, sourceHash: state.requestSources.contentHash, contractHash: state.requestContract.contentHash,
      snapshotHash: proof.contentHash, observedAt, provider: state.provider, response, result };
    const contentHash = hash(payload);
    const recorded = await audit('Case evidence independently assessed', { actionType: 'ai_read', outcome: 'success',
      inputParams: { ...origin, sourceHash: payload.sourceHash, contractHash: payload.contractHash, snapshotHash: payload.snapshotHash, assessmentHash: contentHash },
      afterState: { ...origin, sourceHash: payload.sourceHash, contractHash: payload.contractHash, snapshotHash: payload.snapshotHash, assessmentHash: contentHash, outcome: result.outcome } });
    if (!idOf(recorded)) throw new Error('The independent result could not be audited.');
    state.assessment = { payload, contentHash, auditId: idOf(recorded) };
    return result;
  }
  return { ensureContract, reviewFinish };
}
module.exports = { createCaseAssessment, readAssessment, positive };
