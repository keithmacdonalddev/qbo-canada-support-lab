import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, BookOpen, ChevronRight, Search } from 'lucide-react'
import catalog from '../../../docs/discovery/catalog.v1.json'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { cn } from '@/lib/utils'
import { filterTargets, matchesScope, recordEvidence, RELEASE_TARGETS, savedComparison, targetGroups, UNMAPPED_ADVANCED } from '@/lib/coverage-targets.mjs'

const groups = targetGroups(catalog)
const tierLabel = { 'tier-1': 'Essential · Tier 1', 'tier-2': 'Extended · Tier 2', 'manual-only-critical': 'Essential · manual evidence', critical: 'Critical report', supporting: 'Supporting report' }
const familyLabel = { financial: 'Financial statements', cash: 'Cash', receivables: 'Receivables', payables: 'Payables', expenses: 'Expenses', sales: 'Sales', inventory: 'Inventory', projects: 'Projects', tax: 'Canadian tax', budget: 'Budgets', reconciliation: 'Reconciliation', audit: 'Audit & exceptions' }
const panel = 'rounded-[10px] border border-[var(--line)] bg-[var(--surface)]'
const muted = 'text-[var(--ink-2)]'
function date(value) { return value ? new Date(value.slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—' }
function SectionHeading({ eyebrow, title, children }) { return <div><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-3)]">{eyebrow}</p><h2 className="mt-1 text-[19px] font-semibold tracking-tight">{title}</h2>{children && <p className="mt-1.5 max-w-[90ch] text-[13px] leading-relaxed text-[var(--ink-2)]">{children}</p>}</div> }
function Tags({ items }) { return <ul className="flex flex-wrap gap-1.5">{items.map((s, i) => <li key={i} className="rounded border border-[var(--line)] bg-[var(--sunken)] px-2 py-1 text-[12px]">{s}</li>)}</ul> }
function BulletList({ items }) { return items?.length ? <ul className="list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-[var(--ink-2)]">{items.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="text-[12px] text-[var(--ink-3)]">None specified in this requirement.</p> }
function EvidenceSummary({ evidence, result, recordState, compact = false }) {
  if (!result) return <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">{recordState === 'loading' || recordState === 'checking' ? 'Reading company evidence…' : 'Company comparison unavailable. The intended requirement remains in scope.'}</p>
  if (!evidence.observed) return <p className="text-[12px] leading-relaxed text-[var(--ink-3)]">No automated company observation for this requirement. Inspect its specified evidence.</p>
  return <div className="space-y-1.5 text-[12px] leading-relaxed">
    {!!evidence.available.length && <p><span className="font-medium text-[var(--ok)]">Data found:</span> <span className={muted}>{evidence.available.slice(0, compact ? 3 : undefined).join(', ')}{compact && evidence.available.length > 3 ? '…' : ''}</span></p>}
    {!!evidence.missing.length && <p><span className="font-medium text-[var(--attention)]">Data gaps:</span> <span className={muted}>{evidence.missing.slice(0, compact ? 2 : undefined).join(', ')}{compact && evidence.missing.length > 2 ? '…' : ''}</span></p>}
    {!!evidence.unresolved.length && <p className={muted}>Needs verification: {evidence.unresolved.slice(0, compact ? 2 : undefined).join(', ')}{compact && evidence.unresolved.length > 2 ? '…' : ''}</p>}
    {!compact && <p className="pt-2 text-[var(--ink-3)]">These observations establish record or setup presence. Required variations, linked history and accounting agreement still need their specified evidence.</p>}
  </div>
}
function SavedBusiness({ saved, onRetry }) {
  const comparison = savedComparison(saved.plan.data, saved.governance.data)
  const { draft, published, calendar, draftIsPublished } = comparison
  return <section className={cn(panel, 'p-5')} aria-label="Saved company history comparison">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-[14px] font-semibold">This company's managed history</h3><p className="mt-1 text-[12px] text-[var(--ink-3)]">Saved business plan and calendar</p></div><Link to="/company" className="text-[12px] text-[var(--link)] hover:underline">Open business plan <span aria-hidden="true">↗</span></Link></div>
    <dl className="mt-4 grid gap-4 sm:grid-cols-3">
      <div><dt className="text-[11px] text-[var(--ink-3)]">Published starting point</dt><dd className="mt-1 text-[14px] font-medium">{saved.governance.state !== 'ready' ? saved.governance.state === 'loading' ? 'Reading…' : 'Unavailable' : published ? date(published.openingDate || calendar?.openingDate) : 'Not published'}</dd></div>
      <div><dt className="text-[11px] text-[var(--ink-3)]">Managed periods verified through</dt><dd className="mt-1 text-[14px] font-medium">{saved.governance.state !== 'ready' ? saved.governance.state === 'loading' ? 'Reading…' : 'Unavailable' : calendar?.verifiedThrough ? date(calendar.verifiedThrough) : 'No verified period saved'}</dd></div>
      <div><dt className="text-[11px] text-[var(--ink-3)]">Saved plan's history target</dt><dd className="mt-1 text-[14px] font-medium">{saved.plan.state !== 'ready' ? saved.plan.state === 'loading' ? 'Reading…' : 'Unavailable' : draft ? draft.business.historicalMonths + ' months' : 'No current draft saved'}</dd>{draft && <p className="mt-1 text-[11px] text-[var(--ink-3)]">{draftIsPublished ? 'Matches published plan' : 'Draft · publication not established for this version'}</p>}</div>
    </dl>
    {['plan', 'governance'].some(key => saved[key].state === 'error') && <p role="alert" className="mt-4 text-[12px] text-[var(--attention)]">Some saved state could not be read. It has not been treated as missing progress. <button type="button" onClick={onRetry} className="text-[var(--link)] underline">Retry saved-state read</button></p>}
    {saved.governance.state === 'disconnected' && <p className="mt-4 text-[12px] text-[var(--ink-3)]">Connect the company to compare its saved progress with the target.</p>}
    <p className="mt-4 border-t border-[var(--line)] pt-3 text-[11px] leading-relaxed text-[var(--ink-3)]">A verified calendar period records managed activity checks. It does not certify every feature, report or bank reconciliation. Existing unmanaged records may extend beyond it.</p>
  </section>
}
function Overview({ result, recordState, saved, retry, chooseFeature, showReports }) {
  return <div className="space-y-7">
    <section className={cn(panel, 'overflow-hidden')} aria-label="Intended company coverage">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_310px]">
        <div className="p-5"><SectionHeading eyebrow="The company this app is built to maintain" title="One believable Canadian business. Three connected lines of work.">QuickBooks Online Advanced Canada, with coherent activity across service projects, inventory and wholesale, and recurring services.</SectionHeading>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[12px] font-medium">{['Service & projects', 'Inventory & wholesale', 'Recurring services'].map(name => <li key={name} className="border-l-2 border-[var(--line-strong)] pl-2.5">{name}</li>)}</ul>
        </div>
        <div className="border-t border-[var(--line)] bg-[var(--sunken)] p-5 lg:border-t-0 lg:border-l"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-3)]">Initial approved design horizon</p><p className="mt-2 text-[28px] font-semibold tracking-tight">36 months</p><p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-2)]">Coherent historical business, followed by continuing activity on a governed calendar.</p><p className="mt-2 text-[11px] text-[var(--ink-3)]">Design target · saved progress shown below</p></div>
      </div>
      <div className="flex flex-wrap gap-x-7 gap-y-2 border-t border-[var(--line)] px-6 py-3 text-[12px] text-[var(--ink-2)]"><span><strong className="text-[var(--ink)]">21</strong> business capability areas</span><span><strong className="text-[var(--ink)]">48</strong> report requirements</span><span><strong className="text-[var(--ink)]">3</strong> app operating requirements</span><span className="text-[var(--ink-3)]">Defined project scope · remaining product scope gaps below</span></div>
    </section>
    <section><div className="flex flex-wrap items-end justify-between gap-3"><SectionHeading eyebrow="Intended functional breadth" title="What this company must be able to demonstrate">Coverage means representative business variations, coherent linked records and the accounting evidence behind them. Record presence is one part of that proof.</SectionHeading><Button variant="outline" size="sm" onClick={showReports}><BookOpen /> Review report requirements</Button></div>
      <div className={cn(panel, 'mt-4 overflow-hidden')}><div className="hidden grid-cols-[1fr_1.15fr] gap-6 border-b border-[var(--line)] bg-[var(--sunken)] px-5 py-3 text-[11px] font-medium text-[var(--ink-3)] lg:grid"><span>Required business outcome and variations</span><span>Current company observations · coverage not yet certified here</span></div>
        {groups.map(group => <div key={group.key} className="grid gap-4 border-b border-[var(--line)] p-5 last:border-b-0 lg:grid-cols-[1fr_1.15fr] lg:gap-6"><div><button type="button" onClick={() => chooseFeature(group.keys[0])} className="group inline-flex items-center gap-2 text-left text-[14px] font-semibold hover:text-[var(--link)] focus-visible:outline-2 focus-visible:outline-[var(--link)]">{group.name}<ChevronRight className="size-3.5 text-[var(--ink-3)] group-hover:text-[var(--link)]" /></button>{group.internal && <span className="ml-2 text-[10px] text-[var(--ink-3)]">App reliability</span>}<p className="mt-1 text-[13px] text-[var(--ink-2)]">{group.outcome}</p><p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">{group.examples}</p></div><div><EvidenceSummary evidence={recordEvidence(result, group.keys)} result={result} recordState={recordState} compact /><button type="button" onClick={() => chooseFeature(group.keys[0])} className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--link)] hover:underline">Review requirements & evidence <ArrowRight className="size-3" /></button></div></div>)}
      </div>
    </section>
    <SavedBusiness saved={saved} onRetry={retry} />
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <section className={cn(panel, 'p-5')}><SectionHeading eyebrow="Approved release targets · achievement not calculated" title="What counts as enough coverage" /><ul className="mt-4 divide-y divide-[var(--line)]">{RELEASE_TARGETS.map(([value, label]) => <li key={label} className="flex items-baseline gap-4 py-3 text-[12px]"><span className="w-14 shrink-0 font-semibold tabular-nums">{value}</span><span className={muted}>{label}</span></li>)}</ul><p className="mt-3 text-[11px] leading-relaxed text-[var(--ink-3)]">Business dates must also have no calendar gaps or overlaps. Complete requirements and period-specific evidence are needed before calculating achievement.</p></section>
      <section className={cn(panel, 'p-5')}><SectionHeading eyebrow="Scope still needs classification" title="The catalog does not cover all Advanced functionality">Intuit lists these Advanced Canada features, but they have no explicit capability classification in this project's current catalog. Their intended inclusion, manual path or exclusion remains unresolved.</SectionHeading><div className="mt-4"><Tags items={UNMAPPED_ADVANCED} /></div><p className="mt-4 text-[11px] leading-relaxed text-[var(--ink-3)]">These are scope decisions, not missing-data findings. Payroll and other conditional functionality also depend on actual entitlement.</p><a href="https://quickbooks.intuit.com/ca/online/advanced/" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] text-[var(--link)] hover:underline">Intuit's Canadian Advanced features <ArrowUpRight className="size-3" /></a></section>
    </div>
  </div>
}
function RequirementDetail({ item, kind, result, recordState, inspectArea, headingRef }) {
  const isReport = kind === 'report'
  const prerequisites = isReport ? item.prerequisites : item.requirements
  const reports = isReport ? [] : catalog.reports.filter(r => item.linkedReports.includes(r.key))
  return <section className={cn(panel, 'min-w-0')} aria-label="Selected coverage requirement">
    <header className="border-b border-[var(--line)] p-5"><p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-3)]">{tierLabel[item.tier] || item.tier}</p><h2 ref={headingRef} tabIndex={-1} className="mt-2 text-[20px] font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-[var(--link)]">{item.name}</h2><p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-2)]">{isReport ? item.businessQuestion : item.purpose}</p></header>
    <div className="space-y-6 p-5">
      <div className="rounded-md border border-[var(--line)] bg-[var(--sunken)] p-3"><p className="mb-2 text-[10px] text-[var(--ink-3)]">Catalog classifications · {catalog.asOfDate} · company evidence is separate</p><dl className="grid gap-3 text-[12px] sm:grid-cols-2"><div><dt className="text-[11px] text-[var(--ink-3)]">Advanced Canada applicability</dt><dd className="mt-1 capitalize">{item.applicability.status.replaceAll('-', ' ')}</dd></div><div><dt className="text-[11px] text-[var(--ink-3)]">API / manual route</dt><dd className="mt-1">{isReport ? item.api.status === 'supported' ? 'Reports API documented' : item.api.status === 'manual-only' ? 'Manual report inspection in QuickBooks' : item.api.status.replaceAll('-', ' ') : item.apiSurface === 'none' ? 'Manual inspection in QuickBooks' : item.apiSurface === 'rest-and-graphql' ? 'REST and GraphQL; operation limits below' : 'REST API; operation limits below'}</dd></div></dl>{!isReport && <details className="mt-3"><summary className="cursor-pointer text-[11px] text-[var(--link)]">Documented API operations</summary><dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[var(--ink-2)]">{Object.entries(item.apiOperations).map(([operation, state]) => <div key={operation} className="flex justify-between gap-2"><dt className="capitalize">{operation}</dt><dd>{state.replaceAll('-', ' ')}</dd></div>)}</dl></details>}</div>
      {isReport ? <><div><h3 className="mb-2 text-[13px] font-semibold">Required business periods</h3><Tags items={item.periods} /></div><div><h3 className="mb-2 text-[13px] font-semibold">Expected populated content</h3><BulletList items={item.expectedNonZero} /></div><div><h3 className="mb-2 text-[13px] font-semibold">Accounting relationships to verify</h3><BulletList items={item.assertions} /></div><p className="text-[12px] leading-relaxed text-[var(--ink-3)]">Record the accounting basis, exact period and filters with each observation. Availability, populated output, plausible amounts and reconciliation are separate findings.</p></> : <><div><h3 className="mb-2 text-[13px] font-semibold">Required variations</h3><Tags items={item.variants} /></div><div><h3 className="mb-2 text-[13px] font-semibold">Evidence needed to establish coverage</h3><p className="text-[13px] leading-relaxed text-[var(--ink-2)]">Represent the applicable variations with coherent records or settings, preserve transaction links, and verify the related business and accounting results.</p><p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-3)]">A matching record alone does not establish this requirement.</p><details className="mt-3"><summary className="cursor-pointer text-[12px] text-[var(--link)]">Catalog verification procedure</summary><p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-2)]">{item.evidenceMethod}</p></details></div></>}
      <details className="rounded-md border border-[var(--line)] p-3"><summary className="cursor-pointer text-[12px] font-medium">Prerequisites & scope conditions</summary><div className="mt-3 space-y-3">{Object.entries(prerequisites).filter(([, values]) => values.length).map(([name, values]) => <div key={name}><h4 className="mb-1 text-[11px] font-medium capitalize text-[var(--ink-3)]">{name.replace(/([A-Z])/g, ' $1')}</h4><BulletList items={values} /></div>)}<p className="text-[12px] leading-relaxed text-[var(--ink-2)]">{item.applicability.notes}</p><BulletList items={isReport ? item.knownDiscrepancies : item.limitations} />{!isReport && !!item.approvedExclusions.length && <><h4 className="text-[12px] font-medium">Approved exclusions</h4><BulletList items={item.approvedExclusions} /></>}</div></details>
      {isReport ? <div className="border-t border-[var(--line)] pt-5"><h3 className="text-[13px] font-semibold">Compare retained company evidence</h3><p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-2)]">Open this report's existing evidence view to inspect dated observations and their results. This requirements list does not infer that evidence is missing or that the report is covered.</p><Link to={'/reports?report=' + item.key} className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--link)] hover:underline">Open {item.name} evidence <ArrowUpRight className="size-3.5" /></Link></div> : <><div className="border-t border-[var(--line)] pt-5"><h3 className="mb-3 text-[13px] font-semibold">Available company record observations</h3><EvidenceSummary evidence={recordEvidence(result, [item.key])} result={result} recordState={recordState} />{result?.areas?.some(a => a.key === item.key && a.signals?.length) && <Button variant="outline" size="sm" className="mt-4" onClick={() => inspectArea(item.key)}>Inspect company data <ArrowRight /></Button>}</div>{!!reports.length && <div><h3 className="mb-2 text-[13px] font-semibold">Related report requirements & evidence</h3><ul className="space-y-2">{reports.map(report => <li key={report.key}><Link to={'/reports?report=' + report.key} className="inline-flex items-center gap-1 text-[12px] text-[var(--link)] hover:underline">{report.name}<ArrowUpRight className="size-3" /></Link></li>)}</ul></div>}</>}
    </div><footer className="border-t border-[var(--line)] px-5 py-3 text-[10px] leading-relaxed text-[var(--ink-3)]">Project catalog definition · {catalog.asOfDate}. Discovery status and dates are not live company findings.</footer>
  </section>
}
function Requirements({ kind, selected, onSelect, result, recordState, inspectArea }) {
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('all')
  const [priority, setPriority] = useState('all')
  const heading = useRef(null)
  const shouldFocus = useRef(false)
  const isReport = kind === 'report'
  const items = useMemo(() => isReport ? catalog.reports : groups.flatMap(g => g.capabilities), [isReport])
  const visible = useMemo(() => filterTargets(items, query, group, priority, kind), [items, query, group, priority, kind])
  const item = visible.find(c => c.key === selected) || visible[0]
  useEffect(() => { if (shouldFocus.current) { heading.current?.focus({ preventScroll: true }); shouldFocus.current = false } }, [item?.key])
  return <section>
    <SectionHeading eyebrow={isReport ? 'Report coverage requirements' : 'Feature coverage requirements'} title={isReport ? 'Useful reports, backed by explainable accounting' : 'The variations this company is intended to represent'}>{isReport ? 'All 48 project report definitions: their business questions, periods, expected content and relationships to verify. Inspect retained evidence in Reports.' : 'All 21 business capability areas and 3 app operating requirements. Select a requirement to compare the intended scope with available observations.'}</SectionHeading>
    <div className="mt-5 flex flex-wrap gap-2"><div className="relative min-w-64 flex-1"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-[var(--ink-3)]" /><Input type="search" aria-label={isReport ? 'Find a report requirement' : 'Find a feature requirement'} className="pl-9" placeholder={isReport ? 'Find a report or business question…' : 'Find a feature or required variation…'} value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label={isReport ? 'Report family' : 'Requirement group'} className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12px]" value={group} onChange={e => setGroup(e.target.value)}><option value="all">{isReport ? 'All report families' : 'All requirement groups'}</option>{(isReport ? Object.entries(familyLabel) : groups.map(g => [g.key, g.name])).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="Requirement priority" className="rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12px]" value={priority} onChange={e => setPriority(e.target.value)}><option value="all">All priorities</option>{[...new Set(items.map(i => i.tier))].map(t => <option key={t} value={t}>{tierLabel[t] || t}</option>)}</select></div>
    <p className="my-3 text-[11px] text-[var(--ink-3)]">{visible.length} of {items.length} requirements</p>
    {!visible.length ? <div className={cn(panel, 'p-8 text-center')}><p className="text-[13px] text-[var(--ink-2)]">No requirements match these filters.</p><Button variant="link" onClick={() => { setQuery(''); setGroup('all'); setPriority('all') }}>Show all requirements</Button></div> : <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,0.65fr)_minmax(0,1.35fr)]"><nav aria-label={isReport ? 'Report requirements' : 'Feature requirements'} className={cn(panel, 'overflow-hidden lg:max-h-[calc(100vh-170px)] lg:overflow-y-auto lg:sticky lg:top-20')}>{visible.map(c => <button key={c.key} type="button" aria-current={c.key === item.key ? 'true' : undefined} onClick={() => { shouldFocus.current = true; onSelect(c.key) }} className={cn('flex w-full items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3.5 text-left last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--link)]', item.key === c.key ? 'bg-[var(--sunken)] shadow-[inset_3px_0_0_var(--link)]' : 'hover:bg-[var(--hover)]')}><span><span className="block text-[10px] text-[var(--ink-3)]">{isReport ? familyLabel[c.family] : groups.find(g => g.keys.includes(c.key))?.name} · {tierLabel[c.tier] || c.tier}</span><span className="mt-1 block text-[13px] font-medium">{c.name}</span></span><ChevronRight className="size-3.5 shrink-0 text-[var(--ink-3)]" /></button>)}</nav><RequirementDetail item={item} kind={kind} result={result} recordState={recordState} inspectArea={inspectArea} headingRef={heading} /></div>}
  </section>
}
function ScopedTargets({ mode, onModeChange, connection, result, recordState, onInspectArea }) {
  const [feature, setFeature] = useState('sales.receivables-lifecycle')
  const [report, setReport] = useState('report.balance-sheet')
  const [attempt, setAttempt] = useState(0)
  const enabled = connection?.ready === true
  const initial = { state: enabled ? 'loading' : 'disconnected', data: null }
  const [saved, setSaved] = useState({ plan: initial, governance: initial })
  const scope = { realmId: connection?.status?.realmId, environment: connection?.environment, connectionId: connection?.status?.connectionId }
  const { realmId, environment, connectionId } = scope
  useEffect(() => {
    if (!enabled || !realmId || !connectionId) return
    const controller = new AbortController()
    const scope = { realmId, environment, connectionId }
    Promise.allSettled(['/company/business-plan', '/company/business-governance'].map(path => client.get(path, { signal: controller.signal }))).then(responses => {
      if (controller.signal.aborted) return
      const next = {}
      responses.forEach((response, i) => {
        const key = i === 0 ? 'plan' : 'governance'
        const data = response.status === 'fulfilled' ? response.value.data?.data : null
        next[key] = matchesScope(data, scope) ? { state: 'ready', data } : { state: 'error', data: null }
      })
      setSaved(next)
    })
    return () => controller.abort()
  }, [enabled, realmId, environment, connectionId, attempt])
  function chooseFeature(key) { setFeature(key); onModeChange('features') }
  return <div className="mt-6">{recordState === 'error' && result && <p role="alert" className="mb-4 rounded-md border border-[var(--line)] p-3 text-[12px] text-[var(--attention)]">The latest company read failed. Showing earlier record observations from {date(result.checkedAt)} at {new Date(result.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. Use Refresh record evidence to retry.</p>}{mode === 'overview' ? <Overview result={result} recordState={recordState} saved={saved} retry={() => { setSaved({ plan: initial, governance: initial }); setAttempt(a => a + 1) }} chooseFeature={chooseFeature} showReports={() => onModeChange('reports')} /> : mode === 'features' ? <Requirements key="features" kind="feature" selected={feature} onSelect={setFeature} result={result} recordState={recordState} inspectArea={onInspectArea} /> : <Requirements key="reports" kind="report" selected={report} onSelect={setReport} result={result} recordState={recordState} inspectArea={onInspectArea} />}</div>
}
export default function CoverageTargets(props) {
  const { user } = useAuth()
  const connection = props.connection
  const scopeKey = [user?.actorId || user?.id || user?._id, connection?.status?.realmId, connection?.environment, connection?.status?.connectionId, connection?.ready].join(':')
  return <ScopedTargets key={scopeKey} {...props} />
}
