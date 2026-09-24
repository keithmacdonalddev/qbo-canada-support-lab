import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import client from '../api/client'
import { Button } from '@/components/ui/button'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('token'))
  const [loading, setLoading] = useState(!!token)
  const [sessionError, setSessionError] = useState('')
  const [sessionAttempt, setSessionAttempt] = useState(0)

  const isAuthenticated = !!token && !!user

  useEffect(() => {
    if (!token) return
    let cancelled = false
    client
      .get('/auth/me')
      .then((res) => {
        if (!cancelled) setUser(res.data.user)
      })
      .catch((error) => {
        if (!cancelled) {
          if (error.response?.status === 401) {
            localStorage.removeItem('token')
            setToken(null)
            setUser(null)
          } else {
            setSessionError('The app could not check your sign-in because the server is unavailable. Your sign-in has been kept.')
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [token, sessionAttempt])

  const login = useCallback(async (email, password) => {
    const res = await client.post('/auth/login', { email, password })
    const { token: newToken, user: newUser } = res.data
    localStorage.setItem('token', newToken)
    setToken(newToken)
    setUser(newUser)
    return newUser
  }, [])

  const register = useCallback(async (email, password, displayName) => {
    const res = await client.post('/auth/register', { email, password, displayName })
    const { token: newToken, user: newUser } = res.data
    localStorage.setItem('token', newToken)
    setToken(newToken)
    setUser(newUser)
    return newUser
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
  }, [])

  const retrySession = () => {
    setSessionError('')
    setLoading(true)
    setSessionAttempt((attempt) => attempt + 1)
  }

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#8a8a9a' }}>Loading...</div>
  }

  if (sessionError) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div role="alert" className="max-w-md rounded-lg border border-[var(--border)] bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-[var(--text-heading)]">Sign-in check unavailable</h1>
          <p className="mt-2 mb-4 text-sm text-[var(--text-light)]">{sessionError}</p>
          <Button onClick={retrySession}>Try again</Button>
        </div>
      </main>
    )
  }

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
