'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../frontend/src/lib/business-operation-view.mjs');
test('stored verified state is distinguished from current completion proof', async () => {
  const { operationStatus } = await view;
  assert.equal(operationStatus({ status: 'verified' }), 'Verification recorded');
  assert.equal(operationStatus({ status: 'verified', completion: { evidenceHash: 'proof' } }), 'Verified');
  assert.equal(operationStatus({ status: 'running', execution: { pending: false } }), 'Interrupted — ready to continue');
  assert.equal(operationStatus({ status: 'running', execution: { pending: true }, stopRequested: true }), 'Stopping safely');
});
test('UI actions require current permissions and a runnable state with fresh reads', async () => {
  const { operationActions } = await view, permissions = { execute: true, stop: true };
  assert.deepEqual(operationActions({ status: 'approved' }, permissions), { execute: true, stop: false });
  for (const status of ['verified', 'stopped', 'previewed', 'unknown']) assert.deepEqual(operationActions({ status }, permissions), { execute: false, stop: false });
  assert.deepEqual(operationActions({ status: 'running', execution: { pending: true } }, permissions), { execute: false, stop: true });
  assert.deepEqual(operationActions({ status: 'blocked' }, {}, false), { execute: false, stop: false });
  assert.deepEqual(operationActions({ status: 'blocked' }, permissions, true), { execute: false, stop: false });
  assert.deepEqual(operationActions(null, permissions), { execute: false, stop: false });
});
test('company reconnection, environment and realm mismatches cannot reuse a loaded view', async () => {
  const { assertOperationScope } = await view, value = { scope: { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) } };
  assert.equal(assertOperationScope(value, '123', 'sandbox'), value);
  for (const args of [['456', 'sandbox'], ['123', 'production'], ['123', 'sandbox', 'b'.repeat(24)]]) assert.throws(() => assertOperationScope(value, ...args), /connection changed/);
});
