import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import client from '../api/client'
import { Button } from './ui/button'
const labels = { prepared: 'Ready to add', running: 'Adding records', stopping: 'Stopping after this batch', stopped: 'Stopped', blocked: 'Needs attention', populated: 'Records added', 'populated-with-gaps': 'Records added · relationship gaps remain' }
const today = () => { const value = new Date(); return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-') }
export default function BusinessPopulation(props) { return <PopulationPanel key={[props.realmId, props.environment, props.enabled].join(':')} {...props} /> }
export function PopulationPanel({ realmId, environment, enabled, api = client }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [busy, setBusy] = useState(''), [throughDate, setThroughDate] = useState(today), [confirmed, setConfirmed] = useState(false), [revision, setRevision] = useState(0)
  const mounted = useRef(true), sending = useRef(false), connection = useRef(null), requestKey = useRef(null), epoch = useRef(0)
  const job = state?.job, counts = job?.counts, active = ['running', 'stopping'].includes(job?.status)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const scoped = value => {
    if (!value?.scope || value.scope.realmId !== realmId || value.scope.environment !== environment || (connection.current && value.scope.connectionId !== connection.current)) throw new Error('The company changed. Reload this page before adding records.')
    connection.current = value.scope.connectionId
    return value
  }
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController(); let timer
    async function poll() {
      if (controller.signal.aborted) return
      if (sending.current || document.hidden) { timer = setTimeout(poll, 5000); return }
      const started = epoch.current
      try { const response = await api.get('/business-population', { signal: controller.signal, timeout: 12000 }); if (!controller.signal.aborted && started === epoch.current) { setState(scoped(response.data?.data)); setLoadError('') } }
      catch (failure) { if (!controller.signal.aborted && started === epoch.current) setLoadError(failure.response?.data?.error || failure.message || 'Saved bulk progress could not be loaded.') }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 5000) }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer) }
    // The panel remounts when its company changes; scoped validates every response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, api, revision])
  async function act(action) {
    if (sending.current || !state?.owner) return
    sending.current = true; epoch.current++; setBusy(action); setError('')
    try {
      let response
      if (action === 'prepare') {
        if (!requestKey.current || requestKey.current.throughDate !== throughDate) requestKey.current = { throughDate, key: crypto.randomUUID() }
        response = await api.post('/business-population/prepare', { throughDate, requestKey: requestKey.current.key }, { timeout: 180000 })
      } else if (action === 'start') response = await api.post('/business-population/' + job.jobId + '/start', { manifestHash: job.manifestHash, confirmProduction: environment !== 'production' || confirmed, ...(counts.rejected ? { retryRejected: true } : {}) }, { timeout: 30000 })
      else response = await api.post('/business-population/' + job.jobId + '/stop', {}, { timeout: 30000 })
      const value = scoped(response.data?.data)
      if (mounted.current) { setState(previous => ({ ...previous, ...value })); setConfirmed(false) }
    } catch (failure) { if (mounted.current) setError(failure.response?.data?.error || 'The action could not be confirmed. Refresh saved progress before trying again.') }
    finally { sending.current = false; if (mounted.current) { setBusy(''); setRevision(value => value + 1) } }
  }
  const remaining = counts ? counts.required - counts.saved : 0
  const canStart = job && ['prepared', 'stopped', 'blocked'].includes(job.status) && (!job.batch || job.batch.unsentRecoverable === true) && counts?.unknown === 0
  return <section aria-label="Bulk business activity" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3"><h2 className="text-[13px] font-semibold text-[var(--ink)]">Bulk business activity</h2><Button variant="ghost" size="sm" disabled={!enabled || !!busy} onClick={() => { setError(''); setRevision(value => value + 1) }}><RefreshCw className="size-3.5" />Refresh progress</Button></header>
    <div className="space-y-4 px-5 py-4 text-[13px] text-[var(--ink-2)]">
      <p>Add the published business schedule through an elapsed date. The app reuses saved records and continues in the background when you leave this page.</p>
      {!enabled ? <p>Connect the company to add its business activity.</p> : <>
        {!state && !error && <p role="status">Loading saved progress…</p>}
        {(error || loadError) && <p role="alert" className="text-[var(--attention)]">{error || loadError}</p>}
        {job && <div className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-medium text-[var(--ink)]">{labels[job.status] || 'Saved progress'}</p><p>{job.fromDate} – {job.throughDate}</p></div>
          <div role="progressbar" aria-label="Scheduled records saved" aria-valuemin={0} aria-valuemax={counts.required} aria-valuenow={counts.saved} className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]"><div className="h-full bg-[var(--ink)] transition-[width] motion-reduce:transition-none" style={{ width: counts.required ? (counts.saved / counts.required * 100) + '%' : '0%' }} /></div>
          <dl className="grid grid-cols-4 gap-4"><div><dt>Saved records</dt><dd className="mt-1 text-lg font-semibold tabular text-[var(--ink)]">{counts.saved.toLocaleString()} / {counts.required.toLocaleString()}</dd></div><div><dt>Content checked</dt><dd className="mt-1 text-lg tabular">{counts.contentChecked.toLocaleString()}</dd></div><div><dt>Records with link gaps</dt><dd className="mt-1 text-lg tabular">{counts.coverageGaps.toLocaleString()}</dd></div><div><dt>Rejected / uncertain</dt><dd className="mt-1 text-lg tabular">{counts.rejected} / {counts.unknown}</dd></div></dl>
          {job.batch && <p role="status">Current batch: {job.batch.size} records · {job.batch.state}</p>}
          {job.lastError && <p role="alert" className="text-[var(--attention)]">{job.lastError}</p>}
          <p className="text-[12px] text-[var(--ink-3)]">Saved and content-checked records are creation evidence. Full relationship coverage, report verification and bank reconciliation remain separate.</p>
          {active && state.owner && <Button variant="outline" disabled={!!busy || job.stopRequested} onClick={() => act('stop')}>Stop after current batch</Button>}
          {canStart && state.owner && <div className="space-y-3">{counts.rejected > 0 && <p>Retry the {counts.rejected} records QBO definitively rejected. Saved records are retained. Original failed requests and faults remain in the audit history.</p>}{environment === 'production' && <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!!busy || !!error} className="mt-0.5" /><span>I authorize adding the remaining {remaining.toLocaleString()} scheduled records to Production company ending {String(realmId).slice(-4)}.</span></label>}<Button disabled={!!busy || !!error || (environment === 'production' && !confirmed)} onClick={() => act('start')}>{busy === 'start' ? 'Starting…' : counts.rejected ? 'Retry rejected records and continue' : job.approved ? 'Resume adding records' : 'Start adding records'}</Button></div>}
        </div>}
        {state?.owner && !active && !job?.batch && <div className="flex flex-wrap items-end gap-3 border-t border-[var(--line)] pt-4"><label className="space-y-1"><span className="block">Schedule through</span><input type="date" value={throughDate} max={today()} disabled={!!busy || !!error} onChange={event => setThroughDate(event.target.value)} className="rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[var(--ink)]" /></label><Button variant="outline" disabled={!!busy || !!error || !throughDate} onClick={() => act('prepare')}>{busy === 'prepare' && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}{busy === 'prepare' ? 'Preparing schedule…' : 'Prepare business schedule'}</Button></div>}
      </>}
    </div>
  </section>
}
