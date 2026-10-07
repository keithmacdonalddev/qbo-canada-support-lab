'use strict';
const { scoped } = require('./qbo-write-contract');
const { createBusinessTransaction } = require('./business-transaction');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const { createBusinessAuditWriter } = require('./business-runtime-audit');
const { createBusinessOperationPlanStore } = require('./business-operation-plan-store');
const { createBusinessWriterFence } = require('./business-writer-fence');
const { createBusinessVerificationRuntime } = require('./business-verification-runtime');
const { createBusinessCompilationRuntime } = require('./business-compilation-runtime');
const { createBusinessDispatchReceiptReader } = require('./business-dispatch-receipt');
const { createBusinessStepStore } = require('./business-step-store');
const { createBusinessDispatcher } = require('./business-dispatch');
const { createBusinessPeriodEvidence } = require('./business-period-evidence');
const { createBusinessReportReader } = require('./business-report-evidence');
const { createBusinessPeriodStore } = require('./business-period-store');
const { createBusinessRunState } = require('./business-run-state');
const { createBusinessOperationRunner } = require('./business-operation-runner');
const { createQboWriteGate } = require('./qbo-write-gate');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/;
function fail(message) { throw Object.assign(new Error(message), { status: 409, code: 'BUSINESS_RUNTIME_UNAVAILABLE' }); }
function loadModels() {
  const registered = require('mongoose').models;
  const legacy = new Set(['User', 'Connection', 'CompanyMembership', 'AuditLog']);
  for (const name of legacy) if (!registered[name]) fail('The existing application models must be registered before runtime composition.');
  return Object.fromEntries(Object.entries({ Users: 'User', Connections: 'Connection', Memberships: 'CompanyMembership', Audits: 'AuditLog', Policies: 'CompanyWritePolicy', Writers: 'CompanyWriter', Calendars: 'BusinessCalendar', Runs: 'OperationRun', Plans: 'OperationPlan', Intents: 'OperationIntent', Steps: 'OperationStep', Receipts: 'QboWriteReceipt', Evidence: 'OperationEvidence' }).map(([key, name]) => [key, legacy.has(name) ? registered[name] : require('../models/' + name)]));
}
// Internal server composition for one SAVED operation. No construction-time reads,
// startup, activation, plan approval, migration or scheduler. Actor/owner/scope
// must be derived from authenticated server context, not request body overrides.
function createBusinessRuntime({ scope, operationId, actorId, ownerId, models = loadModels(), connection = require('mongoose').connection, transaction = createBusinessTransaction(connection), assertReady = createBusinessStorageReadiness({ connection, models }), createClient = require('./qbo-client').createQBOClient, environment = () => require('../config').qbo.environment, now = () => Date.now() }) {
  scope = scoped(scope);
  if (![operationId, actorId, ownerId].every(value => ID.test(value || ''))) throw new TypeError('Runtime needs exact saved operation and server authority');
  const access = createBusinessRuntimeAccess({ actorId, ownerId, ...models, environment, createClient: async selected => {
    const client = await createClient(selected); const { QBOClient } = require('./qbo-client');
    if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall) fail('Runtime requires the original QuickBooks transport.');
    client.writeGate = gate; return client;
  } });
  const authorize = access.authorize;
  const gate = createQboWriteGate({ ...models, transaction, assertReady, now });
  const writeAudit = createBusinessAuditWriter({ scope, actorId, ownerId, Audits: models.Audits, transaction, access });
  const plans = createBusinessOperationPlanStore({ ...models, transaction, assertReady, authorize, now, readOnly: true });
  const assertCoordination = async ({ session, phase } = {}) => {
    await assertReady();
    const policy = await models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).select('contractVersion connectionId state preparationEvidenceHash revision').session(session).maxTimeMS(3000).lean();
    if (!policy || policy.contractVersion !== 1 || String(policy.connectionId) !== scope.connectionId || !['active', 'preparing'].includes(policy.state) || !HASH.test(policy.preparationEvidenceHash || '') || !Number.isSafeInteger(policy.revision) || policy.revision < 0) fail('Company-wide write coordination must be explicitly prepared.');
    if (['reserve', 'claim', 'dispatch'].includes(phase)) {
      if (policy.state !== 'active' || !session?.inTransaction?.()) fail('New operation work requires active write coordination.');
      const fenced = await models.Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: 'active', revision: policy.revision, preparationEvidenceHash: policy.preparationEvidenceHash }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!fenced) fail('Company write preparation changed before this activity.');
    }
  };
  const writerFence = createBusinessWriterFence({ ...models, assertIntegration: assertCoordination, now });
  const state = createBusinessRunState({ ...models, transaction, authorize, assertReady, writeAudit, now });
  let verification;
  const steps = createBusinessStepStore({ ...models, transaction, authorize, assertReady, writeAudit, now, loadIntent: plans.loadIntent, fence: writerFence.fenceStep,
    loadRecovery: createBusinessDispatchReceiptReader({ ...models, transaction, authorize, assertReady }),
    loadGraphReadback: input => verification.loadGraphReadback(input), graphSnapshot: input => verification.graphSnapshot(input),
  });
  let boundPlanHash = null;
  const bind = async () => {
    await assertReady(); await authorize(scope, 'operations.read');
    const saved = await state.inspect(scope, operationId);
    if (boundPlanHash && saved.planHash !== boundPlanHash) fail('The runtime saved plan changed.');
    boundPlanHash = saved.planHash;
    if (!verification) verification = createBusinessVerificationRuntime({ scope, operationId, planHash: boundPlanHash, ...models, transaction, assertReady, access, writerFence, plans, now });
    return saved;
  };
  const evidence = createBusinessPeriodEvidence({ ...models, transaction, access, assertReady, writerFence, steps, readReports: createBusinessReportReader({ access, now }), writeAudit, now });
  const periods = createBusinessPeriodStore({ ...models, Writer: writerFence, transaction, authorize, assertReady, writeAudit, loadProof: evidence.loadProof, now });
  async function execute({ signal } = {}) {
    await bind();
    const dispatch = createBusinessDispatcher({ steps, loadIntent: plans.loadIntent, loadCompilationEvidence: createBusinessCompilationRuntime({ scope, operationId, planHash: boundPlanHash, access, plans, steps, verification, assertReady, now }), resolveClient: access.resolveClient, authorize, assertReady, now });
    return createBusinessOperationRunner({ state, plans, steps, dispatch, periods, prepareEvidence: evidence.prepareEvidence })(scope, operationId, { signal });
  }
  return Object.freeze({ execute, inspect: async () => { const saved = await bind(); const { leaseToken, ...visible } = saved; return visible; }, stop: () => periods.requestStop(operationId, scope) });
}
module.exports = { createBusinessRuntime, loadModels };
