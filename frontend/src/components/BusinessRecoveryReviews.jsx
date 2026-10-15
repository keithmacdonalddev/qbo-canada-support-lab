import { useState } from 'react'
import { Button } from './ui/button'
import BusinessUnknownRecovery from './BusinessUnknownRecovery'
const money = value => value == null ? 'No tax' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value / 100)
export default function BusinessRecoveryReviews({ plan, api, scope, act, busy, onApproved }) {
  const [review, setReview] = useState(null), [reason, setReason] = useState(''), [accepted, setAccepted] = useState(false), [offset, setOffset] = useState(0)
  const root = '/company/business-governance/operations/' + plan.operationId
  const prepare = (mode, logicalKey) => act(async () => {
    const endpoint = mode === 'tax' ? '/tax/review' : mode === 'resume' ? '/resume/review' : '/rejection/review'
    const response = await api.post(root + endpoint, { planHash: plan.planHash, ...(logicalKey ? { logicalKey } : {}) }, { timeout: 190000 })
    scope(response.data.data); setReview({ ...response.data.data, mode, logicalKey }); setReason(''); setAccepted(false); setOffset(0)
  })
  return <div className="space-y-3 border-t border-[var(--line)] pt-3" aria-label="Owner operation recovery">
    <h4 className="font-semibold">Review operation recovery</h4>
    {plan.recoveryReason && <p>{plan.recoveryReason}</p>}
    <p>Saved records and original plans stay unchanged. A recovery approval allows already queued work to continue; otherwise use Run saved operation after approval.</p>
    <div className="flex flex-wrap gap-2">
      {plan.status === 'stopped' && <Button variant="outline" disabled={busy} onClick={() => prepare('resume')}>Review resuming this saved operation</Button>}
      {['approved', 'reserved', 'running', 'blocked'].includes(plan.status) && <Button variant="outline" disabled={busy} onClick={() => prepare('tax')}>Review remaining tax expectations</Button>}
      {plan.rejectedActivities?.map(row => <Button key={row.logicalKey} variant="outline" disabled={busy} onClick={() => prepare('rejection', row.logicalKey)}>Review rejected {row.entity} · {row.faultCodes.join(', ')}</Button>)}
    </div>
    <BusinessUnknownRecovery plan={plan} api={api} scope={scope} act={act} busy={busy} onApproved={onApproved} />
    {review && <form className="space-y-3 rounded border border-[var(--line)] p-3" onSubmit={event => { event.preventDefault(); act(async () => {
      const endpoint = review.mode === 'tax' ? '/tax/approve' : review.mode === 'resume' ? '/resume' : '/rejection/retry'
      await api.post(root + endpoint, { planHash: plan.planHash, reviewHash: review.reviewHash, reason, ...(review.logicalKey ? { logicalKey: review.logicalKey } : {}) }, { timeout: 190000 })
      setReview(null); await onApproved()
    }) }}>
      <h4 className="font-semibold">{review.mode === 'tax' ? 'Approve updated expectations for unsent records' : review.mode === 'resume' ? 'Resume the same saved operation' : 'Authorize a new attempt after a definite refusal'}</h4>
      {review.mode === 'tax' ? <>
        <p>{review.savedRecords} saved records keep their original expectations. {review.remainingRecords} unsent records receive the reviewed current tax definitions. Dates, prices, quantities and selected record identities stay the same.</p>
        <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Previous and proposed tax for unsent records</caption><thead><tr><th className="p-2">Date and record</th><th className="p-2">Previous tax</th><th className="p-2">Proposed tax and code</th></tr></thead><tbody>{review.changes.slice(offset, offset + 50).map(row => <tr key={row.logicalKey} className="border-t border-[var(--line)]"><td className="p-2">{row.txnDate} · {row.entity}</td><td className="p-2">{money(row.previousTaxCents)}</td><td className="p-2">{money(row.proposedTaxCents)} · {row.taxCodes.map(code => code.name + ' #' + code.id).join(', ')} {row.rates.map(rate => rate.percent + '%').join(' + ')}{row.taxCodeDefinitionChanged && <p>The definition of this same selected tax code changed.</p>}</td></tr>)}</tbody></table></div>
        {review.changes.length > 50 && <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous tax records</Button><Button type="button" variant="outline" disabled={busy || offset + 50 >= review.changes.length} onClick={() => setOffset(value => value + 50)}>Next tax records</Button></div>}
      </> : review.mode === 'resume' ? <p>The saved cursor and records are retained. The stop request is cleared so this exact operation can continue from its saved progress.</p> : <p>The original request received a recorded QuickBooks validation refusal with no saved record. That receipt stays in history. A separate attempt may be sent after this approval; uncertain outcomes are ineligible.</p>}
      <label className="block space-y-1">Recovery decision and reason<textarea required minLength={20} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />I reviewed this recovery for the displayed company and approve continuing the same operation under these terms.</label>
      <Button type="submit" disabled={busy || !accepted || reason.trim().length < 20}>Approve reviewed recovery</Button>
    </form>}
  </div>
}
