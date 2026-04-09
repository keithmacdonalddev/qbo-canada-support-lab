import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (isRegister) {
        await register(email, password, displayName)
      } else {
        await login(email, password)
      }
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error || 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <div style={styles.brand}>
          <span style={styles.brandIcon}>Q</span>
          <span style={styles.brandTitle}>QBO Support Lab</span>
        </div>
        <h1 style={styles.heading}>{isRegister ? 'Create account' : 'Sign in'}</h1>
        {error && <div style={styles.error}>{error}</div>}
        <form onSubmit={handleSubmit} style={styles.form}>
          {isRegister && (
            <input
              type="text"
              placeholder="Display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={styles.input}
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={styles.input}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={styles.input}
          />
          <button type="submit" disabled={loading} style={styles.submitBtn}>
            {loading ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <div style={styles.toggle}>
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button onClick={() => setIsRegister(!isRegister)} style={styles.toggleBtn}>
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--bg)',
  },
  card: {
    width: 400,
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border)',
    padding: '40px 36px',
    boxShadow: 'var(--shadow-md)',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 28,
  },
  brandIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: 8,
    background: 'var(--primary)',
    color: '#fff',
    fontWeight: 700,
    fontSize: 18,
  },
  brandTitle: {
    fontWeight: 600,
    fontSize: 17,
    color: 'var(--text-heading)',
  },
  heading: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text-heading)',
    marginBottom: 20,
  },
  error: {
    background: 'var(--danger-light)',
    color: 'var(--danger)',
    padding: '10px 14px',
    borderRadius: 'var(--radius)',
    marginBottom: 16,
    fontSize: 13,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  input: {
    width: '100%',
  },
  submitBtn: {
    background: 'var(--primary)',
    color: '#fff',
    padding: '10px 0',
    fontWeight: 500,
    fontSize: 14,
    marginTop: 4,
  },
  toggle: {
    marginTop: 20,
    fontSize: 13,
    color: 'var(--text-light)',
    textAlign: 'center',
  },
  toggleBtn: {
    background: 'none',
    color: 'var(--primary)',
    padding: 0,
    fontWeight: 500,
    fontSize: 13,
  },
}
