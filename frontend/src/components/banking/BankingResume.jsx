import { useId, useState } from 'react'
import { Button } from '../ui/button'
import { bankingError } from '../../api/banking'

export default function BankingResume({ loop, api, onRefresh, stale = false }) {
  const id = useId()
  const [reason, setReason] = useState(''), [inspection, setInspection] = useState(null)
  const [state, setState] = useState({ busy: false, error: '', success: '' })
  const retry = loop.automaticRetry
  async function attach(event) {
    const file = event.target.files?.[0]
    setInspection(null)
    if (!file) return
    try {
      if (file.size > 10000) throw new Error('Choose a saved inspection reference under 10 KB.')
      const ref = JSON.parse(await file.text())
      if (typeof ref.path !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('The inspection reference needs its saved path and SHA-256 hash.')
      setInspection({ path: ref.path, sha256: ref.sha256 })
      setState({ busy: false, error: '', success: '' })
    } catch (error) { setState({ busy: false, error: error.message, success: '' }) }
  }
  async function resume(event) {
    event.preventDefault()
    setState({ busy: true, error: '', success: '' })
    try {
      await api.resume(loop.packageId, { reason: reason.trim(), ...(inspection ? { inspection } : {}) })
      setState({ busy: false, error: '', success: 'Resolution recorded. Scheduled banking can continue on its next check.' })
      onRefresh()
    } catch (error) { setState({ busy: false, error: bankingError(error), success: '' }) }
  }
  return <div className="banking-notice banking-notice--error">
    <p role="alert"><strong>Scheduled banking is paused. </strong>{loop.reason}</p>
    {retry && <p role="status">{retry.reason}. Automatic retries: {retry.attempts} of {retry.maxAttempts}.{!retry.eligible && retry.attempts < retry.maxAttempts && !loop.requiresInspection && <> Next check after {new Date(retry.retryAt).toLocaleString()}.</>}</p>}
    {loop.recoveryReason && <p role="status">Automatic recovery is waiting: {loop.recoveryReason}</p>}
    {loop.canResume ? <form className="banking-resume" onSubmit={resume}>
      <label htmlFor={id + '-reason'}>How was this stop resolved?</label>
      <textarea id={id + '-reason'} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} rows={2} required disabled={state.busy} placeholder="Describe what changed or what the inspection confirmed." />
      {loop.requiresInspection && <><p>A native action may have occurred. First retain a read-only inspection of this run’s bank transactions and screenshot in banking evidence storage, then attach its saved JSON reference confirming no native effect. Accepted or uncertain actions need evidence recovery before retry.</p><label htmlFor={id + '-inspection'}>Saved inspection reference (.json)</label><input id={id + '-inspection'} type="file" accept=".json,application/json" onChange={attach} disabled={state.busy} />{inspection && <p>Inspection reference attached. The server will verify the saved result and screenshot.</p>}</>}
      <Button type="submit" disabled={stale || state.busy || !reason.trim() || (loop.requiresInspection && !inspection)}>{state.busy ? 'Recording resolution…' : 'Resume banking'}</Button>
    </form> : <p>The company owner can record a resolution here before resuming.</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.success && <p role="status">{state.success}</p>}
  </div>
}
