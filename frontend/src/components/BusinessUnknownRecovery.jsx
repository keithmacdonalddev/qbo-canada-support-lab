import { useState } from 'react'
import { Button } from './ui/button'
const money = value => value == null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value)
function RecordFacts({ value }) {
  if (!value) return null
  return <div className="space-y-1"><p>Date {value.txnDate} · Total {money(value.total)} · Tax {money(value.tax)}</p>{value.choices?.map(choice => <p key={choice.label}>{choice.label}: #{choice.id}</p>)}{value.time && <p>{value.time.hours} hours {value.time.minutes} minutes · {value.time.billableStatus}</p>}{value.lines?.length > 0 && <table className="w-full text-left"><caption className="sr-only">Items, quantities and amounts</caption><thead><tr><th>Item</th><th>Quantity</th><th>Price</th><th>Net</th><th>Tax code</th></tr></thead><tbody>{value.lines.map((line, index) => <tr key={index}><td>#{line.itemId || '—'}</td><td>{line.quantity ?? '—'}</td><td>{money(line.unitPrice)}</td><td>{money(line.amount)}</td><td>#{line.taxCodeId || '—'}</td></tr>)}</tbody></table>}<p className="break-words">Marker: {value.marker || '—'}</p><p>Links: {value.links?.length ? value.links.map(link => link.entity + ' #' + link.id + (link.lineId ? ' line ' + link.lineId : '')).join('; ') : 'None'}</p></div>
}

export default function BusinessUnknownRecovery({ plan, api, scope, act, busy, onApproved }) {
  const [selected, setSelected] = useState(''), [qboId, setQboId] = useState('')
  const [review, setReview] = useState(null), [reason, setReason] = useState(''), [accepted, setAccepted] = useState(false)
  const activities = plan.uncertainActivities || []
  if (!activities.length) return null
  const root = '/company/business-governance/operations/' + plan.operationId + '/uncertain'
  return <section aria-label="Uncertain business creation" className="space-y-3 rounded border border-[var(--line)] p-3">
    <h4 className="font-semibold">Identify a saved record after an uncertain request</h4>
    <p>The company writer stays blocked until the original outcome is settled. This review reads one exact QuickBooks ID and its original dependencies. It creates, edits and deletes no QuickBooks records.</p>
    <p>A request still marked possibly sent is ineligible. A finished request with a missing or ambiguous result needs your own identification evidence. A matching amount, description or creation time alone does not establish identity or rule out duplicates.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); act(async () => {
      setReview(null)
      const response = await api.post(root + '/review', { planHash: plan.planHash, logicalKey: selected, qboId }, { timeout: 190000 })
      scope(response.data.data); setReview({ ...response.data.data, logicalKey: selected, qboId }); setReason(''); setAccepted(false)
    }) }}>
      <label className="block">Unsettled activity<select aria-label="Unsettled activity" required value={selected} onChange={event => { setSelected(event.target.value); setReview(null) }} className="ml-2 rounded border border-[var(--line)] bg-[var(--surface)] p-2"><option value="">Choose activity</option>{activities.map(row => <option key={row.logicalKey} value={row.logicalKey}>{row.entity} · {row.txnDate} · {row.logicalKey.slice(0, 10)}</option>)}</select></label>
      <label className="block">Candidate QuickBooks ID<input required pattern="[0-9]{1,30}" inputMode="numeric" value={qboId} onChange={event => { setQboId(event.target.value); setReview(null) }} className="ml-2 w-36 rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
      <Button type="submit" variant="outline" disabled={busy || !selected || !/^\d{1,30}$/.test(qboId)}>Review exact saved record</Button>
    </form>
    {review && <form className="space-y-3 border-t border-[var(--line)] pt-3" onSubmit={event => { event.preventDefault(); act(async () => {
      await api.post(root + '/attribute', { planHash: plan.planHash, logicalKey: review.logicalKey, qboId: review.qboId, reviewHash: review.reviewHash, reason, confirmOwnership: accepted }, { timeout: 190000 })
      setReview(null); await onApproved()
    }) }}>
      <h4 className="font-semibold">Attribute {review.record.entity} #{review.record.id} to this request</h4>
      <p>Local attempt started {review.original?.sentAt}; ended {review.original?.endedAt} ({review.original?.localCompletion}). Candidate created {review.record.createdAt}.</p>
      <div className="grid grid-cols-2 gap-4 overflow-x-auto"><section aria-label="Original requested record"><h5 className="font-semibold">Original requested record</h5><RecordFacts value={review.original} /><p>Dependencies: {review.original?.dependencies?.map(link => link.entity + ' #' + link.id + ' (' + link.kind + ')').join('; ') || 'None'}</p></section><section aria-label="Observed candidate record"><h5 className="font-semibold">Observed candidate #{review.record.id}</h5><RecordFacts value={review.record} /></section></div>
      <p>{review.limitation}</p>
      <p>Creation time passed a local ±15-minute filter around the attempt. This is a review limit and is not a QuickBooks clock guarantee.</p>
      <p>{review.queuedContinuation ? 'Approval may let the previously queued operation continue after mandatory graph checks.' : 'After approval, use Run saved operation for the remaining graph and report checks.'} A saved stop request stays in effect.</p>
      <label className="block">How I identified this exact record<textarea required minLength={30} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />I identified this exact record using my own evidence and approve retaining it as owner-attributed. I understand the original transport result remains uncertain.</label>
      <Button type="submit" disabled={busy || !accepted || reason.trim().length < 30}>Save owner attribution</Button>
    </form>}
  </section>
}
