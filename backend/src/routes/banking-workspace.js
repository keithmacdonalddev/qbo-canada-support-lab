'use strict';
const express = require('express');
const { authenticate } = require('../middleware/auth');
// Mount beneath the existing company scope middleware; deliberately not mounted here.
// GET /, /packages/:id, /packages/:id/files/:fileId; POST /packages,
// /packages/:id/imports, /packages/:id/rows, /packages/:id/reconciliation.
// JSON responses are { data }; failures are { error, code }. Every write includes
// requestId/expectedVersion except register, whose immutable revision is its key.
function createBankingWorkspaceRouter(dependencies = {}) {
  const router = express.Router();
  let current;
  const service = () => dependencies.service || (current ||= require('../modules/banking-workspace-service').createBankingWorkspaceService());
  router.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = (work, queryKeys = []) => async (req, res) => {
    try {
      if (Object.keys(req.query).some(key => !queryKeys.includes(key))) return res.status(400).json({ error: 'Unsupported banking query or company override.', code: 'BANKING_INVALID' });
      const data = await work(req, res);
      if (!res.headersSent) res.json({ data });
    } catch (error) {
      const known = /^(BANKING_|BUSINESS_ACCESS_)/.test(error.code || '');
      const status = known && [400,401,403,404,409].includes(error.status) ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'Banking evidence could not be confirmed. Retain the exact request and retry.' : error.message, code: status === 500 ? 'BANKING_FAILED' : error.code });
    }
  };
  router.get('/', action(req => service().list(req.user, req.query), ['accountId','period']));
  router.post('/packages', action(req => service().register(req.user, req.body)));
  router.get('/packages/:id', action(req => service().detail(req.user, req.params.id)));
  router.get('/packages/:id/files/:fileId', action(async (req, res) => {
    const file = await service().download(req.user, req.params.id, req.params.fileId);
    const types = { csv: ['text/csv; charset=utf-8','csv'], statement: ['application/pdf','pdf'], manifest: ['application/json','json'] };
    const [type, extension] = types[file.kind];
    res.set('Content-Type', type); res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'attachment; filename="banking-' + file.fileId.replace(/[^A-Za-z0-9_-]/g, '_') + '.' + extension + '"');
    res.set('ETag', '"' + file.sha256 + '"'); res.send(file.bytes);
  }));
  router.post('/packages/:id/imports', action(req => service().recordImport(req.user, req.params.id, req.body)));
  router.post('/packages/:id/rows', action(req => service().recordRow(req.user, req.params.id, req.body)));
  router.post('/packages/:id/reconciliation', action(req => service().recordReconciliation(req.user, req.params.id, req.body)));
  return router;
}
module.exports = { createBankingWorkspaceRouter };
