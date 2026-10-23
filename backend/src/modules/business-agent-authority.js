'use strict';
const { canonical } = require('./business-calendar');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AGENT_AUTHORITY_REQUIRED' }); }
function agentAuthority(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'agentId,authorityHash,grantId,ownerId,version' || value.version !== 1 || !ID.test(value.agentId || '') || !ID.test(value.ownerId || '') || !HASH.test(value.grantId || '') || !HASH.test(value.authorityHash || '')) fail('The original company-agent authorization is incomplete.');
  return { ...value };
}
function sameAuthority(a, b) { return canonical(agentAuthority(a)) === canonical(agentAuthority(b)); }
function assertAgentApproval(run) {
  if (!run?.agentAuthority) { if (run?.approval?.agentAuthority) fail('An agent approval cannot authorize an owner-created operation.'); return; }
  const origin = agentAuthority(run.agentAuthority);
  if (String(run.createdBy) !== origin.ownerId || run.authorityHash !== origin.authorityHash || !sameAuthority(run.approval?.agentAuthority, origin) || !['agent-standing-authority', 'owner-review'].includes(run.approval?.decisionSource)) fail('The operation no longer matches its original agent decision and owner authorization.');
  if (run.environment === 'production' && run.approval.productionConsent?.source !== run.approval.decisionSource) fail('The Production authorization source changed.');
}
// Called INSIDE the actual accounting-admission transaction. Touching the same
// document as Pause makes concurrent revocation conflict and be re-read. Receipt
// settlement never calls this function: an already admitted request must settle.
async function fenceAgentAuthority({ authority, run, scope, ownerId, actorId, Agents, session }) {
  const value = authority || run?.agentAuthority;
  if (!value) return null;
  const origin = agentAuthority(value);
  if (!session?.inTransaction?.()) fail('Agent authorization requires the accounting transaction.');
  if (origin.ownerId !== String(ownerId) || String(actorId) !== origin.ownerId || (run && (run.authorityHash !== origin.authorityHash || String(run.createdBy) !== origin.ownerId))) fail('Agent work belongs to a different owner or published business.');
  const Model = Agents || require('../models/BusinessAgent');
  const current = await Model.findOneAndUpdate({ _id: origin.agentId, environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, ownerId: origin.ownerId, 'settings.monitoring': true, 'settings.autonomous': true, 'grant.id': origin.grantId, 'grant.authorityHash': origin.authorityHash, 'grant.ownerId': origin.ownerId }, { $inc: { dispatchRevision: 1 } }, { new: true, session }).lean();
  if (!current) fail('The business agent is paused or its company authorization changed. No new accounting request was admitted.');
  return origin;
}
module.exports = { agentAuthority, sameAuthority, assertAgentApproval, fenceAgentAuthority };
