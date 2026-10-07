'use strict';
const { scoped } = require('./qbo-write-contract');
const { ROLE_PERMISSIONS, ALL_PERMISSIONS, resolvePermissionSnapshot } = require('./rebuild-permissions');
const ID = /^[a-f0-9]{24}$/;
// Internal operation actions map to existing public permissions. No roles or
// memberships gain permissions merely because this runtime adapter is installed.
const ACTIONS = Object.freeze({
  'baseline.review': Object.freeze(['app_data.read', 'reports.read', 'blueprint.read', 'qbo_data.read']),
  'baseline.read': Object.freeze(['app_data.read', 'reports.read', 'blueprint.read']),
  'baseline.capture': Object.freeze(['reports.validate', 'blueprint.manage', 'qbo_data.read', 'app_data.read', 'reports.read', 'blueprint.read']),
  'operations.read': Object.freeze(['app_data.read', 'qbo_data.read']),
  'operations.preview': Object.freeze(['operations.preview', 'qbo_data.read']),
  'operations.execute': Object.freeze(['operations.execute']),
  'operations.record': Object.freeze(['operations.execute']),
  'operations.recover': Object.freeze(['operations.execute']),
  'operations.verify': Object.freeze(['operations.execute']),
  'operations.stop': Object.freeze(['operations.execute']),
});
function fail(message, status = 403) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_ACCESS_DENIED' }); }
const same = (a, b) => String(a) === String(b);
// actorId/ownerId must come from authenticated server context or a retained job,
// never request body overrides. Every call rereads their current company access.
function createBusinessRuntimeAccess({ actorId, ownerId, Users = require('../models/User'), Connections = require('../models/Connection'), Memberships = require('../models/CompanyMembership'), environment = () => require('../config').qbo.environment, createClient = require('./qbo-client').createQBOClient }) {
  if (!ID.test(actorId || '') || !ID.test(ownerId || '') || !Users || !Connections || !Memberships || typeof environment !== 'function' || typeof createClient !== 'function') throw new TypeError('Operation access requires exact authenticated actor and workspace owner');
  const query = (Model, filter, projection, session, sort) => {
    let value = Model.findOne(filter).select(projection).maxTimeMS(3000);
    if (session) value = value.session(session);
    if (sort) value = value.sort(sort);
    return value.lean();
  };
  const cancelled = signal => { if (signal?.aborted) fail('Operation access check was cancelled.', 409); };
  async function authorize(scope, action, { session, signal } = {}) {
    scope = scoped(scope); cancelled(signal);
    const permissions = typeof action === 'string' && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!permissions) fail('Unsupported business operation action.');
    if (scope.environment !== environment()) fail('The configured company environment changed.', 409);
    // Session reads are sequential: MongoDB does not support parallel operations
    // within one transaction. Read projections never include credentials.
    const actor = await query(Users, { _id: actorId }, '_id role', session); cancelled(signal);
    if (!actor || !same(actor._id, actorId) || !['agent', 'supervisor'].includes(actor.role)) fail('The operation actor is no longer available.');
    if (actorId !== ownerId) {
      const owner = await query(Users, { _id: ownerId }, '_id', session); cancelled(signal);
      if (!owner || !same(owner._id, ownerId)) fail('The company workspace owner is unavailable.');
      const ownConnection = await query(Connections, { userId: actorId, status: 'active' }, '_id', session);
      if (ownConnection) fail('The actor now works in its own company workspace.', 409);
    }
    const connection = await query(Connections, { userId: ownerId, status: 'active' }, '_id userId realmId status', session, { updatedAt: -1 }); cancelled(signal);
    if (!connection || !same(connection._id, scope.connectionId) || !same(connection.userId, ownerId) || connection.realmId !== scope.realmId || connection.status !== 'active') fail('The selected company connection changed.', 409);
    // Read suspended/retired memberships too: they must not fall back to a legacy role.
    const membership = await query(Memberships, { userId: actorId, realmId: scope.realmId }, '_id userId realmId role permissionOverrides status', session); cancelled(signal);
    if (membership && (!same(membership.userId, actorId) || membership.realmId !== scope.realmId || membership.status !== 'active' || !Object.hasOwn(ROLE_PERMISSIONS, membership.role) || (membership.permissionOverrides !== undefined && !Array.isArray(membership.permissionOverrides)) || (membership.permissionOverrides || []).some(value => !ALL_PERMISSIONS.includes(value)))) fail('Current company membership is unavailable or invalid.');
    if (!membership && actorId !== ownerId) fail('Active membership in this shared company is required.');
    const access = resolvePermissionSnapshot({ membership, legacyRole: actor.role });
    if (!permissions.every(permission => access.permissions.includes(permission)) || (!['operations.read', 'baseline.read', 'baseline.review'].includes(action) && access.source !== 'company-membership')) fail('Current company permission does not allow this operation.');
    if (scope.environment !== environment()) fail('The configured company environment changed.', 409);
    return { actorId, ownerId, scope, action, source: access.source };
  }
  async function resolveClient(scope, { signal } = {}) {
    scope = scoped(scope); await authorize(scope, 'operations.read', { signal }); cancelled(signal);
    // Tokens are read only here, after authority succeeds, and passed directly to
    // the existing client. They are never included in returned authority or errors.
    const connection = await Connections.findOne({ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }).maxTimeMS(3000);
    cancelled(signal);
    if (!connection || !same(connection._id, scope.connectionId) || !same(connection.userId, ownerId) || connection.realmId !== scope.realmId || connection.status !== 'active') fail('The selected company connection changed.', 409);
    const client = await createClient(connection); cancelled(signal);
    await authorize(scope, 'operations.read', { signal }); cancelled(signal);
    const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
    if (!client || client.realmId !== scope.realmId || !same(client.connection?._id, scope.connectionId) || !same(client.connection?.userId, ownerId) || client.connection?.realmId !== scope.realmId || client.connection?.status !== 'active' || client.apiBase !== base) fail('The resolved client differs from the selected company.', 409);
    return client;
  }
  return { authorize, resolveClient };
}
module.exports = { createBusinessRuntimeAccess, ACTIONS };
