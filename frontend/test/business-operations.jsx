import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BusinessOperationsPanel } from '../src/components/BusinessOperations'
import '../src/index.css'

const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) }
function fixtureApi(scenario, setCalls) {
    const statuses = ['approved', 'running', 'blocked', 'awaiting-evidence', 'verified', 'stopped', 'previewed']
    let requested = false, stopped = false
    const receipts = new Map()
    const rows = Array.from({ length: 23 }, (_, index) => ({ operationId: (index + 1).toString(16).padStart(24, '0'), planHash: 'b'.repeat(64), status: statuses[index % statuses.length], fromDate: '2026-10-01', throughDate: '2026-10-06', recordCount: 120, completedRecords: index % 7 === 4 ? 120 : index * 3, execution: { pending: index % 7 === 1, requestedAt: '2026-10-06T12:00:00Z', result: index % 7 === 2 ? { error: 'A saved record needs fresh verification.' } : null } }))
    const permissions = scenario === 'readonly' ? { execute: false, stop: false } : { execute: true, stop: true }
    return {
      async get(path, options = {}) {
        if (scenario === 'loading') return new Promise(() => {})
        if (scenario === 'error') throw { response: { status: 409, data: { error: 'Operation storage has not been prepared.' } } }
        if (scenario === 'stale' && requested) throw new Error('Fixture read unavailable')
        const actualScope = scenario === 'scope-change' ? { ...scope, realmId: '456' } : scope
        if (path === '/business-operations') {
          const offset = options.params?.after ? 20 : 0, page = scenario === 'empty' ? [] : rows.slice(offset, offset + 20)
          return { data: { data: { scope: actualScope, permissions, operations: page, next: offset === 0 && page.length ? rows[19].operationId : null } } }
        }
        const row = rows.find(value => path.endsWith(value.operationId))
        if (!row) throw new Error('Unknown fixture operation')
        return { data: { data: { ...row, scope: actualScope, permissions, nextOrdinal: row.completedRecords, stopRequested: row.status === 'stopped', unresolved: row.status === 'blocked' ? { logicalKey: 'c'.repeat(64) } : null, completion: row.status === 'verified' ? { evidenceHash: 'd'.repeat(64), throughDate: row.throughDate } : null } } }
      },
      async post(path, body) {
        setCalls(value => value + 1); requested = true; stopped = path.endsWith('/stop')
        const operationId = path.split('/')[2]
        if (!stopped && receipts.has(body.requestKey)) return { data: { data: { ...receipts.get(body.requestKey), reused: true } } }
        const row = rows.find(value => value.operationId === operationId)
        const lostSettled = scenario === 'settled-retry' && receipts.size === 0 && !stopped
        if (row) { row.status = lostSettled ? 'blocked' : stopped ? 'stopped' : 'running'; row.execution = { pending: !stopped && !lostSettled } }
        const result = { operationId, accepted: !stopped, stopRequested: stopped, execution: { pending: !stopped && !lostSettled } }
        if (!stopped) receipts.set(body.requestKey, structuredClone(result))
        if (scenario === 'uncertain' || lostSettled) throw new Error('Fixture acknowledgement lost')
        return { data: { data: result } }
      },
    }
}
export function Fixture() {
  const [scenario, setScenario] = useState('normal'), [calls, setCalls] = useState(0)
  const api = useMemo(() => fixtureApi(scenario, setCalls), [scenario])
  return <main className="mx-auto max-w-[1080px] p-6 text-[var(--ink)]"><h1 className="text-xl font-semibold">Business operations — isolated review fixture</h1><p className="mt-2 text-sm">Simulated records only. No QuickBooks or database calls. Fixture requests: {calls}</p><label className="mt-4 block">Scenario <select className="rounded border border-[var(--line)] bg-[var(--surface)] p-2" value={scenario} onChange={event => { setScenario(event.target.value); setCalls(0) }}>{['normal', 'empty', 'error', 'loading', 'readonly', 'stale', 'uncertain', 'settled-retry', 'scope-change'].map(value => <option key={value}>{value}</option>)}</select></label><BusinessOperationsPanel key={scenario} api={api} realmId={scope.realmId} environment={scope.environment} enabled /></main>
}
if (import.meta.env.DEV) createRoot(document.getElementById('root')).render(<Fixture />)
