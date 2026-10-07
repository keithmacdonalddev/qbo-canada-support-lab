import { useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Button } from '@/components/ui/button'
import { typeLabel } from '@/lib/records'

const money = cents => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100)
function amountLabel(details) {
  if (details.baseAmountCents !== null) return money(details.baseAmountCents)
  if (details.amountRule === 'time_only') return details.hours + ' hours'
  return 'Uses saved originating total'
}
function todayInHalifax() {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]))
  return fields.year + '-' + fields.month + '-' + fields.day
}
export default function BusinessActivityPreview({ view }) {
  return <PreviewContent key={[view.realmId, view.environment, view.connectionId, view.draft?.contentHash].join(':')} view={view} />
}
function PreviewContent({ view }) {
  const source = view.draft || view.proposal
  const today = todayInHalifax()
  const [fromDate, setFromDate] = useState(source.business.openingDate > today.slice(0, 8) + '01' ? source.business.openingDate : today.slice(0, 8) + '01')
  const [throughDate, setThroughDate] = useState(today)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [operation, setOperation] = useState(null)
  const [preparing, setPreparing] = useState(false)
  const [operationError, setOperationError] = useState('')
  const preparation = useRef(null)
  const active = useRef(null)
  useEffect(() => () => { active.current?.abort(); preparation.current?.abort() }, [])
  function change(setter, value) { preparation.current?.abort(); setOperation(null); setOperationError(''); setPreparing(false); active.current?.abort(); setter(value); setResult(null); setError(''); setLoading(false); setPage(0) }
  async function preview() {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setLoading(true); setResult(null); setError(''); setPage(0)
    const body = { connectionId: view.connectionId, baseHash: view.draft?.contentHash || null, fromDate, throughDate }
    try {
      const response = await client.post('/company/business-plan/activity-preview', body, { signal: controller.signal })
      if (controller.signal.aborted) return
      const data = response.data?.data
      if (data?.scope?.realmId !== view.realmId || data?.scope?.environment !== view.environment || data?.connectionId !== view.connectionId || data?.source?.blueprintHash !== body.baseHash) throw new Error('Company or plan changed')
      setResult(data)
    } catch (error) { if (!controller.signal.aborted) setError(error.response?.data?.error || 'The activity preview could not be prepared. Reload the business plan and try again.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  async function prepare() {
    preparation.current?.abort()
    const controller = new AbortController(); preparation.current = controller
    setPreparing(true); setOperation(null); setOperationError('')
    const body = { connectionId: view.connectionId, baseHash: view.draft?.contentHash || null, fromDate, throughDate }
    try {
      const response = await client.post('/company/business-plan/operation-preview', body, { signal: controller.signal })
      if (controller.signal.aborted) return
      const data = response.data?.data
      if (data?.scope?.realmId !== view.realmId || data?.scope?.environment !== view.environment || data?.scope?.connectionId !== view.connectionId || data?.blueprintHash !== body.baseHash || data?.fromDate !== fromDate || data?.throughDate !== throughDate) throw new Error('Company or plan changed')
      setOperation(data)
    } catch (error) { if (!controller.signal.aborted) setOperationError(typeof error.response?.data?.error === 'string' ? error.response.data.error : 'The operation could not be prepared. Reload the plan and try again.') }
    finally { if (!controller.signal.aborted) setPreparing(false) }
  }
  return <section aria-label="Business activity preview" className="space-y-3 border-t border-[var(--line)] pt-3">
    <div><h3 className="font-medium text-[var(--ink)]">Preview business activity</h3><p className="mt-1 text-[12px]">See dated service jobs, stock purchases and care-plan billing. Uses {view.draft ? 'saved draft v' + view.draft.version : 'the proposed business'}, including its history start and volume. Unsaved edits are not included.</p></div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-[12px]">From<input aria-label="Activity from date" type="date" value={fromDate} onChange={event => change(setFromDate, event.target.value)} className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1" /></label>
      <label className="grid gap-1 text-[12px]">Through<input aria-label="Activity through date" type="date" value={throughDate} onChange={event => change(setThroughDate, event.target.value)} className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1" /></label>
      <Button type="button" size="sm" variant="outline" onClick={preview} disabled={loading}>{loading ? 'Preparing preview…' : 'Preview activity'}</Button>
    </div>
    <div className="space-y-2"><Button type="button" size="sm" variant="outline" onClick={prepare} disabled={preparing}>{preparing ? 'Checking operation requirements…' : 'Prepare operation'}</Button><p className="text-[12px]">Reads current company setup and connects it to these dates. Limit: 31 days and 500 steps. Preparation does not create records.</p></div>
    {operationError && <p role="alert" className="text-[var(--attention)]">{operationError}</p>}
    {operation && <section aria-label="Prepared business operation" className="space-y-3 rounded border border-[var(--line)] p-3">
      <p role="status" className="font-medium text-[var(--ink)]">{operation.summary.steps} planned steps · {operation.summary.blockedSteps} with unresolved requirements</p>
      <p className="text-[12px]">{operation.summary.unresolvedReferences} record choices unresolved · {operation.earlierRequirements.length} earlier transactions need evidence. No operation has been saved or started.</p>
      <details><summary className="cursor-pointer text-[12px]">Why steps cannot run yet</summary><ul className="mt-2 list-disc space-y-2 pl-5 text-[12px]">{[...new Map(operation.steps.flatMap(step => step.blockers).filter(blocker => blocker.kind === 'record_choice').map(blocker => [blocker.key, blocker])).values()].map(blocker => <li key={blocker.key}><strong>{blocker.key}</strong>: {blocker.reason}</li>)}</ul></details>
      <ul className="list-disc space-y-1 pl-5 text-[12px]">{operation.remaining.map(item => <li key={item.key}>{item.reason}</li>)}</ul>
      <p className="text-[12px] text-[var(--ink-3)]">Prepared {new Date(operation.preparedAt).toLocaleString()}. Existing activity still needs comparison before anything can be created.</p>
    </section>}
    {error && <p role="alert" className="text-[var(--attention)]">{error}</p>}
    {result && <div className="space-y-3">
      <p role="status" className="text-[var(--ink)]">{result.events.length} scheduled records · {result.future.length} later follow-ups · {result.prerequisites.length} earlier prerequisites</p>
      <p className="text-[12px]">The full-month planning target is {result.monthlyTarget} records. Opening periods and partial months can differ because follow-ups fall in later periods. No company records have been changed.</p>
      <details><summary className="cursor-pointer text-[var(--ink)]">Scheduled records by date</summary>
        <div className="mt-2 overflow-x-auto rounded-md border border-[var(--line)]"><table className="w-full text-left text-[12px]"><thead className="bg-[var(--surface-muted)]"><tr><th className="p-2 font-medium">Date</th><th className="p-2 font-medium">Record</th><th className="p-2 font-medium">Activity</th><th className="p-2 font-medium">Before tax / settlement</th><th className="p-2 font-medium">Earlier steps</th></tr></thead><tbody>
          {result.events.slice(page * 50, (page + 1) * 50).map(event => <tr key={event.logicalKey} className="border-t border-[var(--line)]"><td className="whitespace-nowrap p-2">{event.txnDate}</td><td className="p-2">{typeLabel(event.entity)}</td><td className="p-2">{event.intent.purpose}<span className="ml-1 text-[var(--ink-3)]">· {event.ruleKey}</span></td><td className="p-2"><span>{amountLabel(result.detailProposal.byLogicalKey[event.logicalKey].details)}</span>{result.detailProposal.byLogicalKey[event.logicalKey].details.lines.map(line => <p key={line.key} className="mt-1 text-[var(--ink-3)]">{line.quantity} {line.unit} × {money(line.unitPriceCents)} · {line.itemKey}</p>)}</td><td className="p-2">{event.dependsOn.length}</td></tr>)}
        </tbody></table></div>
        {!result.events.length ? <p className="mt-2">No activities fall in this period.</p> : <div className="mt-2 flex items-center justify-between"><span className="text-[12px]">Showing {page * 50 + 1}–{Math.min((page + 1) * 50, result.events.length)} of {result.events.length}</span><div className="flex gap-2"><Button size="xs" variant="ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous activities</Button><Button size="xs" variant="ghost" disabled={(page + 1) * 50 >= result.events.length} onClick={() => setPage(value => value + 1)}>Next activities</Button></div></div>}
      </details>
      <details><summary className="cursor-pointer text-[var(--ink)]">Proposed amounts and assumptions</summary><div className="mt-2 space-y-3">
        <p className="text-[12px]">Illustrative business amounts, before tax. These are not QuickBooks totals or approved transaction details.</p>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{Object.entries(result.detailProposal.byEntity).map(([entity, total]) => <div key={entity} className="rounded border border-[var(--line)] p-2 text-[12px]"><p className="font-medium">{typeLabel(entity)} · {total.count}</p><p>{total.unresolvedTotals === total.count ? 'Amount depends on saved records or time only' : money(total.beforeTaxCents) + ' before tax'}</p></div>)}</div>
        <ul className="list-disc space-y-1 pl-5 text-[12px]">{result.detailProposal.assumptions.map(item => <li key={item}>{item}</li>)}</ul>
      </div></details>
      <ul className="list-disc space-y-1 pl-5 text-[12px]">{result.limitations.map(item => <li key={item}>{item}</li>)}</ul>
    </div>}
  </section>
}
