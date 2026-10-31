const stamp = value => { const ms = value ? new Date(value).getTime() : NaN; return Number.isFinite(ms) ? ms : null }
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Not recorded'
  if (ms < 1000) return Math.round(ms) + ' ms'
  const seconds = Math.floor(ms / 1000)
  return [seconds >= 3600 ? Math.floor(seconds / 3600) + 'h' : '', seconds >= 60 ? Math.floor(seconds / 60) % 60 + 'm' : '', seconds % 60 + 's'].filter(Boolean).join(' ')
}
export function usdText(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable'
  if (value > 0 && value < 0.0001) return '<$0.0001'
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
}
export function costText(cost) {
  if (!cost || !Number.isFinite(cost.lowUsd) || !Number.isFinite(cost.highUsd)) return 'Unavailable'
  return cost.lowUsd === cost.highUsd ? usdText(cost.lowUsd) : usdText(cost.lowUsd) + '–' + usdText(cost.highUsd)
}
// A tool's timestamp pair measures that tool. Tokens/cost belong to its review, never to each row.
export function transcriptMetadata(entry, entries, review = null, unavailable = false) {
  let timing = null
  if (entry.kind === 'tool-call' || entry.kind === 'tool-result') {
    const call = entries.find(value => value.attemptId === entry.attemptId && value.callId && value.callId === entry.callId && value.kind === 'tool-call')
    const result = entries.find(value => value.attemptId === entry.attemptId && value.callId && value.callId === entry.callId && value.kind === 'tool-result')
    const start = stamp(call?.at), finish = stamp(result?.at), running = !result && review?.running === true
    timing = { label: 'Tool time', startedAt: call?.at || null, finishedAt: result?.at || null, durationMs: start !== null && finish !== null && finish >= start ? finish - start : null, running }
  }
  if (entry.kind === 'outcome' && !review) {
    const start = entries.find(value => value.attemptId === entry.attemptId && value.kind === 'context')?.at, a = stamp(start), b = stamp(entry.at)
    timing = { label: 'Transcript elapsed time', startedAt: start || null, finishedAt: entry.at, durationMs: a !== null && b !== null && b >= a ? b - a : null, running: false }
  }
  return { timing, review, attribution: unavailable ? 'unavailable' : entry.kind === 'outcome' ? 'review' : 'associated-review' }
}
