'use strict';
const { denied, scoped } = require('./qbo-write-contract');
// For owner decisions inside a caller transaction. Authorization is reread and
// the same documents changed by account, membership and connection changes are written.
async function fenceBusinessOwner({ models, scope, ownerId, actorId, access, action, session }) {
  scope = scoped(scope);
  if (actorId !== ownerId || !session?.inTransaction?.()) throw denied('This decision requires the current company owner and a transaction.');
  await access.authorize(scope, action, { session });
  const read = (Model, filter, fields) => Model.findOne(filter).select(fields).session(session).maxTimeMS(3000).lean();
  const user = await read(models.Users, { _id: ownerId }, '_id role connectionSwitchVersion');
  const member = await read(models.Memberships, { userId: ownerId, realmId: scope.realmId, status: 'active' }, '_id role userId realmId status');
  if (!user || !member) throw denied('Current company-owner authority is unavailable.');
  const userVersion = user.connectionSwitchVersion ?? 0;
  if (!Number.isSafeInteger(userVersion) || userVersion < 0 || userVersion >= Number.MAX_SAFE_INTEGER) throw denied('Current owner scope needs recovery.');
  const touched = await models.Users.findOneAndUpdate({ _id: ownerId, role: user.role, connectionSwitchVersion: user.connectionSwitchVersion === undefined ? { $exists: false } : userVersion }, { $inc: { connectionSwitchVersion: 1 } }, { new: true, session }).select('_id').lean();
  const membership = await models.Memberships.findOneAndUpdate({ _id: member._id, userId: ownerId, realmId: scope.realmId, role: member.role, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { new: true, session }).select('_id').lean();
  const connection = await models.Connections.findOneAndUpdate({ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { new: true, session }).select('_id').lean();
  if (!touched || !membership || !connection) throw denied('Company-owner authority changed during this decision.');
}
module.exports = { fenceBusinessOwner };
