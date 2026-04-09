import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export default function Dashboard() {
  const [company, setCompany] = useState(null)
  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState(null)
  const [seedProgress, setSeedProgress] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchHealth = () => {
    client
      .get('/company/health')
      .then((res) => setCompany(res.data))
      .catch(() => { /* ignore */ })
  }

  useEffect(() => {
    client
      .get('/company/health')
      .then((res) => setCompany(res.data))
      .catch(() => { /* ignore */ })
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
      } catch { /* ignore polling errors */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [seeding])

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
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-6">Dashboard</h1>

        {loading ? (
          <p className="text-[#6B7280]">Loading company data...</p>
        ) : !company ? (
          <Card className="shadow-sm">
            <CardContent>
              <p className="text-[#6B7280] mb-3">No company connected yet.</p>
              <a href="/onboarding" className="text-[var(--primary)] font-medium">
                Go to Onboarding
              </a>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-4 mb-6">
              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Company</div>
                  <div className="text-base font-medium text-[var(--text-heading)]">
                    {company.companyName || 'N/A'}
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Connection</div>
                  <div className="text-base font-medium text-[var(--text-heading)] flex items-center gap-2">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full ${
                        company.connectionStatus === 'active'
                          ? 'bg-[var(--success)]'
                          : 'bg-[var(--danger)]'
                      }`}
                    />
                    {company.connectionStatus === 'active' ? 'Connected' : company.connectionStatus}
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Seeding Status</div>
                  <div className="text-base font-medium text-[var(--text-heading)]">
                    {company.seedingStatus || 'Not started'}
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-sm py-0">
                <CardContent className="py-5">
                  <div className="text-[11px] font-semibold text-[#6B7280] uppercase tracking-[0.05em] mb-1.5">Freshness</div>
                  <div className="text-base font-medium text-[var(--text-heading)]">
                    {company.freshnessScore != null
                      ? `${company.freshnessScore}%`
                      : 'N/A'}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="flex items-center gap-4">
              <Button size="lg" onClick={handleSeed} disabled={seeding}>
                {seeding ? 'Seeding...' : 'Seed Company'}
              </Button>
              {seeding && seedProgress && (
                <Badge variant="secondary" className="px-3.5 py-1.5 text-[13px]">
                  {seedProgress.detail}
                </Badge>
              )}
              {!seeding && seedResult && (
                <Badge
                  variant={seedResult.success ? 'secondary' : 'destructive'}
                  className="px-3.5 py-1.5 text-[13px]"
                >
                  {seedResult.message}
                </Badge>
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}
