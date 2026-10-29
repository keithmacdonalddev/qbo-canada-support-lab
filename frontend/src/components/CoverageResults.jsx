import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, Check, CircleHelp, FileText, LoaderCircle, RefreshCw, X } from 'lucide-react'
import catalog from '../../../docs/discovery/catalog.v1.json'
import { Button } from './ui/button'
import CoverageDialog from './CoverageDialog'
import { historyCoverage, reportCoverage } from '@/lib/coverage-results.mjs'

const LABEL = { verified: 'Checked', partial: 'Has data · checks unfinished', failed: 'Checks failed', unverified: 'Not checked yet' }
const FAMILIES = { financial:'Financial statements', cash:'Cash', receivables:'Customer balances', payables:'Supplier balances', expenses:'Expenses', sales:'Sales', inventory:'Inventory', projects:'Projects', tax:'Sales tax', budget:'Budgets', reconciliation:'Reconciliation', audit:'Audit & exceptions' }
const CHECKS = { availability:'Report opens', population:'Contains data', plausibility:'Amounts make sense', reconciliation:'Balances agree' }
function date(value) { return value ? new Date(value.slice(0,10) + 'T12:00:00').toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}) : 'Not recorded' }
function range(period) { return period ? date(period.fromDate) + ' – ' + date(period.throughDate) : 'Dates not recorded' }
function Status({ state, children }) { const Icon = state === 'verified' ? Check : state === 'failed' ? X : CircleHelp; return <span className={'coverage-report-status is-' + state}><Icon size={14} aria-hidden="true" />{children || LABEL[state]}</span> }
function ReportDetail({ report, saved, onClose, requirement, connected }) {
  const manual = saved.reports[report.key], loading = connected && (!manual || manual.state === 'loading' || saved.baselines.state === 'loading')
  return <CoverageDialog title={report.name} subtitle={FAMILIES[report.family]} focusKey={report.key} onClose={onClose}>
    <p className="coverage-detail-description">{report.businessQuestion}</p>
    <div className="coverage-next"><Link className="coverage-primary-link" to={'/reports?report=' + report.key}>Open {report.name} <ArrowUpRight size={16} /></Link></div>
    {manual?.state === 'error' && <p className="coverage-alert" role="alert">Saved checks for this report could not be loaded. Try Refresh saved results.</p>}
    {['error','partial'].includes(saved.baselines.state) && <p className="coverage-alert" role="alert">Some saved report results could not be loaded. The list below may be incomplete.</p>}
    {!report.records.length && <p className="coverage-note">{!connected ? 'Connect the company to load saved results.' : loading ? 'Loading saved results…' : 'No saved results were found in the history loaded here. Open the report to inspect it.'}</p>}
    <div className="coverage-report-observations">{report.records.map(record => <section key={record.id}>
      <div className="coverage-observation-heading"><h3>{range(record.period)}</h3><Status state={record.status} /></div>
      <p className="coverage-record-meta">{record.basis} · {record.source} · saved {date(record.observedAt)}</p>
      {record.filters && <p>Filters: {record.filters}</p>}
      {record.historical && <p className="coverage-warning">This was checked against an earlier checklist. The current checks are still needed.</p>}
      {record.checks && <dl className="coverage-report-checks">{Object.entries(record.checks).map(([key,value]) => <div key={key}><dt>{CHECKS[key] || key}</dt><dd>{value.status === 'passed' ? 'Passed' : value.status === 'failed' ? 'Failed' : value.status.replaceAll('-',' ')}</dd>{value.note && <dd className="coverage-check-note">{value.note}</dd>}</div>)}</dl>}
      {record.note && <details className="coverage-method"><summary>Saved notes</summary><p>{record.note}</p></details>}
    </section>)}</div>
    <p className="coverage-note">Checks apply to the saved dates, accounting basis and filters. A report containing data still needs its figures checked.</p>
    {(!report.historyComplete || saved.baselines.historyComplete === false) && <p className="coverage-record-meta">Older saved results may be available on the report page.</p>}
    <div className="coverage-dialog-footer"><button type="button" onClick={() => { onClose(); requirement(report.key) }}>View the report checklist <ArrowRight size={14} /></button></div>
  </CoverageDialog>
}
function History({ saved, retry, connected }) {
  const history = historyCoverage(saved.plan, saved.governance)
  if (!connected) return <div className="coverage-empty"><h2>Connect your company to see its history</h2><Link to="/company" className="coverage-primary-link">Open Company →</Link></div>
  if (saved.governance.state === 'loading' || saved.plan.state === 'loading') return <div className="coverage-empty" role="status"><LoaderCircle className="animate-spin" size={24}/><h2>Loading business history…</h2></div>
  if (history.status === 'unavailable') return <div className="coverage-empty" role="alert"><h2>Business history could not be loaded</h2><p>The company’s records have not been changed.</p><Button variant="outline" onClick={retry}>Try again</Button></div>
  if (history.status === 'unpublished') return <div className="coverage-empty"><h2>No business calendar has been published</h2><p>Set the business start date and history target in Company setup.</p><Link to="/company/setup" className="coverage-primary-link">Open Company setup →</Link></div>
  const months = Number.isInteger(history.required) && history.required > 0 ? Array.from({length:Math.min(history.required,1200)},(_,index) => {
    const [year,month] = history.opening.split('-').map(Number), day = new Date(Date.UTC(year,month-1+index,1))
    return { index, year:day.getUTCFullYear(), month:day.toLocaleDateString(undefined,{month:'short',timeZone:'UTC'}), done:index < history.completed }
  }) : []
  const years = [...new Set(months.map(month => month.year))]
  return <section className="coverage-history" aria-label="Business history">
    <div className="coverage-history-status"><div><span className={'coverage-history-state ' + (history.status === 'stopped' ? 'is-stopped' : '')}>{history.status === 'stopped' ? 'Activity stopped' : history.completed ? 'History in progress' : 'History not completed yet'}</span><h2>{history.completed} {history.required != null ? 'of ' + history.required : ''} months completed</h2><p>Transactions can exist in months that have not been completed. This calendar tracks the full month and its checks.</p></div><Link to="/company/setup" className="coverage-primary-link">Open business calendar <ArrowRight size={16} /></Link></div>
    <dl className="coverage-history-dates"><div><dt>Business starts</dt><dd>{date(history.opening)}</dd></div><div><dt>Completed through</dt><dd>{history.through ? date(history.through) : 'No completed period'}</dd></div><div><dt>History planned through</dt><dd>{date(history.targetThrough)}</dd></div></dl>
    {history.completionPending && <p className="coverage-alert">The latest period is waiting for its completion checks.</p>}
    {months.length > 0 ? <div className="coverage-calendar">{years.map(year => <section key={year}><h3>{year}</h3><div>{months.filter(month => month.year === year).map(month => <div key={month.index} className={month.done ? 'is-complete' : ''}><span>{month.month}</span><span>{month.done ? <><Check size={13} /> Complete</> : 'Not complete'}</span></div>)}</div></section>)}</div> : <p className="coverage-note">{saved.plan.state === 'error' ? 'The saved business plan could not be loaded. Refresh saved history to try again; completed periods above are still shown from the calendar.' : 'The saved plan does not match the published calendar, so its planned length cannot be shown here.'}</p>}
    <div className="coverage-history-next"><h3>Check the figures behind a completed period</h3><p>Review bank reconciliation and the saved period checks.</p><Link to="/company/period-close">Open period checks <ArrowRight size={15} /></Link></div>
    <details className="coverage-method"><summary>How completed months are counted</summary><p>A month counts only after the business calendar confirms that the full period is complete. Opening balances, individual transactions and records outside that calendar do not count as completed months.</p></details>
    <button type="button" className="coverage-text-link" onClick={retry}><RefreshCw size={13}/> Refresh saved history</button>
  </section>
}
export default function CoverageResults({ connection, section, query, clearQuery, requirement, saved, retry, initialFilter = 'suggested', initialFamilies = [] }) {
  const connected = connection?.ready === true
  const [filter,setFilter] = useState(initialFilter), [family,setFamily] = useState(initialFamilies.length ? 'focus' : 'all'), [selected,setSelected] = useState(null)
  const reports = useMemo(() => catalog.reports.map(report => reportCoverage(report,saved.reports[report.key],saved.baselines.data || [])),[saved.reports,saved.baselines])
  const searched = reports.filter(report => (family === 'all' || family === report.family || (family === 'focus' && initialFamilies.includes(report.family))) && [report.name,report.businessQuestion].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const filtered = searched.filter(report => ['all','suggested'].includes(filter) || (filter === 'saved' ? report.records.length > 0 : report.status === filter))
  const order = {failed:0,partial:1,verified:2,unverified:3}
  const visible = filter === 'suggested' && !query.trim() ? [...filtered].sort((a,b) => order[a.status] - order[b.status]).slice(0,6) : filtered
  const selectedReport = reports.find(report => report.key === selected)
  const loading = connected && (Object.keys(saved.reports).length < catalog.reports.length || Object.values(saved.reports).some(report => report.state === 'loading') || saved.baselines.state === 'loading')
  const failures = Object.values(saved.reports).filter(report => report.state === 'error').length
  if (section === 'history') return <History saved={saved} retry={retry} connected={connected} />
  return <section aria-label="Report coverage">
    <div className="coverage-toolbar"><div className="coverage-filters" role="group" aria-label="Report status">{[['suggested','Start here',Math.min(6,searched.length)],['all','All reports',searched.length],['saved','Saved results',searched.filter(r => r.records.length).length],['partial','Checks unfinished',searched.filter(r => r.status === 'partial').length],['failed','Checks failed',searched.filter(r => r.status === 'failed').length],['unverified','Not checked',searched.filter(r => r.status === 'unverified').length]].map(([key,label,count]) => <button type="button" key={key} aria-pressed={filter===key} onClick={() => setFilter(key)}>{label}<span>{key !== 'all' && (loading || !connected) ? '—' : count}</span></button>)}</div><select aria-label="Report category" value={family} onChange={event => setFamily(event.target.value)}><option value="all">All report categories</option>{initialFamilies.length > 0 && <option value="focus">Selected work area</option>}{Object.entries(FAMILIES).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><div className="coverage-refresh"><button type="button" onClick={retry} disabled={!connected || loading}>{loading ? <LoaderCircle className="animate-spin" size={14}/> : <RefreshCw size={14}/>}<span>{loading ? 'Loading…' : 'Refresh saved results'}</span></button></div></div>
    {!connected && <p className="coverage-alert">Connect the company to load saved results. <Link to="/company">Open Company →</Link></p>}
    {(failures > 0 || ['error','partial'].includes(saved.baselines.state)) && <p className="coverage-alert" role="alert">Some saved results could not be loaded. Refresh to retry; missing results are not counted as passed checks.</p>}
    {filter === 'suggested' && !query.trim() && <p className="coverage-report-intro">{visible.some(report => report.records.length) ? 'Saved results first. Open a report’s name to see its dates and checks.' : 'Start with the core reports. All reports are available above.'}</p>}
    <div className="coverage-report-list">{visible.map(report => {
      const manual = saved.reports[report.key], pending = connected && (!manual || manual.state === 'loading' || saved.baselines.state === 'loading') && !report.records.length
      return <article key={report.key} className="coverage-report-row"><FileText size={18} aria-hidden="true"/><div className="coverage-report-name"><button type="button" onClick={() => setSelected(report.key)}>{report.name}</button><p>{report.businessQuestion}</p></div><div className="coverage-report-result">{pending ? <span className="coverage-record-meta">Loading saved results…</span> : !connected ? <span className="coverage-record-meta">Company not connected</span> : <Status state={report.status}>{manual?.state === 'error' && !report.records.length ? 'Could not load checks' : LABEL[report.status]}</Status>}{report.records[0] && <button type="button" className="coverage-period-link" onClick={() => setSelected(report.key)}>{range(report.records[0].period)}</button>}</div><Link to={'/reports?report=' + report.key} className="coverage-open-report" aria-label={'Open ' + report.name}>Open <ArrowUpRight size={14} /></Link></article>
    })}</div>
    {!visible.length && <div className="coverage-empty"><h2>No reports match these filters</h2><Button variant="outline" onClick={() => {setFilter('all');setFamily('all');clearQuery()}}>Show all reports</Button></div>}
    <details className="coverage-method"><summary>About these report results</summary><p>Saved results keep their dates, accounting basis and filters. “Checked” means the checks passed for those saved dates. “Has data” means report data was found but the complete checklist has not passed. Older saved results may be available on each report’s page.</p></details>
    {selectedReport && <ReportDetail report={selectedReport} saved={saved} connected={connected} onClose={() => setSelected(null)} requirement={requirement} />}
  </section>
}
