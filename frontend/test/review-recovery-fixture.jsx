import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../src/components/ui/toast'
import { BusinessWorkspaceContent } from '../src/pages/BusinessWorkspace'
import { useBusinessWorkspace } from '../src/lib/useBusinessWorkspace'

const scope = { realmId: '123', environment: 'sandbox', connectionId: 'a'.repeat(24) }
const ENDPOINT = '/company/business-agent'
const storage = 'review-fixture-server'
function initial() {
 const now = Date.now(), stamp = new Date(now).toISOString()
 return { scope, viewerId: 'b'.repeat(24), owner: true, configured: true, revision: 7,
 settings: { monitoring: true, autonomous: true, specialists: [], instructions: '', syncIntervalSeconds: 30, decisionIntervalMinutes: 60 },
 agent: { id: 'd'.repeat(24), status: 'attention', lastError: '1 customer payment is already saved. The remaining bank deposit was not sent and needs a fresh plan.', errorDetail: { code: 'GENERAL_WRITE_REPLAN_REQUIRED', message: 'Invoice 100 changed in fresh evidence. Nothing was sent.' }, attention: { state: 'replan-remaining', saved: [{ entity: 'Payment', qboId: '501' }], next: 'Keep the saved payment. Prepare only the unsent deposit after checking current evidence.' }, summary: 'Monitoring the business.' },
 business: { published: true, authorityHash: 'c'.repeat(64), recoveries: [] },
 sync: { status: 'current', summaryAt: stamp, lastSuccessAt: stamp, summaryFreshUntil: new Date(now + 600000).toISOString(), sources: [{ entity: 'Invoice', complete: true, status: 'current', lastSuccessAt: stamp, freshUntil: new Date(now + 600000).toISOString() }] },
 company: { counts: {}, totals: { currency: 'CAD' }, recent: [] },
 rightNow: { state: 'idle', nextReviewAt: new Date(now + 600000).toISOString(), cadence: { kind: 'waiting', reason: 'On schedule; more work is due later' } }, events: [], decisions: [], work: { items: [] }, usage: {} }
}
function mockApi(mode) {
 const saved = JSON.parse(sessionStorage.getItem(storage) || 'null')
 const api = { state: saved?.state || initial(), calls: saved?.calls || [], receipts: saved?.receipts || {}, receiptReads: [], mode }
 const save = () => sessionStorage.setItem(storage, JSON.stringify({ state: api.state, calls: api.calls, receipts: api.receipts }))
 const accept = body => {
  const request = api.state.agent.reviewRequest?.pending ? api.state.agent.reviewRequest : { id: body.requestKey, state: 'queued', pending: true, requestedAt: new Date().toISOString(), title: 'Your review is queued', detail: 'The accountant will review the business after its current checks.' }
  api.state.agent.reviewRequest = request
  api.state.controlReceipt = { command: 'run-now', requestId: request.id, disposition: 'queued' }
  api.receipts[body.requestKey] = { requestId: request.id, disposition: 'queued', at: request.requestedAt }; save()
 }
 api.get = async path => {
  if (path === ENDPOINT) return { data: { data: structuredClone(api.state) } }
  if (path.startsWith(ENDPOINT + '/review-requests/')) {
   const requestKey = path.split('/').at(-1); api.receiptReads.push(requestKey)
   return { data: { data: { scope, requestKey, receipt: api.receipts[requestKey] || null } } }
  }
  throw Error('Unexpected fixture read')
 }
 api.post = async (path, body) => {
  if (path !== ENDPOINT + '/control' || body.command !== 'run-now') throw Error('Unexpected fixture mutation')
  api.calls.push(structuredClone(body)); save()
  if (mode === 'unrecorded' && api.calls.length === 1) throw Error('Acknowledgement lost before acceptance')
  accept(body)
  if (mode === 'uncertain') throw Error('Acknowledgement lost after acceptance')
  if (mode === 'held-response') return new Promise(resolve => { api.release = () => resolve({ data: { data: structuredClone(api.state) } }) })
  return { data: { data: structuredClone(api.state) } }
 }
 api.start = () => { api.state.agent.reviewRequest = { ...api.state.agent.reviewRequest, state: 'running', pending: true, attemptId: 'fixture-attempt-123', title: 'Your review is running', detail: 'Repeated requests join this review and do not restart it.' }; api.state.rightNow.state = 'reviewing'; save() }
 api.finish = (outcome = 'completed') => {
  api.state.agent.reviewRequest = { ...api.state.agent.reviewRequest, state: outcome, pending: false, attemptId: 'fixture-attempt-123', finishedAt: new Date().toISOString(), title: outcome === 'completed' ? 'Review completed' : 'Review ended with work remaining', detail: outcome === 'completed' ? 'Confirmed the existing payments and deposit. No new transactions were needed.' : 'Some work remains; inspect this exact review.' }
  api.state.agent.lastError = null; api.state.agent.status = 'ready'; api.state.rightNow.state = 'idle'
  api.state.business.recoveries = [{ operationId: 'original', note: 'Posting recovered; original failure and note remain in history.', replacements: [{ entity: 'Deposit', qboId: '600' }] }]; save()
 }
 return api
}
export function Workspace({ mode, reset }) {
 const api = useMemo(() => mockApi(mode), [mode])
 const workspace = useBusinessWorkspace(api, scope, true)
 const [selected, setSelected] = useState(null)
 useEffect(() => { window.reviewFixture = { api, reset, refresh: workspace.refresh, selected } }, [api, reset, workspace.refresh, selected])
 return <main style={{ padding: 24 }}><BusinessWorkspaceContent {...workspace} companyName="Example Business" connectionState="connected" onCommand={workspace.command} transcript={{ entries: [], following: !selected, attemptId: selected, selectedStatus: selected ? 'empty' : null, attempts: api.state.recentAttempts === false ? [] : [{ attemptId: 'fixture-attempt-123', role: 'accountant' }], select: setSelected }} /></main>
}
export function Harness() {
 const [mode, setMode] = useState(sessionStorage.getItem('review-fixture-mode') || 'normal')
 const [generation, setGeneration] = useState(0)
 const reset = next => { sessionStorage.clear(); sessionStorage.setItem('review-fixture-mode', next); setMode(next); setGeneration(n => n + 1) }
 return <MemoryRouter><ToastProvider><Workspace key={mode + generation} mode={mode} reset={reset} /></ToastProvider></MemoryRouter>
}
createRoot(document.getElementById('root')).render(<Harness />)
