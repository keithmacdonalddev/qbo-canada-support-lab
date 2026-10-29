// The four promises the business operator keeps, judged from saved workspace and coverage reads.
import { ageLabel, syncPresentation } from './business-workspace.mjs'
import { featureName } from './coverage-features.mjs'

const time = value => { const stamp = value ? new Date(value).getTime() : NaN; return Number.isFinite(stamp) ? stamp : null }
const clock = value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = value => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's')

export function runningPromise(data, now) {
  const settings = data?.settings || {}, agent = data?.agent || {}
  const last = time(agent.lastDecisionAt), next = time(agent.nextDecisionAt)
  const interval = (Number(settings.decisionIntervalMinutes) || 60) * 60000
  const base = { key: 'running', name: 'Keeps running' }
  if (!settings.monitoring) return { ...base, state: 'broken', verdict: 'Not running', headline: 'The business is not running.', detail: 'Monitoring is off, so nothing is happening in the business.', action: 'Start monitoring', target: 'directions' }
  if (!settings.autonomous) return { ...base, state: 'broken', verdict: 'Paused', headline: 'The business is paused.', detail: 'The accountant is not making business decisions until you resume it.', action: 'Resume the accountant', target: 'directions' }
  if (agent.lastError || ['blocked', 'error'].includes(agent.status)) return { ...base, state: 'broken', verdict: 'Stopped by a problem', headline: 'The business stopped because of a problem.', detail: agent.lastError || 'The accountant reported a problem on its last review.', action: 'See what happened', target: 'activity' }
  if (last && now - last > interval * 2 + 10 * 60000) return { ...base, state: 'broken', verdict: 'Overdue', headline: 'The accountant is overdue for its next review.', detail: 'Last review was ' + ageLabel(last, now).toLowerCase() + '. It should review every ' + (interval / 60000) + ' minutes.', action: 'See activity', target: 'activity' }
  if (!last) return { ...base, state: 'waiting', verdict: 'Starting up', detail: 'The first business review has not finished yet.', action: 'See activity', target: 'activity' }
  return { ...base, state: 'kept', verdict: 'Working', detail: 'Last review ' + ageLabel(last, now).toLowerCase() + (next && next > now ? ' · next at ' + clock(next) : '') + '.', action: 'See activity', target: 'activity' }
}

export function correctPromise(data, now) {
  const sync = syncPresentation(data?.sync, data?.settings || {}, now)
  const blockers = Array.isArray(data?.business?.blockers) ? data.business.blockers : []
  const failing = sync.sources.filter(source => source.error || source.lastError || ['error', 'blocked', 'saturated'].includes(source.status))
  const verified = data?.business?.verifiedThrough
  const base = { key: 'correct', name: 'Stays correct in QuickBooks' }
  if (blockers.length) {
    const first = blockers[0]
    return { ...base, state: 'broken', verdict: plural(blockers.length, 'problem') + ' to review', headline: 'The books have ' + plural(blockers.length, 'problem') + ' to review.', detail: typeof first === 'string' ? first : first.title || first.message || first.label || 'Business work needs review.', action: 'Review the problem', target: 'manage' }
  }
  if (failing.length) return { ...base, state: 'broken', verdict: 'Can’t read ' + plural(failing.length, 'record type'), headline: 'QuickBooks can’t be fully read right now.', detail: failing.slice(0, 2).map(source => source.entity || source.name).join(', ') + ' could not be read from QuickBooks. Work waits until it can.', action: 'See sync details', target: 'activity' }
  if (sync.tone !== 'good') return { ...base, state: 'waiting', verdict: sync.label, detail: sync.detail, action: 'See sync details', target: 'activity' }
  return { ...base, state: 'kept', verdict: verified ? 'Checked through ' + day(verified) : 'In sync', detail: 'All ' + sync.sources.length + ' record types match QuickBooks and no writes are unresolved.', action: 'See sync details', target: 'activity' }
}

export function featuresPromise(coverage) {
  const base = { key: 'features', name: 'Uses QuickBooks features' }
  if (coverage === undefined) return { ...base, state: 'waiting', verdict: 'Checking…', detail: 'Reading the last feature check.', action: 'Open coverage', target: 'coverage' }
  if (!coverage) return { ...base, state: 'unknown', verdict: 'Not checked yet', detail: 'Run a feature check to see which QuickBooks features the business uses.', action: 'Open coverage', target: 'coverage' }
  const signals = (coverage.areas || []).flatMap(area => area.signals || []).filter(signal => ['ok', 'stale', 'missing'].includes(signal.status))
  const used = signals.filter(signal => signal.status === 'ok'), stale = signals.filter(signal => signal.status === 'stale'), missing = signals.filter(signal => signal.status === 'missing')
  const verdict = used.length + ' of ' + signals.length + ' in use'
  if (!signals.length) return { ...base, state: 'unknown', verdict: 'Not checked yet', detail: 'The last feature check measured nothing.', action: 'Open coverage', target: 'coverage' }
  if (!stale.length && !missing.length) return { ...base, state: 'kept', verdict, detail: 'Every measured feature has been used recently.', action: 'Open coverage', target: 'coverage' }
  const named = [...stale, ...missing].slice(0, 2).map(featureName).join(' and ')
  const parts = [stale.length && plural(stale.length, 'feature') + ' going unused', missing.length && plural(missing.length, 'feature') + ' never used'].filter(Boolean).join(' · ')
  return { ...base, state: 'attention', verdict, detail: parts + '. Next up: ' + named + '.', action: 'See all features', target: 'coverage' }
}

export function realismPromise() {
  return { key: 'realism', name: 'Behaves like a real business', state: 'unknown', verdict: 'Not measured yet', detail: 'Will check that payroll, rent, billing and restocks land on their dates and the numbers stay in realistic ranges.', action: null, target: null }
}

export function businessPromises(data, coverage, now = Date.now()) {
  const promises = [runningPromise(data, now), correctPromise(data, now), featuresPromise(coverage), realismPromise()]
  const broken = promises.filter(item => item.state === 'broken'), attention = promises.filter(item => item.state === 'attention')
  const kept = promises.filter(item => item.state === 'kept'), unknown = promises.filter(item => ['unknown', 'waiting'].includes(item.state))
  let headline
  if (broken.length) headline = broken.length === 1 ? broken[0].headline : broken.length + ' promises are broken. ' + broken[0].headline
  else if (attention.length) headline = 'Nothing is broken. ' + attention[0].detail.split('. Next up')[0] + '.'
  else headline = kept.length === promises.length ? 'All four promises are holding.' : kept.length + ' of ' + promises.length + ' promises are holding.'
  return { promises, headline, tone: broken.length ? 'broken' : attention.length ? 'attention' : 'kept', unknown: unknown.length }
}
