import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Alert } from '@/components/ui/alert'

export default function Settings() {
  const [company, setCompany] = useState(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [message, setMessage] = useState(null)
  const [companyError, setCompanyError] = useState(null)
  const [aiConfigError, setAiConfigError] = useState(null)

  // AI API key state
  const [aiConfig, setAiConfig] = useState(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  const fetchCompany = () => {
    setLoading(true)
    setCompanyError(null)
    client
      .get('/qbo/status')
      .then((res) => setCompany(res.data))
      .catch((err) => setCompanyError(err.response?.data?.error || 'Could not load QBO connection status.'))
      .finally(() => setLoading(false))
  }

  const fetchAiConfig = () => {
    setAiConfigError(null)
    client.get('/ai/config')
      .then((res) => { if (res.data.success) setAiConfig(res.data.data) })
      .catch((err) => setAiConfigError(err.response?.data?.error || 'Could not load AI configuration.'))
  }

  useEffect(() => {
    fetchCompany()
    fetchAiConfig()
  }, [])

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return
    setSavingKey(true)
    setMessage(null)
    try {
      const res = await client.put('/auth/api-key', { apiKey: apiKeyInput.trim() })
      if (res.data.success) {
        setMessage({ type: 'success', text: 'API key saved.' })
        setApiKeyInput('')
        fetchAiConfig()
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to save API key' })
    } finally {
      setSavingKey(false)
    }
  }

  const handleClearApiKey = async () => {
    if (!confirm('Remove your Anthropic API key?')) return
    setSavingKey(true)
    setMessage(null)
    try {
      const res = await client.put('/auth/api-key', { apiKey: null })
      if (res.data.success) {
        setMessage({ type: 'success', text: 'API key removed.' })
        fetchAiConfig()
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to remove API key' })
    } finally {
      setSavingKey(false)
    }
  }

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
          ) : companyError ? (
            <Alert variant="error" onRetry={fetchCompany} className="max-w-[560px]">
              {companyError}
            </Alert>
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
        {/* AI API Key Section */}
        <div className="mb-8">
          <h2 className="text-base font-semibold text-[var(--text-heading)] mb-3">AI Assistant</h2>

          {aiConfigError ? (
            <Alert variant="error" onRetry={fetchAiConfig} className="max-w-[560px]">
              {aiConfigError}
            </Alert>
          ) : !aiConfig ? (
            <p className="text-[var(--text-light)] mb-2">Loading AI configuration...</p>
          ) : (
            <Card className="max-w-[560px] shadow-sm">
              <CardContent className="space-y-0">
                {/* Status row */}
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">AI Features</span>
                  <Badge variant={aiConfig.available ? 'default' : 'secondary'}>
                    {aiConfig.available ? 'Available' : 'Not configured'}
                  </Badge>
                </div>
                <Separator />

                {/* Global key info */}
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Shared API key</span>
                  <span className="text-sm font-medium text-[var(--text-heading)]">
                    {aiConfig.globalKeyEnabled
                      ? (aiConfig.globalKeySet ? 'Active' : 'Enabled (not set)')
                      : 'Disabled'}
                  </span>
                </div>
                <Separator />

                {/* Per-user key */}
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-[13px] text-[#6B7280]">Your API key</span>
                  <span className="text-sm font-medium text-[var(--text-heading)]">
                    {!aiConfig.userKeysEnabled
                      ? 'Disabled by admin'
                      : aiConfig.hasUserKey
                        ? `Set (${aiConfig.maskedKey || '••••'})`
                        : 'Not set'}
                  </span>
                </div>

                {/* Key input — only if user keys are enabled */}
                {aiConfig.userKeysEnabled && (
                  <>
                    <Separator />
                    <div className="py-3">
                      <p className="text-xs text-[#6B7280] mb-2">
                        Enter your Anthropic API key to use AI features. Get one at{' '}
                        <span className="font-medium">console.anthropic.com</span>
                      </p>
                      <div className="flex gap-2">
                        <Input
                          type="password"
                          placeholder="sk-ant-api03-..."
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSaveApiKey()}
                          className="flex-1 font-mono text-sm"
                        />
                        <Button
                          size="sm"
                          onClick={handleSaveApiKey}
                          disabled={savingKey || !apiKeyInput.trim()}
                        >
                          {savingKey ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>

              {/* Clear key button */}
              {aiConfig.userKeysEnabled && aiConfig.hasUserKey && (
                <CardFooter>
                  <Button variant="destructive" size="sm" onClick={handleClearApiKey} disabled={savingKey}>
                    Remove API Key
                  </Button>
                </CardFooter>
              )}
            </Card>
          )}
        </div>
      </div>
    </Layout>
  )
}
