import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import client from '../api/client'
import { Button } from './ui/button'

export default function BusinessSetup({ enabled, onChanged }) {
  const [view, setView] = useState(null)
  const [preview, setPreview] = useState(null)
  const [preparation, setPreparation] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [closedThrough, setClosedThrough] = useState('')
  const [reconciledThrough, setReconciledThrough] = useState('')
  const [evidenceNote, setEvidenceNote] = useState('')
  const load = useCallback(async () => {
    const response = await client.get('/company/business-setup')
    setView(response.data.data)
  }, [])
  useEffect(() => {
    if (!enabled) return
    let current = true
    client.get('/company/business-setup').then(response => { if (current) setView(response.data.data) }).catch(err => { if (current) setError(err.response?.data?.error || 'Company setup could not be read.') })
    return () => { current = false }
  }, [enabled])
  useEffect(() => {
    const controls = view?.coordination.periodControl
    setClosedThrough(controls?.closedThrough || '')
    setReconciledThrough(controls?.reconciledThrough || '')
    setEvidenceNote(controls?.evidenceNote || '')
  }, [view?.coordination.periodControl])
  const act = async (path, body, receive) => {
    setBusy(true); setError(null)
    try {
      const response = await client.post('/company/business-setup/' + path, body)
      receive?.(response.data.data)
      await load(); onChanged?.()
    } catch (err) {
      setError(err.response?.data?.error || 'Setup could not finish. Retry the same reviewed action.')
      try { await load(); onChanged?.() } catch { /* Retain the failure and the last confirmed state. */ }
    }
    finally { setBusy(false) }
  }
  const retryRead = async () => {
    setBusy(true); setError(null)
    try { await load(); onChanged?.() } catch (err) { setError(err.response?.data?.error || 'Company setup could not be read.') }
    finally { setBusy(false) }
  }
  if (!enabled) return null
  const complete = view?.storage.ready && view?.coordination.state === 'active' && view?.coordination.periodControl
  return <section className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]" aria-label="Business access and preparation">
    <header className="border-b border-[var(--line)] px-5 py-3"><h2 className="text-[13px] font-semibold">Business access and preparation</h2></header>
    <div className="space-y-3 px-5 py-4 text-[13px]">
      {view && <p>{complete ? 'Company write coordination is ready.' : 'The owner needs to prepare business storage and company write coordination.'} This setup changes app storage and access; it creates no accounting records and does not verify or activate a business calendar.</p>}
      {view && <p className="text-[var(--ink-2)]">{view.companyName} · {view.environment} · {view.realmId}</p>}
      {!view && !error && <p role="status">Reading preparation…</p>}
      {error && <div className="space-y-2"><p role="alert" className="text-[var(--danger-ink)]">{error}</p><Button variant="outline" disabled={busy} onClick={retryRead}>Check saved setup</Button></div>}
      {view && !view.owner && !complete && <p>The connected company owner must complete this step.</p>}
      {view?.owner && !view.storage.ready && <>
        <Button variant="outline" disabled={busy} onClick={() => act('preview', {}, setPreview)}>Review preparation</Button>
        {preview && <div className="space-y-3 rounded-lg border border-[var(--line)] p-4">
          <p>Prepare business plans, observations, operation receipts and audit storage for this company. {preview.permissionChange ? 'Grant your account the lab-owner role.' : 'Keep your current lab-owner access.'} No QuickBooks records will change.</p>
          <p className="text-[var(--ink-2)]">This initial setup requires operation and authority storage to be empty. Existing business plans, cases and baseline observations are retained.</p>
          <Button disabled={busy} onClick={() => act('apply', { planHash: preview.planHash }, () => setPreview(null))}>{busy ? 'Preparing…' : 'Prepare storage and owner access'}</Button>
        </div>}
      </>}
      {view?.owner && view.storage.ready && view.coordination.state === 'unprepared' && <Button disabled={busy} onClick={() => act('coordination/prepare', {}, setPreparation)}>Prepare company write coordination</Button>}
      {view?.owner && view.storage.ready && ['preparing', 'active'].includes(view.coordination.state) && <form className="space-y-3 rounded-lg border border-[var(--line)] p-4" onSubmit={event => { event.preventDefault(); act('period-controls', { closedThrough: closedThrough || null, reconciledThrough: reconciledThrough || null, evidenceNote }) }}>
        <h3 className="font-semibold">Protect accounting periods</h3>
        <p>Record the dates you have closed or reconciled. A blank date records no additional cutoff. QuickBooks’ own closing date is checked before every financial write.</p>
        <div className="flex flex-wrap gap-4">
          <label className="space-y-1">Closed through<input className="block rounded border border-[var(--line)] bg-[var(--surface)] p-2" type="date" value={closedThrough} onChange={event => setClosedThrough(event.target.value)} /></label>
          <label className="space-y-1">Reconciled through<input className="block rounded border border-[var(--line)] bg-[var(--surface)] p-2" type="date" value={reconciledThrough} onChange={event => setReconciledThrough(event.target.value)} /></label>
        </div>
        <label className="block space-y-1">Evidence note<textarea className="block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" required minLength={10} maxLength={2000} value={evidenceNote} onChange={event => setEvidenceNote(event.target.value)} /></label>
        <p className="text-[var(--ink-2)]">These owner-recorded limits protect historical writes. They do not certify bank reconciliation. Saved cutoffs can only move forward here.</p>
        <Link to="/company/period-close" className="inline-block text-[var(--link)] underline">Review reconciliation, close or reopening</Link>
        {view.coordination.periodControl && <p role="status">Saved protection: closed through {view.coordination.periodControl.closedThrough || 'none'} · reconciled through {view.coordination.periodControl.reconciledThrough || 'none'}.</p>}
        <Button type="submit" disabled={busy || evidenceNote.trim().length < 10}>{view.coordination.periodControl ? 'Update protected dates' : 'Record protected dates'}</Button>
      </form>}
      {view?.owner && view.coordination.state === 'preparing' && <>
        <p>New company writes are paused. Activation checks that earlier workers and uncertain requests are settled.</p>
        {!preparation && <Button variant="outline" disabled={busy} onClick={() => act('coordination/prepare', {}, setPreparation)}>Read saved preparation</Button>}
        {preparation && <Button disabled={busy || !view.coordination.periodControl} onClick={() => act('coordination/activate', { preparationEvidenceHash: preparation.preparationEvidenceHash })}>Enable coordinated company writes</Button>}
      </>}
    </div>
  </section>
}
