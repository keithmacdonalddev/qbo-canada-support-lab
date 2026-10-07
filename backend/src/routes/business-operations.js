'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
const { respondQboError } = require('../modules/qbo-error');
function createBusinessOperationsRouter({ service = () => require('../modules/business-execution-service').getBusinessExecutionService() } = {}) {
  const router = express.Router(); router.use(authenticate, rejectContextOverrides);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = work => async (req, res) => { try { await work(req, res); } catch (error) {
    const local = error.businessExecutionError === true || /^BUSINESS_[A-Z_]+$/.test(error.code || '');
    if (!local && respondQboError(res, error)) return;
    const status = [400, 403, 404, 409].includes(error.status) ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Business operations are unavailable. Saved work has been retained.' : error.message, ...(local && error.code ? { code: error.code } : {}) });
  } };
  router.get('/', action(async (req, res) => {
    if (Object.keys(req.query).some(key => !['after', 'limit'].includes(key)) || (req.query.limit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(req.query.limit))) throw Object.assign(new Error('Use a bounded operation page.'), { status: 400, businessExecutionError: true });
    res.json({ data: await service().list(req.user, { after: req.query.after, limit: req.query.limit === undefined ? 50 : Number(req.query.limit) }) });
  }));
  router.use('/:id', (req, res, next) => Object.keys(req.query).length ? res.status(400).json({ error: 'Operation actions do not accept query overrides.' }) : next());
  router.get('/:id', action(async (req, res) => res.json({ data: await service().inspect(req.user, req.params.id) })));
  router.post('/:id/execute', action(async (req, res) => {
    const result = await service().request(req.user, req.params.id, req.body);
    res.status(result.accepted ? 202 : 200).json({ data: result });
  }));
  router.post('/:id/stop', action(async (req, res) => {
    if (req.body && Object.keys(req.body).length) throw Object.assign(new Error('Stop does not accept context or state overrides.'), { status: 400, businessExecutionError: true });
    res.json({ data: await service().stop(req.user, req.params.id) });
  }));
  return router;
}
module.exports = { createBusinessOperationsRouter };
