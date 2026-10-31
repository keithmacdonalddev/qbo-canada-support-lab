import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowDown, ArrowRight, Brain, Check, Circle, Clock3, Coins, LoaderCircle, MessageSquare, OctagonPause, RefreshCw, Send, Wrench, X } from 'lucide-react'
import { dateTime, timeOfDay } from '../lib/format'
import { recordLink } from '../lib/business-workspace.mjs'

const ROLE_NAMES = { receivables: 'Receivables specialist', payables: 'Payables specialist', inventory: 'Inventory specialist' }
const stamp = value => { const time = value ? new Date(value).getTime() : NaN; return Number.isFinite(time) ? time : null }
function minutes(ms) {
  const total = Math.max(0, Math.round(ms / 60000))
  if (total < 1) return 'under a minute'
  if (total < 60) return total + ' min'
  return Math.floor(total / 60) + ' h' + (total % 60 ? ' ' + (total % 60) + ' min' : '')
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()
const when = (value, clock) => sameDay(value, clock) ? timeOfDay(value) : dateTime(value)
function clockTime(value, clock) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return sameDay(value, clock) ? time : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + time
}
const number = value => Number.isFinite(Number(value)) && value !== null ? Number(value).toLocaleString() : null

// The one-line "now" statement. The feed knows about reviews and sends as they happen;
// the workspace status knows pauses, limits, catch-up and the next review time.
// Cadence kinds that mean work is due now or straight after the current step.
const CONTINUOUS = new Set(['slice', 'obligations', 'recovery', 'catch-up', 'management', 'owner', 'poll'])
function nowLine(feed, rightNow, clock) {
  const next = stamp(rightNow?.nextReviewAt), reason = rightNow?.cadence?.reason
  // Either source may notice a review first; both polls catch up within seconds.
  if (feed?.state === 'reviewing' || rightNow?.state === 'reviewing') {
    const started = stamp(feed?.startedAt || rightNow?.startedAt), role = ROLE_NAMES[feed?.role || rightNow?.role]
    return { tone: 'working', Icon: LoaderCircle, spin: true, title: role ? role + ' is reviewing' : 'Reviewing the business', detail: [started === null ? '' : 'started ' + timeOfDay(started), feed?.reason].filter(Boolean).join(' · ') }
  }
  if (feed?.state === 'sending') {
    const sending = feed.sending
    return { tone: 'working', Icon: LoaderCircle, spin: true, title: 'Sending records to QuickBooks', detail: sending && sending.total ? sending.done + ' of ' + sending.total + ' records done' : 'checking each record as it is saved' }
  }
  switch (rightNow?.state) {
    case 'paused': return { tone: 'held', Icon: OctagonPause, title: 'Paused', detail: 'nothing new happens until you resume the accountant' }
    case 'stopped': return { tone: 'held', Icon: OctagonPause, title: 'Stopped', detail: 'company monitoring is off' }
    case 'usage-paused': return { tone: 'held', Icon: OctagonPause, title: 'Paused for its AI usage limit', detail: next ? 'reviews resume ' + when(next, clock) : 'reviews wait until the limit allows them' }
    case 'catching-up': return { tone: 'working', Icon: RefreshCw, title: 'Catching up with QuickBooks', detail: 'the next review starts once every record type is current' }
    case 'recovering': return { tone: 'working', Icon: RefreshCw, title: 'Recovering', detail: 'picking up where the last review stopped' }
    default: {
      // The accountant works back to back while anything is due; otherwise it is paused, with the exact reason.
      const due = next === null ? 'next step is queued' : next <= clock ? 'next step starting now' : 'next step in ' + minutes(next - clock)
      if (CONTINUOUS.has(rightNow?.cadence?.kind)) return { tone: 'working', Icon: Activity, title: 'Working continuously', detail: due + (reason ? ' · ' + reason : '') }
      return { tone: 'idle', Icon: Clock3, title: 'Paused', detail: (reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Nothing is due right now') + (next === null ? '' : next <= clock ? ' · checking again now' : ' · checks again at ' + when(next, clock)) }
    }
  }
}
// "Today (Fri Oct 30): 20 planned · 7 in QuickBooks", or the calendar catch-up state, from the server.
function todayLine(rightNow) {
  if (rightNow?.calendar) return 'Calendar closed through ' + (rightNow.calendar.closedThrough || 'its opening') + ' · closing ' + rightNow.calendar.closing
  return rightNow?.today?.line || ''
}

// One timeline, oldest first: the review session transcript plus the runner's record lines and
// key events. Review-step summaries are left out when the full session is shown.
function timeline(feed, transcript) {
  const entries = transcript?.entries || []
  const items = Array.isArray(feed?.items) ? feed.items : []
  const first = entries.length ? stamp(entries[0].at) : null, last = entries.length ? stamp(entries.at(-1).at) : null
  const inWindow = item => {
    if (transcript?.following !== false || first === null) return true
    const at = stamp(item.at)
    return at !== null && at >= first - 60000 && at <= last + 600000
  }
  const rows = [
    ...entries.map(entry => ({ id: 't:' + entry.attemptId + ':' + entry.seq, at: stamp(entry.at) ?? 0, order: entry.seq, entry })),
    ...items.filter(item => !(entries.length && (item.kind === 'review-step' || item.kind === 'review')) && inWindow(item)).map(item => ({ id: 'f:' + item.id, at: stamp(item.at) ?? 0, order: 0, item })),
  ]
  return rows.sort((a, b) => a.at - b.at || a.order - b.order)
}

const ITEM_ICONS = { running: LoaderCircle, done: Check, failed: X, attention: AlertTriangle, info: Circle }
function FeedRow({ item, clock }) {
  const Icon = ITEM_ICONS[item.status] || Check
  return <li className={'bwl-item bwl-item--' + item.status + ' bwl-item--' + item.kind}>
    <time dateTime={item.at}>{clockTime(item.at, clock)}</time>
    <Icon aria-hidden="true" className={item.status === 'running' ? 'animate-spin' : ''} />
    <div>
      <span className="bwl-text">{item.record ? <Link to={recordLink(item.record)}>{item.text}</Link> : item.text}{item.by === 'owner' && <em> · you</em>}</span>
      {item.outcome && <span className="bwl-outcome"> — {item.outcome}</span>}
      {item.status === 'running' && <span className="bw-sr-only"> (in progress)</span>}
      {item.detail && <p>{item.detail}</p>}
      {item.kind === 'operation' && item.id.endsWith(':planned') && <Link className="bwl-inspect" to="/company/manage">Inspect<ArrowRight aria-hidden="true" /></Link>}
    </div>
  </li>
}
// Long bodies open truncated, with the rest one click away.
function Body({ text, limit = 1500 }) {
  const [all, setAll] = useState(false)
  if (!text) return null
  const long = text.length > limit
  return <><pre className="bwl-pre">{all || !long ? text : text.slice(0, limit) + '…'}</pre>{long && <button type="button" className="bw-text-button bwl-more" onClick={() => setAll(value => !value)}>{all ? 'Show less' : 'Show more (' + Math.round(text.length / 1024) + ' KB)'}</button>}</>
}
function compact(json) {
  try { const text = JSON.stringify(JSON.parse(json)); return text.length > 110 ? text.slice(0, 109) + '…' : text } catch { return '' }
}
function usageText(json) {
  let value = {}; try { value = JSON.parse(json) || {} } catch { /* shown as unavailable */ }
  const cached = number(value.cachedInputTokens ?? value.cacheReadTokens)
  return ['Tokens', number(value.inputTokens) && number(value.inputTokens) + ' in' + (cached && cached !== '0' ? ' (' + cached + ' cached)' : ''), number(value.outputTokens) && number(value.outputTokens) + ' out', value.stopReason && 'stop: ' + value.stopReason].filter(Boolean).join(' · ')
}
const OUTCOMES = { completed: 'Review finished', incomplete: 'Review finished early', yielded: 'Review paused to refresh company data', cancelled: 'Review stopped', failed: 'Review needs attention', 'plan-limit': 'Review paused at the plan limit', 'cap-reached': 'Review paused at the usage cap', truncated: 'Transcript limit reached' }
function EntryRow({ entry, clock }) {
  const time = <time dateTime={entry.at}>{clockTime(entry.at, clock)}</time>
  const truncated = entry.truncated ? <small className="bwl-cut"> (shortened for storage)</small> : null
  switch (entry.kind) {
    case 'context': return <li className="bwl-entry bwl-entry--context">{time}<Send aria-hidden="true" /><details><summary>Sent to the model{entry.provider ? ' (' + entry.provider + (entry.name ? ' · ' + entry.name : '') + ')' : ''}: instructions, business context and tools</summary><Body text={entry.text} limit={4000} />{truncated}</details></li>
    case 'reasoning': return <li className="bwl-entry bwl-entry--reasoning">{time}<Brain aria-hidden="true" /><div><span className="bwl-label">Thinking</span><p>{entry.text}</p>{truncated}</div></li>
    case 'message': return <li className="bwl-entry bwl-entry--message">{time}<MessageSquare aria-hidden="true" /><div><p>{entry.text}</p>{truncated}</div></li>
    case 'tool-call': return <li className="bwl-entry bwl-entry--call">{time}<Wrench aria-hidden="true" /><details><summary><strong>{entry.name || 'tool'}</strong> <code>{compact(entry.json)}</code></summary><Body text={entry.json} />{truncated}</details></li>
    case 'tool-result': return <li className={'bwl-entry bwl-entry--result bwl-entry--' + (entry.status || 'ok')}>{time}{entry.status === 'ok' ? <Check aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<details><summary>{entry.name || 'tool'} {entry.status === 'ok' ? 'returned' : entry.status === 'failed' ? 'returned an error' : 'stopped'}{entry.json ? ' · ' + Math.max(1, Math.round(entry.json.length / 1024)) + ' KB' : ''}</summary><Body text={entry.json || entry.text} />{truncated}</details></li>
    case 'usage': return <li className="bwl-entry bwl-entry--usage">{time}<Coins aria-hidden="true" /><span>{usageText(entry.json)}</span></li>
    default: return <li className={'bwl-entry bwl-entry--outcome bwl-entry--' + (entry.status || 'done')}>{time}{entry.status === 'completed' ? <Check aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<div><strong>{OUTCOMES[entry.status] || 'Review ended'}</strong>{entry.text && <p>{entry.text}</p>}</div></li>
  }
}
function attemptLabel(row, clock) {
  return clockTime(row.startedAt, clock) + ' · ' + (ROLE_NAMES[row.role] || 'Main accountant') + (row.outcome ? ' · ' + (OUTCOMES[row.outcome] || row.outcome).replace(/^Review /, '') : ' · in progress')
}

// The live panel at the top of the first page: what the accountant is doing now, its session as
// it streams (reasoning, messages, tool calls and results) and every record sent to QuickBooks.
// Fixed height so updates never move the rest of the page; it follows the newest line unless
// the owner scrolls up.
export default function BusinessLive({ feed, failed, transcript, rightNow, now }) {
  const [mountedAt] = useState(Date.now)
  const list = useRef(null), stick = useRef(true)
  const [behind, setBehind] = useState(false)
  const rows = rightNow && rightNow.state !== 'not-configured' ? timeline(feed, transcript) : []
  const lastId = rows.at(-1)?.id
  useLayoutEffect(() => {
    const node = list.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [lastId, rows.length])
  useEffect(() => { stick.current = true }, [transcript?.attemptId])
  if (!rightNow || rightNow.state === 'not-configured') return null
  const clock = now ?? mountedAt
  const line = nowLine(feed, rightNow, clock), today = todayLine(rightNow), NowIcon = line.Icon
  const live = line.tone === 'working'
  const sending = feed?.state === 'sending' && feed.sending?.total ? Math.min(100, Math.round(100 * feed.sending.done / feed.sending.total)) : null
  const attempts = transcript?.attempts || []
  const onScroll = event => { const node = event.currentTarget; const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 24; stick.current = atEnd; setBehind(!atEnd) }
  const jump = () => { const node = list.current; if (node) { node.scrollTop = node.scrollHeight; stick.current = true; setBehind(false) } }
  const status = failed ? 'Reconnecting…' : transcript?.mode === 'streaming' ? 'Streaming' : transcript?.mode === 'polling' ? 'Updating every 2 s' : feed?.asOf ? 'Updated ' + clockTime(feed.asOf, clock) : ''
  return <section className={'bwl bwl--' + line.tone} aria-labelledby="business-live-title">
    <header className="bwl-head">
      <h2 id="business-live-title"><span className={'bwl-pulse' + (live ? ' bwl-pulse--on' : '')} aria-hidden="true" />Live</h2>
      <p className="bwl-now" aria-live="polite"><NowIcon aria-hidden="true" className={line.spin ? 'animate-spin' : ''} /><strong>{line.title}</strong>{line.detail && <span> · {line.detail}</span>}</p>
      <div className="bwl-tools">
        {attempts.length > 0 && <><label className="bw-sr-only" htmlFor="business-live-review">Review to show</label><select id="business-live-review" value={transcript.following ? '' : transcript.attemptId || ''} onChange={event => transcript.select(event.target.value || null)}><option value="">Follow the latest review</option>{attempts.map(row => <option key={row.attemptId} value={row.attemptId}>{attemptLabel(row, clock)}</option>)}</select></>}
        <span className="bwl-updated">{status}</span>
      </div>
    </header>
    <div className="bwl-sub">
      <span>{today}</span>
      {sending !== null && <span className="bwl-bar" role="progressbar" aria-label="Records sent" aria-valuemin={0} aria-valuemax={100} aria-valuenow={sending}><span style={{ width: sending + '%' }} /></span>}
    </div>
    <div className="bwl-feed" ref={list} onScroll={onScroll} tabIndex={0} aria-label="Accountant activity, oldest first">
      {rows.length ? <ol>
        {rows.map(row => row.entry ? <EntryRow key={row.id} entry={row.entry} clock={clock} /> : <FeedRow key={row.id} item={row.item} clock={clock} />)}
      </ol> : <p className="bwl-empty">{!feed ? failed ? 'Live activity could not be read yet. Retrying automatically.' : 'Loading the latest activity…' : 'Nothing recorded yet. The accountant’s next review appears here as it happens: what it reads, what it decides and every record it sends to QuickBooks.'}</p>}
    </div>
    {behind && <button type="button" className="bwl-jump" onClick={jump}><ArrowDown aria-hidden="true" />Scrolling paused · jump to latest</button>}
    {feed?.stale && <p className="bwl-stale">Showing the last activity read. New activity appears once the next read succeeds.</p>}
  </section>
}
