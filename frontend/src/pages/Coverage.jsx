import { useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import Layout from '../components/Layout'
import CoverageOverview from '../components/CoverageOverview'
import CoverageExplorer from '../components/CoverageExplorer'
import CoverageTargets from '../components/CoverageTargets'
import CoverageResults from '../components/CoverageResults'
import useCoverageEvidence from '../components/useCoverageEvidence'
import { useAuth } from '../context/AuthContext'
import { useConnection } from '../context/ConnectionContext'
import { useCoverage } from '@/components/coverage'
import { historyCoverage, reportCoverage } from '@/lib/coverage-results.mjs'
import { REPORT_FAMILIES } from '@/lib/coverage-priorities.mjs'
import catalog from '../../../docs/discovery/catalog.v1.json'
import '../styles/coverage.css'

const VIEWS = [['situations','Gaps'],['start','For you'],['examples','Features'],['report-results','Reports'],['history','Business history']]

const SITUATION_FILTERS = [['weekly','Missing this week'],['never','Never found'],['unknown','Unknown'],['all','All situations']]
const GROUP_ORDER = ['Invoice','Payment','Bill','BillPayment','Estimate','PurchaseOrder','SalesReceipt','CreditMemo','RefundReceipt','VendorCredit','Purchase','Deposit','Transfer','JournalEntry','TimeActivity','Every class','Every location']
const REACH_LABEL = {'reachable-now':'Available tools','needs-tool':'Tool needed','needs-owner-setting':'Owner setting'}
function SituationCoverage({result,state,error,check,query,ready}) {
  const [filter,setFilter] = useState('weekly')
  const [group,setGroup] = useState('all')
  const situations=result?.situations, weekly=result?.weekly
  const unknownRows=[...new Map([...(weekly?.rows||[]).filter(row=>row.status==='unknown'),...(situations?.rows||[]).filter(row=>row.status==='unknown')].map(row=>[row.key,row])).values()]
  const source=filter==='weekly'?weekly?.rows:filter==='unknown'?unknownRows:situations?.rows
  const matches=(source||[]).filter(row => (filter==='weekly'?row.status==='missing':filter==='never'?row.status==='missing':filter==='unknown'?row.status==='unknown':true)
    && (group==='all'||row.group===group) && (!query || [row.label,row.entity,row.key,row.needed].join(' ').toLowerCase().includes(query.toLowerCase())))
  const groups=[...new Set(matches.map(row=>row.group))].sort((a,b)=>(GROUP_ORDER.includes(a)?GROUP_ORDER.indexOf(a):99)-(GROUP_ORDER.includes(b)?GROUP_ORDER.indexOf(b):99)||a.localeCompare(b))
  const options=[...new Set([...(situations?.rows||[]),...(weekly?.rows||[])].map(row=>row.group))].sort()
  const busy=['loading','checking'].includes(state)
  if(!ready) return <section className="situation-message"><h2>Connect a company to measure its situations</h2><p>Coverage uses the company’s synced copy.</p><Link to="/settings">Open connection settings</Link></section>
  if(!situations) return <section className="situation-message" aria-live="polite"><h2>{busy?'Measuring the synced company…':'Situation coverage is not available yet'}</h2><p>{error||'Read the local synced records to find lifecycle, tax, settings and weekly breadth gaps.'}</p><button type="button" disabled={busy} onClick={()=>check({refresh:true})}>{busy?'Checking…':'Check synced records'}</button></section>
  return <section className="situation-workspace" aria-label="Situation gaps">
    <div className="situation-summary"><p><strong>{weekly?.summary.gaps??'—'}</strong> weekly gaps <span>·</span> <strong>{situations.summary.missing}</strong> never found <span>·</span> <strong>{unknownRows.length}</strong> unknown <span>·</span> {situations.summary.total} situations</p><button type="button" disabled={busy} onClick={()=>check({refresh:true})}>{busy?'Checking…':'Refresh synced evidence'}</button></div>
    <p className="situation-note">Checked {new Date(result.checkedAt).toLocaleString()}. Seven days: {weekly?.from} – {weekly?.through}. Uses transaction dates, not sync times. Unknown evidence is excluded from gaps. {result.evidence?.recordsScanned?.toLocaleString()} mirrored records; no QuickBooks reads.</p>
    {error && <p role="alert" className="situation-error">{error} <button type="button" disabled={busy} onClick={()=>check({refresh:true})}>Retry</button></p>}
    <div className="coverage-toolbar"><div className="coverage-filters" aria-label="Situation filter">{SITUATION_FILTERS.map(([key,label])=><button type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</button>)}</div><select aria-label="Situation group" value={group} onChange={e=>setGroup(e.target.value)}><option value="all">Every record type and group</option>{options.map(g=><option key={g}>{g}</option>)}</select><span className="situation-result-count" aria-live="polite">{matches.length} shown</span></div>
    {filter==='weekly' && weekly?.summary.unknown>0 && <p className="situation-note">{weekly.summary.unknown} weekly checks are unknown. Review “Unknown” before treating this as complete breadth.</p>}
    {!matches.length && <p className="situation-message">{query||group!=='all'?'No situations match these filters.':'No measured gaps in this view. Unknown checks still need evidence.'}</p>}
    <div key={filter+group+query} className="situation-groups">{groups.map((name,index)=>{
      const rows=matches.filter(row=>row.group===name)
      return <details className="situation-group" key={name} open={index===0||!!query}>
        <summary><h2>{name==='Department'?'Locations':name}</h2><span>{rows.length} {filter==='all'?'situations':'checks'}</span></summary>
        <table><thead><tr><th scope="col">Situation</th><th scope="col">Evidence</th><th scope="col">What fills the gap</th><th scope="col">Example record</th></tr></thead><tbody>{rows.map(row=><tr key={row.key}>
          <th scope="row"><span>{row.label}</span><small>{row.key}</small></th>
          <td><span className={'situation-state is-'+row.status}>{row.status==='stale'?'Not this week':row.status==='missing'?'Missing':row.status==='unknown'?'Unknown':'Present'}</span><small>{filter==='weekly'?row.recentCount+' this week':(row.retainedCount??row.count)+' retained · '+row.recentCount+' this week'}{!row.evidence.complete?' · partial evidence':''}</small></td>
          <td><span className="situation-reach">{REACH_LABEL[row.reachability]}</span><p>{row.status==='present'?'Evidence found; keep this situation in the breadth rotation.':row.needed}</p>{row.evidence.reason&&<small>{row.evidence.reason}</small>}</td>
          <td>{row.example?.href?<Link to={row.example.href}>{row.example.entity} #{row.example.id}</Link>:row.example?<span>Deleted #{row.example.id}</span>:<span className="situation-none">No example</span>}{row.setupExample?.href&&<small><Link to={row.setupExample.href}>View {row.entity==='Class'?'class':'location'} #{row.setupExample.id}</Link></small>}</td>
        </tr>)}</tbody></table>
      </details>
    })}</div>
  </section>
}

function CoverageWorkspace({ connection }) {
  const ready = connection?.ready === true
  const { result, state, error, check } = useCoverage(ready,{autoCheck:true,acceptOlderCache:false})
  const { saved,retry } = useCoverageEvidence({enabled:ready,realmId:connection?.status?.realmId,environment:connection?.environment,connectionId:connection?.status?.connectionId,definitions:catalog.reports})
  const reports = useMemo(() => catalog.reports.map(report => reportCoverage(report,saved.reports[report.key],saved.baselines.data || [])),[saved.reports,saved.baselines])
  const history = useMemo(() => historyCoverage(saved.plan,saved.governance),[saved.plan,saved.governance])
  const pending = ready && (Object.keys(saved.reports).length < catalog.reports.length || saved.baselines.state === 'loading')
  const reportsFailed = Object.values(saved.reports).some(report => report.state === 'error') || ['error','partial'].includes(saved.baselines.state)
  const [params] = useSearchParams()
  const [mode,setMode] = useState(() => params.get('area') ? 'examples' : 'situations'), [query,setQuery] = useState('')
  const [focus,setFocus] = useState('all'), [recent,setRecent] = useState(null)
  const [destination,setDestination] = useState(() => ({area:params.get('area')})), [visit,setVisit] = useState(0)
  const [targetFeature,setTargetFeature] = useState(null)
  const top = useRef(null)
  function changeMode(next) { setMode(next); setQuery(''); top.current?.scrollIntoView({block:'start'}) }
  function open(target) { setDestination(target); setVisit(value => value+1); changeMode(target.view) }
  function requirement(key) {setTargetFeature(key);changeMode('features')}
  const isGuide = mode === 'features' || mode === 'reports'
  return <div className="coverage-page" ref={top}>
    <header className="coverage-topbar"><h1>Coverage</h1><nav aria-label="Coverage views">{VIEWS.map(([key,label]) => <button type="button" key={key} aria-current={mode === key ? 'page' : undefined} onClick={() => changeMode(key)}>{label}</button>)}<button type="button" aria-current={isGuide ? 'page' : undefined} onClick={() => {setTargetFeature(null);changeMode(mode === 'report-results' ? 'reports' : 'features')}}>Checklist</button></nav>{!['start','history'].includes(mode) && <div className="coverage-search"><Search size={16} aria-hidden="true"/><input type="search" aria-label="Search this coverage view" placeholder={mode === 'report-results' || mode === 'reports' ? 'Search reports' : 'Search features'} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={14}/></button>}</div>}</header>
    <div hidden={mode !== 'situations'}><SituationCoverage result={result} state={state} error={error} check={check} query={query} ready={ready}/></div>
    <div hidden={mode !== 'start'}><CoverageOverview key={focus} result={result} state={ready ? state : 'disconnected'} reports={reports} history={history} reportsFailed={reportsFailed} pending={pending} focus={focus} setFocus={setFocus} recent={recent} onOpen={open}/></div>
    <div hidden={mode !== 'examples'}><CoverageExplorer key={'features:' + visit} result={result} state={ready ? state : 'disconnected'} error={error} query={query} clearQuery={() => setQuery('')} check={check} requirement={requirement} initialArea={destination.area} initialSignal={destination.signal} initialGroup={destination.group} initialFilter={destination.view === 'examples' ? destination.filter : null} onSelect={(area,signal) => setRecent(area.key + ':' + signal.key)}/></div>
    <div hidden={!['report-results','history'].includes(mode)}><CoverageResults key={'results:' + visit} section={mode === 'history' ? 'history' : 'reports'} connection={connection} saved={saved} retry={retry} initialFilter={destination.view === 'report-results' ? destination.filter : undefined} initialFamilies={REPORT_FAMILIES[destination.family] || []} query={query} clearQuery={() => setQuery('')} requirement={key => {setTargetFeature(key);changeMode('reports')}}/></div>
    {isGuide && <CoverageTargets mode={mode} initialFeature={targetFeature} connection={connection} result={result} recordState={ready ? state : 'disconnected'} query={query} clearQuery={() => setQuery('')} onModeChange={changeMode} onInspectArea={key => open({view:'examples',area:key})}/>}
  </div>
}
export default function Coverage() {
  const connection = useConnection(), {user} = useAuth()
  const scope = [user?.actorId || user?.id || user?._id,connection?.status?.realmId,connection?.environment,connection?.status?.connectionId,connection?.ready].join(':')
  return <Layout><CoverageWorkspace key={scope} connection={connection}/></Layout>
}
