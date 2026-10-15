'use strict';
const { scoped, denied } = require('./qbo-write-contract');
const { loadModels } = require('./business-runtime');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createBusinessTransaction } = require('./business-transaction');
const { createBusinessStorageReadiness } = require('./business-runtime-storage');
const { createMasterPreparationTransport } = require('./business-master-preparation-transport');
const { createMasterPreparationStore } = require('./business-master-preparation-store');
const { createMasterPreparationRunner } = require('./business-master-preparation-runner');
const { createMasterQboAccess } = require('./business-master-qbo-access');
const { createMasterQuiescence } = require('./company-active-work');
const { createQboWriteGate } = require('./qbo-write-gate');
const { QBOClient, createQBOClient } = require('./qbo-client');
const { prepareMasterPlan, validateMasterPreparationInput } = require('./business-master-preparation-plan');
const { draftView, readDraftSetup } = require('./blueprint-draft');
const { readBusinessMasters } = require('./business-master-data');
const { readCanadianCompany } = require('./business-country');
const setup = require('./business-storage-setup');
function loadMasterModels() {
  // Additive v5 belongs only to this workflow. Existing v4 business execution
  // must remain usable without installing or querying the new collection.
  return { ...loadModels(), MasterRuns: require('../models/MasterPreparationRun'), Sequences: require('../models/BlueprintSequence') };
}
function createMasterStorageReadiness({ connection, models, scope, ownerId, now = () => Date.now(), assertProfile = setup.assertProfileSetupCompleted, inspectProfile = setup.inspectStorage }) {
  scope = scoped(scope);
  const structural = createBusinessStorageReadiness({ connection, models, now });
  return async ({ session } = {}) => {
    await structural();
    const storage = await inspectProfile(connection.db, 'master-preparation');
    if (storage.some(row => row.create || row.missingIndexes.length)) throw Object.assign(new Error('Master-record storage or its business prerequisites changed. Review the exact storage preparation.'), { status: 409, code: 'BUSINESS_STORAGE_UNPREPARED' });
    for (const profile of ['continual-business', 'master-preparation']) {
      try { await assertProfile(connection.db, { ...scope, ownerId }, profile, session); }
      catch { throw Object.assign(new Error('Review and complete the exact business and master-record storage setup for this company.'), { status: 409, code: 'BUSINESS_STORAGE_UNPREPARED' }); }
    }
  };
}
// No construction-time reads, DDL, startup, scheduler or invented approval.
// Actor and owner are supplied only by authenticated server composition.
function createMasterRuntime({ scope, ownerId, actorId, models = loadMasterModels(), connection = require('mongoose').connection, transaction = createBusinessTransaction(connection), assertReady, assertQuiescent, createClient = createQBOClient, environment = () => require('../config').qbo.environment, now = () => Date.now() }) {
  scope = scoped(scope);
  if (![ownerId, actorId].every(id => /^[a-f0-9]{24}$/.test(id || ''))) throw new TypeError('Master runtime needs exact server-owned identities');
  assertReady ||= createMasterStorageReadiness({ connection, models, scope, ownerId, now });
  assertQuiescent ||= createMasterQuiescence(connection.db);
  let gate;
  const access = createBusinessRuntimeAccess({ ...models, actorId, ownerId, environment, createClient: async selected => {
    const client = await createClient(selected);
    if (!(client instanceof QBOClient) || client.apiCall !== QBOClient.prototype.apiCall) throw denied('Master preparation requires the original QuickBooks transport.');
    client.writeGate = gate; return client;
  } });
  const transport = createMasterPreparationTransport({ ...models, assertReady, now });
  const baseGate = createQboWriteGate({ ...models, transaction, assertReady, masterTransport: transport, now });
  const reads = createMasterQboAccess({ scope, ownerId, authorize: access.authorize, clientFor: access.resolveClient });
  // The last protected-period read has the same current authority boundary as
  // setup pages and exact-ID readbacks, even if the original client was cached.
  gate = Object.freeze({ ...baseGate, preflight: async ({ request }) => {
    await access.authorize(scope, 'operations.execute');
    const evidence = await baseGate.preflight({ request, client: { query: reads.queryClient.query, read: (entity, id) => reads.read('operations.read', client => client.apiCall('GET', entity + '/' + id)) } });
    await access.authorize(scope, 'operations.execute'); return evidence;
  } });
  const store = createMasterPreparationStore({ models, scope, ownerId, actorId, access, transaction, assertReady, transport, assertQuiescent, now, db: connection.db });
  const readPolicy = requested => {
    if (JSON.stringify(scoped(requested)) !== JSON.stringify(scope)) throw denied('The master policy scope changed.');
    return models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).maxTimeMS(3000).lean();
  };
  const execute = createMasterPreparationRunner({ scope, ownerId, store, clientFor: access.resolveClient, authorize: access.authorize, readPolicy, now });
  async function prepare(input) {
    input = validateMasterPreparationInput(input); await assertReady(); await access.authorize(scope, 'operations.preview');
    const current = await store.latest(), view = { ...scope, draft: draftView(current, scope.connectionId) };
    const observedSetup = await readDraftSetup(reads.queryClient, scope, now); await access.authorize(scope, 'operations.preview');
    const masters = await readBusinessMasters(reads.queryClient, scope, now); await access.authorize(scope, 'operations.preview');
    const country = await readCanadianCompany(reads.queryClient, scope, now); await access.authorize(scope, 'operations.preview');
    const latest = await store.latest();
    if (!current || !latest || String(latest._id) !== String(current._id) || latest.contentHash !== current.contentHash) throw denied('The business draft changed during master preparation. Reload it.');
    const policy = await readPolicy(scope);
    return prepareMasterPlan({ view, input, setup: observedSetup, masters, country, periodControl: policy?.periodControl, ownerId, now: now() });
  }
  return Object.freeze({ scope, ownerId, actorId, assertReady, access, store, prepare, execute });
}
module.exports = { loadMasterModels, createMasterStorageReadiness, createMasterRuntime };
