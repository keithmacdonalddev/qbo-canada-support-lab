'use strict'

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const schemaPath = path.join(repoRoot, 'docs', 'discovery', 'registry.schema.v1.json')
const catalogPath = path.join(repoRoot, 'docs', 'discovery', 'catalog.v1.json')

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${path.relative(repoRoot, filePath)} is not valid JSON: ${error.message}`)
  }
}

function requireFields(record, fields, label) {
  for (const field of fields) {
    if (!(field in record)) {
      throw new Error(`${label} is missing required field "${field}"`)
    }
  }
}

function uniqueKeys(records, label) {
  const keys = new Set()
  for (const record of records) {
    if (!record.key && !record.id) {
      throw new Error(`${label} entry is missing a key/id`)
    }
    const key = record.key || record.id
    if (keys.has(key)) {
      throw new Error(`${label} contains duplicate key "${key}"`)
    }
    keys.add(key)
  }
  return keys
}

function assertReferences(values, validKeys, label) {
  for (const value of values) {
    if (!validKeys.has(value)) {
      throw new Error(`${label} references unknown key "${value}"`)
    }
  }
}

function main() {
  const schema = readJson(schemaPath)
  const catalog = readJson(catalogPath)

  if (!schema.$id || !schema.$defs?.capability || !schema.$defs?.report) {
    throw new Error('registry.schema.v1.json is missing its versioned id or core definitions')
  }

  requireFields(
    catalog,
    ['catalogVersion', 'status', 'asOfDate', 'releasePolicy', 'sources', 'capabilities', 'reports'],
    'catalog'
  )

  if (catalog.$schema !== './registry.schema.v1.json') {
    throw new Error('catalog must point to ./registry.schema.v1.json')
  }
  if (!catalog.releasePolicy.unknownAllowedDuringDiscovery) {
    throw new Error('discovery policy must permit explicit unknowns')
  }
  if (catalog.releasePolicy.unknownAllowedAtRelease) {
    throw new Error('release policy must reject unknowns')
  }
  if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length === 0) {
    throw new Error('catalog must contain capability candidates')
  }
  if (!Array.isArray(catalog.reports) || catalog.reports.length === 0) {
    throw new Error('catalog must contain report candidates')
  }

  const sourceKeys = uniqueKeys(catalog.sources, 'sources')
  const capabilityKeys = uniqueKeys(catalog.capabilities, 'capabilities')
  const reportKeys = uniqueKeys(catalog.reports, 'reports')

  const capabilityFields = [
    'key',
    'name',
    'purpose',
    'domain',
    'tier',
    'tierRationale',
    'applicability',
    'apiSurface',
    'apiOperations',
    'currentAppStatus',
    'coverageState',
    'requirements',
    'variants',
    'linkedReports',
    'evidenceMethod',
    'evidenceStatus',
    'lastVerified',
    'sourceIds',
    'limitations',
    'approvedExclusions'
  ]

  for (const capability of catalog.capabilities) {
    requireFields(capability, capabilityFields, `capability ${capability.key}`)
    requireFields(
      capability.apiOperations,
      ['read', 'create', 'update', 'delete', 'void'],
      `capability ${capability.key}.apiOperations`
    )
    assertReferences(capability.sourceIds, sourceKeys, `capability ${capability.key}.sourceIds`)
    assertReferences(capability.linkedReports, reportKeys, `capability ${capability.key}.linkedReports`)

    if (capability.evidenceStatus !== 'unverified' && capability.sourceIds.length === 0) {
      throw new Error(`capability ${capability.key} claims evidence without a source`)
    }
    if (capability.evidenceStatus !== 'unverified' && !capability.lastVerified) {
      throw new Error(`capability ${capability.key} claims evidence without lastVerified`)
    }
  }

  const reportFields = [
    'key',
    'name',
    'family',
    'businessQuestion',
    'tier',
    'applicability',
    'api',
    'prerequisites',
    'periods',
    'expectedNonZero',
    'assertions',
    'uiNavigation',
    'coverageState',
    'evidenceStatus',
    'lastVerified',
    'sourceIds',
    'knownDiscrepancies'
  ]

  for (const report of catalog.reports) {
    requireFields(report, reportFields, `report ${report.key}`)
    assertReferences(report.sourceIds, sourceKeys, `report ${report.key}.sourceIds`)

    if (report.api.status === 'supported' && !report.api.endpoint) {
      throw new Error(`report ${report.key} is API-supported but has no endpoint`)
    }
    if (report.evidenceStatus !== 'unverified' && report.sourceIds.length === 0) {
      throw new Error(`report ${report.key} claims evidence without a source`)
    }
    if (report.evidenceStatus !== 'unverified' && !report.lastVerified) {
      throw new Error(`report ${report.key} claims evidence without lastVerified`)
    }
  }

  const unknownCapabilities = catalog.capabilities.filter(
    (entry) =>
      entry.coverageState === 'unknown' ||
      entry.applicability.status === 'unknown' ||
      Object.values(entry.apiOperations).includes('unknown')
  )
  const unknownReports = catalog.reports.filter(
    (entry) =>
      entry.coverageState === 'unknown' ||
      entry.applicability.status === 'unknown' ||
      entry.api.status === 'unknown'
  )

  if (catalog.status === 'approved' && (unknownCapabilities.length > 0 || unknownReports.length > 0)) {
    throw new Error('an approved catalog cannot contain release-blocking unknowns')
  }

  console.log(`Discovery catalog ${catalog.catalogVersion} is structurally valid.`)
  console.log(`Sources: ${sourceKeys.size}`)
  console.log(`Capabilities: ${capabilityKeys.size} (${unknownCapabilities.length} still require classification)`)
  console.log(`Reports: ${reportKeys.size} (${unknownReports.length} still require classification)`)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
