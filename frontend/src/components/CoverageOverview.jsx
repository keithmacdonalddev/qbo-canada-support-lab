import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, FileText, Layers3, RefreshCw } from 'lucide-react'
import { coveragePriorities, FOCUS_AREAS } from '@/lib/coverage-priorities.mjs'
import { measuredAreas, relativeTime } from './coverage'

export default function CoverageOverview({ result, state, reports, history, reportsFailed, pending, focus, setFocus, recent, onOpen }) {
  const candidates = useMemo(() => coveragePriorities({areas:measuredAreas(result),reports,history,focus,state,reportsFailed,recent}),[result,reports,history,focus,state,reportsFailed,recent])
  // Keep the displayed choices still while asynchronous reads finish. Updating is explicit.
  const [snapshot,setSnapshot] = useState(() => result ? candidates : null)
  if (!snapshot && result) setSnapshot(candidates)
  const choices = snapshot || candidates
  const changed = snapshot && JSON.stringify(snapshot) !== JSON.stringify(candidates)
  const lead = choices.spotlight
  if (!result) return <section className="coverage-start-empty"><Layers3 size={30}/><h2>{state === 'disconnected' ? 'Connect a company to explore its test data' : state === 'loading' || state === 'checking' ? 'Opening your company’s examples…' : 'See what your company can demonstrate'}</h2><p>{state === 'error' ? 'The saved company check could not be loaded.' : 'Examples, saved reports and unfinished work will appear here from your company’s actual results.'}</p>{state === 'disconnected' ? <Link className="coverage-primary-link" to="/company">Open Company <ArrowRight size={16}/></Link> : !['loading','checking'].includes(state) && <button className="coverage-primary-link" onClick={() => onOpen({view:'examples'})}>Open company check <ArrowRight size={16}/></button>}</section>
  return <section className="coverage-overview" aria-label="Suggested next steps">
    <div className="coverage-interest"><label htmlFor="coverage-focus">Working on</label><select id="coverage-focus" value={focus} onChange={event => setFocus(event.target.value)}><option value="all">The whole company</option>{FOCUS_AREAS.map(area => <option key={area.key} value={area.key}>{area.name}</option>)}</select><span className="coverage-observed">Company checked {relativeTime(result.checkedAt)}</span>{changed && <button className="coverage-update" onClick={() => setSnapshot(candidates)}><RefreshCw size={12}/> Update suggestions</button>}</div>
    <div className="coverage-start-layout">
      {lead ? <article className={'coverage-spotlight is-' + lead.kind}>
        <div className="coverage-spotlight-label">{lead.kind === 'example' ? <><Check size={15}/> Available to explore</> : <>Needs a closer look</>}</div>
        <h2>{lead.title}</h2><p>{lead.reason}</p>
        {lead.proof && <div className="coverage-proof">{lead.proof}</div>}
        <button className="coverage-spotlight-action" onClick={() => onOpen(lead.target)}>{lead.action}<ArrowRight size={18}/></button>
        <div className="coverage-spotlight-context"><span>{lead.kind === 'example' ? 'From the saved company check' : 'From saved company results'}</span><details><summary>Why this?</summary><p>{lead.kind === 'example' ? 'This example has matching data and demonstrates a specific business situation. Your chosen work area narrows the suggestions.' : 'A recorded failure or unfinished period takes priority. This suggestion does not run or change anything.'}</p></details></div>
      </article> : <article className="coverage-spotlight"><div className="coverage-spotlight-label">This work area</div><h2>No confirmed examples yet</h2><p>See what is missing, what needs setup, and what must be checked in QuickBooks.</p><button className="coverage-spotlight-action" onClick={() => onOpen({view:'examples',group:focus})}>Inspect this area <ArrowRight size={18}/></button></article>}
      <aside className="coverage-next-up" aria-label="Other useful next steps"><h2>Worth a look</h2>{choices.actions.map(item => <button key={item.key} className={'coverage-priority is-' + item.kind} onClick={() => onOpen(item.target)}><span className="coverage-priority-kind">{item.kind === 'report' ? 'Reports' : item.kind === 'gap' ? 'Missing examples' : item.kind === 'resume' ? 'Your recent work' : item.kind === 'history' ? 'Business history' : 'Needs attention'}</span><strong>{item.title}</strong><span className="coverage-priority-reason">{item.reason}</span><span className="coverage-priority-action">{item.action}<ArrowUpRight size={15}/></span></button>)}{!choices.actions.length && <div className="coverage-quiet"><FileText size={20}/><p>{pending ? 'Loading saved report checks…' : 'No additional actions surfaced for this area.'}</p><button onClick={() => onOpen({view:'report-results'})}>Explore reports <ArrowRight size={14}/></button></div>}</aside>
    </div>
    {choices.alternatives.length > 0 && <div className="coverage-alternatives"><span>Also available</span>{choices.alternatives.map(item => <button key={item.key} onClick={() => onOpen(item.target)}><span>{item.title}</span><small>{item.proof}</small><ArrowRight size={16}/></button>)}</div>}
    <details className="coverage-area-directory"><summary>Browse another part of the company <ChevronDown size={15}/></summary><div>{FOCUS_AREAS.map(area => <button key={area.key} onClick={() => {setFocus(area.key)}}>{area.name}<ArrowRight size={14}/></button>)}</div></details>
  </section>
}
