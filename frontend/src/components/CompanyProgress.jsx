import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import client from '../api/client'
import { Button, buttonVariants } from './ui/button'
import { companyProgress, readCompanyProgress } from '../lib/company-progress.mjs'

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function date(value) { return value ? new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not established' }
export default function CompanyProgress({ enabled, realmId, environment, connectionId, api = client }) {
  const [saved, setSaved] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController(); let timer
    async function load() {
      if (document.hidden) { timer = setTimeout(load, 30000); return }
      setLoading(true)
      try {
        const value = await readCompanyProgress(api, { realmId, environment, connectionId }, controller.signal)
        if (!controller.signal.aborted) { setSaved({ ...value, readAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }); setError('') }
      } catch { if (!controller.signal.aborted) { setSaved(null); setError('Saved company progress could not be confirmed. Refresh the summary to try again; the detailed workflows remain available below.') } }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(load, 30000) } }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [enabled, realmId, environment, connectionId, api, revision])
  const view = saved && companyProgress({ ...saved, today: today() })
  function focusTarget(event) {
    const target = document.getElementById(view.action.target)
    if (target) { event.preventDefault(); target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }) }
  }
  return <section aria-label="Company progress and next action" className="mt-6 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
      <h2 className="text-[13px] font-semibold text-[var(--ink)]">Company progress</h2>
      <Button size="sm" variant="ghost" disabled={!enabled || loading} onClick={() => setRevision(value => value + 1)}>{loading && enabled && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}Refresh summary</Button>
    </header>
    {!enabled ? <p className="px-5 py-4 text-[13px] text-[var(--ink-2)]">Connect the company to see its saved progress. <Link to="/settings" className="text-[var(--link)] underline">Open connection settings</Link></p> : error ? <p role="alert" className="px-5 py-4 text-[13px] text-[var(--attention)]">{error}</p> : !view ? <p role="status" className="px-5 py-4 text-[13px] text-[var(--ink-2)]">Reading saved records, calendar and accounting checks…</p> : <>
      <dl className="grid gap-5 px-5 py-5 md:grid-cols-2">
        <div><dt className="text-[12.5px] text-[var(--ink-2)]">Records prepared through</dt><dd className="mt-1 text-[20px] font-semibold tabular text-[var(--ink)]">{date(view.records.date)}</dd><dd className="mt-2 text-[13px] text-[var(--ink-2)]">{view.records.detail}</dd></div>
        <div><dt className="text-[12.5px] text-[var(--ink-2)]">Books checked through</dt><dd className="mt-1 text-[20px] font-semibold tabular text-[var(--ink)]">{date(view.books.date)}</dd><dd className="mt-2 text-[13px] text-[var(--ink-2)]">{view.books.detail}</dd>{view.books.observedAt && <dd className="mt-1 text-[12px] text-[var(--ink-3)]">Captured {new Date(view.books.observedAt).toLocaleString()}. Later changes require a fresh check.</dd>}</div>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line)] px-5 py-4">
        <div className="min-w-0 flex-1"><h3 className="text-[13px] font-semibold text-[var(--ink)]">Next action</h3><p className="mt-1 text-[13px] text-[var(--ink-2)]">{view.action.detail}</p></div>
        {loading ? <p role="status" className="text-[13px] text-[var(--ink-2)]">Refreshing next action…</p> : view.action.target.startsWith('/') ? <Link to={view.action.target} className={buttonVariants({ size: 'sm' })}>{view.action.label}<ArrowRight className="size-3.5" /></Link> : <a href={'#' + view.action.target} onClick={focusTarget} className={buttonVariants({ size: 'sm' })}>{view.action.label}<ArrowRight className="size-3.5" /></a>}
      </div>
      <p className="border-t border-[var(--line)] px-5 py-3 text-[12px] text-[var(--ink-3)]">Calendar verified through: {date(view.verified)}. Saved report checks cover their stated period; bank reconciliation is separate. Summary read at {saved.readAt}.</p>
    </>}
  </section>
}
