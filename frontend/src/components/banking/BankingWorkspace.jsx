import { useEffect, useId, useState } from 'react'
import { RefreshCw, Landmark, ArrowRight } from 'lucide-react'
import { Button } from '../ui/button'
import { bankingApi, bankingError, bankingPeriodState, currentBankingPackages } from '../../api/banking'
import BankingAccountPeriod from './BankingAccountPeriod'
import './banking.css'

export function BankingWorkspaceView({ data, loading = false, error = '', loadedAt, onRefresh, api = bankingApi, accounts = [], scopeKey = 'connected-company', operatorStatusByPackage = {}, refreshKey = 0 }) {
  const titleId = useId(), accountFilterId = useId(), monthFilterId = useId()
  const [selected, setSelected] = useState(null)
  const [accountFilter, setAccountFilter] = useState(''), [monthFilter, setMonthFilter] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false), [page, setPage] = useState(0)
  const packages = currentBankingPackages(data?.packages || [])
  const accountName = id => accounts.find(account => String(account.id) === id)?.name || 'Account #' + id
  const filtered = packages.filter(pkg => (!accountFilter || pkg.accountId === accountFilter) && (!monthFilter || pkg.period === monthFilter) && (!attentionOnly || !pkg.summary?.reconciled || pkg.summary?.needsReview || pkg.blockers?.length))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12)), currentPage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(currentPage * 12, (currentPage + 1) * 12)
  const chosen = visible.find(pkg => pkg.id === selected) || visible[0]
  const filter = setter => event => { setter(event.target.value); setPage(0) }
  return <section className="banking-workspace" aria-labelledby={titleId}>
    <header className="banking-heading">
      <div><h2 id={titleId}><Landmark size={19} aria-hidden="true" />Banking</h2><p>Statements, imports and reconciliation by account and month.</p></div>
      <Button variant="outline" onClick={() => onRefresh()} disabled={loading} aria-label="Refresh banking evidence"><RefreshCw size={15} aria-hidden="true" />{loading ? 'Loading…' : 'Refresh'}</Button>
    </header>
    {error && <div className="banking-notice banking-notice--error" role="alert"><strong>{data ? 'Saved view may be out of date. ' : ''}</strong>{error} <button type="button" onClick={() => onRefresh()}>Try again</button></div>}
    {!data && !error && <p className="banking-notice" role="status">Loading account-month packages and saved evidence…</p>}
    {data && <>
      <div className="banking-toolbar">
        <label htmlFor={accountFilterId}>Account<select id={accountFilterId} value={accountFilter} onChange={filter(setAccountFilter)}><option value="">All accounts</option>{[...new Set(packages.map(pkg => pkg.accountId))].map(id => <option value={id} key={id}>{accountName(id)}</option>)}</select></label>
        <label htmlFor={monthFilterId}>Month<select id={monthFilterId} value={monthFilter} onChange={filter(setMonthFilter)}><option value="">All months</option>{[...new Set(packages.map(pkg => pkg.period))].sort().map(month => <option key={month}>{month}</option>)}</select></label>
        <label className="banking-checkbox"><input type="checkbox" checked={attentionOnly} onChange={event => { setAttentionOnly(event.target.checked); setPage(0) }} />Needs work</label>
        <span className="banking-muted" role="status">{filtered.length} account-months · Loaded {loadedAt}{loading ? ' · Refreshing…' : ''}</span>
      </div>
      {data.truncated && <p className="banking-notice" role="status">Only the first 2,000 package revisions were returned. Coverage is incomplete; missing months are not proof of completion.</p>}
      {!packages.length ? <div className="banking-empty"><h3>No banking packages yet</h3><p>Generated CSVs, simulated statements and native evidence will appear here. No uploaded or reconciled history has been confirmed by this workspace.</p></div> : !filtered.length ? <div className="banking-empty"><h3>No months match these filters</h3><Button variant="outline" onClick={() => { setAccountFilter(''); setMonthFilter(''); setAttentionOnly(false); setPage(0) }}>Show all account-months</Button></div> : <>
        <div className="banking-table-scroll" tabIndex={0} aria-label="Account-month banking status; scroll horizontally if needed">
          <table className="banking-table"><caption className="banking-sr-only">Latest package revision for each account-month. Select a month to inspect its files, blockers and evidence.</caption><thead><tr><th scope="col">Account / month</th>{['Generated', 'Uploaded', 'Reviewed', 'Reconciled'].map(label => <th scope="col" key={label}>{label}</th>)}<th scope="col">Next action / blocked reason</th></tr></thead><tbody>
            {visible.map(pkg => { const state = bankingPeriodState(pkg); return <tr key={pkg.id} className={chosen?.id === pkg.id ? 'banking-selected' : ''}>
              <th scope="row"><button type="button" className="banking-period-link" aria-expanded={chosen?.id === pkg.id} onClick={() => setSelected(pkg.id)}><strong>{accountName(pkg.accountId)}</strong><span>{pkg.period} · {pkg.accountCurrency} · v{pkg.revision}</span></button></th>
              {state.stages.map(stage => <td key={stage.key}><span className={'banking-stage' + (stage.done ? ' banking-stage--done' : '')}>{stage.value}</span></td>)}
              <td><button type="button" className="banking-next" onClick={() => setSelected(pkg.id)}>{pkg.nextAction || 'Inspect evidence'}<ArrowRight size={14} aria-hidden="true" /></button>{state.needsReview && <span className="banking-warning">History changed · review required</span>}{state.blockers.length > 0 && <span className="banking-warning">{state.blockers.length} blocked reason{state.blockers.length === 1 ? '' : 's'}: {state.blockers[0]}</span>}</td>
            </tr> })}
          </tbody></table>
        </div>
        <div className="banking-pagination"><span>{currentPage * 12 + 1}–{Math.min((currentPage + 1) * 12, filtered.length)} of {filtered.length} · oldest first within each account</span><Button variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button><Button variant="outline" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</Button></div>
        {chosen && <BankingAccountPeriod key={scopeKey + ':' + chosen.id} packageSummary={chosen} accountName={accountName(chosen.accountId)} api={api} refreshKey={refreshKey} operatorStatus={operatorStatusByPackage[chosen.id]} stale={Boolean(error || loading)} />}
      </>}
      <p className="banking-footnote">Generated files are simulated evidence. Uploaded, reviewed and reconciled are separate states; a reviewed row may still need resolution. Terra reports and retained screenshots are shown with their recorded evidence labels.</p>
    </>}
  </section>
}

// BF6 mounts this under the connected company and changes scopeKey with the connection.
export default function BankingWorkspace({ api = bankingApi, accounts = [], scopeKey = 'connected-company', operatorStatusByPackage = {} }) {
  const [load, setLoad] = useState({ data: null, loading: true, error: '', scopeKey })
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve().then(() => { if (!controller.signal.aborted) setLoad(old => old.scopeKey === scopeKey ? { ...old, loading: true, error: '' } : { data: null, loading: true, error: '', scopeKey }) })
    api.list({ signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setLoad({ data, loading: false, error: '', scopeKey, at: new Date().toLocaleTimeString() })
    }).catch(error => {
      if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: false, error: bankingError(error) }))
    })
    return () => controller.abort()
  }, [api, scopeKey, refresh])
  return <BankingWorkspaceView key={scopeKey} data={load.scopeKey === scopeKey ? load.data : null} loading={load.scopeKey !== scopeKey || load.loading} error={load.scopeKey === scopeKey ? load.error : ''} loadedAt={load.at} onRefresh={() => setRefresh(value => value + 1)} api={api} accounts={accounts} scopeKey={scopeKey} refreshKey={refresh} operatorStatusByPackage={operatorStatusByPackage} />
}
