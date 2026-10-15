import { useCallback, useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Button } from './ui/button'
import { Alert } from './ui/alert'
import MasterPreparationRecords from './MasterPreparationRecords'

const base = '/company/business-master-preparation'
const inputClass = 'rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[13px]'
const canceled = error => ['ERR_CANCELED', 'ABORT_ERR'].includes(error?.code) || ['CanceledError', 'AbortError'].includes(error?.name)
const errorText = error => typeof error.response?.data?.error === 'string' ? error.response.data.error : 'Saved preparation could not be confirmed. Check progress before retrying.'
const stateText = { proposed: 'Awaiting owner approval', approved: 'Approved · ready to start', running: 'Worker in progress', stopped: 'Stopped', blocked: 'Recovery needed', complete: 'Creates verified · choose how to use the IDs', closed: 'Preparation closed' }

export default function BusinessMasterPreparation({ view, hasUnsavedEdits, onDraftSaved }) {
  const [status, setStatus] = useState(null), [run, setRun] = useState(null), [preview, setPreview] = useState(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(''), [stopping, setStopping] = useState(false)
  const [storagePreview, setStoragePreview] = useState(null), [inventoryDate, setInventoryDate] = useState(view.draft?.business.openingDate || '')
  const [approvalConsent, setApprovalConsent] = useState(null), [retainConsent, setRetainConsent] = useState(null)
  const [selection, setSelection] = useState(null), [applyReview, setApplyReview] = useState(null), [applyConsent, setApplyConsent] = useState(null)
  const [candidateId, setCandidateId] = useState(''), [unknownReview, setUnknownReview] = useState(null), [reason, setReason] = useState(''), [ownerConsent, setOwnerConsent] = useState(null)
  const [history, setHistory] = useState(null)
  const alive = useRef(true), requests = useRef(new Set()), selectedId = useRef(null), proposalKey = useRef(null), applyKey = useRef(null)
  const request = useCallback(async (method, path, body) => {
    const controller = new AbortController(); requests.current.add(controller)
    try {
      const response = method === 'get' ? await client.get(base + path, { signal: controller.signal }) : await client.post(base + path, body, { signal: controller.signal })
      const data = response.data?.data
      if (data?.realmId !== view.realmId || data?.environment !== view.environment || data?.connectionId !== view.connectionId) throw new Error('Company changed')
      return data
    } finally { requests.current.delete(controller) }
  }, [view.realmId, view.environment, view.connectionId])
  const receiveRun = useCallback(value => {
    setRun(current => current && value && current.id === value.id && current.revision > value.revision ? current : value)
  }, [])
  const load = useCallback(async (preferred = selectedId.current) => {
    const before = selectedId.current, current = await request('get', '')
    const saved = preferred && current.run?.id !== preferred ? (await request('get', '/' + preferred)).run : current.run
    if (!alive.current || (selectedId.current !== before && selectedId.current !== preferred)) return
    if (saved?.claim === 'closed') proposalKey.current = null
    setStatus(current); receiveRun(saved)
  }, [request, receiveRun])
  useEffect(() => {
    alive.current = true
    load().catch(problem => { if (alive.current && !canceled(problem)) setError(errorText(problem)) })
    const pending = requests.current
    return () => { alive.current = false; for (const controller of pending) controller.abort() }
  }, [load])
  useEffect(() => {
    if (!run?.workerActive && !status?.run?.workerActive) return
    let reading = false
    const timer = setInterval(async () => {
      if (reading) return
      reading = true
      try { await load() } catch (problem) { if (alive.current && !canceled(problem)) setError(errorText(problem)) }
      finally { reading = false }
    }, 3000)
    return () => clearInterval(timer)
  }, [run?.workerActive, status?.run?.workerActive, load])
  useEffect(() => {
    if (run?.applied?.draftVersion > (view.draft?.version || 0)) onDraftSaved?.(run.applied.draftVersion)
  }, [run?.applied?.draftVersion, view.draft?.version, onDraftSaved])
  async function act(path, body, receive, { urgent = false, refresh = true } = {}) {
    if (urgent) setStopping(true); else setBusy(path)
    setError(''); setNotice('')
    try {
      const data = await request('post', path, body)
      if (!alive.current) return
      if ('run' in data) { selectedId.current = data.run?.id || null; if (data.run?.claim === 'closed') proposalKey.current = null; receiveRun(data.run); if (data.run) setStatus(current => data.run.claim === 'open' || current?.run?.id === data.run.id || !current?.run ? { ...current, run: data.run } : current) }
      receive?.(data)
      if (refresh) await load(data.run?.id || selectedId.current)
    } catch (problem) {
      if (!alive.current || canceled(problem)) return
      setError(errorText(problem))
      try { await load() } catch { /* Keep the original action error and last confirmed state. */ }
    } finally { if (alive.current) { if (urgent) setStopping(false); else setBusy('') } }
  }
  async function refresh() {
    setBusy('refresh'); setError('')
    try { await load() } catch (problem) { if (alive.current && !canceled(problem)) setError(errorText(problem)) }
    finally { if (alive.current) setBusy('') }
  }
  async function readHistory(before = null) {
    setBusy('history'); setError('')
    try {
      const data = await request('post', '/history', { before })
      if (alive.current) setHistory(current => ({ entries: before ? [...(current?.entries || []), ...data.entries] : data.entries, next: data.next }))
    } catch (problem) { if (alive.current && !canceled(problem)) setError(errorText(problem)) }
    finally { if (alive.current) setBusy('') }
  }
  async function selectHistory(id) {
    selectedId.current = id; setBusy('history'); setError('')
    try { await load(id) } catch (problem) { if (alive.current && !canceled(problem)) setError(errorText(problem)) }
    finally { if (alive.current) setBusy('') }
  }
  const verified = run?.records.filter(row => row.state === 'verified' && row.evidenceStatus === 'checked').map(row => row.ordinal) || []
  const selected = selection && run && selection.id === run.id ? selection.ordinals.filter(n => verified.includes(n)) : verified
  const shownApplyReview = applyReview && run && applyReview.runId === run.id && applyReview.runRevision === run?.revision && applyReview.ordinals.join(',') === selected.join(',') ? applyReview : null
  const first = run?.records.find(row => row.state !== 'verified')
  const shownUnknown = unknownReview && run && unknownReview.runId === run.id && unknownReview.progressHash === run?.progressHash && unknownReview.qboId === candidateId ? unknownReview : null
  const owner = status?.permissions.owner, locked = Boolean(busy), actions = run?.actions || {}
  const canPrepare = status?.storage.ready && status.permissions.prepare && view.draft?.connectionMatches && (!run || run.claim === 'closed') && status?.run?.claim !== 'open' && !status.blockingPreparation
  function prepare() {
    proposalKey.current ||= crypto.randomUUID()
    act('/prepare', { requestKey: proposalKey.current, connectionId: view.connectionId, baseHash: view.draft.contentHash, inventoryStartDate: inventoryDate }, data => {
      setPreview(data.preview || null); setHistory(null)
      if (data.run) setNotice(data.existing ? 'The saved preparation is shown. No second set was proposed.' : 'Preparation saved. Review the exact creates before approval.')
    }, { refresh: false })
  }
  function choose(ordinal, checked) {
    const values = checked ? [...new Set([...selected, ordinal])].sort((a, b) => a - b) : selected.filter(n => n !== ordinal)
    setSelection({ id: run.id, ordinals: values }); setApplyReview(null); applyKey.current = null
  }
  return <section aria-label="Business record preparation" className="space-y-3 rounded-lg border border-[var(--line)] p-4">
    <header className="flex items-center justify-between gap-3"><div><h3 className="font-semibold text-[var(--ink)]">Prepare missing business records</h3><p className="mt-1 text-[12px]">Create the saved business’s missing accounts, customers, suppliers, products and time-entry worker, then choose which verified IDs to use.</p></div><Button size="sm" variant="outline" disabled={locked} onClick={refresh}>Check saved progress</Button></header>
    {!status && !error && <p role="status">Reading record preparation…</p>}
    {error && <Alert variant="error">{error}</Alert>}
    {notice && <p role="status" className="text-[var(--ok)]">{notice}</p>}
    {status && <p className="text-[12px] text-[var(--ink-3)]">{status.companyName} · {status.environment} · company {status.realmId}</p>}
    {status && !owner && <p>The connected company owner makes preparation and recovery decisions. You can inspect the saved progress allowed by your company role.</p>}
    {status?.run && status.run.id !== run?.id && <div className="space-y-2 rounded-md border border-[var(--line)] p-3"><p>{status.run.claim === 'open' ? 'Current preparation' : 'Latest saved preparation'}: {stateText[status.run.state] || status.run.state} · {status.run.counts.identifiedRecords} IDs retained{status.run.workerActive ? ' · worker active' : ''}.</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={locked} onClick={() => { selectedId.current = null; refresh() }}>Return to current preparation</Button>{status.run.actions.stop && <Button size="sm" variant="outline" disabled={stopping} onClick={() => act('/' + status.run.id + '/stop', {}, () => setNotice('Stop recorded for the current preparation.'), { urgent: true })}>Stop current creates</Button>}</div></div>}
    {owner && status.permissions.recover && !status.permissions.execute && <p role="status" className="text-[var(--attention)]">New creates are unavailable with your current automation access. Stop and recovery remain available.</p>}
    {status?.blockingPreparation && <Alert variant="warning">{status.blockingPreparation.reason} Preparation {status.blockingPreparation.id}.</Alert>}
    {status && !status.storage.ready && <div className="space-y-3"><p>{status.storage.reason} This adds app storage for retained request receipts; it creates no QuickBooks records.</p>{owner && status.permissions.recover && <Button size="sm" variant="outline" disabled={locked} onClick={() => act('/storage/preview', {}, data => setStoragePreview(data.preview))}>Review record-preparation storage</Button>}{storagePreview && <div className="space-y-2 border-l-2 border-[var(--line)] pl-3"><p>Prepare this company’s master-record history and protection against duplicate open preparations. Existing business plans, accounting activity and receipts are retained.</p><p className="text-[12px]">Storage applies across the app database. QuickBooks writes: 0. Company: {status.companyName} · {status.environment} · {status.realmId}.</p><Button size="sm" disabled={locked} onClick={() => act('/storage/apply', { planHash: storagePreview.planHash }, () => setStoragePreview(null))}>Prepare record-history storage</Button></div>}</div>}
    {!view.draft && <p>Save the business draft before preparing its records.</p>}
    {hasUnsavedEdits && <p role="status" className="text-[var(--attention)]">You have unsaved business edits. Save them before preparing, approving or continuing creates. Recovery keeps using the saved request history.</p>}
    {canPrepare && <div className="space-y-3"><p>Use saved draft v{view.draft.version}: {view.draft.business.displayName}. Existing AR/AP, undeposited funds and tax codes must be selected first. Inventory tracking must already be enabled.</p><div className="flex flex-wrap items-end gap-3"><label className="space-y-1"><span className="block text-[12px]">Inventory starting date</span><input type="date" className={inputClass} value={inventoryDate} onChange={event => { setInventoryDate(event.target.value); proposalKey.current = null; setPreview(null) }} disabled={locked} /></label><Button size="sm" disabled={locked || !inventoryDate || hasUnsavedEdits} onClick={prepare}>{busy === '/prepare' ? 'Reading company prerequisites…' : 'Review missing records'}</Button></div><p className="text-[12px] text-[var(--ink-3)]">Opening stock is zero. Choose an elapsed date on or before {view.draft.business.openingDate}; protected dates are checked before any create. This action saves a proposal in the app. QuickBooks creates wait for exact approval and Start.</p></div>}
    {preview && <div className="space-y-2"><p role="status">{preview.entries.length === 0 && preview.blockers.length === 0 ? 'All required roles are already selected. No master creates are needed.' : 'Preparation needs these choices resolved before any create:'}</p>{preview.blockers.length > 0 && <ul className="max-h-64 list-disc space-y-1 overflow-y-auto pl-5">{preview.blockers.map((row, index) => <li key={row.key + ':' + index}>{view.mappingDefinitions?.[row.key]?.label || row.key}: {row.reason}</li>)}</ul>}</div>}
    {run && <div className="space-y-3 border-t border-[var(--line)] pt-3">
      <div className="flex items-start justify-between gap-3"><div><h4 className="font-semibold">{stateText[run.state] || run.state}</h4><p className="text-[12px] text-[var(--ink-3)]">{run.source.businessName} · saved draft v{run.source.version} · {run.recordCount || run.entries.length} planned creates</p></div>{actions.stop && <Button size="sm" variant="outline" disabled={stopping} onClick={() => act('/' + run.id + '/stop', {}, () => setNotice('Stop recorded. An admitted request may still finish; its ID or uncertainty will be retained.'), { urgent: true })}>{stopping ? 'Recording Stop…' : 'Stop creates'}</Button>}</div>
      <p role="status">{run.counts.identifiedRecords} IDs retained · {run.counts.acceptedRecords} confirmed create responses · {run.counts.ownerAttributedRecords} identified by owner · {run.counts.verifiedRecords} readbacks verified</p>
      <p className="text-[12px] text-[var(--ink-3)]">{run.admittedRequests} admitted requests · {run.unknownRequests} original unknown outcomes. Prepared records do not establish financial history, report coverage or calendar activation.</p>
      {run.workerActive && <p role="status">A worker holds the saved lease. Progress refreshes every three seconds. Stop prevents later requests after the admitted request settles.</p>}
      {run.failure && <Alert variant="warning">{run.failure.message}</Alert>}
      {!run.failure && status?.lastWorkerResult?.failure && <Alert variant="warning">{status.lastWorkerResult.failure.message}</Alert>}
      {run.integrity !== 'checked' && <Alert variant="error">Saved request evidence is incomplete or inconsistent. IDs remain visible for investigation; approval, continuation and apply are blocked.</Alert>}
      {!run.sourceMatchesCurrentDraft && run.claim === 'open' && <Alert variant="warning">The saved business changed after this preparation. Further creates are blocked. Review compatible retained IDs for the current draft, or retain them unassigned and close only the unsent work.</Alert>}
      <MasterPreparationRecords key={run.id} run={run} mappingDefinitions={view.mappingDefinitions} selected={selected} onSelect={choose} selectable={actions.apply && !locked} />
      {actions.approve && <div className="space-y-2 rounded-md border border-[var(--line)] p-3"><label className="flex items-start gap-2"><input type="checkbox" checked={approvalConsent === run.planHash} onChange={event => setApprovalConsent(event.target.checked ? run.planHash : null)} /><span>I approve these {run.entries.length} exact creates in {status.environment === 'production' ? 'Production' : 'Sandbox'}: {status.companyName} (company {status.realmId}).</span></label><p className="text-[12px]">No opening balances, edits, preference changes or messages are included. Created records remain in QuickBooks if you stop or retain them.</p><Button size="sm" disabled={locked || hasUnsavedEdits || approvalConsent !== run.planHash} onClick={() => act('/' + run.id + '/approve', { planHash: run.planHash, productionConfirmed: status.environment === 'production' })}>Approve exact creates</Button></div>}
      {actions.execute && <Button size="sm" disabled={locked || hasUnsavedEdits} onClick={() => act('/' + run.id + '/execute', { planHash: run.planHash, reviewHash: run.progressHash, resume: run.stopRequested || run.state !== 'approved' }, data => { if (!data.workerClaimed) setNotice('A worker was not newly claimed. The current saved state is shown.') })}>{run.state === 'approved' && !run.stopRequested ? 'Start approved creates' : 'Continue approved creates'}</Button>}
      {actions.recoverAccepted && <div className="space-y-2"><p>Read the exact accepted ID{first ? ' ' + first.qboId : 's'} and settle saved verification. This recovery sends no create request and keeps Stop set.</p><Button size="sm" variant="outline" disabled={locked} onClick={() => act('/' + run.id + '/recover', { planHash: run.planHash, reviewHash: run.progressHash })}>Recover accepted record</Button></div>}
      {actions.retry && <div className="space-y-2"><p>The first incomplete record has {first?.state === 'rejected' ? 'a refused request' : 'a reservation without confirmed admission'}. The server must prove that exact attempt had no effect before authorizing another attempt.</p><Button size="sm" variant="outline" disabled={locked} onClick={() => act('/' + run.id + '/retry', { ordinal: first.ordinal, planHash: run.planHash, reviewHash: run.progressHash, confirmNoEffect: true })}>Review no-effect proof and allow a fresh attempt</Button><p className="text-[12px]">This decision keeps Stop set. Continue is a separate action.</p></div>}
      {actions.attributeUnknown && <div className="space-y-3 rounded-md border border-[var(--line)] p-3"><h4 className="font-semibold">Identify an unknown master result</h4><p>The original request ended without a confirmed ID. Find the candidate in QuickBooks using your own evidence; names alone do not establish ownership.</p><div className="flex flex-wrap items-end gap-3"><label className="space-y-1"><span className="block text-[12px]">Candidate QuickBooks ID</span><input className={inputClass} inputMode="numeric" value={candidateId} maxLength={30} onChange={event => { setCandidateId(event.target.value); setUnknownReview(null) }} /></label><Button size="sm" variant="outline" disabled={locked || !/^\d{1,30}$/.test(candidateId)} onClick={() => act('/' + run.id + '/unknown/review', { ordinal: first.ordinal, qboId: candidateId }, data => setUnknownReview(data.review))}>Read exact candidate</Button></div>{shownUnknown && <><p>{shownUnknown.limitation}</p><p className="text-[12px]">Candidate {shownUnknown.qboId} · created {new Date(shownUnknown.candidate.createdAt).toLocaleString()}</p><details><summary className="cursor-pointer">Candidate business fields</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-[var(--surface-2)] p-3 text-[12px]">{JSON.stringify(shownUnknown.candidate.proof.fields, null, 2)}</pre></details><label className="block space-y-1"><span>Identification evidence</span><textarea className={inputClass + ' block w-full'} minLength={30} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label><label className="flex items-start gap-2"><input type="checkbox" checked={ownerConsent === shownUnknown.reviewHash} onChange={event => setOwnerConsent(event.target.checked ? shownUnknown.reviewHash : null)} /><span>I independently identified this exact record as this attempt’s result. Matching fields and time do not prove request identity or exclude duplicates.</span></label><Button size="sm" disabled={locked || reason.trim().length < 30 || ownerConsent !== shownUnknown.reviewHash} onClick={() => act('/' + run.id + '/unknown/attribute', { ordinal: first.ordinal, qboId: candidateId, reviewHash: shownUnknown.reviewHash, reason, confirmOwnership: true })}>Record owner identification</Button><p className="text-[12px]">The original result stays unknown in history. Identification keeps Stop set and does not start more creates.</p></>}</div>}
      {first?.state === 'possibly-sent' && <Alert variant="warning">The request has no terminal result yet. Its company write barrier remains held. Lease age, missing name matches and Stop do not authorize a retry.</Alert>}
      {actions.apply && <div className="space-y-3 rounded-md border border-[var(--line)] p-3"><h4 className="font-semibold">Use verified IDs in the business draft</h4><p>{selected.length} of {verified.length} verified records selected. The current saved draft receives these choices in a new version. Other saved IDs remain discoverable and unassigned; only proved-unsent work is retired.</p><div className="flex flex-wrap gap-2"><Button size="xs" variant="ghost" disabled={locked} onClick={() => { setSelection({ id: run.id, ordinals: verified }); setApplyReview(null); applyKey.current = null }}>Select all verified</Button><Button size="xs" variant="ghost" disabled={locked} onClick={() => { setSelection({ id: run.id, ordinals: [] }); setApplyReview(null); applyKey.current = null }}>Clear selection</Button><Button size="sm" variant="outline" disabled={locked || !selected.length} onClick={() => act('/' + run.id + '/apply-review', { ordinals: selected }, data => { setApplyReview(data.review); applyKey.current = null })}>Review use in current draft</Button></div>{shownApplyReview && <><p>Current draft v{shownApplyReview.baseVersion}: {shownApplyReview.entries.length} exact IDs checked again. Publication and accepted opening evidence stay separate.</p><label className="flex items-start gap-2"><input type="checkbox" checked={applyConsent === shownApplyReview.reviewHash} onChange={event => setApplyConsent(event.target.checked ? shownApplyReview.reviewHash : null)} /><span>Use this exact selection and retain the displayed disposition of every other record.</span></label><Button size="sm" disabled={locked || applyConsent !== shownApplyReview.reviewHash} onClick={() => { applyKey.current ||= crypto.randomUUID(); act('/' + run.id + '/apply', { ordinals: shownApplyReview.ordinals, reviewHash: shownApplyReview.reviewHash, requestKey: applyKey.current }, data => { if (data.draft) onDraftSaved?.(data.draft.version) }) }}>Save new draft with verified IDs</Button></>}</div>}
      {run.applied && <p role="status" className="text-[var(--ok)]">IDs applied to saved draft v{run.applied.draftVersion}. Reload the saved business plan to continue its mapping, tax and publication reviews.</p>}
      {actions.retain && <details className="space-y-2"><summary className="cursor-pointer text-[var(--ink-2)]">Retain records without assigning them</summary><p className="mt-2">Keep every saved ID in QuickBooks and close this preparation without changing the business draft. Only proved-unsent activity is retired.</p><label className="flex items-start gap-2"><input type="checkbox" checked={retainConsent === run.progressHash} onChange={event => setRetainConsent(event.target.checked ? run.progressHash : null)} /><span>I reviewed these {run.counts.identifiedRecords} retained IDs and the remaining unsent activity.</span></label><Button size="sm" variant="outline" disabled={locked || retainConsent !== run.progressHash} onClick={() => act('/' + run.id + '/retain', { planHash: run.planHash, reviewHash: run.progressHash, confirmRetain: true }, () => { setHistory(null); setNotice('Preparation closed. Saved IDs remain available in preparation history and record choices.') })}>Retain IDs and close preparation</Button></details>}
    </div>}
    {status?.storage.ready && <details onToggle={event => { if (event.currentTarget.open && !history && !locked) readHistory() }}><summary className="cursor-pointer font-medium">Saved preparation history</summary><div className="mt-3 space-y-3">{history?.entries.map(entry => <div key={entry.id} className="space-y-1 border-b border-[var(--line)] pb-2"><p className="text-[12px]">{stateText[entry.state] || entry.state} · {entry.id}{entry.draftVersion ? ' · applied draft v' + entry.draftVersion : ''}</p>{entry.sameConnection && <Button size="xs" variant="ghost" disabled={locked} aria-label={'Inspect preparation ' + entry.id} onClick={() => selectHistory(entry.id)}>Inspect saved preparation</Button>}{!entry.sameConnection && <p className="text-[12px] text-[var(--attention)]">Earlier connection · retained IDs are shown for review.</p>}{entry.retainedRecords.length > 0 && <details><summary className="cursor-pointer text-[12px]">{entry.retainedRecords.length} retained IDs</summary><ul className="mt-1 max-h-48 space-y-1 overflow-auto text-[12px]">{entry.retainedRecords.map(row => <li key={row.ordinal}>{row.key} · {row.entity} {row.qboId} · {row.state}</li>)}</ul></details>}</div>)}{history?.entries.length === 0 && <p>No saved preparations yet.</p>}{!history && <p role="status">Reading saved history…</p>}{history?.next && <Button size="sm" variant="outline" disabled={locked} onClick={() => readHistory(history.next)}>More preparations</Button>}</div></details>}
  </section>
}
