import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import '../styles/sidebar.css'
import {
  WandSparkles, Building2, Table2, History, Settings, LogOut, LoaderCircle, RefreshCw, ChevronDown, LayoutGrid, PanelLeftClose, PanelLeftOpen, Bot, Layers, Archive,
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
  { to: '/ai', label: 'Old AI console', icon: Bot },
  { to: '/issuepacks', label: 'Issue packs', icon: Layers },
  { to: '/checkpoints', label: 'Checkpoints', icon: Archive },
]

const SIDEBAR_PREFERENCE = 'tdl.sidebar.collapsed'

function readSidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_PREFERENCE) === 'true'
  } catch {
    return false
  }
}

// Portal-based hints stay readable outside the narrow, scrollable icon rail.
function SidebarHint({ label, enabled = true, children }) {
  return (
    <Tooltip.Root disabled={!enabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" sideOffset={10} className="z-[60]">
          <Tooltip.Popup className="sidebar-tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function NavItem({ item, active, collapsed = false }) {
  const Icon = item.icon
  return (
    <SidebarHint label={item.label} enabled={collapsed}>
      <Link
        to={item.to}
        aria-label={item.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'sidebar-item flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] no-underline focus-visible:outline-offset-[-2px]',
          active
            ? 'bg-[var(--surface)] font-medium text-[var(--ink)] shadow-[0_0_0_1px_var(--line)]'
            : 'text-[var(--ink-2)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]',
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />}
        <span className="sidebar-label" aria-hidden={collapsed || undefined}>{item.label}</span>
      </Link>
    </SidebarHint>
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
  const [collapsed, setCollapsed] = useState(readSidebarPreference)

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_PREFERENCE, String(collapsed))
    } catch {
      // Storage can be unavailable; the control still works for this page.
    }
  }, [collapsed])

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const summary = connectionSummary(connection?.status, connection?.state === 'unavailable')
  const companyName = connection?.state === 'unavailable' ? 'Company unavailable'
    : connection?.companyName || (connection?.status ? 'No company connected' : 'Loading company…')

  const nav = (compact = false) => (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((item) => <NavItem key={item.to} item={item} active={item.match(pathname)} collapsed={compact} />)}
    </nav>
  )

  const footer = (compact = false) => (
    <div className="sidebar-footer flex shrink-0 flex-col gap-0.5 border-t border-[var(--line)] pt-3">
      <NavItem item={{ to: '/settings', label: 'Settings', icon: Settings }} active={pathname.startsWith('/settings')} collapsed={compact} />
      <details className="group">
        <SidebarHint label="Legacy tools" enabled={compact}>
          <summary aria-label="Legacy tools" className="sidebar-item flex cursor-pointer list-none items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink-2)] focus-visible:outline-offset-[-2px]">
            <ChevronDown className="sidebar-disclosure size-4 shrink-0 -rotate-90 group-open:rotate-0" aria-hidden="true" />
            <span className="sidebar-label" aria-hidden={compact || undefined}>Legacy tools</span>
          </summary>
        </SidebarHint>
        <div className="sidebar-legacy flex flex-col gap-0.5 pl-6">
          {LEGACY_NAV.map((item) => (
            <NavItem key={item.to} item={item} active={pathname.startsWith(item.to)} collapsed={compact} />
          ))}
        </div>
      </details>
      <div className="sidebar-account mt-2 flex min-h-9 items-center gap-2 px-2.5">
        <span className="sidebar-label min-w-0 flex-1 truncate text-[12px] text-[var(--ink-3)]" title={user?.email} aria-hidden={compact || undefined}>{user?.email}</span>
        <SidebarHint label="Log out">
          <button
            type="button"
            onClick={handleLogout}
            className="sidebar-logout grid size-9 shrink-0 place-items-center rounded-md text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)] focus-visible:outline-offset-[-2px]"
            aria-label="Log out"
          >
            <LogOut className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </SidebarHint>
      </div>
    </div>
  )

  return (
    <Tooltip.Provider delay={350}>
      <div className="flex min-h-screen bg-[var(--canvas)]">
        {connection?.isProduction && (
          <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-[3px] bg-[var(--production)]" />
        )}
        <aside
          id="desktop-sidebar"
          aria-label="Sidebar"
          data-collapsed={collapsed}
          className="app-sidebar sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--line)] bg-[var(--canvas)] px-3 pb-3 pt-4 md:flex"
        >
          <SidebarHint label="Test Data Lab home" enabled={collapsed}>
            <Link to="/" aria-label="Test Data Lab home" className="sidebar-brand mb-3 flex min-h-8 items-center gap-2.5 px-1.5 no-underline">
              <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-[6px] bg-[var(--ink)] text-[11px] font-semibold tracking-tight text-white">
                TD
              </span>
              <span className="sidebar-label text-[14px] font-semibold tracking-[-0.01em] text-[var(--ink)]" aria-hidden={collapsed || undefined}>Test Data Lab</span>
            </Link>
          </SidebarHint>
          <SidebarHint label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              aria-controls="desktop-sidebar"
              className="sidebar-item sidebar-toggle mb-3 flex shrink-0 items-center gap-2.5 rounded-md px-2.5 text-[12px] text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)] focus-visible:outline-offset-[-2px]"
            >
              <span className="sidebar-toggle-icon relative size-4 shrink-0" aria-hidden="true">
                <PanelLeftClose className="sidebar-close-icon absolute inset-0 size-4" strokeWidth={1.75} />
                <PanelLeftOpen className="sidebar-open-icon absolute inset-0 size-4" strokeWidth={1.75} />
              </span>
              <span className="sidebar-label" aria-hidden={collapsed || undefined}>Collapse sidebar</span>
            </button>
          </SidebarHint>
          <div className="sidebar-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{nav(collapsed)}</div>
          {footer(collapsed)}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--canvas)] px-4 py-3 md:hidden">
            <span className="text-[14px] font-semibold text-[var(--ink)]">Test Data Lab</span>
            <details className="relative">
              <summary className="cursor-pointer rounded-md border border-[var(--line-strong)] px-3 py-1.5 text-sm font-medium">Menu</summary>
              <div className="absolute right-0 top-full z-50 mt-2 w-60 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-md)]">
                {nav()}
                <div className="mt-3">{footer()}</div>
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
    </Tooltip.Provider>
  )
}
