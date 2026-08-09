'use strict'

const express = require('express')
const { authenticate } = require('../middleware/auth')
const { requireFeatureFlag, publicFeatureFlags } = require('../middleware/featureGate')
const { createContextService } = require('../modules/rebuild-context')
const { createDefinitionsService } = require('../modules/rebuild-definitions')
const { validateBlueprintDefinition } = require('../modules/blueprint-validator')

const ALLOWED_QUERY_KEYS = Object.freeze({
  capabilities: new Set(['domain', 'tier', 'coverageState', 'offset', 'limit']),
  reports: new Set(['family', 'tier', 'coverageState', 'apiStatus', 'offset', 'limit']),
})
const ALLOWED_QUERY_VALUES = Object.freeze({
  capabilities: {
    domain: new Set(['company', 'sales', 'expenses', 'banking', 'inventory', 'projects', 'tax', 'accounting', 'reporting', 'users', 'administration']),
    tier: new Set(['tier-1', 'tier-2', 'tier-3', 'manual-only-critical', 'deferred']),
    coverageState: new Set(['unknown', 'covered', 'partially-covered', 'manual-only', 'unavailable', 'deferred']),
  },
  reports: {
    family: new Set(['financial', 'cash', 'receivables', 'sales', 'payables', 'expenses', 'inventory', 'projects', 'tax', 'budget', 'reconciliation', 'audit']),
    tier: new Set(['critical', 'supporting', 'edge', 'deferred']),
    coverageState: new Set(['unknown', 'covered', 'partially-covered', 'manual-only', 'unavailable', 'deferred']),
    apiStatus: new Set(['supported', 'conditional', 'unsupported', 'manual-only', 'not-applicable']),
  },
})

function sendError(req, res, status, code, message, details) {
  const error = { code, message }
  if (details) error.details = details
  return res.status(status).json({
    success: false,
    error,
    requestId: req.context?.requestId || null,
  })
}

function rejectContextOverrides(req, res, next) {
  const untrustedKeys = ['realmId', 'realmID', 'companyId', 'companyID', 'environment']
  const supplied = untrustedKeys.filter(
    (key) => Object.prototype.hasOwnProperty.call(req.query || {}, key) || Object.prototype.hasOwnProperty.call(req.body || {}, key)
  )
  if (supplied.length > 0) {
    return sendError(req, res, 400, 'CONTEXT_OVERRIDE_FORBIDDEN', 'Company and environment context are resolved by the server', { fields: supplied })
  }
  return next()
}

function parseListQuery(req, res, kind) {
  const unknown = Object.keys(req.query).filter((key) => !ALLOWED_QUERY_KEYS[kind].has(key))
  if (unknown.length > 0) {
    sendError(req, res, 400, 'INVALID_QUERY', 'Unsupported query parameter', { fields: unknown })
    return null
  }
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset)
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit)
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    sendError(req, res, 400, 'INVALID_PAGINATION', 'offset must be a non-negative integer and limit must be an integer from 1 to 100')
    return null
  }
  const invalidValues = Object.entries(ALLOWED_QUERY_VALUES[kind]).flatMap(([key, values]) => {
    if (req.query[key] === undefined) return []
    return typeof req.query[key] === 'string' && values.has(req.query[key]) ? [] : [key]
  })
  if (invalidValues.length > 0) {
    sendError(req, res, 400, 'INVALID_QUERY_VALUE', 'One or more query values are unsupported', { fields: invalidValues })
    return null
  }
  return { ...req.query, offset, limit }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function createRebuildRouter(dependencies = {}) {
  const router = express.Router()
  const contextService = dependencies.contextService || createContextService()
  const definitionsService = dependencies.definitionsService || createDefinitionsService()
  const featureSource = dependencies.featureSource

  router.use(authenticate)
  router.use(requireFeatureFlag('rebuildReadOnly', {
    source: featureSource,
    message: 'The rebuild read-only API is disabled by server policy',
  }))
  router.use(rejectContextOverrides)
  router.use(asyncRoute(async (req, _res, next) => {
    req.rebuildContext = await contextService.resolve(req.user)
    next()
  }))

  function requirePermission(permission) {
    return (req, res, next) => {
      if (req.rebuildContext.membership.permissions.includes(permission)) return next()
      return sendError(req, res, 403, 'PERMISSION_DENIED', `Permission ${permission} is required`)
    }
  }

  router.get('/context', requirePermission('company.read'), (req, res) => {
    res.json({
      success: true,
      data: {
        ...req.rebuildContext,
        definitions: definitionsService.getSummary(),
        featureFlags: publicFeatureFlags(featureSource),
      },
      requestId: req.context?.requestId || null,
    })
  })

  router.get('/capabilities', requirePermission('coverage.read'), (req, res) => {
    const filters = parseListQuery(req, res, 'capabilities')
    if (!filters) return
    res.json({ success: true, data: definitionsService.listCapabilities(filters), requestId: req.context?.requestId || null })
  })

  router.get('/capabilities/operation-matrix', requirePermission('coverage.read'), (_req, res) => {
    res.json({ success: true, data: definitionsService.getOperationMatrix(), requestId: _req.context?.requestId || null })
  })

  router.get('/reports', requirePermission('reports.read'), (req, res) => {
    const filters = parseListQuery(req, res, 'reports')
    if (!filters) return
    res.json({ success: true, data: definitionsService.listReports(filters), requestId: req.context?.requestId || null })
  })

  router.get('/blueprints/proposal', requirePermission('blueprint.read'), (_req, res) => {
    const proposal = definitionsService.getFlagshipProfile()
    res.json({ success: true, data: { proposal, validation: validateBlueprintDefinition(proposal) }, requestId: _req.context?.requestId || null })
  })

  router.get('/volume-profiles', requirePermission('coverage.read'), (_req, res) => {
    res.json({ success: true, data: definitionsService.getVolumeProfiles(), requestId: _req.context?.requestId || null })
  })

  router.use((error, req, res, _next) => {
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 ? error.statusCode : 500
    const code = status === 500 ? 'REBUILD_API_ERROR' : (error.code || 'REQUEST_FAILED')
    const message = status === 500 ? 'The rebuild read-only request could not be completed' : error.message
    return sendError(req, res, status, code, message)
  })

  return router
}

module.exports = {
  createRebuildRouter,
  parseListQuery,
  rejectContextOverrides,
}
