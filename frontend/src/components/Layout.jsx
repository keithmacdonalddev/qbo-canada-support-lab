import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect } from 'react'
import client from '../api/client'

const navItems = [
  { to: '/', label: 'Dashboard', icon: '\u25A3' },
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

  useEffect(() => {
    client
      .get('/qbo/status')
      .then((res) => setCompany(res.data))
      .catch(() => {})
  }, [])

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const connectionStatus = company?.connected
  const companyName = company?.companyName || 'No Company'

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 min-w-60 bg-[var(--sidebar-bg)] text-[var(--sidebar-text)] flex flex-col p-0">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--primary)] text-white font-bold text-base">
            Q
          </span>
          <span className="text-white font-semibold text-[15px]">QBO Support Lab</span>
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
        <header className="flex items-center justify-between px-7 h-14 bg-[var(--topbar-bg)] border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-[15px] text-[var(--text-heading)]">
              {companyName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-[9px] h-[9px] rounded-full ${
                connectionStatus ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'
              }`}
            />
            <span className="text-[13px] text-[var(--text-light)]">
              {connectionStatus ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </header>
        <main className="flex-1 p-7 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
