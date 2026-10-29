import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, CircleHelp, X } from 'lucide-react'
import catalog from '../../../docs/discovery/catalog.v1.json'
import { useAuth } from '../context/AuthContext'
import { Button } from './ui/button'
import CoverageDialog from './CoverageDialog'
import { featureCoverage } from '@/lib/coverage-results.mjs'
import { filterTargets, TARGET_GROUPS } from '@/lib/coverage-targets.mjs'

function ChecklistStatus({ variant }) {
  const Icon = variant.status === 'represented' ? Check : variant.status === 'missing' ? X : CircleHelp
  const label = variant.status === 'represented' ? 'Found' : variant.status === 'missing' ? 'Not found in check' : 'Not checked'
  return <span className={'coverage-checklist-status is-' + variant.status}><Icon size={13} aria-hidden="true"/><span>{label}</span></span>
}
function RequirementDetail({ item, isReport, comparison, result, inspectArea, onClose }) {
  const related = catalog.reports.filter(report => item.linkedReports?.includes(report.key))
  return <CoverageDialog title={item.name} subtitle={isReport ? 'Report checklist' : 'Feature checklist'} focusKey={item.key} onClose={onClose}>
    <p className="coverage-detail-description">{isReport ? item.businessQuestion : item.purpose}</p>
    {isReport ? <>
      <h3>Dates to cover</h3><ul className="coverage-tags">{item.periods.map(period => <li key={period}>{period}</li>)}</ul>
      <h3>What should be in the report</h3><ul className="coverage-bullets">{item.expectedNonZero.map(text => <li key={text}>{text}</li>)}</ul>
      <h3>What needs to agree</h3><ul className="coverage-bullets">{item.assertions.map(text => <li key={text}>{text}</li>)}</ul>
      <Link to={'/reports?report=' + item.key} className="coverage-primary-link">Open {item.name} <ArrowRight size={14}/></Link>
    </> : <>
      <h3>Situations the company should demonstrate</h3><ul className="coverage-variant-list">{item.variants.map(name => { const variant = comparison?.variants.find(value => value.name === name) || {name,status:'unverified'}; return <li key={name}><span>{name}</span><ChecklistStatus variant={variant}/>{variant.source && <small>{variant.source}{variant.older ? ' · older records' : ''}</small>}</li> })}</ul>
      <p className="coverage-note">“Found” confirms that situation has matching records or settings. “Not checked” means this company check does not establish it; it does not mean the situation is absent.</p>
      {result?.areas?.some(area => area.key === item.key && area.signals?.length) && <Button onClick={() => {onClose();inspectArea(item.key)}}>See the company’s examples <ArrowRight/></Button>}
      {!!related.length && <><h3>Related reports</h3><ul className="coverage-link-list">{related.map(report => <li key={report.key}><Link to={'/reports?report=' + report.key}>{report.name} →</Link></li>)}</ul></>}
    </>}
    <details className="coverage-method"><summary>What needs to be set up first</summary>{Object.entries(isReport ? item.prerequisites : item.requirements).filter(([,values]) => values.length).map(([key,values]) => <div key={key}><h4>{key.replace(/([A-Z])/g,' $1')}</h4><ul className="coverage-bullets">{values.map(text => <li key={text}>{text}</li>)}</ul></div>)}<p>{item.applicability.notes}</p>{(isReport ? item.knownDiscrepancies : item.limitations).map(text => <p key={text}>{text}</p>)}</details>
    <details className="coverage-method"><summary>Technical reference & checking procedure</summary><p>Catalog dated {catalog.asOfDate}. These definitions describe intended coverage, not a new company check.</p><p>Product availability: {item.applicability.status.replaceAll('-',' ')}.</p>{isReport ? <p>Report access: {item.api.status.replaceAll('-',' ')}.</p> : <><p>{item.evidenceMethod}</p><dl>{Object.entries(item.apiOperations).map(([operation,state]) => <div key={operation}><dt>{operation}</dt><dd>{state.replaceAll('-',' ')}</dd></div>)}</dl>{!!item.approvedExclusions.length && <p>Approved exclusions: {item.approvedExclusions.join('; ')}</p>}</>}</details>
  </CoverageDialog>
}
function Targets({ mode, initialFeature, result, query, clearQuery, onModeChange, onInspectArea }) {
  const isReport = mode === 'reports', [group,setGroup] = useState('all'), [selected,setSelected] = useState(initialFeature)
  const comparisons = useMemo(() => featureCoverage(catalog,result),[result])
  const items = isReport ? catalog.reports : catalog.capabilities
  const visible = filterTargets(items,query,group,'all',isReport ? 'report' : 'feature')
  const item = items.find(value => value.key === selected)
  const groups = isReport ? [...new Set(catalog.reports.map(report => report.family))].map(key => [key,key.replaceAll('-',' ')]) : TARGET_GROUPS.map(value => [value.key,value.name])
  return <section aria-label={isReport ? 'Report checklist' : 'Feature checklist'}>
    <div className="coverage-toolbar"><div className="coverage-filters" role="group" aria-label="Checklist type"><button type="button" aria-pressed={!isReport} onClick={() => onModeChange('features')}>Feature checklist</button><button type="button" aria-pressed={isReport} onClick={() => onModeChange('reports')}>Report checklist</button></div><select aria-label="Checklist category" value={group} onChange={event => setGroup(event.target.value)}><option value="all">All categories</option>{groups.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><span className="coverage-toolbar-note">The company’s planned coverage</span></div>
    <div className="coverage-card-grid">{visible.map(value => { const comparison = comparisons.find(row => row.key === value.key); return <article key={value.key} className="coverage-checklist-card"><h2><button type="button" onClick={() => setSelected(value.key)}>{value.name}</button></h2>{isReport ? <><p>{value.businessQuestion}</p><ul className="coverage-bullets">{value.expectedNonZero.slice(0,3).map(text => <li key={text}>{text}</li>)}</ul></> : <ul className="coverage-variant-list">{value.variants.slice(0,4).map(name => <li key={name}><span>{name}</span><ChecklistStatus variant={comparison?.variants.find(v => v.name === name) || {status:'unverified'}}/></li>)}</ul>}<button type="button" className="coverage-text-link" onClick={() => setSelected(value.key)}>{isReport ? 'View checks & dates' : 'All ' + value.variants.length + ' situations'} <ArrowRight size={13}/></button></article>})}</div>
    {!visible.length && <div className="coverage-empty"><h2>No checklist items match these filters</h2><Button variant="outline" onClick={() => {setGroup('all');clearQuery()}}>Show all checklist items</Button></div>}
    {item && <RequirementDetail item={item} isReport={isReport} comparison={comparisons.find(row => row.key === item.key)} result={result} inspectArea={onInspectArea} onClose={() => setSelected(null)}/>}
  </section>
}
export default function CoverageTargets(props) {
  const {user} = useAuth(), connection = props.connection
  const key = [user?.actorId || user?.id || user?._id,connection?.status?.realmId,connection?.environment,connection?.status?.connectionId,connection?.ready,props.mode,props.initialFeature].join(':')
  return <Targets key={key} {...props}/>
}
