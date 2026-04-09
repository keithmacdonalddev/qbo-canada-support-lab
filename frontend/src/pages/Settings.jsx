import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'

export default function Settings() {
  const [company, setCompany] = useState(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [message, setMessage] = useState(null)

  const fetchCompany = () => {
    client
      .get('/qbo/status')
      .then((res) => setCompany(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchCompany()
  }, [])

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect this company?')) return
    setDisconnecting(true)
    setMessage(null)
    try {
      await client.post('/qbo/disconnect')
      setMessage({ type: 'success', text: 'Company disconnected successfully.' })
      setCompany(null)
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Disconnect failed' })
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <Layout>
      <div style={styles.page}>
        <h1 style={styles.title}>Settings</h1>

        {message && (
          <div
            style={{
              ...styles.alert,
              background: message.type === 'success' ? 'var(--success-light)' : 'var(--danger-light)',
              color: message.type === 'success' ? 'var(--success)' : 'var(--danger)',
            }}
          >
            {message.text}
          </div>
        )}

        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>QBO Connection</h2>
          {loading ? (
            <p style={styles.muted}>Loading...</p>
          ) : !company?.connected ? (
            <div style={styles.card}>
              <p style={styles.muted}>No company connected.</p>
              <a href="/onboarding" style={styles.link}>Set up a connection</a>
            </div>
          ) : (
            <div style={styles.card}>
              <div style={styles.row}>
                <span style={styles.label}>Company Name</span>
                <span style={styles.value}>{company.companyName || 'N/A'}</span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>Realm ID</span>
                <span style={{ ...styles.value, fontFamily: 'var(--mono)', fontSize: 13 }}>
                  {company.realmId || 'N/A'}
                </span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>Status</span>
                <span style={styles.value}>
                  <span
                    style={{
                      ...styles.dot,
                      background: company.connected ? 'var(--success)' : 'var(--danger)',
                    }}
                  />
                  {company.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>Token Expires</span>
                <span style={styles.value}>
                  {company.tokenExpiresAt
                    ? new Date(company.tokenExpiresAt).toLocaleString()
                    : 'N/A'}
                </span>
              </div>
              <div style={styles.row}>
                <span style={styles.label}>Last Refreshed</span>
                <span style={styles.value}>
                  {company.lastRefreshedAt
                    ? new Date(company.lastRefreshedAt).toLocaleString()
                    : 'N/A'}
                </span>
              </div>
              <div style={styles.actions}>
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  style={styles.disconnectBtn}
                >
                  {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}

const styles = {
  page: {},
  title: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text-heading)',
    marginBottom: 24,
  },
  alert: {
    padding: '10px 14px',
    borderRadius: 'var(--radius)',
    marginBottom: 16,
    fontSize: 13,
    fontWeight: 500,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-heading)',
    marginBottom: 12,
  },
  card: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '20px 24px',
    maxWidth: 560,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 0',
    borderBottom: '1px solid var(--border-light)',
  },
  label: {
    fontSize: 13,
    color: 'var(--text-light)',
  },
  value: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-heading)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    display: 'inline-block',
    width: 9,
    height: 9,
    borderRadius: '50%',
  },
  muted: {
    color: 'var(--text-light)',
    marginBottom: 8,
  },
  link: {
    color: 'var(--primary)',
    fontWeight: 500,
    fontSize: 13,
  },
  actions: {
    paddingTop: 16,
  },
  disconnectBtn: {
    background: 'var(--danger-light)',
    color: 'var(--danger)',
    fontWeight: 500,
    padding: '8px 20px',
  },
}
