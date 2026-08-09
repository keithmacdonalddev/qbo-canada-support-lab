'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const jwt = require('jsonwebtoken')

const config = require('../src/config')
const { createApp } = require('../src/app')
const { createRebuildRouter } = require('../src/routes/rebuild')
const { requestContext } = require('../src/middleware/requestContext')
const { createDefinitionsService } = require('../src/modules/rebuild-definitions')
const { createContextService } = require('../src/modules/rebuild-context')
const { validateBlueprintDefinition } = require('../src/modules/blueprint-validator')
const BlueprintVersion = require('../src/models/BlueprintVersion')

function bearer(role = 'supervisor') {
  const token = jwt.sign({ id: '000000000000000000000001', email: 'fixture@test.local', role }, config.jwtSecret)
  return `Bearer ${token}`
}

async function withServer(app, callback) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

function createFixtureApp({ permissions } = {}) {
  const app = express()
  app.use(requestContext)
  app.use(express.json())
  const contextService = {
    async resolve() {
      return {
        environment: 'production',
        connection: {
          connected: true,
          realmId: 'server-owned-realm',
          companyName: 'Fixture Company',
          status: 'active',
          lastRefreshedAt: null,
          contextUpdatedAt: null,
        },
        membership: {
          role: 'reviewer',
          permissions: permissions || ['company.read', 'coverage.read', 'reports.read', 'blueprint.read'],
          source: 'company-membership',
        },
      }
    },
  }
  const featureSource = {
    rebuildReadOnly: true,
    experimental: { aiMutations: false, issuePackMutations: false },
    legacyStartupMaintenance: false,
  }
  app.use('/api', createRebuildRouter({ contextService, featureSource }))
  return app
}

test('definition service exposes honest static classifications without secrets', () => {
  const definitions = createDefinitionsService()
  const summary = definitions.getSummary()

  assert.equal(summary.counts.capabilities, 24)
  assert.equal(summary.counts.reports, 48)
  assert.equal(summary.counts.staticUnknown.tierOne, 2)
  assert.equal(summary.counts.staticUnknown.reports, 0)
  assert.equal(summary.counts.capabilityCoverageUnknown, 24)
  assert.equal(summary.counts.reportCoverageUnknown, 48)
  const operationEntities = definitions.getOperationMatrix().lifecycles.flatMap((entry) => entry.entities)
  assert.equal(operationEntities.length, 12)
  assert.equal(
    operationEntities.flatMap((entry) => Object.values(entry.operations)).filter((status) => status === 'unknown').length,
    30
  )
  assert.equal(validateBlueprintDefinition(definitions.getFlagshipProfile()).valid, true)

  const forbiddenKeys = new Set(['accessToken', 'refreshToken', 'clientSecret', 'anthropicApiKey', 'authorization'])
  function inspect(value) {
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `definition output must not contain ${key}`)
      inspect(nested)
    }
  }
  inspect({
    summary,
    capabilities: definitions.listCapabilities({ offset: 0, limit: 100 }),
    reports: definitions.listReports({ offset: 0, limit: 100 }),
    matrix: definitions.getOperationMatrix(),
    profile: definitions.getFlagshipProfile(),
    volumes: definitions.getVolumeProfiles(),
  })
})

test('blueprint model derives validation evidence instead of trusting caller fields', async () => {
  const definitions = createDefinitionsService()
  const document = new BlueprintVersion({
    realmId: 'fixture-realm',
    version: 1,
    status: 'draft',
    definition: definitions.getFlagshipProfile(),
    validation: { valid: false, errors: [{ path: '/', message: 'caller claim' }], validatedAt: null },
    createdBy: '000000000000000000000001',
  })
  await document.validate()
  assert.equal(document.validation.valid, true)
  assert.deepEqual(document.validation.errors, [])
  assert.equal(document.validation.validatedAt instanceof Date, true)
})

test('context service derives realm and permissions only from server lookups', async () => {
  const calls = []
  const service = createContextService({
    environment: 'production',
    async findActiveConnection(userId) {
      calls.push(['connection', userId])
      return { realmId: 'trusted-realm', companyName: 'Trusted Company', status: 'active' }
    },
    async findActiveMembership(userId, realmId) {
      calls.push(['membership', userId, realmId])
      return { role: 'operator', permissionOverrides: ['audit.read'] }
    },
  })

  const context = await service.resolve({ id: 'user-1', role: 'agent', realmId: 'client-realm' })
  assert.equal(context.connection.realmId, 'trusted-realm')
  assert.equal(context.membership.role, 'operator')
  assert.equal(context.membership.permissions.includes('audit.read'), true)
  assert.deepEqual(calls, [
    ['connection', 'user-1'],
    ['membership', 'user-1', 'trusted-realm'],
  ])
  assert.equal('accessToken' in context.connection, false)
  assert.equal('refreshToken' in context.connection, false)
})

test('legacy-role bridge is read-only until an explicit membership exists', async () => {
  const service = createContextService({
    environment: 'production',
    async findActiveConnection() {
      return { realmId: 'trusted-realm', status: 'active' }
    },
    async findActiveMembership() {
      return null
    },
  })

  const context = await service.resolve({ id: 'legacy-supervisor', role: 'supervisor' })
  assert.equal(context.membership.source, 'legacy-role-bridge')
  assert.equal(context.membership.role, 'lab-owner')
  assert.equal(context.membership.permissions.length > 0, true)
  assert.equal(context.membership.permissions.every((permission) => permission.endsWith('.read')), true)
  assert.equal(context.membership.permissions.includes('blueprint.manage'), false)
})

test('read-only routes reject realm overrides and enforce permission checks', async () => {
  await withServer(createFixtureApp({ permissions: ['company.read'] }), async (baseUrl) => {
    const override = await fetch(`${baseUrl}/api/context?realmId=client-realm`, {
      headers: { Authorization: bearer(), 'X-Request-Id': 'fixture-override' },
    })
    assert.equal(override.status, 400)
    assert.equal((await override.json()).error.code, 'CONTEXT_OVERRIDE_FORBIDDEN')

    const forbidden = await fetch(`${baseUrl}/api/reports`, {
      headers: { Authorization: bearer(), 'X-Request-Id': 'fixture-permission' },
    })
    assert.equal(forbidden.status, 403)
    const body = await forbidden.json()
    assert.equal(body.error.code, 'PERMISSION_DENIED')
    assert.equal(body.requestId, 'fixture-permission')
  })
})

test('unexpected read-only route failures use the sanitized rebuild error contract', async () => {
  const app = express()
  app.use(requestContext)
  app.use(express.json())
  const featureSource = {
    rebuildReadOnly: true,
    experimental: { aiMutations: false, issuePackMutations: false },
    legacyStartupMaintenance: false,
  }
  app.use('/api', createRebuildRouter({
    featureSource,
    contextService: {
      async resolve() {
        throw new Error('fixture database detail must not escape')
      },
    },
  }))

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/context`, {
      headers: { Authorization: bearer(), 'X-Request-Id': 'fixture-error' },
    })
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.error.code, 'REBUILD_API_ERROR')
    assert.equal(body.error.message.includes('fixture database detail'), false)
    assert.equal(body.requestId, 'fixture-error')
  })
})

test('read-only context and catalog routes return bounded, server-owned data', async () => {
  await withServer(createFixtureApp(), async (baseUrl) => {
    const contextResponse = await fetch(`${baseUrl}/api/context`, {
      headers: { Authorization: bearer(), 'X-Request-Id': 'fixture-context' },
    })
    assert.equal(contextResponse.status, 200)
    assert.equal(contextResponse.headers.get('x-request-id'), 'fixture-context')
    const context = await contextResponse.json()
    assert.equal(context.data.connection.realmId, 'server-owned-realm')
    assert.equal(context.data.definitions.counts.staticUnknown.tierOne, 2)
    assert.equal(context.data.featureFlags.experimental.aiMutations, false)

    const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities?limit=2&offset=0&tier=tier-1`, {
      headers: { Authorization: bearer() },
    })
    assert.equal(capabilitiesResponse.status, 200)
    const capabilities = await capabilitiesResponse.json()
    assert.equal(capabilities.data.items.length, 2)
    assert.equal(capabilities.data.items.every((entry) => entry.tier === 'tier-1'), true)

    const invalidPagination = await fetch(`${baseUrl}/api/reports?limit=101`, {
      headers: { Authorization: bearer() },
    })
    assert.equal(invalidPagination.status, 400)
    assert.equal((await invalidPagination.json()).error.code, 'INVALID_PAGINATION')
  })
})

test('legacy AI and issue-pack QBO mutation routes are off by default', async () => {
  assert.equal(config.features.experimental.aiMutations, false)
  assert.equal(config.features.experimental.issuePackMutations, false)

  await withServer(createApp(), async (baseUrl) => {
    for (const path of ['/api/ai/plan/fixture/execute', '/api/issuepacks/fixture/run']) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: bearer(),
          'Content-Type': 'application/json',
          'X-Request-Id': `gate-${path.includes('issuepacks') ? 'issuepack' : 'ai'}`,
        },
        body: JSON.stringify({ confirmProduction: true }),
      })
      assert.equal(response.status, 403)
      const body = await response.json()
      assert.equal(body.error.code, 'FEATURE_DISABLED')
    }
  })
})

test('public health remains reachable before authenticated rebuild routes', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'ok')
    assert.equal(Number.isNaN(Date.parse(body.timestamp)), false)
  })
})

test('importing the server module does not start a listener', () => {
  const serverModule = require('../src/server')
  assert.equal(typeof serverModule.start, 'function')
})
