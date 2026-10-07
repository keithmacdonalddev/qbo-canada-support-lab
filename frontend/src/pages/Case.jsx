import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowLeftRight, ArrowUp, Banknote, BookOpen, Check, ChevronDown, CircleDashed, CircleX, Clock, Copy,
  CreditCard, ExternalLink, FileText, HandCoins, Landmark, LoaderCircle, Minus, Package, Receipt, Users, Wallet,
} from 'lucide-react'
import Layout from '../components/Layout'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import { qboRecordUrl } from '@/lib/qbo-links'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/ui/markdown'
import ScreenVerification from '@/components/reproduction/ScreenVerification'
import CaseTiming from '@/components/reproduction/CaseTiming'

// A case runs from description through execution, observation and evidence.
const STAGES = ['Describe', 'Recreate', 'Check results', 'Result']

// A short heading from a case's opening message: its first sentence (unless that is
// a fragment like "Hi." or "1."), cut at a word.
function caseTitle(text) {
  const line = String(text || '').replace(/[*#]/g, '').split('\n').find((l) => l.trim())?.trim() || ''
  const first = line.match(/^.+?[.!?](?=\s|$)/)?.[0]
  const sentence = first && first.length >= 15 ? first : line
  if (sentence.length <= 90) return sentence
  return `${sentence.slice(0, 91).replace(/\s+\S*$/, '')}…`
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
const SINGULAR = {
  SalesReceipt: 'Sales receipt', CreditMemo: 'Credit note', RefundReceipt: 'Refund', Payment: 'Customer payment',
  Deposit: 'Bank deposit', BillPayment: 'Bill payment', VendorCredit: 'Vendor credit', Purchase: 'Expense',
  PurchaseOrder: 'Purchase order', JournalEntry: 'Journal entry', TimeActivity: 'Time entry',
}
const typeInfo = (t) => {
  const words = String(t).replace(/([a-z])([A-Z])/g, '$1 $2')
  return { plural: words, Icon: Wallet, ...TYPES[t], singular: SINGULAR[t] || words }
}

const STATUS = {
  done: { Icon: Check, label: 'Made', cls: 'bg-[var(--ok)] text-white border-[var(--ok)]' },
  failed: { Icon: CircleX, label: 'Failed', cls: 'bg-[var(--danger-soft)] text-[var(--danger-ink)] border-[var(--danger-soft)]' },
  running: { Icon: LoaderCircle, label: 'Making now', cls: 'text-[var(--ink-2)] border-[var(--line-strong)]', spin: true },
  waiting: { Icon: CircleDashed, label: 'Not run', cls: 'text-[var(--ink-3)] border-transparent' },
  queued: { Icon: CircleDashed, label: 'Next in line', cls: 'text-[var(--ink-3)] border-transparent' },
  pending: { Icon: CircleDashed, label: 'Not made', cls: 'text-[var(--ink-3)] border-transparent' },
  skipped: { Icon: Minus, label: 'Not made', cls: 'text-[var(--ink-3)] border-[var(--line)]' },
  approval: { Icon: CircleDashed, label: 'Needs your approval', cls: 'text-[var(--ink)] border-[var(--line-strong)]' },
  declined: { Icon: Minus, label: 'Declined', cls: 'text-[var(--ink-3)] border-[var(--line)]' },
}

const VERB = { delete: 'Delete', void: 'Void', update: 'Edit' }

// Changes the agent asked to make to records that existed before the case. They
// run only when the company owner approves them here, and only if the record is
// unchanged since it was proposed.
export function ApprovalRequests({ changes, active, onDecide, deciding, error }) {
  if (!changes.length) return null
  return (
    <section className="rounded-[12px] border border-[var(--line-strong)] bg-[var(--attention-soft)]" aria-label="Changes waiting for your approval">
      <header className="border-b border-[var(--line)] px-4 py-3">
        <h2 className="text-[14px] font-semibold text-[var(--ink)]">Needs your approval</h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          {changes.length === 1 ? 'The agent asked to change a record' : 'The agent asked to change records'} that existed before this case. Nothing happens until you approve.
        </p>
      </header>
      <ul className="divide-y divide-[var(--line)]">
        {changes.map((c) => {
          const name = `${typeInfo(c.entityType).singular}${c.docNumber ? ` ${c.docNumber}` : ''}`
          const busy = deciding === c.key
          return (
            <li key={c.key} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-[var(--ink)]">
                  <span className="mr-1.5 rounded bg-[var(--surface)] px-1.5 py-px text-[11px] font-semibold uppercase text-[var(--ink-2)]">{VERB[c.action] || c.action}</span>
                  {name}{c.party && <span className="font-normal text-[var(--ink-2)]"> · {c.party}</span>}
                </p>
                <p className="mt-0.5 text-[12.5px] text-[var(--ink-2)] tabular">
                  {[c.date && `Dated ${shortDate(c.date)}`, c.amount !== null && c.amount !== undefined && money(c.amount),
                    c.approval?.record?.balance !== null && c.approval?.record?.balance !== undefined && `${money(c.approval.record.balance)} owing`,
                    c.approval?.record?.createdAt && `entered ${new Date(c.approval.record.createdAt).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`]
                    .filter(Boolean).join(' · ')}
                </p>
                {c.summary && <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{c.summary}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" onClick={() => onDecide(c, 'decline')} disabled={active || Boolean(deciding)} aria-label={`Decline: ${VERB[c.action] || c.action} ${name}`}>Decline</Button>
                <Button onClick={() => onDecide(c, 'approve')} disabled={active || Boolean(deciding)} aria-label={`Approve: ${VERB[c.action] || c.action} ${name}`}>
                  {busy && <LoaderCircle className="animate-spin" />}
                  {busy ? 'Working…' : `Approve ${(VERB[c.action] || c.action).toLowerCase()}`}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
      {active && <p className="border-t border-[var(--line)] px-4 py-2.5 text-[12.5px] text-[var(--ink-2)]">You can decide once the case run finishes.</p>}
      {error && <p role="alert" className="border-t border-[var(--line)] px-4 py-2.5 text-[12.5px] text-[var(--danger-ink)]">{error}</p>}
    </section>
  )
}

function ChangeRow({ change, step, environment, showType = false, nested = false }) {
  const [open, setOpen] = useState(false)
  const status = STATUS[change.status] || STATUS.pending
  const verb = VERB[change.action] || null
  const url = change.status === 'done' && change.recordId && change.action !== 'delete' ? qboRecordUrl(change.entityType, change.recordId, environment) : null
  const muted = ['skipped', 'pending'].includes(change.status)
  const name = `${change.party || typeInfo(change.entityType).plural}${change.docNumber ? ` #${change.docNumber}` : ''}`
  return (
    <li className="group">
      <div className={cn('grid grid-cols-[20px_minmax(0,1fr)_96px_112px_88px] items-start gap-x-3 py-2.5 pr-4', nested ? 'pl-12' : 'pl-4')}>
        <span className={cn('mt-0.5 grid size-5 place-items-center rounded-full border', status.cls)} title={status.label}>
          <status.Icon className={cn('size-3', status.spin && 'animate-spin')} strokeWidth={2.5} aria-hidden="true" />
          <span className="sr-only">{status.label}</span>
        </span>
        <div className="min-w-0">
          <p className={cn('truncate text-[13.5px] font-medium', muted ? 'text-[var(--ink-3)]' : 'text-[var(--ink)]')}>
            {verb && <span className="mr-1.5 rounded bg-[var(--sunken)] px-1.5 py-px text-[11px] font-semibold uppercase text-[var(--ink-2)]">{verb}</span>}
            {showType && <span className="font-normal text-[var(--ink-3)]">{typeInfo(change.entityType).singular} · </span>}
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

// Where one ask stands, from the records that answer it.
export function ChangesLedger({ view, plans, environment, loading, onReload }) {
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
        <h2 className="text-[14px] font-semibold text-[var(--ink)]">
          Changes in QuickBooks
        </h2>
        {counts && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {counts.done > 0 && <span className="rounded-full bg-[var(--ok-soft)] px-2 py-0.5 font-medium text-[var(--ok)]">{counts.done} changes saved</span>}
            {counts.waiting > 0 && <span className="rounded-full bg-[var(--attention-soft)] px-2 py-0.5 font-medium text-[var(--ink)]">{counts.waiting} proposed earlier</span>}
            {counts.failed > 0 && <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 font-medium text-[var(--danger-ink)]">{counts.failed} failed</span>}
            {counts.running > 0 && <span className="rounded-full bg-[var(--sunken)] px-2 py-0.5 text-[var(--ink-2)]">{counts.running} in progress</span>}
            {counts.notDone > 0 && <span className="rounded-full bg-[var(--sunken)] px-2 py-0.5 text-[var(--ink-2)]">{counts.notDone} not made</span>}
            {counts.retried > 0 && (
              <span className="text-[var(--ink-3)]" title="Failed the first time and was made by a later proposal">{counts.retried} retried</span>
            )}
          </div>
        )}
      </header>



      {view?.error ? (
        <div className="px-4 py-6 text-[13px] text-[var(--ink-2)]" role="alert">
          The list of changes could not be loaded. <button type="button" onClick={onReload} className="font-medium text-[var(--link)] hover:underline">Try again</button>
        </div>
      ) : loading && !view ? (
        <p className="flex items-center gap-2 px-4 py-6 text-[13px] text-[var(--ink-3)]"><LoaderCircle className="size-3.5 animate-spin" /> Loading changes…</p>
      ) : groups.length === 0 ? (
        <p className="px-4 py-6 text-[13px] leading-relaxed text-[var(--ink-3)]">
          Records appear here as the agent creates and changes them.
        </p>
      ) : (
        <div className="divide-y divide-[var(--line)]">
          <div className="grid grid-cols-[20px_minmax(0,1fr)_96px_112px_88px] gap-x-3 px-4 py-1.5 text-[11.5px] font-medium uppercase tracking-[0.04em] text-[var(--ink-3)]" aria-hidden="true">
            <span /><span>Record</span><span>Date</span><span className="text-right">Amount</span><span />
          </div>
          {groups.map(([type, changes]) => {
            const { plural, Icon } = typeInfo(type)
            return (
              <div key={type}>
                <div className="flex items-center justify-between gap-3 bg-[var(--surface-muted)] px-4 py-2">
                  <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--ink)]">
                    <Icon className="size-3.5 text-[var(--ink-3)]" aria-hidden="true" />
                    {plural}
                    <span className="font-normal text-[var(--ink-3)]">{changes.length} {changes.length === 1 ? 'action' : 'actions'}</span>
                  </h3>

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

export function ReproductionStatus({ run, onStop, stopping, onContinue, busy, error }) {
  const active = run?.status === 'running';
  const labels = { reproduced: 'Issue reproduced', not_reproduced: 'Not reproduced in these tests', unverified: 'Result not fully verified' };
  return (
    <section className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4" aria-label="Reproduction progress">
      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--ink)]" role="status">
          {active && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
          {active ? (run.phase === 'continuing' ? 'Continuing from saved progress' : run.phase === 'checking' || run.verificationOnly ? 'Checking the result' : run.phase === 'preparing' ? 'Preparing the scenario' : 'Recreating the scenario')
            : labels[run?.outcome] || 'Ready to continue this case'}
        </h2>
        {active && <Button variant="outline" size="sm" onClick={onStop} disabled={stopping || run.stopRequested}>{run.stopRequested ? 'Stopping…' : 'Stop'}</Button>}
      </div>
      {active ? (
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-2)]">
          {run.stopRequested ? 'Finishing any change already sent, then stopping.' : run.phase === 'continuing' ? 'The model reached its time limit. The agent is continuing automatically using saved records and results.' : run.verificationOnly ? 'The agent is checking the saved results and recording any unfinished tests.' : 'The agent is creating the test records, making the relevant changes and checking what QuickBooks saved. You can leave this page; the case keeps running.'}
        </p>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-2)]">{run?.summary || 'Continue the original request automatically. The agent will create its own test records and check the results.'}</p>
          {(!run || run.status === 'interrupted' || (run.outcome === 'unverified' && !run.outcomeUnknown && !active)) && <Button className="mt-3" onClick={onContinue} disabled={busy}>{busy ? 'Starting…' : 'Continue reproduction'}</Button>}
        </>
      )}
      {active && run?.progress?.currentStep && (
        <div className="mt-3 text-[13px] text-[var(--ink-2)]">
          <p><span className="font-semibold">Agent’s saved plan: </span>{run.progress.currentStep}</p>
          {run.progress.remainingSteps?.length > 0 && <p className="mt-1">Remaining: {run.progress.remainingSteps.join(' · ')}</p>}
        </div>
      )}
      {run?.conditions?.length > 0 && (
        <div className="mt-4 border-t border-[var(--line)] pt-3">
          <h3 className="text-[12px] font-semibold text-[var(--ink-2)]">What the agent is checking</h3>
          <ul className="mt-2 space-y-2 text-[13px]">
            {run.conditions.map((label) => {
              const result = run.conditionResults?.find((entry) => entry.label === label);
              return <li key={label} className="flex items-start gap-2">
                {result?.available ? (result.passed ? <Check className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" /> : <Minus className="mt-0.5 size-4 shrink-0 text-[var(--ink-3)]" />) : <CircleDashed className="mt-0.5 size-4 shrink-0 text-[var(--ink-3)]" />}
                <span>{label}{result?.checks.map((check, index) => {
                  const fields = [...new Set((check.sources || []).map((source) => source.path?.split('.').at(-1)))];
                  const names = { Qty: 'Quantity', TxnLineId: 'Linked transaction line', TxnId: 'Linked transaction', TotalAmt: 'Total amount', Received: 'Received quantity', billedQuantity: 'Screen billed quantity', receivedQuantity: 'Screen received quantity' };
                  const measurement = fields.map((field) => names[field] || field).filter(Boolean).join(', ') || 'Check';
                  return <span key={index} className="block text-[12px] text-[var(--ink-3)]">
                    {measurement}: {!check.current ? 'Needs checking after the latest change' : check.available
                      ? `Observed: ${String(check.actual)} · Expected: ${String(check.expected)}${check.passed ? ' · Matched' : ' · Did not match'}`
                      : (check.reason || 'Not available')}
                  </span>;
                })}</span>
              </li>;
            })}
          </ul>
        </div>
      )}
      {run?.tests?.length > 0 && <details className="mt-3 text-[13px]"><summary className="cursor-pointer font-medium">Tests performed</summary><ul className="mt-2 list-disc space-y-1 pl-5">{run.tests.map((test, i) => <li key={i}>{test}</li>)}</ul></details>}
      {run?.limitations?.length > 0 && <div className="mt-3 text-[13px] text-[var(--ink-2)]"><p className="font-medium">What remains unverified</p><ul className="mt-1 list-disc space-y-1 pl-5">{run.limitations.map((limit, i) => <li key={i}>{limit}</li>)}</ul></div>}
      {error && <p role="alert" className="mt-3 text-[13px] text-[var(--danger-ink)]">{error}</p>}
    </section>
  );
}

export default function Case() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const connection = useConnection();
  const isNew = id === 'new';
  const initialMessage = isNew ? location.state?.message : null;
  const [session, setSession] = useState(null);
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pending, setPending] = useState(null);
  const [chatError, setChatError] = useState(null);
  const [failedText, setFailedText] = useState(null);
  const [reply, setReply] = useState('');
  const [version, setVersion] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [deciding, setDeciding] = useState(null);
  const [decisionError, setDecisionError] = useState(null);
  const started = useRef(false);
  const submission = useRef({ text: initialMessage, requestId: location.state?.requestId || crypto.randomUUID() });

  const startCase = async (text, existingId) => {
    if (submission.current.text !== text) submission.current = { text, requestId: crypto.randomUUID() };
    setChatError(null);
    setFailedText(null);
    setPending({ text, since: Date.now() });
    try {
      const res = await client.post('/ai/reproduce', {
        message: text, sessionId: existingId, requestId: submission.current.requestId,
        realmId: connection?.status?.realmId, environment: connection?.environment,
      });
      const next = res.data?.data?.session;
      if (next?._id) {
        setSession(next);
        if (isNew) navigate('/cases/' + next._id, { replace: true });
        else setVersion((v) => v + 1);
      }
      // Keep the id for network retries; a successful new instruction gets a new id.
      submission.current = { text: null, requestId: null };
    } catch (err) {
      setFailedText(text);
      setChatError(err.response?.data?.error || 'The case could not start. Retrying this request will not duplicate its records.');
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    if (!isNew || started.current || !connection?.ready) return;
    started.current = true;
    if (!initialMessage) { navigate('/', { replace: true }); return; }
    startCase(initialMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, initialMessage, connection?.ready]);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    client.get('/ai/sessions/' + id)
      .then((res) => { if (!cancelled) { setSession(res.data?.data?.session || null); setLoadError(null); } })
      .catch((err) => { if (!cancelled) setLoadError(err.response?.data?.error || 'The case could not be loaded.'); });
    client.get('/ai/sessions/' + id + '/changes')
      .then((res) => { if (!cancelled) setView(res.data?.data || null); })
      .catch(() => { if (!cancelled) setView((v) => v && !v.error ? v : { error: true }); });
    return () => { cancelled = true; };
  }, [id, isNew, version]);

  const run = session?.reproduction;
  const active = run?.status === 'running';
  useEffect(() => {
    if (isNew) return;
    const refresh = () => { if (document.visibilityState === 'visible') setVersion((v) => v + 1); };
    const timer = setInterval(refresh, active ? 1500 : 15000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [isNew, active]);

  const sendReply = (event) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text || pending || active) return;
    setReply('');
    startCase(text, id);
  };
  const stop = async () => {
    setStopping(true);
    setChatError(null);
    try { await client.post('/ai/sessions/' + id + '/stop'); setVersion((v) => v + 1); }
    catch (err) { setChatError(err.response?.data?.error || 'The stop request could not be sent.'); }
    finally { setStopping(false); }
  };

  const decide = async (change, decision) => {
    setDeciding(change.key);
    setDecisionError(null);
    try {
      const res = await client.post('/ai/sessions/' + id + '/approvals', { planId: change.planId, stepNumber: change.stepNumber, decision });
      const outcome = res.data?.data;
      if (outcome?.error) setDecisionError(outcome.error);
    } catch (err) {
      setDecisionError(err.response?.data?.error || 'The decision could not be sent. Nothing was changed.');
    } finally {
      setDeciding(null);
      setVersion((v) => v + 1);
    }
  };

  const plans = useMemo(() => session?.plans || [], [session]);
  const waitingForOwner = (view?.changes || []).filter((c) => c.status === 'approval');
  const messages = (session?.messages || []).filter((m) => ['user', 'assistant'].includes(m.role) && m.content?.trim());
  const opening = messages.find((m) => m.role === 'user')?.content || initialMessage || session?.title;
  const title = run?.title || caseTitle(opening) || 'New case';
  const stage = !run ? 0 : active ? (run.phase === 'checking' ? 2 : 1) : 3;
  const busy = Boolean(pending) || active;

  return (
    <Layout>
      <div className="mx-auto max-w-[1280px]">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--ink-2)] no-underline hover:text-[var(--ink)]"><ArrowLeft className="size-3.5" /> All cases</Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <h1 className="line-clamp-2 max-w-[60ch] text-[22px] font-semibold leading-snug text-[var(--ink)]">{title}</h1>
          {(session || isNew) && <Stepper current={stage} />}
        </div>
        <CaseTiming timing={session?.timing} />
        {loadError ? <p className="mt-8 text-[13px]" role="alert">{loadError} <button onClick={() => setVersion((v) => v + 1)} className="text-[var(--link)]">Try again</button></p> : (
          <div className="mt-5 grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
            <div className="flex min-w-0 flex-col gap-5">
              {!isNew && !session && <p role="status" className="text-[13px] text-[var(--ink-2)]">Loading case…</p>}
              {!isNew && session && <ReproductionStatus run={run} onStop={stop} stopping={stopping} busy={busy}
                error={chatError}
                onContinue={() => startCase('Complete the original reproduction request automatically, including supported experiments and verification. Reuse the saved records from this case and resume unfinished tests. Do not stop for repeated approvals or manual setup. Supersede the earlier proposal.', id)} />}
              {!isNew && run && <ScreenVerification sessionId={id} run={run} />}
              <ApprovalRequests changes={waitingForOwner} active={active} onDecide={decide} deciding={deciding} error={decisionError} />
              <ChangesLedger view={view} plans={plans} environment={run?.environment || connection?.environment}
                loading={!view && !isNew} onReload={() => setVersion((v) => v + 1)} />
              {run && !active && <CaseNote sessionId={id} />}
            </div>
            <aside className="min-w-0 xl:sticky xl:top-4">
              <Conversation messages={messages} pending={pending} failedText={failedText}
                chatError={chatError} onRetry={() => startCase(failedText, isNew ? undefined : id)}
                loading={!session && !pending && !chatError && !isNew} isNew={isNew}
                reply={reply} setReply={setReply} onSend={sendReply} canSend={Boolean(connection?.ready) && !active} busy={busy} />
            </aside>
          </div>
        )}
      </div>
    </Layout>
  );
}
