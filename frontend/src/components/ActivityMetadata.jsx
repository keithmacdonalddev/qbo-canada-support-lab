import { costText, durationText, usdText } from '../lib/activity-metadata.mjs'
import './activity-metadata.css'

const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Not reported'
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'Not recorded'

export default function ActivityMetadata({ metadata, recordedAt, clock, onOpen }) {
  const review = metadata?.review, ownReview = metadata?.attribution === 'review'
  const timing = ownReview && review ? { ...review, label: 'Review time' } : metadata?.timing
  const elapsed = timing?.running && timing.startedAt ? Math.max(0, clock - Date.parse(timing.startedAt)) : timing?.durationMs
  const tokens = review?.tokens, cost = review?.cost
  const rows = tokens ? [
    ['Uncached input', tokens.uncachedInputTokens, cost?.components.inputUsd],
    ['Cached input', tokens.cachedInputTokens, cost?.components.cachedInputUsd],
    ...(review.provider === 'anthropic' ? [['Cache writes (5 min)', tokens.cacheWriteTokens - tokens.cacheWrite1hTokens, cost?.components.cacheWrite5mUsd], ['Cache writes (1 hour)', tokens.cacheWrite1hTokens, cost?.components.cacheWrite1hUsd]] : []),
    ['Output', tokens.outputTokens, cost?.components.outputUsd],
  ] : []
  return <details className="bwl-metadata" onToggle={event => { if (event.currentTarget.open) onOpen?.() }}>
    <summary>Details{Number.isFinite(elapsed) && <span> · {durationText(elapsed)}{timing?.running ? ' so far' : ''}</span>}{tokens && <span> · {ownReview ? '' : 'Review: '}{count(tokens.totalTokens)} tokens{review.usageMissing ? ' reported' : ''}</span>}{cost && <span> · ≈{costText(cost)} USD{cost.partial ? ' reported' : ''}</span>}</summary>
    <div className="bwl-metadata-body">
      <dl>
        <div><dt>{timing?.label || 'Item duration'}</dt><dd>{durationText(elapsed)}{timing?.running && Number.isFinite(elapsed) ? ' so far' : ''}</dd></div>
        <div><dt>Recorded</dt><dd>{date(recordedAt)}</dd></div>
        {timing?.startedAt && <div><dt>Started</dt><dd>{date(timing.startedAt)}</dd></div>}
        {timing?.finishedAt && <div><dt>Finished / last update</dt><dd>{date(timing.finishedAt)}</dd></div>}
      </dl>
      {review ? <>
        <p className="bwl-metadata-note">{ownReview ? 'This review’s measured usage.' : 'Associated review total, shared by its activity entries. This is not a separate charge for this item.'}</p>
        <dl>
          <div><dt>Model</dt><dd>{review.model || 'Not recorded'}</dd></div>
          <div><dt>Total input tokens</dt><dd>{tokens ? count(tokens.inputTokens) : 'Not reported'}</dd></div>
          <div><dt>Total tokens</dt><dd>{tokens ? count(tokens.totalTokens) : 'Not reported'}{review.usageMissing && tokens ? ' reported so far' : ''}</dd></div>
          <div><dt>{review.provider === 'codex' ? 'API equivalent (USD)' : 'API cost estimate (USD)'}</dt><dd>{costText(cost)}{cost?.partial ? ' reported so far' : ''}</dd></div>
          {!ownReview && <div><dt>Review time</dt><dd>{durationText(review.running && review.startedAt ? Math.max(0, clock - Date.parse(review.startedAt)) : review.durationMs)}{review.running ? ' so far' : ''}</dd></div>}
        </dl>
        {tokens && <table aria-label="Review token and cost breakdown"><thead><tr><th>Usage</th><th>Tokens</th><th>Cost (USD)</th></tr></thead><tbody>{rows.map(([label, amount, usd]) => <tr key={label}><th scope="row">{label}</th><td>{count(amount)}</td><td>{usdText(usd)}</td></tr>)}</tbody></table>}
        {review.usageMissing && <p className="bwl-metadata-note">{review.running ? 'Usage is still being reported.' : 'Complete usage was not confirmed.'} {tokens ? 'These are the reported counts and costs only; the final total may be higher.' : 'Token counts and cost are unavailable; they are not zero.'}</p>}
        {tokens && tokens.cachedInputTokens === null && <p className="bwl-metadata-note">The cached share of {count(tokens.inputTokens)} input tokens was not recorded. Cost is a range from all cached to all uncached input.</p>}
        {!cost && tokens && <p className="bwl-metadata-note">No verified price is available for this model.</p>}
        {cost && <p className="bwl-metadata-note">{review.provider === 'codex' ? 'Standard base API rates for comparison; not a ChatGPT subscription charge. Request-level context surcharges and billing adjustments are not available.' : 'Calculated from reported usage at standard API rates; your final bill may differ.'}</p>}
        <p className="bwl-metadata-note">Review ID: <code>{review.attemptId}</code></p>
      </> : <p className="bwl-metadata-note">{metadata?.attribution === 'unavailable' ? 'Usage details could not be read. They will retry automatically with the activity feed.' : metadata?.attribution === 'none' ? 'This operation is not separately metered for AI usage. No per-record token or API charge is recorded.' : 'No saved review usage is linked to this entry. Token counts and API cost are unavailable.'}</p>}
    </div>
  </details>
}
