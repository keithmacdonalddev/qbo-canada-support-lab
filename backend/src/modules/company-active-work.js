'use strict';
const { scoped, denied } = require('./qbo-write-contract');
function legacyCompanyWorkQueries(scope) {
  return [
    ['seedruns', { realmId: scope.realmId, status: { $in: ['pending', 'in_progress'] } }],
    ['generationruns', { realmId: scope.realmId, $or: [{ status: { $in: ['pending', 'in_progress'] } }, { 'steps.state': { $in: ['sending', 'uncertain'] } }] }],
    ['issuepackruns', { realmId: scope.realmId, status: { $in: ['pending', 'in_progress', 'running'] } }],
    ['aisessions', { realmId: scope.realmId, $or: [{ 'reproduction.status': 'running' }, { 'reproduction.outcomeUnknown': true }] }],
    ['aiplans', { realmId: scope.realmId, status: 'executing' }],
  ];
}
// Reads only, inside the caller's policy-fenced transaction. Historical legacy
// environments are incomplete, so an active job in this realm always blocks.
async function companyActiveWork(db, suppliedScope, { session, includeMaster = true, includeBusiness = false } = {}) {
  const scope = scoped(suppliedScope), company = { environment: scope.environment, realmId: scope.realmId };
  if (!db || typeof db.collection !== 'function') throw denied('Company work history is unavailable.');
  const queries = legacyCompanyWorkQueries(scope);
  if (includeBusiness) queries.push(['operationruns', { ...company, $or: [{ status: { $in: ['approved', 'reserved', 'running', 'blocked', 'stopped', 'awaiting-evidence', 'committing'] } }, { 'executionRequest.pending': true }] }]);
  if (includeMaster) queries.push(['masterpreparationruns', { ...company, claim: 'open', state: { $in: ['approved', 'running', 'stopped', 'blocked', 'complete'] } }]);
  const blockers = [];
  for (const [collection, filter] of queries) {
    const row = await db.collection(collection).findOne(filter, { session, projection: { _id: 1 }, maxTimeMS: 3000 });
    if (row) blockers.push({ collection, id: String(row._id) });
  }
  return blockers;
}
function createMasterQuiescence(db) {
  return async ({ scope, session }) => {
    if (!session?.inTransaction?.()) throw denied('Master admission requires a transaction.');
    const blockers = await companyActiveWork(db, scope, { session, includeMaster: false, includeBusiness: true });
    if (blockers.length) throw denied('Earlier company work needs completion or recovery before master records can be created.');
  };
}
module.exports = { legacyCompanyWorkQueries, companyActiveWork, createMasterQuiescence };
