'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
const { respondQboError } = require('../modules/qbo-error');
function createBusinessGovernanceRouter(dependencies = {}) {
  const router = express.Router(); let current;
  const service = dependencies.service || (() => current ||= require('../modules/business-governance-service').createBusinessGovernanceService());
  router.use(authenticate, rejectContextOverrides, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = work => async (req, res) => {
    const controller = new AbortController(), abort = () => controller.abort(); req.once('aborted', abort); res.once('close', abort);
    try { res.json({ data: await work(req, controller.signal) }); }
    catch (error) {
      const local = /^BUSINESS_/.test(error.code || '') || error.businessPlanError || error.qboStage === 'write_admission';
      if (!local && respondQboError(res, error)) return;
      const status = local && [400, 403, 404, 409].includes(error.status) ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'Business maintenance could not finish. Saved reviews and progress remain available.' : error.message, code: error.code || 'BUSINESS_GOVERNANCE_REQUIRED' });
    } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); controller.abort(); }
  };
  router.get('/operations/:id/review', action(req => {
    if (Object.keys(req.query).some(key => key !== 'offset') || (req.query.offset !== undefined && !/^(?:0|[1-9][0-9]{0,2}|1000)$/.test(req.query.offset))) throw Object.assign(new Error('Use a bounded saved plan page.'), { status: 400, code: 'BUSINESS_GOVERNANCE_REQUIRED' });
    return service().reviewOperation(req.user, req.params.id, Number(req.query.offset || 0));
  }));
  router.use((req, res, next) => Object.keys(req.query).length ? res.status(400).json({ error: 'Business decisions do not accept query overrides.' }) : next());
  router.get('/', action(req => service().status(req.user)));
  router.post('/publication/review', action(req => service().reviewPublication(req.user, req.body)));
  router.post('/publication', action((req, signal) => service().publish(req.user, req.body, { signal })));
  router.post('/operations/prepare', action((req, signal) => service().prepare(req.user, req.body, { signal })));
  router.post('/operations/:id/approve', action(req => service().approve(req.user, req.params.id, req.body)));
  router.post('/operations/:id/retirement/review', action(req => service().reviewRetirement(req.user, req.params.id, req.body)));
  router.post('/operations/:id/retirement', action(req => service().retire(req.user, req.params.id, req.body)));
  router.post('/operations/:id/tax/review', action(req => service().reviewTaxChange(req.user, req.params.id, req.body)));
  router.post('/operations/:id/tax/approve', action(req => service().approveTaxChange(req.user, req.params.id, req.body)));
  router.post('/operations/:id/resume/review', action(req => service().reviewResume(req.user, req.params.id, req.body)));
  router.post('/operations/:id/resume', action(req => service().resume(req.user, req.params.id, req.body)));
  router.post('/operations/:id/rejection/review', action(req => service().reviewRejected(req.user, req.params.id, req.body)));
  router.post('/operations/:id/rejection/retry', action(req => service().retryRejected(req.user, req.params.id, req.body)));
  router.post('/operations/:id/uncertain/review', action((req, signal) => service().reviewUnknown(req.user, req.params.id, req.body, { signal })));
  router.post('/operations/:id/uncertain/attribute', action((req, signal) => service().attributeUnknown(req.user, req.params.id, req.body, { signal })));
  return router;
}
module.exports = { createBusinessGovernanceRouter };
