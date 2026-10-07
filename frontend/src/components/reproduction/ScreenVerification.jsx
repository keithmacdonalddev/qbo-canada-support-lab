import { useEffect, useState } from 'react'
import client from '@/api/client'
import { qboRecordUrl } from '@/lib/qbo-links'

function companionMessage(type, request, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const messageId = crypto.randomUUID()
    const done = (result) => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(result) }
    const onMessage = (event) => {
      if (event.source === window && event.origin === window.location.origin
          && event.data?.type === 'tdl-screen-result' && event.data.protocolVersion === 2 && event.data.messageId === messageId) done(event.data.result)
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('The Chrome screen reader is not connected.'))
    }, timeout)
    window.addEventListener('message', onMessage)
    window.postMessage({ type, protocolVersion: 2, messageId, ...(request ? { request } : {}) }, window.location.origin)
  })
}

export default function ScreenVerification({ sessionId, run }) {
  const [status, setStatus] = useState('Checking the Chrome connection…')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)
  const active = run?.status === 'running'
  useEffect(() => {
    if (!sessionId || sessionId === 'new') return
    let cancelled = false
    let timer
    let lastHeartbeat = 0
    let connected = false
    const handled = new Set()
    const tick = async () => {
      try {
        if (Date.now() - lastHeartbeat > 10000) {
          let response
          try { response = await companionMessage('tdl-screen-status') }
          catch (err) { response = { ready: false, error: err.message } }
          if (cancelled) return
          connected = response?.ready === true
          setReady(connected)
          setStatus(connected ? 'Automatic screen checks ready.' : response?.error || 'Install or update the Chrome screen reader.')
          await client.post('/ai/sessions/' + sessionId + '/screen', { type: 'heartbeat', ready: connected })
          lastHeartbeat = Date.now()
        }
        if (active && connected && !cancelled) {
          const res = await client.get('/ai/sessions/' + sessionId + '/screen')
          const request = res.data?.data?.request
          if (request && !handled.has(request.nonce)) {
            handled.add(request.nonce)
            setStatus('Reading the ' + (request.field === 'receivedQuantity' ? 'Received' : 'Billed') + ' column on PO ' + request.docNumber + '…')
            let receipt
            try { receipt = await companionMessage('tdl-screen-capture', request, Math.max(2000, Math.min(60000, request.expiresAt - Date.now() + 2000))) }
            catch (err) { receipt = { error: err.message } }
            if (cancelled) return
            await client.post('/ai/sessions/' + sessionId + '/screen', { type: 'receipt', nonce: request.nonce, ...receipt })
            setStatus(receipt?.error ? 'Screen check unavailable: ' + receipt.error : 'Screen evidence returned to the assistant.')
          }
        }
        if (!cancelled) setError(null)
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || 'The screen connection could not be checked.')
      } finally { if (!cancelled) timer = setTimeout(tick, active ? 1500 : 10000) }
    }
    tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [sessionId, active])
  const evidence = (run?.checks || []).filter((c) => c.evidence?.kind === 'observed_screen')
  return <section className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4" aria-label="QuickBooks screen checks">
    <h2 className="text-[14px] font-semibold">QuickBooks screen checks</h2>
    <p className="mt-1 text-[13px] text-[var(--ink-2)]" role="status">{status}</p>
    {ready && <p className="mt-1 text-[12px] text-[var(--ink-3)]">Keep this case page open. The reader briefly shows its own QuickBooks tab, reads the screen, then returns to your previous tab. It reconnects automatically. Screen checks do not change transactions.</p>}
    {!ready && <details className="mt-2 text-[13px] text-[var(--ink-2)]">
      <summary className="cursor-pointer font-medium text-[var(--link)]">One-time Chrome setup</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>Open Chrome’s Extensions page, turn on Developer mode, and choose Load unpacked.</li>
        <li>Select <code>C:\Projects\qbo\extensions\qbo-screen-reader</code>.</li>
        <li>Allow the extension access to the listed QuickBooks sites when Chrome asks. Existing installations need one extension reload to apply the update.</li>
        <li>Stay signed in to QuickBooks in this Chrome profile. The reader connects automatically; no ON click is needed.</li>
      </ol>
      <p className="mt-2">The first reader supports English purchase orders with a visible Billed or Received quantity column. Other layouts remain unverified. If you edit a reader tab, it is left untouched and the next check uses a fresh tab.</p>
    </details>}
    {evidence.length > 0 && <details className="mt-3 text-[13px]">
      <summary className="cursor-pointer font-medium">Saved screen evidence ({evidence.length})</summary>
      <ul className="mt-2 space-y-2">{evidence.map((check, index) => <li key={index}>
        <a className="text-[var(--link)] hover:underline" href={qboRecordUrl('PurchaseOrder', check.evidence.id, check.evidence.environment)} target="_blank" rel="noreferrer">PO {check.evidence.docNumber}</a>
        {' · ' + (check.evidence.field === 'receivedQuantity' ? 'Received' : 'Billed') + ' quantity: ' + check.actual + ' · ' + new Date(check.evidence.capturedAt).toLocaleString()}
        {check.revision !== run.revision && <span className="block text-[var(--ink-3)]">Recorded before later case changes; needs checking again.</span>}
        <ul className="ml-4 text-[12px] text-[var(--ink-2)]">{check.evidence.rows.map((row, i) => <li key={i}>{row.item}: {row.quantity} ordered · {row.label}: {row.text}</li>)}</ul>
      </li>)}</ul>
    </details>}
    {error && <p role="alert" className="mt-2 text-[13px] text-[var(--danger-ink)]">{error}</p>}
  </section>
}
