import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LoaderCircle, RefreshCw, WandSparkles } from 'lucide-react'
import Layout from '../components/Layout'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import {
  AREA_STATE, CoverageUnavailable, Pip, PipLegend, Pips, SIGNAL_STATE, areaCounts, assistantGaps, fillRequest,
  DOMAIN_LABEL, isGap, measuredAreas, relativeTime, signalDetail, useCoverage,
} from '@/components/coverage'
import { cn } from '@/lib/utils'

// Coverage answers: which parts of QuickBooks does this company actually use?
// Every area is measured from the company's own records, so a gap here is a
// real gap, and each one says who can close it.

const BAR_ORDER = ['covered', 'partial', 'stale', 'missing', 'manual', 'error']
const BAR_CLS = {
  covered: 'bg-[var(--ok)]',
  partial: 'bg-[var(--ok)] opacity-45',
  stale: 'bg-[var(--attention-dot)]',
  missing: 'bg-[var(--line-strong)]',
  manual: 'bg-[repeating-linear-gradient(135deg,var(--ink-3)_0_1.5px,transparent_1.5px_4px)]',
  error: 'bg-[var(--danger-ink)]',
}

function SummaryBand({ result }) {
  const counts = result.summary.areas
  const total = result.summary.measuredAreas
  const gaps = result.summary.gaps
  return (
    <section className="mt-6 grid grid-cols-1 gap-6 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-6 py-5 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
      <div>
        <div className="flex items-baseline gap-1.5 tabular">
          <span className="text-[34px] font-semibold leading-none tracking-[-0.03em] text-[var(--ink)]">{counts.covered || 0}</span>
          <span className="text-[17px] text-[var(--ink-3)]">/ {total}</span>
        </div>
        <p className="mt-1 text-[12.5px] text-[var(--ink-2)]">areas fully in use</p>
      </div>
      <div className="min-w-0">
        <div className="flex h-2.5 overflow-hidden rounded-full bg-[var(--sunken)]" role="img" aria-label={BAR_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${AREA_STATE[k].label.toLowerCase()}`).join(', ')}>
          {BAR_ORDER.filter((k) => counts[k]).map((k) => (
            <span key={k} className={cn('h-full border-r-2 border-[var(--surface)] last:border-r-0', BAR_CLS[k])} style={{ width: `${(counts[k] / total) * 100}%` }} />
          ))}
        </div>
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-[var(--ink-2)]">
          {BAR_ORDER.filter((k) => counts[k]).map((k) => (
            <li key={k} className="inline-flex items-center gap-1.5">
              <span className={cn('inline-block size-2 rounded-[2px]', BAR_CLS[k])} aria-hidden="true" />
              <span className="tabular font-medium text-[var(--ink)]">{counts[k]}</span> {AREA_STATE[k].label.toLowerCase()}
            </li>
          ))}
        </ul>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 text-[12.5px] lg:border-l lg:border-[var(--line)] lg:pl-6">
        <div>
          <dt className="text-[var(--ink-2)]">Assistant can fill</dt>
          <dd className="text-[22px] font-semibold tabular text-[var(--ink)]">{gaps.assistant}</dd>
        </div>
        <div>
          <dt className="text-[var(--ink-2)]">Do in QuickBooks</dt>
          <dd className="text-[22px] font-semibold tabular text-[var(--ink)]">{gaps.quickbooks}</dd>
        </div>
      </dl>
    </section>
  )
}

function AreaTile({ area, selected, onSelect }) {
  const { inUse, measured } = areaCounts(area)
  const state = AREA_STATE[area.status] || AREA_STATE.missing
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex min-w-0 flex-col gap-2.5 rounded-[8px] border bg-[var(--surface)] px-3.5 py-3 text-left transition-colors duration-100',
        selected ? 'border-[var(--ink)] shadow-[0_0_0_1px_var(--ink)]' : 'border-[var(--line)] hover:border-[var(--line-strong)]',
      )}
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--ink-3)]">{DOMAIN_LABEL[area.domain] || area.domain}</span>
        <span className="text-[13px] font-medium leading-snug text-[var(--ink)]">{area.name}</span>
      </span>
      <Pips signals={area.signals} />
      <span className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className={state.tone}>{state.label}</span>
        {measured > 0 && <span className="tabular text-[var(--ink-3)]">{inUse} of {measured}</span>}
      </span>
    </button>
  )
}

function SignalRow({ signal }) {
  const gap = isGap(signal)
  return (
    <li className="flex gap-3 px-5 py-3">
      <Pip status={signal.status} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-[13.5px] text-[var(--ink)]">{signal.label}</span>
          <span className="text-[11.5px] text-[var(--ink-3)]">{SIGNAL_STATE[signal.status]?.label}</span>
        </div>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{signalDetail(signal)}</p>
        {gap && (
          <p className="mt-1 text-[12px] font-medium text-[var(--ink-3)]">
            {signal.fill === 'assistant' ? 'The assistant can add these' : (signal.blockedBy || 'Set this up in QuickBooks')}
          </p>
        )}
      </div>
    </li>
  )
}

function AreaDetail({ area, canAsk }) {
  const navigate = useNavigate()
  const fillable = assistantGaps(area)
  const state = AREA_STATE[area.status] || AREA_STATE.missing
  return (
    <section className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)]" aria-label={area.name}>
      <header className="border-b border-[var(--line)] px-5 py-4">
        <p className={cn('text-[12px] font-medium', state.tone)}>{state.label}</p>
        <h2 className="mt-0.5 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-[var(--ink)]">{area.name}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink-2)]">{area.purpose}</p>
      </header>
      <ul className="divide-y divide-[var(--line)]">
        {area.signals.map((s) => <SignalRow key={s.key} signal={s} />)}
      </ul>
      {fillable.length > 0 && (
        <div className="border-t border-[var(--line)] px-5 py-4">
          <Button
            size="lg"
            disabled={!canAsk}
            onClick={() => navigate('/cases/new', { state: { message: fillRequest(area, fillable) } })}
          >
            <WandSparkles /> Ask the assistant to fill {fillable.length === 1 ? 'this gap' : `${fillable.length} gaps`}
          </Button>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-3)]">
            It proposes the exact records first. Nothing is written until you approve.
          </p>
        </div>
      )}
      {area.linkedReports.length > 0 && (
        <div className="border-t border-[var(--line)] px-5 py-4">
          <h3 className="text-[12px] font-medium text-[var(--ink-2)]">Reports that depend on this</h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {area.linkedReports.map((name) => (
              <li key={name} className="rounded-md bg-[var(--sunken)] px-2 py-0.5 text-[12px] text-[var(--ink-2)]">{name}</li>
            ))}
          </ul>
        </div>
      )}
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

  useEffect(() => {
    let cancelled = false
    client.get('/ai/config')
      .then((res) => { if (!cancelled) setAiReady(res.data?.data?.available === true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [selectedKey, setSelectedKey] = useState(() => params.get('area'))

  const defaultArea = areas.find((a) => assistantGaps(a).length > 0) || areas[0]
  const selected = areas.find((a) => a.key === selectedKey) || defaultArea
  const checking = state === 'checking'

  return (
    <Layout>
      <div className="mx-auto max-w-[1280px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ink)]">Coverage</h1>
            <p className="mt-1 max-w-[70ch] text-[13.5px] text-[var(--ink-2)]">
              Which parts of QuickBooks this company actually uses, read from its own records. Each square is one thing a real business does.
            </p>
          </div>
          {ready && state !== 'unavailable' && (
            <div className="flex items-center gap-3 text-[12.5px] text-[var(--ink-3)]">
              {result && <span>Checked {relativeTime(result.checkedAt)}</span>}
              <Button variant="outline" onClick={() => check({ refresh: true })} disabled={checking}>
                {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                {checking ? 'Reading the company…' : 'Check again'}
              </Button>
            </div>
          )}
        </div>

        {!ready ? (
          <p className="mt-8 text-[13.5px] text-[var(--ink-2)]">Coverage is read from QuickBooks, so it shows once the company is connected.</p>
        ) : state === 'unavailable' ? (
          <CoverageUnavailable className="mt-8" />
        ) : !result ? (
          state === 'error' ? (
            <p className="mt-8 text-[13.5px] text-[var(--danger-ink)]">
              {error} <button type="button" className="font-medium text-[var(--link)] hover:underline" onClick={() => check({ refresh: true })}>Try again</button>
            </p>
          ) : (
            <p className="mt-8 flex items-center gap-2 text-[13.5px] text-[var(--ink-2)]" role="status">
              <LoaderCircle className="size-4 animate-spin" /> Reading every part of the company. This takes up to half a minute the first time.
            </p>
          )
        ) : (
          <>
            {state === 'error' && <p className="mt-4 text-[13px] text-[var(--danger-ink)]">{error} Showing the previous check.</p>}
            <SummaryBand result={result} />
            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
              <div className="flex min-w-0 flex-col gap-6">
                <PipLegend />
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {areas.map((area) => (
                    <AreaTile key={area.key} area={area} selected={selected?.key === area.key} onSelect={() => setSelectedKey(area.key)} />
                  ))}
                </div>
                {result.sourceErrors.length > 0 && (
                  <p className="text-[12.5px] leading-relaxed text-[var(--ink-3)]">
                    QuickBooks didn't return {result.sourceErrors.map((e) => e.source).join(', ')}, so those checks show as "Couldn't check".
                  </p>
                )}
              </div>
              <div className="lg:sticky lg:top-20 lg:self-start">
                {selected && <AreaDetail area={selected} canAsk={ready && aiReady} />}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
