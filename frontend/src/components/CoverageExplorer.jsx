import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, Check, CircleHelp, Search, X, ChevronRight, RefreshCw, LoaderCircle } from 'lucide-react'
import { Button } from './ui/button'
import CoverageDialog from './CoverageDialog'
import client from '../api/client'
import { CoverageUnavailable, fillRequest, measuredAreas, relativeTime, shortDate } from './coverage'
import { featureGroup, featureName, featureRecordType, featureState } from '@/lib/coverage-features.mjs'
import { TARGET_GROUPS } from '@/lib/coverage-targets.mjs'
import { RECORD_TYPES } from '@/lib/records'
import catalog from '../../../docs/discovery/catalog.v1.json'

const TITLES = { 'sales.customers': 'Customers', 'sales.receivables-lifecycle': 'Invoices & customer payments', 'expenses.vendors': 'Suppliers', 'expenses.payables-lifecycle': 'Bills & supplier payments', 'inventory.items': 'Products & inventory', 'banking.cash-and-clearing': 'Deposits & transfers', 'tax.canadian-sales-tax': 'Sales tax', 'projects.project-lifecycle': 'Projects', 'expenses.time-activity': 'Time tracking', 'accounting.chart-of-accounts': 'Chart of accounts', 'accounting.journals-and-close': 'Journal entries & closing the books', 'accounting.reconciliation': 'Bank reconciliation', 'accounting.budgets': 'Budgets', 'accounting.recurring-transactions': 'Recurring transactions', 'accounting.payroll-summary': 'Payroll', 'company.preferences': 'Company settings', 'company.dimensions': 'Classes & locations', 'company.multicurrency': 'Foreign currencies', 'company.custom-fields': 'Custom fields', 'users.qbo-company-roles': 'Users & permissions', 'administration.attachments': 'Attachments' }
const STATUS = { available: 'Found in company', limited: 'Some data found', missing: 'Not found', incomplete: 'More setup needed', manual: 'Check in QuickBooks', unverified: 'Could not check', blocked: 'Setup needed' }
const SIGNAL_ORDER = { 'sales.receivables-lifecycle': ['invoices','partly-paid-invoices','overdue-invoices','refund-receipts'], 'expenses.payables-lifecycle': ['bills','partly-paid-bills','vendor-credits','card-credits'] }
const PRIORITY = ['sales.receivables-lifecycle', 'expenses.payables-lifecycle', 'inventory.items', 'projects.project-lifecycle', 'sales.customers', 'expenses.vendors']
function groupFor(area) { return TARGET_GROUPS.find(g => g.keys.includes(area.key)) }
function title(area) { return TITLES[area.key] || area.name }
function countLabel(signal) {
  const state = featureState(signal)
  if (signal.key === 'customer-provinces' && signal.count != null && ['available','limited','incomplete'].includes(state)) return signal.count + ' provinces'
  if (state === 'available' || state === 'limited') return signal.count != null ? signal.count.toLocaleString() + (signal.truncated ? '+' : '') + ' found' : signal.kind === 'setup' ? 'Enabled' : 'Found'
  return STATUS[state]
}
function SignalStatus({ signal }) {
  const group = featureGroup(signal), Icon = group === 'available' ? Check : group === 'missing' ? X : CircleHelp
  return <span className={'coverage-signal-status is-' + group}><Icon size={14} aria-hidden="true" /><span>{countLabel(signal)}</span></span>
}

function description(signal) {
  const state = featureState(signal)
  if (state === 'manual') return signal.how || 'Check this feature in QuickBooks.'
  if (state === 'unverified') return 'This information could not be checked. Check the company again to retry.'
  if (state === 'blocked') return signal.blockedBy || 'Set up this feature in QuickBooks first.'
  if (signal.key === 'customer-provinces' && signal.count != null) return 'Customer billing addresses cover ' + signal.count + ' provinces.'
  if (signal.kind === 'setup' && signal.count == null) return state === 'available' ? 'This setting is enabled.' : 'This setting was not enabled when the company was checked.'
  if (signal.count > 0) return signal.count.toLocaleString() + (signal.truncated ? ' or more' : '') + ' matching ' + (signal.kind === 'setup' ? 'items' : 'records') + ' found.'
  return signal.kind === 'setup' ? 'No matching setup was found.' : 'No matching records were found in the checked date range.'
}
function DetailSurface({ inline, title, subtitle, children, ...props }) {
  return inline ? <section className="coverage-inline-detail" id="coverage-feature-detail" aria-label={title}><header><p className="coverage-eyebrow">{subtitle}</p><h2>{title}</h2></header><div className="coverage-inline-body">{children}</div></section> : <CoverageDialog title={title} subtitle={subtitle} {...props}>{children}</CoverageDialog>
}
function EvidenceDetail({ selection, onClose, requirement, result, canAsk, inline = false }) {
  const navigate = useNavigate(), { area, signal, selectSignal } = selection
  const state = signal && featureState(signal), type = signal && featureRecordType(signal)
  const definition = catalog.capabilities.find(row => row.key === area.key)
  const related = catalog.reports.filter(report => definition?.linkedReports?.includes(report.key))
  return <DetailSurface inline={inline} title={signal ? featureName(signal) : title(area)} subtitle={signal ? title(area) : null} onClose={onClose} focusKey={signal?.key || area.key}>
    {signal ? <>
      <div className={'coverage-evidence-banner is-' + featureGroup(signal)}><SignalStatus signal={signal} /><span>{STATUS[state]}</span></div>
      <p className="coverage-detail-description">{description(signal)}</p>
      <dl className="coverage-facts">{signal.last && <div><dt>Latest record</dt><dd>{shortDate(signal.last)}</dd></div>}<div><dt>Last checked</dt><dd>{shortDate(result.checkedAt) || 'Unknown'}</dd></div>{signal.kind !== 'setup' && signal.kind !== 'manual' && <div><dt>Dates searched</dt><dd>Last {result.lookbackDays || 365} days</dd></div>}</dl>
      {signal.status === 'stale' && <p className="coverage-note">These examples are older, but still count as data you can inspect.</p>}
      {state === 'limited' && <p className="coverage-note">There is data to inspect, but less than the planned amount.</p>}
      {state === 'incomplete' && <p className="coverage-note">Some setup exists, but more is needed to demonstrate this feature.</p>}
      {signal.truncated && <p className="coverage-warning">Only part of the list was checked. The count is a minimum.</p>}
      {type && <div className="coverage-next"><Link to={'/explorer?type=' + type} className="coverage-primary-link">Browse all {RECORD_TYPES[type]?.plural?.toLowerCase() || type} <ArrowUpRight size={16} /></Link><p>The saved check contains a count, not individual record links. This opens the full list.</p></div>}
      {!type && <p className="coverage-note">Open this feature in QuickBooks to inspect it.</p>}
      {state === 'missing' && signal.fill === 'assistant' && <div className="coverage-next"><Button disabled={!canAsk} onClick={() => navigate('/cases/new', { state: { message: fillRequest(area, [signal]) } })}>Start a test case <ArrowRight /></Button><p>Starts the assistant now and authorizes it to create and change its own test records in the connected company. Existing records stay read-only.</p>{!canAsk && <Link to="/settings" className="coverage-text-link">Set up an AI provider to start test cases →</Link>}</div>}
      {!inline && <button type="button" className="coverage-back" onClick={() => selectSignal(area, null)}>← All features in {title(area)}</button>}
    </> : <div className="coverage-detail-signals">{area.signals.map(s => <SignalRow key={s.key} signal={s} onClick={() => selectSignal(area, s)} />)}</div>}
    {!!related.length && <details className="coverage-method"><summary>Related reports</summary><ul>{related.map(report => <li key={report.key}><Link to={'/reports?report=' + report.key}>{report.name} →</Link></li>)}</ul></details>}
    <div className="coverage-dialog-footer"><button type="button" onClick={() => { onClose(); requirement(area.key) }}>What else should this feature cover? <ArrowRight size={14} /></button></div>
  </DetailSurface>
}
function SignalRow({ signal, onClick }) {
  return <button type="button" className="coverage-signal" onClick={onClick}><span className="coverage-signal-name">{featureName(signal)}</span><SignalStatus signal={signal} /><ChevronRight size={13} className="coverage-row-arrow" aria-hidden="true" /></button>
}
export default function CoverageExplorer({ result, state, error, query, clearQuery, check, requirement, initialArea, initialSignal, initialGroup, initialFilter, onSelect }) {
  const [group,setGroup] = useState(initialGroup || (initialArea ? groupFor({key:initialArea})?.key : initialFilter ? 'all' : 'sales') || 'sales')
  const [filter,setFilter] = useState(initialFilter || 'all')
  const [selectionIds,setSelectionIds] = useState(() => initialArea ? {areaKey:initialArea,signalKey:initialSignal} : null)
  const [canAsk,setCanAsk] = useState(false)
  useEffect(() => {let cancelled=false;client.get('/ai/config').then(response => {if (!cancelled) setCanAsk(response.data?.data?.available === true)}).catch(() => {});return () => {cancelled=true}},[])
  const areas = useMemo(() => measuredAreas(result).sort((a,b) => {const ai=PRIORITY.indexOf(a.key),bi=PRIORITY.indexOf(b.key);return (ai<0?100:ai)-(bi<0?100:bi)}),[result])
  const needle = query.trim().toLowerCase()
  const visible = areas.flatMap(area => {
    if (!needle && group !== 'all' && groupFor(area)?.key !== group) return []
    const areaMatch = [title(area),area.name,groupFor(area)?.name].join(' ').toLowerCase().includes(needle)
    const order = SIGNAL_ORDER[area.key] || []
    const signals = area.signals.filter(signal => (!needle || areaMatch || [featureName(signal),signal.label].join(' ').toLowerCase().includes(needle)) && (filter === 'all' || featureGroup(signal) === filter))
    signals.sort((a,b) => {const ai=order.indexOf(a.key),bi=order.indexOf(b.key);return (ai<0?100:ai)-(bi<0?100:bi)})
    return signals.length ? [{...area,signals}] : []
  })
  const reset = () => {setGroup('all');clearQuery();setFilter('all');setSelectionIds(null)}
  const selectSignal = (area,signal) => {setSelectionIds({areaKey:area.key,signalKey:signal?.key});if(signal) onSelect?.(area,signal)}
  const selectedArea = visible.find(area => area.key === selectionIds?.areaKey && area.signals.some(signal => signal.key === selectionIds?.signalKey)) || visible.find(area => area.key === selectionIds?.areaKey) || visible[0]
  const selectedSignal = selectedArea?.signals.find(signal => signal.key === selectionIds?.signalKey) || selectedArea?.signals[0]
  const selection = selectedSignal ? {area:areas.find(area => area.key === selectedArea.key),signal:selectedSignal,selectSignal} : null
  const loading = state === 'loading' || state === 'checking'
  return <section aria-label="Company features">
    <div className="coverage-toolbar"><label className="coverage-scope-control">Business area<select aria-label="Business area" value={group} onChange={event => {setGroup(event.target.value);setSelectionIds(null);clearQuery()}}><option value="all">All business areas</option>{TARGET_GROUPS.filter(g => !g.internal).map(g => <option key={g.key} value={g.key}>{g.name}</option>)}</select></label><div className="coverage-filters" role="group" aria-label="Feature status">{[['all','All'],['available','With data'],['missing','Missing or incomplete'],['verification','Needs checking']].map(([key,label]) => <button type="button" key={key} aria-pressed={filter===key} onClick={() => {setFilter(key);setSelectionIds(null)}}>{label}</button>)}</div><div className="coverage-refresh">{result && <span>Checked {relativeTime(result.checkedAt)}</span>}{!['disconnected','unavailable'].includes(state) && <button type="button" disabled={loading} onClick={() => check({refresh:true})} aria-label="Check company again" title="Read current company records and settings">{loading ? <LoaderCircle className="animate-spin" size={14}/> : <RefreshCw size={14}/>}<span>{loading ? 'Checking…' : 'Check company'}</span></button>}</div></div>
    {needle && <p className="coverage-report-intro">Searching across all business areas. Status filter: {filter === 'all' ? 'all features' : filter === 'missing' ? 'missing or incomplete' : filter === 'available' ? 'with data' : 'needs checking'}.</p>}
    {state === 'error' && <p className="coverage-alert" role="alert">{error || 'The company check failed.'} {result && 'Showing the previous results.'} Use Check company to retry.</p>}
    {state === 'unavailable' ? <CoverageUnavailable/> : !result ? <div className="coverage-empty" role="status"><Search size={25}/><h2>{loading ? 'Loading company features…' : state === 'disconnected' ? 'Connect your company to see its features' : 'Check your company to see what’s available'}</h2><p>{state === 'disconnected' ? 'Connect QuickBooks from the Company page.' : 'The check reads existing records and settings. It does not create transactions.'}</p>{state === 'disconnected' ? <Link to="/company" className="coverage-primary-link">Open Company →</Link> : !loading && <Button onClick={() => check({refresh:true})}>Check company</Button>}</div> : <>
      {selection ? <div className="coverage-feature-workspace"><div className="coverage-feature-list" aria-label="Features in this area">{visible.map(area => <section key={area.key}><h2>{title(area)}</h2>{area.signals.map(signal => <button type="button" key={signal.key} className="coverage-feature-choice" aria-pressed={selectedArea.key===area.key && selectedSignal.key===signal.key} aria-controls="coverage-feature-detail" onClick={() => selectSignal(area,signal)}><span>{featureName(signal)}</span><SignalStatus signal={signal}/><ChevronRight size={14}/></button>)}</section>)}</div><EvidenceDetail inline selection={selection} onClose={() => setSelectionIds(null)} requirement={requirement} result={result} canAsk={canAsk}/></div> : <div className="coverage-empty"><Search size={25}/><h2>No features match this view</h2><p>Try another business area or clear the filters.</p><Button variant="outline" onClick={reset}>Show all features</Button></div>}
      <details className="coverage-method"><summary>About these results</summary><p>Checked {shortDate(result.checkedAt)}. Transactions were searched over {result.lookbackDays || 365} days; settings reflect the time of the check. Older records still count. Finding examples does not establish complete report checks or completed business history.</p>{!!result.sourceErrors?.length && <p className="coverage-warning">Some sources could not be checked: {result.sourceErrors.map(source => source.source).join(', ')}.</p>}</details>
    </>}
  </section>
}
