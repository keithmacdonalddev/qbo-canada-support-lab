'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
function createBusinessSetupRouter(dependencies = {}) {
  const router = express.Router(); let current;
  const service = dependencies.service || (() => current ||= require('../modules/business-setup-service').createBusinessSetupService());
  router.use(authenticate, rejectContextOverrides, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'Setup actions do not accept company overrides.' }); next();
  });
  const action = work => async (req, res) => { try { res.json({ data: await work(req) }); } catch (error) {
    const local = /^BUSINESS_/.test(error.code || '') || error.setupError;
    const status = local && [400, 403, 409].includes(error.status) ? error.status : error.setupError ? 409 : 500;
    res.status(status).json({ error: status === 500 ? 'Company setup could not finish. Saved preparation remains available for recovery.' : error.message, code: error.code || 'BUSINESS_SETUP_REQUIRED' });
  } };
  const empty = req => { if (!req.body || Object.keys(req.body).length) throw Object.assign(new Error('This action takes no company or state overrides.'), { status: 400, code: 'BUSINESS_SETUP_REQUIRED' }); };
  router.get('/', action(req => service().status(req.user)));
  router.post('/preview', action(req => { empty(req); return service().preview(req.user); }));
  router.post('/apply', action(req => service().apply(req.user, req.body)));
  router.post('/coordination/prepare', action(req => { empty(req); return service().prepareCoordination(req.user); }));
  router.post('/coordination/activate', action(req => service().activateCoordination(req.user, req.body)));
  return router;
}
module.exports = { createBusinessSetupRouter };
