'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { denied } = require('./qbo-write-contract');
const storage = new AsyncLocalStorage();
const ID = /^[a-f0-9]{24}$/i;
function normalizeWorkflow(value) {
  if (!value || value.version !== 1 || value.kind !== 'reproduction' || !ID.test(value.sessionId || '') || !ID.test(value.planId || '') || !Number.isSafeInteger(value.stepNumber) || value.stepNumber < 1 || value.stepNumber > 1000) throw denied('An exact saved case step is required for write correlation.');
  return Object.freeze({ version: 1, kind: 'reproduction', sessionId: value.sessionId, planId: value.planId, stepNumber: value.stepNumber });
}
// Correlation is server-owned evidence, never a grant of write authority.
function withWriteWorkflow(value, onDispatch, work) {
  if (typeof onDispatch !== 'function' || typeof work !== 'function') throw new TypeError('Write correlation requires persistence and work callbacks.');
  return storage.run({ workflow: normalizeWorkflow(value), onDispatch, consumed: false }, work);
}
function claimWriteWorkflow() {
  const context = storage.getStore(); if (!context) return null;
  if (context.consumed) throw denied('A case change cannot send more than one accounting write.');
  context.consumed = true;
  return { workflow: context.workflow, onDispatch: context.onDispatch };
}
module.exports = { normalizeWorkflow, withWriteWorkflow, claimWriteWorkflow };
