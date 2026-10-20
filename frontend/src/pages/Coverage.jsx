import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowUpRight, Check, Clock3, HelpCircle, LoaderCircle, RefreshCw, Search, WandSparkles, X } from 'lucide-react'
import Layout from '../components/Layout'
import CoverageTargets from '../components/CoverageTargets'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CoverageUnavailable, DOMAIN_LABEL, fillRequest, measuredAreas, relativeTime, shortDate, signalDetail, useCoverage } from '@/components/coverage'
import { featureGroup, featureName, featureRecordType, featureState, filterFeatureAreas } from '@/lib/coverage-features.mjs'
import { RECORD_TYPES } from '@/lib/records'
import { cn } from '@/lib/utils'

const VIEWS = [['all', 'All features'], ['available', 'Has data'], ['missing', 'Missing data'], ['verification', 'Needs verification']]
const STATE_LABEL = { available: 'Has company data', limited: 'Limited company data', missing: 'No data found', incomplete: 'More setup data needed', manual: 'Verify in QuickBooks', unverified: 'Could not verify', blocked: 'Setup needed' }

function FeatureButton({ signal, selected, onSelect }) {
  const state = featureState(signal)
  const available = featureGroup(signal) === 'available'
  const Icon = signal.status === 'stale' ? Clock3 : available ? Check : state === 'missing' ? X : HelpCircle
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      aria-label={`${featureName(signal)}: ${STATE_LABEL[state]}${signal.status === 'stale' ? ', older records' : ''}`}
      className={cn('inline-flex max-w-full items-start gap-1.5 rounded-md border px-2 py-1.5 text-left text-[12px] leading-snug transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--link)]', selected ? 'border-[var(--link)] bg-[var(--sunken)]' : 'border-[var(--line)] hover:border-[var(--line-strong)]')}>
      <Icon className={cn('mt-0.5 size-3 shrink-0', available ? 'text-[var(--ok)]' : state === 'missing' ? 'text-[var(--attention)]' : 'text-[var(--ink-3)]')} aria-hidden="true" />
      <span>{featureName(signal)}{signal.status === 'stale' && <span className="ml-1 text-[var(--ink-3)]">· older data</span>}{state === 'limited' && <span className="ml-1 text-[var(--ink-3)]">· limited</span>}{state === 'blocked' && <span className="ml-1 text-[var(--ink-3)]">· setup needed</span>}</span>
    </button>
  )
}

function FeatureDetail({ area, signal, canAsk, onClose }) {
  const navigate = useNavigate()
  const heading = useRef(null)
  const state = featureState(signal)
  const type = featureRecordType(signal)
  const recordType = type && RECORD_TYPES[type]
  const canCreateExample = state === 'missing' && signal.fill === 'assistant'
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [area.key, signal.key])
  return (
    <section className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)]" aria-label="Selected feature details">
      <header className="border-b border-[var(--line)] p-5">
        <div className="flex items-start justify-between gap-3"><div><p className="text-[11px] text-[var(--ink-3)]">{area.name}</p><h2 ref={heading} tabIndex={-1} className="mt-1 text-[17px] font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-[var(--link)]">{featureName(signal)}</h2></div><Button variant="ghost" size="icon-sm" aria-label="Close feature details" onClick={onClose}><X /></Button></div>
        <p className={cn('mt-3 text-[13px] font-medium', featureGroup(signal) === 'available' ? 'text-[var(--ok)]' : state === 'missing' ? 'text-[var(--attention)]' : 'text-[var(--ink-2)]')}>{STATE_LABEL[state]}</p>
      </header>
      <div className="space-y-3 border-b border-[var(--line)] p-5 text-[13px] text-[var(--ink-2)]">
        <h3 className="font-medium text-[var(--ink)]">What is in the company</h3><p>{signalDetail(signal)}</p>
        {signal.status === 'stale' && <p>This feature has data. The records are older than the recent-activity window; they still represent the feature.</p>}
        {state === 'limited' && <p>The feature has data, but the configured volume target has not been met.</p>}
        {state === 'incomplete' && <p>Some setup data exists, but it does not yet demonstrate the named feature.</p>}
        {signal.blockedBy && <p>{signal.blockedBy}</p>}
        {signal.truncated && <p className="text-[var(--attention)]">Only part of the record list was read. Counts may be incomplete.</p>}
        {recordType && <Link to={`/explorer?type=${type}`} className="inline-flex items-center gap-1.5 font-medium text-[var(--link)] hover:underline">Browse {recordType.plural.toLowerCase()} <ArrowUpRight className="size-3.5" /></Link>}
      </div>
      {canCreateExample && <div className="border-b border-[var(--line)] p-5"><Button disabled={!canAsk} onClick={() => navigate('/cases/new', { state: { message: fillRequest(area, [signal]) } })}><WandSparkles /> Start a separate test case</Button><p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-3)]">Starting a case authorizes the assistant to create and change its own QuickBooks test records in the connected company. This does not advance the managed business calendar.</p></div>}
      <div className="p-5"><h3 className="text-[13px] font-medium">Related reports</h3><p className="mt-1 text-[12px] text-[var(--ink-3)]">Feature data does not establish report coverage or reconciliation.</p>{!!area.linkedReports?.length && <ul className="mt-3 flex flex-wrap gap-1.5">{area.linkedReports.map(name => <li key={name} className="rounded bg-[var(--sunken)] px-2 py-1 text-[12px] text-[var(--ink-2)]">{name}</li>)}</ul>}<Link to="/reports" className="mt-3 inline-block text-[12px] font-medium text-[var(--link)] hover:underline">Open reports →</Link></div>
    </section>
  )
}

export default function Coverage() {
  const connection = useConnection()
  const ready = connection?.ready === true
  const { result, state, error, check } = useCoverage(ready)
  const areas = useMemo(() => measuredAreas(result), [result])
  const [aiReady, setAiReady] = useState(false)
  const [params] = useSearchParams()
  const [mode, setMode] = useState(() => params.get('area') ? 'data' : 'overview')
  const [selection, setSelection] = useState(() => ({ area: params.get('area'), feature: null }))
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState('all')
  const [view, setView] = useState('all')
  const returnFocus = useRef(null)
  const pageHeading = useRef(null)
  const previousMode = useRef(mode)
  useEffect(() => {
    if (previousMode.current !== mode) { pageHeading.current?.focus({ preventScroll: true }); pageHeading.current?.scrollIntoView({ block: 'start' }); previousMode.current = mode }
  }, [mode])
  useEffect(() => {
    let cancelled = false
    client.get('/ai/config').then(res => { if (!cancelled) setAiReady(res.data?.data?.available === true) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const visible = useMemo(() => filterFeatureAreas(areas, { query, domain, view }), [areas, query, domain, view])
  const selectedArea = areas.find(area => area.key === selection.area)
  const selectedSignal = selectedArea?.signals.find(signal => signal.key === selection.feature) || (selection.area && !selection.feature ? selectedArea?.signals[0] : null)
  const checking = state === 'checking'
  const filtered = query.trim() || domain !== 'all' || view !== 'all'
  const showAvailable = view === 'all' || view === 'available'
  const showUnresolved = view !== 'available'
  function selectFeature(area, signal, event) { returnFocus.current = event.currentTarget; setSelection({ area: area.key, feature: signal.key }) }
  function closeDetails() { setSelection({ area: null, feature: null }); returnFocus.current?.focus() }
  function clearFilters() { setQuery(''); setDomain('all'); setView('all') }
  return (
    <Layout>
      <div className="mx-auto max-w-[1440px]">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 ref={pageHeading} tabIndex={-1} className="scroll-mt-20 text-[22px] font-semibold tracking-[-0.015em] focus-visible:outline-2 focus-visible:outline-[var(--link)]">Coverage</h1><p className="mt-1 max-w-[80ch] text-[13.5px] text-[var(--ink-2)]">The business, features and reports this company is intended to cover — compared with available evidence.</p></div>{ready && state !== 'unavailable' && <div className="flex items-center gap-3 text-[12px] text-[var(--ink-3)]">{result && <span>Read {relativeTime(result.checkedAt)}</span>}<Button variant="outline" onClick={() => check({ refresh: true })} disabled={checking}>{checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{checking ? 'Reading company…' : 'Refresh record evidence'}</Button></div>}</div>
        <nav aria-label="Coverage workspace" className="mt-5 flex flex-wrap gap-1 border-b border-[var(--line)] pb-3">{[['overview', 'Intended coverage'], ['features', 'Feature requirements'], ['reports', 'Report requirements'], ['data', 'Company data']].map(([key, label]) => <Button key={key} variant={mode === key ? 'secondary' : 'ghost'} size="sm" aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</Button>)}</nav>
        {mode !== 'data' && <CoverageTargets mode={mode} onModeChange={setMode} connection={connection} result={result} recordState={ready ? state : 'disconnected'} onInspectArea={key => { setSelection({ area: key, feature: null }); setQuery(areas.find(area => area.key === key)?.name || ''); setView('all'); setDomain('all'); setMode('data') }} />}
        {mode === 'data' && <>
        <div className="mt-6"><h2 className="text-[18px] font-semibold">Supporting company data</h2><p className="mt-1 text-[13px] text-[var(--ink-2)]">Record and setup observations support the coverage requirements. They do not establish the complete intended business or report coverage.</p></div>
        {!ready ? <p className="mt-8 text-[13.5px] text-[var(--ink-2)]">Connect the QuickBooks company to see its feature coverage.</p>
          : state === 'unavailable' ? <CoverageUnavailable className="mt-8" />
            : !result ? state === 'error' ? <p role="alert" className="mt-8 text-[13px] text-[var(--danger-ink)]">{error} <button type="button" className="text-[var(--link)] underline" onClick={() => check({ refresh: true })}>Try again</button></p>
              : <p role="status" className="mt-8 flex items-center gap-2 text-[13px] text-[var(--ink-2)]"><LoaderCircle className="size-4 animate-spin" />Reading company records and setup…</p>
              : <>
                {state === 'error' && <p role="alert" className="mt-4 text-[13px] text-[var(--danger-ink)]">{error} Showing the earlier coverage findings.</p>}
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--line)] py-3">
                  <div role="group" aria-label="Feature coverage filter" className="flex flex-wrap gap-1">{VIEWS.map(([key, label]) => <Button key={key} variant={view === key ? 'secondary' : 'ghost'} size="sm" aria-pressed={view === key} onClick={() => setView(key)}>{label}</Button>)}</div>
                  <div className="flex flex-wrap items-center gap-2"><div className="relative min-w-48"><Search aria-hidden="true" className="pointer-events-none absolute top-2 left-2.5 size-4 text-[var(--ink-3)]" /><Input type="search" aria-label="Find a QuickBooks feature" placeholder="Find a feature…" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} /></div><select aria-label="Business area" className="h-8 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-[12px]" value={domain} onChange={event => setDomain(event.target.value)}><option value="all">All business areas</option>{Object.entries(DOMAIN_LABEL).filter(([key]) => areas.some(area => area.domain === key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>{filtered && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>}</div>
                </div>
                <p className="mt-3 text-[12px] text-[var(--ink-3)]">Select a named feature for its evidence. Older records still count as data. Transaction search: last {result.lookbackDays || 365} days{result.asOf ? ` through ${shortDate(result.asOf)}` : ''}.</p>
                <div className={cn('mt-4 grid items-start gap-5', selectedSignal && 'lg:grid-cols-[minmax(0,1fr)_340px]')}>
                  <div className="min-w-0 overflow-x-auto rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
                    <table className="w-full table-fixed text-left"><caption className="sr-only">QuickBooks functionality with company data, missing data, or unresolved verification</caption>
                      <thead><tr className="border-b border-[var(--line)] text-[11.5px] text-[var(--ink-3)]"><th className={cn("px-4 py-3 font-medium", view === "all" ? "w-[19%]" : "w-1/4")}>Feature area</th><th className={cn("px-4 py-3 font-medium", view === "all" ? "w-[45%]" : "w-3/4", !showAvailable && "hidden")}>Covered by company data</th><th className={cn("px-4 py-3 font-medium", !showUnresolved && "hidden")}>Missing data or needs verification</th></tr></thead>
                      <tbody>{visible.map(area => {
                        const available = area.signals.filter(signal => featureGroup(signal) === 'available')
                        const unresolved = area.signals.filter(signal => featureGroup(signal) !== 'available')
                        return <tr key={area.key} className="border-b border-[var(--line)] last:border-0"><th scope="row" className="px-4 py-4 align-top"><p className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--ink-3)]">{DOMAIN_LABEL[area.domain] || area.domain}</p><p className="mt-1 text-[13px] font-medium leading-snug">{area.name}</p></th><td className={cn("px-4 py-3 align-top", !showAvailable && "hidden")}><div className="flex flex-wrap gap-1.5">{available.map(signal => <FeatureButton key={signal.key} signal={signal} selected={selection.area === area.key && selectedSignal?.key === signal.key} onSelect={event => selectFeature(area, signal, event)} />)}{!available.length && <span className="py-1 text-[12px] text-[var(--ink-3)]">{view !== 'all' ? '—' : unresolved.some(signal => featureGroup(signal) === 'verification') ? 'Not established' : 'No data found'}</span>}</div></td><td className={cn("px-4 py-3 align-top", !showUnresolved && "hidden")}><div className="flex flex-wrap gap-1.5">{unresolved.map(signal => <div key={signal.key}><FeatureButton signal={signal} selected={selection.area === area.key && selectedSignal?.key === signal.key} onSelect={event => selectFeature(area, signal, event)} /><p className="mt-0.5 px-2 text-[10.5px] text-[var(--ink-3)]">{STATE_LABEL[featureState(signal)]}</p></div>)}{!unresolved.length && <span className="py-1 text-[12px] text-[var(--ink-3)]">{view === 'all' ? 'None identified in the listed features' : '—'}</span>}</div></td></tr>
                      })}{!visible.length && <tr><td colSpan={view === 'all' ? 3 : 2} className="px-5 py-10 text-center text-[13px] text-[var(--ink-2)]"><p>No features match this view.</p><Button variant="link" size="sm" onClick={clearFilters}>Show all features</Button></td></tr>}</tbody>
                    </table>
                  </div>
                  {selectedArea && selectedSignal && <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"><FeatureDetail area={selectedArea} signal={selectedSignal} canAsk={ready && aiReady} onClose={closeDetails} /></div>}
                </div>
                {!!result.sourceErrors?.length && <p className="mt-4 text-[12px] text-[var(--attention)]">Some sources could not be read: {result.sourceErrors.map(source => source.source).join(', ')}. Their feature coverage remains unverified.</p>}
                <p className="mt-4 text-[12px] leading-relaxed text-[var(--ink-3)]">These findings show which listed features have supporting records or setup. They do not establish complete business history, every QuickBooks feature, or reconciled reports. <Link to="/reports" className="text-[var(--link)] underline">Inspect reports</Link>.</p>
              </>}
        </>}
      </div>
    </Layout>
  )
}
