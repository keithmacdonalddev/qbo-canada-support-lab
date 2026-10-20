import { featureGroup, featureName } from './coverage-features.mjs'

// Editorial grouping only. Requirements and report definitions remain catalog-owned.
export const TARGET_GROUPS = [
  { key: 'sales', name: 'Customers & sales', keys: ['sales.customers', 'sales.receivables-lifecycle'], outcome: 'Estimates through invoicing, collection, credits and refunds', examples: 'Customer hierarchy · full, partial and late payment · unapplied cash · voids' },
  { key: 'purchasing', name: 'Purchases & suppliers', keys: ['expenses.vendors', 'expenses.payables-lifecycle'], outcome: 'Purchasing through bills, payment and supplier credits', examples: 'Supplier terms · open and partly paid bills · inventory purchases · voids' },
  { key: 'inventory', name: 'Products & inventory', keys: ['inventory.items'], outcome: 'Stock and service activity with explainable quantities and value', examples: 'Inventory · services · non-inventory items · bundles · taxable and zero-rated sales' },
  { key: 'banking', name: 'Cash & reconciliation', keys: ['banking.cash-and-clearing', 'accounting.reconciliation'], outcome: 'Cash movement that agrees to bank and credit-card statements', examples: 'Deposits · transfers · outstanding items · statement periods · zero-difference reconciliation' },
  { key: 'tax', name: 'Canadian sales tax', keys: ['tax.canadian-sales-tax'], outcome: 'Sales and purchase tax that can be explained and reconciled', examples: 'GST/HST/PST · exempt and zero-rated activity · multi-province treatment, subject to verified tax rules' },
  { key: 'projects', name: 'Projects & labour', keys: ['projects.project-lifecycle', 'expenses.time-activity'], outcome: 'Jobs with related revenue, costs, time and profitability', examples: 'Active and completed projects · estimates · billable and non-billable time · budgets' },
  { key: 'books', name: 'Books & period close', keys: ['accounting.chart-of-accounts', 'accounting.journals-and-close', 'accounting.budgets', 'accounting.recurring-transactions', 'accounting.payroll-summary'], outcome: 'Coherent financial statements across historical and ongoing periods', examples: 'Accruals · reversals · depreciation · budgets · recurring templates · payroll summaries · closing controls' },
  { key: 'company', name: 'Company & Advanced setup', keys: ['company.preferences', 'company.dimensions', 'company.multicurrency', 'company.custom-fields'], outcome: 'A configured company with useful reporting dimensions and variations', examples: 'Fiscal settings · classes and locations · foreign currency and exchange effects · enhanced custom fields' },
  { key: 'access', name: 'People & supporting documents', keys: ['users.qbo-company-roles', 'administration.attachments'], outcome: 'Inspect roles and supporting records within their actual permissions', examples: 'Company roles · custom access · time-only access when entitled · attachments and notes' },
  { key: 'operations', name: 'App operating requirements', keys: ['reporting.reports-api', 'administration.api-budgets', 'administration.full-pagination'], outcome: 'Reliable inspection and controlled operations at the tested scale', examples: 'Complete pagination · API limits and retries · normalized report evidence', internal: true },
]
export const UNMAPPED_ADVANCED = ['Custom report builder', 'Batch invoices and expenses', 'Excel sync', 'Workflow automation', 'Revenue recognition', 'Backup and restore']
export const RELEASE_TARGETS = [
  ['100%', 'Relevant capabilities explicitly classified'],
  ['100%', 'Tier 1 covered, or manual-only with evidence'],
  ['≥85%', 'In-scope API capabilities covered; approved exceptions'],
  ['100%', 'Critical reports covered'],
  ['≥80%', 'Other in-scope reports covered; approved exclusions'],
]
export function targetGroups(catalog) {
  return TARGET_GROUPS.map(group => ({ ...group, capabilities: group.keys.map(key => catalog.capabilities.find(c => c.key === key)).filter(Boolean) }))
}
export function recordEvidence(result, keys) {
  const areas = (result?.areas || []).filter(a => keys.includes(a.key))
  const signals = areas.flatMap(a => a.signals || [])
  return {
    available: signals.filter(s => featureGroup(s) === 'available').map(featureName),
    missing: signals.filter(s => featureGroup(s) === 'missing').map(featureName),
    unresolved: signals.filter(s => featureGroup(s) === 'verification').map(featureName),
    observed: signals.length > 0,
    // Presence observations never certify the target's variants or accounting evidence.
    coverageVerdict: 'unassessed',
  }
}
export function matchesScope(data, scope) {
  return Boolean(data && ['realmId', 'environment', 'connectionId'].every(k => scope[k] != null && String(data[k]) === String(scope[k])))
}
export function savedComparison(plan, governance) {
  const draft = plan?.draft?.connectionMatches === true ? plan.draft : null
  const published = governance?.published || null
  return { draft, published, draftIsPublished: Boolean(draft?.contentHash && published?.blueprintHash === draft.contentHash), calendar: governance?.calendar || null }
}
export function filterTargets(items, query, group = 'all', priority = 'all', kind = 'feature') {
  const q = query.trim().toLowerCase()
  return items.filter(item => (group === 'all' || (kind === 'report' ? item.family === group : TARGET_GROUPS.find(g => g.keys.includes(item.key))?.key === group))
    && (priority === 'all' || item.tier === priority)
    && (!q || [item.name, item.purpose, item.businessQuestion, ...(item.variants || []), ...(item.expectedNonZero || [])].join(' ').toLowerCase().includes(q)))
}
