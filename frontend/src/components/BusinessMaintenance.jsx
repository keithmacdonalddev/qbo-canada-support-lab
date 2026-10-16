import { useCallback, useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Button } from './ui/button'
import { useAuth } from '../context/AuthContext'
import BusinessRecoveryReviews from './BusinessRecoveryReviews'
import BusinessActivityTerms from './BusinessActivityTerms'
import BusinessContinuity from './BusinessContinuity'

const money = cents => cents == null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100)
export default function BusinessMaintenance(props) {
  const { user } = useAuth()
  return <MaintenancePanel key={[props.realmId, props.environment, props.enabled, user?.id || user?._id].join(':')} {...props} />
}
export function MaintenancePanel({ enabled, realmId, environment, onChanged, onState, refreshVersion = 0, api = client }) {
  const [view, setView] = useState(null), [draft, setDraft] = useState(null), [baselines, setBaselines] = useState([])
  const [revise, setRevise] = useState(false)
  const [retirement, setRetirement] = useState(null), [retirementReason, setRetirementReason] = useState('')
  const [baselineId, setBaselineId] = useState(''), [review, setReview] = useState(null), [reviewNote, setReviewNote] = useState(''), [acceptExisting, setAcceptExisting] = useState(false)
  const [throughDate, setThroughDate] = useState(''), [plan, setPlan] = useState(null), [acceptPlan, setAcceptPlan] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const sending = useRef(false), mounted = useRef(false), connection = useRef(null), requests = useRef(new Map())
  const scope = useCallback(value => {
    const actual = value?.scope || value
    if (!actual || !/^[a-f0-9]{24}$/.test(actual.connectionId || '') || actual.realmId !== realmId || actual.environment !== environment || (connection.current && actual.connectionId !== connection.current)) throw new Error('The selected company changed. Reload Company before continuing.')
    connection.current = actual.connectionId
    return value
  }, [realmId, environment])
  const load = useCallback(async () => {
    const response = await api.get('/company/business-governance', { timeout: 15000 }), saved = scope(response.data.data)
    if (!mounted.current) return
    setView(saved); onState?.(saved)
    if (!saved.published || saved.canReviseBeforeActivity) {
      const [business, observations] = await Promise.all([api.get('/company/business-plan'), api.get('/company/business-baseline', { params: { limit: 50 } })])
      scope(business.data.data); scope(observations.data.data)
      if (!mounted.current) return
      setDraft(business.data.data.draft)
      setBaselines(observations.data.data.records.filter(row => row.purpose === 'opening-balances' && row.blueprint.contentHash === business.data.data.draft?.contentHash))
    }
  }, [api, scope, onState])
  useEffect(() => {
    mounted.current = true
    if (enabled) load().catch(err => { if (mounted.current) setError(err.response?.data?.error || err.message || 'Business maintenance could not be read.') })
    const timer = enabled ? setInterval(() => { if (!document.hidden && !sending.current) load().catch(err => { if (mounted.current) setError(err.response?.data?.error || 'Saved business state could not be refreshed.') }) }, 15000) : null
    return () => { mounted.current = false; clearInterval(timer) }
  }, [enabled, load, refreshVersion])
  const act = async work => {
    if (sending.current) return
    sending.current = true
    setBusy(true); setError(''); setNotice('')
    try { await work(); if (mounted.current) await load() }
    catch (err) { if (mounted.current) { setPlan(null); setRetirement(null); setError(err.response?.data?.error || err.message || 'The action could not be confirmed. Check saved state before retrying.'); try { await load() } catch { /* Keep last confirmed state and its error. */ } } }
    finally { sending.current = false; if (mounted.current) setBusy(false) }
  }
  const readPlan = async (operationId, offset = 0) => {
    const response = await api.get('/company/business-governance/operations/' + operationId + '/review', { params: { offset }, timeout: 15000 })
    const saved = scope(response.data.data)
    if (saved.operationId !== operationId) throw new Error('The saved plan changed.')
    if (mounted.current) { setPlan(saved); setAcceptPlan(false); setRetirement(null); setRetirementReason('') }
  }
  const nextFrom = view?.calendar?.verifiedThrough ? new Date(Date.parse(view.calendar.verifiedThrough + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10) : view?.published?.openingDate
  const monthEnd = nextFrom ? new Date(Date.UTC(Number(nextFrom.slice(0, 4)), Number(nextFrom.slice(5, 7)), 0)).toISOString().slice(0, 10) : undefined
  if (!enabled) return null
  return <section id="business-maintenance" aria-label="Business publication and calendar" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3"><h2 className="text-[13px] font-semibold">Business publication and calendar</h2><Button variant="ghost" size="sm" disabled={busy} onClick={() => act(load)}>Refresh business state</Button></header>
    <div className="space-y-4 px-5 py-4 text-[13px]">
      {view && <p className="text-[var(--ink-2)]">{view.companyName} · {view.environment} · {view.realmId}</p>}
      {!view && !error && <p role="status">Reading the business calendar…</p>}
      {error && <p role="alert" className="text-[var(--danger-ink)]">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {view?.owner && view.published && view.canReviseBeforeActivity && <Button variant="outline" disabled={busy} onClick={() => setRevise(value => !value)}>Review a corrected draft before activity</Button>}
      {view && (!view.published || revise) && <>
        <p>Publish a reviewed business plan and accept its opening evidence before preparing calendar operations. Existing records stay visible and unmanaged; publication creates no QuickBooks records.</p>
        {!view.owner ? <p>The connected company owner must review and publish the business.</p> : <>
          {!draft ? <p>Save the business plan and its company record choices above first.</p> : <>
            <p>Saved business: {draft.business.displayName} · version {draft.version} · opens {draft.business.openingDate}.</p>
            <label className="block space-y-1">Opening observation<select aria-label="Opening observation" className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" value={baselineId} onChange={event => { setBaselineId(event.target.value); setReview(null); setAcceptExisting(false) }}><option value="">Choose retained opening evidence</option>{baselines.map(row => <option key={row.id} value={row.id}>{row.period.fromDate} – {row.period.throughDate} · captured {new Date(row.observedAt).toLocaleString()}</option>)}</select></label>
            {!baselines.length && <p>Capture an opening-balances observation below, dated the day before this business opens.</p>}
            <Button variant="outline" disabled={busy || !baselineId} onClick={() => act(async () => { const response = await api.post('/company/business-governance/publication/review', { blueprintHash: draft.contentHash, baselineId }); scope(response.data.data.review); setReview(response.data.data); setAcceptExisting(false) })}>Review publication</Button>
            {review && <form className="space-y-3 rounded-lg border border-[var(--line)] p-4" onSubmit={event => { event.preventDefault(); act(async () => { await api.post('/company/business-governance/publication', { blueprintHash: draft.contentHash, baselineId, reviewHash: review.reviewHash, reviewNote, ownershipDisposition: 'retain-unmanaged' }, { timeout: 190000 }); setRevise(false); setReview(null); setNotice('Publication saved. The calendar starts at opening; no business period has yet been verified.'); onChanged?.() }) }}>
              <h3 className="font-semibold">Review the starting point</h3>
              <p>{review.review.recordCount} current records were observed; {review.review.existingOnOrAfterOpening} transactions are dated on or after business opening. Review overlapping history and unusual balances in the observation and Explorer before accepting.</p>
              <ul className="list-disc pl-5">{review.review.reportChecks.map(check => <li key={check.key}>{check.label}: {check.status} · {money(check.left * 100)} / {money(check.right * 100)}</li>)}</ul>
              {review.review.financialSummary && <><dl className="grid grid-cols-2 gap-2">{Object.entries(review.review.financialSummary.values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? 'Not separately confirmed' : money(value * 100)}</dd></div>)}</dl>{review.review.financialSummary.blockers.map(blocker => <p role="alert" key={blocker.key} className="text-[var(--danger-ink)]">{blocker.reason}</p>)}</>}
              <p>Business schedule version {review.review.activityTemplateVersion || 1}. {review.review.activityTemplateVersion === 2 ? 'Includes staged and late collections, retained opening stock, seasonal service hours and monthly nonbillable operating bills.' : 'Uses the original full-settlement and complete-batch activity rules.'}</p>
              <p>Arithmetic agreement does not establish realistic balances, complete activity or bank reconciliation. Publication retains the existing records and approves the saved activity template, prices and selected Canadian tax codes. Dated tax definitions are checked for each prepared operation.</p>
              <label className="block space-y-1">Starting evidence and existing-record review<textarea required minLength={30} maxLength={2000} className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" value={reviewNote} onChange={event => setReviewNote(event.target.value)} /></label>
              <label className="flex items-start gap-2"><input type="checkbox" checked={acceptExisting} onChange={event => setAcceptExisting(event.target.checked)} />I accept these starting balances and reviewed the overlapping records. Every existing transaction stays unmanaged and unchanged.</label>
              <Button type="submit" disabled={busy || !acceptExisting || reviewNote.trim().length < 30 || Boolean(review.review.financialSummary?.blockers.length)}>Publish business and accept opening evidence</Button>
            </form>}
          </>}
        </>}
      </>}
      {view?.published && <>
        <p className="font-medium">Business published · opening {view.calendar.openingDate}</p>
        <p>{view.calendar.verifiedThrough ? 'Managed activity verified through ' + view.calendar.verifiedThrough + '.' : 'No managed business period has been verified yet.'} {view.calendar.currentOperationId ? 'Continue the current operation in Business operations below.' : 'Prepare the next uninterrupted period.'}</p>
        <p className="text-[var(--ink-2)]">{view.limitation}</p>
        {view.published.continuity && <p>New occurrences from {view.published.continuity.effectiveFrom} use the revised business plan. Earlier activity retains its original terms.</p>}
        {view.owner && view.calendar.verifiedThrough && <BusinessContinuity realmId={realmId} environment={environment} connectionId={view.connectionId} published={view.published} calendar={view.calendar} onChanged={async () => { await load(); onChanged?.() }} api={api} />}
        {view.currentOperation && <Button variant="outline" disabled={busy} onClick={() => act(() => readPlan(view.currentOperation.operationId))}>Review current operation and recovery</Button>}
        {!view.calendar.currentOperationId && <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); act(async () => { const identity = view.published.contentHash + ':' + view.calendar.revision + ':' + throughDate, requestKey = requests.current.get(identity) || crypto.randomUUID(); requests.current.set(identity, requestKey); const response = await api.post('/company/business-governance/operations/prepare', { requestKey, throughDate }, { timeout: 190000 }); await readPlan(response.data.data.operationId); setNotice('The exact operation is saved for review. No QuickBooks records were created.'); onChanged?.() }) }}>
          <label className="space-y-1">Prepare through<input required type="date" min={nextFrom} max={monthEnd} value={throughDate} onChange={event => setThroughDate(event.target.value)} className="block rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
          <Button type="submit" disabled={busy || !throughDate}>Prepare next business period</Button><p className="text-[var(--ink-2)]">Prepare through this month’s end, then continue with the next period. Income and expense proof stays within one calendar month.</p>
        </form>}
        {view.pendingOperations?.length > 0 && <div className="space-y-2"><h3 className="font-semibold">Saved plans awaiting owner approval</h3>{view.pendingOperations.map(operation => <div key={operation.operationId} className="flex items-center justify-between gap-3 rounded border border-[var(--line)] p-3"><p>{operation.fromDate} – {operation.throughDate} · {operation.recordCount} records</p><Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => readPlan(operation.operationId))}>Review saved plan {operation.operationId.slice(-6)}</Button></div>)}</div>}
      </>}
      {plan && <div className="space-y-3 rounded-lg border border-[var(--line)] p-4" aria-label="Saved business plan review">
        <h3 className="font-semibold">{plan.fromDate} – {plan.throughDate} · {plan.recordCount} records · {plan.createCount} creations</h3>
        {plan.businessTerms && <p>This period follows the business terms from {plan.businessTerms.map(row => row.effectiveFrom).join(', ')}. Each activity keeps the terms in effect when it began, including payments collected later.</p>}
        {plan.approvalReports ? <p className="text-[var(--ink-2)]">Approval retained {plan.approvalReports.available} of {plan.approvalReports.reports} critical reports observed {new Date(plan.approvalReports.observedAt).toLocaleString()}. Completion requires fresh evidence.</p> : plan.status !== 'previewed' && <p className="text-[var(--ink-2)]">This earlier approval has no retained seven-report observation. Its original authority is preserved; new completion still requires current report evidence.</p>}
        <p>Approval covers only this exact saved plan for {view?.companyName} in {environment}. It allows the operation to create its planned records when you run it below. Required evidence: {plan.requiredAssertions.map(row => row.key).join(', ')}.</p>
        <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Saved transaction details</caption><thead><tr><th className="p-2">Date and record</th><th className="p-2">Purpose and references</th><th className="p-2">Before tax</th><th className="p-2">Expected tax</th></tr></thead><tbody>{plan.entries.map(entry => <tr key={entry.logicalKey} className="border-t border-[var(--line)]"><td className="p-2">{entry.txnDate}<br />{entry.entity} · {entry.kind}{entry.businessOrigin && <p className="mt-1 text-[var(--ink-2)]">Activity began {entry.businessOrigin.occurrence}<br />Business terms from {entry.businessOrigin.effectiveFrom}</p>}</td><td className="p-2"><BusinessActivityTerms details={entry.details} references={entry.references} /><p className="text-[var(--ink-2)]">{entry.references.map(ref => ref.key + ' #' + ref.id).join(' · ')}</p></td><td className="p-2 tabular">{money(entry.details.baseAmountCents)}</td><td className="p-2 tabular">{money(entry.expectedTaxCents)}</td></tr>)}</tbody></table></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || plan.offset === 0} onClick={() => act(() => readPlan(plan.operationId, Math.max(0, plan.offset - 50)))}>Previous plan records</Button><Button size="sm" variant="outline" disabled={busy || plan.nextOffset === null} onClick={() => act(() => readPlan(plan.operationId, plan.nextOffset))}>Next plan records</Button></div>
        {view?.owner && !['previewed', 'verified', 'committing', 'retired'].includes(plan.status) && <BusinessRecoveryReviews key={plan.operationId + ':' + plan.status} plan={plan} api={api} scope={scope} act={act} busy={busy} onApproved={() => readPlan(plan.operationId)} />}
        {view?.owner && !['verified', 'committing', 'retired'].includes(plan.status) && <div className="space-y-3 border-t border-[var(--line)] pt-3">
          <p>If this plan cannot continue, the app can retire it only after proving that none of its requests were sent. The saved plan and review remain in the audit history.</p>
          <Button variant="outline" disabled={busy} onClick={() => act(async () => { const response = await api.post('/company/business-governance/operations/' + plan.operationId + '/retirement/review', { planHash: plan.planHash }); scope(response.data.data); setRetirement(response.data.data) })}>Review whether this operation is unsent</Button>
          {retirement && <form className="space-y-3" onSubmit={event => { event.preventDefault(); act(async () => { await api.post('/company/business-governance/operations/' + plan.operationId + '/retirement', { planHash: plan.planHash, reviewHash: retirement.reviewHash, reason: retirementReason }); requests.current.clear(); setPlan(null); setRetirement(null); setNotice('Unsent operation retired. The calendar is unchanged. Prepare a fresh plan with current definitions.'); onChanged?.() }) }}>
            <p>No transport receipts or accounting records were found for this operation. {retirement.claimCount} unsent claims will be retained in the retirement audit.</p>
            <label className="block space-y-1">Reason for retiring this unsent plan<textarea required minLength={20} maxLength={2000} value={retirementReason} onChange={event => setRetirementReason(event.target.value)} className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
            <Button type="submit" variant="outline" disabled={busy || retirementReason.trim().length < 20}>Retire reviewed unsent operation</Button>
          </form>}
        </div>}
        {view?.owner && plan.status === 'previewed' && <><label className="flex items-start gap-2"><input type="checkbox" checked={acceptPlan} onChange={event => setAcceptPlan(event.target.checked)} />I reviewed this plan’s dates, amounts, links and expected tax for the displayed company.{environment === 'production' && ' I explicitly approve these writes to the REAL Production company.'}</label><Button disabled={busy || !acceptPlan} onClick={() => act(async () => { await api.post('/company/business-governance/operations/' + plan.operationId + '/approve', { planHash: plan.planHash, ...(environment === 'production' ? { confirmProduction: true } : {}) }, { timeout: 190000 }); setPlan(null); setNotice('Plan approved. Use Run saved operation below to execute it.'); onChanged?.() })}>Approve saved business operation</Button></>}
      </div>}
    </div>
  </section>
}
