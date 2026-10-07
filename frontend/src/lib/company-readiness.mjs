// A job timestamp is operational history, never an accounting-period watermark.
export function companyReadiness({ ready, result, state, error, now = Date.now() }) {
  if (!ready) return { tone: 'muted', title: 'Waiting on QuickBooks', detail: 'Business completeness can be checked once the company is connected.', gaps: [] }
  if (!result) return { tone: state === 'error' || state === 'unavailable' ? 'attention' : 'muted', title: state === 'error' || state === 'unavailable' ? 'Business activity could not be checked' : 'Checking business activity…', detail: error || null, loading: ['loading', 'checking'].includes(state), gaps: [] }
  const signals = (result.areas || []).flatMap(area => (area.signals || []).map(signal => ({ ...signal, areaKey: area.key, areaName: area.name })))
  const gaps = signals.filter(signal => ['stale', 'missing'].includes(signal.status))
  const unanswered = signals.filter(signal => ['error', 'manual'].includes(signal.status)).length
  const checkedAt = new Date(result.checkedAt).getTime()
  const stale = !Number.isFinite(checkedAt) || now - checkedAt > 10 * 60 * 1000 || checkedAt > now + 60000
  const incomplete = result.evidence?.complete !== true
  const cannotConfirm = state === 'error' || state === 'unavailable' || incomplete || stale
  return {
    tone: 'attention',
    title: gaps.length ? 'Business activity needs attention' : cannotConfirm ? 'Business completeness is not verified' : 'Activity checks passed; completeness is not verified',
    detail: gaps.length ? gaps.length + ' activity or setup gaps found in the latest check. These need review against the business plan.' : 'Recent records alone do not establish a complete business history.',
    gaps, unanswered, stale, incomplete,
    checkFailed: state === 'error' || state === 'unavailable',
    asOf: result.asOf,
    // Until actual durable calendar and reconciliation evidence is connected,
    // these remain explicitly unverified even when all feature signals pass.
    calendarVerified: false,
    reportsVerified: false,
  }
}
