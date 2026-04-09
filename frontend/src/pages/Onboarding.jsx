import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import client from '../api/client'

const STEPS = ['Connect QBO', 'Company Info', 'Assess', 'Readiness', 'Begin']

export default function Onboarding() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [company, setCompany] = useState(null)
  const [assessment, setAssessment] = useState(null)

  // Check if already connected on mount
  useEffect(() => {
    client.get('/qbo/status').then((res) => {
      if (res.data.connected) {
        setCompany(res.data)
        setStep(1)
      }
    }).catch(() => {})
  }, [])

  const handleConnect = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await client.get('/qbo/connect')
      const { authUri } = res.data
      const popup = window.open(authUri, 'qbo_connect', 'width=600,height=700')

      // Listen for postMessage from callback popup
      const onMessage = async (event) => {
        if (event.data?.type === 'qbo_connected') {
          window.removeEventListener('message', onMessage)
          clearInterval(interval)
          const statusRes = await client.get('/qbo/status')
          if (statusRes.data.connected) {
            setCompany(statusRes.data)
            setStep(1)
          }
          setLoading(false)
        } else if (event.data?.type === 'qbo_error') {
          window.removeEventListener('message', onMessage)
          clearInterval(interval)
          setError(event.data.error || 'Connection failed')
          setLoading(false)
        }
      }
      window.addEventListener('message', onMessage)

      // Fallback: poll for popup close
      const interval = setInterval(async () => {
        try {
          if (popup?.closed) {
            clearInterval(interval)
            window.removeEventListener('message', onMessage)
            const statusRes = await client.get('/qbo/status')
            if (statusRes.data.connected) {
              setCompany(statusRes.data)
              setStep(1)
            }
            setLoading(false)
          }
        } catch {
          clearInterval(interval)
          setLoading(false)
        }
      }, 1000)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start connection')
      setLoading(false)
    }
  }

  const handleAssess = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await client.post('/company/assess')
      const profile = res.data.profile
      setAssessment({
        status: 'ready',
        summary: `${profile.companyName} — ${profile.subscriptionTier}`,
        items: [
          ...profile.enabledFeatures.map(f => ({ label: f.replace(/_/g, ' '), ok: true })),
          ...profile.knownLimitations.map(l => ({ label: l.replace(/_/g, ' '), ok: false })),
        ],
      })
      setStep(3)
    } catch (err) {
      setError(err.response?.data?.error || 'Assessment failed')
    } finally {
      setLoading(false)
    }
  }

  const handleBegin = () => {
    navigate('/')
  }

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <div style={styles.stepContent}>
            <h2 style={styles.stepTitle}>Connect to QuickBooks Online</h2>
            <p style={styles.stepDesc}>
              Link your QBO sandbox account to get started. A new window will open to authorize the
              connection.
            </p>
            <button onClick={handleConnect} disabled={loading} style={styles.primaryBtn}>
              {loading ? 'Connecting...' : 'Connect QBO'}
            </button>
          </div>
        )
      case 1:
        return (
          <div style={styles.stepContent}>
            <h2 style={styles.stepTitle}>Company Connected</h2>
            <div style={styles.infoGrid}>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Name</span>
                <span style={styles.infoValue}>{company?.companyName || 'Sandbox Company'}</span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Realm ID</span>
                <span style={styles.infoValue}>{company?.realmId || 'N/A'}</span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Status</span>
                <span style={styles.infoValue}>{company?.status || 'active'}</span>
              </div>
            </div>
            <button onClick={() => setStep(2)} style={styles.primaryBtn}>
              Next
            </button>
          </div>
        )
      case 2:
        return (
          <div style={styles.stepContent}>
            <h2 style={styles.stepTitle}>Assess Company Readiness</h2>
            <p style={styles.stepDesc}>
              We will analyze the connected QBO company to determine setup readiness and identify any
              existing configuration.
            </p>
            <button onClick={handleAssess} disabled={loading} style={styles.primaryBtn}>
              {loading ? 'Assessing...' : 'Assess Company'}
            </button>
          </div>
        )
      case 3:
        return (
          <div style={styles.stepContent}>
            <h2 style={styles.stepTitle}>Readiness Summary</h2>
            {assessment && (
              <div style={styles.summaryCard}>
                <div style={styles.infoRow}>
                  <span style={styles.infoLabel}>Status</span>
                  <span
                    style={{
                      ...styles.badge,
                      background:
                        assessment.status === 'ready'
                          ? 'var(--success-light)'
                          : 'var(--warning)',
                      color:
                        assessment.status === 'ready'
                          ? 'var(--success)'
                          : '#fff',
                    }}
                  >
                    {assessment.status || 'Complete'}
                  </span>
                </div>
                {assessment.summary && (
                  <p style={styles.stepDesc}>{assessment.summary}</p>
                )}
                {assessment.items && (
                  <ul style={styles.itemList}>
                    {assessment.items.map((item, i) => (
                      <li key={i} style={styles.item}>
                        <span style={{
                          ...styles.itemDot,
                          background: item.ok ? 'var(--success)' : 'var(--warning)',
                        }} />
                        {item.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <button onClick={() => setStep(4)} style={styles.primaryBtn}>
              Next
            </button>
          </div>
        )
      case 4:
        return (
          <div style={styles.stepContent}>
            <h2 style={styles.stepTitle}>Ready to Go</h2>
            <p style={styles.stepDesc}>
              Setup is complete. Click below to head to your dashboard and start working.
            </p>
            <button onClick={handleBegin} style={styles.primaryBtn}>
              Begin Setup
            </button>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <Layout>
      <div style={styles.page}>
        <h1 style={styles.title}>Onboarding</h1>

        <div style={styles.stepper}>
          {STEPS.map((label, i) => (
            <div key={i} style={styles.stepItem}>
              <div
                style={{
                  ...styles.stepCircle,
                  background: i <= step ? 'var(--primary)' : 'var(--border)',
                  color: i <= step ? '#fff' : 'var(--text-light)',
                }}
              >
                {i < step ? '\u2713' : i + 1}
              </div>
              <span
                style={{
                  ...styles.stepLabel,
                  color: i <= step ? 'var(--text-heading)' : 'var(--text-light)',
                  fontWeight: i === step ? 600 : 400,
                }}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && <div style={styles.stepLine} />}
            </div>
          ))}
        </div>

        {error && <div style={styles.error}>{error}</div>}
        {renderStep()}
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
  stepper: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: 32,
    gap: 0,
  },
  stepItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  stepCircle: {
    width: 30,
    height: 30,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 600,
    flexShrink: 0,
  },
  stepLabel: {
    fontSize: 13,
    whiteSpace: 'nowrap',
  },
  stepLine: {
    width: 40,
    height: 2,
    background: 'var(--border)',
    margin: '0 8px',
  },
  stepContent: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '32px',
    maxWidth: 560,
  },
  stepTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text-heading)',
    marginBottom: 10,
  },
  stepDesc: {
    color: 'var(--text-light)',
    marginBottom: 20,
    lineHeight: 1.6,
  },
  primaryBtn: {
    background: 'var(--primary)',
    color: '#fff',
    padding: '10px 24px',
    fontWeight: 500,
  },
  error: {
    background: 'var(--danger-light)',
    color: 'var(--danger)',
    padding: '10px 14px',
    borderRadius: 'var(--radius)',
    marginBottom: 16,
    fontSize: 13,
    maxWidth: 560,
  },
  infoGrid: {
    marginBottom: 20,
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: '1px solid var(--border-light)',
  },
  infoLabel: {
    color: 'var(--text-light)',
    fontSize: 13,
  },
  infoValue: {
    fontWeight: 500,
    color: 'var(--text-heading)',
    fontSize: 13,
  },
  summaryCard: {
    marginBottom: 20,
  },
  badge: {
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
  },
  itemList: {
    listStyle: 'none',
    padding: 0,
    marginTop: 12,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 0',
    fontSize: 13,
  },
  itemDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
}
