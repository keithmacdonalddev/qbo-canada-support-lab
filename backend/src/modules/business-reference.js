'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/, HASH = /^[a-f0-9]{64}$/;
const ENTITIES = new Set(['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'TaxCode']);
const TRANSACTIONS = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment']);
// Definition contract v1: do not expand these exclusions without a new version.
// Balances and stock are current observations, not approved master definitions.
const DYNAMIC = Object.freeze({ Customer: ['Balance', 'BalanceWithJobs'], Vendor: ['Balance'], Employee: [], Item: ['QtyOnHand'], Account: ['CurrentBalance', 'CurrentBalanceWithSubAccounts'], TaxCode: [] });
const METADATA = new Set(['SyncToken', 'MetaData', 'domain', 'sparse']);
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_REFERENCE_UNVERIFIED' }); }
function fresh(stamp, now) { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(now) && Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= now && now - value <= 300000; }
function sameScope(a, b) { return ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]); }
function referenceDefinition(scope, entity, record) {
  scope = scoped(scope);
  if (!ENTITIES.has(entity) || !record || Object.getPrototypeOf(record) !== Object.prototype || typeof record.Id !== 'string' || !ID.test(record.Id) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || record.Active !== true || (record.sparse !== undefined && record.sparse !== false)) fail('A complete active company record with an exact version is required.');
  let serialized;
  try { serialized = canonical(record); } catch { fail('Company reference observations must be plain JSON.'); }
  if (Buffer.byteLength(serialized) > 256000) fail('The company reference exceeds its observation size budget.');
  for (const key of DYNAMIC[entity]) if (key in record && (typeof record[key] !== 'number' || !Number.isFinite(record[key]))) fail('A current balance or quantity has an invalid value.');
  const fields = Object.fromEntries(Object.entries(record).filter(([key]) => !METADATA.has(key) && !DYNAMIC[entity].includes(key)));
  return { version: 1, hash: hash({ version: 1, scope, entity, fields }) };
}
function validateReferenceBinding(binding) {
  if (!binding || !ENTITIES.has(binding.entity) || typeof binding.key !== 'string' || !binding.key || binding.key.length > 100 || typeof binding.id !== 'string' || !ID.test(binding.id) || typeof binding.syncToken !== 'string' || !VERSION.test(binding.syncToken) || binding.status !== 'resolved' || binding.definition?.version !== 1 || typeof binding.definition.hash !== 'string' || !HASH.test(binding.definition.hash)) fail('Each record choice requires its approved definition and original version.');
}
function observedRecord(scope, entity, observed, now) {
  if (!observed || !sameScope(observed.scope, scope) || observed.entity !== entity || !fresh(observed.observedAt, now) || !observed.record || observed.recordHash !== hash(observed.record)) fail('The company reference is stale, incomplete or from another company.');
  const source = observed.source, record = observed.record;
  if (!source || source.version !== 1 || source.kind !== 'qbo-full-entity-get' || !sameScope(source.scope, scope) || source.entity !== entity || source.id !== record.Id || source.endpoint !== entity.toLowerCase() + '/' + record.Id || source.recordHash !== observed.recordHash) fail('The reference requires provenance from a complete QuickBooks entity GET.');
  return record;
}
// Preparation only: bind a fresh full entity read BEFORE the step's policy is
// approved. Calling this function does not confer approval or write authority.
function bindBusinessReference({ scope, key, entity, observed, now = Date.now() }) {
  scope = scoped(scope);
  const record = observedRecord(scope, entity, observed, now), definition = referenceDefinition(scope, entity, record);
  const binding = { key, entity, id: record.Id, syncToken: record.SyncToken, status: 'resolved', definition };
  validateReferenceBinding(binding); return binding;
}
// Execution never rewrites the saved binding. Version drift is permitted only
// when the complete master definition still matches the approved v1 definition.
function verifyBusinessReference({ scope, binding, observed, now = Date.now() }) {
  scope = scoped(scope); validateReferenceBinding(binding);
  const record = observedRecord(scope, binding.entity, observed, now), definition = referenceDefinition(scope, binding.entity, record);
  if (record.Id !== binding.id || BigInt(record.SyncToken) < BigInt(binding.syncToken) || definition.hash !== binding.definition.hash) fail('The selected ' + binding.entity + ' (' + binding.key + ') differs from its approved definition or version.');
  return record;
}
// Fixed full GET only; there is no caller-provided endpoint, query projection or
// record-enrichment hook. The resolver must supply the existing scoped QBO client.
function createBusinessRecordReader({ resolveClient, authorize, now = () => Date.now() }, transactions = false) {
  const entities = transactions ? TRANSACTIONS : ENTITIES;
  const action = transactions ? 'operations.read' : 'operations.preview';
  if ([resolveClient, authorize, now].some(value => typeof value !== 'function')) throw new TypeError('Reference reading needs explicit company client and authority adapters');
  return async (scope, entity, id, { signal } = {}) => {
    scope = scoped(scope);
    if (!entities.has(entity) || typeof id !== 'string' || !ID.test(id)) fail('Choose an exact supported company reference.');
    const started = now(), controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 60000); timeout.unref?.();
    const check = () => { if (controller.signal.aborted || !Number.isFinite(now()) || now() - started > 60000) fail('The full reference read was cancelled or exceeded its one-minute budget.'); };
    const call = factory => new Promise((resolve, reject) => {
      const cancelled = () => { try { check(); } catch (error) { reject(error); } };
      if (controller.signal.aborted) { cancelled(); return; }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { check(); return factory(); }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled));
    });
    try {
      check(); const actor = await call(() => authorize(scope, action, { signal: controller.signal })); check();
      if (!actor?.actorId) fail('Company reference read permission is required.');
      const client = await call(() => resolveClient(scope, { signal: controller.signal })); check();
      const expectedBase = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
      const clientScope = () => { if (!client || typeof client.read !== 'function' || String(client.connection?._id) !== scope.connectionId || client.realmId !== scope.realmId || String(client.connection?.realmId) !== scope.realmId || client.apiBase !== expectedBase || client.connection?.status !== 'active') fail('The QuickBooks client no longer matches the approved company connection.'); };
      if (transactions) {
        const { QBOClient } = require('./qbo-client');
        if (!(client instanceof QBOClient) || client.read !== QBOClient.prototype.read || client.apiCall !== QBOClient.prototype.apiCall || !/^[a-f0-9]{24}$/.test(actor.ownerId || '') || String(client.connection?.userId) !== actor.ownerId) fail('Saved transaction reads require the original scoped QuickBooks client.');
      }
      clientScope();
      const body = await call(() => client.read(entity.toLowerCase(), id)); check(); clientScope();
      if (!body || Object.getPrototypeOf(body) !== Object.prototype || Object.keys(body).some(key => ![entity, 'time'].includes(key)) || !body[entity] || body[entity].Id !== id) fail('QuickBooks did not return the requested full entity envelope.');
      const serialized = canonical(body[entity]);
      if (Buffer.byteLength(serialized) > 256000) fail('The saved record exceeds its observation size budget.');
      const record = JSON.parse(serialized);
      if (transactions) {
        if (!record || Object.getPrototypeOf(record) !== Object.prototype || record.Id !== id || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || (record.sparse !== undefined && record.sparse !== false) || record.status === 'Deleted') fail('A complete saved transaction with an exact version is required.');
      } else referenceDefinition(scope, entity, record);
      const recordHash = hash(record), observedAt = new Date(now()).toISOString();
      const currentActor = await call(() => authorize(scope, action, { signal: controller.signal })); check(); clientScope();
      if (currentActor?.actorId !== actor.actorId || (transactions && (currentActor?.ownerId !== actor.ownerId || String(client.connection?.userId) !== actor.ownerId))) fail('The company reader changed during the reference read.');
      return { scope, entity, observedAt, record, recordHash, source: { version: 1, kind: 'qbo-full-entity-get', scope, entity, id, endpoint: entity.toLowerCase() + '/' + id, recordHash } };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
const createBusinessReferenceReader = options => createBusinessRecordReader(options);
const createBusinessTransactionReader = options => createBusinessRecordReader(options, true);
module.exports = { createBusinessReferenceReader, createBusinessTransactionReader, bindBusinessReference, verifyBusinessReference, validateReferenceBinding, referenceDefinition };
