import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Bot, Check, CheckCircle2, CircleDashed, Clock3, Hand, LoaderCircle, OctagonPause, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { Button } from './ui/button'
import { dateTime, timeOfDay } from '../lib/format'

// Only 'working' animates: the server sends it solely while something is happening now
// (a review in progress, catching up with QuickBooks, or an operation sending records).
// 'on-duty' is a standing responsibility that is enabled but idle until its next review.
const STATES = { working: ['Working', LoaderCircle], 'on-duty': ['On duty', ShieldCheck], waiting: ['Up next', CircleDashed], blocked: ['Blocked', OctagonPause], done: ['Done', CheckCircle2] }

// The business work list from the server: the owner sees only what needs a
// person; everything else is the accountant's job, shown with its status.
export default function BusinessWork({ work, rightNow, now, disabled, onAction }) {
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
    <RightNow value={rightNow} now={now} />
    <ol className="bwk-list">
      {theirs.map(item => {
        const [label, Icon] = STATES[item.state] || STATES.waiting
        const animate = item.state === 'working'
        return <li key={item.key} className={'bwk-item bwk-item--' + item.state}>
          <span className="bwk-state"><Icon aria-hidden="true" className={animate ? 'animate-spin' : ''} />{label}</span>
          <div className="bwk-body">
            <h3>{item.title}</h3>
            {item.facts && <p className="bwk-facts">{item.facts}</p>}
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

const ROLE_NAMES = { receivables: 'Receivables specialist', payables: 'Payables specialist', inventory: 'Inventory specialist' }
const STEP_ICONS = { running: LoaderCircle, done: Check, failed: X }
const stamp = value => { const time = value ? new Date(value).getTime() : NaN; return Number.isFinite(time) ? time : null }
function minutes(ms) {
  const total = Math.max(0, Math.round(ms / 60000))
  if (total < 1) return 'under a minute'
  if (total < 60) return total + ' min'
  return Math.floor(total / 60) + ' h' + (total % 60 ? ' ' + (total % 60) + ' min' : '')
}
function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString() }
function when(value, clock) { return sameDay(value, clock) ? timeOfDay(value) : dateTime(value) }

// What the accountant is doing at this moment, from the server's rightNow state.
function rightNowLine(value, clock) {
  const next = stamp(value.nextReviewAt), started = stamp(value.startedAt)
  switch (value.state) {
    case 'reviewing': return [LoaderCircle, (ROLE_NAMES[value.role] ? ROLE_NAMES[value.role] + ' reviewing' : 'Reviewing') + ' now', started === null ? '' : clock - started < 60000 ? 'started just now' : 'started ' + minutes(clock - started) + ' ago']
    case 'paused': return [OctagonPause, 'Paused', 'nothing new happens until you resume the accountant']
    case 'stopped': return [OctagonPause, 'Stopped', 'company monitoring is off']
    case 'usage-paused': return [OctagonPause, 'Paused for its AI usage limit', next ? 'reviews resume ' + when(next, clock) : 'reviews wait until the limit allows them']
    case 'catching-up': return [RefreshCw, 'Catching up with QuickBooks', 'the next review starts once every record type is current']
    case 'recovering': return [RefreshCw, 'Recovering', 'picking up where the last review stopped']
    default: return [Clock3, 'Idle', next === null ? 'next review is queued' : next <= clock ? 'next review starting shortly' : 'next review at ' + when(next, clock) + ' (in ' + minutes(next - clock) + ')']
  }
}
function RightNow({ value, now }) {
  const [mountedAt] = useState(Date.now)
  if (!value || value.state === 'not-configured') return null
  const clock = now ?? mountedAt
  const [Icon, title, detail] = rightNowLine(value, clock)
  const reviewing = value.state === 'reviewing', last = stamp(value.lastReviewAt)
  return <div className={'bwk-now bwk-now--' + value.state} role="group" aria-label="Right now">
    <span className="bwk-now-eyebrow">Right now</span>
    <p className="bwk-now-line"><Icon aria-hidden="true" className={reviewing ? 'animate-spin' : ''} /><strong>{title}</strong>{detail && <span> · {detail}</span>}</p>
    {reviewing ? (value.steps?.length ? <ol className="bwk-steps" aria-label="Latest steps, newest first">
      {value.steps.map((step, index) => {
        const StepIcon = STEP_ICONS[step.status] || Check
        return <li key={(step.at || '') + index} className={'bwk-step bwk-step--' + step.status}>
          <StepIcon aria-hidden="true" className={step.status === 'running' ? 'animate-spin' : ''} />
          <span>{step.label}{step.status === 'failed' && <em> · did not finish</em>}{step.status === 'running' && <span className="bw-sr-only"> (in progress)</span>}</span>
          {step.at && <time dateTime={step.at}>{timeOfDay(step.at)}</time>}
        </li>
      })}
      {value.earlierSteps > 0 && <li className="bwk-step bwk-step--earlier"><span>+{value.earlierSteps} earlier {value.earlierSteps === 1 ? 'step' : 'steps'} in this review</span></li>}
    </ol> : <p className="bwk-now-last">Reading the business and deciding what to do first.</p>)
      : <p className="bwk-now-last">{last === null ? 'No business review has finished yet.' : 'Last review ' + when(last, clock) + (value.lastSummary ? ': ' + value.lastSummary : '.')}</p>}
  </div>
}
