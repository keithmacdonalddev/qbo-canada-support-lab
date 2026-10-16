import { useCallback, useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { Button } from './ui/button'

const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-f0-9]{24}$/
function readPending(storage, key, scope) {
  const text = storage.getItem(key)
  if (!text) return null
  let value
  try { value = JSON.parse(text) } catch { throw new Error('The saved business-change request could not be read. Check saved business state before continuing.') }
  if (value?.version !== 1 || ['realmId', 'environment', 'connectionId'].some(field => value.scope?.[field] !== scope[field]) || !idPattern.test(value.body?.blueprintId || '') || !hashPattern.test(value.body?.blueprintHash || '') || !hashPattern.test(value.body?.reviewHash || '') || typeof value.body?.effectiveFrom !== 'string' || typeof value.body?.reason !== 'string') throw new Error('The saved business-change request differs from this company. Check saved business state before continuing.')
  return value.body
}
export default function BusinessContinuity(props) {
  const { user } = useAuth()
  const actorId = user?.id || user?._id
  return <ContinuityPanel key={[actorId, props.realmId, props.environment, props.connectionId].join(':')} {...props} actorId={actorId} />
}
export function ContinuityPanel({ realmId, environment, connectionId, actorId, published, calendar, onChanged, api = client, storage = sessionStorage }) {
  const [draft, setDraft] = useState(null), [review, setReview] = useState(null), [pending, setPending] = useState(null)
  const [draftLoaded, setDraftLoaded] = useState(false), [recoveryBlocked, setRecoveryBlocked] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [accepted, setAccepted] = useState(false), [reason, setReason] = useState('')
  const form = useRef(null), active = useRef(false), sending = useRef(false), request = useRef(null), head = useRef(published.contentHash), result = useRef(null)
  head.current = published.contentHash
  const key = ['business-continuity-v1', actorId, environment, realmId, connectionId].join(':')
  const bound = useCallback(value => {
    const scope = value?.scope || value
    if (!scope || scope.realmId !== realmId || scope.environment !== environment || scope.connectionId !== connectionId) throw new Error('The selected company changed. Reload the business before continuing.')
    return value
  }, [realmId, environment, connectionId])
  const load = useCallback(async signal => {
    const response = await api.get('/company/business-plan', { signal, timeout: 15000 }), value = bound(response.data?.data)
    if (active.current && !signal?.aborted) { setDraft(value.draft || null); setDraftLoaded(true) }
  }, [api, bound])
  useEffect(() => {
    active.current = true
    const controller = new AbortController()
    try { setPending(readPending(storage, key, { realmId, environment, connectionId })) } catch (failure) { setRecoveryBlocked(true); setError(failure.message) }
    load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure.response?.data?.error || failure.message || 'The saved business draft could not be read.') })
    return () => { active.current = false; controller.abort(); request.current?.abort() }
  }, [load, storage, key, realmId, environment, connectionId])
  useEffect(() => { setReview(null); setAccepted(false) }, [published.contentHash])
  useEffect(() => { if (notice) { result.current?.focus(); result.current?.scrollIntoView({ block: 'nearest' }) } }, [notice])
  const act = async work => {
    if (sending.current) return
    sending.current = true; setBusy(true); setError(''); setNotice(''); request.current = new AbortController()
    try { await work(request.current.signal) }
    catch (failure) { if (active.current) setError(failure.response?.data?.error || failure.message || 'The change could not be confirmed. Retry the exact saved request.') }
    finally { sending.current = false; if (active.current) setBusy(false) }
  }
  async function apply(body, signal) {
    const saved = { version: 1, scope: { realmId, environment, connectionId }, body }
    // Retain the exact action before sending, so a lost reply or reload cannot
    // turn an uncertain metadata decision into a different business revision.
    storage.setItem(key, JSON.stringify(saved)); setPending(body)
    const response = await api.post('/company/business-governance/continuity', body, { signal, timeout: 190000 }), value = bound(response.data?.data)
    await finish(value, body, signal)
  }
  async function finish(value, body, signal) {
    const applied = value.applied === true && value.withdrawn !== true, withdrawn = value.withdrawn === true && value.applied === false
    if ((!applied && !withdrawn) || value.reviewHash !== body.reviewHash || value.effectiveFrom !== body.effectiveFrom || !hashPattern.test((applied ? value.authorityHash : value.withdrawalHash) || '')) throw new Error('The saved decision could not be confirmed. Retry its exact request.')
    storage.removeItem(key)
    if (active.current) { setPending(null); setReview(null); setAccepted(false); setNotice(withdrawn ? 'The pending business change was withdrawn. The business calendar and records were kept.' : value.current === false ? 'This reviewed change was saved. A later business revision is now current.' : 'Business change saved. Earlier activity keeps its original plan; the calendar has not advanced.'); await onChanged?.(); await load(signal) }
  }
  const changed = draft && draft.contentHash !== published.blueprintHash
  const schedulePending = environment === 'production' && draft?.business.activityTemplateVersion === 3
  return <section aria-label="Future business changes" className="rounded-lg border border-[var(--line)] p-4">
    <h3 className="font-semibold">Change future business activity</h3>
    <p className="mt-1 text-[var(--ink-2)]">Use a newer saved business plan from a chosen start date. Earlier jobs, stock orders and subscriptions keep their original bills, collections and record choices.</p>
    {error && <p role="alert" className="mt-3 text-[var(--danger-ink)]">{error}</p>}
    {notice && <p ref={result} tabIndex={-1} role="status" className="mt-3 scroll-mt-20">{notice}</p>}
    {recoveryBlocked ? <p className="mt-3">The saved browser request needs recovery before another change can be sent. Inspect the current business and its history.</p> : pending ? <div className="mt-3 space-y-2"><p role="status">The previous change was not confirmed. Retry its exact saved request for {pending.effectiveFrom}; this will not move the calendar or create accounting records.</p><Button variant="outline" disabled={busy} onClick={() => act(signal => apply(pending, signal))}>{busy ? 'Checking saved change…' : 'Retry saved business change'}</Button><Button variant="ghost" disabled={busy} onClick={() => act(async signal => { const response = await api.post('/company/business-governance/continuity/withdraw', { request: pending, reason: 'Owner withdrew this unconfirmed request from the business change screen.' }, { signal, timeout: 15000 }); await finish(bound(response.data?.data), pending, signal) })}>Withdraw pending business change</Button></div> : changed ? <form ref={form} className="mt-3 space-y-3" onSubmit={event => {
      event.preventDefault()
      const values = new FormData(event.currentTarget)
      if (!review || String(values.get('effectiveFrom') || '') !== review.selection.effectiveFrom || draft.contentHash !== review.selection.blueprintHash) { setError('The draft or date changed. Review this business change again.'); setReview(null); return }
      const note = String(values.get('reason') || '')
      if (values.get('accept') !== 'yes' || note.trim().length < 30) { setError('Confirm the reviewed change and explain why it should apply.'); return }
      act(signal => apply({ ...review.selection, reviewHash: review.reviewHash, reason: note }, signal))
    }}>
      <p>Saved plan version {draft.version}: {draft.business.displayName} · {draft.business.volumeProfile} volume.</p>
      <label className="block space-y-1">New activity starts on<input name="effectiveFrom" aria-label="New activity starts on" type="date" required min={calendar.verifiedThrough} disabled={busy} onChange={() => { setReview(null); setAccepted(false) }} className="block rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
      <p className="text-[var(--ink-2)]">Choose a date after verified activity through {calendar.verifiedThrough}. Keep the original opening, fiscal calendar, accounts, tax codes and every previously selected record. The continuing schedule can move to customer credits after review; earlier activity keeps its original terms. New roles can be added.</p>
      {schedulePending && <p role="status">The customer-credit schedule awaits a Canadian company check before a Production change. Earlier saved decisions can still be checked or withdrawn.</p>}
      <Button type="button" variant="outline" disabled={busy || schedulePending} onClick={() => {
        const selection = { blueprintId: draft.id, blueprintHash: draft.contentHash, effectiveFrom: String(new FormData(form.current).get('effectiveFrom') || '') }
        act(async signal => { const response = await api.post('/company/business-governance/continuity/review', selection, { signal, timeout: 190000 }), value = bound(response.data?.data); bound(value.review)
          if (!hashPattern.test(value.reviewHash || '') || value.review.previousAuthorityHash !== head.current || ['blueprintId', 'blueprintHash', 'effectiveFrom'].some(field => value.review[field] !== selection[field])) throw new Error('The reviewed business changed. Read its current state and review again.')
          if (active.current) { setReview({ ...value, selection }); setAccepted(false) }
        })
      }}>{busy ? 'Reading company choices…' : 'Review future business change'}</Button>
      {review && <div className="space-y-3 rounded border border-[var(--line)] p-3">
        <h4 className="font-semibold">Review the change from {review.selection.effectiveFrom}</h4>
        <dl className="grid grid-cols-2 gap-2"><dt>Business name</dt><dd>{review.review.changes.displayName.from} → {review.review.changes.displayName.to}</dd><dt>Activity volume</dt><dd>{review.review.changes.volumeProfile.from} → {review.review.changes.volumeProfile.to}</dd><dt>Planned history</dt><dd>{review.review.changes.historicalMonths.from} → {review.review.changes.historicalMonths.to} months</dd>{review.review.changes.activityTemplateVersion && <><dt>Business schedule</dt><dd>Continuing business → Customer credits</dd></>}<dt>New record choices</dt><dd>{review.review.changes.addedMasterRoles.length}</dd></dl>
        {review.review.changes.addedMasterRoles.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="py-2 font-medium">Use</th><th className="font-medium">Selected record</th><th className="font-medium">ID</th></tr></thead><tbody>{review.review.changes.addedMasterRoles.map(row => <tr key={row.key} className="border-t border-[var(--line)]"><td className="py-2 pr-3">{row.key.replaceAll('-', ' ')}</td><td className="pr-3">{row.name} <span className="text-[var(--ink-2)]">({row.entity})</span></td><td>{row.id}</td></tr>)}</tbody></table></div>}
        <p>The original opening evidence and verified-through date stay the same. This decision changes the app’s business plan; it creates no QuickBooks records. Finish or retire outstanding plans before applying it.</p>
        <label className="block space-y-1">Reason for the business change<textarea name="reason" required minLength={30} maxLength={2000} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
        <label className="flex items-start gap-2"><input name="accept" value="yes" type="checkbox" disabled={busy} checked={accepted} onChange={event => setAccepted(event.target.checked)} />I reviewed this change. Earlier activity must keep its original plan and outstanding obligations.</label>
        <Button type="submit" disabled={busy || !accepted || reason.trim().length < 30}>{busy ? 'Saving business change…' : 'Apply reviewed business change'}</Button>
      </div>}
    </form> : !draftLoaded && !error ? <p role="status" className="mt-3">Reading the saved business plan…</p> : <p className="mt-3 text-[var(--ink-2)]">Save a changed business plan above before reviewing a future revision.</p>}
  </section>
}
