'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { denied } = require('./qbo-write-contract');
const storage = new AsyncLocalStorage();
const ID = /^[a-f0-9]{24}$/i;
function normalizeWorkflow(value) {
  if (value?.version === 1 && value.kind === 'business-link-repair') {
    if (!/^[a-f0-9]{64}$/.test(value.authorityHash || '') || Object.keys(value).some(key => !['version','kind','authorityHash'].includes(key))) throw denied('An exact immutable owned-link repair authority is required.');
    return Object.freeze({ version: 1, kind: 'business-link-repair', authorityHash: value.authorityHash });
  }
  if (value?.version === 1 && value.kind === 'master-preparation') {
    if (!ID.test(value.runId || '') || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal > 99 || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 10 || typeof value.leaseToken !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(value.leaseToken)) throw denied('An exact saved master attempt and current worker are required for correlation.');
    return Object.freeze({ version: 1, kind: 'master-preparation', runId: value.runId, ordinal: value.ordinal, attempt: value.attempt, leaseToken: value.leaseToken });
  }
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
  if (context.consumed) throw denied('A correlated change cannot send more than one accounting write.');
  context.consumed = true;
  return { workflow: context.workflow, onDispatch: context.onDispatch };
}
module.exports = { normalizeWorkflow, withWriteWorkflow, claimWriteWorkflow };
