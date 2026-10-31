import { useState } from 'react'
import { Button } from './ui/button'
import { dateTime } from '../lib/format'
const number = value => Number(value || 0).toLocaleString('en-CA')
const cost = value => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value || 0)
const dollars = value => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0)
// What the same usage would cost at pay-per-use API prices; a range when older Codex reviews lack the cached-input split.
const atApiPrices = value => value ? '≈ ' + dollars(value.lowUsd) + (value.legacyReviews > 0 && dollars(value.highUsd) !== dollars(value.lowUsd) ? '–' + dollars(value.highUsd) : '') + ' at API prices' + (value.unpricedReviews > 0 ? ' + unpriced usage' : '') : ''

export default function BusinessAgentUsage({ usage, qboRequests, disabled, configured, onCommand }) {
  const [editing, setEditing] = useState(false)
  const [apiUsd, setApiUsd] = useState(''), [tokens, setTokens] = useState('')
  const caps = usage?.caps || {}
  function open() { setApiUsd(caps.apiUsd ?? ''); setTokens(caps.tokens ?? ''); setEditing(true) }
  return <section className="bw-usage" id="ai-usage" aria-labelledby="ai-usage-title">
    <div className="bw-panel-heading"><h3 id="ai-usage-title">AI usage & limits</h3><button type="button" className="bw-text-button" disabled={disabled || !configured} onClick={open}>Edit monthly limits</button></div>
    {!usage || usage.unavailable ? <p role="status">Usage history is unavailable. New reviews wait for it to recover; refresh the workspace to try again.</p> : <>
      <div className="bw-usage-periods">{[['today', 'Today'], ['week', 'Last 7 days'], ['month', 'This month']].map(([key, label]) => { const value = usage[key] || {}; return <div key={key}><span>{label}</span><strong>{number(value.totalTokens)} tokens</strong><small>{number(value.reviews)} reviews · {cost(value.estimatedCostUsd)} API spend{value.unpricedReviews > 0 ? ' + unpriced usage' : ''}</small>{value.apiEquivalent && <small>{atApiPrices(value.apiEquivalent)}</small>}</div> })}</div>
      {usage.models?.length ? <ul className="bw-usage-models">{usage.models.map(item => <li key={[item.provider, item.model, item.role, item.billing].join(':')}><strong>{item.provider === 'codex' ? 'Codex' : 'Anthropic'} · {item.model}</strong><span>{item.role} · {number(item.reviews)} reviews · {number(item.totalTokens)} tokens · {item.provider === 'codex' ? (item.billing === 'included in plan' ? 'Included in plan' : 'Billing unverified') + (item.apiEquivalent ? ' · ' + atApiPrices(item.apiEquivalent) : '') : cost(item.estimatedCostUsd) + ' estimated API spend' + (item.unpricedReviews > 0 ? ' + unpriced usage' : '')}</span></li>)}</ul> : <p>No reviews recorded this month. Earlier reviews have no usage history.</p>}
      {usage.latest && <p>Latest review: {usage.latest.role} · {usage.latest.outcome} · {dateTime(usage.latest.finishedAt || usage.latest.startedAt)}</p>}
      {usage.month?.missingUsageReviews > 0 && <p>Some reviews have no reported token count. Totals are incomplete.</p>}
      {qboRequests?.today && <p>QuickBooks requests by this app: {number(qboRequests.today.total)} today · {number(qboRequests.month?.total)} this month (UTC; sync {number(qboRequests.today.attempts?.sync)}, reports {number(qboRequests.today.attempts?.report)}, writes {number(qboRequests.today.attempts?.write)} today).</p>}
    </>}
    <p>Monthly limits: {caps.apiUsd == null ? 'No API spend cap' : cost(caps.apiUsd) + ' API spend'} · {caps.tokens == null ? 'No token cap' : number(caps.tokens) + ' tokens'}.</p>
    {usage?.pause && <div className="bw-notice bw-notice--attention" role="status"><div><strong>{usage.pause.title}</strong><p>{usage.pause.detail}{usage.pause.resetAt && <> Reset: {dateTime(usage.pause.resetAt)}.</>}</p></div></div>}
    {!usage?.pause && <p>Plan limit: {usage?.planLimit?.resetAt ? 'Last reported reset: ' + dateTime(usage.planLimit.resetAt) : 'No active limit reported by Codex.'}</p>}
    {usage?.planLimit && !usage.planLimit.resetAt && <Button size="sm" variant="outline" disabled={disabled} onClick={() => onCommand('retry-plan-limit')}>Check plan again</Button>}
    <p className="bw-provisional">Accountant and specialist reviews only. Calendar days and months use UTC. API spend is the estimated USD cost of Anthropic API-key reviews, and only it counts toward the API spend limit; Codex signed in with ChatGPT is included in your plan; Codex API-key billing is unverified. “At API prices” is a comparison: what the same usage would cost at the provider’s pay-per-use API rates, however it was paid. Codex long-request pricing can’t be assessed, so base rates are used; older Codex reviews, recorded before cached input was tracked, show a range. Limits stop the next model call; an in-flight response can exceed them. History is kept for 180 days.</p>
    {editing && <form className="bw-form" onSubmit={async event => { event.preventDefault(); if (await onCommand('configure-usage', { settings: { apiUsd: apiUsd === '' ? null : Number(apiUsd), tokens: tokens === '' ? null : Number(tokens) } })) setEditing(false) }}>
      <label htmlFor="ai-monthly-usd">Monthly API spend limit (USD)</label><input id="ai-monthly-usd" type="number" min="0" max="100000" step="0.01" placeholder="No limit" value={apiUsd} disabled={disabled} onChange={event => setApiUsd(event.target.value)} />
      <label htmlFor="ai-monthly-tokens">Monthly token limit (all providers)</label><input id="ai-monthly-tokens" type="number" min="0" max="1000000000000" step="1" placeholder="No limit" value={tokens} disabled={disabled} onChange={event => setTokens(event.target.value)} />
      <p>Leave a field blank for no cap. A limit of zero pauses new reviews. Raising or clearing a reached limit lets enabled reviews continue automatically.</p>
      <div className="bw-inline-actions"><Button type="submit" disabled={disabled}>Save monthly limits</Button><Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div>
    </form>}
  </section>
}
