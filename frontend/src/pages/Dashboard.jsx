import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'

export default function Dashboard() {
  const [company, setCompany] = useState(null)
  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState(null)
  const [seedProgress, setSeedProgress] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    client
      .get('/company/health')
      .then((res) => setCompany(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Poll for seeding progress while active
  useEffect(() => {
    if (!seeding) return
    const interval = setInterval(async () => {
      try {
        const res = await client.get('/seed/status')
        const run = res.data.seedRun
        if (run?.progress) setSeedProgress(run.progress)
        if (run?.status === 'completed' || run?.status === 'failed') {
          setSeeding(false)
          setSeedProgress(null)
          // Build result message
          const created = run.entitiesCreated || {}
          const skipped = run.entitiesSkipped || {}
          const errors = run.seedErrors?.length || 0
          const createdParts = []
          if (created.customers) createdParts.push(`${created.customers} customers`)
          if (created.vendors) createdParts.push(`${created.vendors} vendors`)
          if (created.items) createdParts.push(`${created.items} items`)
          const totalSkipped = (skipped.customers || 0) + (skipped.vendors || 0) + (skipped.items || 0)
          const parts = []
          if (createdParts.length) parts.push(`Created ${createdParts.join(', ')}`)
          if (totalSkipped) parts.push(`${totalSkipped} already existed`)
          if (errors) parts.push(`${errors} errors`)
          setSeedResult({
            success: run.status === 'completed',
            message: parts.length ? parts.join(' · ') : (run.status === 'failed' ? 'Seeding failed' : 'Done'),
          })
          fetchHealth()
        }
      } catch (_) {}
    }, 2000)
    return () => clearInterval(interval)
  }, [seeding])

  const fetchHealth = () => {
    client
      .get('/company/health')
      .then((res) => setCompany(res.data))
      .catch(() => {})
  }

  const handleSeed = async () => {
    setSeeding(true)
    setSeedResult(null)
    setSeedProgress(null)
    try {
      await client.post('/seed/start')
      // Polling useEffect takes over from here
    } catch (err) {
      setSeedResult({ success: false, message: err.response?.data?.error || 'Seeding failed' })
      setSeeding(false)
    }
  }

  return (
    <Layout>
      <div style={styles.page}>
        <h1 style={styles.title}>Dashboard</h1>

        {loading ? (
          <p style={styles.loading}>Loading company data...</p>
        ) : !company ? (
          <div style={styles.card}>
            <p style={styles.emptyText}>No company connected yet.</p>
            <a href="/onboarding" style={styles.link}>
              Go to Onboarding
            </a>
          </div>
        ) : (
          <>
            <div style={styles.grid}>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Company</div>
                <div style={styles.cardValue}>{company.companyName || 'N/A'}</div>
              </div>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Connection</div>
                <div style={styles.cardValue}>
                  <span
                    style={{
                      ...styles.dot,
                      background: company.connectionStatus === 'active' ? 'var(--success)' : 'var(--danger)',
                    }}
                  />
                  {company.connectionStatus === 'active' ? 'Connected' : company.connectionStatus}
                </div>
              </div>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Seeding Status</div>
                <div style={styles.cardValue}>{company.seedingStatus || 'Not started'}</div>
              </div>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Freshness</div>
                <div style={styles.cardValue}>
                  {company.freshnessScore != null
                    ? `${company.freshnessScore}%`
                    : 'N/A'}
                </div>
              </div>
            </div>

            <div style={styles.actionBar}>
              <button onClick={handleSeed} disabled={seeding} style={styles.seedBtn}>
                {seeding ? 'Seeding...' : 'Seed Company'}
              </button>
              {seeding && seedProgress && (
                <span style={styles.progressBadge}>
                  {seedProgress.detail}
                </span>
              )}
              {!seeding && seedResult && (
                <span
                  style={{
                    ...styles.resultBadge,
                    background: seedResult.success ? 'var(--success-light)' : 'var(--danger-light)',
                    color: seedResult.success ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {seedResult.message}
                </span>
              )}
            </div>
          </>
        )}
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
  loading: {
    color: 'var(--text-light)',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 16,
    marginBottom: 24,
  },
  card: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '20px 22px',
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-light)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  cardValue: {
    fontSize: 16,
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
  emptyText: {
    color: 'var(--text-light)',
    marginBottom: 12,
  },
  link: {
    color: 'var(--primary)',
    fontWeight: 500,
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  seedBtn: {
    background: 'var(--primary)',
    color: '#fff',
    padding: '10px 24px',
    fontWeight: 500,
  },
  resultBadge: {
    padding: '8px 14px',
    borderRadius: 'var(--radius)',
    fontSize: 13,
    fontWeight: 500,
  },
  progressBadge: {
    padding: '8px 14px',
    borderRadius: 'var(--radius)',
    fontSize: 13,
    fontWeight: 500,
    background: 'var(--primary-light, #e8f0fe)',
    color: 'var(--primary)',
  },
}
