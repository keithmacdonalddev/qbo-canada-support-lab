'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const repoRoot = path.resolve(__dirname, '../../..')
const discoveryRoot = path.join(repoRoot, 'docs', 'discovery')

const DEFINITION_FILES = Object.freeze({
  catalog: 'catalog.v1.json',
  operationMatrix: 'entity-operation-matrix.v1.json',
  flagshipProfile: 'flagship-business-profile.v1.json',
  volumeProfiles: 'volume-profiles.v1.json',
})

function readDefinition(fileName) {
  const filePath = path.join(discoveryRoot, fileName)
  const raw = fs.readFileSync(filePath, 'utf8')
  return {
    value: JSON.parse(raw),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  }
}

function getStaticUnknownCounts(catalog) {
  const capabilities = catalog.capabilities.filter(
    (entry) =>
      entry.applicability.status === 'unknown' ||
      entry.apiSurface === 'unknown' ||
      Object.values(entry.apiOperations).includes('unknown')
  )
  const tierOne = capabilities.filter((entry) => entry.tier === 'tier-1')
  const reports = catalog.reports.filter(
    (entry) => entry.applicability.status === 'unknown' || entry.api.status === 'unknown'
  )
  return { capabilities: capabilities.length, tierOne: tierOne.length, reports: reports.length }
}

function createDefinitionsService() {
  const definitions = Object.fromEntries(
    Object.entries(DEFINITION_FILES).map(([key, fileName]) => [key, readDefinition(fileName)])
  )
  const catalog = definitions.catalog.value

  function paginate(records, { offset = 0, limit = 50 }) {
    return {
      items: records.slice(offset, offset + limit),
      total: records.length,
      offset,
      limit,
    }
  }

  return {
    getSummary() {
      const staticUnknown = getStaticUnknownCounts(catalog)
      return {
        catalogVersion: catalog.catalogVersion,
        catalogStatus: catalog.status,
        asOfDate: catalog.asOfDate,
        counts: {
          sources: catalog.sources.length,
          capabilities: catalog.capabilities.length,
          reports: catalog.reports.length,
          staticUnknown,
          capabilityCoverageUnknown: catalog.capabilities.filter((entry) => entry.coverageState === 'unknown').length,
          reportCoverageUnknown: catalog.reports.filter((entry) => entry.coverageState === 'unknown').length,
        },
        hashes: Object.fromEntries(
          Object.entries(definitions).map(([key, definition]) => [key, definition.sha256])
        ),
      }
    },

    listCapabilities(filters) {
      let records = catalog.capabilities
      if (filters.domain) records = records.filter((entry) => entry.domain === filters.domain)
      if (filters.tier) records = records.filter((entry) => entry.tier === filters.tier)
      if (filters.coverageState) records = records.filter((entry) => entry.coverageState === filters.coverageState)
      return paginate(records, filters)
    },

    listReports(filters) {
      let records = catalog.reports
      if (filters.family) records = records.filter((entry) => entry.family === filters.family)
      if (filters.tier) records = records.filter((entry) => entry.tier === filters.tier)
      if (filters.coverageState) records = records.filter((entry) => entry.coverageState === filters.coverageState)
      if (filters.apiStatus) records = records.filter((entry) => entry.api.status === filters.apiStatus)
      return paginate(records, filters)
    },

    getOperationMatrix() {
      return definitions.operationMatrix.value
    },

    getFlagshipProfile() {
      return definitions.flagshipProfile.value
    },

    getVolumeProfiles() {
      return definitions.volumeProfiles.value
    },
  }
}

module.exports = { createDefinitionsService, getStaticUnknownCounts }
