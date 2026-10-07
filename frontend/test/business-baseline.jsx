import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BusinessBaselinePanel } from '../src/components/BusinessBaseline'
import '../src/index.css'
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24)
const blueprint = { id: 'c'.repeat(24), contentHash: 'd'.repeat(64), openingDate: '2026-10-01', version: 2 }
const inventory = { sourceHash: '9'.repeat(64), version: 1, status: 'matching-scans', count: 1068, coverage: ['Customer', 'Invoice', 'Vendor', 'Bill'], startedAt: '2026-10-06T12:00:00Z', observedAt: '2026-10-06T12:00:04Z', entities: [{ entity: 'Customer', count: 54, active: 49, inactive: 5 }, { entity: 'Invoice', count: 1000, earliestDate: '2023-09-01', latestDate: '2026-10-06' }, { entity: 'Vendor', count: 14, active: 14, inactive: 0 }, { entity: 'Bill', count: 0, earliestDate: null, latestDate: null }], limitation: 'Fixture: matching scans are not an atomic snapshot or ownership proof.' }
const inventoryTypes = ['Customer', 'Invoice', 'Payment', 'CreditMemo', 'Bill', 'BillPayment', 'VendorCredit', 'Vendor', 'Item', 'Account', 'JournalEntry', 'Estimate', 'Deposit', 'SalesReceipt', 'RefundReceipt', 'Purchase', 'PurchaseOrder', 'Transfer', 'TimeActivity']
inventory.coverage = inventoryTypes
inventory.entities = inventoryTypes.map(entity => inventory.entities.find(row => row.entity === entity) || (['Item', 'Account'].includes(entity) ? { entity, count: 0, active: 0, inactive: 0 } : { entity, count: 0, earliestDate: null, latestDate: null }))
function fixture(scenario, count) {
  const requests = new Map(), storage = new Map()
  let failed = false
  const rows = scenario === 'empty' ? [] : Array.from({ length: 12 }, (_, index) => ({ id: (index + 1).toString(16).padStart(24, '0'), scope, blueprint, inventory: index === 0 ? inventory : 'unverified', purpose: 'company-survey', period: { fromDate: '2026-10-01', throughDate: '2026-10-06' }, observedAt: '2026-10-06T12:00:00Z', status: 'captured', accepted: false, activated: false, persisted: true, evidenceHash: 'e'.repeat(64), evaluation: { checks: [{ key: 'trial-balance', label: 'Trial balance debits and credits', status: 'passed' }, { key: 'receivables', label: 'Accounts receivable compared with customer balances', status: 'failed', reason: 'A difference of 50 CAD remains.' }] }, limitation: 'Separate report requests are not an atomic historical inventory. Record ownership, realistic balances and complete business activity remain unverified.' }))
  return { storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, api: {
    async get(path, options = {}) {
      if (scenario === 'loading') return new Promise(() => {})
      if (scenario === 'error') throw { response: { status: 409, data: { code: 'BUSINESS_STORAGE_UNPREPARED' } } }
      const actualScope = scenario === 'scope-change' ? { ...scope, realmId: '456' } : scope
      if (path === '/company/business-baseline') { const offset = options.params?.after ? 10 : 0; return { data: { data: { scope: actualScope, blueprint: scenario === 'no-plan' ? null : blueprint, canCapture: !['readonly', 'no-plan'].includes(scenario), records: rows.slice(offset, offset + 10), next: !offset && rows.length > 10 ? 'next' : null } } } }
      const inventoryPath = /^\/company\/business-baseline\/([a-f0-9]{24})\/inventory(?:\/(\w+)\/(\d+))?$/.exec(path)
      if (inventoryPath) {
        const baseline = rows.find(row => row.id === inventoryPath[1]), entity = inventoryPath[2] || options.params.entity
        const summary = inventory.entities.find(row => row.entity === entity), offset = Number(options.params?.after || 0)
        const captured = Array.from({ length: summary.count }, (_, index) => ({ id: String(index + 1), syncToken: '1', ...(summary.active !== undefined ? { active: index < summary.active } : { transactionDate: summary.earliestDate }) }))
        const identity = { scope: scenario === 'review-scope-change' ? { ...scope, realmId: '456' } : scope, baselineId: baseline.id, evidenceHash: baseline.evidenceHash, inventoryHash: inventory.sourceHash, entity }
        if (!inventoryPath[2]) return { data: { data: { ...identity, records: captured.slice(offset, offset + 20), total: captured.length, next: offset + 20 < captured.length ? String(offset + 20) : null, observedAt: inventory.observedAt, ownership: 'unclassified', currentVerified: false } } }
        if (scenario === 'review-loading') return new Promise(() => {})
        if (scenario === 'review-error') throw new Error('Fixture QuickBooks record read failed. Try the comparison again.')
        const row = captured.find(value => value.id === inventoryPath[3]), comparison = scenario === 'review-missing' ? 'not-returned' : scenario === 'review-content' ? 'different-content' : scenario === 'review-version' ? 'different-version' : 'matches'
        return { data: { data: { ...identity, id: row.id, captured: { ...row, observedAt: inventory.observedAt }, current: comparison === 'not-returned' ? null : { ...row, syncToken: comparison === 'different-version' ? '2' : row.syncToken, observedAt: '2026-10-06T13:00:00Z' }, comparison, checkedAt: '2026-10-06T13:00:00Z', ownership: 'unclassified', writeAllowed: false,
          origin: scenario === 'review-history-error' ? { complete: false, status: 'unavailable', sources: [] } : { complete: true, status: 'recorded', sources: [{ kind: 'support_case', sourceId: '8'.repeat(24), scope: 'recorded_environment', caseId: '7'.repeat(24) }] }, limitation: 'Fixture comparison: this does not establish continuing-business membership or authorize changes.' } } }
      }
      return { data: { data: rows.find(row => path.endsWith(row.id)) } }
    },
    async post(_path, input) {
      count(value => value + 1)
      if (scenario === 'rejected' && !failed) { failed = true; throw { response: { status: 400, data: { code: 'BUSINESS_BASELINE_REQUEST_INVALID', notSaved: true, error: 'Choose an elapsed report period of at most one year.' } } } }
      if (!requests.has(input.requestKey)) requests.set(input.requestKey, { id: 'f'.repeat(24), inventory, scope, blueprint: { id: input.blueprintId, contentHash: input.blueprintHash }, purpose: input.purpose, period: { fromDate: input.fromDate, throughDate: input.throughDate }, observedAt: '2026-10-06T12:00:00Z', status: 'captured', accepted: false, activated: false, persisted: true, evidenceHash: 'e'.repeat(64), evaluation: { checks: [{ key: 'trial-balance', label: 'Trial balance debits and credits', status: 'passed' }] }, limitation: 'This saved observation does not establish accepted opening balances or complete business records.' })
      if (scenario === 'uncertain' && !failed) { failed = true; throw new Error('Fixture response lost. Retry the saved request.') }
      const result = requests.get(input.requestKey); if (!rows.some(row => row.id === result.id)) rows.unshift(result)
      return { data: { data: result } }
    },
  } }
}
export function Fixture() {
  const [scenario, setScenario] = useState('normal'), [calls, setCalls] = useState(0)
  const data = useMemo(() => fixture(scenario, setCalls), [scenario])
  return <main className="mx-auto max-w-[1080px] p-6 text-[var(--ink)]"><h1 className="text-xl font-semibold">Saved observations — isolated review fixture</h1><p className="mt-2 text-sm">Simulated records only. No QuickBooks or database calls. Fixture requests: {calls}</p><label className="mt-4 block">Scenario <select className="rounded border border-[var(--line)] bg-[var(--surface)] p-2" value={scenario} onChange={event => { setScenario(event.target.value); setCalls(0) }}>{['normal', 'empty', 'error', 'loading', 'readonly', 'no-plan', 'uncertain', 'rejected', 'scope-change', 'review-error', 'review-missing', 'review-content', 'review-version', 'review-history-error', 'review-scope-change', 'review-loading'].map(value => <option key={value}>{value}</option>)}</select></label><BusinessBaselinePanel key={scenario} {...data} realmId={scope.realmId} environment={scope.environment} actorId={actorId} enabled /></main>
}
if (import.meta.env.DEV) createRoot(document.getElementById('root')).render(<Fixture />)
