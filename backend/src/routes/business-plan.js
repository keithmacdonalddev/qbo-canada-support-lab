'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
const { createBlueprintDraftService } = require('../modules/blueprint-draft-store');
const { validateMappingRequest, assertMappingVersion, checkBlueprintMappings } = require('../modules/blueprint-mapping-check');
const { validateOperationRequest, prepareBusinessOperation, operationHistoryRoots, attachPreparedOperationHistory } = require('../modules/business-operation-preview');
const { createBusinessOperationPlanStore } = require('../modules/business-operation-plan-store');
const { createBusinessStorageReadiness } = require('../modules/business-runtime-storage');
const { createBusinessTransaction } = require('../modules/business-transaction');
const { loadModels } = require('../modules/business-runtime');
const { createBusinessRuntimeAccess } = require('../modules/business-runtime-access');
const { bindPreparedOperationReferences } = require('../modules/business-preparation-references');
const { readBusinessMasters, inspectBusinessMasters } = require('../modules/business-master-data');
const { readDraftSetup, problem } = require('../modules/blueprint-draft');
const { previewBusinessActivity, validatePreviewRequest } = require('../modules/business-activity-preview');
const { createQBOClient } = require('../modules/qbo-client');
const { respondQboError } = require('../modules/qbo-error');
const Connection = require('../models/Connection');
function createBusinessPlanRouter(dependencies = {}) {
  const router = express.Router();
  const service = dependencies.service || createBlueprintDraftService();
  const setup = dependencies.readSetup || readDraftSetup;
  const accessFor = dependencies.accessFor || createBusinessRuntimeAccess;
  let historyBacking;
  const historyFor = dependencies.historyFor || (access => {
    if (!historyBacking) {
      const connection = require('mongoose').connection, models = loadModels();
      historyBacking = { ...models, transaction: createBusinessTransaction(connection), assertReady: createBusinessStorageReadiness({ connection, models }) };
    }
    return createBusinessOperationPlanStore({ ...historyBacking, authorize: access.authorize, readOnly: true });
  });
  const qboFor = dependencies.qboFor || (async (user, context) => {
    const connection = await Connection.findOne({ _id: context.connection.connectionId, userId: user.id, realmId: context.connection.realmId, status: 'active' });
    if (!connection) throw Object.assign(new Error('The connected company changed. Reload before checking setup.'), { status: 409, businessPlanError: true });
    return createQBOClient(connection);
  });
  router.use(authenticate, rejectContextOverrides);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'Business plan requests do not accept query overrides.' });
    next();
  });
  const action = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const local = error.businessPlanError || /^BUSINESS_/.test(error.code || '');
      if (!local && respondQboError(res, error)) return;
      const status = local && [400, 403, 409].includes(error.status) ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'The business plan could not be loaded or saved. Try again.' : error.message });
    }
  };
  router.get('/', action(async (req, res) => res.json({ data: await service.read(req.user) })));
  router.post('/', action(async (req, res) => res.json({ data: await service.save(req.user, req.body) })));
  router.post('/activity-preview', action(async (req, res) => {
    const input = validatePreviewRequest(req.body);
    const view = await service.read(req.user);
    res.json({ data: previewBusinessActivity(view, input) });
  }));
  router.post('/mapping-check', action(async (req, res) => {
    const input = validateMappingRequest(req.body);
    const view = await service.read(req.user);
    assertMappingVersion(view, input);
    const context = await service.contextFor(req.user, 'blueprint.read');
    const scope = { realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId };
    if (Object.keys(scope).some(key => scope[key] !== view[key])) throw problem('The company changed. Reload the business plan.', 409);
    const result = await setup(await qboFor(req.user, context), scope);
    const current = await service.read(req.user);
    assertMappingVersion(current, input);
    res.json({ data: checkBlueprintMappings(current, result, input) });
  }));
  router.post('/operation-preview', action(async (req, res) => {
    const input = validateOperationRequest(req.body);
    const view = await service.read(req.user);
    assertMappingVersion(view, { connectionId: input.connectionId, baseHash: input.baseHash });
    previewBusinessActivity(view, input); // Reject impossible periods before any company read.
    const context = await service.contextFor(req.user, 'blueprint.read');
    const scope = { realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId };
    if (Object.keys(scope).some(key => scope[key] !== view[key])) throw problem('The company changed. Reload the business plan.', 409);
    const qbo = await qboFor(req.user, context);
    const setupResult = await setup(qbo, scope);
    const masters = await (dependencies.readMasters || readBusinessMasters)(qbo, scope);
    const current = await service.read(req.user);
    let prepared = prepareBusinessOperation(current, input, setupResult, masters);
    // Read-only viewers retain the structural preview. Operators can additionally
    // bind complete definitions; neither path grants approval or saves records.
    if (context.membership.permissions.includes('operations.preview') && context.membership.permissions.includes('qbo_data.read')) {
      const controller = new AbortController(), abort = () => controller.abort();
      req.once('aborted', abort); res.once('close', abort);
      if (req.aborted || res.destroyed) abort();
      try {
        const access = accessFor({ actorId: String(req.user.actorId || req.user.id), ownerId: String(req.user.id) });
        let history;
        try { history = await historyFor(access).history(scope, operationHistoryRoots(prepared), { signal: controller.signal }); }
        catch (error) { if (error.code !== 'BUSINESS_STORAGE_UNPREPARED') throw error; history = { unavailable: true }; }
        const existingCurrent = history.entries?.some(entry => prepared.steps.some(step => step.logicalKey === entry.logicalKey));
        if (!existingCurrent) prepared = await bindPreparedOperationReferences(prepared, {
          signal: controller.signal,
          resolveClient: async requested => {
            if (Object.keys(scope).some(key => requested[key] !== scope[key])) throw problem('The company changed during preparation.', 409);
            return qbo;
          },
          authorize: access.authorize,
        });
        prepared = attachPreparedOperationHistory(prepared, history);
        const latest = await service.read(req.user);
        assertMappingVersion(latest, { connectionId: input.connectionId, baseHash: input.baseHash });
        if (Object.keys(scope).some(key => latest[key] !== scope[key])) throw problem('The company changed during preparation.', 409);
      } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); controller.abort(); }
    }
    res.json({ data: prepared });
  }));
  router.post('/masters-check', action(async (req, res) => {
    const input = validateMappingRequest(req.body);
    const view = await service.read(req.user);
    assertMappingVersion(view, input);
    const context = await service.contextFor(req.user, 'blueprint.read');
    const scope = { realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId };
    if (Object.keys(scope).some(key => scope[key] !== view[key])) throw problem('The company changed. Reload the business plan.', 409);
    const observed = await (dependencies.readMasters || readBusinessMasters)(await qboFor(req.user, context), scope);
    const current = await service.read(req.user);
    assertMappingVersion(current, input);
    res.json({ data: inspectBusinessMasters(current, observed) });
  }));
  router.get('/setup', action(async (req, res) => {
    const context = await service.contextFor(req.user, 'blueprint.read');
    const qbo = await qboFor(req.user, context);
    const result = await setup(qbo, { realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId });
    res.json({ data: result });
  }));
  return router;
}
module.exports = { createBusinessPlanRouter };
