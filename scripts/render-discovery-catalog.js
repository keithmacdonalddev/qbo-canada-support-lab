'use strict'

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const catalogPath = path.join(repoRoot, 'docs', 'discovery', 'catalog.v1.json')
const outputPath = path.join(repoRoot, 'docs', 'discovery', 'catalog.v1.md')

function readCatalog() {
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
}

function titleCase(value) {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function operationSummary(entry) {
  const labels = { read: 'R', create: 'C', update: 'U', delete: 'D', void: 'V' }
  return Object.entries(entry.apiOperations)
    .map(([key, value]) => `${labels[key]}:${value}`)
    .join(' · ')
}

function reportApiSummary(report) {
  if (report.api.status === 'supported') return `API: ${report.api.endpoint}`
  if (report.api.status === 'manual-only') return 'Manual product evidence'
  return titleCase(report.api.status)
}

function render() {
  const catalog = readCatalog()
  const staticUnknownCapabilities = catalog.capabilities.filter(
    (entry) =>
      entry.applicability.status === 'unknown' ||
      entry.apiSurface === 'unknown' ||
      Object.values(entry.apiOperations).includes('unknown')
  )
  const datasetUnknownCapabilities = catalog.capabilities.filter(
    (entry) => entry.coverageState === 'unknown'
  )
  const staticUnknownReports = catalog.reports.filter(
    (entry) => entry.applicability.status === 'unknown' || entry.api.status === 'unknown'
  )
  const datasetUnknownReports = catalog.reports.filter(
    (entry) => entry.coverageState === 'unknown'
  )
  const tierOne = catalog.capabilities.filter((entry) => entry.tier === 'tier-1')
  const tierOneStaticUnknown = tierOne.filter(
    (entry) =>
      entry.applicability.status === 'unknown' ||
      entry.apiSurface === 'unknown' ||
      Object.values(entry.apiOperations).includes('unknown')
  )

  const lines = [
    '# Test Data Lab Capability and Report Catalog',
    '',
    `**Catalog:** ${catalog.catalogVersion}`,
    `**Status:** ${titleCase(catalog.status)}`,
    `**As of:** ${catalog.asOfDate}`,
    '**Authority:** `catalog.v1.json` validated by `registry.schema.v1.json`',
    '',
    'This is a human-readable view of the versioned JSON catalog. Run `npm run render:discovery` after catalog changes.',
    '',
    '## Practical status',
    '',
    `- ${tierOne.length} Tier 1 capabilities; ${tierOneStaticUnknown.length} still have a product/API classification unknown.`,
    `- ${catalog.capabilities.length} total capabilities; ${datasetUnknownCapabilities.length} still need flagship-dataset evidence.`,
    `- ${catalog.reports.length} reports; ${staticUnknownReports.length} still have a product/API classification unknown and ${datasetUnknownReports.length} still need dataset/report evidence.`,
    '- Unknown dataset coverage is intentional until a fixture, sandbox, or approved connected-company observation proves it.',
    '- Production scheduling and discovery mutations remain disabled.',
    '',
    '## Capabilities',
    '',
    '| Key | Tier | Product | API surface and operations | App | Dataset |',
    '| --- | --- | --- | --- | --- | --- |'
  ]

  for (const capability of catalog.capabilities) {
    lines.push(
      `| \`${capability.key}\` | ${titleCase(capability.tier)} | ${titleCase(capability.applicability.status)} | ${titleCase(capability.apiSurface)}; ${operationSummary(capability)} | ${titleCase(capability.currentAppStatus)} | ${titleCase(capability.coverageState)} |`
    )
  }

  lines.push(
    '',
    'Operation abbreviations are Read, Create, Update, Delete, and Void. `Conditional` means the operation varies by entity, entitlement, preference, locale, or record state and must be resolved at the operation boundary.',
    '',
    '## Reports',
    '',
    '| Key | Tier | Family | Product | Retrieval | Dataset |',
    '| --- | --- | --- | --- | --- | --- |'
  )

  for (const report of catalog.reports) {
    lines.push(
      `| \`${report.key}\` | ${titleCase(report.tier)} | ${titleCase(report.family)} | ${titleCase(report.applicability.status)} | ${reportApiSummary(report)} | ${titleCase(report.coverageState)} |`
    )
  }

  lines.push('', '## Remaining static classification queue', '')
  if (staticUnknownCapabilities.length === 0 && staticUnknownReports.length === 0) {
    lines.push('- No Tier 1 product/API unknown is being hidden. Remaining static unknowns, if any, are listed below by capability.')
  }
  for (const capability of staticUnknownCapabilities) {
    lines.push(`- \`${capability.key}\`: ${capability.limitations.join(' ')}`)
  }
  for (const report of staticUnknownReports) {
    lines.push(`- \`${report.key}\`: ${report.knownDiscrepancies.join(' ') || report.applicability.notes}`)
  }

  lines.push(
    '',
    '## Dataset and live evidence queue',
    '',
    '- Observe current connected-company preferences, entitlements, dimensions, custom fields, Projects, time/payroll availability, and report availability only after a read-only target is explicitly approved.',
    '- Run pagination and rate/latency benchmarks only against an explicitly approved sandbox or read-only target.',
    '- Run uncertain writes only as separately approved sandbox spikes with exact budgets and cleanup/compensation notes.',
    '- Keep Canadian tax and accounting fixtures behind current authoritative research and accounting review.',
    '- Keep Production scheduling and automatic mutations disabled.',
    '',
    '## Official sources',
    ''
  )

  for (const source of catalog.sources) {
    lines.push(`- [${source.title}](${source.url}) — ${source.publisher}; accessed ${source.accessedOn}. ${source.notes || ''}`)
  }

  lines.push(
    '',
    '## Related artifacts',
    '',
    '- `official-surface-classification.v1.md` — product/API/manual conclusions and remaining unknowns.',
    '- `report-dependency-map.v1.md` — report prerequisites and relationship assertions.',
    '- `flagship-business-profile.v1.json` — proposed coherent business identity and rules.',
    '- `volume-profiles.v1.json` — Development, Flagship, and Scale proposals.',
    '',
    'No live QBO call, OAuth flow, database write, or server startup is required to render this summary.',
    ''
  )

  const output = `${lines.map((line) => line.trimEnd()).join('\n')}\n`.replace(/\n+$/, '\n')
  fs.writeFileSync(outputPath, output, 'utf8')
  console.log(`Rendered ${path.relative(repoRoot, outputPath)} from ${path.relative(repoRoot, catalogPath)}.`)
}

render()
