'use strict';
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_AGENT_AUTHORITY_REQUIRED' }); }
function agentAuthority(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'agentId,authorityHash,grantId,ownerId,version' || value.version !== 1 || !ID.test(value.agentId || '') || !ID.test(value.ownerId || '') || !HASH.test(value.grantId || '') || !HASH.test(value.authorityHash || '')) fail('The original company-agent authorization is incomplete.');
  return { ...value };
}
// Grant IDs and publication hashes record when a decision was made. They do not
// change the accountant or owner. Callers must still prove scope and fence current
// standing authority before admission; this comparison alone grants no permission.
function sameAgentLineage(a, b) { const x = agentAuthority(a), y = agentAuthority(b); return x.agentId === y.agentId && x.ownerId === y.ownerId; }
function sameAuthority(a, b) { return sameAgentLineage(a, b); }
function ownsAgentWork(origin, agent) {
  try { return sameAgentLineage(origin, { version: 1, agentId: String(agent._id || agent.id), ownerId: String(agent.ownerId), grantId: agent.grant?.id, authorityHash: agent.grant?.authorityHash }); }
  catch { return false; }
}
function assertAgentApproval(run) {
  if (!run?.agentAuthority) { if (run?.approval?.agentAuthority) fail('An agent approval cannot authorize an owner-created operation.'); return; }
  const origin = agentAuthority(run.agentAuthority);
  if (String(run.createdBy) !== origin.ownerId || !sameAgentLineage(run.approval?.agentAuthority, origin) || !['agent-standing-authority', 'owner-review'].includes(run.approval?.decisionSource)) fail('The operation no longer matches its original agent decision and owner authorization.');
  if (run.environment === 'production' && run.approval.productionConsent?.source !== run.approval.decisionSource) fail('The Production authorization source changed.');
}
// Touch the same scoped agent document as Pause inside accounting admission, so
// concurrent revocation conflicts and is re-read. Already admitted receipts settle
// without this fence. An expired or replaced worker lease cannot admit new work.
async function fenceAgentAuthority({ authority, run, scope, ownerId, actorId, Agents, session, lease = null }) {
  const value = authority || run?.agentAuthority;
  if (!value) return null;
  const origin = agentAuthority(value);
  if (!session?.inTransaction?.()) fail('Agent authorization requires the accounting transaction.');
  if (origin.ownerId !== String(ownerId) || String(actorId) !== origin.ownerId || (run && (String(run.createdBy) !== origin.ownerId || run.agentAuthority && !sameAgentLineage(run.agentAuthority, origin)))) fail('Agent work belongs to a different owner or accountant.');
  if (run && ['environment', 'realmId', 'connectionId'].some(key => run[key] !== undefined && String(run[key]) !== String(scope[key]))) fail('Agent work belongs to a different company.');
  const batchPolicy = run?.activityBatch?.policyHash;
  if (run?.activityBatch && !require('./business-activity-batch').SAVED_POLICIES.has(batchPolicy)) fail('The additional business activity policy is unknown.');
  const Model = Agents || require('../models/BusinessAgent');
  const current = await Model.findOneAndUpdate({ _id: origin.agentId, environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, ownerId: origin.ownerId, 'settings.monitoring': true, 'settings.autonomous': true, 'grant.ownerId': origin.ownerId, ...(lease ? { leaseToken: String(lease.token || ''), leaseExpiresAt: { $gt: new Date((lease.now || Date.now)()) } } : {}) }, { $inc: { dispatchRevision: 1 } }, { new: true, session }).lean();
  if (!current || !ownsAgentWork(origin, current)) fail(lease ? 'The business agent is paused, its company authorization changed, or this review lost its worker lease. No new accounting work was admitted.' : 'The business agent is paused or its company authorization changed. No new accounting request was admitted.');
  return agentAuthority({ version: 1, agentId: String(current._id), ownerId: String(current.ownerId), grantId: current.grant.id, authorityHash: current.grant.authorityHash });
}
module.exports = { agentAuthority, sameAuthority, sameAgentLineage, ownsAgentWork, assertAgentApproval, fenceAgentAuthority };
