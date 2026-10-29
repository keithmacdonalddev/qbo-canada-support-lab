import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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

const VIEWS = [['start','For you'],['examples','Features'],['report-results','Reports'],['history','Business history']]
function CoverageWorkspace({ connection }) {
  const ready = connection?.ready === true
  const { result, state, error, check } = useCoverage(ready,{autoCheck:false,acceptOlderCache:true})
  const { saved,retry } = useCoverageEvidence({enabled:ready,realmId:connection?.status?.realmId,environment:connection?.environment,connectionId:connection?.status?.connectionId,definitions:catalog.reports})
  const reports = useMemo(() => catalog.reports.map(report => reportCoverage(report,saved.reports[report.key],saved.baselines.data || [])),[saved.reports,saved.baselines])
  const history = useMemo(() => historyCoverage(saved.plan,saved.governance),[saved.plan,saved.governance])
  const pending = ready && (Object.keys(saved.reports).length < catalog.reports.length || saved.baselines.state === 'loading')
  const reportsFailed = Object.values(saved.reports).some(report => report.state === 'error') || ['error','partial'].includes(saved.baselines.state)
  const [params] = useSearchParams()
  const [mode,setMode] = useState(() => params.get('area') ? 'examples' : 'start'), [query,setQuery] = useState('')
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
