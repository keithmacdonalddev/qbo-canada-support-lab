import { useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Link } from 'react-router-dom'
import { buttonVariants } from '@/components/ui/button'

const LABELS = { passed: 'Passed', failed: 'Difference found', unverified: 'Not verified' }
export default function BookEvidence({ realmId, environment, connectionId, enabled, standalone = false }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [requestedPeriod, setRequestedPeriod] = useState(null)
  const [result, setResult] = useState(null)
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  const counter = useRef({ value: 0, controller: null })
  useEffect(() => { const requests = counter.current; return () => { requests.value++; requests.controller?.abort() } }, [])
  async function check(event) {
    event.preventDefault()
    setResult(null); setError(null)
    const fields = new FormData(event.currentTarget)
    const fromDate = String(fields.get('fromDate') || ''), throughDate = String(fields.get('throughDate') || '')
    if (!fromDate || !throughDate || fromDate > throughDate || throughDate > today) { setError('Choose a valid elapsed reporting period.'); return }
    const requests = counter.current
    if (requests.controller) return
    const controller = new AbortController()
    requests.controller = controller
    setRequestedPeriod({ fromDate, throughDate })
    const request = ++requests.value
    setState('loading'); setError(null); setResult(null)
    try {
      const response = await client.get('/company/book-evidence', { params: { fromDate, throughDate }, timeout: 190000, signal: controller.signal })
      if (request !== requests.value) return
      if (String(response.data?.data?.realmId) !== String(realmId) || response.data?.data?.environment !== environment || response.data?.data?.connectionId !== connectionId) throw new Error('The company changed. Run the check again.')
      if (response.data.data.period?.fromDate !== fromDate || response.data.data.period?.throughDate !== throughDate || response.data.data.period?.basis !== 'Accrual' || response.data.data.period?.currency !== 'CAD') throw new Error('The report period or accounting scope changed. Run the check again.')
      setResult(response.data.data); setState('ready')
    } catch (failure) {
      if (request !== requests.value) return
      setError(typeof failure.response?.data?.error === 'string' ? failure.response.data.error : failure.message || 'The report check failed.')
      setState('error')
    } finally {
      if (requests.controller === controller) requests.controller = null
    }
  }
  function stop() {
    counter.current.value++
    counter.current.controller?.abort()
    counter.current.controller = null
    setState('idle'); setResult(null); setError('Report check stopped.')
  }
  return <section aria-label="Book checks" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3"><h2 className="text-[13px] font-semibold text-[var(--ink)]">Book checks</h2>{!standalone && <Link to="/company/reports" className="text-[12.5px] font-medium text-[var(--link)]">Open book checks</Link>}</header>
    <div className="px-5 py-4">
      <p className="text-[13px] text-[var(--ink-2)]">Read the seven critical financial reports and compare the trial balance, balance sheet, receivables and payables. Reads without changing records.</p>
      <form onSubmit={check} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12px] text-[var(--ink-2)]">From<input aria-label="Book checks from date" name="fromDate" type="date" defaultValue={today.slice(0, 7) + '-01'} max={today} required disabled={state === 'loading'} onChange={() => setResult(null)} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-[var(--ink)]" /></label>
        <label className="text-[12px] text-[var(--ink-2)]">Through<input aria-label="Book checks through date" name="throughDate" type="date" defaultValue={today} max={today} required disabled={state === 'loading'} onChange={() => setResult(null)} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-[var(--ink)]" /></label>
        <button type="submit" disabled={!enabled || state === 'loading'} className={buttonVariants({ size: 'sm' })}>{state === 'loading' ? 'Reading reports…' : 'Check reports'}</button>
        {state === 'loading' && <button type="button" onClick={stop} className={buttonVariants({ size: 'sm', variant: 'outline' })}>Cancel check</button>}
        <span className="pb-2 text-[12px] text-[var(--ink-3)]">Accrual ledger · CAD</span>
      </form>
      {error && <p role="alert" className="mt-3 text-[13px] text-[var(--danger-ink)]">{error}</p>}
      {state === 'loading' && <p role="status" className="mt-3 text-[13px] text-[var(--ink-2)]">Reading seven reports for {requestedPeriod?.fromDate} through {requestedPeriod?.throughDate} and matching ledger account IDs…</p>}
      {result && <div className="mt-4">
        <p className="mb-2 text-[12px] text-[var(--ink-2)]">Observed period: {result.period?.fromDate} through {result.period?.throughDate}.</p>
        <p className="text-[13px] font-medium text-[var(--ink)]">{result.status === 'checks-passed' ? 'These accounting checks passed' : result.status === 'differences-found' ? 'Accounting differences found' : 'Some report evidence remains unverified'}</p>
        {result.reportCoverage ? <p className="mt-2 text-[13px] text-[var(--ink-2)]">{result.reportCoverage.available} of {result.reportCoverage.required} critical reports confirm the required period, currency and supported accounting scope.{!result.reportCoverage.complete && ' Still unverified: ' + result.reportCoverage.missing.join(', ') + '.'} Report availability is separate from the accounting checks below.</p> : <p className="mt-2 text-[13px] text-[var(--ink-2)]">This earlier result contains {result.reports.length} report observations. General ledger and cash-flow coverage remain unverified.</p>}
        <ul className="mt-2 divide-y divide-[var(--line)]">{result.checks.map(check => <li key={check.key} className="py-2 text-[13px]">
          <div className="flex flex-wrap justify-between gap-2"><span>{check.label}</span><span className={check.status === 'passed' ? 'text-[var(--ok)]' : 'text-[var(--attention)]'}>{LABELS[check.status]}</span></div>
          {check.reason && <p className="mt-1 text-[var(--ink-3)]">{check.reason}</p>}
          {check.left != null && <p className="mt-1 text-[var(--ink-3)]">{check.left.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} compared with {check.right.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CAD · difference {check.difference.toFixed(2)}</p>}
        </li>)}</ul>
        <details className="mt-3 text-[12px] text-[var(--ink-2)]"><summary className="cursor-pointer">Report evidence</summary>
          <p className="mt-2">{Number.isSafeInteger(result.readAttempts) ? result.readAttempts + ' QuickBooks read attempts for this check.' : 'The original read-attempt count is unavailable.'}</p>
          <div className="mt-2 space-y-4">{result.reports.map(report => <section key={report.name}>
            <h3 className="font-medium">{report.name}: {report.status}</h3>
            <p>{report.startDate || 'Unknown start'} through {report.throughDate || 'unknown date'} · {report.evidenceType === 'open-balances-at-date' ? 'Open balances at date' : report.evidenceType === 'ledger-detail' ? 'General ledger detail' : report.evidenceType === 'cash-movement-statement' ? 'Cash flow statement' : report.basis || 'Basis not returned'} · {report.currency || 'Currency not returned'}</p>
            {(report.error || report.limitation) && <p className="text-[var(--attention)]">{report.error || report.limitation}</p>}
            {!!report.summaries?.length && <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><thead><tr>{report.columns.map((column, i) => <th key={i} className="border-b border-[var(--line)] p-1 font-medium">{column}</th>)}</tr></thead><tbody>{report.summaries.map((cells, i) => <tr key={i}>{cells.map((cell, j) => <td key={j} className="p-1 tabular">{cell}</td>)}</tr>)}</tbody></table></div>}
            {report.summariesTruncated && <p>Showing the first 50 summary rows. Checks use the complete supported report.</p>}
          </section>)}</div>
        </details>
        <p className="mt-3 text-[12px] text-[var(--ink-3)]">{result.limitation}</p>
      </div>}
    </div>
  </section>
}
