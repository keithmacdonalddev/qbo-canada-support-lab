'use strict';
const { harness, scope, ownerId } = require('./master-transport-fixture');
const { createMasterPreparationStore } = require('../../src/modules/business-master-preparation-store');
const { createBusinessRuntimeAccess } = require('../../src/modules/business-runtime-access');
const { prepareMasterPlan, compileMasterEntry } = require('../../src/modules/business-master-preparation-plan');
const { prepareMasterDispatchEvidence } = require('../../src/modules/business-master-dispatch-evidence');
const { verifiedParents } = require('../../src/modules/business-master-preparation-transport');
const { freezeWriteRequest } = require('../../src/modules/qbo-write-contract');
const { hash } = require('../../src/modules/business-calendar');
function scenario(options = {}) {
  const h = harness(options), plan = prepareMasterPlan(h.source); h.data.MasterRuns = []; h.data.Audits = []; Object.assign(h.writer(), { operationId: null, planHash: null, workflowKind: null });
  const access = createBusinessRuntimeAccess({ ...h.models, ownerId, actorId: ownerId, environment: () => scope.environment, createClient: async () => h.client });
  h.access = access; h.tokenSequence = 0; h.ownershipQueries = [];
  h.db = { collection: name => ({ find: (filter, options) => { h.ownershipQueries.push({ name, filter, options }); return { limit() { return this; }, toArray: async () => h.legacyOwner && name === 'seedruns' ? [{ _id: 'other-legacy-owner' }] : [] }; } }) };
  h.store = createMasterPreparationStore({ models: h.models, db: h.db, scope, ownerId, actorId: ownerId, access, transaction: h.transaction, assertReady: async () => {}, transport: h.master, assertQuiescent: async () => { if (h.busy) throw new Error('fixture active work'); }, now: () => h.clock, token: () => 'master-private-worker-' + String(++h.tokenSequence).padStart(16, '0') });
  h.propose = () => h.store.propose(plan); h.approve = () => h.store.approve(String(h.run()._id), plan.planHash, true, prepareMasterPlan(h.source)); h.claim = () => h.store.claim(String(h.run()._id));
  h.prepare = async ordinal => {
    const run = h.run(); h.compiled = compileMasterEntry(run.plan, ordinal, verifiedParents(run)); h.request = freezeWriteRequest(scope, 'POST', h.compiled.entity.toLowerCase(), h.compiled.payload);
    const proof = prepareMasterDispatchEvidence({ run, ordinal, requestHash: h.request.requestHash, setup: h.source.setup, country: h.source.country, controls: h.source.periodControl, now: h.clock });
    await h.store.reserve(String(run._id), run.leaseToken, ordinal, proof);
    h.workflow = { version: 1, kind: 'master-preparation', runId: String(run._id), ordinal, attempt: 1, leaseToken: run.leaseToken };
  };
  return h;
}
module.exports = { scenario };
