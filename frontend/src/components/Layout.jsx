import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import {
  WandSparkles, Building2, Table2, History, Settings, LogOut, LoaderCircle, RefreshCw, ChevronDown, LayoutGrid,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useConnection } from '../context/ConnectionContext'
import { Button, buttonVariants } from '@/components/ui/button'
import { StatusDot, EnvironmentTag, connectionSummary } from '@/components/ui/status'
import { cn } from '@/lib/utils'

// The app exists to do one thing well: turn a customer's description of a
// problem into that same situation in the QuickBooks company. Everything else
// supports that job: Coverage shows what the company is missing, then where
// its data lives and what the lab did.
const NAV = [
  { to: '/', label: 'Reproduce', icon: WandSparkles, match: (p) => p === '/' || p.startsWith('/cases') },
  { to: '/coverage', label: 'Coverage', icon: LayoutGrid, match: (p) => p.startsWith('/coverage') },
  { to: '/company', label: 'Company', icon: Building2, match: (p) => p.startsWith('/company') || p.startsWith('/lab') },
  { to: '/explorer', label: 'Records', icon: Table2, match: (p) => p.startsWith('/explorer') },
  { to: '/audit', label: 'History', icon: History, match: (p) => p.startsWith('/audit') },
]

const LEGACY_NAV = [
  { to: '/ai', label: 'Old AI console' },
  { to: '/issuepacks', label: 'Issue packs' },
  { to: '/checkpoints', label: 'Checkpoints' },
]

function NavItem({ item, active }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] no-underline transition-colors duration-100 focus-visible:outline-offset-[-2px]',
        active
          ? 'bg-[var(--surface)] font-medium text-[var(--ink)] shadow-[0_0_0_1px_var(--line)]'
          : 'text-[var(--ink-2)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]',
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
      {item.label}
    </Link>
  )
}

// Shown on every page while QuickBooks is unusable, with the fix in place.
function ConnectionBar() {
  const connection = useConnection()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  if (!connection || ['loading', 'connected'].includes(connection.state)) return null

  const trySaved = async () => {
    setBusy(true)
    setResult(null)
    setResult(await connection.trySavedConnection())
    setBusy(false)
  }

  const reconnect = (
    <Link to="/onboarding" className={cn(buttonVariants({ variant: result?.rejected ? 'default' : 'outline', size: 'sm' }), 'no-underline')}>
      Reconnect
    </Link>
  )

  let message
  let actions
  if (connection.state === 'unavailable') {
    message = 'The lab server is not responding, so nothing can be read or changed.'
    actions = <Button size="sm" variant="outline" onClick={connection.refresh}><RefreshCw /> Check again</Button>
  } else if (connection.state === 'none') {
    message = 'No QuickBooks company is connected yet.'
    actions = <Link to="/onboarding" className={cn(buttonVariants({ size: 'sm' }), 'no-underline')}>Connect company</Link>
  } else if (result?.rejected) {
    message = 'QuickBooks rejected the saved sign-in. Reconnect to continue.'
    actions = reconnect
  } else {
    message = 'QuickBooks is disconnected. Nothing can be reproduced, read or changed until it is fixed.'
    actions = (
      <>
        <Button size="sm" onClick={trySaved} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          {busy ? 'Checking…' : 'Try saved connection'}
        </Button>
        {reconnect}
      </>
    )
  }

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#f0dcb4] bg-[var(--attention-soft)] px-5 py-2.5 md:px-8">
      <StatusDot tone="attention" />
      <p className="min-w-0 flex-1 text-[13px] text-[var(--ink)]">
        {message}
        {result && !result.rejected && <span className="text-[var(--danger-ink)]"> {result.message}</span>}
        {result?.intuitTid && <span className="text-[var(--ink-3)]"> Intuit reference: {result.intuitTid}</span>}
      </p>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  )
}

export default function Layout({ children }) {
  const { user, logout } = useAuth()
  const connection = useConnection()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const summary = connectionSummary(connection?.status, connection?.state === 'unavailable')
  const companyName = connection?.state === 'unavailable' ? 'Company unavailable'
    : connection?.companyName || (connection?.status ? 'No company connected' : 'Loading company…')

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((item) => <NavItem key={item.to} item={item} active={item.match(pathname)} />)}
    </nav>
  )

  const footer = (
    <div className="flex flex-col gap-0.5 border-t border-[var(--line)] pt-3">
      <NavItem item={{ to: '/settings', label: 'Settings', icon: Settings }} active={pathname.startsWith('/settings')} />
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink-2)]">
          <ChevronDown className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" aria-hidden="true" />
          Legacy tools
        </summary>
        <div className="flex flex-col gap-0.5 pl-6">
          {LEGACY_NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="rounded-md px-2.5 py-1.5 text-[12.5px] text-[var(--ink-3)] no-underline hover:bg-[var(--sunken)] hover:text-[var(--ink)]">
              {item.label}
            </NavLink>
          ))}
        </div>
      </details>
      <div className="mt-2 flex items-center gap-2 px-2.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-3)]" title={user?.email}>{user?.email}</span>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-md p-1.5 text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]"
          aria-label="Log out"
          title="Log out"
        >
          <LogOut className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex min-h-screen bg-[var(--canvas)]">
      {connection?.isProduction && (
        <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-[3px] bg-[var(--production)]" />
      )}
      <aside className="sticky top-0 hidden h-screen w-[220px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--canvas)] px-3 pb-3 pt-4 md:flex">
        <Link to="/" className="mb-6 flex items-center gap-2.5 px-2.5 no-underline">
          <span aria-hidden="true" className="grid size-6 place-items-center rounded-[6px] bg-[var(--ink)] text-[11px] font-semibold tracking-tight text-white">
            TD
          </span>
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--ink)]">Test Data Lab</span>
        </Link>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {footer}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--canvas)] px-4 py-3 md:hidden">
          <span className="text-[14px] font-semibold text-[var(--ink)]">Test Data Lab</span>
          <details className="relative">
            <summary className="cursor-pointer rounded-md border border-[var(--line-strong)] px-3 py-1.5 text-sm font-medium">Menu</summary>
            <div className="absolute right-0 top-full z-50 mt-2 w-60 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-md)]">
              {nav}
              <div className="mt-3">{footer}</div>
            </div>
          </details>
        </div>

        {/* Scope strip: which company a change will land in, always visible. */}
        <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--canvas)]">
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2 md:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate text-[13.5px] font-medium text-[var(--ink)]" title={companyName}>{companyName}</span>
              <EnvironmentTag environment={connection?.environment} />
            </div>
            <Link
              to="/company"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-[var(--ink-2)] no-underline hover:bg-[var(--sunken)] hover:text-[var(--ink)]"
            >
              <StatusDot tone={summary.tone} />
              {summary.label}
            </Link>
          </div>
          <ConnectionBar />
        </header>

        <main className="min-w-0 flex-1 px-5 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  )
}
