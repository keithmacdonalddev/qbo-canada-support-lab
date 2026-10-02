/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import client from '../api/client'
import { useAuth } from './AuthContext'

// One shared answer to "is QuickBooks usable right now?" so every page shows
// the same state and the same fix, instead of each page failing on its own.
const ConnectionContext = createContext(null)

export function ConnectionProvider({ children }) {
  const { isAuthenticated } = useAuth()
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    client.get('/qbo/status')
      .then((res) => { if (!cancelled) { setStatus(res.data); setError(null) } })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'The lab server did not answer.') })
    return () => { cancelled = true }
  }, [isAuthenticated, version])

  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1)
    window.addEventListener('qbo-connection-changed', onChange)
    return () => window.removeEventListener('qbo-connection-changed', onChange)
  }, [])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  // Re-try the saved QuickBooks authorization. Resolves to null on success or
  // { rejected, message, intuitTid } so callers can show the right next step.
  const trySavedConnection = useCallback(async () => {
    try {
      await client.post('/qbo/refresh')
      window.dispatchEvent(new Event('qbo-connection-changed'))
      return null
    } catch (err) {
      const failure = err.response?.data
      setVersion((v) => v + 1)
      return {
        rejected: failure?.code === 'QBO_RECONNECT_REQUIRED',
        message: failure?.error || 'The saved connection could not be checked. See the local API log.',
        intuitTid: failure?.intuit_tid || null,
      }
    }
  }, [])

  const state = error ? 'unavailable'
    : !status ? 'loading'
      : status.connected ? 'connected'
        : status.status === 'expired' ? 'expired'
          : status.status === 'none' ? 'none'
            : 'disconnected'

  return (
    <ConnectionContext.Provider value={{
      status,
      error,
      state,
      ready: state === 'connected',
      environment: status?.environment || null,
      isProduction: status?.environment === 'production',
      companyName: status?.companyName || null,
      refresh,
      trySavedConnection,
    }}
    >
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  return useContext(ConnectionContext)
}
