'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
const { respondQboError } = require('../modules/qbo-error');
function createBusinessBaselineRouter(dependencies = {}) {
  const router = express.Router(); let current;
  const service = dependencies.service || (() => current ||= require('../modules/business-baseline-service').createBusinessBaselineService());
  router.use(authenticate, rejectContextOverrides, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = work => async (req, res) => {
    try { await work(req, res); } catch (error) {
      const local = /^BUSINESS_/.test(error.code || '');
      if (!local && respondQboError(res, error)) return;
      const status = local && [400, 403, 404, 409].includes(error.status) ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'The baseline observation could not be loaded or saved. Retry with the same request.' : error.message, ...(local ? { code: error.code } : {}), ...(status === 400 && error.code === 'BUSINESS_BASELINE_REQUEST_INVALID' && error.notSaved === true ? { notSaved: true } : {}) });
    }
  };
  const badInput = () => { throw Object.assign(new Error('Use the supported baseline observation request.'), { code: 'BUSINESS_BASELINE_UNVERIFIED', status: 400 }); };
  router.get('/', action(async (req, res) => {
    if (Object.keys(req.query).some(key => !['after', 'limit'].includes(key)) || (req.query.limit !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(req.query.limit))) badInput();
    res.json({ data: await service().list(req.user, { ...(req.query.after === undefined ? {} : { after: req.query.after }), ...(req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }) }) });
  }));
  router.post('/', action(async (req, res) => {
    if (Object.keys(req.query).length) badInput();
    const controller = new AbortController(), abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort); if (req.aborted || res.destroyed) abort();
    try { const result = await service().capture(req.user, req.body, { signal: controller.signal }); if (!controller.signal.aborted) res.json({ data: result }); }
    finally { req.removeListener('aborted', abort); res.removeListener('close', abort); controller.abort(); }
  }));

  router.get('/:id/inventory', action(async (req, res) => {
    if (Object.keys(req.query).some(key => !['entity', 'after', 'limit'].includes(key)) || typeof req.query.entity !== 'string' || (req.query.after !== undefined && typeof req.query.after !== 'string') || (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(req.query.limit)))) badInput();
    res.json({ data: await service().inventory(req.user, req.params.id, { entity: req.query.entity, ...(req.query.after === undefined ? {} : { after: req.query.after }), ...(req.query.limit === undefined ? {} : { limit: Number(req.query.limit) }) }) });
  }));
  router.get('/:id/inventory/:entity/:recordId', action(async (req, res) => {
    if (Object.keys(req.query).length) badInput();
    const controller = new AbortController(), abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort); if (req.aborted || res.destroyed) abort();
    try { const result = await service().review(req.user, req.params.id, req.params.entity, req.params.recordId, { signal: controller.signal }); if (!controller.signal.aborted) res.json({ data: result }); }
    finally { req.removeListener('aborted', abort); res.removeListener('close', abort); controller.abort(); }
  }));
  router.get('/:id', action(async (req, res) => { if (Object.keys(req.query).length) badInput(); res.json({ data: await service().inspect(req.user, req.params.id) }); }));
  return router;
}
module.exports = { createBusinessBaselineRouter };
