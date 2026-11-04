'use strict';
const { scoped } = require('./qbo-write-contract');
const { canonical } = require('./business-calendar');
const { createBusinessTransactionBatchReader } = require('./business-transaction-batch-reader');
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_VERIFICATION_UNAVAILABLE' }); }
// One independent full-record window per readMany invocation. No writerFence is
// supplied, so the transaction reader cannot reuse an earlier close observation.
function createGeneralCloseReader({ scope, access, client, signal = new AbortController().signal, now = () => Date.now() }) {
  scope = scoped(scope);
  const check = value => { signal.throwIfAborted(); if (canonical(scoped(value)) !== canonical(scope)) fail('The close reader cannot change its company scope.'); };
  const identity = (entity, id) => { if (!/^[A-Z][A-Za-z0-9]{0,49}$/.test(entity || '') || !/^\d{1,30}$/.test(id || '')) fail('Close reads require exact saved record identities.'); };
  const grouped = createBusinessTransactionBatchReader({ access, now });
  // Exact GET preserves inactive master coverage. Active-filter equivalence for
  // grouped Customer/Vendor/Item queries is not established for this close.
  const batchable = entity => grouped.supports(entity) && !['Customer', 'Vendor', 'Item'].includes(entity);
  async function read(value, entity, id) {
    check(value); identity(entity, id);
    const actor = await access.authorize(scope, 'operations.read', { signal }); check(value);
    const guard = async () => {
      check(value);
      const current = await access.authorize(scope, 'operations.read', { signal }); check(value);
      const base = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
      if (current?.actorId !== actor?.actorId || current?.ownerId !== actor?.ownerId || client.realmId !== scope.realmId || client.apiBase !== base || String(client.connection?._id) !== scope.connectionId || String(client.connection?.realmId) !== scope.realmId || client.connection?.status !== 'active' || String(client.connection?.userId) !== actor?.ownerId) fail('The close reader changed company or authority.');
    };
    await guard();
    const body = await client.apiCall('GET', entity.toLowerCase() + '/' + id, undefined, 0, 0, { signal, beforeAttempt: guard, onFailure: () => {} });
    await guard();
    return body?.[entity === 'CreditCardPayment' ? 'CreditCardPaymentTxn' : entity] || null;
  }
  async function readMany(value, identities) {
    check(value);
    const wanted = new Set();
    for (const row of identities) { identity(row.entity, row.qboId); const key = row.entity + ':' + row.qboId; if (wanted.has(key)) fail('Close reads require unique saved identities.'); wanted.add(key); }
    const supported = identities.filter(row => batchable(row.entity)), result = new Map();
    const observations = await grouped(scope, supported, { signal }); check(value);
    for (const row of supported) {
      const key = row.entity + ':' + row.qboId, observed = observations.get(key);
      if (!observed || canonical(observed.scope) !== canonical(scope) || observed.entity !== row.entity || observed.record?.Id !== row.qboId) fail('A grouped close observation changed scope or identity.');
      result.set(key, observed.record);
    }
    if (observations.size !== supported.length) fail('Grouped close observations contain unexpected identities.');
    // Other types and masters retain their original exact GET. An incomplete query is
    // never retried as a singleton or substituted with retained/create data.
    for (const row of identities.filter(row => !batchable(row.entity))) {
      const record = await read(value, row.entity, row.qboId);
      if (!record || record.Id !== row.qboId) fail('An exact saved close record is unavailable.');
      result.set(row.entity + ':' + row.qboId, record);
    }
    check(value); return result;
  }
  return { read, readMany };
}
module.exports = { createGeneralCloseReader };
