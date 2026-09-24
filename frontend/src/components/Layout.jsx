import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect } from 'react'
import client from '../api/client'

const navItems = [
  { to: '/', label: 'Dashboard', icon: '\u25A3' },
  { to: '/lab', label: 'Lab Tools', icon: '\u2692' },
  { to: '/ai', label: 'AI Assistant', icon: '\u2726' },
  { to: '/explorer', label: 'Entity Explorer', icon: '\u229E' },
  { to: '/checkpoints', label: 'Checkpoints', icon: '\u2299' },
  { to: '/issuepacks', label: 'Issue Packs', icon: '\u2298' },
  { to: '/audit', label: 'Audit Log', icon: '\u2637' },
  { to: '/settings', label: 'Settings', icon: '\u2699' },
]

export default function Layout({ children }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [company, setCompany] = useState(null)
  const [companyError, setCompanyError] = useState(false)

  useEffect(() => {
    const refreshStatus = () => {
      client.get('/qbo/status')
        .then((res) => { setCompany(res.data); setCompanyError(false) })
        .catch(() => setCompanyError(true))
    }
    refreshStatus()
    window.addEventListener('qbo-connection-changed', refreshStatus)
    return () => window.removeEventListener('qbo-connection-changed', refreshStatus)
  }, [])

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const connectionStatus = companyError ? 'Status unavailable'
    : !company ? 'Checking connection…'
      : company.status === 'expired' ? 'Check saved connection'
        : company.connected ? 'Saved connection' : 'No connection'
  const companyName = companyError ? 'Company status unavailable'
    : company?.companyName || (company ? 'No Company' : 'Checking company…')
  const environment = company?.environment
  const isProduction = environment === 'production'

  return (
    <div className="flex min-h-screen">
      <aside className="hidden md:flex w-60 min-w-60 bg-[var(--sidebar-bg)] text-[var(--sidebar-text)] flex-col p-0">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--primary)] text-white font-bold text-base">
            T
          </span>
          <span className="text-white font-semibold text-[15px]">Test Data Lab</span>
        </div>
        <nav className="flex flex-col gap-0.5 px-2.5 flex-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 py-2.5 px-3 rounded-md text-[var(--sidebar-text)] no-underline text-sm transition-colors duration-150 ${
                  isActive
                    ? 'bg-[var(--sidebar-hover)] text-[var(--sidebar-active)] font-medium'
                    : ''
                }`
              }
            >
              <span className="text-base w-5 text-center">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 pt-4 pb-5 border-t border-white/[0.08]">
          <div className="mb-2.5">
            <div className="text-[13px] text-[var(--sidebar-text)] overflow-hidden text-ellipsis whitespace-nowrap">
              {user?.email}
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="bg-white/[0.06] text-[var(--sidebar-text)] border-none rounded-md py-1.5 px-3.5 text-[13px] cursor-pointer w-full"
          >
            Log out
          </button>
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="md:hidden flex items-center justify-between gap-3 bg-[var(--sidebar-bg)] text-white px-4 py-3">
          <span className="font-semibold text-[15px]">Test Data Lab</span>
          <details className="relative">
            <summary className="cursor-pointer rounded-md border border-white/25 px-3 py-1.5 text-sm font-medium">Menu</summary>
            <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-white/20 bg-[var(--sidebar-bg)] p-2 shadow-xl">
              <nav className="flex flex-col gap-0.5" aria-label="Mobile navigation">
                {navItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `rounded-md px-3 py-2 text-sm text-white no-underline ${isActive ? 'bg-[var(--sidebar-hover)] font-semibold' : ''}`
                    }
                  >
                    {item.icon} {item.label}
                  </NavLink>
                ))}
              </nav>
              <div className="mt-2 border-t border-white/20 px-3 py-2 text-xs break-all text-white/75">{user?.email}</div>
              <button onClick={handleLogout} className="w-full rounded-md px-3 py-2 text-left text-sm text-white hover:bg-white/10">Log out</button>
            </div>
          </details>
        </div>
        <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 min-h-14 bg-[var(--topbar-bg)] border-b border-[var(--border)] md:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate font-semibold text-[15px] text-[var(--text-heading)]">
              {companyName}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {environment && (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                  isProduction
                    ? 'bg-gradient-to-r from-sky-700 via-violet-700 to-fuchsia-700 text-white'
                    : 'bg-[var(--border)] text-[var(--text-heading)]'
                }`}
              >
                {isProduction ? '✨ Production' : 'Sandbox'}
              </span>
            )}
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-[9px] h-[9px] rounded-full ${
                  companyError || !company ? 'bg-[var(--warning)]'
                    : company.connected ? 'bg-[var(--success)]'
                      : company.status === 'expired' ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]'
                }`}
              />
              <span className="text-[13px] text-[var(--text-light)]">
                {connectionStatus}
              </span>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 overflow-y-auto md:p-7">{children}</main>
      </div>
    </div>
  )
}
