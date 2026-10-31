import { useCallback, useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Button } from './ui/button'

const labels = { open: 'Open', exception: 'Exception', 'evidence-recorded': 'Partial evidence', 'report-supported': 'Report supported', 'review-recorded': 'Review recorded', 'manually-attested': 'Owner attested', 'evidence-unavailable': 'Evidence unavailable' }
const field = 'block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2'
export default function BusinessCloseChecklist({ realmId, environment, connectionId, api = client }) {
  return <Checklist key={[realmId, environment, connectionId].join(':')} {...{ realmId, environment, connectionId, api }} />
}
export function Checklist({ realmId, environment, connectionId, api }) {
  const [period, setPeriod] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit' }).slice(0, 7))
  const [view, setView] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState(''), [disposition, setDisposition] = useState('evidence'), [reference, setReference] = useState(''), [note, setNote] = useState(''), [manualReference, setManualReference] = useState(''), [confirmed, setConfirmed] = useState(false), [notice, setNotice] = useState('')
  const mounted = useRef(false), generation = useRef(0), sending = useRef(false), request = useRef(null)
  const verifyScope = useCallback(value => {
    if (value?.scope?.realmId !== realmId || value?.scope?.environment !== environment || value?.scope?.connectionId !== connectionId) throw new Error('The selected company changed. Reload Company before continuing.')
    return value
  }, [realmId, environment, connectionId])
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true); setError('')
    try {
      const response = await api.get('/company/business-governance/close-checklist/' + period, { timeout: 20000 })
      const value = verifyScope(response.data.data)
      if (mounted.current && generation.current === current) setView(value)
    } catch (err) { if (mounted.current && generation.current === current) { setView(null); setSelection(''); setError(err.response?.data?.error || err.message || 'The close checklist could not be read.') } }
    finally { if (mounted.current && generation.current === current) setLoading(false) }
  }, [api, period, verifyScope])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { load() }, [load])
  const resetForm = () => { setSelection(''); setNote(''); setReference(''); setManualReference(''); setConfirmed(false); request.current = null }
  const item = view?.items.find(row => row.key + ':' + row.accountId === selection)
  const save = async event => {
    event.preventDefault()
    if (sending.current || !item || !view?.storage.ready) return
    const current = generation.current
    const ref = view.evidence.find(row => row.kind + ':' + row.id === reference)
    const body = { contextHash: view.contextHash, period, checkKey: item.key, accountId: item.accountId, expectedRevision: item.revision, disposition, note, evidenceReferences: ref ? [{ kind: ref.kind, id: ref.id, hash: ref.hash }] : [], attestation: disposition === 'manual-attestation' ? { confirmed, asOfDate: view.throughDate, reference: manualReference } : null }
    const identity = JSON.stringify(body)
    if (request.current?.identity !== identity) request.current = { identity, key: crypto.randomUUID() }
    sending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const response = await api.post('/company/business-governance/close-checklist/evidence', { ...body, requestKey: request.current.key }, { timeout: 20000 })
      verifyScope(response.data.data)
      if (mounted.current && generation.current === current) { resetForm(); setNotice('Checklist decision and audit saved. ' + (labels[response.data.data.status] || response.data.data.status) + '.'); await load() }
    } catch (err) { if (mounted.current && generation.current === current) setError(err.response?.data?.error || 'The decision was not confirmed. Retry the unchanged form to check its saved result.') }
    finally { sending.current = false; if (mounted.current) setBusy(false) }
  }
  return <section aria-label="Month-end close checklist" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] text-[13px]">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
      <h2 className="font-semibold">Month-end close checklist</h2>
      <div className="flex items-center gap-3"><label className="flex items-center gap-2">Month<input type="month" value={period} min="2000-01" max="2099-12" disabled={busy} onChange={event => { if (!event.target.value) return; setPeriod(event.target.value); setView(null); resetForm(); setNotice('') }} className="rounded border border-[var(--line)] bg-[var(--surface)] p-1.5" /></label><Button size="sm" variant="ghost" disabled={loading || busy} onClick={load}>Refresh checklist</Button></div>
    </header>
    <div className="space-y-3 px-5 py-4">
      {loading && <p role="status">Reading retained close evidence…</p>}
      {error && <div role="alert" className="text-[var(--danger-ink)]"><p>{error}</p><Button size="sm" variant="outline" disabled={loading || busy} onClick={load}>Retry reading checklist</Button></div>}
      {notice && <p role="status">{notice}</p>}
      {view && <>
        <p>{view.fromDate} – {view.throughDate} · {view.summary.open} open items · {view.summary.exceptions} exceptions. Select an item to attach evidence or record what remains.</p>
        {!view.storage.ready && <p role="status">{view.storage.reason}</p>}
        {view.accountCoverage === 'unavailable' && <p role="status">No intact account observation is available. Bank and card checks cannot be enumerated yet; account coverage remains open.</p>}
        <div className="max-h-[420px] overflow-auto"><table className="w-full text-left"><caption className="sr-only">Month-end checks, accounts and recorded status</caption><thead className="sticky top-0 bg-[var(--surface)]"><tr><th className="p-2">Check</th><th className="p-2">Account</th><th className="p-2">Status</th><th className="p-2">Evidence</th></tr></thead><tbody>{view.items.map(row => <tr key={row.key + ':' + row.accountId} className="border-t border-[var(--line)]"><td className="p-2"><button type="button" disabled={busy || loading} className="text-left underline decoration-dotted underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]" onClick={() => { resetForm(); setSelection(row.key + ':' + row.accountId); setDisposition(row.mode === 'review' ? 'review' : 'evidence'); setNotice('') }}>{row.label}</button></td><td className="p-2">{row.accountName}{row.accountId !== 'company' && <span className="text-[var(--ink-2)]"> #{row.accountId}</span>}</td><td className="p-2">{labels[row.status] || row.status}</td><td className="p-2">{row.current ? row.current.evidenceReferences.length + ' linked · revision ' + row.revision : row.supportedBy.length ? 'Monthly source available' : 'None attached'}</td></tr>)}</tbody></table></div>
        {item && <form onSubmit={save} className="space-y-3 rounded border border-[var(--line)] p-4" aria-label="Record checklist evidence">
          <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{item.label} · {item.accountName}</h3><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={resetForm}>Close item</Button></div>
          <label className="block space-y-1">Record<select className={field} value={disposition} disabled={busy || loading} onChange={event => { setDisposition(event.target.value); setConfirmed(false) }}><option value="evidence">Attach evidence</option>{item.mode === 'review' && <option value="review">Record my review</option>}<option value="exception">Record an exception</option><option value="reopen">Reopen this check</option>{item.mode === 'manual' && view.owner && <option value="manual-attestation">Attest manual work as company owner</option>}</select></label>
          <label className="block space-y-1">Retained evidence<select className={field} value={reference} disabled={busy || loading} onChange={event => setReference(event.target.value)} required={['evidence', 'review'].includes(disposition)}><option value="">Choose evidence (optional for exceptions and manual work)</option>{view.evidence.map(ref => <option key={ref.kind + ':' + ref.id} value={ref.kind + ':' + ref.id}>{ref.title || (ref.completeMonth ? 'Full month' : 'Partial period') + ' · ' + ref.period.fromDate + ' – ' + ref.period.throughDate} · {ref.id.slice(-8)}</option>)}</select></label>
          {!view.evidence.length && <p>No retained evidence is available for this month. An exception or an explicit owner attestation can still record the missing work once storage is prepared.</p>}
          <label className="block space-y-1">Review, exception or next action<textarea className={field} required minLength={20} maxLength={4000} value={note} disabled={busy || loading} onChange={event => setNote(event.target.value)} /></label>
          {disposition === 'manual-attestation' && <><label className="block space-y-1">Statement, filing or settings evidence reference<input className={field} required minLength={10} maxLength={1000} value={manualReference} disabled={busy || loading} onChange={event => setManualReference(event.target.value)} /></label><label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy || loading} onChange={event => setConfirmed(event.target.checked)} required />I explicitly attest this work for {item.accountName} as of {view.throughDate}. This records my statement; the app has not independently verified it.</label></>}
          <Button type="submit" disabled={busy || loading || !view.storage.ready || note.trim().length < 20 || (disposition === 'manual-attestation' && (!confirmed || manualReference.trim().length < 10))}>{busy ? 'Saving checklist evidence…' : 'Save checklist decision'}</Button>
          {item.history.length > 0 && <details><summary className="cursor-pointer">Retained history ({item.history.length})</summary><ol className="space-y-3 pt-2">{item.history.map(entry => <li key={entry.id} className="rounded border border-[var(--line)] p-3"><p>Revision {entry.revision} · {labels[entry.result.status]} · {new Date(entry.at).toLocaleString()}</p><p>{entry.note}</p><p className="text-[var(--ink-2)]">Actor {entry.actorId} · Audit {entry.auditId}</p>{entry.evidenceReferences.map(ref => <p className="break-all text-[var(--ink-2)]" key={ref.kind + ':' + ref.id}>{ref.kind} · {ref.id} · hash {ref.hash}</p>)}{entry.attestation && <p>Owner evidence: {entry.attestation.reference} · as of {entry.attestation.asOfDate}</p>}</li>)}</ol></details>}
        </form>}
        <p className="text-[var(--ink-2)]">{view.limitation}</p>
        {view.rejectedEvidence.length > 0 && <p role="status">{view.rejectedEvidence.length} retained observations could not be verified. They cannot support a completed check.</p>}
      </>}
    </div>
  </section>
}
