import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../components/ui/toast'
import { workspaceScope } from './business-workspace.mjs'

const ENDPOINT = '/company/business-agent'

export function useBusinessWorkspace(api, scope, enabled) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [reviewWarning, setReviewWarning] = useState('')
  const reviewStorageKey = useRef(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState('')
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [readAt, setReadAt] = useState(0)
  const pendingReview = useRef(null)
  const current = useRef(null), sending = useRef(false), epoch = useRef(0), mounted = useRef(true), actionController = useRef(null)
  const toast = useToast()
  const scopeKey = [scope.realmId, scope.environment, scope.connectionId].join(':')
  const refresh = useCallback(() => setVersion(value => value + 1), [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionController.current?.abort() } }, [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController(); let timer
    async function load() {
      if (controller.signal.aborted) return
      if (sending.current) { timer = setTimeout(load, 1000); return }
      const started = epoch.current
      setRefreshing(true)
      try {
        const response = await api.get(ENDPOINT, { signal: controller.signal, timeout: 12000 })
        const next = workspaceScope(response.data?.data, scope)
        if (!controller.signal.aborted && started === epoch.current) {
          current.current = next; setData(next); setError(''); setReadAt(Date.now())
          if (next.owner && next.viewerId) {
            reviewStorageKey.current = 'tdl.pending-review:' + scopeKey + ':' + next.viewerId
            if (!pendingReview.current) {
              try { const retained = JSON.parse(sessionStorage.getItem(reviewStorageKey.current)); if (retained?.command === 'run-now' && retained.expectedAgentId === next.agent?.id && Number.isSafeInteger(retained.expectedRevision) && /^[a-zA-Z0-9_-]{16,100}$/.test(retained.requestKey || '') && Object.keys(retained).sort().join(',') === 'command,expectedAgentId,expectedRevision,requestKey') pendingReview.current = retained } catch { /* A missing browser receipt never changes company state. */ }
            }
          }
          if (pendingReview.current) {
            const checkingKey = pendingReview.current.requestKey
            const receiptResponse = await api.get(ENDPOINT + '/review-requests/' + checkingKey, { signal: controller.signal, timeout: 8000 })
            const receipt = receiptResponse.data?.data
            if (!receipt?.scope || !Object.keys(scope).every(key => String(receipt.scope[key]) === String(scope[key]))) throw new Error('The selected company changed while confirming the review request.')
            if (!controller.signal.aborted && started === epoch.current && pendingReview.current?.requestKey === checkingKey && receipt.requestKey === checkingKey && receipt.receipt) { pendingReview.current = null; try { sessionStorage.removeItem(reviewStorageKey.current) } catch { /* Storage can be disabled. */ } setActionError(''); setReviewWarning('') }
            else if (!controller.signal.aborted && started === epoch.current && pendingReview.current?.requestKey === checkingKey) setReviewWarning('No saved receipt was found yet. Retrying uses the same request identifier, so it cannot request the review twice.')
          } else setActionError('')
        }
      } catch (failure) {
        if (!controller.signal.aborted && started === epoch.current) setError(failure.response?.data?.error || failure.message || 'Company monitoring could not be read. Your saved business and instructions have been kept.')
      } finally {
        if (!controller.signal.aborted) { setNow(Date.now()); setRefreshing(false); timer = setTimeout(load, 5000) }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
    // Company changes remount the workspace; validate every response against that exact scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, scopeKey, version])
  const fresh = !!data && !error && !actionError && now - readAt < 20000
  async function command(name, extra = {}) {
    if (sending.current || !current.current?.owner || !fresh) return false
    sending.current = true; epoch.current++; setBusy(name); setActionError('')
    const controller = new AbortController(); actionController.current = controller
    try {
      const body = name === 'run-now' && pendingReview.current ? pendingReview.current : { command: name, expectedRevision: current.current.revision, requestKey: crypto.randomUUID(), ...(name === 'run-now' ? { expectedAgentId: current.current.agent.id } : {}), ...extra }
      if (name === 'run-now') { pendingReview.current = body; try { if (reviewStorageKey.current) sessionStorage.setItem(reviewStorageKey.current, JSON.stringify(body)) } catch { /* The server still records every accepted request. */ } }
      const response = await api.post(ENDPOINT + '/control', body, { signal: controller.signal, timeout: 30000 })
      const next = workspaceScope(response.data?.data, scope)
      if (mounted.current) {
        current.current = next; setData(next); setError(''); setActionError(''); setReadAt(Date.now()); setNow(Date.now()); if (name === 'run-now') { pendingReview.current = null; try { sessionStorage.removeItem(reviewStorageKey.current) } catch { /* Storage can be disabled. */ } setReviewWarning('') }
        toast.success(name === 'run-now' ? next.controlReceipt?.disposition === 'already-running' ? 'The accountant is already reviewing. Your request joins that review.' : next.controlReceipt?.disposition === 'already-queued' ? 'Your review is already queued. It will not be requested twice.' : 'Your review request is saved. Its progress and result appear above the live activity.' : name === 'save-instructions' ? 'Your instructions are saved for the accountant.' : name === 'respond-decision' ? 'Your decision is recorded.' : 'Business controls updated.')
      }
      return true
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        const definite = failure.response?.status && failure.response.status < 500
        if (name === 'run-now' && definite) { pendingReview.current = null; try { sessionStorage.removeItem(reviewStorageKey.current) } catch { /* Storage can be disabled. */ } }
        const message = failure.response?.data?.error || (name === 'run-now' ? 'Your review request could not be confirmed. Checking its saved receipt; a refresh will not send another request.' : 'The action could not be confirmed. Refresh saved state before trying again.')
        if (name === 'run-now' && !definite) { setReviewWarning(message); setActionError('') } else setActionError(message)
        toast.error(message)
      }
      return false
    } finally {
      sending.current = false; actionController.current = null
      if (mounted.current) { setBusy(''); refresh() }
    }
  }
  return { data, reviewWarning, error: error || actionError, refreshing, busy, fresh, now, refresh, command }
}
