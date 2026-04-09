import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

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
      <div>
        <h1 className="text-[22px] font-semibold text-[var(--text-heading)] mb-6">Settings</h1>

        {message && (
          <div
            className={`rounded-lg px-3.5 py-2.5 mb-4 text-[13px] font-medium ${
              message.type === 'success'
                ? 'bg-green-50 text-[var(--success)]'
                : 'bg-red-50 text-[var(--danger)]'
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="mb-8">
          <h2 className="text-base font-semibold text-[var(--text-heading)] mb-3">QBO Connection</h2>
          {loading ? (
            <p className="text-[var(--text-light)] mb-2">Loading...</p>
          ) : !company?.connected ? (
            <Card className="max-w-[560px]">
              <CardContent>
                <p className="text-[var(--text-light)] mb-2">No company connected.</p>
                <a href="/onboarding" className="text-[var(--primary)] font-medium text-[13px]">
                  Set up a connection
                </a>
              </CardContent>
            </Card>
          ) : (
            <Card className="max-w-[560px] shadow-sm">
              <CardContent className="space-y-0">
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Company Name</span>
                  <span className="text-sm font-medium text-[var(--text-heading)] flex items-center gap-2">
                    {company.companyName || 'N/A'}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Realm ID</span>
                  <span className="text-[13px] font-medium text-[var(--text-heading)] flex items-center gap-2 font-mono">
                    {company.realmId || 'N/A'}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Status</span>
                  <span className="text-sm font-medium text-[var(--text-heading)] flex items-center gap-2">
                    <span
                      className={`inline-block size-2.5 rounded-full ${
                        company.connected ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'
                      }`}
                    />
                    {company.connected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Token Expires</span>
                  <span className="text-sm font-medium text-[var(--text-heading)] flex items-center gap-2">
                    {company.tokenExpiresAt
                      ? new Date(company.tokenExpiresAt).toLocaleString()
                      : 'N/A'}
                  </span>
                </div>
                <Separator />
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Last Refreshed</span>
                  <span className="text-sm font-medium text-[var(--text-heading)] flex items-center gap-2">
                    {company.lastRefreshedAt
                      ? new Date(company.lastRefreshedAt).toLocaleString()
                      : 'N/A'}
                  </span>
                </div>
              </CardContent>
              <CardFooter>
                <Button
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                >
                  {disconnecting ? 'Disconnecting...' : 'Disconnect'}
                </Button>
              </CardFooter>
            </Card>
          )}
        </div>
      </div>
    </Layout>
  )
}
