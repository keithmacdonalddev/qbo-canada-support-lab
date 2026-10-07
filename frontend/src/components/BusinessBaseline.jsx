import { useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { Button } from './ui/button'
import BusinessInventoryReview from './BusinessInventoryReview'
import { assertBaselineScope, baselineRequestKey, pendingBaselineRequest, captureBaseline } from '../lib/business-baseline-request.mjs'

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const label = value => value === 'opening-balances' ? 'Opening balances' : 'Company survey'
const reason = error => error.response?.data?.code === 'BUSINESS_STORAGE_UNPREPARED' ? 'Observation storage needs explicit preparation before reports can be saved.' : typeof error.response?.data?.error === 'string' ? error.response.data.error : error.message || 'The observation could not be loaded.'
export default function BusinessBaseline(props) {
  const { user } = useAuth(), actorId = user?._id || user?.id
  return <BusinessBaselinePanel key={[actorId, props.realmId, props.environment, props.enabled].join(':')} {...props} actorId={actorId} />
}
export function BusinessBaselinePanel({ realmId, environment, enabled, actorId, api = client, storage = sessionStorage }) {
  const [page, setPage] = useState(null), [detail, setDetail] = useState(null), [pending, setPending] = useState(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [cursors, setCursors] = useState([null]), [purpose, setPurpose] = useState('company-survey')
  const [fromDate, setFrom] = useState(today().slice(0, 7) + '-01'), [throughDate, setThrough] = useState(today())
  const connection = useRef(null), active = useRef(true), sending = useRef(false), action = useRef(null), detailRequest = useRef(0), detailHeading = useRef(null)
  const after = cursors.at(-1)
  useEffect(() => { active.current = true; return () => { active.current = false; action.current?.abort() } }, [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController(); setLoading(true)
    api.get('/company/business-baseline', { params: { limit: 10, ...(after ? { after } : {}) }, signal: controller.signal, timeout: 15000 }).then(response => {
      if (controller.signal.aborted) return
      const value = assertBaselineScope(response.data?.data, realmId, environment, connection.current)
      if (!Array.isArray(value.records)) throw new Error('The saved observation list is incomplete.')
      connection.current = value.scope.connectionId
      const request = pendingBaselineRequest(storage, baselineRequestKey(actorId, value.scope), value.scope)
      setPage(value); setPending(request); setError('')
    }).catch(failure => { if (!controller.signal.aborted) { setError(reason(failure)); setPage(null) } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, storage, actorId, realmId, environment, enabled, after, revision])
  useEffect(() => { if (detail) detailHeading.current?.focus() }, [detail])
  async function capture() {
    if (!page?.canCapture || sending.current || loading) return
    sending.current = true; detailRequest.current++; setBusy(true); setDetail(null); setError(''); action.current = new AbortController()
    try {
      const result = await captureBaseline({ api, storage, key: baselineRequestKey(actorId, page.scope), scope: page.scope, signal: action.current.signal,
        request: { connectionId: page.scope.connectionId, blueprintId: page.blueprint.id, blueprintHash: page.blueprint.contentHash, purpose, fromDate, throughDate } })
      if (!active.current) return
      setDetail(result); setPending(null); setCursors([null]); setRevision(value => value + 1)
    } catch (failure) {
      if (active.current) { setError(reason(failure)); try { setPending(pendingBaselineRequest(storage, baselineRequestKey(actorId, page.scope), page.scope)) } catch (stored) { setError(reason(stored)) } }
    } finally { sending.current = false; if (active.current) setBusy(false) }
  }
  async function inspect(id) {
    if (sending.current) return
    const request = ++detailRequest.current; setDetail(null); setError('')
    try {
      const response = await api.get('/company/business-baseline/' + id, { timeout: 15000 })
      if (!active.current || request !== detailRequest.current) return
      const value = assertBaselineScope(response.data?.data, realmId, environment, connection.current)
      if (value.id !== id || value.accepted !== false || value.activated !== false) throw new Error('The saved observation could not be confirmed.')
      setDetail(value)
    } catch (failure) { if (active.current && request === detailRequest.current) setError(reason(failure)) }
  }
  function changePurpose(value) {
    setPurpose(value)
    if (value === 'opening-balances' && page?.blueprint?.openingDate) {
      const before = new Date(page.blueprint.openingDate + 'T12:00:00Z'); before.setUTCDate(before.getUTCDate() - 1)
      const end = before.toISOString().slice(0, 10); setFrom(end.slice(0, 4) + '-01-01'); setThrough(end)
    } else { setFrom(today().slice(0, 7) + '-01'); setThrough(today()) }
  }
  const locked = busy || Boolean(pending)
  return <section aria-label="Saved report observations" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3"><h2 className="text-[13px] font-semibold">Saved report observations</h2><Button size="sm" variant="ghost" disabled={!enabled || busy || loading} onClick={() => setRevision(value => value + 1)}>Refresh observations</Button></header>
    <div className="px-5 py-4 text-[13px]">
      <p className="text-[var(--ink-2)]">Keep five dated accounting reports, their checks, and an inventory of 19 current record types tied to the saved business plan. Saving an observation does not change QuickBooks records or approve the opening balances.</p>
      {!enabled ? <p className="mt-3">Connect a company to view its saved observations.</p> : loading ? <p role="status" className="mt-3">Loading saved observations…</p> : page && <>
        {!page.blueprint ? <p className="mt-3 text-[var(--attention)]">Save a business plan before capturing its first observation.</p> : <p className="mt-3 text-[var(--ink-2)]">Business plan version {page.blueprint.version} · Opening date {page.blueprint.openingDate}</p>}
        {page.canCapture && <div className="mt-3 flex flex-wrap items-end gap-3">
          <label>Purpose<select aria-label="Observation purpose" value={pending?.purpose || purpose} disabled={locked} onChange={event => changePurpose(event.target.value)} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2"><option value="company-survey">Company survey</option><option value="opening-balances">Opening balances</option></select></label>
          <label>From<input aria-label="Observation from date" type="date" value={pending?.fromDate || fromDate} disabled={locked} max={pending?.throughDate || throughDate} onChange={event => setFrom(event.target.value)} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
          <label>Through<input aria-label="Observation through date" type="date" value={pending?.throughDate || throughDate} disabled={locked || purpose === 'opening-balances'} min={pending?.fromDate || fromDate} max={today()} onChange={event => setThrough(event.target.value)} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
          <Button size="sm" disabled={busy || !fromDate || !throughDate || (!pending && (throughDate > today() || fromDate > throughDate))} onClick={capture}>{busy ? 'Reading and saving…' : pending ? 'Retry saved request' : 'Save report observation'}</Button>
        </div>}
        {page.blueprint && !page.canCapture && <p className="mt-3 text-[var(--ink-2)]">{page.captureBlockReason || 'You can view observations. Capturing a new one requires report and business-plan permissions.'}</p>}
        {pending && <p role="status" className="mt-3 text-[var(--attention)]">The previous save was not confirmed. Retry its exact request to recover the original result.</p>}
        {busy && <p role="status" className="mt-3">Reading five reports and checking the current record inventory twice. This can take up to three minutes; keep this page open.</p>}
        <div className="mt-4 overflow-x-auto"><table className="w-full text-left"><thead><tr className="text-[var(--ink-3)]"><th className="py-2 font-medium">Observation</th><th className="font-medium">Report dates</th><th className="font-medium">Captured</th><th><span className="sr-only">Inspect</span></th></tr></thead><tbody>{page.records.map(record => <tr key={record.id} className="border-t border-[var(--line)]"><td className="py-3">{label(record.purpose)}<span className="block text-[12px] text-[var(--ink-3)]">Saved · Not accepted</span></td><td>{record.period.fromDate} to {record.period.throughDate}</td><td>{new Date(record.observedAt).toLocaleString()}</td><td><Button size="sm" variant="ghost" disabled={busy} onClick={() => inspect(record.id)}>View checks</Button></td></tr>)}</tbody></table></div>
        {!page.records.length && <p className="mt-2 text-[var(--ink-3)]">No observations saved on this page.</p>}
        <div className="mt-2 flex gap-2">{cursors.length > 1 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCursors(values => values.slice(0, -1))}>Previous observations</Button>}{page.next && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCursors(values => [...values, page.next])}>Older observations</Button>}</div>
      </>}
      {error && <p role="alert" className="mt-3 text-[var(--danger-ink)]">{error}</p>}
      {detail && <div aria-live="polite" className="mt-4 border-t border-[var(--line)] pt-4"><h3 ref={detailHeading} tabIndex={-1} className="font-semibold">{label(detail.purpose)} saved · Not accepted</h3><p className="mt-1 text-[var(--ink-2)]">{detail.period.fromDate} through {detail.period.throughDate} · Captured {new Date(detail.observedAt).toLocaleString()}</p><ul className="mt-3 divide-y divide-[var(--line)]">{detail.evaluation.checks.map(check => <li key={check.key} className="py-2"><div className="flex justify-between gap-3"><span>{check.label}</span><span className={check.status === 'passed' ? 'text-[var(--ok)]' : 'text-[var(--attention)]'}>{check.status === 'passed' ? 'Passed' : check.status === 'failed' ? 'Difference found' : 'Not verified'}</span></div>{check.reason && <p className="mt-1 text-[var(--ink-3)]">{check.reason}</p>}</li>)}</ul>{detail.inventory?.status === 'matching-scans' ? <section aria-label="Current record inventory" className="mt-4 border-t border-[var(--line)] pt-3"><h4 className="font-semibold">Current record inventory</h4><p className="mt-1 text-[var(--ink-2)]">{detail.inventory.count.toLocaleString()} records across {detail.inventory.coverage.length} record types. Two scans agreed from {new Date(detail.inventory.startedAt).toLocaleString()} to {new Date(detail.inventory.observedAt).toLocaleString()}.</p><p className="mt-1 text-[12px] text-[var(--ink-3)]">This inventory reflects records when captured, regardless of the report dates. It does not reconstruct the opening-date records.</p><div className="mt-3 overflow-x-auto"><table className="w-full text-left"><thead><tr className="text-[var(--ink-3)]"><th className="py-2 font-medium">Record type</th><th className="font-medium">Count</th><th className="font-medium">Active / inactive or transaction dates</th></tr></thead><tbody>{detail.inventory.entities.map(row => <tr key={row.entity} className="border-t border-[var(--line)]"><td className="py-2">{row.entity.replace(/([a-z])([A-Z])/g, '$1 $2')}</td><td>{row.count.toLocaleString()}</td><td>{row.active !== undefined ? row.active + ' active / ' + row.inactive + ' inactive' : row.count ? row.earliestDate + ' to ' + row.latestDate : 'No current records returned'}</td></tr>)}</tbody></table></div><p className="mt-2 text-[12px] text-[var(--ink-3)]">{detail.inventory.limitation}</p><BusinessInventoryReview key={[detail.id, detail.evidenceHash].join(':')} baseline={detail} api={api} /></section> : <p className="mt-3 text-[var(--ink-3)]">This older observation has no saved record inventory.</p>}<p className="mt-3 text-[12px] text-[var(--ink-3)]">{detail.limitation}</p></div>}
    </div>
  </section>
}
