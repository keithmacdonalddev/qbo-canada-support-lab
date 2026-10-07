import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Copy, LoaderCircle } from 'lucide-react'
import Layout from '../components/Layout'
import BookEvidence from '../components/BookEvidence'
import BusinessBaseline from '../components/BusinessBaseline'
import BusinessPlan from '../components/BusinessPlan'
import BusinessOperations from '../components/BusinessOperations'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { buttonVariants } from '@/components/ui/button'
import { StatusDot, EnvironmentTag } from '@/components/ui/status'
import { CoverageUnavailable, useCoverage } from '@/components/coverage'
import { cn } from '@/lib/utils'
import { companyReadiness } from '@/lib/company-readiness.mjs'

// Company answers: is the test company believable and current, and what's in it?
// Keeping it current is one decision ("catch up"), not a form of parameters.

const COUNT_ROWS = [
  { key: 'customers', label: 'Active customers' },
  { key: 'vendors', label: 'Active vendors' },
  { key: 'items', label: 'Active products and services' },
  { key: 'accounts', label: 'Active accounts' },
  { key: 'openInvoices', label: 'Open invoices' },
  { key: 'openBills', label: 'Unpaid bills' },
]

function shortDate(date) {
  if (!date) return '—'
  return new Date(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date + 'T12:00:00' : date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}


function humanizeAction(action) {
  const text = String(action || 'Activity').replace(/[._-]+/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function Panel({ title, action, children, className }) {
  return (
    <section className={cn('rounded-[10px] border border-[var(--line)] bg-[var(--surface)]', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
        <h2 className="text-[13px] font-semibold text-[var(--ink)]">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
      <dt className="text-[var(--ink-2)]">{label}</dt>
      <dd className="min-w-0 text-right text-[var(--ink)]">{children}</dd>
    </div>
  )
}

function CopyValue({ value }) {
  const [copied, setCopied] = useState(false)
  if (!value) return '—'
  const copy = () => navigator.clipboard?.writeText(value).then(() => {
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }).catch(() => {})
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-[12.5px] tabular">{value}</span>
      <button type="button" onClick={copy} className="rounded p-0.5 text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]" aria-label={copied ? 'Copied' : 'Copy realm ID'}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  )
}

function Meter({ label, done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-[var(--ink)]">{label}</span>
        <span className="tabular text-[var(--ink-2)]">{done} of {total}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--sunken)]" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="h-full rounded-full bg-[var(--ok)]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function Company() {
  const connection = useConnection()
  const scope = [connection?.status?.realmId, connection?.environment, connection?.ready].join(':')
  return <CompanyContent key={scope} connection={connection} />
}

function CompanyContent({ connection }) {
  const ready = connection?.ready === true
  const [health, setHealth] = useState(null)
  const [readVersion, setReadVersion] = useState(0)
  const [snapshot, setSnapshot] = useState(null)
  const [snapshotError, setSnapshotError] = useState(false)
  const [activity, setActivity] = useState(null)
  const coverage = useCoverage(ready)

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const settle = (fn) => { if (!cancelled) fn() }
    // probe=true: one cheap read-only QBO call so "verified" means QuickBooks answered.
    client.get('/company/health?probe=true').then((res) => settle(() => setHealth(res.data))).catch(() => {})
    client.get('/company/snapshot')
      .then((res) => settle(() => { setSnapshot(res.data?.counts || {}); setSnapshotError(false) }))
      .catch(() => settle(() => setSnapshotError(true)))
    client.get('/explore/timeline?limit=6')
      .then((res) => settle(() => setActivity(res.data?.entries || [])))
      .catch(() => settle(() => setActivity('error')))
    return () => { cancelled = true }
  }, [ready, readVersion])

  const status = connection?.status
  const coverageSummary = coverage.result?.summary
  const currency = companyReadiness({ ready, result: coverage.result, state: coverage.state, error: coverage.error })

  return (
    <Layout>
      <div className="mx-auto max-w-[1080px]">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ink)]">{status?.companyName || 'Company'}</h1>
        <p className="mt-1 text-[13.5px] text-[var(--ink-2)]">Maintain a realistic business, keep its records current, and verify the results.</p>

        <section className="mt-6 flex flex-wrap items-center gap-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-6 py-5">
          <StatusDot tone={currency.tone} className="size-2.5" />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[17px] font-semibold text-[var(--ink)]">
              {currency.loading && <LoaderCircle className="size-4 animate-spin text-[var(--ink-3)]" />}
              {currency.title}
            </h2>
            {currency.detail && <p className="mt-0.5 text-[13.5px] text-[var(--ink-2)]">{currency.detail}</p>}
          </div>
          <button type="button" disabled={!ready || coverage.state === 'checking'} onClick={() => { setReadVersion(v => v + 1); coverage.check({ refresh: true }) }} className={buttonVariants({ size: 'lg' })}>
            {coverage.state === 'checking' ? 'Checking…' : 'Check business activity'}
          </button>
        </section>

        {ready && coverage.result && (
          <Panel title="What still needs to be established" className="mt-5" action={<Link to="/coverage" className="text-[12.5px] font-medium text-[var(--link)]">Inspect coverage <ArrowRight className="inline size-3.5" /></Link>}>
            <div className="px-5 py-4 text-[13px] text-[var(--ink-2)]">
              <p>Activity assessed through {currency.asOf || 'an unknown date'}. A finished generation job does not prove the books are current.</p>
              {(currency.stale || currency.checkFailed || currency.incomplete) && <p role="status" className="mt-2 text-[var(--attention)]">{currency.checkFailed ? 'The latest check failed. Earlier findings are shown below.' : currency.stale ? 'These findings need refreshing.' : 'Some records could not be read completely.'}</p>}
              <ul className="mt-3 list-disc space-y-1 pl-5">
                <li>Business calendar: no verified continuous-through date.</li>
                <li>Reports and reconciliation: completeness has not been established.</li>
                <li>{currency.unanswered} coverage checks still require evidence or a successful read.</li>
              </ul>
            </div>
            {currency.gaps.length > 0 && <div className="border-t border-[var(--line)] px-5 py-4">
              <h3 className="text-[13px] font-semibold text-[var(--ink)]">Activity and setup gaps</h3>
              <ul className="mt-2 grid gap-x-6 gap-y-2 md:grid-cols-2">
                {currency.gaps.map(gap => <li key={gap.areaKey + ':' + gap.key} className="text-[13px]">
                  <span className="text-[var(--ink)]">{gap.label}</span>
                  <span className="ml-2 text-[var(--ink-3)]">{gap.last ? 'Latest ' + shortDate(gap.last) : 'Missing in the checked records'}</span>
                </li>)}
              </ul>
            </div>}
          </Panel>
        )}

        <BusinessPlan realmId={status?.realmId} environment={connection?.environment} enabled={ready} />

        <BusinessOperations realmId={status?.realmId} environment={connection?.environment} enabled={ready} />

        <BusinessBaseline realmId={status?.realmId} environment={connection?.environment} enabled={ready} />

        <BookEvidence realmId={status?.realmId} enabled={ready} />

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-3">
          <Panel title="Connection">
            <dl className="divide-y divide-[var(--line)] px-5 py-1">
              <Row label="Status">
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={ready ? 'ok' : 'attention'} />
                  {ready ? (health?.verified ? 'Verified just now' : 'Connected') : 'Needs reconnect'}
                </span>
              </Row>
              <Row label="Environment"><EnvironmentTag environment={connection?.environment} /></Row>
              <Row label="Realm ID"><CopyValue value={status?.realmId} /></Row>
              <Row label="Sign-in valid to"><span className="tabular">{shortDate(status?.refreshTokenExpiresAt)}</span></Row>
            </dl>
          </Panel>

          <Panel title="What's in the books">
            {!ready ? (
              <p className="px-5 py-4 text-[13px] text-[var(--ink-3)]">Shown once QuickBooks is connected.</p>
            ) : snapshotError ? (
              <div className="px-5 py-4 text-[13px] text-[var(--ink-2)]"><p>QuickBooks didn't return the counts.</p><button type="button" onClick={() => setReadVersion(v => v + 1)} className="mt-2 text-[var(--link)]">Retry counts</button></div>
            ) : (
              <dl className="divide-y divide-[var(--line)] px-5 py-1">
                {COUNT_ROWS.map((row) => (
                  <Row key={row.key} label={row.label}>
                    <span className="tabular font-medium">{snapshot === null ? '…' : snapshot[row.key] ?? 'n/a'}</span>
                  </Row>
                ))}
              </dl>
            )}
          </Panel>

          <Panel
            title="Coverage"
            action={<Link to="/coverage" className="text-[12.5px] font-medium text-[var(--link)] no-underline hover:underline">Open map</Link>}
          >
            {!ready ? (
              <p className="px-5 py-4 text-[13px] text-[var(--ink-3)]">Shown once QuickBooks is connected.</p>
            ) : coverage.state === 'unavailable' ? (
              <CoverageUnavailable className="px-5 py-4" />
            ) : coverageSummary ? (
              <div className="flex flex-col gap-4 px-5 py-4">
                <Meter label="Areas fully in use" done={coverageSummary.areas.covered || 0} total={coverageSummary.measuredAreas} />
                <p className="text-[12.5px] leading-relaxed text-[var(--ink-3)]">
                  {coverageSummary.gaps.assistant} gaps the assistant can fill, {coverageSummary.gaps.quickbooks} to do in QuickBooks. Read from the company's own records.
                </p>
              </div>
            ) : (
              <p className="px-5 py-4 text-[13px] text-[var(--ink-3)]">{coverage.state === 'error' ? coverage.error : 'Checking…'}</p>
            )}
          </Panel>
        </div>

        <Panel
          title="Recent lab activity"
          className="mt-5"
          action={<Link to="/audit" className="text-[12.5px] font-medium text-[var(--link)] no-underline hover:underline">Full history</Link>}
        >
          {!ready ? (
            <p className="px-5 py-4 text-[13px] text-[var(--ink-3)]">Shown once QuickBooks is connected.</p>
          ) : activity === null ? (
            <p className="px-5 py-4 text-[13px] text-[var(--ink-3)]">Loading…</p>
          ) : activity === 'error' || activity.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-[var(--ink-3)]">{activity === 'error' ? "Activity couldn't be loaded." : 'Nothing yet.'}</p>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {activity.map((entry) => (
                <li key={entry._id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
                  <span className="truncate text-[var(--ink)]">{humanizeAction(entry.action)}</span>
                  <span className="shrink-0 text-[12.5px] text-[var(--ink-3)] tabular">{shortDate(entry.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Layout>
  )
}
