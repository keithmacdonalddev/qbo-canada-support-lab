import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Bot, CheckCircle2, CircleDashed, Hand, LoaderCircle, OctagonPause } from 'lucide-react'
import { Button } from './ui/button'

const STATES = { working: ['Working', LoaderCircle], waiting: ['Up next', CircleDashed], blocked: ['Blocked', OctagonPause], done: ['Done', CheckCircle2] }

// The business work list from the server: the owner sees only what needs a
// person; everything else is the accountant's job, shown with its status.
export default function BusinessWork({ work, disabled, onAction }) {
  const navigate = useNavigate()
  if (!work) return null
  const mine = work.items.filter(item => item.owner === 'owner' && item.state === 'needs-owner')
  const optional = work.items.filter(item => item.owner === 'owner' && item.state === 'optional')
  const theirs = work.items.filter(item => item.owner === 'accountant')
  const act = action => action.kind === 'link' ? navigate(action.href) : onAction(action.kind)
  return <section className={'bwk' + (mine.length ? ' bwk--owner' : '')} aria-labelledby="business-work-title">
    <h2 id="business-work-title">{work.headline}</h2>
    {mine.length > 0 && <div className="bwk-owner" role="group" aria-label="Needs you">
      {mine.map(item => <article key={item.key} className="bwk-owner-item">
        <Hand aria-hidden="true" />
        <div><h3>{item.title}</h3><p>{item.detail}</p></div>
        {item.action && <Button disabled={disabled && item.action.kind !== 'link'} onClick={() => act(item.action)}>{item.action.label}<ArrowRight /></Button>}
      </article>)}
    </div>}
    <div className="bwk-list-head"><Bot aria-hidden="true" /><span>The accountant’s work</span><Link to="/company/accountant/tools" className="bw-text-button bwk-tools-link">Its tools and what it can do<ArrowRight /></Link></div>
    <ol className="bwk-list">
      {theirs.map(item => {
        const [label, Icon] = STATES[item.state] || STATES.waiting
        return <li key={item.key} className={'bwk-item bwk-item--' + item.state}>
          <span className="bwk-state"><Icon aria-hidden="true" className={item.state === 'working' ? 'animate-spin' : ''} />{label}</span>
          <div className="bwk-body">
            <h3>{item.title}</h3>
            {item.detail && <p>{item.detail}</p>}
            {item.features?.length > 0 && <ul className="bwk-features" aria-label="Features to use">{item.features.slice(0, 8).map(feature => <li key={feature.key} className={'bwk-feature bwk-feature--' + feature.status}>{feature.name}</li>)}{item.features.length > 8 && <li className="bwk-feature">+{item.features.length - 8} more</li>}</ul>}
            {(item.next || item.href) && <small>{item.next}{item.href && <> <Link to={item.href}>Inspect</Link></>}</small>}
          </div>
        </li>
      })}
      {!theirs.length && <li className="bwk-item bwk-item--done"><span className="bwk-state"><CheckCircle2 aria-hidden="true" />Done</span><div className="bwk-body"><h3>Nothing outstanding</h3><p>The accountant is keeping the business running.</p></div></li>}
    </ol>
    {optional.map(item => <div key={item.key} className="bwk-optional"><span>{item.title}. {item.detail}</span>{item.action && <button type="button" className="bw-text-button" onClick={() => act(item.action)}>{item.action.label}<ArrowRight /></button>}</div>)}
  </section>
}
