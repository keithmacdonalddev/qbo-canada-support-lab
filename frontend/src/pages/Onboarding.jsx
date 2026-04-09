import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import client from '../api/client'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

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
          <Card className="max-w-[560px]">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-[var(--text-heading)]">
                Connect to QuickBooks Online
              </CardTitle>
              <CardDescription className="leading-relaxed">
                Link your QBO sandbox account to get started. A new window will open to authorize the
                connection.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleConnect} disabled={loading} size="lg">
                {loading ? 'Connecting...' : 'Connect QBO'}
              </Button>
            </CardContent>
          </Card>
        )
      case 1:
        return (
          <Card className="max-w-[560px]">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-[var(--text-heading)]">
                Company Connected
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-0">
              <div className="mb-5">
                <div className="flex justify-between py-2 border-b border-[var(--border)]">
                  <span className="text-[13px] text-[var(--text-light)]">Name</span>
                  <span className="text-[13px] font-medium text-[var(--text-heading)]">{company?.companyName || 'Sandbox Company'}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-[var(--border)]">
                  <span className="text-[13px] text-[var(--text-light)]">Realm ID</span>
                  <span className="text-[13px] font-medium text-[var(--text-heading)]">{company?.realmId || 'N/A'}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-[var(--border)]">
                  <span className="text-[13px] text-[var(--text-light)]">Status</span>
                  <span className="text-[13px] font-medium text-[var(--text-heading)]">{company?.status || 'active'}</span>
                </div>
              </div>
              <Button onClick={() => setStep(2)} size="lg">
                Next
              </Button>
            </CardContent>
          </Card>
        )
      case 2:
        return (
          <Card className="max-w-[560px]">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-[var(--text-heading)]">
                Assess Company Readiness
              </CardTitle>
              <CardDescription className="leading-relaxed">
                We will analyze the connected QBO company to determine setup readiness and identify any
                existing configuration.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleAssess} disabled={loading} size="lg">
                {loading ? 'Assessing...' : 'Assess Company'}
              </Button>
            </CardContent>
          </Card>
        )
      case 3:
        return (
          <Card className="max-w-[560px]">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-[var(--text-heading)]">
                Readiness Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              {assessment && (
                <div className="mb-5">
                  <div className="flex justify-between py-2 border-b border-[var(--border)]">
                    <span className="text-[13px] text-[var(--text-light)]">Status</span>
                    <Badge
                      variant={assessment.status === 'ready' ? 'default' : 'secondary'}
                      className={
                        assessment.status === 'ready'
                          ? 'bg-[var(--success)]/15 text-[var(--success)]'
                          : 'bg-[var(--warning)] text-white'
                      }
                    >
                      {assessment.status || 'Complete'}
                    </Badge>
                  </div>
                  {assessment.summary && (
                    <p className="text-sm text-[var(--text-light)] leading-relaxed mt-3">
                      {assessment.summary}
                    </p>
                  )}
                  {assessment.items && (
                    <ul className="list-none p-0 mt-3">
                      {assessment.items.map((item, i) => (
                        <li key={i} className="flex items-center gap-2 py-1.5 text-[13px]">
                          <span
                            className={`size-2 rounded-full shrink-0 ${
                              item.ok ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'
                            }`}
                          />
                          {item.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <Button onClick={() => setStep(4)} size="lg">
                Next
              </Button>
            </CardContent>
          </Card>
        )
      case 4:
        return (
          <Card className="max-w-[560px]">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-[var(--text-heading)]">
                Ready to Go
              </CardTitle>
              <CardDescription className="leading-relaxed">
                Setup is complete. Click below to head to your dashboard and start working.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleBegin} size="lg">
                Begin Setup
              </Button>
            </CardContent>
          </Card>
        )
      default:
        return null
    }
  }

  return (
    <Layout>
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-6">Onboarding</h1>

        <div className="flex items-center mb-8">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <div
                className={`size-[30px] rounded-full flex items-center justify-center text-[13px] font-semibold shrink-0 ${
                  i <= step
                    ? 'bg-[var(--primary)] text-white'
                    : 'bg-[var(--border)] text-[var(--text-light)]'
                }`}
              >
                {i < step ? '\u2713' : i + 1}
              </div>
              <span
                className={`text-[13px] whitespace-nowrap ${
                  i <= step ? 'text-[var(--text-heading)]' : 'text-[var(--text-light)]'
                } ${i === step ? 'font-semibold' : 'font-normal'}`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <div className="w-10 h-0.5 bg-[var(--border)] mx-2" />
              )}
            </div>
          ))}
        </div>

        {error && (
          <div className="bg-[var(--danger-light)] text-[var(--danger)] px-3.5 py-2.5 rounded-[var(--radius)] mb-4 text-[13px] max-w-[560px]">
            {error}
          </div>
        )}
        {renderStep()}
      </div>
    </Layout>
  )
}
