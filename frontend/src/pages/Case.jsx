import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowUp, Check, CircleDashed, CircleX, Copy, ExternalLink, FileText, LoaderCircle, Minus,
} from 'lucide-react'
import Layout from '../components/Layout'
import ProductionGuardDialog from '../components/ProductionGuardDialog'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import { qboRecordLabel, qboRecordUrl, stepRecordType } from '@/lib/qbo-links'
import { cn } from '@/lib/utils'

// A case is one customer issue moving through four stages:
// describe -> review the proposed changes -> run them -> check in QuickBooks.
const STAGES = ['Describe', 'Review changes', 'Run', 'Check in QuickBooks']

function stageFor(plan) {
  if (!plan) return 0
  if (['proposed', 'approved', 'partially_approved'].includes(plan.status)) return 1
  if (plan.status === 'executing') return 2
  if (['completed', 'failed'].includes(plan.status)) return 3
  return 0
}

function Stepper({ current }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]" aria-label="Case progress">
      {STAGES.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            aria-current={i === current ? 'step' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5',
              i < current && 'text-[var(--ok)]',
              i === current && 'bg-[var(--ink)] font-medium text-white',
              i > current && 'text-[var(--ink-3)]',
            )}
          >
            {i < current && <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
            {label}
          </span>
          {i < STAGES.length - 1 && <span className="h-px w-4 bg-[var(--line-strong)]" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  )
}

function Message({ role, children }) {
  const isUser = role === 'user'
  return (
    <div className={cn('flex', isUser && 'justify-end')}>
      <div
        className={cn(
          'max-w-[88%] whitespace-pre-wrap rounded-[12px] px-4 py-3 text-[14px] leading-relaxed',
          isUser ? 'bg-[var(--ink)] text-white' : 'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)]',
        )}
      >
        {children}
      </div>
    </div>
  )
}

function Thinking({ since }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] border border-dashed border-[var(--line-strong)] px-4 py-3 text-[13.5px] text-[var(--ink-2)]" role="status">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      Looking through your company and working out the changes… <span className="tabular text-[var(--ink-3)]">{seconds}s</span>
    </div>
  )
}

// Record types the in-app Records page can search by document number.
const EXPLORER_TYPES = {
  invoice: 'Invoice', bill: 'Bill', creditmemo: 'CreditMemo', vendorcredit: 'VendorCredit',
  estimate: 'Estimate', journalentry: 'JournalEntry', deposit: 'Deposit',
}

const STEP_ICON = {
  completed: { Icon: Check, cls: 'bg-[var(--ok)] text-white border-[var(--ok)]' },
  failed: { Icon: CircleX, cls: 'bg-[var(--danger-soft)] text-[var(--danger-ink)] border-[var(--danger-soft)]' },
  executing: { Icon: LoaderCircle, cls: 'text-[var(--ink-2)] border-[var(--line-strong)]', spin: true },
  skipped: { Icon: Minus, cls: 'text-[var(--ink-3)] border-[var(--line)]' },
  rejected: { Icon: Minus, cls: 'text-[var(--ink-3)] border-[var(--line)]' },
}

function StepRow({ step, environment }) {
  const icon = STEP_ICON[step.status]
  const recordType = stepRecordType(step)
  const record = step.result?.data
  const url = step.status === 'completed' && recordType ? qboRecordUrl(recordType, record?.id, environment) : null
  return (
    <li className="flex gap-3 px-5 py-3.5">
      {icon ? (
        <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border', icon.cls)} aria-hidden="true">
          <icon.Icon className={cn('size-3', icon.spin && 'animate-spin')} strokeWidth={2.5} />
        </span>
      ) : (
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-[var(--line-strong)] text-[11px] font-medium text-[var(--ink-2)] tabular" aria-hidden="true">
          {step.stepNumber}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('text-[13.5px] leading-snug', ['skipped', 'rejected'].includes(step.status) ? 'text-[var(--ink-3)] line-through' : 'text-[var(--ink)]')}>
          {step.description}
        </p>
        {step.status === 'failed' && (
          <p className="mt-1 text-[12.5px] text-[var(--danger-ink)]">{step.error || step.result?.error || 'This change failed.'}</p>
        )}
        {step.toolInput && (
          <details className="mt-1.5 text-[12px] text-[var(--ink-3)]">
            <summary className="cursor-pointer select-none hover:text-[var(--ink-2)]">Data the assistant proposed</summary>
            <pre className="mt-1.5 max-h-56 overflow-auto rounded-md bg-[var(--sunken)] p-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--ink-2)]">{JSON.stringify(step.toolInput, null, 2)}</pre>
          </details>
        )}
        {url && (
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[12.5px]">
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-[var(--link)] no-underline hover:underline">
              Open {qboRecordLabel(recordType).toLowerCase()}{record?.docNumber ? ` ${record.docNumber}` : ''} in QuickBooks <ExternalLink className="size-3" aria-hidden="true" />
            </a>
            {record?.docNumber && EXPLORER_TYPES[String(recordType).toLowerCase()] && (
              <Link to={`/explorer?type=${EXPLORER_TYPES[String(recordType).toLowerCase()] || 'Invoice'}&q=${encodeURIComponent(record.docNumber)}`} className="text-[var(--ink-2)] no-underline hover:underline">
                View in Records
              </Link>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

function ChangesPanel({ plan, environment, canWrite, onRun, onDiscard, busy, actionError }) {
  if (!plan) {
    return (
      <div className="px-5 py-6 text-[13px] leading-relaxed text-[var(--ink-3)]">
        No changes proposed yet. When the assistant knows what to create, the exact list appears here for you to review before anything is touched.
      </div>
    )
  }
  const pending = ['proposed', 'approved', 'partially_approved'].includes(plan.status)
  const done = plan.steps.filter((s) => s.status === 'completed').length
  const failed = plan.steps.filter((s) => s.status === 'failed').length

  return (
    <>
      <ul className="divide-y divide-[var(--line)]">
        {plan.steps.map((step) => <StepRow key={step._id || step.stepNumber} step={step} environment={environment} />)}
      </ul>
      <div className="border-t border-[var(--line)] px-5 py-4">
        {pending && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="lg" onClick={onRun} disabled={busy || !canWrite}>
                {busy ? <LoaderCircle className="animate-spin" /> : null}
                {busy ? 'Running…' : `Make ${plan.steps.length === 1 ? 'this change' : `these ${plan.steps.length} changes`}`}
              </Button>
              <Button size="lg" variant="ghost" onClick={onDiscard} disabled={busy}>Discard</Button>
            </div>
            {!canWrite && (
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                Making changes is switched off on the lab server. Set <code className="font-mono text-[12px]">LEGACY_AI_MUTATIONS_ENABLED=true</code> in the backend .env and restart the backend.
              </p>
            )}
          </>
        )}
        {plan.status === 'executing' && <p className="text-[13px] text-[var(--ink-2)]">Making the changes in QuickBooks…</p>}
        {plan.status === 'completed' && (
          <p className="text-[13px] text-[var(--ok)]">Done. {done} {done === 1 ? 'change' : 'changes'} made. Open the records to confirm the customer's view.</p>
        )}
        {plan.status === 'failed' && (
          <p className="text-[13px] text-[var(--danger-ink)]">{done} made, {failed} failed. Records already created stay in QuickBooks; ask the assistant to adjust and continue.</p>
        )}
        {plan.status === 'rejected' && <p className="text-[13px] text-[var(--ink-3)]">Discarded. Nothing was changed.</p>}
        {actionError && <p className="mt-2.5 text-[12.5px] text-[var(--danger-ink)]">{actionError}</p>}
      </div>
    </>
  )
}

function CaseNote({ sessionId }) {
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const write = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await client.post('/ai/generate-note', { sessionId, format: 'internal' })
      setNote(res.data?.data?.note?.content || '')
    } catch (err) {
      setError(err.response?.data?.error || 'The note could not be written.')
    } finally {
      setBusy(false)
    }
  }

  const copy = () => navigator.clipboard?.writeText(note).then(() => {
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }).catch(() => {})

  return (
    <section className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
        <h2 className="text-[13px] font-semibold text-[var(--ink)]">Case note</h2>
        {note && (
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-[12.5px] text-[var(--ink-2)] hover:text-[var(--ink)]">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </header>
      {note ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-5 py-4 font-sans text-[13px] leading-relaxed text-[var(--ink)]">{note}</pre>
      ) : (
        <div className="px-5 py-4">
          <p className="text-[13px] text-[var(--ink-2)]">Summarize what was reproduced and where to find it, ready to paste into the ticket.</p>
          <Button className="mt-3" variant="outline" onClick={write} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : <FileText />} {busy ? 'Writing…' : 'Write note'}
          </Button>
          {error && <p className="mt-2 text-[12.5px] text-[var(--danger-ink)]">{error}</p>}
        </div>
      )}
    </section>
  )
}

export default function Case() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const connection = useConnection()
  const isNew = id === 'new'
  const initialMessage = isNew ? location.state?.message : null

  const [session, setSession] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [pending, setPending] = useState(null) // { text, since }
  const [chatError, setChatError] = useState(null)
  const [failedText, setFailedText] = useState(null)
  const [reply, setReply] = useState('')
  const [canWrite, setCanWrite] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [guardError, setGuardError] = useState(null)
  const [version, setVersion] = useState(0)
  const started = useRef(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    client.get('/ai/config')
      .then((res) => { if (!cancelled) setCanWrite(res.data?.data?.featureFlags?.aiMutations === true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // A brand-new case sends the description first, then moves to its own URL.
  const startCase = async (text) => {
    setChatError(null)
    setFailedText(null)
    setPending({ text, since: Date.now() })
    try {
      const res = await client.post('/ai/chat', { message: text })
      const newId = res.data?.data?.session?._id
      setPending(null)
      if (newId) navigate(`/cases/${newId}`, { replace: true })
    } catch (err) {
      setPending(null)
      setFailedText(text)
      setChatError(err.response?.data?.error || 'The assistant could not start this case.')
    }
  }

  useEffect(() => {
    if (!isNew || started.current) return
    started.current = true
    if (!initialMessage) {
      navigate('/', { replace: true })
      return
    }
    startCase(initialMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, initialMessage])

  useEffect(() => {
    if (isNew) return
    let cancelled = false
    client.get(`/ai/sessions/${id}`)
      .then((res) => { if (!cancelled) { setSession(res.data?.data?.session || null); setLoadError(null) } })
      .catch((err) => { if (!cancelled) setLoadError(err.response?.status === 404 ? 'This case does not exist.' : (err.response?.data?.error || 'The case could not be loaded.')) })
    return () => { cancelled = true }
  }, [id, isNew, version])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [session?.messages?.length, pending])

  const plans = session?.plans || []
  const plan = plans[plans.length - 1] || null
  const environment = connection?.environment

  const sendReply = async (e) => {
    e.preventDefault()
    const text = reply.trim()
    if (!text || pending) return
    setReply('')
    setChatError(null)
    setPending({ text, since: Date.now() })
    try {
      await client.post('/ai/chat', { sessionId: id, message: text })
      setVersion((v) => v + 1)
    } catch (err) {
      setReply(text)
      setChatError(err.response?.data?.error || 'The assistant could not answer.')
    } finally {
      setPending(null)
    }
  }

  const run = async () => {
    setRunning(true)
    setGuardError(null)
    setActionError(null)
    try {
      if (plan.status === 'proposed') await client.post(`/ai/plan/${plan._id}/approve`, {})
      await client.post(`/ai/plan/${plan._id}/execute`, connection?.isProduction ? { confirmProduction: true } : {})
      setConfirmOpen(false)
      setVersion((v) => v + 1)
    } catch (err) {
      const data = err.response?.data
      const message = typeof data?.error === 'string' ? data.error : data?.error?.message
      if (err.response?.status === 412) {
        setGuardError(message || 'Production confirmation is required.')
      } else {
        setConfirmOpen(false)
        setActionError(message || 'The changes could not be made.')
        setVersion((v) => v + 1)
      }
    } finally {
      setRunning(false)
    }
  }

  const discard = async () => {
    setActionError(null)
    try {
      await client.post(`/ai/plan/${plan._id}/reject`)
      setVersion((v) => v + 1)
    } catch (err) {
      setActionError(err.response?.data?.error || 'The proposal could not be discarded.')
    }
  }

  const messages = (session?.messages || []).filter((m) => ['user', 'assistant'].includes(m.role) && m.content?.trim())
  const title = session?.title || initialMessage || 'New case'
  const busy = Boolean(pending)

  return (
    <Layout>
      <div className="mx-auto max-w-[1180px]">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--ink-2)] no-underline hover:text-[var(--ink)]">
          <ArrowLeft className="size-3.5" aria-hidden="true" /> All cases
        </Link>
        <div className="mt-2 flex flex-col gap-3">
          <h1 className="max-w-[60ch] text-[22px] font-semibold leading-snug tracking-[-0.015em] text-[var(--ink)]">{title}</h1>
          <Stepper current={stageFor(plan)} />
        </div>

        {loadError ? (
          <p className="mt-8 text-[13.5px] text-[var(--ink-2)]">{loadError} <Link to="/" className="font-medium text-[var(--link)]">Back to Reproduce</Link></p>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
            {/* Conversation */}
            <section className="flex min-h-[420px] flex-col rounded-[10px] border border-[var(--line)] bg-[var(--canvas)]" aria-label="Conversation">
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
                {!session && !pending && !chatError && (
                  <p className="flex items-center gap-2 text-[13px] text-[var(--ink-3)]"><LoaderCircle className="size-3.5 animate-spin" /> Loading case…</p>
                )}
                {messages.map((m, i) => <Message key={i} role={m.role}>{m.content}</Message>)}
                {pending && (
                  <>
                    <Message role="user">{pending.text}</Message>
                    <Thinking since={pending.since} />
                  </>
                )}
                {failedText && <Message role="user">{failedText}</Message>}
                {chatError && (
                  <div className="rounded-[10px] bg-[var(--danger-soft)] px-4 py-3 text-[13px] text-[var(--danger-ink)]" role="alert">
                    {chatError}
                    {failedText && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => startCase(failedText)}>Try again</Button>
                        <Link to="/" className="text-[12.5px] font-medium text-[var(--ink-2)] hover:underline">Back to Reproduce</Link>
                      </div>
                    )}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              {!isNew && (
                <form onSubmit={sendReply} className="border-t border-[var(--line)] p-3">
                  <div className="flex items-end gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] p-2 focus-within:border-[var(--ink-3)]">
                    <label htmlFor="case-reply" className="sr-only">Reply to the assistant</label>
                    <textarea
                      id="case-reply"
                      rows={2}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) sendReply(e) }}
                      placeholder="Add detail, answer a question, or ask for different changes"
                      className="min-h-[40px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)]"
                      disabled={!connection?.ready}
                    />
                    <Button type="submit" size="icon-lg" disabled={busy || !reply.trim() || !connection?.ready} aria-label="Send">
                      <ArrowUp />
                    </Button>
                  </div>
                </form>
              )}
            </section>

            {/* What will change in QuickBooks */}
            <aside className="flex min-w-0 flex-col gap-5">
              <section className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
                <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
                  <h2 className="text-[13px] font-semibold text-[var(--ink)]">Changes to QuickBooks</h2>
                  {plan && (
                    <span className="text-[12px] text-[var(--ink-3)]">
                      {plan.steps.length} {plan.steps.length === 1 ? 'change' : 'changes'}
                    </span>
                  )}
                </header>
                {busy && !plan ? (
                  <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-[var(--ink-3)]"><CircleDashed className="size-4" /> Waiting for the assistant…</div>
                ) : (
                  <ChangesPanel
                    plan={plan}
                    environment={environment}
                    canWrite={canWrite}
                    busy={running}
                    actionError={actionError}
                    onRun={() => { setGuardError(null); setConfirmOpen(true) }}
                    onDiscard={discard}
                  />
                )}
              </section>
              {plans.length > 1 && (
                <p className="px-1 text-[12px] text-[var(--ink-3)]">Showing the latest of {plans.length} proposals in this case.</p>
              )}
              {plan?.status === 'completed' && <CaseNote sessionId={id} />}
            </aside>
          </div>
        )}
      </div>

      <ProductionGuardDialog
        key={confirmOpen ? `run-${plan?._id}` : 'closed'}
        open={confirmOpen}
        environment={environment}
        title={`Make ${plan?.steps?.length || 0} ${plan?.steps?.length === 1 ? 'change' : 'changes'} in QuickBooks?`}
        description="Each listed change is made in order: new records are created, edits are saved and voids are applied. QuickBooks keeps all of them afterwards; nothing is deleted."
        actionLabel="Make changes"
        loading={running}
        error={guardError}
        onConfirm={run}
        onCancel={() => setConfirmOpen(false)}
      />
    </Layout>
  )
}
