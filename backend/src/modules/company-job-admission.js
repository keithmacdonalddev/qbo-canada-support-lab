'use strict';
const { scoped, denied } = require('./qbo-write-contract');
const { currentActorId } = require('./actor-context');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessTransaction } = require('./business-transaction');
const { assertPeriodControl } = require('./qbo-write-period');
const setup = require('./business-storage-setup');
function createCompanyJobAdmission({ Policies, Writers, Users, Connections, Memberships, transaction, assertReady, accessFor = createBusinessRuntimeAccess, environment = () => require('../config').qbo.environment }) {
  return async function admit(connection, action, work) {
    const scope = scoped({ environment: environment(), realmId: String(connection.realmId), connectionId: String(connection._id) });
    const ownerId = String(connection.userId), actorId = String(currentActorId() || ownerId);
    await assertReady(scope, ownerId);
    const access = accessFor({ Users, Connections, Memberships, ownerId, actorId, environment });
    return transaction(async session => {
      await access.authorize(scope, action, { session });
      for (const id of new Set([ownerId, actorId])) {
        const changed = await Users.updateOne({ _id: id, role: { $in: ['agent', 'supervisor'] } }, { $inc: { connectionSwitchVersion: 1 } }, { session });
        if (changed.matchedCount !== 1) throw denied('The job actor or company owner changed.');
      }
      const member = await Memberships.updateOne({ userId: actorId, realmId: scope.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { session });
      const selected = await Connections.updateOne({ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }, { $inc: { businessSetupVersion: 1 } }, { session });
      if (member.matchedCount !== 1 || selected.matchedCount !== 1) throw denied('Current company access changed before the job was saved.');
      // Activation writes this same policy document before scanning durable jobs.
      // A competing job claim conflicts and retries against the preparing state.
      const policy = await Policies.findOneAndUpdate({ ...scope, contractVersion: 1, state: 'active' }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!policy || !/^[a-f0-9]{64}$/.test(policy.preparationEvidenceHash || '')) throw denied('Prepare and enable company write coordination on the Company page before starting work.');
      assertPeriodControl(policy.periodControl, scope, ownerId);
      const writer = await Writers.findOne({ environment: scope.environment, realmId: scope.realmId }).session(session).maxTimeMS(3000).lean();
      if (!writer || writer.contractVersion !== 1 || String(writer.connectionId) !== scope.connectionId || writer.operationId !== null || writer.planHash !== null || writer.unresolved !== null) throw denied('Finish or recover the current company writer before starting another job.');
      return work(session);
    });
  };
}
let defaultAdmission;
function admitCompanyJob(connection, action, work) {
  if (!defaultAdmission) {
    const mongoose = require('mongoose');
    const models = Object.fromEntries(Object.entries({ Policies: 'CompanyWritePolicy', Writers: 'CompanyWriter', Users: 'User', Connections: 'Connection', Memberships: 'CompanyMembership' }).map(([key, name]) => [key, require('../models/' + name)]));
    const assertReady = async (scope, ownerId) => {
      if (mongoose.connection.readyState !== 1) throw denied('Company job storage is unavailable.');
      try {
        await setup.assertProfileSetupCompleted(mongoose.connection.db, { ...scope, ownerId }, 'continual-business');
        const storage = await setup.inspectStorage(mongoose.connection.db, 'continual-business');
        if (storage.some(row => row.create || row.missingIndexes.length)) throw new Error('storage changed');
      } catch { throw denied('Review and complete business storage preparation on the Company page before starting work.'); }
    };
    defaultAdmission = createCompanyJobAdmission({ ...models, assertReady, transaction: createBusinessTransaction(mongoose.connection) });
  }
  return defaultAdmission(connection, action, work);
}
module.exports = { createCompanyJobAdmission, admitCompanyJob };
