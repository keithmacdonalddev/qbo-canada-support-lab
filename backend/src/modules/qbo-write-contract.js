'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { hash } = require('./business-calendar');
const storage = new AsyncLocalStorage();
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/i, QBO_ID = /^\d{1,30}$/, VERSION = /^(0|[1-9]\d{0,63})$/;
function denied(message, unknown = false) { return Object.assign(new Error(message), { status: unknown ? 503 : 409, qboStage: unknown ? 'write_receipt' : 'write_admission', outcomeUnknown: unknown }); }
function scoped(scope) {
  if (!scope || typeof scope.realmId !== 'string' || !QBO_ID.test(scope.realmId) || !['sandbox', 'production'].includes(scope.environment) || typeof scope.connectionId !== 'string' || !ID.test(scope.connectionId)) throw denied('The write needs an exact company connection.');
  return { realmId: scope.realmId, environment: scope.environment, connectionId: scope.connectionId };
}
function freezeWriteRequest(scope, method, endpoint, body) {
  scope = scoped(scope); method = String(method).toUpperCase();
  if (method !== 'POST' || typeof endpoint !== 'string' || endpoint.length > 512 || !/^[a-zA-Z][a-zA-Z0-9]*(?:\?[^?#]*)?$/.test(endpoint)) throw denied('Unsupported company write endpoint.');
  const [path, search = ''] = endpoint.split('?');
  const params = new URLSearchParams(search), seen = new Set();
  for (const [key, value] of params) {
    if (seen.has(key) || !['operation', 'include', 'minorversion', 'requestid'].includes(key)) throw denied('Unsupported or duplicate write parameter.'); seen.add(key);
    if ((key === 'operation' && !['update', 'delete', 'void'].includes(value)) || (key === 'include' && value !== 'void') || (key === 'minorversion' && !/^\d{1,3}$/.test(value)) || (key === 'requestid' && !/^[a-zA-Z0-9-]{1,50}$/.test(value))) throw denied('Invalid write parameter.');
  }
  params.sort(); const query = params.toString(), normalized = path.toLowerCase() + (query ? '?' + query : '');
  if (!body || Object.getPrototypeOf(body) !== Object.prototype) throw denied('A write needs a plain transaction object.');
  let serialized; try { serialized = JSON.stringify(body); } catch { throw denied('The write cannot be serialized.'); }
  if (typeof serialized !== 'string') throw denied('The write cannot be serialized.');
  if (Buffer.byteLength(serialized) > 8000000) throw denied('The write exceeds the request size budget.');
  const copy = JSON.parse(serialized), entity = path.toLowerCase();
  if (!copy || Object.getPrototypeOf(copy) !== Object.prototype) throw denied('The serialized write must remain a transaction object.');
  const operation = params.get('operation') === 'delete' ? 'delete' : params.get('operation') === 'void' || params.get('include') === 'void' ? 'void' : copy.Id != null || params.get('operation') === 'update' ? 'update' : 'create';
  const targetId = copy.Id == null ? null : String(copy.Id);
  if ((operation !== 'create' && targetId === null) || (targetId !== null && !QBO_ID.test(targetId))) throw denied('Invalid write target identifier.');
  const requestHash = hash({ scope, method, endpoint: normalized, body: serialized });
  return Object.freeze({ scope: Object.freeze(scope), method, endpoint: normalized, entity, operation, targetId, body: serialized, requestHash });
}
function withBusinessWritePermit(permit, work) {
  if (!permit || (permit.leaseToken !== undefined && (typeof permit.leaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(permit.leaseToken))) || !ID.test(permit.operationId || '') || !HASH.test(permit.logicalKey || '') || !HASH.test(permit.dispatchKey || '') || !HASH.test(permit.requestHash || '') || typeof work !== 'function') throw denied('A saved business dispatch permission is required.');
  const normalized = Object.freeze({ scope: Object.freeze(scoped(permit.scope)), operationId: permit.operationId, logicalKey: permit.logicalKey, dispatchKey: permit.dispatchKey, requestHash: permit.requestHash, ...(permit.leaseToken !== undefined ? { leaseToken: permit.leaseToken } : {}) });
  return storage.run({ permit: normalized, consumed: false }, work);
}
function consumeBusinessWritePermit() {
  const context = storage.getStore(); if (!context) return null;
  if (context.consumed) throw denied('This business dispatch permission has already been consumed.');
  context.consumed = true; // Before the first await, including inherited child tasks.
  return context.permit;
}
function responsePayload(response) {
  let value; try { value = typeof response?.getJson === 'function' ? response.getJson() : null; } catch { return null; }
  if (!value) { try { value = response?.json || JSON.parse(response?.body || 'null'); } catch { return null; } }
  return value && Object.getPrototypeOf(value) === Object.prototype ? value : null;
}
function classifyWriteResponse(request, response, intuitTid = '') {
  const status = response?.status, payload = responsePayload(response);
  let responseHash = null;
  if (payload) { try { const serialized = JSON.stringify(payload); if (Buffer.byteLength(serialized) <= 8000000) responseHash = createHash('sha256').update(serialized).digest('hex'); } catch { /* remain unknown */ } }
  const base = { httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, intuitTid: typeof intuitTid === 'string' && /^[a-z0-9._-]{1,128}$/i.test(intuitTid) ? intuitTid : null, responseHash, entity: request.entity, operation: request.operation };
  if (!payload || !responseHash || request.entity === 'batch') return { ...base, outcome: 'unknown' };
  const matches = Object.entries(payload).filter(([key]) => key.toLowerCase() === request.entity);
  const fault = payload.Fault;
  // Narrow no-effect classification. System faults and unrecognized error envelopes
  // remain unknown regardless of HTTP status. No request is retried automatically.
  if (status === 400 && fault?.type === 'ValidationFault' && !matches.length && Array.isArray(fault.Error) && fault.Error.length > 0 && fault.Error.length <= 100 && fault.Error.every(error => typeof error?.code === 'string' && /^\d{1,8}$/.test(error.code))) return { ...base, outcome: 'rejected', faultCodes: fault.Error.map(error => error.code) };
  if (!Number.isInteger(status) || status < 200 || status > 299 || fault || matches.length !== 1) return { ...base, outcome: 'unknown' };
  const record = matches[0][1], qboId = record && typeof record.Id === 'string' ? record.Id : null;
  if (!record || Array.isArray(record) || !qboId || !QBO_ID.test(qboId) || (request.targetId !== null && qboId !== request.targetId)) return { ...base, outcome: 'unknown' };
  if (request.operation === 'delete') return record.status === 'Deleted' ? { ...base, outcome: 'saved', qboId, syncToken: null } : { ...base, outcome: 'unknown' };
  if (typeof record.SyncToken !== 'string' || !VERSION.test(record.SyncToken)) return { ...base, outcome: 'unknown' };
  return { ...base, outcome: 'saved', qboId, syncToken: record.SyncToken };
}
module.exports = { denied, scoped, freezeWriteRequest, withBusinessWritePermit, consumeBusinessWritePermit, classifyWriteResponse };
