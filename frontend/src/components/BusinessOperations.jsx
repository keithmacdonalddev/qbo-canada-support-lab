import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { Button } from './ui/button'
import { requestBusinessOperation } from '../lib/business-operation-request.mjs'
import { assertOperationScope, operationActions, operationError, operationStatus } from '../lib/business-operation-view.mjs'

const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown date'
const pending = value => value?.execution?.pending === true
export default function BusinessOperations(props) {
  const { user } = useAuth()
  return <BusinessOperationsPanel key={[props.realmId, props.environment, props.enabled, user?._id || user?.id].join(':')} {...props} />
}

// An injected client is used only by the isolated development fixture. The app
// always uses its authenticated API client; no browser-controlled scope is sent.
export function BusinessOperationsPanel({ realmId, environment, enabled, api = client }) {
  const [page, setPage] = useState(null)
  const [cursors, setCursors] = useState([null])
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [pageError, setPageError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const mounted = useRef(false), sending = useRef(false), keys = useRef(new Map()), boundConnection = useRef(null), epoch = useRef(0), detailHeading = useRef(null), opener = useRef(null)
  const after = cursors.at(-1)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => {
    if (!enabled) return
    let timer, first = true
    const controller = new AbortController()
    async function read() {
      if (controller.signal.aborted) return
      if ((document.hidden && !first) || sending.current) { timer = setTimeout(read, 15000); return }
      first = false
      const started = epoch.current
      try {
        const response = await api.get('/business-operations', { params: { limit: 20, ...(after ? { after } : {}) }, signal: controller.signal, timeout: 12000 })
        if (controller.signal.aborted || started !== epoch.current) return
        const value = assertOperationScope(response.data?.data, realmId, environment, boundConnection.current)
        if (!Array.isArray(value.operations)) throw new Error('Incomplete operation page')
        boundConnection.current = value.scope.connectionId
        setPage(value); setPageError('')
      } catch (error) { if (!controller.signal.aborted && started === epoch.current) setPageError(operationError(error)) }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(read, 10000) } }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, after, enabled, realmId, environment, revision])

  useEffect(() => {
    if (!enabled || !selected) return
    let timer, first = true
    const controller = new AbortController()
    async function read() {
      if (controller.signal.aborted) return
      if ((document.hidden && !first) || sending.current) { timer = setTimeout(read, 10000); return }
      first = false
      const started = epoch.current
      try {
        const response = await api.get('/business-operations/' + selected, { signal: controller.signal, timeout: 12000 })
        if (controller.signal.aborted || started !== epoch.current) return
        const value = assertOperationScope(response.data?.data, realmId, environment, boundConnection.current)
        if (value.operationId !== selected) throw new Error('Operation changed')
        boundConnection.current = value.scope.connectionId
        setDetail(value); setDetailError('')
      } catch (error) { if (!controller.signal.aborted && started === epoch.current) setDetailError(operationError(error)) }
      finally { if (!controller.signal.aborted) timer = setTimeout(read, 5000) }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [api, selected, enabled, realmId, environment, revision])

  useEffect(() => { if (selected) detailHeading.current?.focus() }, [selected])

  function select(operationId, button) {
    if (sending.current) return
    opener.current = button
    setSelected(operationId); setDetail(null); setDetailError(''); setActionError(''); setNotice('')
  }
  function move(next) {
    if (sending.current) return
    setCursors(next); setPage(null); setLoading(true); setPageError('')
  }
  async function act(action) {
    const allowed = operationActions(detail, detail?.permissions, Boolean(pageError || detailError))
    if (!detail || sending.current || !allowed[action]) return
    sending.current = true; epoch.current++; setBusy(true); setActionError(''); setNotice('')
    const operationId = detail.operationId, identity = operationId + ':' + detail.planHash
    try {
      const result = action === 'execute'
        ? await requestBusinessOperation({ api, operation: detail, keys: keys.current, realmId, environment, connectionId: boundConnection.current, isCurrent: () => mounted.current })
        : (await api.post('/business-operations/' + operationId + '/stop', {}, { timeout: 20000 })).data?.data
      if (result?.operationId !== operationId || (action === 'stop' && result.stopRequested !== true)) throw new Error('Operation response could not be confirmed')
      if (!mounted.current) return
      keys.current.delete(identity)
      setNotice(action === 'stop' ? 'Stop requested. The app will account for any record already sent before stopping.' : result.accepted === false ? result.state === 'verified' ? 'This operation is already marked verified. Refreshing its saved evidence.' : 'The earlier request is confirmed. Refreshing the current operation state.' : 'Work requested. You can leave this page; the app keeps the saved progress.')
    } catch (error) {
      if (mounted.current) {
        const reason = typeof error.response?.data?.error === 'string' ? ' ' + operationError(error) : ''
        setActionError('The request could not be confirmed. Saved progress has been retained; check the refreshed state before trying again.' + reason)
      }
    } finally {
      sending.current = false
      if (mounted.current) { setBusy(false); setDetail(null); setRevision(value => value + 1) }
    }
  }
  const actions = operationActions(detail, detail?.permissions, Boolean(pageError || detailError))
  return <section aria-label="Business operations" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
      <h2 className="text-[13px] font-semibold text-[var(--ink)]">Business operations</h2>
      <Button variant="ghost" size="sm" disabled={!enabled || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw className="size-3.5" />Refresh operations</Button>
    </header>
    <div className="space-y-4 px-5 py-4 text-[13px] text-[var(--ink-2)]">
      <p>Inspect saved business activity and its verification. Operations continue on the server when you leave this page.</p>
      {!enabled ? <p>Connect the company to inspect its operations.</p> : <>
        {loading && !page && <p role="status" className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />Loading saved operations…</p>}
        {pageError && <p role="alert" className="text-[var(--attention)]">{pageError} {page ? 'Earlier progress is shown; actions are unavailable until it refreshes.' : ''}</p>}
        {page && !page.operations.length && <p>{after ? 'No more operations on this page.' : 'No saved business operations yet. Prepare and approve the business activity before running it.'}</p>}
        {page?.operations.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-[13px]">
          <caption className="sr-only">Saved operations for this company</caption>
          <thead className="border-b border-[var(--line)] text-[11px] uppercase tracking-wide text-[var(--ink-3)]"><tr><th scope="col" className="py-2 pr-4">Business period</th><th scope="col" className="p-2">Progress</th><th scope="col" className="p-2">State</th><th scope="col" className="py-2 pl-2"><span className="sr-only">Inspect</span></th></tr></thead>
          <tbody>{page.operations.map(operation => <tr key={operation.operationId} className="border-b border-[var(--line)] last:border-0">
            <td className="py-3 pr-4 text-[var(--ink)]">{date(operation.fromDate)} – {date(operation.throughDate)}</td>
            <td className="p-2 tabular">{operation.completedRecords} / {operation.recordCount} records checked</td>
            <td className="p-2">{operationStatus(operation)}</td>
            <td className="py-2 pl-2 text-right"><Button size="sm" variant="ghost" disabled={busy} aria-expanded={selected === operation.operationId} aria-controls="business-operation-detail" onClick={event => select(operation.operationId, event.currentTarget)} aria-label={'Inspect operation ' + operation.operationId.slice(-6)}>Inspect</Button></td>
          </tr>)}</tbody>
        </table></div>}
        {(cursors.length > 1 || page?.next) && <nav aria-label="Operation pages" className="flex items-center justify-between gap-3"><span>Page {cursors.length}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={cursors.length === 1 || busy || loading} onClick={() => move(cursors.slice(0, -1))}>Previous operations</Button><Button variant="outline" size="sm" disabled={!page?.next || busy || loading || Boolean(pageError)} onClick={() => move([...cursors, page.next])}>Next operations</Button></div></nav>}
        {selected && <section id="business-operation-detail" aria-label="Selected operation" className="space-y-3 rounded-lg border border-[var(--line)] bg-[var(--sunken)] p-4">
          <div className="flex items-start justify-between gap-3"><h3 ref={detailHeading} tabIndex={-1} className="font-semibold text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">{detail ? date(detail.fromDate) + ' – ' + date(detail.throughDate) : 'Operation details'}</h3><Button size="xs" variant="ghost" disabled={busy} onClick={() => { setSelected(null); setDetail(null); opener.current?.focus() }}>Close details</Button></div>
          {detailError && <p role="alert" className="text-[var(--attention)]">{detailError}</p>}
          {!detail && !detailError && <p role="status">Reading saved progress…</p>}
          {detail && <>
            <p className="font-medium text-[var(--ink)]">{operationStatus(detail)}</p>
            <p>{detail.nextOrdinal} of {detail.recordCount} records checked. A business period is complete only after its required records and reports are verified.</p>
            {detail.completion && <p className="text-[var(--ok)]">This operation has verified evidence through {date(detail.completion.throughDate)}.</p>}
            {detail.unresolved && <p className="text-[var(--attention)]">A QuickBooks request still needs its outcome checked. The app must account for that request before creating another record.</p>}
            {detail.execution?.result?.error && <p role="status" className="text-[var(--attention)]">{detail.execution.result.error}</p>}
            {pending(detail) && <p role="status">The app has a saved request to continue this work. Progress refreshes automatically.</p>}
            {!detail.permissions?.execute && <p>Your company access allows inspection. Running or stopping business operations requires execution access.</p>}
            {detail.status === 'previewed' && <p>This plan must be approved before it can run.</p>}
            {detail.status === 'stopped' && <p>This operation was stopped. Its saved records and history have been retained.</p>}
            <div className="flex flex-wrap gap-2">
              {actions.execute && <Button disabled={busy} onClick={() => act('execute')}>{busy ? 'Requesting…' : detail.status === 'approved' ? 'Run saved operation' : 'Continue saved operation'}</Button>}
              {actions.stop && <Button disabled={busy} variant="outline" onClick={() => act('stop')}>{busy ? 'Requesting…' : 'Stop operation'}</Button>}
            </div>
          </>}
          {notice && <p role="status">{notice}</p>}
          {actionError && <p role="alert" className="text-[var(--attention)]">{actionError}</p>}
        </section>}
      </>}
    </div>
  </section>
}
