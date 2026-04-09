import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect } from 'react'
import client from '../api/client'

const navItems = [
  { to: '/', label: 'Dashboard', icon: '\u25A3' },
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
    <div style={styles.shell}>
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <span style={styles.brandIcon}>Q</span>
          <span style={styles.brandText}>QBO Support Lab</span>
        </div>
        <nav style={styles.nav}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              style={({ isActive }) => ({
                ...styles.navLink,
                ...(isActive ? styles.navLinkActive : {}),
              })}
            >
              <span style={styles.navIcon}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={styles.sidebarFooter}>
          <div style={styles.userInfo}>
            <div style={styles.userEmail}>{user?.email}</div>
          </div>
          <button onClick={handleLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </aside>
      <div style={styles.mainCol}>
        <header style={styles.topbar}>
          <div style={styles.topbarLeft}>
            <span style={styles.companyName}>{companyName}</span>
          </div>
          <div style={styles.topbarRight}>
            <span
              style={{
                ...styles.statusDot,
                background: connectionStatus ? 'var(--success)' : 'var(--danger)',
              }}
            />
            <span style={styles.statusText}>
              {connectionStatus ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </header>
        <main style={styles.content}>{children}</main>
      </div>
    </div>
  )
}

const styles = {
  shell: {
    display: 'flex',
    minHeight: '100vh',
  },
  sidebar: {
    width: 240,
    minWidth: 240,
    background: 'var(--sidebar-bg)',
    color: 'var(--sidebar-text)',
    display: 'flex',
    flexDirection: 'column',
    padding: '0',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '20px 20px 24px',
  },
  brandIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'var(--primary)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 16,
  },
  brandText: {
    color: '#fff',
    fontWeight: 600,
    fontSize: 15,
  },
  nav: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '0 10px',
    flex: 1,
  },
  navLink: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 6,
    color: 'var(--sidebar-text)',
    textDecoration: 'none',
    fontSize: 14,
    transition: 'background 0.15s',
  },
  navLinkActive: {
    background: 'var(--sidebar-hover)',
    color: 'var(--sidebar-active)',
    fontWeight: 500,
  },
  navIcon: {
    fontSize: 16,
    width: 20,
    textAlign: 'center',
  },
  sidebarFooter: {
    padding: '16px 16px 20px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  userInfo: {
    marginBottom: 10,
  },
  userEmail: {
    fontSize: 13,
    color: 'var(--sidebar-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  logoutBtn: {
    background: 'rgba(255,255,255,0.06)',
    color: 'var(--sidebar-text)',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    width: '100%',
  },
  mainCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 28px',
    height: 56,
    background: 'var(--topbar-bg)',
    borderBottom: '1px solid var(--border)',
  },
  topbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  companyName: {
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text-heading)',
  },
  topbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    display: 'inline-block',
    width: 9,
    height: 9,
    borderRadius: '50%',
  },
  statusText: {
    fontSize: 13,
    color: 'var(--text-light)',
  },
  content: {
    flex: 1,
    padding: 28,
    overflowY: 'auto',
  },
}
