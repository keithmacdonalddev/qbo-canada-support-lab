function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable'
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 1) return 'Less than 1 second'
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60)
  if (days) return days + 'd ' + hours + 'h ' + minutes + 'm'
  if (hours) return hours + 'h ' + minutes + 'm'
  if (minutes) return minutes + 'm ' + seconds % 60 + 's'
  return seconds + 's'
}
export default function CaseTiming({ timing }) {
  if (!timing) return null
  if (!timing.available) return <p className="mt-2 text-[12px] text-[var(--ink-3)]">The saved timestamps do not establish this result’s duration.</p>
  const label = timing.running ? 'Since first request' : timing.verifiedResult ? 'First request to verified result' : 'First request to latest result'
  return <div aria-label="Case timing" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--ink-2)]">
    <span title={timing.firstSubmittedAt ? 'First request: ' + new Date(timing.firstSubmittedAt).toLocaleString() : undefined}>{label}: <strong className="font-medium text-[var(--ink)]">{duration(timing.elapsedMs)}</strong></span>
    <span>Latest run: {duration(timing.latestRunMs)}</span>
    <span className="text-[var(--ink-3)]">Includes waiting between attempts.{timing.firstSubmissionSource === 'session_created_estimate' ? ' Start estimated from case creation.' : ''}</span>
  </div>
}
