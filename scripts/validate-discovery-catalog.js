'use strict'

const fs = require('fs')
const path = require('path')
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')

const repoRoot = path.resolve(__dirname, '..')
const schemaPath = path.join(repoRoot, 'docs', 'discovery', 'registry.schema.v1.json')
const catalogPath = path.join(repoRoot, 'docs', 'discovery', 'catalog.v1.json')
const profilePath = path.join(repoRoot, 'docs', 'discovery', 'flagship-business-profile.v1.json')
const volumePath = path.join(repoRoot, 'docs', 'discovery', 'volume-profiles.v1.json')
const requiredReportManifestPath = path.join(repoRoot, 'docs', 'discovery', 'required-report-manifest.v1.json')
const operationMatrixSchemaPath = path.join(repoRoot, 'docs', 'discovery', 'entity-operation-matrix.schema.v1.json')
const operationMatrixPath = path.join(repoRoot, 'docs', 'discovery', 'entity-operation-matrix.v1.json')
const expectedPlanReportKeys = [
  'report.balance-sheet',
  'report.profit-and-loss',
  'report.profit-and-loss-detail',
  'report.trial-balance',
  'report.general-ledger',
  'report.account-list-detail',
  'report.journal',
  'report.cash-flow',
  'report.cash-summary',
  'report.ar-aging',
  'report.ar-aging-detail',
  'report.customer-balance',
  'report.customer-balance-detail',
  'report.invoice-list',
  'report.collections',
  'report.customer-statements',
  'report.customer-sales',
  'report.customer-income',
  'report.item-sales',
  'report.class-sales',
  'report.department-sales',
  'report.ap-aging',
  'report.ap-aging-detail',
  'report.vendor-balance',
  'report.vendor-balance-detail',
  'report.unpaid-bills',
  'report.vendor-expenses',
  'report.purchases-by-vendor',
  'report.purchases-by-product',
  'report.purchases-by-class',
  'report.purchases-by-location',
  'report.inventory-valuation-summary',
  'report.inventory-valuation-detail',
  'report.inventory-quantity-on-hand',
  'report.inventory-purchases',
  'report.inventory-adjustments',
  'report.project-profitability',
  'report.project-time-cost',
  'report.project-unbilled-activity',
  'report.tax-liability',
  'report.tax-detail',
  'report.budget-vs-actual',
  'report.management-comparison',
  'report.reconciliation-summary',
  'report.cleared-uncleared',
  'report.account-history',
  'report.audit-log',
  'report.transaction-exceptions'
]

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

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} has unsupported value "${value}"`)
  }
}

function main() {
  const schema = readJson(schemaPath)
  const catalog = readJson(catalogPath)
  const profile = readJson(profilePath)
  const volumeProposal = readJson(volumePath)
  const requiredReportManifest = readJson(requiredReportManifestPath)
  const operationMatrixSchema = readJson(operationMatrixSchemaPath)
  const operationMatrix = readJson(operationMatrixPath)

  if (!schema.$id || !schema.$defs?.capability || !schema.$defs?.report) {
    throw new Error('registry.schema.v1.json is missing its versioned id or core definitions')
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const validateSchema = ajv.compile(schema)
  if (!validateSchema(catalog)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    throw new Error(`catalog.v1.json does not satisfy registry.schema.v1.json: ${details}`)
  }
  const validateOperationMatrix = ajv.compile(operationMatrixSchema)
  if (!validateOperationMatrix(operationMatrix)) {
    const details = validateOperationMatrix.errors
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ')
    throw new Error(`entity-operation-matrix.v1.json does not satisfy its schema: ${details}`)
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
  assertReferences(operationMatrix.sourceIds, sourceKeys, 'entity operation matrix sourceIds')
  const expectedOperationEntities = {
    'sales.receivables-lifecycle': ['Estimate', 'Invoice', 'SalesReceipt', 'Payment', 'CreditMemo', 'RefundReceipt', 'Deposit'],
    'expenses.payables-lifecycle': ['PurchaseOrder', 'Purchase', 'Bill', 'BillPayment', 'VendorCredit']
  }
  const operationCapabilityKeys = new Set()
  for (const lifecycle of operationMatrix.lifecycles) {
    if (operationCapabilityKeys.has(lifecycle.capabilityKey)) {
      throw new Error(`entity operation matrix contains duplicate lifecycle "${lifecycle.capabilityKey}"`)
    }
    operationCapabilityKeys.add(lifecycle.capabilityKey)
    if (!capabilityKeys.has(lifecycle.capabilityKey)) {
      throw new Error(`entity operation matrix references unknown capability "${lifecycle.capabilityKey}"`)
    }
    const expectedEntities = expectedOperationEntities[lifecycle.capabilityKey]
    if (!expectedEntities) {
      throw new Error(`entity operation matrix contains unexpected lifecycle "${lifecycle.capabilityKey}"`)
    }
    const entityNames = lifecycle.entities.map((entry) => entry.entity)
    if (new Set(entityNames).size !== entityNames.length) {
      throw new Error(`entity operation matrix ${lifecycle.capabilityKey} contains duplicate entities`)
    }
    const missingEntities = expectedEntities.filter((entity) => !entityNames.includes(entity))
    const unexpectedEntities = entityNames.filter((entity) => !expectedEntities.includes(entity))
    if (missingEntities.length || unexpectedEntities.length) {
      throw new Error(`entity operation matrix ${lifecycle.capabilityKey} is incomplete: missing [${missingEntities.join(', ')}]; unexpected [${unexpectedEntities.join(', ')}]`)
    }
    for (const entity of lifecycle.entities) {
      assertReferences(entity.sourceIds, sourceKeys, `entity operation matrix ${lifecycle.capabilityKey}.${entity.entity}.sourceIds`)
    }
    const capability = catalog.capabilities.find((entry) => entry.key === lifecycle.capabilityKey)
    for (const operation of ['read', 'create', 'update', 'delete', 'void']) {
      const classifications = new Set(lifecycle.entities.map((entry) => entry.operations[operation]))
      const expectedComposite = classifications.has('unknown')
        ? 'unknown'
        : classifications.size === 1 && classifications.has('supported')
          ? 'supported'
          : 'conditional'
      if (capability.apiOperations[operation] !== expectedComposite) {
        throw new Error(`capability ${lifecycle.capabilityKey}.apiOperations.${operation} must be ${expectedComposite} to match the entity operation matrix`)
      }
    }
  }
  for (const capabilityKey of Object.keys(expectedOperationEntities)) {
    if (!operationCapabilityKeys.has(capabilityKey)) {
      throw new Error(`entity operation matrix is missing lifecycle "${capabilityKey}"`)
    }
  }
  requireFields(requiredReportManifest, ['manifestVersion', 'planSection', 'reports'], 'required report manifest')
  const requiredReportKeys = uniqueKeys(requiredReportManifest.reports, 'required report manifest')
  if (requiredReportManifest.planSection !== '13.2') {
    throw new Error('required report manifest must identify rebuild plan section 13.2')
  }
  const missingPlanReports = expectedPlanReportKeys.filter((key) => !requiredReportKeys.has(key))
  const unexpectedPlanReports = [...requiredReportKeys].filter((key) => !expectedPlanReportKeys.includes(key))
  if (missingPlanReports.length || unexpectedPlanReports.length) {
    throw new Error(`required report manifest does not exactly match the plan: missing [${missingPlanReports.join(', ')}]; unexpected [${unexpectedPlanReports.join(', ')}]`)
  }
  assertReferences(requiredReportKeys, reportKeys, 'required report manifest')
  for (const requiredReport of requiredReportManifest.reports) {
    requireFields(requiredReport, ['key', 'planFamily', 'reason'], `required report ${requiredReport.key}`)
  }
  const operationStatuses = schema.$defs.operationSupport.enum
  const availabilityStatuses = schema.$defs.availability.enum
  const coverageStatuses = schema.$defs.coverageState.enum
  const evidenceStatuses = schema.$defs.evidenceStatus.enum
  const keyPattern = new RegExp(schema.$defs.key.pattern)

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
    if (!keyPattern.test(capability.key)) {
      throw new Error(`capability key "${capability.key}" does not match the schema key pattern`)
    }
    assertEnum(capability.applicability.status, availabilityStatuses, `capability ${capability.key}.applicability.status`)
    assertEnum(capability.coverageState, coverageStatuses, `capability ${capability.key}.coverageState`)
    assertEnum(capability.evidenceStatus, evidenceStatuses, `capability ${capability.key}.evidenceStatus`)
    for (const [operation, status] of Object.entries(capability.apiOperations)) {
      assertEnum(status, operationStatuses, `capability ${capability.key}.apiOperations.${operation}`)
    }

    if (
      capability.apiSurface === 'none' &&
      Object.values(capability.apiOperations).some((status) => status === 'supported')
    ) {
      throw new Error(`capability ${capability.key} has no API surface but claims a supported operation`)
    }

    if (capability.evidenceStatus !== 'unverified' && capability.sourceIds.length === 0) {
      throw new Error(`capability ${capability.key} claims evidence without a source`)
    }
    if (capability.evidenceStatus !== 'unverified' && !capability.lastVerified) {
      throw new Error(`capability ${capability.key} claims evidence without lastVerified`)
    }
    if (
      capability.coverageState !== 'unknown' &&
      ['unverified', 'documented', 'static-verified'].includes(capability.evidenceStatus)
    ) {
      throw new Error(`capability ${capability.key} claims dataset coverage without observed or manually verified evidence`)
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
    if (!keyPattern.test(report.key)) {
      throw new Error(`report key "${report.key}" does not match the schema key pattern`)
    }
    assertEnum(report.applicability.status, availabilityStatuses, `report ${report.key}.applicability.status`)
    assertEnum(report.coverageState, coverageStatuses, `report ${report.key}.coverageState`)
    assertEnum(report.evidenceStatus, evidenceStatuses, `report ${report.key}.evidenceStatus`)
    assertEnum(report.api.status, operationStatuses, `report ${report.key}.api.status`)

    if (report.api.status === 'supported' && !report.api.endpoint) {
      throw new Error(`report ${report.key} is API-supported but has no endpoint`)
    }
    if (report.api.status === 'manual-only' && !report.uiNavigation) {
      throw new Error(`report ${report.key} is manual-only but has no QBO UI navigation guidance`)
    }
    if (report.evidenceStatus !== 'unverified' && report.sourceIds.length === 0) {
      throw new Error(`report ${report.key} claims evidence without a source`)
    }
    if (report.evidenceStatus !== 'unverified' && !report.lastVerified) {
      throw new Error(`report ${report.key} claims evidence without lastVerified`)
    }
    if (
      report.coverageState !== 'unknown' &&
      ['unverified', 'documented', 'static-verified'].includes(report.evidenceStatus)
    ) {
      throw new Error(`report ${report.key} claims dataset coverage without observed or manually verified evidence`)
    }
  }

  requireFields(profile, ['profileVersion', 'status', 'ownerDecision', 'publicSafeIdentity', 'calendar', 'divisions', 'realismRules', 'approvalNeeded'], 'flagship profile')
  if (profile.status !== 'proposal') {
    throw new Error('flagship profile must remain a proposal while implementation details are unresolved')
  }
  requireFields(profile.ownerDecision, ['status', 'approvedOn', 'approvedScope', 'limitations'], 'flagship profile owner decision')
  if (profile.ownerDecision.status !== 'direction-approved' || profile.ownerDecision.approvedOn !== '2026-08-09') {
    throw new Error('flagship profile must record the 2026-08-09 owner direction approval')
  }
  const expectedProfileApprovalScope = [
    'Harbour & Pine Operations Inc. public-safe fixture identity',
    '36-month Flagship planning horizon',
    'Three operating divisions: Field & Advisory Services, Supply & Workshop, and Care Plans'
  ]
  if (!Array.isArray(profile.ownerDecision.approvedScope) || JSON.stringify(profile.ownerDecision.approvedScope) !== JSON.stringify(expectedProfileApprovalScope)) {
    throw new Error('flagship profile owner decision must record only the exact approved identity, horizon, and operating shape')
  }
  if (!Array.isArray(profile.ownerDecision.limitations) || profile.ownerDecision.limitations.length === 0) {
    throw new Error('flagship profile owner decision must retain its non-live limitations')
  }
  if (!profile.ownerDecision.limitations.some((entry) => entry.includes('fiscal-year start and exact calendar'))) {
    throw new Error('flagship profile owner decision must state that the fiscal calendar remains unresolved')
  }
  if (profile.publicSafeIdentity.displayName !== 'Harbour & Pine Operations Inc.' || profile.publicSafeIdentity.legalName !== 'Harbour & Pine Operations Inc.') {
    throw new Error('flagship profile must preserve the approved public-safe business identity')
  }
  if (profile.calendar.historicalMonths !== 36) {
    throw new Error('flagship profile must preserve the accepted 36-month planning horizon')
  }
  const expectedDivisionNames = ['Field & Advisory Services', 'Supply & Workshop', 'Care Plans']
  if (!Array.isArray(profile.divisions) || JSON.stringify(profile.divisions.map((entry) => entry.name)) !== JSON.stringify(expectedDivisionNames)) {
    throw new Error('flagship profile must define the three accepted operating lines')
  }
  if (!Array.isArray(profile.approvalNeeded) || profile.approvalNeeded.length === 0) {
    throw new Error('flagship profile must keep unresolved implementation decisions explicit')
  }
  if (!profile.approvalNeeded.includes('Fiscal-year start and exact fiscal calendar')) {
    throw new Error('flagship profile must keep the unapproved fiscal calendar explicit')
  }

  requireFields(volumeProposal, ['proposalVersion', 'status', 'ownerDecision', 'sharedRules', 'profiles'], 'volume proposal')
  if (volumeProposal.status !== 'proposal') {
    throw new Error('volume profiles must remain proposals until benchmark evidence resolves the provisional limits')
  }
  requireFields(volumeProposal.ownerDecision, ['status', 'approvedOn', 'approvedPlanningTargets', 'provisionalProfiles', 'productionSchedulingAuthorized', 'limitations'], 'volume proposal owner decision')
  if (volumeProposal.ownerDecision.status !== 'approved-with-conditions' || volumeProposal.ownerDecision.approvedOn !== '2026-08-09') {
    throw new Error('volume proposal must record the 2026-08-09 conditional owner approval')
  }
  if (!Array.isArray(volumeProposal.ownerDecision.approvedPlanningTargets) || volumeProposal.ownerDecision.approvedPlanningTargets.join(',') !== 'development,flagship') {
    throw new Error('only Development and Flagship are approved planning targets')
  }
  if (!Array.isArray(volumeProposal.ownerDecision.provisionalProfiles) || volumeProposal.ownerDecision.provisionalProfiles.join(',') !== 'scale') {
    throw new Error('Scale must remain the only provisional volume profile')
  }
  if (!Array.isArray(volumeProposal.ownerDecision.limitations) || volumeProposal.ownerDecision.limitations.length === 0) {
    throw new Error('volume proposal owner decision must retain its non-live limitations')
  }
  if (volumeProposal.ownerDecision.productionSchedulingAuthorized !== false) {
    throw new Error('owner approval must not authorize Production scheduling')
  }
  if (volumeProposal.sharedRules.productionSchedulingEnabled !== false) {
    throw new Error('volume proposal must keep Production scheduling disabled')
  }
  if (volumeProposal.sharedRules.provisionalBatchPayloads > 10) {
    throw new Error('provisional batch payload budget must use the stricter published value of 10')
  }
  const volumeKeys = uniqueKeys(volumeProposal.profiles, 'volume profiles')
  for (const requiredKey of ['development', 'flagship', 'scale']) {
    if (!volumeKeys.has(requiredKey)) {
      throw new Error(`volume proposal is missing the ${requiredKey} profile`)
    }
  }
  const developmentProfile = volumeProposal.profiles.find((entry) => entry.key === 'development')
  const flagshipVolumeProfile = volumeProposal.profiles.find((entry) => entry.key === 'flagship')
  if (developmentProfile.historicalMonths !== 6 || developmentProfile.approximateHistoricalTransactions !== 420) {
    throw new Error('Development must preserve the approved 6-month, 420-transaction planning target')
  }
  if (flagshipVolumeProfile.historicalMonths !== 36 || flagshipVolumeProfile.approximateHistoricalTransactions !== 9360) {
    throw new Error('Flagship must preserve the approved 36-month, 9,360-transaction planning target')
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
  const staticUnknownCapabilities = catalog.capabilities.filter(
    (entry) =>
      entry.applicability.status === 'unknown' ||
      entry.apiSurface === 'unknown' ||
      Object.values(entry.apiOperations).includes('unknown')
  )
  const staticUnknownReports = catalog.reports.filter(
    (entry) => entry.applicability.status === 'unknown' || entry.api.status === 'unknown'
  )
  const tierOneStaticUnknown = catalog.capabilities.filter(
    (entry) =>
      entry.tier === 'tier-1' &&
      (entry.applicability.status === 'unknown' ||
        entry.apiSurface === 'unknown' ||
        Object.values(entry.apiOperations).includes('unknown'))
  )
  const operationMatrixUnknown = operationMatrix.lifecycles.reduce(
    (total, lifecycle) => total + lifecycle.entities.reduce(
      (entityTotal, entity) => entityTotal + Object.values(entity.operations).filter((status) => status === 'unknown').length,
      0
    ),
    0
  )

  if (catalog.status === 'approved' && (unknownCapabilities.length > 0 || unknownReports.length > 0)) {
    throw new Error('an approved catalog cannot contain release-blocking unknowns')
  }

  console.log(`Discovery catalog ${catalog.catalogVersion} is structurally valid.`)
  console.log(`Sources: ${sourceKeys.size}`)
  console.log(`Capabilities: ${capabilityKeys.size} (${staticUnknownCapabilities.length} static classification unknown; ${unknownCapabilities.length} release blockers including dataset evidence)`)
  console.log(`Tier 1 static classification unknown: ${tierOneStaticUnknown.length}`)
  console.log(`Tier 1 entity operation matrix: ${operationMatrix.lifecycles.reduce((total, lifecycle) => total + lifecycle.entities.length, 0)} exact entities; ${operationMatrixUnknown} operation questions remain (${operationMatrix.status})`)
  console.log(`Reports: ${reportKeys.size} (${staticUnknownReports.length} static classification unknown; ${unknownReports.length} release blockers including dataset evidence)`)
  console.log(`Plan-required report manifest: ${requiredReportKeys.size} linked rows`)
  console.log(`Flagship profile: ${profile.profileVersion} (${profile.status})`)
  console.log(`Volume profiles: ${volumeKeys.size} (${volumeProposal.status})`)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
