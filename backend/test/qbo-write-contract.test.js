'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freezeWriteRequest, withBusinessWritePermit, consumeBusinessWritePermit, classifyWriteResponse, denied } = require('../src/modules/qbo-write-contract');
const { respondQboError } = require('../src/modules/qbo-error');
const { hash } = require('../src/modules/business-calendar');
const { QBOClient } = require('../src/modules/qbo-client');
const config = require('../src/config');
const scope = { environment: config.qbo.environment, realmId: '123', connectionId: 'a'.repeat(24) };
const permission = request => ({ scope, operationId: 'c'.repeat(24), logicalKey: hash('invoice'), dispatchKey: hash('dispatch'), requestHash: request.requestHash });
const request = freezeWriteRequest(scope, 'POST', 'invoice', { CustomerRef: { value: '1' } });
function clientFor(send, gate) {
  const client = Object.create(QBOClient.prototype);
  Object.assign(client, { realmId: scope.realmId, connection: { _id: scope.connectionId, userId: 'b'.repeat(24) }, _requestLog: [], _windowMs: 60000, _retryAfterUntil: 0, ensureFreshToken: async () => {}, _sleep: async () => { throw new Error('no write retry allowed'); }, oauthClient: { makeApiCall: send }, writeGate: gate });
  return client;
}
async function quiet(work) { const original = console.error; console.error = () => {}; try { return await work(); } finally { console.error = original; } }
test('request freezes nested data and canonicalizes allowed endpoint parameters', () => {
  const body = { Id: '2', Line: [{ Amount: 5 }] };
  const frozen = freezeWriteRequest(scope, 'post', 'Invoice?minorversion=75&operation=update', body);
  body.Line[0].Amount = 9;
  assert.equal(JSON.parse(frozen.body).Line[0].Amount, 5); assert.equal(frozen.operation, 'update'); assert.equal(frozen.targetId, '2'); assert.equal(frozen.endpoint, 'invoice?minorversion=75&operation=update');
  assert.equal(frozen.requestHash, freezeWriteRequest(scope, 'POST', 'invoice?operation=update&minorversion=75', { Id: '2', Line: [{ Amount: 5 }] }).requestHash);
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(frozen.scope));
});
test('ambiguous, unsupported or unscoped writes are rejected before transport', () => {
  for (const endpoint of ['invoice?operation=delete?operation=update', 'invoice?operation=update&operation=delete', 'invoice?secret=x', 'https://example.test/invoice', 'invoice/2']) assert.throws(() => freezeWriteRequest(scope, 'POST', endpoint, {}));
  assert.throws(() => freezeWriteRequest(scope, 'POST', 'invoice?operation=delete', {}));
  assert.throws(() => freezeWriteRequest(scope, 'PUT', 'invoice', {}));
  assert.throws(() => freezeWriteRequest({ ...scope, connectionId: null }, 'POST', 'invoice', {}));
});
test('inherited asynchronous calls share a single consumed permission', async () => {
  assert.equal(consumeBusinessWritePermit(), null);
  const results = await withBusinessWritePermit(permission(request), () => Promise.allSettled([Promise.resolve().then(consumeBusinessWritePermit), Promise.resolve().then(consumeBusinessWritePermit)]));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.filter(row => row.status === 'rejected').length, 1); assert.equal(consumeBusinessWritePermit(), null);
});
test('success requires the expected entity, exact updated ID and canonical version', () => {
  assert.equal(classifyWriteResponse(request, { status: 200, json: { Invoice: { Id: '100', SyncToken: '0' } } }).outcome, 'saved');
  const update = freezeWriteRequest(scope, 'POST', 'invoice', { Id: '2' });
  for (const response of [{ status: 200, json: { Invoice: { Id: '3', SyncToken: '1' } } }, { status: 200, json: { Bill: { Id: '2', SyncToken: '1' } } }, { json: { Invoice: { Id: '2', SyncToken: '1' } } }, { status: 200, json: { Invoice: { Id: '2', SyncToken: 1 } } }, { status: 200, json: { Invoice: { Id: '2', SyncToken: '01' } } }, { status: 200, body: 'bad' }]) assert.equal(classifyWriteResponse(update, response).outcome, 'unknown');
  const deletion = freezeWriteRequest(scope, 'POST', 'invoice?operation=delete', { Id: '2', SyncToken: '1' });
  assert.equal(classifyWriteResponse(deletion, { status: 200, json: { Invoice: { Id: '2', status: 'Deleted' } } }).outcome, 'saved');
  assert.equal(classifyWriteResponse(deletion, { status: 200, json: { Invoice: { Id: '2', SyncToken: '1' } } }).outcome, 'unknown');
});
test('only a narrow no-effect validation envelope classifies as rejected', () => {
  const fault = { Fault: { type: 'ValidationFault', Error: [{ code: '6000' }] } };
  assert.equal(classifyWriteResponse(request, { status: 400, json: fault }).outcome, 'rejected');
  for (const response of [{ status: 500, json: fault }, { status: 400, json: { ...fault, Invoice: { Id: '2' } } }, { status: 400, json: { Fault: { type: 'SystemFault', Error: [{ code: '6000' }] } } }, { status: 400, json: { Fault: { type: 'ValidationFault', Error: [] } } }]) assert.equal(classifyWriteResponse(request, response).outcome, 'unknown');
});
test('SDK receives frozen bytes even if the caller changes data during token refresh', async () => {
  const body = { CustomerRef: { value: '1' }, Line: [{ Amount: 5 }] }; let beginRequest, sent;
  const client = clientFor(async opts => { sent = opts; return { status: 200, json: { Invoice: { Id: '100', SyncToken: '0' } } }; }, { begin: async ({ request }) => { beginRequest = request; return { coordinated: true }; }, complete: async () => ({ outcome: 'saved' }) });
  client.ensureFreshToken = async () => { body.Line[0].Amount = 999; };
  await client.apiCall('POST', 'invoice', body);
  assert.equal(JSON.parse(sent.body).Line[0].Amount, 5); assert.equal(sent.body, beginRequest.body);
});
test('common client consumes inherited permission before either request reaches an await', async () => {
  let calls = 0, admissions = 0;
  const client = clientFor(async () => { calls += 1; return { status: 200, json: { Invoice: { Id: '100', SyncToken: '0' } } }; }, { begin: async ({ permit }) => { assert.equal(permit.requestHash, request.requestHash); admissions += 1; return { coordinated: true }; }, complete: async () => ({ outcome: 'saved' }) });
  const result = await withBusinessWritePermit(permission(request), () => Promise.allSettled([client.apiCall('POST', 'invoice', JSON.parse(request.body)), client.apiCall('POST', 'invoice', JSON.parse(request.body))]));
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1); assert.equal(calls, 1); assert.equal(admissions, 1);
});
test('coordinated throttles and malformed responses are not retried or reported as saved', async () => {
  for (const response of [null, { status: 429, headers: {}, json: {} }, { status: 200, headers: {}, json: {} }]) {
    let calls = 0, completions = 0;
    const client = clientFor(async () => { calls += 1; return response; }, { begin: async () => ({ coordinated: true }), complete: async (_ticket, request, response) => { completions += 1; return classifyWriteResponse(request, response); } });
    await assert.rejects(client.apiCall('POST', 'invoice', {}), error => error.outcomeUnknown === true); assert.equal(calls, 1); assert.equal(completions, 1);
  }
});
test('lost transport response and failed receipt save surface unknown outcomes', async () => quiet(async () => {
  let calls = 0;
  const client = clientFor(async () => { calls += 1; throw Object.assign(new Error('network failed'), { code: 'ETIMEDOUT' }); }, { begin: async () => ({ coordinated: true }), complete: async () => { throw new Error('must not settle'); } });
  await assert.rejects(client.apiCall('POST', 'invoice', {}), error => error.outcomeUnknown === true); assert.equal(calls, 1);
  client.oauthClient.makeApiCall = async () => ({ status: 200, json: { Invoice: { Id: '100', SyncToken: '0' } } });
  await assert.rejects(client.apiCall('POST', 'invoice', {}), error => error.qboStage === 'write_receipt' && error.outcomeUnknown === true);
}));
test('admission storage failures make no SDK call and expose a local conflict', async () => quiet(async () => {
  let calls = 0;
  const client = clientFor(async () => { calls += 1; }, { begin: async () => { throw new Error('private database detail'); } });
  await assert.rejects(client.apiCall('POST', 'invoice', {}), error => error.qboStage === 'write_admission' && !error.message.includes('private')); assert.equal(calls, 0);
}));
test('local admission errors and unknown outcomes retain distinct HTTP meaning', () => {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  respondQboError(res, denied('not admitted')); assert.equal(res.code, 409); assert.equal(res.body.qboStatus, null); assert.equal(res.body.outcomeUnknown, false);
  respondQboError(res, denied('unknown', true)); assert.equal(res.code, 503); assert.equal(res.body.outcomeUnknown, true);
  respondQboError(res, { status: 502, message: 'network', outcomeUnknown: true }); assert.equal(res.code, 502); assert.equal(res.body.outcomeUnknown, true);
  respondQboError(res, { status: 401, message: 'upstream' }); assert.equal(res.code, 502);
});

test('execution permission is explicit and does not extend to default read-only or support roles', () => {
  const { normalizePermissions } = require('../src/modules/rebuild-permissions');
  assert.ok(normalizePermissions('lab-owner').includes('operations.execute'));
  for (const role of ['operator', 'support-agent', 'reviewer', 'unknown']) assert.equal(normalizePermissions(role).includes('operations.execute'), false);
  assert.ok(normalizePermissions('operator', ['operations.execute']).includes('operations.execute'));
});
test('custom serialization cannot change a transaction into a missing or non-object payload', () => {
  for (const value of [undefined, null, [], 'payload']) assert.throws(() => freezeWriteRequest(scope, 'POST', 'invoice', { toJSON() { return value; } }));
});
