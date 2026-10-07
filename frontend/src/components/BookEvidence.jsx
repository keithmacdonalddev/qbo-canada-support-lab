import { useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { buttonVariants } from '@/components/ui/button'

const LABELS = { passed: 'Passed', failed: 'Difference found', unverified: 'Not verified' }
export default function BookEvidence({ realmId, enabled }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const [fromDate, setFromDate] = useState(today.slice(0, 7) + '-01')
  const [throughDate, setThroughDate] = useState(today)
  const [result, setResult] = useState(null)
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  const counter = useRef({ value: 0 })
  useEffect(() => { const requests = counter.current; return () => { requests.value++ } }, [])
  async function check() {
    const requests = counter.current
    const request = ++requests.value
    setState('loading'); setError(null); setResult(null)
    try {
      const response = await client.get('/company/book-evidence', { params: { fromDate, throughDate } })
      if (request !== requests.value) return
      if (String(response.data?.data?.realmId) !== String(realmId)) throw new Error('The company changed. Run the check again.')
      setResult(response.data.data); setState('ready')
    } catch (failure) {
      if (request !== requests.value) return
      setError(typeof failure.response?.data?.error === 'string' ? failure.response.data.error : failure.message || 'The report check failed.')
      setState('error')
    }
  }
  return <section aria-label="Book checks" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="border-b border-[var(--line)] px-5 py-3"><h2 className="text-[13px] font-semibold text-[var(--ink)]">Book checks</h2></header>
    <div className="px-5 py-4">
      <p className="text-[13px] text-[var(--ink-2)]">Compare the trial balance, balance sheet, and amounts owed by customers and to vendors. Reads reports without changing records.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12px] text-[var(--ink-2)]">From<input aria-label="Book checks from date" type="date" value={fromDate} max={throughDate} disabled={state === 'loading'} onChange={event => { setFromDate(event.target.value); setResult(null) }} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-[var(--ink)]" /></label>
        <label className="text-[12px] text-[var(--ink-2)]">Through<input aria-label="Book checks through date" type="date" value={throughDate} min={fromDate} max={today} disabled={state === 'loading'} onChange={event => { setThroughDate(event.target.value); setResult(null) }} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-[var(--ink)]" /></label>
        <button type="button" disabled={!enabled || !fromDate || !throughDate || state === 'loading'} onClick={check} className={buttonVariants({ size: 'sm' })}>{state === 'loading' ? 'Reading reports…' : 'Check reports'}</button>
        <span className="pb-2 text-[12px] text-[var(--ink-3)]">Accrual ledger · CAD</span>
      </div>
      {error && <p role="alert" className="mt-3 text-[13px] text-[var(--danger-ink)]">{error}</p>}
      {state === 'loading' && <p role="status" className="mt-3 text-[13px] text-[var(--ink-2)]">Reading five reports and matching ledger account IDs…</p>}
      {result && <div className="mt-4">
        <p className="text-[13px] font-medium text-[var(--ink)]">{result.status === 'checks-passed' ? 'These accounting checks passed' : result.status === 'differences-found' ? 'Accounting differences found' : 'Some accounting checks remain unverified'}</p>
        <ul className="mt-2 divide-y divide-[var(--line)]">{result.checks.map(check => <li key={check.key} className="py-2 text-[13px]">
          <div className="flex flex-wrap justify-between gap-2"><span>{check.label}</span><span className={check.status === 'passed' ? 'text-[var(--ok)]' : 'text-[var(--attention)]'}>{LABELS[check.status]}</span></div>
          {check.reason && <p className="mt-1 text-[var(--ink-3)]">{check.reason}</p>}
          {check.left != null && <p className="mt-1 text-[var(--ink-3)]">{check.left.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} compared with {check.right.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} CAD · difference {check.difference.toFixed(2)}</p>}
        </li>)}</ul>
        <details className="mt-3 text-[12px] text-[var(--ink-2)]"><summary className="cursor-pointer">Report evidence</summary>
          <div className="mt-2 space-y-4">{result.reports.map(report => <section key={report.name}>
            <h3 className="font-medium">{report.name}: {report.status}</h3>
            <p>{report.startDate || 'Unknown start'} through {report.throughDate || 'unknown date'} · {report.evidenceType === 'open-balances-at-date' ? 'Open balances at date' : report.basis || 'Basis not returned'} · {report.currency || 'Currency not returned'}</p>
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
