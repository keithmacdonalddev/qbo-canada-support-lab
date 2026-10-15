import { useCallback, useEffect, useState } from 'react'
import client from '../api/client'
import { Button } from '@/components/ui/button'

export default function AccountAutomationReview() {
  const [review, setReview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const load = useCallback(async () => {
    setError('')
    setAcknowledged(false)
    try { setReview((await client.get('/auth/automation-review')).data) }
    catch (err) { setError(err.response?.data?.error || 'Account automation status could not be checked.') }
  }, [])
  useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer) }, [load])
  const enable = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await client.post('/auth/automation-enable', { reviewHash: review.reviewHash, acknowledgeRetainedWork: acknowledged })
      setReview(result.data)
    } catch (err) {
      setAcknowledged(false)
      try {
        const current = (await client.get('/auth/automation-review')).data
        setReview(current)
        if (!current.enabled) setError(err.response?.data?.error || 'The decision was not confirmed. Read the current review before retrying.')
      } catch {
        setReview(null)
        setError('Automation status is unknown. It may already be enabled. Read current access before retrying.')
      }
    } finally { setBusy(false) }
  }
  if (error) return <div className="border-t border-[var(--line)] px-5 py-4"><p role="alert" className="text-[13px] text-[var(--danger-ink)]">{error}</p><Button variant="outline" className="mt-3" onClick={load}>Read current access</Button></div>
  if (review?.enabled) return <p role="status" className="border-t border-[var(--line)] px-5 py-4 text-[13px] text-[var(--ok)]">Automation enabled. Retained work still follows its original permissions, approvals and company write controls.</p>
  if (!review) return <p role="status" className="border-t border-[var(--line)] px-5 py-4 text-[13px] text-[var(--ink-3)]">Checking account automation…</p>
  if (!review.required) return null
  return <section aria-labelledby="account-automation-heading" className="border-t border-[var(--line)] px-5 py-4">
    <h3 id="account-automation-heading" className="text-[14px] font-semibold text-[var(--ink)]">Private sign-in restored; automation paused</h3>
    <p className="mt-2 text-[13px] text-[var(--ink-2)]">Your account and its saved work were preserved during credential recovery. Read the retained entries below. Stop unwanted work on its own page before enabling automation.</p>
    <div className="mt-3 space-y-2">
      {review.groups.map(group => <details key={group.key} className="rounded-lg border border-[var(--line)] p-3">
        <summary className="cursor-pointer text-[13px] font-medium">{group.label}: {group.total} retained, {group.entries.length} require review</summary>
        {group.history && <p className="mt-2 text-[12px] text-[var(--ink-3)]">History states: {Object.entries(group.history).map(([state, count]) => `${state}: ${count}`).join(' · ')}</p>}
        {group.entries.length ? <div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-left text-[12px]"><thead><tr><th className="pb-2 pr-3">Reference</th><th className="pb-2 pr-3">Company / environment</th><th className="pb-2">State</th></tr></thead><tbody>{group.entries.map(entry => <tr key={entry.id} className="border-t border-[var(--line)]"><td className="break-all py-2 pr-3 font-mono">{entry.id}</td><td className="py-2 pr-3">{entry.realmId}<br />{entry.environment}</td><td className="py-2">{entry.status}{entry.uncertain && <span className="block text-[var(--danger-ink)]">Uncertain write: inspect before continuing</span>}</td></tr>)}</tbody></table></div> : <p className="mt-2 text-[12px] text-[var(--ink-3)]">No pending, authorized or uncertain entries.</p>}
      </details>)}
    </div>
    <p className="mt-3 text-[13px] text-[var(--ink-2)]">{review.notice}</p>
    <label className="mt-4 flex items-start gap-2 text-[13px]"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy} className="mt-0.5" /><span>I reviewed the retained work and authorize existing approved or submitted work to continue under its original controls.</span></label>
    <Button className="mt-3" disabled={busy || !acknowledged} onClick={enable}>{busy ? 'Enabling…' : 'Enable account automation'}</Button>
  </section>
}
