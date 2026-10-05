/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useState } from 'react'
import client from '../api/client'
import { cn } from '@/lib/utils'

// Shared pieces for showing coverage: which parts of QuickBooks the company
// actually has records for. Each signal is drawn as a small square whose
// shape and colour both carry its state, so it reads without colour too.

export const SIGNAL_STATE = {
  ok: { label: 'In use', cls: 'bg-[var(--ok)] border-[var(--ok)]' },
  stale: { label: 'Stale', cls: 'bg-[var(--attention-dot)] border-[var(--attention-dot)]' },
  missing: { label: 'Missing', cls: 'bg-transparent border-[var(--ink-3)]' },
  manual: { label: 'Check by hand', cls: 'bg-[repeating-linear-gradient(135deg,var(--ink-3)_0_1.5px,transparent_1.5px_4px)] border-[var(--ink-3)]' },
  error: { label: "Couldn't check", cls: 'bg-transparent border-[var(--danger-ink)] border-dashed' },
}

export const AREA_STATE = {
  covered: { label: 'In use', tone: 'text-[var(--ok)]' },
  partial: { label: 'Partly used', tone: 'text-[var(--ink)]' },
  stale: { label: 'Gone quiet', tone: 'text-[var(--attention)]' },
  missing: { label: 'Not used', tone: 'text-[var(--ink-2)]' },
  manual: { label: 'Check by hand', tone: 'text-[var(--ink-2)]' },
  error: { label: "Couldn't check", tone: 'text-[var(--danger-ink)]' },
}

// Business order: money in, money out, stock, cash, tax, jobs, then the books
// and the company itself.
const DOMAIN_ORDER = ['sales', 'expenses', 'inventory', 'banking', 'tax', 'projects', 'accounting', 'company', 'users', 'administration']
export const DOMAIN_LABEL = {
  sales: 'Sales', expenses: 'Expenses', inventory: 'Inventory', banking: 'Banking', tax: 'Sales tax',
  projects: 'Projects', accounting: 'Accounting', company: 'Company setup', users: 'Users', administration: 'Records',
}

export function measuredAreas(result) {
  return (result?.areas || [])
    .filter((a) => !['internal', 'unmeasured'].includes(a.status))
    .sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain))
}

export const isGap = (s) => ['missing', 'stale'].includes(s.status)

export function assistantGaps(area) {
  return area.signals.filter((s) => isGap(s) && s.fill === 'assistant')
}

// The message that opens a case asking the assistant to fill an area's gaps.
export function fillRequest(area, signals = assistantGaps(area)) {
  const list = signals.map((s) => `- ${s.label}${s.status === 'stale' && s.last ? ` (last one ${s.last})` : ''}`).join('\n')
  return `Fill these coverage gaps in ${area.name}:\n${list}\n\nUse realistic records that fit the existing customers, vendors, items and accounts, dated in the last 30 days.`
}

export function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export function relativeTime(iso) {
  if (!iso) return ''
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : shortDate(iso)
}

// One line describing a signal's evidence.
export function signalDetail(s) {
  if (s.status === 'manual') return s.how
  if (s.status === 'error') return s.error ? `QuickBooks didn't answer: ${s.error}` : "QuickBooks didn't answer."
  if (s.blockedBy && s.count == null) return 'Not available until it is set up'
  const plus = s.truncated ? '+' : ''
  if (s.kind === 'setup') {
    if (s.count == null) return s.status === 'ok' ? 'Turned on' : 'Turned off'
    return s.min > 1 ? `${s.count}${plus} of ${s.min} needed` : `${s.count}${plus} found`
  }
  if (s.status === 'ok') return `${s.recent}${plus} in the last ${s.freshDays} days · latest ${shortDate(s.last)}`
  if (s.status === 'stale') return `None in the last ${s.freshDays} days · latest ${shortDate(s.last)}`
  return 'None in the last 12 months'
}

export function Pip({ status, className, title }) {
  const state = SIGNAL_STATE[status] || SIGNAL_STATE.missing
  return (
    <span
      title={title}
      className={cn('inline-block size-2.5 shrink-0 rounded-[2px] border-[1.5px]', state.cls, className)}
      aria-hidden="true"
    />
  )
}

export function Pips({ signals, className }) {
  return (
    <span className={cn('flex flex-wrap gap-[3px]', className)}>
      {signals.map((s) => <Pip key={s.key} status={s.status} title={`${s.label}: ${SIGNAL_STATE[s.status]?.label || s.status}`} />)}
    </span>
  )
}

export function PipLegend({ className }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--ink-2)]', className)} aria-label="Legend">
      {['ok', 'stale', 'missing', 'manual'].map((key) => (
        <li key={key} className="inline-flex items-center gap-1.5"><Pip status={key} />{SIGNAL_STATE[key].label}</li>
      ))}
    </ul>
  )
}

export function areaCounts(area) {
  const measured = area.signals.filter((s) => s.status !== 'manual')
  return { inUse: measured.filter((s) => s.status === 'ok').length, measured: measured.length }
}

// An older running backend answers 404 without this route's own message.
const isMissingRoute = (err) => err.response?.status === 404 && err.response?.data?.error !== 'No active QBO connection'

/**
 * Loads coverage for the connected company. Shows the last result straight
 * away when the server has one, then checks again if it has none.
 * state: 'loading' | 'checking' | 'ready' | 'unavailable' | 'error'
 */
export function useCoverage(enabled) {
  const [result, setResult] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState(null)

  const check = useCallback(async ({ refresh = false } = {}) => {
    setState('checking')
    setError(null)
    try {
      const res = await client.get('/coverage', { params: refresh ? { refresh: 'true' } : {} })
      setResult(res.data?.data || null)
      setState('ready')
    } catch (err) {
      const message = typeof err.response?.data?.error === 'string' ? err.response.data.error : null
      if (isMissingRoute(err)) {
        setState('unavailable')
      } else {
        setError(message || 'QuickBooks did not answer.')
        setState('error')
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    client.get('/coverage', { params: { cached: 'true' } })
      .then((res) => {
        if (cancelled) return
        const cached = res.data?.data || null
        if (cached) {
          setResult(cached)
          setState('ready')
        } else {
          check()
        }
      })
      .catch((err) => {
        if (cancelled) return
        if (isMissingRoute(err)) setState('unavailable')
        else check()
      })
    return () => { cancelled = true }
  }, [enabled, check])

  return { result, state, error, check }
}

export function CoverageUnavailable({ className }) {
  return (
    <p className={cn('text-[13px] leading-relaxed text-[var(--ink-2)]', className)}>
      Coverage checking is new and the running backend hasn't loaded it yet. Restart the backend to turn it on.
    </p>
  )
}
