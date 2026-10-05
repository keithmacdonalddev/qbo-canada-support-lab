import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, ChevronRight, ExternalLink, LoaderCircle, Minus, Search, X } from 'lucide-react'
import Layout from '../components/Layout'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import { Muted, PageHeader, Segmented } from '@/components/ui/page'
import { dayLabel, startOfDay, timeOfDay, dateTime, money, shortDate } from '@/lib/format'
import { RECORD_TYPES, typeLabel } from '@/lib/records'
import { qboRecordUrl } from '@/lib/qbo-links'
import { cn } from '@/lib/utils'

// History answers: "what has the lab done to the company, and did it work?"
// Every entry is written as a sentence, grouped by day, newest first, with the
// record it touched one click away.

const PAGE_SIZE = 50

const FILTERS = [
  { value: 'all', label: 'Everything', types: null },
  { value: 'changes', label: 'Changes to QuickBooks', types: ['ai_executed', 'generate_txn', 'generate', 'seed', 'seed_entity', 'issue_pack', 'issue_pack_entity', 'inject'] },
  { value: 'cases', label: 'Cases', types: ['ai_chat', 'ai_plan', 'ai_plan_approve', 'ai_plan_reject', 'ai_approve', 'ai_reject', 'ai_plan_execute', 'ai_investigate', 'ai_generate_note'] },
  { value: 'connection', label: 'Connection', types: ['connection', 'auth'] },
  { value: 'lookups', label: 'Lookups', types: ['ai_read'] },
]

// [what was done, what couldn't be done] for each assistant write.
const recordName = (p) => `${typeLabel(p?.entityType).toLowerCase()} #${p?.id ?? ''}`
const WRITE_TOOLS = {
  createInvoice: () => ['Created an invoice', 'create an invoice'],
  applyPayment: () => ['Recorded a customer payment', 'record a customer payment'],
  createBill: () => ['Created a bill', 'create a bill'],
  applyBillPayment: () => ['Paid a bill', 'pay a bill'],
  runIssuePack: (p) => [`Ran the issue pack ${p?.slug || ''}`.trim(), `run the issue pack ${p?.slug || ''}`.trim()],
  createCheckpoint: () => ['Saved a checkpoint', 'save a checkpoint'],
  createRecord: (p) => {
    const what = withArticle(typeLabel(p?.entityType).toLowerCase())
    return [`Created ${what}`, `create ${what}`]
  },
  updateRecord: (p) => [`Edited ${recordName(p)}`, `edit ${recordName(p)}`],
  voidTransaction: (p) => [`Voided ${recordName(p)}`, `void ${recordName(p)}`],
}

// Server error codes some entries store instead of a sentence.
const ERROR_CODES = {
  QBO_RECONNECT_REQUIRED: 'QuickBooks asked for a fresh sign-in.',
}

const LOOKUPS = {
  lookupCustomer: 'a customer',
  lookupInvoice: 'an invoice',
  searchEntities: null,
  getEntityDetail: 'a record',
  getTransactionChain: 'linked records',
  getChangeSummary: 'recent changes',
  getCoverage: 'coverage',
  runReport: 'a report',
}

const CONNECTION_TEXT = {
  'QBO authorization granted': 'Connected QuickBooks',
  'QBO OAuth connected': 'Connected QuickBooks',
  'QBO token refresh requested': 'Checked the saved QuickBooks sign-in',
  'QBO token refreshed': 'Renewed the QuickBooks sign-in',
  'QBO token refresh failed': 'QuickBooks rejected the saved sign-in',
  'QBO authorization rejected': 'QuickBooks rejected the saved sign-in',
  'QBO disconnected': 'Disconnected QuickBooks',
}

function withArticle(word) {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`
}

function plainAction(text) {
  return String(text || 'Activity').replace(/\bQBO\b/g, 'QuickBooks')
}

function toolFromAction(entry) {
  if (entry.tool && entry.tool !== 'ai-orchestrator') return entry.tool
  const match = /:\s*(\w+)\s*$/.exec(entry.action || '')
  return match ? match[1] : null
}

function lookupText(entry) {
  const tool = toolFromAction(entry)
  const p = entry.inputParams || {}
  // searchEntities and getEntityDetail name the record type `type`; other tools use `entityType`.
  const type = p.type ?? p.entityType
  if (tool === 'searchEntities') return type ? `${RECORD_TYPES[type]?.plural?.toLowerCase() || type}` : 'records'
  if (tool === 'runReport') return p.reportName || p.report || 'a report'
  if (tool === 'getEntityDetail' && type) return `${typeLabel(type).toLowerCase()} #${p.id ?? ''}`.trim()
  return LOOKUPS[tool] || (tool ? tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : 'records')
}

// A record the entry touched, if it says which: { type, id }.
function touchedRecord(entry) {
  const a = entry.afterState || {}
  const p = entry.inputParams || {}
  const raw = a.entity || (entry.actionType === 'ai_executed' ? p.entityType : null)
  const id = a.qboId || (entry.actionType === 'ai_executed' ? p.id : null)
  if (!raw || !id) return null
  const type = Object.keys(RECORD_TYPES).find((t) => t.toLowerCase() === String(raw).toLowerCase())
  return type ? { type, id: String(id) } : null
}

// Plain-English sentence, who/what did it, and where it leads.
function describe(entry) {
  const p = entry.inputParams || {}
  const a = entry.afterState || {}
  const failed = entry.outcome === 'failure'
  switch (entry.actionType) {
    case 'ai_executed': {
      const tool = toolFromAction(entry)
      const [done, attempt] = WRITE_TOOLS[tool]?.(p) || [plainAction(entry.action), null]
      return { title: failed && attempt ? `Couldn't ${attempt}` : done, detail: p.summary || null, by: 'Assistant, after your approval' }
    }
    case 'ai_read':
      return { title: `${failed ? "Couldn't look up" : 'Looked up'} ${lookupText(entry)}`, by: 'Assistant' }
    case 'ai_plan':
      return {
        title: p.stepCount != null ? `Proposed ${p.stepCount} ${p.stepCount === 1 ? 'change' : 'changes'} for you to review` : 'Proposed changes for you to review',
        by: 'Assistant',
      }
    case 'ai_approve':
    case 'ai_plan_approve': {
      const status = /AI plan (\w+)/.exec(entry.action || '')?.[1]
      return { title: status === 'partially_approved' ? 'Approved some of the proposed changes' : 'Approved the proposed changes' }
    }
    case 'ai_reject':
    case 'ai_plan_reject':
      return { title: 'Discarded the proposed changes' }
    case 'ai_plan_execute':
      return { title: entry.outcome === 'partial' ? 'Ran the approved changes; some steps failed' : 'Ran the approved changes' }
    case 'ai_chat':
      return { title: 'Talked to the assistant in a case', caseId: a.sessionId || null }
    case 'ai_investigate':
      return { title: 'Asked the assistant to investigate', by: 'Assistant' }
    case 'ai_generate_note':
      return { title: 'Wrote a ticket note', by: 'Assistant' }
    case 'connection':
    case 'auth':
      return { title: CONNECTION_TEXT[entry.action] || plainAction(entry.action) }
    case 'generate_txn':
      return {
        title: `Added ${typeLabel(a.entity).toLowerCase()} ${a.docNumber || `#${a.qboId ?? ''}`}`,
        detail: [a.customerOrVendor, a.amount != null && money(a.amount), a.txnDate && shortDate(a.txnDate)].filter(Boolean).join(' · ') || null,
        by: 'Activity generator',
      }
    case 'generate':
      return { title: failed ? 'Business activity stopped partway' : `Finished adding business activity${a.totalTransactions != null ? ` (${a.totalTransactions} records)` : ''}`, by: 'Activity generator' }
    case 'seed':
      return { title: entry.outcome === 'partial' ? 'Added starter records; some failed' : 'Added starter records' }
    case 'seed_entity': {
      const what = `${typeLabel(a.entity).toLowerCase()} “${a.name || ''}”`
      if (entry.outcome === 'skipped') return { title: `Skipped ${what}; it already exists` }
      return { title: failed ? `Couldn't add ${what}` : `Added ${what}` }
    }
    default:
      return { title: plainAction(entry.action) }
  }
}

const OUTCOME = {
  success: { Icon: Check, cls: 'text-[var(--ok)]', label: 'Done' },
  failure: { Icon: X, cls: 'text-[var(--danger-ink)]', label: 'Failed' },
  partial: { Icon: Minus, cls: 'text-[var(--attention)]', label: 'Partly done' },
  skipped: { Icon: Minus, cls: 'text-[var(--ink-3)]', label: 'Skipped' },
}

function OutcomeIcon({ outcome }) {
  const o = OUTCOME[outcome] || OUTCOME.success
  return (
    <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center', o.cls)} title={o.label}>
      <o.Icon className="size-4" strokeWidth={2.25} aria-hidden="true" />
      <span className="sr-only">{o.label}</span>
    </span>
  )
}

function compact(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'object') return String(value)
  const text = JSON.stringify(value, null, 1)
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

function Details({ entry }) {
  const sections = [
    ['What was sent', entry.inputParams],
    ['Before', entry.beforeState],
    ['After', entry.afterState],
  ].filter(([, v]) => v && typeof v === 'object' && Object.keys(v).length)
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-muted)] px-3 py-2.5 text-[12px]">
      <p className="text-[var(--ink-3)]">
        {dateTime(entry.createdAt)}
        {entry.tool && <> · tool <span className="font-mono">{entry.tool}</span></>}
        {entry.approvalEvent && <> · plan <span className="font-mono">{entry.approvalEvent}</span></>}
        {/* A member of the shared company acting in the owner's workspace is named as the actor. */}
        {(entry.actorUserId?.email || entry.userId?.email) && <> · {entry.actorUserId?.email || entry.userId.email}</>}
      </p>
      {sections.map(([label, value]) => (
        <div key={label}>
          <div className="mb-0.5 font-medium text-[var(--ink-2)]">{label}</div>
          <dl className="font-mono text-[11.5px] leading-relaxed">
            {Object.entries(value).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
                <dt className="truncate text-[var(--ink-3)]" title={k}>{k}</dt>
                <dd className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[var(--ink)]">{compact(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {!sections.length && !entry.error && <p className="text-[var(--ink-3)]">No further detail was recorded.</p>}
    </div>
  )
}

function EntryRow({ entry, environment, nested = false }) {
  const [open, setOpen] = useState(false)
  const info = describe(entry)
  const record = touchedRecord(entry)
  const qboUrl = record ? qboRecordUrl(record.type, record.id, environment) : null

  return (
    <li className={cn('flex gap-3 py-2.5', nested ? 'pl-0' : 'px-5')}>
      <OutcomeIcon outcome={entry.outcome} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-4">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="group flex min-w-0 items-start gap-1 text-left text-[13.5px] text-[var(--ink)]"
          >
            <span className="min-w-0">{info.title}</span>
            <ChevronRight className={cn('mt-[3px] size-3.5 shrink-0 text-[var(--ink-3)] opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100', open && 'rotate-90 opacity-100')} aria-hidden="true" />
          </button>
          <span className="shrink-0 pt-px text-[12px] tabular text-[var(--ink-3)]">{timeOfDay(entry.createdAt)}</span>
        </div>
        {info.detail && <p className="mt-0.5 text-[12.5px] text-[var(--ink-2)]">{info.detail}</p>}
        {entry.error && <p className="mt-0.5 text-[12.5px] text-[var(--danger-ink)]">{ERROR_CODES[entry.error] || plainAction(entry.error)}</p>}
        {((info.by && !nested) || record || info.caseId) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ink-3)]">
            {info.by && !nested && <span>{info.by}</span>}
            {record && (
              <Link to={`/explorer?type=${record.type}&id=${encodeURIComponent(record.id)}`} className="text-[var(--link)] no-underline hover:underline">
                View in Records
              </Link>
            )}
            {qboUrl && (
              <a href={qboUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--link)] no-underline hover:underline">
                Open in QuickBooks <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            )}
            {info.caseId && (
              <Link to={`/cases/${info.caseId}`} className="text-[var(--link)] no-underline hover:underline">Open case</Link>
            )}
          </div>
        )}
        {open && <Details entry={entry} />}
      </div>
    </li>
  )
}

// A run of assistant lookups reads as one line until opened.
function LookupRun({ entries, environment }) {
  const [open, setOpen] = useState(false)
  const failures = entries.filter((e) => e.outcome === 'failure').length
  const first = entries[entries.length - 1]
  const last = entries[0]
  return (
    <li className="flex gap-3 px-5 py-2.5">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-[var(--ink-3)]"><Search className="size-3.5" aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-4">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1 text-left text-[13.5px] text-[var(--ink-2)] hover:text-[var(--ink)]">
            {`The assistant looked up ${entries.length} things`}
            {failures > 0 && <span className="text-[var(--danger-ink)]">{`(${failures} failed)`}</span>}
            <ChevronRight className={cn('size-3.5 text-[var(--ink-3)] transition', open && 'rotate-90')} aria-hidden="true" />
          </button>
          <span className="shrink-0 pt-px text-[12px] tabular text-[var(--ink-3)]">
            {timeOfDay(first.createdAt)}{timeOfDay(first.createdAt) !== timeOfDay(last.createdAt) && `–${timeOfDay(last.createdAt)}`}
          </span>
        </div>
        {open && (
          <ul className="mt-1 border-l border-[var(--line)] pl-3">
            {entries.map((entry) => <EntryRow key={entry._id} entry={entry} environment={environment} nested />)}
          </ul>
        )}
      </div>
    </li>
  )
}

// Group entries by day; inside a day, fold runs of 3+ lookups together.
function groupEntries(entries, foldLookups) {
  const days = []
  for (const entry of entries) {
    const key = startOfDay(entry.createdAt)?.getTime() ?? 'unknown'
    let day = days[days.length - 1]
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(entry.createdAt), items: [] }
      days.push(day)
    }
    const prev = day.items[day.items.length - 1]
    if (foldLookups && entry.actionType === 'ai_read') {
      if (prev?.kind === 'lookups') { prev.entries.push(entry); continue }
      day.items.push({ kind: 'lookups', entries: [entry] })
    } else {
      day.items.push({ kind: 'entry', entry })
    }
  }
  // Short runs read better as plain rows.
  for (const day of days) {
    day.items = day.items.flatMap((item) => (item.kind === 'lookups' && item.entries.length < 3
      ? item.entries.map((entry) => ({ kind: 'entry', entry }))
      : [item]))
  }
  return days
}

export default function AuditLog() {
  const connection = useConnection()
  const ready = connection?.ready === true
  const [searchParams, setSearchParams] = useSearchParams()
  const filter = FILTERS.find((f) => f.value === searchParams.get('show')) || FILTERS[0]
  const [entries, setEntries] = useState([])
  const [total, setTotal] = useState(0)
  const [state, setState] = useState('loading')
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const requestId = useRef(0)

  const fetchPage = useCallback((offset) => {
    const params = { offset, limit: PAGE_SIZE }
    if (filter.types) params.actionType = filter.types.join(',')
    return client.get('/audit', { params })
  }, [filter])

  const load = useCallback(() => {
    const id = ++requestId.current
    setState('loading')
    setError(null)
    fetchPage(0)
      .then((res) => {
        if (id !== requestId.current) return
        setEntries(res.data.logs || [])
        setTotal(res.data.pagination?.total || 0)
        setState('done')
      })
      .catch((err) => {
        if (id !== requestId.current) return
        setError(err.response?.data?.error || "History couldn't be loaded.")
        setState('error')
      })
  }, [fetchPage])

  useEffect(() => {
    if (!ready) return undefined
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [ready, load])

  const loadMore = () => {
    const id = requestId.current
    setLoadingMore(true)
    fetchPage(entries.length)
      .then((res) => {
        if (id !== requestId.current) return
        // Offsets shift when new entries arrive; skip any already shown.
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e._id))
          return [...prev, ...(res.data.logs || []).filter((e) => !seen.has(e._id))]
        })
        setTotal(res.data.pagination?.total || 0)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }

  const days = useMemo(() => groupEntries(entries, filter.value !== 'lookups'), [entries, filter.value])
  const environment = connection?.environment

  let body
  if (!connection || connection.state === 'loading') {
    body = <Muted>Checking the QuickBooks connection…</Muted>
  } else if (!ready) {
    body = <Muted>History is kept per company, so it shows once QuickBooks is connected again.</Muted>
  } else if (state === 'loading') {
    body = <Muted className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> Loading history…</Muted>
  } else if (state === 'error') {
    body = (
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <p className="flex-1 text-[13px] text-[var(--danger-ink)]">{error}</p>
        <Button size="sm" variant="outline" onClick={load}>Try again</Button>
      </div>
    )
  } else if (!entries.length) {
    body = (
      <Muted>
        {filter.value === 'all' ? 'Nothing has been recorded for this company yet.' : `Nothing under “${filter.label}” yet.`}
        {filter.value === 'changes' && ' Changes appear here once a case runs, or business activity or starter records are added.'}
      </Muted>
    )
  } else {
    body = (
      <>
        {days.map((day) => (
          <Fragment key={day.key}>
            <h2 className="sticky top-[49px] z-10 border-b border-[var(--line)] bg-[var(--surface-muted)] px-5 py-1.5 text-[12px] font-medium text-[var(--ink-2)]">
              {day.label}
            </h2>
            <ul className="divide-y divide-[var(--line)]">
              {day.items.map((item) => (item.kind === 'lookups'
                ? <LookupRun key={item.entries[0]._id} entries={item.entries} environment={environment} />
                : <EntryRow key={item.entry._id} entry={item.entry} environment={environment} />))}
            </ul>
          </Fragment>
        ))}
        {entries.length < total && (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3">
            <span className="text-[12.5px] text-[var(--ink-3)]">Showing {entries.length} of {total}</span>
            <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore && <LoaderCircle className="animate-spin" />}
              {loadingMore ? 'Loading…' : 'Show older'}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <Layout>
      <div className="mx-auto max-w-[920px]">
        <PageHeader title="History" description="What was done in this company through the lab, newest first. Open an entry to see exactly what was sent." />
        <div className="mt-6">
          <Segmented
            label="Show"
            value={filter.value}
            onChange={(value) => setSearchParams(value === 'all' ? {} : { show: value }, { replace: true })}
            options={FILTERS.map(({ value, label }) => ({ value, label }))}
          />
        </div>
        <section className="mt-4 overflow-clip rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
          {body}
        </section>
      </div>
    </Layout>
  )
}
