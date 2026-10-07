import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ChevronRight, ExternalLink, GitBranch, LoaderCircle, Search, X,
} from 'lucide-react'
import Layout from '../components/Layout'
import RecordOrigin from '../components/RecordOrigin'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useConnection } from '../context/ConnectionContext'
import { Button, buttonVariants } from '@/components/ui/button'
import { StatusDot } from '@/components/ui/status'
import { CopyButton, Muted, PageHeader } from '@/components/ui/page'
import { money, shortDate, dateTime } from '@/lib/format'
import {
  COLUMNS, DEFAULT_TYPE, RECORD_GROUPS, RECORD_TYPES, currencyOf, linkedRecords, recordFacts, recordLines,
  recordStatus, recordTitle, typeLabel,
} from '@/lib/records'
import { qboRecordUrl } from '@/lib/qbo-links'
import { cn } from '@/lib/utils'

// Records answers: "show me that record the way QuickBooks has it, what it's
// connected to, and let me open it there." Pick a kind of record on the left,
// the newest ones load straight away, and a record opens beside the list.

function errorText(err, fallback) {
  const data = err?.response?.data
  const ref = data?.intuit_tid ? ` Intuit reference: ${data.intuit_tid}.` : ''
  return `${data?.error || fallback}${ref}`
}

function StatusPill({ status }) {
  if (!status) return null
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-[var(--ink-2)]">
      <StatusDot tone={status.tone} />
      {status.label}
    </span>
  )
}

function Cell({ column, record, type }) {
  const def = COLUMNS[column]
  if (def.kind === 'status') return <StatusPill status={recordStatus(type, record) || (column === 'active' ? { label: 'Active', tone: 'ok' } : null)} />
  const value = def.get(record)
  if (def.kind === 'money') return <span className="tabular">{money(value, currencyOf(record))}</span>
  if (def.kind === 'date') return <span className="tabular">{shortDate(value)}</span>
  return <span title={typeof value === 'string' ? value : undefined} className={cn('block truncate', def.mono && 'tabular', def.strong && 'font-medium', def.muted && 'text-[var(--ink-3)]')}>{value}</span>
}

function TypeNav({ value, onChange }) {
  return (
    <nav aria-label="Kinds of record" className="flex flex-col gap-4">
      {RECORD_GROUPS.map((group) => (
        <div key={group.label}>
          <h2 className="mb-1 px-2.5 text-[11.5px] font-medium uppercase tracking-[0.04em] text-[var(--ink-3)]">{group.label}</h2>
          <ul className="flex flex-col gap-0.5">
            {group.types.map((type) => {
              const active = type === value
              return (
                <li key={type}>
                  <button
                    type="button"
                    onClick={() => onChange(type)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'w-full rounded-md px-2.5 py-[5px] text-left text-[13px] transition-colors duration-100',
                      active
                        ? 'bg-[var(--surface)] font-medium text-[var(--ink)] shadow-[0_0_0_1px_var(--line)]'
                        : 'text-[var(--ink-2)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]',
                    )}
                  >
                    {RECORD_TYPES[type].plural}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

// Fixed widths keep columns steady; the name column takes what is left.
function columnWidth(def) {
  if (def.grow) return 140
  if (def.mono) return 76
  if (def.kind === 'status') return 116
  if (def.kind === 'date' || def.kind === 'money' || def.numeric) return 108
  return 140
}

function ResultsTable({ type, records, selectedId, onOpen, compact }) {
  // Beside an open record, drop the columns the record itself shows.
  const columns = RECORD_TYPES[type].cols.filter((col) => !(compact && COLUMNS[col].secondary))
  const minWidth = columns.reduce((sum, col) => sum + columnWidth(COLUMNS[col]), 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-[13px]" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-[var(--line)] text-left text-[12px] text-[var(--ink-3)]">
            {columns.map((col) => {
              const def = COLUMNS[col]
              const right = def.kind === 'money' || def.numeric
              return (
                <th
                  key={col}
                  scope="col"
                  className={cn('px-4 py-2 font-medium first:pl-5 last:pr-5', right && 'text-right')}
                  style={def.grow ? undefined : { width: columnWidth(def) }}
                >
                  {def.label}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const selected = String(record.Id) === String(selectedId)
            return (
              <tr
                key={record.Id}
                data-record-id={record.Id}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onOpen(record)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(record) } }}
                className={cn(
                  'cursor-pointer border-b border-[var(--line)] last:border-b-0 outline-none transition-colors duration-100 focus-visible:bg-[var(--sunken)]',
                  selected ? 'bg-[var(--link-soft)]' : 'hover:bg-[var(--surface-muted)]',
                )}
              >
                {columns.map((col) => {
                  const def = COLUMNS[col]
                  return (
                    <td key={col} className={cn('px-4 py-2.5 text-[var(--ink)] first:pl-5 last:pr-5', (def.kind === 'money' || def.numeric) && 'text-right tabular')}>
                      <Cell column={col} record={record} type={type} />
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FactValue({ fact, currency }) {
  if (fact.kind === 'money') return <span className="tabular">{money(fact.value, currency)}</span>
  if (fact.kind === 'date') return <span className="tabular">{shortDate(fact.value)}</span>
  return <span className="break-words">{String(fact.value)}</span>
}

function LinesTable({ record }) {
  const lines = recordLines(record)
  if (!lines.length) return null
  const currency = currencyOf(record)
  const journal = lines.some((l) => l.debit != null || l.credit != null)
  const hasQty = !journal && lines.some((l) => l.qty != null)
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-[0.04em] text-[var(--ink-3)]">Lines</h3>
      <div className="overflow-hidden rounded-lg border border-[var(--line)]">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-[var(--surface-muted)] text-left text-[11.5px] text-[var(--ink-3)]">
              <th scope="col" className="px-3 py-1.5 font-medium">{journal ? 'Account' : 'Item or account'}</th>
              {hasQty && <th scope="col" className="px-3 py-1.5 text-right font-medium">Qty × rate</th>}
              {journal ? (
                <>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium">Debit</th>
                  <th scope="col" className="px-3 py-1.5 text-right font-medium">Credit</th>
                </>
              ) : <th scope="col" className="px-3 py-1.5 text-right font-medium">Amount</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="border-t border-[var(--line)] align-top">
                <td className="px-3 py-2">
                  <div className="text-[var(--ink)]">{line.label}</div>
                  {line.sub && <div className="mt-0.5 text-[12px] text-[var(--ink-3)]">{line.sub}</div>}
                </td>
                {hasQty && (
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular text-[var(--ink-2)]">
                    {line.qty != null ? `${line.qty} × ${money(line.rate, currency)}` : ''}
                  </td>
                )}
                {journal ? (
                  <>
                    <td className="px-3 py-2 text-right tabular">{line.debit != null ? money(line.debit, currency) : ''}</td>
                    <td className="px-3 py-2 text-right tabular">{line.credit != null ? money(line.credit, currency) : ''}</td>
                  </>
                ) : <td className="whitespace-nowrap px-3 py-2 text-right tabular">{money(line.amount, currency)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ChainView({ chain, currentKey, onOpen }) {
  if (!chain.nodes?.length) return <p className="text-[12.5px] text-[var(--ink-3)]">Nothing else is linked.</p>
  return (
    <>
    <ol className="flex flex-col">
      {chain.nodes.map((node, i) => {
        const key = `${node.entity}:${node.id}`.toLowerCase()
        const isCurrent = key === currentKey.toLowerCase()
        const type = Object.keys(RECORD_TYPES).find((t) => t.toLowerCase() === String(node.entity).toLowerCase())
        const label = `${typeLabel(type || node.entity)} ${node.data?.DocNumber || `#${node.id}`}`
        const meta = node.error ? "Couldn't be read" : [node.data?.TxnDate && shortDate(node.data.TxnDate), node.data?.TotalAmt != null && money(node.data.TotalAmt, currencyOf(node.data))].filter(Boolean).join(' · ')
        return (
          <li key={key + i} className="relative flex gap-3 pb-3 last:pb-0">
            {i < chain.nodes.length - 1 && <span aria-hidden="true" className="absolute left-[5px] top-4 h-full w-px bg-[var(--line-strong)]" />}
            <span aria-hidden="true" className={cn('relative mt-1.5 size-[11px] shrink-0 rounded-full border-2', isCurrent ? 'border-[var(--link)] bg-[var(--link)]' : 'border-[var(--line-strong)] bg-[var(--surface)]')} />
            <div className="min-w-0 flex-1">
              {type && !isCurrent && !node.error ? (
                <button type="button" onClick={() => onOpen(type, node.id)} className="text-left text-[13px] font-medium text-[var(--link)] hover:underline">
                  {label}
                </button>
              ) : (
                <span className="text-[13px] font-medium text-[var(--ink)]">{label}{isCurrent && <span className="font-normal text-[var(--ink-3)]"> (this record)</span>}</span>
              )}
              {meta && <div className={cn('text-[12px] tabular', node.error ? 'text-[var(--danger-ink)]' : 'text-[var(--ink-3)]')}>{meta}</div>}
            </div>
          </li>
        )
      })}
    </ol>
    {chain.truncated && <p className="mt-2 text-[12px] text-[var(--ink-3)]">The chain is longer than this. Open a linked record and trace from there to see more.</p>}
    </>
  )
}

function RawFields({ record }) {
  return (
    <details className="group rounded-lg border border-[var(--line)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12.5px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)]">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        Fields returned by QuickBooks
      </summary>
      <dl className="max-h-[420px] overflow-auto border-t border-[var(--line)] px-3 py-2 font-mono text-[11.5px] leading-relaxed">
        {Object.entries(record).map(([key, val]) => (
          <div key={key} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 py-0.5">
            <dt className="truncate text-[var(--ink-3)]" title={key}>{key}</dt>
            <dd className="whitespace-pre-wrap break-all text-[var(--ink)]">
              {val !== null && typeof val === 'object' ? JSON.stringify(val, null, 1) : String(val ?? '—')}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function RecordPanel({ type, id, preview, realmId, environment, canGoBack, onBack, onClose, onOpen }) {
  const [record, setRecord] = useState(preview || null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [chain, setChain] = useState(null)
  const [chainState, setChainState] = useState('idle')
  const alive = useRef(true)

  // The panel is keyed by type and id, so each record starts with fresh state.
  useEffect(() => {
    let cancelled = false
    alive.current = true
    client.get(`/explore/${type.toLowerCase()}/${encodeURIComponent(id)}`)
      .then((res) => { if (cancelled) return; if (res.data.scope?.realmId !== realmId || res.data.scope?.environment !== environment) throw new Error('Company changed'); setRecord(res.data.record) })
      .catch((err) => { if (!cancelled) setError(errorText(err, "QuickBooks didn't return this record.")) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; alive.current = false }
  }, [type, id, realmId, environment])

  const traceChain = () => {
    setChainState('loading')
    client.get(`/explore/${type}/${encodeURIComponent(id)}/chain`)
      .then((res) => { if (!alive.current) return; if (res.data.scope?.realmId !== realmId || res.data.scope?.environment !== environment) throw new Error('Company changed'); setChain(res.data); setChainState('done') })
      .catch((err) => { if (!alive.current) return; setChain({ error: errorText(err, "The linked records couldn't be traced.") }); setChainState('error') })
  }

  const status = recordStatus(type, record)
  const links = linkedRecords(record)
  const facts = recordFacts(type, record)
  const qboUrl = qboRecordUrl(type, id, environment)
  const currency = currencyOf(record)

  return (
    <aside aria-label={`${typeLabel(type)} details`} className="flex min-h-0 flex-col rounded-[10px] border border-[var(--line)] bg-[var(--surface)] lg:sticky lg:top-[72px] lg:max-h-[calc(100vh-96px)]">
      <header className="border-b border-[var(--line)] px-5 pb-4 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          {canGoBack ? (
            <button type="button" onClick={onBack} className="-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-[var(--ink-2)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]">
              <ArrowLeft className="size-3.5" /> Back
            </button>
          ) : <span className="text-[12px] text-[var(--ink-3)]">{typeLabel(type)}</span>}
          <button type="button" onClick={onClose} aria-label="Close record" className="rounded-md p-1 text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]">
            <X className="size-4" />
          </button>
        </div>
        <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
          {loading && !record && <LoaderCircle className="size-4 animate-spin text-[var(--ink-3)]" />}
          {recordTitle(type, record)}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--ink-3)]">
          <StatusPill status={status} />
          <span className="inline-flex items-center gap-1">ID <span className="tabular text-[var(--ink-2)]">{id}</span><CopyButton value={id} label="Copy ID" /></span>
        </div>
        {qboUrl && (
          <a href={qboUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3 no-underline')}>
            Open in QuickBooks <ExternalLink />
          </a>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {error && <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] text-[var(--danger-ink)]">{error}</p>}
        {record && (
          <>
            {facts.length > 0 && (
              <dl className="divide-y divide-[var(--line)]">
                {facts.map((fact) => (
                  <div key={fact.label} className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
                    <dt className="shrink-0 text-[var(--ink-2)]">{fact.label}</dt>
                    <dd className="min-w-0 text-right text-[var(--ink)]"><FactValue fact={fact} currency={currency} /></dd>
                  </div>
                ))}
              </dl>
            )}

            <RecordOrigin key={[type, id, realmId, environment].join(':')} type={type} id={id} realmId={realmId} environment={environment} />

            <LinesTable record={record} />

            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-medium uppercase tracking-[0.04em] text-[var(--ink-3)]">Linked records</h3>
                {chainState !== 'done' && (
                  <Button size="xs" variant="ghost" onClick={traceChain} disabled={chainState === 'loading' || loading}>
                    {chainState === 'loading' ? <LoaderCircle className="animate-spin" /> : <GitBranch />}
                    {chainState === 'loading' ? 'Tracing…' : 'Trace linked records'}
                  </Button>
                )}
              </div>
              {chainState === 'done' ? (
                <ChainView chain={chain} currentKey={`${type}:${id}`} onOpen={onOpen} />
              ) : chainState === 'error' ? (
                <p className="text-[12.5px] text-[var(--danger-ink)]">{chain?.error}</p>
              ) : links.length ? (
                <ul className="flex flex-col gap-1">
                  {links.map((link) => (
                    <li key={`${link.txnType}:${link.id}`} className="flex items-center justify-between gap-3 text-[13px]">
                      {link.type ? (
                        <button type="button" onClick={() => onOpen(link.type, link.id)} className="text-left text-[var(--link)] hover:underline">
                          {typeLabel(link.type)} #{link.id}
                        </button>
                      ) : <span className="text-[var(--ink-2)]">{typeLabel(link.txnType)} #{link.id}</span>}
                      {link.amount != null && <span className="tabular text-[12.5px] text-[var(--ink-3)]">{money(link.amount, currency)}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-[var(--ink-3)]">{loading ? 'Loading…' : 'This record has no outgoing transaction links. Chain tracing follows links returned on each record.'}</p>
              )}
            </section>

            {(record.MetaData?.CreateTime || record.MetaData?.LastUpdatedTime) && (
              <p className="text-[12px] text-[var(--ink-3)]">
                Created {dateTime(record.MetaData?.CreateTime)} · Last changed {dateTime(record.MetaData?.LastUpdatedTime)}
              </p>
            )}

            <RawFields record={record} />
          </>
        )}
      </div>
    </aside>
  )
}

export default function EntityExplorer() {
  const connection = useConnection()
  const { user } = useAuth()
  return <ExplorerContent key={[connection?.status?.realmId, connection?.environment, connection?.ready, user?._id || user?.id].join(':')} connection={connection} />
}

function ExplorerContent({ connection }) {
  const realmId = connection?.status?.realmId
  const environment = connection?.environment
  const ready = connection?.ready === true
  const [searchParams, setSearchParams] = useSearchParams()
  const urlType = RECORD_TYPES[searchParams.get('type')] ? searchParams.get('type') : DEFAULT_TYPE

  const [type, setType] = useState(urlType)
  const [query, setQuery] = useState(() => searchParams.get('q') || '')
  const [offset, setOffset] = useState(() => Math.max(0, Number(searchParams.get('offset')) || 0))
  const [from, setFrom] = useState(() => searchParams.get('from') || '')
  const [through, setThrough] = useState(() => searchParams.get('through') || '')
  const [active, setActive] = useState(() => searchParams.get('active') || 'all')
  const [attempt, setAttempt] = useState(0)
  const [results, setResults] = useState({ type: null, records: [], state: 'idle', error: null })
  // Open records, newest last, so links can be followed and walked back.
  const [stack, setStack] = useState(() => {
    const id = searchParams.get('id')
    const openType = RECORD_TYPES[searchParams.get('open')] ? searchParams.get('open') : urlType
    return id ? [{ type: openType, id }] : []
  })
  const requestId = useRef(0)
  const autoOpen = useRef(!!searchParams.get('q') && !searchParams.get('id'))

  const current = stack[stack.length - 1] || null
  const config = RECORD_TYPES[type]

  // Keep the address shareable: type, search and the open record.
  useEffect(() => {
    const next = { type }
    if (query.trim()) next.q = query.trim()
    if (offset) next.offset = String(offset)
    if (!RECORD_TYPES[type].isList && from) next.from = from
    if (!RECORD_TYPES[type].isList && through) next.through = through
    if (RECORD_TYPES[type].isList && active !== 'all') next.active = active
    if (current) { next.open = current.type; next.id = current.id }
    if (current && current.type === type) delete next.open
    setSearchParams(next, { replace: true })
  }, [type, query, current, offset, from, through, active, setSearchParams])

  // Clicking Records in the menu lands on a bare /explorer: start over.
  const bareUrl = searchParams.toString() === ''
  useEffect(() => {
    if (!bareUrl) return undefined
    const timer = setTimeout(() => {
      setType(DEFAULT_TYPE)
      setQuery(''); setOffset(0); setFrom(''); setThrough(''); setActive('all')
      setStack([])
    }, 0)
    return () => clearTimeout(timer)
  }, [bareUrl])

  const filters = JSON.stringify({ type, query, offset, from: config.isList ? '' : from, through: config.isList ? '' : through, active: config.isList ? active : '' })
  const runSearch = useCallback((criteria, signal) => {
    const request = JSON.parse(criteria)
    const id = ++requestId.current
    setResults({ type: request.type, filters: criteria, records: [], state: 'loading', error: null })
    const params = { type: request.type, offset: request.offset }
    if (request.query.trim() && RECORD_TYPES[request.type].search) params.q = request.query.trim()
    if (RECORD_TYPES[request.type].isList) params.active = request.active
    else { if (request.from) params.from = request.from; if (request.through) params.through = request.through }
    client.get('/explore/search', { params, signal })
      .then((res) => {
        if (signal.aborted || id !== requestId.current) return
        if (res.data.scope?.realmId !== realmId || res.data.scope?.environment !== environment) throw new Error('Company changed')
        const records = res.data.records || []
        setResults({ ...res.data, type: request.type, filters: criteria, records, state: 'done', error: null })
        if (autoOpen.current) {
          autoOpen.current = false
          if (records.length === 1 && !res.data.hasMore && request.offset === 0) setStack([{ type: request.type, id: String(records[0].Id), preview: records[0] }])
        }
      })
      .catch((err) => {
        if (signal.aborted || id !== requestId.current) return
        setResults({ type: request.type, filters: criteria, records: [], state: 'error', error: errorText(err, 'The search failed.') })
      })
  }, [realmId, environment])

  useEffect(() => {
    if (!ready) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => runSearch(filters, controller.signal), query ? 350 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [ready, filters, query, runSearch, attempt])

  const chooseType = (next) => {
    if (next === type) return
    setType(next); setQuery(''); setOffset(0)
  }

  const openFromList = (record) => setStack([{ type, id: String(record.Id), preview: record }])
  const followLink = (linkType, id) => setStack((prev) => [...prev, { type: linkType, id: String(id) }])

  const showing = results.type === type && results.filters === filters
  const records = showing ? results.records : []

  let body
  if (!connection || connection.state === 'loading') {
    body = <Muted>Checking the QuickBooks connection…</Muted>
  } else if (!ready) {
    body = <Muted>Records are read live from QuickBooks, so they show once the connection is fixed.</Muted>
  } else if (!showing || (results.state === 'loading' && !records.length)) {
    body = <Muted className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" /> Loading {config.plural.toLowerCase()}…</Muted>
  } else if (results.state === 'error') {
    body = (
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <p className="flex-1 text-[13px] text-[var(--danger-ink)]">{results.error}</p>
        <Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
      </div>
    )
  } else if (!records.length) {
    body = <Muted>{query.trim() ? `No ${config.plural.toLowerCase()} match “${query.trim()}”.` : 'No records on this page match the selected filters.'}</Muted>
  } else {
    body = <ResultsTable type={type} records={records} selectedId={current?.type === type ? current.id : null} onOpen={openFromList} compact={!!current} />
  }

  const noun = records.length === 1 ? config.one.toLowerCase() : config.plural.toLowerCase()
  const order = config.isList ? 'A to Z' : 'newest first'
  const countText = !showing || !records.length || results.state === 'error' ? ''
    : 'Showing ' + (offset + 1) + '–' + (offset + records.length) + ' ' + noun + ', ' + order


  return (
    <Layout>
      <PageHeader
        title="Records"
        description="Read anything in the company the way QuickBooks stores it, follow what it's linked to, and open it in QuickBooks."
      />

      <div className={cn('mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[180px_minmax(0,1fr)]', current && 'xl:grid-cols-[minmax(0,1fr)_420px] 2xl:grid-cols-[180px_minmax(0,1fr)_420px]')}>
        <div className={cn('hidden', current ? '2xl:block' : 'lg:block')}><TypeNav value={type} onChange={chooseType} /></div>

        <section className="min-w-0 self-start rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
          <header className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-3">
            <label className="sr-only" htmlFor="record-type">Kind of record</label>
            <select
              id="record-type"
              value={type}
              onChange={(e) => chooseType(e.target.value)}
              className={cn('h-8 rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] px-2 text-[13px]', current ? '2xl:hidden' : 'lg:hidden')}
            >
              {RECORD_GROUPS.flatMap((g) => g.types).map((t) => <option key={t} value={t}>{RECORD_TYPES[t].plural}</option>)}
            </select>
            <h2 className={cn('hidden text-[15px] font-semibold text-[var(--ink)]', current ? '2xl:block' : 'lg:block')}>{config.plural}</h2>
            {config.search ? (
              <div className="relative ml-auto w-full max-w-[320px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--ink-3)]" aria-hidden="true" />
                <label className="sr-only" htmlFor="record-search">Search {config.plural.toLowerCase()}</label>
                <input
                  id="record-search"
                  type="search"
                  value={query}
                  maxLength={120}
                  onChange={(e) => { setQuery(e.target.value); setOffset(0) }}
                  placeholder={`${config.search}…`}
                  className="h-8 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] pl-8 pr-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-3)]"
                />
              </div>
            ) : <span className="ml-auto text-[12.5px] text-[var(--ink-3)]">QuickBooks can't search these by number.</span>}
          </header>
          <div className="flex flex-wrap items-end gap-3 border-b border-[var(--line)] px-5 py-3 text-[12px]">
            {config.isList ? <label className="grid gap-1">Status<select aria-label="Record status" value={active} onChange={event => { setActive(event.target.value); setOffset(0) }} className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1"><option value="all">Active and inactive</option><option value="active">Active only</option><option value="inactive">Inactive only</option></select></label> : <>
              <label className="grid gap-1">From<input type="date" aria-label="Records from date" value={from} onChange={event => { setFrom(event.target.value); setOffset(0) }} className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1" /></label>
              <label className="grid gap-1">Through<input type="date" aria-label="Records through date" value={through} onChange={event => { setThrough(event.target.value); setOffset(0) }} className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1" /></label>
            </>}
            <Button size="sm" variant="ghost" onClick={() => { setOffset(0); setAttempt(value => value + 1) }}>Refresh from first page</Button>
          </div>
          {countText && (
            <p className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-1.5 text-[12px] text-[var(--ink-3)]">
              {countText}
              {results.state === 'loading' && <LoaderCircle className="size-3 animate-spin" aria-label="Refreshing" />}
            </p>
          )}
          {body}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3">
            <p className="text-[12px] text-[var(--ink-3)]">Live results can move between pages when QuickBooks records change.</p>
            <div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0 || results.state === 'loading'} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</Button><Button size="sm" variant="outline" disabled={!showing || results.state !== 'done' || !results.hasMore} onClick={() => setOffset(results.nextOffset)}>Next</Button></div>
          </div>
        </section>

        {ready && current && (
          <div className="min-w-0 lg:col-span-2 xl:col-span-1">
            <RecordPanel
              key={`${current.type}:${current.id}`}
              type={current.type}
              id={current.id}
              preview={current.preview}
              realmId={realmId}
              environment={environment}
              canGoBack={stack.length > 1}
              onBack={() => setStack((prev) => prev.slice(0, -1))}
              onClose={() => setStack([])}
              onOpen={followLink}
            />
          </div>
        )}
      </div>
    </Layout>
  )
}
