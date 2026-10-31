'use strict';
const { hash, canonical } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { runWithCaller } = require('./qbo-request-meter');
const { createBusinessObservationStore } = require('./business-observation-store');
const ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/, HASH = /^[a-f0-9]{64}$/;
const ENTITIES = new Set(['Customer', 'Vendor', 'Employee', 'Item', 'Account', 'TaxCode']);
// Saved-record reads: transactions plus the list records the accountant adds.
const TRANSACTIONS = new Set(['Estimate', 'TimeActivity', 'Invoice', 'Payment', 'Deposit', 'PurchaseOrder', 'Bill', 'SalesReceipt', 'BillPayment', 'CreditMemo', 'Purchase', 'VendorCredit', 'RefundReceipt', 'Transfer', 'JournalEntry', 'Customer', 'Vendor', 'Item']);
// Keep v1 stable for saved approvals. Items/tax codes use canonical v2 definitions.
// Balances and stock are current observations, not approved master definitions.
const DYNAMIC = Object.freeze({ Customer: ['Balance', 'BalanceWithJobs'], Vendor: ['Balance'], Employee: [], Item: ['QtyOnHand'], Account: ['CurrentBalance', 'CurrentBalanceWithSubAccounts'], TaxCode: [] });
const METADATA = new Set(['SyncToken', 'MetaData', 'domain', 'sparse']);
function fail(message, detail = {}) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_REFERENCE_UNVERIFIED', businessDetail: detail }); }
function fresh(stamp, now) { const value = typeof stamp === 'string' ? Date.parse(stamp) : NaN; return Number.isFinite(now) && Number.isFinite(value) && new Date(value).toISOString() === stamp && value <= now && now - value <= 300000; }
function sameScope(a, b) { return ['realmId', 'environment', 'connectionId'].every(key => a?.[key] === b?.[key]); }
// Canonical definition fields exclude transport state and reference display labels.
// Unknown provider settings stay bound: only known presentation fields are removed.
function definitionFields(entity, record) {
  function copy(value, key = '') {
    if (Array.isArray(value)) return value.map(entry => copy(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([field]) => !(field === 'name' && /Ref$/.test(key) && typeof value.value === 'string')).map(([field, entry]) => [field, copy(entry, field)]));
  }
  return copy(Object.fromEntries(Object.entries(record).filter(([key]) => !METADATA.has(key) && !['CreateTime', 'LastUpdatedTime'].includes(key) && !(DYNAMIC[entity] || []).includes(key))));
}
// Absent and default-empty values are the same definition: QuickBooks adds new fields
// (e.g. Item.DeferredRevenue: false) to live reads that older copies never carried.
function withoutDefaults(value) {
  if (Array.isArray(value)) return value.map(withoutDefaults);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== false && entry !== null && entry !== '' && !(Array.isArray(entry) && entry.length === 0)).map(([key, entry]) => [key, withoutDefaults(entry)]));
}
function sameCanonicalDefinition(entity, a, b) { return hash(withoutDefaults(definitionFields(entity, a))) === hash(withoutDefaults(definitionFields(entity, b))); }
function referenceDefinition(scope, entity, record, version = ['Item', 'TaxCode'].includes(entity) ? 2 : 1) {
  scope = scoped(scope);
  if (!ENTITIES.has(entity) || !record || Object.getPrototypeOf(record) !== Object.prototype || typeof record.Id !== 'string' || !ID.test(record.Id) || typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken) || record.Active !== true || (record.sparse !== undefined && record.sparse !== false)) fail('A complete active company record with an exact version is required.');
  let serialized;
  try { serialized = canonical(record); } catch { fail('Company reference observations must be plain JSON.'); }
  if (Buffer.byteLength(serialized) > 256000) fail('The company reference exceeds its observation size budget.');
  for (const key of DYNAMIC[entity]) if (key in record && (typeof record[key] !== 'number' || !Number.isFinite(record[key]))) fail('A current balance or quantity has an invalid value.');
  if (![1, 2].includes(version)) fail('Unsupported company definition version.');
  const fields = version === 1 ? Object.fromEntries(Object.entries(record).filter(([key]) => !METADATA.has(key) && !DYNAMIC[entity].includes(key))) : definitionFields(entity, record);
  return { version, hash: hash({ version, scope, entity, fields }) };
}
function validateReferenceBinding(binding) {
  if (!binding || !ENTITIES.has(binding.entity) || typeof binding.key !== 'string' || !binding.key || binding.key.length > 100 || typeof binding.id !== 'string' || !ID.test(binding.id) || typeof binding.syncToken !== 'string' || !VERSION.test(binding.syncToken) || binding.status !== 'resolved' || ![1, 2].includes(binding.definition?.version) || typeof binding.definition.hash !== 'string' || !HASH.test(binding.definition.hash)) fail('Each record choice requires its approved definition and original version.');
}
function observedRecord(scope, entity, observed, now) {
  if (!observed || !sameScope(observed.scope, scope) || observed.entity !== entity || !fresh(observed.observedAt, now) || !observed.record || observed.recordHash !== hash(observed.record)) fail('The company reference is stale, incomplete or from another company.');
  const source = observed.source, record = observed.record;
  if (!source || source.version !== 1 || !['qbo-full-entity-get', 'qbo-current-mirror'].includes(source.kind) || !sameScope(source.scope, scope) || source.entity !== entity || source.id !== record.Id || (source.kind === 'qbo-full-entity-get' ? source.endpoint !== entity.toLowerCase() + '/' + record.Id : typeof source.generation !== 'string' || !source.generation || !Number.isFinite(Date.parse(source.completedAt)) || Date.parse(source.completedAt) > Date.parse(observed.observedAt) || !Number.isFinite(Date.parse(source.freshUntil)) || Date.parse(source.freshUntil) < Date.parse(observed.observedAt)) || source.recordHash !== observed.recordHash) fail('The reference requires provenance from a complete QuickBooks entity GET or current synchronized source.');
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
// when the complete master definition still matches the approved definition.
function matchesReferenceDefinition(scope, entity, record, definition, definitionObservation, now = Date.now(), resolveDefinitionObservation) {
  if (referenceDefinition(scope, entity, record, definition.version).hash === definition.hash) return true;
  if (definition.version !== 1 || !['Item', 'TaxCode'].includes(entity)) return false;
  const matches = witnessObservation => {
    if (!witnessObservation) return false;
  // Authenticate the old full record before comparing canonical definitions.
  // Historical evidence authenticates only the approved baseline. It must never
  // be used as a fresh observation for preparation, stock or execution.
  let retained;
  if (witnessObservation.source?.kind === 'qbo-retained-mirror') {
    const witness = witnessObservation, source = witness.source;
    if (!sameScope(witness.scope, scope) || witness.entity !== entity || !witness.record || witness.recordHash !== hash(witness.record) || !sameScope(source.scope, scope) || source.version !== 1 || source.entity !== entity || source.id !== witness.record.Id || source.recordHash !== witness.recordHash || typeof source.generation !== 'string' || !source.generation || typeof witness.observedAt !== 'string' || !Number.isFinite(Date.parse(witness.observedAt)) || new Date(Date.parse(witness.observedAt)).toISOString() !== witness.observedAt || Date.parse(witness.observedAt) > now || source.retainedAt !== witness.observedAt) fail('The approved definition requires exact retained company evidence.');
    retained = witness.record;
  } else retained = observedRecord(scope, entity, witnessObservation, now);
  return retained.Id === record.Id && referenceDefinition(scope, entity, retained, 1).hash === definition.hash && sameCanonicalDefinition(entity, retained, record);
  };
  let originalError;
  try { if (matches(definitionObservation)) return true; } catch (error) { originalError = error; }
  if (typeof resolveDefinitionObservation === 'function') {
    const retained = resolveDefinitionObservation(scope, entity, record.Id, definition);
    if (retained) return matches(retained);
  }
  if (originalError) throw originalError;
  return false;
}
function verifyBusinessReference({ scope, binding, observed, now = Date.now(), resolveDefinitionObservation }) {
  let retained = false, retainedObservation = null;
  const resolve = typeof resolveDefinitionObservation === 'function' ? (...args) => { const witness = resolveDefinitionObservation(...args); retained ||= Boolean(witness); retainedObservation ||= witness; return witness; } : undefined;
  try {
  scope = scoped(scope); validateReferenceBinding(binding);
  const record = observedRecord(scope, binding.entity, observed, now);
  const matches = matchesReferenceDefinition(scope, binding.entity, record, binding.definition, observed.definitionObservation, now, resolve);
  if (record.Id !== binding.id || BigInt(record.SyncToken) < BigInt(binding.syncToken) || !matches) {
    const approvedObservation = [retainedObservation, observed.definitionObservation].find(value => { try { return value?.record?.Id === binding.id && value.entity === binding.entity && sameScope(value.scope, scope) && value.recordHash === hash(value.record) && referenceDefinition(scope, binding.entity, value.record, binding.definition.version).hash === binding.definition.hash; } catch { return false; } });
    fail('The selected ' + binding.entity + ' (' + binding.key + ') differs from its approved definition or version.', { entity: binding.entity, recordId: binding.id, bindingKey: binding.key, expectedVersion: binding.syncToken, observedVersion: record.SyncToken, approvedDefinition: binding.definition, observedDefinition: referenceDefinition(scope, binding.entity, record, binding.definition.version), approvedObservationAvailable: Boolean(approvedObservation?.record), differences: approvedObservation?.record ? require('./business-error-detail').definitionDifferences(definitionFields(binding.entity, approvedObservation.record), definitionFields(binding.entity, record)) : [], note: approvedObservation?.record ? 'Compared retained approved observation with the current definition.' : 'The approved hash is retained, but approved field values are unavailable; they cannot be reconstructed from a hash.' });
  }
  return record;
  } catch (error) {
    error.referenceDiagnostic = { observationSource: ({ 'qbo-full-entity-get': 'live', 'qbo-current-mirror': 'mirror', 'qbo-write-response': 'saved' })[observed?.source?.kind] || 'unknown', definitionVersion: [1, 2].includes(binding?.definition?.version) ? binding.definition.version : null, definitionObservationPresent: Boolean(observed?.definitionObservation), retainedDefinitionResolved: retained };
    throw error;
  }
}
// Fixed full GET only; there is no caller-provided endpoint, query projection or
// record-enrichment hook. The resolver must supply the existing scoped QBO client.
function createBusinessRecordReader({ resolveClient, authorize, now = () => Date.now(), observationStore = createBusinessObservationStore({ now }) }, transactions = false) {
  const entities = transactions ? TRANSACTIONS : ENTITIES;
  const action = transactions ? 'operations.read' : 'operations.preview';
  if ([resolveClient, authorize, now].some(value => typeof value !== 'function')) throw new TypeError('Reference reading needs explicit company client and authority adapters');
  return async (scope, entity, id, { signal, live = false } = {}) => {
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
      // Transaction balances, links and computed states can change after any related
      // save without a SyncToken change. Copies are only safe for master definitions.
      if (observationStore && !live && !transactions) {
        let cached;
        try { cached = await call(() => observationStore.read(scope, entity, id, { transactions, signal: controller.signal }));
          if (!cached && transactions) cached = await call(() => observationStore.saved(scope, entity, id, { signal: controller.signal }));
        } catch { check(); /* An unavailable mirror falls back to the full scoped GET. */ }
        if (cached) {
          check();
          if (!sameScope(cached.scope, scope) || cached.entity !== entity || cached.record?.Id !== id || cached.recordHash !== hash(cached.record) || !fresh(cached.observedAt, now())) fail('The local observation differs from the exact company record.');
          if (!transactions) { observedRecord(scope, entity, cached, now()); referenceDefinition(scope, entity, cached.record); }
          if (cached.source.kind === 'qbo-write-response') try { await call(() => observationStore.retain(scope, entity, cached.record, cached.observedAt)); } catch { check(); /* The durable receipt survives mirror failure. */ }
          check();
          let definitionObservation;
          if (['Item', 'TaxCode'].includes(entity) && typeof observationStore.definition === 'function') {
            try { definitionObservation = await call(() => observationStore.definition(scope, entity, id, { signal: controller.signal })); }
            catch { check(); /* Compatibility evidence is optional for current v2 definitions. */ }
          }
          check();
          const current = await call(() => authorize(scope, action, { signal: controller.signal })); check();
          if (current?.actorId !== actor.actorId || current?.ownerId !== actor.ownerId) fail('The company reader changed during the local observation.');
          return definitionObservation ? { ...cached, definitionObservation } : cached;
        }
      }
      let definitionObservation;
      if (!transactions && observationStore && ['Item', 'TaxCode'].includes(entity)) {
        try { definitionObservation = await call(() => observationStore.read(scope, entity, id, { signal: controller.signal })); }
        catch { check(); /* The current mirror may be unavailable. */ }
        // A stale sync does not invalidate a historical approval witness. This
        // separate read supplies no current authority; matchesReferenceDefinition
        // must authenticate its exact v1 hash before comparing canonical fields.
        if (!definitionObservation && typeof observationStore.definition === 'function') {
          try { definitionObservation = await call(() => observationStore.definition(scope, entity, id, { signal: controller.signal })); }
          catch { check(); /* Missing evidence still fails closed for v1 approvals. */ }
        }
      }
      const client = await call(() => resolveClient(scope, { signal: controller.signal })); check();
      const expectedBase = 'https://' + (scope.environment === 'production' ? 'quickbooks.api.intuit.com' : 'sandbox-quickbooks.api.intuit.com') + '/v3/company/' + scope.realmId;
      const clientScope = () => { if (!client || typeof client.read !== 'function' || String(client.connection?._id) !== scope.connectionId || client.realmId !== scope.realmId || String(client.connection?.realmId) !== scope.realmId || client.apiBase !== expectedBase || client.connection?.status !== 'active') fail('The QuickBooks client no longer matches the approved company connection.'); };
      if (transactions) {
        const { QBOClient } = require('./qbo-client');
        if (!(client instanceof QBOClient) || client.read !== QBOClient.prototype.read || client.apiCall !== QBOClient.prototype.apiCall || !/^[a-f0-9]{24}$/.test(actor.ownerId || '') || String(client.connection?.userId) !== actor.ownerId) fail('Saved transaction reads require the original scoped QuickBooks client.');
      }
      clientScope();
      const body = await call(() => runWithCaller(transactions ? 'business-transaction' : 'business-reference', () => client.read(entity.toLowerCase(), id))); check(); clientScope();
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
      return { scope, entity, observedAt, record, recordHash, ...(definitionObservation ? { definitionObservation } : {}), source: { version: 1, kind: 'qbo-full-entity-get', scope, entity, id, endpoint: entity.toLowerCase() + '/' + id, recordHash } };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
const createBusinessReferenceReader = options => createBusinessRecordReader(options);
const createBusinessTransactionReader = options => createBusinessRecordReader({ observationStore: null, ...options }, true);
module.exports = { createBusinessReferenceReader, createBusinessTransactionReader, bindBusinessReference, verifyBusinessReference, validateReferenceBinding, referenceDefinition, definitionFields, matchesReferenceDefinition };
