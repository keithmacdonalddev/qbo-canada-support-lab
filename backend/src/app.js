'use strict'

const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const errorHandler = require('./middleware/errorHandler')
const { requestContext } = require('./middleware/requestContext')
const { createRebuildRouter } = require('./routes/rebuild')
const { companyScope: defaultCompanyScope } = require('./middleware/companyScope')

function createApp(options = {}) {
  const app = express()

  app.use(requestContext)
  app.use(cors())
  app.use(express.json())

  // Browser companion redeems a one-use, short-lived case capability, never a JWT.
  // This exact endpoint grants no general app or QBO access.
  app.post('/api/screen-reader/capability', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(req.get('origin') || '') || !['redeem', 'validate'].includes(req.body?.stage)) {
      return res.status(404).json({ error: 'Screen capability unavailable.' });
    }
    try {
      const request = await require('./modules/reproduction-screen').screenBroker.capability(req.body.nonce, req.body.stage === 'redeem');
      return res.json({ request });
    } catch { return res.status(404).json({ error: 'Screen capability unavailable.' }); }
  });

  // Company routes run in the shared company's workspace for its members (see
  // middleware/companyScope.js). Auth, settings and QuickBooks connect/disconnect
  // stay per account; only the connection status read is shared.
  const companyScope = options.companyScope || defaultCompanyScope
  app.use([
    '/api/company', '/api/seed', '/api/audit', '/api/generate', '/api/checkpoint', '/api/explore',
    '/api/coverage', '/api/issuepacks', '/api/ai', '/api/context', '/api/capabilities', '/api/reports',
    '/api/blueprints', '/api/volume-profiles', '/api/business-operations',
  ], companyScope)
  app.get('/api/qbo/status', companyScope)

  app.use('/api/auth', require('./routes/auth'))
  app.use('/api/qbo', require('./routes/qbo'))
  app.use('/api/company', require('./routes/company'))
  app.use('/api/seed', require('./routes/seed'))
  app.use('/api/audit', require('./routes/audit'))
  app.use('/api/generate', require('./routes/generate'))
  app.use('/api/checkpoint', require('./routes/checkpoint'))
  app.use('/api/explore', require('./routes/explore'))
  app.use('/api/coverage', require('./routes/coverage'))
  app.use('/api/business-operations', options.businessOperationsRouter || require('./routes/business-operations').createBusinessOperationsRouter())
  app.use('/api/issuepacks', require('./routes/issuepacks'))
  // Codex CLI runs call this app's AI tools here (per-run token, no JWT).
  app.use('/api/ai-tools/mcp', require('./routes/ai-tools-mcp'))
  const aiRoutes = require('./routes/ai')
  app.use('/api/ai', aiRoutes.router)

  const orchestrator = require('./modules/ai-orchestrator')
  orchestrator.bindSSE(aiRoutes.emitSSE)

  app.get('/api/health', (_req, res) => {
    const databaseConnected = (options.databaseReady || (() => mongoose.connection.readyState === 1))()
    res.status(databaseConnected ? 200 : 503).json({
      app: 'test-data-lab',
      status: databaseConnected ? 'ok' : 'unavailable',
      database: databaseConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    })
  })

  app.use('/api', options.rebuildRouter || createRebuildRouter(options.rebuildDependencies))

  app.use(errorHandler)
  return app
}

module.exports = { createApp }
