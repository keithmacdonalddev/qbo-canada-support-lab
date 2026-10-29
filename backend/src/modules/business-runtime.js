'use strict';
const { scoped } = require('./qbo-write-contract');
const { assertPublishedBusiness } = require('./business-authority');
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
  return Object.fromEntries(Object.entries({ Users: 'User', Connections: 'Connection', Memberships: 'CompanyMembership', Audits: 'AuditLog', Policies: 'CompanyWritePolicy', Writers: 'CompanyWriter', Calendars: 'BusinessCalendar', Runs: 'OperationRun', Plans: 'OperationPlan', Intents: 'OperationIntent', Steps: 'OperationStep', Receipts: 'QboWriteReceipt', Evidence: 'OperationEvidence', Authorities: 'BusinessAuthority', Versions: 'BlueprintVersion', Baselines: 'BusinessBaseline' }).map(([key, name]) => [key, legacy.has(name) ? registered[name] : require('../models/' + name)]));
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
  const gate = createQboWriteGate({ ...models, transaction, assertReady, now, assertBusinessAuthority: ({ run, session }) => assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, manifest: run, session, fence: true }) });
  const writeAudit = createBusinessAuditWriter({ scope, actorId, ownerId, Audits: models.Audits, transaction, access });
  const plans = createBusinessOperationPlanStore({ ...models, transaction, assertReady, authorize, now, readOnly: true });
  const assertCoordination = async ({ session, phase } = {}) => {
    await assertReady();
    const policy = await models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).select('contractVersion connectionId state preparationEvidenceHash revision').session(session).maxTimeMS(3000).lean();
    if (!policy || policy.contractVersion !== 1 || String(policy.connectionId) !== scope.connectionId || !['active', 'preparing'].includes(policy.state) || !HASH.test(policy.preparationEvidenceHash || '') || !Number.isSafeInteger(policy.revision) || policy.revision < 0) fail('Company-wide write coordination must be explicitly prepared.');
    if (['reserve', 'claim', 'dispatch'].includes(phase)) {
      const run = await models.Runs.findOne({ _id: operationId, ...scope }).session(session).maxTimeMS(3000).lean();
      await require('./business-agent-authority').fenceAgentAuthority({ run, scope, ownerId, actorId, Agents: models.Agents, session });
      await assertPublishedBusiness({ ...models, scope, requireScheduleAcceptance: true, manifest: run, session, fence: true });
      if (policy.state !== 'active' || !session?.inTransaction?.()) fail('New operation work requires active write coordination.');
      const fenced = await models.Policies.findOneAndUpdate({ _id: policy._id, ...scope, state: 'active', revision: policy.revision, preparationEvidenceHash: policy.preparationEvidenceHash }, { $inc: { revision: 1 } }, { new: true, session }).lean();
      if (!fenced) fail('Company write preparation changed before this activity.');
    }
  };
  const writerFence = createBusinessWriterFence({ ...models, assertIntegration: assertCoordination, now });
  const state = createBusinessRunState({ ...models, transaction, authorize, assertReady, writeAudit, now });
  let verification;
  const steps = createBusinessStepStore({ ...models, transaction, authorize, assertReady, writeAudit, now, loadIntent: plans.loadIntent, fence: writerFence.fenceStep,
    loadRecovery: createBusinessDispatchReceiptReader({ ...models, transaction, authorize, assertReady, settleUnsent: gate.releaseUnsent }),
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
  const evidence = createBusinessPeriodEvidence({ ...models, transaction, access, assertReady, writerFence, steps, readStock: require('./business-stock-source').createBusinessStockReader({ access, now }), readReports: createBusinessReportReader({ access, now }), writeAudit, now });
  const periods = createBusinessPeriodStore({ ...models, Writer: writerFence, transaction, authorize, assertReady, writeAudit, loadProof: evidence.loadProof, now });
  async function validateOpening({ signal }) {
    const run = await models.Runs.findOne({ _id: operationId, ...scope }).maxTimeMS(3000).lean();
    const plan = await models.Plans.findOne({ _id: run.planId, ...scope, operationId, planHash: boundPlanHash }).maxTimeMS(3000).lean();
    if (!plan?.manifest || require('./business-calendar').hash(plan.manifest) !== run.planHash) fail('The exact saved business plan is unavailable.');
    require('./business-financial-movements').assertMovementCapacity(plan.manifest);
    if (await models.Steps.findOne({ ...scope, operationId, state: { $in: ['dispatched', 'unknown', 'saved', 'verified'] } }).maxTimeMS(3000).lean()) return;
    const before = await verification.readFence(scope, { signal });
    let stockSource = null;
    if (plan.manifest.stockCostExpectation) {
      const expected = plan.manifest.stockCostExpectation;
      const origins = await require('./business-stock-evidence').loadPurchaseOrigins(models, expected.opening);
      if (require('./business-calendar').canonical(origins) !== require('./business-calendar').canonical(expected.purchaseOrigins)) fail('Original stock purchase costs changed before the first write.');
      stockSource = await require('./business-stock-source').createBusinessStockReader({ access, now })(scope, expected.opening, { signal });
    }
    const source = await createBusinessReportReader({ access, now, purpose: 'operation' })(scope, { fromDate: run.fromDate, throughDate: run.throughDate }, { signal });
    require('./business-financial-movements').assertMovementCapacity(plan.manifest, source);
    const evaluation = require('./book-evidence').evaluateReportSources(source, { allowExplicitZero: true });
    if (![2, 3].includes(source.version) || evaluation.status !== 'checks-passed' || !require('./business-financial-summary').reportComplete(evaluation, source)) fail('All seven critical reports and the named accounting checks must be available before the first business write.');
    const actual = plan.manifest.incomeExpectation ? require('./business-income-evidence').incomeCents(require('./business-report-source').unpackReport('ProfitAndLoss', source.reports.ProfitAndLoss, source.version), { fromDate: run.fromDate, throughDate: run.throughDate }, source.version) : null;
    if (plan.manifest.incomeExpectation && actual !== plan.manifest.incomeExpectation.openingIncomeCents) fail('Period income changed after preparation. Nothing was sent by this operation. Retire this unsent plan and prepare it again.');
    if (plan.manifest.financialExpectation) {
      const opening = require('./business-financial-movements').compareFinancialMovements(plan.manifest.financialExpectation, [], source);
      if (opening.status !== 'passed') fail('Selected financial account balances changed after preparation. Nothing was sent by this operation. Retire this unsent plan and prepare it again.');
    }
    if (plan.manifest.stockCostExpectation) {
      const opening = require('./business-stock-evidence').compareStockCosts(plan.manifest.stockCostExpectation, [], source, stockSource, { openingOnly: true });
      if (opening.status !== 'passed') fail('Stock quantity, original purchase cost or selected cost balances changed after preparation. Nothing was sent by this operation. Retire this unsent plan and prepare it again.');
    }
    const after = await verification.readFence(scope, { signal });
    if (require('./business-calendar').canonical(before) !== require('./business-calendar').canonical(after)) fail('Company activity changed during the starting-income check.');
  }
  async function execute({ signal } = {}) {
    await bind();
    const dispatch = createBusinessDispatcher({ steps, loadIntent: plans.loadIntent, loadCompilationEvidence: createBusinessCompilationRuntime({ scope, operationId, planHash: boundPlanHash, access, plans, steps, verification, assertReady, adoptedSources: require('./business-adopted-settlement').createAdoptedSettlementReader({ Calendars: models.Calendars, PopulationRecords: models.PopulationRecords || require('../models/BusinessPopulationRecord'), readRecord: verification.rawRecord }), now }), resolveClient: access.resolveClient, authorize, assertReady, beforeDispatch: validateOpening, now });
    return createBusinessOperationRunner({ state, plans, steps, dispatch, periods, prepareEvidence: evidence.prepareEvidence, validateOpening })(scope, operationId, { signal });
  }
  return Object.freeze({ execute, settleStop: async () => {
    let saved = await bind();
    const complete = value => ({ operationId, state:'verified', complete:true, completedRecords:value.nextOrdinal, recordCount:value.recordCount, ...value.completion });
    if (saved.status === 'verified' && saved.completion) return complete(saved);
    if (['committing','verified'].includes(saved.status)) {
      await periods.repair(scope, operationId); saved = await bind();
      if (!saved.completion) fail('The completed operation receipt still needs recovery.');
      return { operationId, state:'verified', complete:true, completedRecords:saved.nextOrdinal, recordCount:saved.recordCount, ...saved.completion };
    }
    return state.settleStop(scope, operationId);
  }, inspect: async () => {
    const saved = await bind(), { leaseToken, ...visible } = saved;
    let financialMovements;
    try {
      const run = await models.Runs.findOne({ _id: operationId, ...scope }).maxTimeMS(3000).lean();
      financialMovements = await evidence.financialSummary(run);
    }
    catch {
      // Optional financial assurance cannot remove core progress or Stop. Current
      // access is checked again so auth/scope failures are never hidden.
      await authorize(scope, 'operations.read');
      financialMovements = { status: 'integrity-unavailable', complete: false, checks: [], period: { fromDate: saved.fromDate, throughDate: saved.throughDate }, observedAt: null, reason: 'Saved financial evidence could not be verified. Progress and Stop remain available; no financial assurance is shown.', limitation: 'Inspect the retained evidence before relying on financial completion.' };
    }
    await authorize(scope, 'operations.read');
    return { ...visible, financialMovements };
  }, stop: () => periods.requestStop(operationId, scope) });
}
module.exports = { createBusinessRuntime, loadModels };
