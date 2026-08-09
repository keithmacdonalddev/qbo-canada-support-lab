import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import client from '../api/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

export default function Login() {
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devAccess, setDevAccess] = useState(null)

  useEffect(() => {
    let cancelled = false

    client.get('/auth/dev-access')
      .then((res) => {
        if (!cancelled && res.data.enabled) setDevAccess(res.data)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [])

  const useTesterAccount = () => {
    setIsRegister(false)
    setEmail(devAccess.email)
    setPassword(devAccess.password)
    setError('')
  }

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
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
      <Card className="w-[400px] px-5 py-6 shadow-md">
        <CardHeader>
          <div className="flex items-center gap-2.5 mb-3">
            <span className="inline-flex size-9 items-center justify-center rounded-lg bg-primary text-white text-lg font-bold">
              T
            </span>
            <span className="text-[17px] font-semibold text-[var(--text-heading)]">
              Test Data Lab
            </span>
          </div>
          <CardTitle className="text-[22px] font-semibold text-[var(--text-heading)]">
            {isRegister ? 'Create account' : 'Sign in'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 rounded-md bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
              {error}
            </div>
          )}
          {!isRegister && devAccess && (
            <div className="mb-4 rounded-lg border border-primary/20 bg-primary/[0.05] p-3.5">
              <div className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-[var(--text-heading)]">
                <KeyRound className="size-4 text-primary" aria-hidden="true" />
                Local tester account
              </div>
              <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-[13px]">
                <dt className="text-[var(--text-light)]">Email</dt>
                <dd className="font-mono text-[var(--text-heading)]">{devAccess.email}</dd>
                <dt className="text-[var(--text-light)]">Password</dt>
                <dd className="font-mono text-[var(--text-heading)]">{devAccess.password}</dd>
              </dl>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={useTesterAccount}
                className="mt-3 w-full bg-white"
              >
                Use tester account
              </Button>
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {isRegister && (
              <div className="grid gap-1.5">
                <Label htmlFor="displayName">Display name</Label>
                <Input
                  id="displayName"
                  type="text"
                  placeholder="Display name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={loading} size="lg" className="mt-1 w-full">
              {loading ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'}
            </Button>
          </form>
          <div className="mt-5 text-center text-[13px] text-[var(--text-light)]">
            {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
            <Button
              variant="link"
              onClick={() => setIsRegister(!isRegister)}
              className="h-auto p-0 text-[13px] font-medium"
            >
              {isRegister ? 'Sign in' : 'Create one'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
