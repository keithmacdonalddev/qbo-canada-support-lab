'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { rejectContextOverrides } = require('./rebuild');
function createReportEvidenceRouter(dependencies = {}) {
  const router = express.Router(); let current;
  const service = dependencies.service || (() => current ||= require('../modules/report-evidence-service').createReportEvidenceService());
  router.use(authenticate, rejectContextOverrides, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = work => async (req, res) => {
    try { res.json({ data: await work(req) }); }
    catch (error) { const known = /^(?:REPORT_EVIDENCE_|BUSINESS_ACCESS_)/.test(error.code || ''), status = known && [400,403,404,409].includes(error.status) ? error.status : 500; res.status(status).json({ error: status === 500 ? 'Saved manual report evidence is unavailable. Retry the exact request before relying on a result.' : error.message, ...(known ? { code: error.code } : {}) }); }
  };
  const noQuery = req => { if (Object.keys(req.query).length) throw Object.assign(new Error('This report action accepts no query overrides.'), { status: 400, code: 'REPORT_EVIDENCE_UNAVAILABLE' }); };
  router.get('/', action(req => service().list(req.user, req.query)));
  router.post('/', action(req => { noQuery(req); return service().save(req.user, req.body); }));
  router.post('/withdraw', action(req => { noQuery(req); return service().withdraw(req.user, req.body); }));
  router.get('/:id', action(req => { noQuery(req); return service().inspect(req.user, req.params.id); }));
  return router;
}
module.exports = { createReportEvidenceRouter };
