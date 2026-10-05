import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowLeftRight, ArrowUp, Banknote, BookOpen, Check, ChevronDown, CircleDashed, CircleX, Clock, Copy,
  CreditCard, ExternalLink, FileText, HandCoins, Landmark, LoaderCircle, Minus, Package, Receipt, Users, Wallet,
} from 'lucide-react'
import Layout from '../components/Layout'
import ProductionGuardDialog from '../components/ProductionGuardDialog'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import { qboRecordUrl } from '@/lib/qbo-links'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/ui/markdown'

// A case is one customer issue moving through four stages:
// describe -> review the proposed changes -> run them -> check in QuickBooks.
const STAGES = ['Describe', 'Review changes', 'Run', 'Check in QuickBooks']

// A short heading from a case's opening message: its first sentence (unless that is
// a fragment like "Hi." or "1."), cut at a word.
function caseTitle(text) {
  const line = String(text || '').split('\n').find((l) => l.trim())?.trim() || ''
  const first = line.match(/^.+?[.!?](?=\s|$)/)?.[0]
  const sentence = first && first.length >= 15 ? first : line
  if (sentence.length <= 90) return sentence
  return `${sentence.slice(0, 91).replace(/\s+\S*$/, '')}…`
}

function stageFor(plan) {
  if (!plan) return 0
  if (['proposed', 'approved', 'partially_approved'].includes(plan.status)) return 1
  if (plan.status === 'executing') return 2
  if (['completed', 'failed'].includes(plan.status)) return 3
  return 0
}

const money = (n) => (n === null || n === undefined ? '' : `$${Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const shortDate = (d) => {
  if (!d) return ''
  const date = new Date(`${String(d).slice(0, 10)}T12:00:00`)
  return Number.isNaN(date.getTime()) ? String(d) : date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
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
              i === current && 'bg-[var(--link-soft)] font-medium text-[var(--link)]',
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

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

// Long assistant replies start folded so the thread stays scannable.
function AssistantText({ text }) {
  const long = text.length > 700
  const [open, setOpen] = useState(!long)
  return (
    <div>
      <div className={cn('relative', !open && 'max-h-[9.5rem] overflow-hidden')}>
        <Markdown text={text} />
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--surface)] to-transparent" aria-hidden="true" />}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1.5 text-[12.5px] font-medium text-[var(--link)] hover:underline">
          {open ? 'Show less' : 'Show the whole reply'}
        </button>
      )}
    </div>
  )
}

function Message({ role, children }) {
  const isUser = role === 'user'
  return (
    <div
      className={cn(
        'rounded-[10px] border px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--ink)]',
        isUser ? 'border-[var(--link-soft)] bg-[var(--link-soft)]' : 'border-[var(--line)] bg-[var(--surface)]',
      )}
    >
      <p className={cn('mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em]', isUser ? 'text-[var(--link)]' : 'text-[var(--ink-3)]')}>
        {isUser ? 'Request' : 'Assistant'}
      </p>
      {isUser || typeof children !== 'string' ? <div className="whitespace-pre-wrap">{children}</div> : <AssistantText text={children} />}
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
    <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-[var(--line-strong)] px-3.5 py-3 text-[13px] text-[var(--ink-2)]" role="status">
      <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      Looking through your company and working out the changes… <span className="tabular text-[var(--ink-3)]">{seconds}s</span>
    </div>
  )
}

function Conversation({ messages, pending, failedText, chatError, onRetry, loading, isNew, reply, setReply, onSend, canSend, busy }) {
  const bottomRef = useRef(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length, pending])

  return (
    <section className="flex min-h-0 flex-col rounded-[12px] border border-[var(--line)] bg-[var(--canvas)]" aria-label="Conversation">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-[var(--ink)]">Conversation</h2>
        {messages.length > 0 && <span className="text-[12px] text-[var(--ink-3)]">{messages.length} {messages.length === 1 ? 'message' : 'messages'}</span>}
      </header>
      <div className="flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto p-3">
        {loading && <p className="flex items-center gap-2 px-1 py-2 text-[13px] text-[var(--ink-3)]"><LoaderCircle className="size-3.5 animate-spin" /> Loading case…</p>}
        {messages.map((m, i) => <Message key={i} role={m.role}>{m.content}</Message>)}
        {pending && (
          <>
            <Message role="user">{pending.text}</Message>
            <Thinking since={pending.since} />
          </>
        )}
        {failedText && <Message role="user">{failedText}</Message>}
        {chatError && (
          <div className="rounded-[10px] bg-[var(--danger-soft)] px-3.5 py-3 text-[13px] text-[var(--danger-ink)]" role="alert">
            {chatError}
            {failedText && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
                <Link to="/" className="text-[12.5px] font-medium text-[var(--ink-2)] hover:underline">Back to Reproduce</Link>
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {!isNew && (
        <form onSubmit={onSend} className="border-t border-[var(--line)] p-3">
          <div className="flex items-end gap-2 rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] p-2 focus-within:border-[var(--ink-3)]">
            <label htmlFor="case-reply" className="sr-only">Reply to the assistant</label>
            <textarea
              id="case-reply"
              rows={2}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) onSend(e) }}
              placeholder="Ask for different changes or add detail"
              className="min-h-[40px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)]"
              disabled={!canSend}
            />
            <Button type="submit" size="icon-lg" disabled={busy || !reply.trim() || !canSend} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Changes in QuickBooks
// ---------------------------------------------------------------------------

const TYPES = {
  Invoice: { plural: 'Invoices', Icon: FileText },
  SalesReceipt: { plural: 'Sales receipts', Icon: Receipt },
  CreditMemo: { plural: 'Credit notes', Icon: Receipt },
  RefundReceipt: { plural: 'Refunds', Icon: Receipt },
  Estimate: { plural: 'Estimates', Icon: FileText },
  Payment: { plural: 'Customer payments', Icon: HandCoins },
  Deposit: { plural: 'Bank deposits', Icon: Landmark },
  Bill: { plural: 'Bills', Icon: FileText },
  BillPayment: { plural: 'Bill payments', Icon: Banknote },
  VendorCredit: { plural: 'Vendor credits', Icon: Receipt },
  Purchase: { plural: 'Expenses', Icon: CreditCard },
  PurchaseOrder: { plural: 'Purchase orders', Icon: Package },
  Transfer: { plural: 'Transfers', Icon: ArrowLeftRight },
  JournalEntry: { plural: 'Journal entries', Icon: BookOpen },
  TimeActivity: { plural: 'Time entries', Icon: Clock },
  Customer: { plural: 'Customers', Icon: Users },
  Vendor: { plural: 'Vendors', Icon: Users },
  Employee: { plural: 'Employees', Icon: Users },
}
const typeInfo = (t) => TYPES[t] || { plural: String(t).replace(/([a-z])([A-Z])/g, '$1 $2'), Icon: Wallet }

const STATUS = {
  done: { Icon: Check, label: 'Made', cls: 'bg-[var(--ok)] text-white border-[var(--ok)]' },
  failed: { Icon: CircleX, label: 'Failed', cls: 'bg-[var(--danger-soft)] text-[var(--danger-ink)] border-[var(--danger-soft)]' },
  running: { Icon: LoaderCircle, label: 'Making now', cls: 'text-[var(--ink-2)] border-[var(--line-strong)]', spin: true },
  waiting: { Icon: CircleDashed, label: 'Waiting for approval', cls: 'text-[var(--ink-3)] border-transparent' },
  queued: { Icon: CircleDashed, label: 'Next in line', cls: 'text-[var(--ink-3)] border-transparent' },
  pending: { Icon: CircleDashed, label: 'Not made', cls: 'text-[var(--ink-3)] border-transparent' },
  skipped: { Icon: Minus, label: 'Not made', cls: 'text-[var(--ink-3)] border-[var(--line)]' },
}

function ChangeRow({ change, step, environment }) {
  const [open, setOpen] = useState(false)
  const status = STATUS[change.status] || STATUS.pending
  const verb = change.action === 'void' ? 'Void' : change.action === 'update' ? 'Edit' : null
  const url = change.status === 'done' && change.recordId ? qboRecordUrl(change.entityType, change.recordId, environment) : null
  const muted = ['skipped', 'pending'].includes(change.status)
  const name = `${change.party || typeInfo(change.entityType).plural}${change.docNumber ? ` #${change.docNumber}` : ''}`
  return (
    <li className="group">
      <div className="grid grid-cols-[20px_minmax(0,1fr)_96px_112px_88px] items-start gap-x-3 px-4 py-2.5">
        <span className={cn('mt-0.5 grid size-5 place-items-center rounded-full border', status.cls)} title={status.label}>
          <status.Icon className={cn('size-3', status.spin && 'animate-spin')} strokeWidth={2.5} aria-hidden="true" />
          <span className="sr-only">{status.label}</span>
        </span>
        <div className="min-w-0">
          <p className={cn('truncate text-[13.5px] font-medium', muted ? 'text-[var(--ink-3)]' : 'text-[var(--ink)]')}>
            {verb && <span className="mr-1.5 rounded bg-[var(--sunken)] px-1.5 py-px text-[11px] font-semibold uppercase text-[var(--ink-2)]">{verb}</span>}
            {change.party || typeInfo(change.entityType).plural}
            {change.docNumber && <span className="ml-1.5 font-normal text-[var(--ink-3)]">#{change.docNumber}</span>}
          </p>
          {change.facts.length > 0 && <p className="mt-0.5 truncate text-[12.5px] text-[var(--ink-2)]" title={change.facts.join(' · ')}>{change.facts.join(' · ')}</p>}
          {change.error && <p className="mt-1 text-[12.5px] text-[var(--danger-ink)]">{change.error}</p>}
          {open && (
            <div className="mt-2 rounded-[8px] bg-[var(--sunken)] p-2.5 text-[12px] text-[var(--ink-2)]">
              {change.summary && <p className="mb-2 leading-relaxed">{change.summary}</p>}
              {step?.toolInput && <pre className="max-h-56 overflow-auto font-mono text-[11.5px] leading-relaxed">{JSON.stringify(step.toolInput.record || step.toolInput, null, 2)}</pre>}
            </div>
          )}
        </div>
        <div className="text-[12.5px] leading-snug text-[var(--ink-2)] tabular">
          <span className="sr-only">Date </span>{shortDate(change.date)}
          {change.dueDate && <div className="text-[var(--ink-3)]">due {shortDate(change.dueDate)}</div>}
        </div>
        <div className="text-right tabular">
          {change.amount !== null && change.amount !== undefined && <span className="sr-only">Amount </span>}
          <span className="text-[13.5px] font-medium text-[var(--ink)]">{money(change.amount)}</span>
          {change.amountNote && <div className="text-[11.5px] text-[var(--ink-3)]">{change.amountNote}</div>}
        </div>
        <div className="flex flex-col items-end gap-1 text-[12.5px]">
          {url && (
            <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} in QuickBooks`} className="inline-flex items-center gap-1 font-medium text-[var(--link)] no-underline hover:underline">
              Open <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          )}
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Details for ${name}`} className="inline-flex items-center gap-0.5 text-[var(--ink-3)] hover:text-[var(--ink-2)]">
            Details <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  )
}

// "Making change 2 of 5" with a bar, while the server works through the list.
function RunProgress({ plan }) {
  const toRun = plan.steps.filter((s) => !['rejected', 'pending', 'proposed'].includes(s.status))
  const total = toRun.length || plan.steps.length
  const finished = toRun.filter((s) => ['completed', 'failed', 'skipped'].includes(s.status)).length
  const position = Math.min(total, finished + 1)
  return (
    <div role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="flex min-w-0 items-center gap-2 font-medium text-[var(--ink)]">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-[var(--ink-3)]" aria-hidden="true" />
          Making change {position} of {total}…
        </span>
        <span className="shrink-0 tabular text-[12.5px] text-[var(--ink-3)]">{finished} done</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--sunken)]" role="progressbar" aria-label="Changes made" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished}>
        <div className="h-full rounded-full bg-[var(--ok)] transition-[width] duration-300" style={{ width: `${total ? Math.round((finished / total) * 100) : 0}%` }} />
      </div>
      <p className="mt-2 text-[12.5px] text-[var(--ink-3)]">The changes keep going on the lab server if you leave this page.</p>
    </div>
  )
}

// What the latest proposal needs from you, or what happened to it.
function PlanBand({ plan, canWrite, busy, actionError, onRun, onDiscard }) {
  if (!plan) return null
  const waiting = ['proposed', 'approved', 'partially_approved'].includes(plan.status)
  const n = plan.steps.length
  const failed = plan.steps.filter((s) => s.status === 'failed').length
  let body = null
  if (waiting) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-semibold text-[var(--ink)]">Review {n === 1 ? 'this change' : `these ${n} changes`}</p>
          <p className="text-[12.5px] text-[var(--ink-2)]">Nothing is written to QuickBooks until you approve.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onDiscard} disabled={busy}>Discard</Button>
          <Button size="lg" onClick={onRun} disabled={busy || !canWrite}>
            {busy && <LoaderCircle className="animate-spin" />}
            {busy ? 'Running…' : `Make ${n === 1 ? 'this change' : `these ${n} changes`}`}
          </Button>
        </div>
        {!canWrite && (
          <p className="w-full text-[12.5px] leading-relaxed text-[var(--ink-2)]">
            Making changes is switched off on the lab server. Set <code className="font-mono text-[12px]">LEGACY_AI_MUTATIONS_ENABLED=true</code> in the backend .env and restart the backend.
          </p>
        )}
      </div>
    )
  } else if (plan.status === 'executing') {
    body = <RunProgress plan={plan} />
  } else if (plan.status === 'failed') {
    body = (
      <p className="text-[13px] text-[var(--danger-ink)]">
        {failed || 'A'} {failed === 1 || !failed ? 'change' : 'changes'} failed, so the rest of this proposal stopped. Records already made stay in QuickBooks. Ask the assistant to fix it and continue.
      </p>
    )
  } else if (plan.status === 'completed') {
    body = <p className="text-[13px] text-[var(--ok)]">All done. Open a record to see it the way the customer does.</p>
  } else if (plan.status === 'rejected') {
    body = <p className="text-[13px] text-[var(--ink-3)]">The last proposal was discarded. Nothing was changed.</p>
  }
  if (!body && !actionError) return null
  return (
    <div className={cn('border-b border-[var(--line)] px-4 py-3.5', waiting && 'bg-[var(--attention-soft)]')}>
      {body}
      {actionError && <p className="mt-2 text-[12.5px] text-[var(--danger-ink)]">{actionError}</p>}
    </div>
  )
}

function ChangesLedger({ view, plans, plan, environment, loading, canWrite, busy, actionError, onRun, onDiscard, onReload }) {
  const steps = useMemo(() => {
    const map = new Map()
    for (const p of plans) for (const s of p.steps || []) map.set(`${p._id}:${s.stepNumber}`, s)
    return map
  }, [plans])

  const groups = useMemo(() => {
    const byType = new Map()
    for (const change of view?.changes || []) {
      if (!byType.has(change.entityType)) byType.set(change.entityType, [])
      byType.get(change.entityType).push(change)
    }
    return [...byType]
  }, [view])

  const counts = view?.counts
  return (
    <section className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)]" aria-label="Changes in QuickBooks">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h2 className="text-[14px] font-semibold text-[var(--ink)]">Changes in QuickBooks</h2>
        {counts && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {counts.done > 0 && <span className="rounded-full bg-[var(--ok-soft)] px-2 py-0.5 font-medium text-[var(--ok)]">{counts.done} made</span>}
            {counts.waiting > 0 && <span className="rounded-full bg-[var(--attention-soft)] px-2 py-0.5 font-medium text-[var(--ink)]">{counts.waiting} waiting</span>}
            {counts.failed > 0 && <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 font-medium text-[var(--danger-ink)]">{counts.failed} failed</span>}
            {counts.running > 0 && <span className="rounded-full bg-[var(--sunken)] px-2 py-0.5 text-[var(--ink-2)]">{counts.running} in progress</span>}
            {counts.notDone > 0 && <span className="rounded-full bg-[var(--sunken)] px-2 py-0.5 text-[var(--ink-2)]">{counts.notDone} not made</span>}
            {counts.retried > 0 && (
              <span className="text-[var(--ink-3)]" title="Failed the first time and was made by a later proposal">{counts.retried} retried</span>
            )}
          </div>
        )}
      </header>

      <PlanBand plan={plan} canWrite={canWrite} busy={busy} actionError={actionError} onRun={onRun} onDiscard={onDiscard} />

      {view?.error ? (
        <div className="px-4 py-6 text-[13px] text-[var(--ink-2)]" role="alert">
          The list of changes could not be loaded. <button type="button" onClick={onReload} className="font-medium text-[var(--link)] hover:underline">Try again</button>
        </div>
      ) : loading && !view ? (
        <p className="flex items-center gap-2 px-4 py-6 text-[13px] text-[var(--ink-3)]"><LoaderCircle className="size-3.5 animate-spin" /> Loading changes…</p>
      ) : groups.length === 0 ? (
        <p className="px-4 py-6 text-[13px] leading-relaxed text-[var(--ink-3)]">
          No changes proposed yet. When the assistant knows what to create, each record appears here for you to review before anything is touched.
        </p>
      ) : (
        <div className="divide-y divide-[var(--line)]">
          <div className="grid grid-cols-[20px_minmax(0,1fr)_96px_112px_88px] gap-x-3 px-4 py-1.5 text-[11.5px] font-medium uppercase tracking-[0.04em] text-[var(--ink-3)]" aria-hidden="true">
            <span /><span>Record</span><span>Date</span><span className="text-right">Amount</span><span />
          </div>
          {groups.map(([type, changes]) => {
            const { plural, Icon } = typeInfo(type)
            const total = changes.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
            const showTotal = changes.some((c) => c.amount !== null && c.amount !== undefined)
            return (
              <div key={type}>
                <div className="flex items-center justify-between gap-3 bg-[var(--surface-muted)] px-4 py-2">
                  <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--ink)]">
                    <Icon className="size-3.5 text-[var(--ink-3)]" aria-hidden="true" />
                    {plural}
                    <span className="font-normal text-[var(--ink-3)]">{changes.length}</span>
                  </h3>
                  {showTotal && <span className="text-[12.5px] font-medium text-[var(--ink-2)] tabular">{money(total)}</span>}
                </div>
                <ul className="divide-y divide-[var(--line)]">
                  {changes.map((c) => <ChangeRow key={c.key} change={c} step={steps.get(`${c.planId}:${c.stepNumber}`)} environment={environment} />)}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      {view?.discardedProposals > 0 && (
        <p className="border-t border-[var(--line)] px-4 py-2.5 text-[12px] text-[var(--ink-3)]">
          {view.discardedProposals} discarded {view.discardedProposals === 1 ? 'proposal is' : 'proposals are'} not shown.
        </p>
      )}
    </section>
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
    <section className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
        <h2 className="text-[13px] font-semibold text-[var(--ink)]">Case note</h2>
        {note && (
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-[12.5px] text-[var(--ink-2)] hover:text-[var(--ink)]">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </header>
      {note ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-4 py-3 font-sans text-[13px] leading-relaxed text-[var(--ink)]">{note}</pre>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-[13px] text-[var(--ink-2)]">A summary of what was reproduced, ready to paste into the ticket.</p>
          <Button variant="outline" onClick={write} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : <FileText />} {busy ? 'Writing…' : 'Write note'}
          </Button>
          {error && <p className="w-full text-[12.5px] text-[var(--danger-ink)]">{error}</p>}
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
  const [view, setView] = useState(null)
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
    // The readable list of changes, with names looked up in QuickBooks.
    client.get(`/ai/sessions/${id}/changes`)
      .then((res) => { if (!cancelled) setView(res.data?.data || null) })
      .catch(() => { if (!cancelled) setView((v) => (v && !v.error ? v : { error: true })) })
    return () => { cancelled = true }
  }, [id, isNew, version])

  const plans = useMemo(() => session?.plans || [], [session])
  const plan = plans[plans.length - 1] || null
  const environment = connection?.environment
  const executing = plan?.status === 'executing'

  // While changes are being made (including after a page reload), re-read the
  // case every second so each step ticks off as the server finishes it.
  useEffect(() => {
    if (!executing) return undefined
    const timer = setTimeout(() => setVersion((v) => v + 1), 1000)
    return () => clearTimeout(timer)
  }, [executing, session])

  // Someone else (a shared-company member, or another tab) may continue this
  // case. Re-read it when the window comes back into view and every 15 s while visible.
  useEffect(() => {
    if (isNew) return undefined
    const refresh = () => { if (document.visibilityState === 'visible') setVersion((v) => v + 1) }
    const timer = setInterval(refresh, 15000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [isNew])

  // The server only starts once the production check passes, so the
  // confirmation can step aside and let the progress show.
  useEffect(() => {
    if (!executing || !confirmOpen) return undefined
    const timer = setTimeout(() => setConfirmOpen(false), 0)
    return () => clearTimeout(timer)
  }, [executing, confirmOpen])

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
    let peek = null
    try {
      if (plan.status === 'proposed') await client.post(`/ai/plan/${plan._id}/approve`, {})
      const execution = client.post(`/ai/plan/${plan._id}/execute`, connection?.isProduction ? { confirmProduction: true } : {})
      // The request only answers when every change is made. Re-read the case
      // shortly after it starts; once it shows "executing", the progress
      // effect keeps it current step by step.
      peek = setTimeout(() => setVersion((v) => v + 1), 700)
      await execution
      setConfirmOpen(false)
      setVersion((v) => v + 1)
    } catch (err) {
      clearTimeout(peek)
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
  const opening = messages.find((m) => m.role === 'user')?.content || initialMessage || session?.title
  const title = caseTitle(opening) || 'New case'
  const busy = Boolean(pending)
  const hasChanges = Boolean(plan) || (view?.changes?.length || 0) > 0
  const startedAt = session?.createdAt ? new Date(session.createdAt).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null

  const conversation = (
    <Conversation
      messages={messages}
      pending={pending}
      failedText={failedText}
      chatError={chatError}
      onRetry={() => startCase(failedText)}
      loading={!session && !pending && !chatError && !isNew}
      isNew={isNew}
      reply={reply}
      setReply={setReply}
      onSend={sendReply}
      canSend={Boolean(connection?.ready)}
      busy={busy}
    />
  )

  return (
    <Layout>
      <div className="mx-auto max-w-[1280px]">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--ink-2)] no-underline hover:text-[var(--ink)]">
          <ArrowLeft className="size-3.5" aria-hidden="true" /> All cases
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="line-clamp-2 max-w-[60ch] text-[22px] font-semibold leading-snug tracking-[-0.015em] text-[var(--ink)]">{title}</h1>
            {startedAt && <p className="mt-1 text-[12.5px] text-[var(--ink-3)]">Started {startedAt}</p>}
          </div>
          <Stepper current={stageFor(plan)} />
        </div>

        {loadError ? (
          <p className="mt-8 text-[13.5px] text-[var(--ink-2)]">{loadError} <Link to="/" className="font-medium text-[var(--link)]">Back to Reproduce</Link></p>
        ) : hasChanges ? (
          // Once there is something to review, the changes lead and the conversation sits beside them.
          <div className="mt-5 grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-5">
              <ChangesLedger
                view={view}
                plans={plans}
                plan={plan}
                environment={environment}
                loading={!view}
                canWrite={canWrite}
                busy={running}
                actionError={actionError}
                onRun={() => { setGuardError(null); setConfirmOpen(true) }}
                onDiscard={discard}
                onReload={() => setVersion((v) => v + 1)}
              />
              {plan?.status === 'completed' && <CaseNote sessionId={id} />}
            </div>
            <aside className="min-w-0 xl:sticky xl:top-4">{conversation}</aside>
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0">{conversation}</div>
            <aside className="rounded-[12px] border border-dashed border-[var(--line-strong)] px-4 py-4 text-[13px] leading-relaxed text-[var(--ink-3)]">
              <p className="font-medium text-[var(--ink-2)]">Changes in QuickBooks</p>
              <p className="mt-1">
                {busy ? 'The assistant is working out what to create…' : 'When the assistant knows what to create, each record appears here for you to review before anything is touched.'}
              </p>
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
