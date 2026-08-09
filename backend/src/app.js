'use strict'

const express = require('express')
const cors = require('cors')
const errorHandler = require('./middleware/errorHandler')
const { requestContext } = require('./middleware/requestContext')
const { createRebuildRouter } = require('./routes/rebuild')

function createApp(options = {}) {
  const app = express()

  app.use(requestContext)
  app.use(cors())
  app.use(express.json())

  app.use('/api/auth', require('./routes/auth'))
  app.use('/api/qbo', require('./routes/qbo'))
  app.use('/api/company', require('./routes/company'))
  app.use('/api/seed', require('./routes/seed'))
  app.use('/api/audit', require('./routes/audit'))
  app.use('/api/generate', require('./routes/generate'))
  app.use('/api/checkpoint', require('./routes/checkpoint'))
  app.use('/api/explore', require('./routes/explore'))
  app.use('/api/issuepacks', require('./routes/issuepacks'))
  const aiRoutes = require('./routes/ai')
  app.use('/api/ai', aiRoutes.router)

  const orchestrator = require('./modules/ai-orchestrator')
  orchestrator.bindSSE(aiRoutes.emitSSE)

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  app.use('/api', options.rebuildRouter || createRebuildRouter(options.rebuildDependencies))

  app.use(errorHandler)
  return app
}

module.exports = { createApp }
