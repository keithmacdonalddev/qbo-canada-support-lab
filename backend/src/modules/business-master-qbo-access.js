'use strict';
const { scoped, denied } = require('./qbo-write-contract');
const { QBOClient } = require('./qbo-client');
function createMasterQboAccess({ scope, ownerId, authorize, clientFor }) {
  scope = scoped(scope);
  if (!/^[a-f0-9]{24}$/.test(ownerId || '') || typeof authorize !== 'function' || typeof clientFor !== 'function') throw new TypeError('Master reads need current scoped access');
  async function client() {
    const value = await clientFor(scope), base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
    if (!(value instanceof QBOClient) || value.apiCall !== QBOClient.prototype.apiCall || value.realmId !== scope.realmId || String(value.connection?._id) !== scope.connectionId || String(value.connection?.userId) !== ownerId || value.connection?.realmId !== scope.realmId || value.connection?.status !== 'active' || value.apiBase !== base) throw denied('The original QuickBooks client must match this exact company owner.');
    return value;
  }
  async function read(action, work) {
    if (!['operations.read', 'operations.recover'].includes(action)) throw new TypeError('Unsupported master read authority');
    await authorize(scope, action);
    const qbo = await client(), value = await work(qbo);
    await authorize(scope, action);
    return value;
  }
  // readSource catches query failures; the surrounding phase must also recheck
  // access. Each page still gets its own current client and authority boundary.
  const queryClient = Object.freeze({ query: sql => read('operations.read', qbo => QBOClient.prototype.query.call(qbo, sql)) });
  return Object.freeze({ client, read, queryClient });
}
module.exports = { createMasterQboAccess };
