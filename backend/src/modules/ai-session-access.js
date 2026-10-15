'use strict';
const { assertAccountEligible, accountVersion } = require('./account-policy');
const { normalizePermissions } = require('./rebuild-permissions');
const denied = (message = 'Your current company access does not include this saved session.', status = 403) => Object.assign(new Error(message), { status, savedSessionAccess: true });
function createSessionAccess({ loadAccount = require('../middleware/currentAccount').loadCurrentAccount, Memberships = require('../models/CompanyMembership'), now = () => Date.now() } = {}) {
  async function accounts(user, account) {
    const ownerId = String(user?.id || ''), actorId = String(user?.actorId || user?.id || '');
    if (!ownerId || !actorId) throw denied('Authentication required.', 401);
    const actor = await loadAccount(actorId);
    try { assertAccountEligible(actor); } catch { throw denied('Your account can no longer read saved company work.'); }
    if (String(actor._id) !== actorId || (account && (String(account.id) !== actorId || accountVersion(actor) !== account.authVersion || now() >= account.sessionExpiresAt))) throw denied('Your account authorization changed.');
    if (actorId !== ownerId) {
      const owner = await loadAccount(ownerId);
      try { assertAccountEligible(owner); } catch { throw denied('The company workspace account is unavailable.'); }
      if (String(owner._id) !== ownerId) throw denied('The company workspace account is unavailable.');
    }
    return { ownerId, actorId };
  }
  async function assertSession(user, session, account) {
    if (!session || String(session.userId) !== String(user?.id) || typeof session.realmId !== 'string' || !session.realmId) throw denied('Session not found.', 404);
    const { ownerId, actorId } = await accounts(user, account);
    // Owners retain read access to their historical and disconnected companies.
    // Sharing a workspace never grants another company's saved data.
    if (actorId !== ownerId) {
      const member = await Memberships.findOne({ userId: actorId, realmId: session.realmId, status: 'active' }).select('role permissionOverrides').maxTimeMS(3000).lean();
      if (!member || !normalizePermissions(member.role, member.permissionOverrides).includes('app_data.read')) throw denied();
    }
  }
  async function listScope(user, account) {
    const { ownerId, actorId } = await accounts(user, account);
    const members = actorId === ownerId ? null : await Memberships.find({ userId: actorId, status: 'active' }).select('realmId role permissionOverrides').maxTimeMS(3000).lean();
    const realms = members === null ? null : [...new Set(members.filter(member => normalizePermissions(member.role, member.permissionOverrides).includes('app_data.read')).map(member => member.realmId).filter(realm => typeof realm === 'string' && realm))].sort();
    return { ownerId, actorId, realms, filter: { userId: ownerId, ...(realms === null ? {} : { realmId: { $in: realms } }) } };
  }
  async function assertListScope(scope, user, account) {
    const current = await listScope(user, account);
    if (current.ownerId !== scope.ownerId || current.actorId !== scope.actorId || JSON.stringify(current.realms) !== JSON.stringify(scope.realms)) throw denied('Company access changed while reading saved sessions. Refresh to try again.');
  }
  const checked = fn => async (...args) => {
    try { return await fn(...args); } catch (error) { if (error?.savedSessionAccess) throw error; throw denied('Saved company access could not be verified. Try again when storage is available.', 503); }
  };
  return { assertSession: checked(assertSession), listScope: checked(listScope), assertListScope: checked(assertListScope) };
}
function respondSessionAccess(res, error) {
  if (!error?.savedSessionAccess) return false;
  res.status(error.status).json({ success: false, error: error.message, code: 'SAVED_SESSION_ACCESS_REQUIRED' });
  return true;
}
module.exports = { createSessionAccess, respondSessionAccess };
