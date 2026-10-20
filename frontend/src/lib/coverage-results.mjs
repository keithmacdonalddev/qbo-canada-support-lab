import { featureState } from './coverage-features.mjs'
import { matchesScope } from './coverage-targets.mjs'

export const APP_REQUIREMENTS = new Set(['reporting.reports-api', 'administration.api-budgets', 'administration.full-pagination'])
// Explicit semantic matches only. Record-type existence is not evidence of a
// different business situation (for example overdue is not payment made late).
export const VARIANT_EVIDENCE = {
  'company.preferences': { 'Closing date': ['accounting.journals-and-close/books-closed'], 'Custom numbering': ['custom-txn-numbers'], 'Class tracking': ['class-tracking'], 'Department/location tracking': ['location-tracking'], 'Inventory tracking': ['inventory-tracking'] },
  'accounting.chart-of-accounts': { Assets: ['asset-accounts'], Liabilities: ['liability-accounts'], 'Cost of goods sold': ['cogs-accounts'], Subaccounts: ['sub-accounts'] },
  'sales.customers': { Active: ['active-customers'], Inactive: ['inactive-customer'], 'Sub-customer': ['sub-customers'], Province: ['customer-provinces'], 'Payment terms': ['customer-terms'] },
  'expenses.vendors': { Active: ['active-vendors'], Inactive: ['inactive-vendor'], 'Payment terms': ['vendor-terms'] },
  'inventory.items': { Service: ['service-items'], 'Non-inventory': ['non-inventory-items'], Inventory: ['inventory-items'], 'Bundle/group': ['bundles'], Inactive: ['inactive-item'] },
  'sales.receivables-lifecycle': { 'Partial payment': ['partly-paid-invoices'], Credit: ['credit-memos'], Refund: ['refund-receipts'], 'Unapplied payment': ['unapplied-payments'] },
  'expenses.payables-lifecycle': { 'Open bill': ['current-bills', 'overdue-bills'], 'Partial payment': ['partly-paid-bills'], 'Vendor credit': ['vendor-credits'], 'Expense/cheque': ['cheques-and-cash'] },
  'banking.cash-and-clearing': { Deposit: ['deposits'], Transfer: ['transfers'] },
  'projects.project-lifecycle': { 'Billable sales': ['project-invoices'], 'Project cost': ['project-costs'] },
  'expenses.time-activity': { Billable: ['billable-time'], Project: ['projects.project-lifecycle/project-time'] },
  'company.custom-fields': { 'Sales form': ['custom-field-values'] },
}
// A narrower positive observation can establish representation without being
// broad enough to prove absence (for example invoice text fields vs all forms).
const ABSENCE_NOT_PROVEN = new Set(['accounting.chart-of-accounts/Assets', 'accounting.chart-of-accounts/Liabilities', 'company.custom-fields/Sales form', 'projects.project-lifecycle/Billable sales', 'projects.project-lifecycle/Project cost', 'expenses.time-activity/Billable', 'expenses.payables-lifecycle/Open bill'])
export function variantResult(area, variant, snapshot) {
  const refs = VARIANT_EVIDENCE[area.key]?.[variant] || []
  const observations = refs.map(ref => {
    const slash = ref.lastIndexOf('/')
    const areaKey = slash < 0 ? area.key : ref.slice(0, slash), key = slash < 0 ? ref : ref.slice(slash + 1)
    return snapshot?.areas?.find(a => a.key === areaKey)?.signals?.find(s => s.key === key)
  })
  const found = observations.find(s => s && (['available', 'limited'].includes(featureState(s)) || (s.kind === 'setup' && s.count > 0 && !s.error && !s.blockedBy && (s.key.startsWith('active-') || ['asset-accounts', 'liability-accounts'].includes(s.key)))))
  if (found) return { name: variant, status: 'represented', observation: found, source: found.label, older: found.status === 'stale' }
  const absent = !ABSENCE_NOT_PROVEN.has(area.key + '/' + variant) && observations.length > 0 && observations.every(s => s && ['missing', 'incomplete'].includes(featureState(s)) && !s.truncated && !s.blockedBy && (s.count == null || s.count === 0))
  if (absent) return { name: variant, status: 'missing', observation: observations[0], source: observations.map(s => s.label).join(' or ') }
  return { name: variant, status: 'unverified', reason: !refs.length ? 'The current company scan does not assess this required variation.' : 'A complete qualifying observation is unavailable.' }
}
export function featureCoverage(catalog, snapshot) {
  return catalog.capabilities.filter(c => !APP_REQUIREMENTS.has(c.key)).map(area => {
    const variants = area.variants.map(name => variantResult(area, name, snapshot))
    const represented = variants.filter(v => v.status === 'represented'), missing = variants.filter(v => v.status === 'missing'), unverified = variants.filter(v => v.status === 'unverified')
    const status = represented.length === variants.length && variants.length ? 'observed' : represented.length ? 'partial' : missing.length === variants.length && variants.length ? 'missing' : missing.length ? 'gaps' : 'unverified'
    return { ...area, variants, represented, missing, unverified, status }
  })
}
export function featureTotals(rows) {
  return rows.reduce((total, row) => ({ required: total.required + row.variants.length, represented: total.represented + row.represented.length, missing: total.missing + row.missing.length, unverified: total.unverified + row.unverified.length }), { required: 0, represented: 0, missing: 0, unverified: 0 })
}
const definitionKey = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const LEVELS = ['availability', 'population', 'plausibility', 'reconciliation']
const NATIVE_RELATIONSHIPS = { BalanceSheet: ['balance-sheet', 'receivables', 'payables'], TrialBalance: ['trial-balance', 'receivables', 'payables'], AgedReceivables: ['receivables'], AgedPayables: ['payables'] }
const NATIVE_REPORT = { BalanceSheet: 'report.balance-sheet', ProfitAndLoss: 'report.profit-and-loss', TrialBalance: 'report.trial-balance', GeneralLedger: 'report.general-ledger', CashFlow: 'report.cash-flow', AgedReceivables: 'report.ar-aging', AgedPayables: 'report.ap-aging' }
export function reportCoverage(definition, manual, baselines = []) {
  const records = [], latest = new Map()
  for (const item of manual?.data?.items || []) {
    if (item.recorded !== true || item.withdrawn || item.request?.reportKey !== definition.key) continue
    const request = item.request, key = JSON.stringify([request.period, request.basis, request.filters])
    const previous = latest.get(key)
    if (!previous || item.recordedAt > previous.recordedAt) latest.set(key, item)
  }
  for (const item of latest.values()) {
    const request = item.request, levels = LEVELS.map(key => request.checks?.[key]?.status), assertions = request.assertions || []
    const failed = levels.includes('failed') || assertions.some(a => a.status === 'failed')
    const sameDefinition = definitionKey(item.definition) === definitionKey(definition)
    const verified = sameDefinition && item.definitionCurrent === true && levels.every(s => s === 'passed') && assertions.length === definition.assertions.length && assertions.every(a => a.status === 'passed')
    records.push({ id: item.id, status: failed ? 'failed' : verified ? 'verified' : levels.some(s => s === 'passed') ? 'partial' : 'unverified', period: request.period, basis: request.basis, filters: request.filters, observedAt: request.observedOn, source: 'Owner-recorded', historical: !item.definitionCurrent || !sameDefinition, checks: request.checks, assertions, note: request.source?.finding })
  }
  const nativeLatest = new Map()
  for (const baseline of baselines) {
    for (const report of baseline.evaluation?.reports || []) {
      if (NATIVE_REPORT[report.name] !== definition.key) continue
      const key = JSON.stringify([baseline.period, report.basis, report.evidenceType])
      const prior = nativeLatest.get(key)
      if (!prior || baseline.observedAt > prior.baseline.observedAt) nativeLatest.set(key, { baseline, report })
    }
  }
  for (const { baseline, report } of nativeLatest.values()) {
    const usable = report.scopeMatches === true && report.currency === 'CAD' && report.status === 'populated'
    const relationships = (baseline.evaluation.checks || []).filter(check => (NATIVE_RELATIONSHIPS[report.name] || []).includes(check.key))
    const differences = relationships.filter(check => check.status === 'failed')
    records.push({ id: baseline.id + ':' + report.name, status: differences.length ? 'failed' : usable ? 'partial' : 'unverified', period: baseline.period, basis: report.basis || 'Basis not returned', evidenceType: report.evidenceType, observedAt: baseline.observedAt, source: baseline.purpose === 'opening-balances' ? 'Opening report observation' : 'Saved report observation', checks: Object.fromEntries(relationships.map(check => [check.label, { status: check.status, note: check.reason }])), note: differences.length ? differences.map(check => check.label + ': difference found' + (check.reason ? ' — ' + check.reason : '')).join('. ') : usable ? 'Report data observed for this period. Full report requirements and reconciliation are not established.' : report.error || report.limitation || 'Report scope or populated content not confirmed.' })
  }
  const failed = records.some(r => r.status === 'failed'), verified = records.some(r => r.status === 'verified'), partial = records.some(r => r.status === 'partial')
  return { ...definition, records: records.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt))), status: failed ? 'failed' : verified ? 'verified' : partial ? 'partial' : 'unverified', hasVerifiedScope: verified, manualState: manual?.state || 'loading', historyComplete: manual?.data?.historyComplete === true }
}
export function reportTotals(rows) {
  return Object.fromEntries(['verified', 'partial', 'failed', 'unverified'].map(key => [key, rows.filter(r => r.status === key).length]))
}
function addMonths(day, count) {
  const [y, m, d] = day.split('-').map(Number), end = new Date(Date.UTC(y, m - 1 + count + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1 + count, Math.min(d, end))).toISOString().slice(0, 10)
}
export function historyCoverage(plan, governance) {
  if (governance?.state !== 'ready') return { status: 'unavailable', completed: null, required: null }
  const value = governance.data, publication = value?.published, calendar = value?.calendar
  if (!publication) return { status: 'unpublished', completed: null, required: null }
  const draft = plan?.state === 'ready' && plan.data?.draft?.connectionMatches === true ? plan.data.draft : null
  const matching = draft?.contentHash === publication.blueprintHash
  const required = matching && Number.isInteger(draft.business?.historicalMonths) ? draft.business.historicalMonths : null
  const opening = calendar?.openingDate || publication.openingDate, through = calendar?.verifiedThrough || null
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(opening || '')) return { status: 'unavailable', completed: null, required }
  const completed = through ? Array.from({ length: 1200 }, (_, i) => addMonths(opening, i + 1)).filter(next => next <= new Date(Date.parse(through + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)).length : 0
  const targetNext = required ? addMonths(opening, required) : null
  const targetThrough = targetNext ? new Date(Date.parse(targetNext + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10) : null
  return { status: calendar?.stopRequested ? 'stopped' : through ? 'started' : 'not-started', completed, required, opening, through, targetThrough, completionPending: calendar?.completionPending === true, published: true }
}
export async function readReportPages(api, definitions, scope, signal, onResult, concurrency = 4) {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, definitions.length) }, async () => {
    while (!signal.aborted && index < definitions.length) {
      const definition = definitions[index++]
      try {
        const response = await api.get('/company/report-evidence', { params: { reportKey: definition.key }, timeout: 15000, signal })
        const data = response.data?.data
        if (!matchesScope(data, scope) || data.definition?.key !== definition.key || !Array.isArray(data.items)) throw new Error('The saved report evidence does not match this company and report.')
        if (!signal.aborted) onResult(definition.key, { state: 'ready', data })
      } catch (error) { if (!signal.aborted) onResult(definition.key, { state: 'error', data: null }) }
    }
  }))
}
