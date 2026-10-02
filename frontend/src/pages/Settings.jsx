import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { KeyRound, LoaderCircle, LogOut, RefreshCw } from 'lucide-react'
import Layout from '../components/Layout'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useConnection } from '../context/ConnectionContext'
import { Button, buttonVariants } from '@/components/ui/button'
import { StatusDot, EnvironmentTag } from '@/components/ui/status'
import { CopyButton, FactRow, Muted, PageHeader, Panel } from '@/components/ui/page'
import { dateTime, daysUntil, shortDate } from '@/lib/format'
import { cn } from '@/lib/utils'

// Settings answers one question per section: is QuickBooks connected, is the
// assistant ready (and allowed to make changes), and who is signed in. The one
// destructive action sits apart at the bottom.

function Headline({ tone, title, detail, children }) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-4">
      <StatusDot tone={tone} className="size-2.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-[var(--ink)]">{title}</p>
        {detail && <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">{detail}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

function Notice({ message }) {
  if (!message) return null
  return (
    <p
      role={message.type === 'error' ? 'alert' : 'status'}
      className={cn(
        'mx-5 mb-4 rounded-lg px-3 py-2 text-[12.5px]',
        message.type === 'error' ? 'bg-[var(--danger-soft)] text-[var(--danger-ink)]' : 'bg-[var(--ok-soft)] text-[var(--ok)]',
      )}
    >
      {message.text}
    </p>
  )
}

function QuickBooksSection() {
  const connection = useConnection()
  const status = connection?.status
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [rejected, setRejected] = useState(false)

  const trySaved = async () => {
    setBusy(true)
    setMessage(null)
    const result = await connection.trySavedConnection()
    if (result) {
      setRejected(result.rejected)
      setMessage({ type: 'error', text: `${result.message}${result.intuitTid ? ` Intuit reference: ${result.intuitTid}.` : ''}` })
    } else {
      setMessage({ type: 'success', text: 'The saved sign-in worked. QuickBooks is connected again.' })
    }
    setBusy(false)
  }

  const reconnect = (primary) => (
    <Link to="/onboarding" className={cn(buttonVariants({ variant: primary ? 'default' : 'outline' }), 'no-underline')}>
      Reconnect
    </Link>
  )

  let headline
  if (!connection || connection.state === 'loading') {
    headline = <Headline tone="muted" title="Checking…" />
  } else if (connection.state === 'unavailable') {
    headline = (
      <Headline tone="attention" title="The lab server isn't answering" detail="Nothing can be read or changed until it's running.">
        <Button variant="outline" onClick={connection.refresh}><RefreshCw /> Check again</Button>
      </Headline>
    )
  } else if (connection.state === 'connected') {
    const days = status?.refreshTokenExpiresInDays ?? daysUntil(status?.refreshTokenExpiresAt)
    headline = (
      <Headline
        tone={days != null && days <= 14 ? 'attention' : 'ok'}
        title={`Connected to ${status?.companyName || 'your company'}`}
        detail={days != null && days <= 14
          ? `The sign-in runs out in ${days} ${days === 1 ? 'day' : 'days'}. Reconnect before then to keep working.`
          : 'The lab renews the sign-in by itself while it’s in use.'}
      >
        {days != null && days <= 14 && reconnect(true)}
      </Headline>
    )
  } else if (connection.state === 'expired') {
    headline = (
      <Headline
        tone="attention"
        title={rejected ? 'QuickBooks needs you to reconnect' : 'QuickBooks is disconnected'}
        detail={rejected
          ? 'QuickBooks rejected the saved sign-in. Reconnecting takes about a minute.'
          : `${status?.companyName || 'The company'} is still saved. Try the saved sign-in first; reconnect if QuickBooks rejects it.`}
      >
        {!rejected && (
          <Button onClick={trySaved} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            {busy ? 'Checking…' : 'Try saved sign-in'}
          </Button>
        )}
        {reconnect(rejected)}
      </Headline>
    )
  } else {
    headline = (
      <Headline tone="muted" title={connection.state === 'none' ? 'No company connected' : 'This company was disconnected'} detail="Connect the test company to start reproducing issues.">
        <Link to="/onboarding" className={cn(buttonVariants(), 'no-underline')}>Connect company</Link>
      </Headline>
    )
  }

  return (
    <Panel title="QuickBooks">
      {headline}
      <Notice message={message} />
      {status?.realmId && (
        <dl className="divide-y divide-[var(--line)] border-t border-[var(--line)] px-5 py-1">
          <FactRow label="Company">{status.companyName || '—'}</FactRow>
          <FactRow label="Environment"><EnvironmentTag environment={connection?.environment} /></FactRow>
          <FactRow label="Realm ID">
            <span className="inline-flex items-center gap-1.5"><span className="font-mono text-[12.5px] tabular">{status.realmId}</span><CopyButton value={status.realmId} label="Copy realm ID" /></span>
          </FactRow>
          <FactRow label="Sign-in valid until"><span className="tabular">{status.refreshTokenExpiresAt ? shortDate(status.refreshTokenExpiresAt) : 'Not reported'}</span></FactRow>
          <FactRow label="Last renewed"><span className="tabular">{status.lastRefreshedAt ? dateTime(status.lastRefreshedAt) : '—'}</span></FactRow>
        </dl>
      )}
    </Panel>
  )
}

function ApiKeyForm({ config, onChanged }) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  const save = async (apiKey) => {
    setSaving(true)
    setMessage(null)
    try {
      await client.put('/auth/api-key', { apiKey })
      setValue('')
      setMessage({ type: 'success', text: apiKey ? 'Key saved.' : 'Key removed.' })
      onChanged()
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'The key could not be saved.' })
    } finally {
      setSaving(false)
    }
  }

  if (!config.userKeysEnabled) {
    return <p className="text-[12.5px] text-[var(--ink-3)]">Personal keys are turned off on this server.{config.globalKeySet ? ' A shared key is set.' : ''}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-[var(--ink-2)]">
        {config.hasUserKey ? <>Your key ending <span className="font-mono">{config.maskedKey?.slice(-4)}</span> is saved.</> : 'No key saved.'}
        {config.globalKeySet && ' A shared key is also set on the server.'}
      </p>
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(value.trim()) }} className="flex flex-wrap items-center gap-2">
        <label htmlFor="settings-api-key" className="sr-only">Anthropic API key</label>
        <div className="relative min-w-[240px] flex-1">
          <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--ink-3)]" aria-hidden="true" />
          <input
            id="settings-api-key"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={config.hasUserKey ? 'Paste a new key to replace it' : 'Paste your Anthropic API key'}
            className="h-8 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] pl-8 pr-3 font-mono text-[12.5px] text-[var(--ink)] placeholder:font-sans placeholder:text-[var(--ink-3)]"
          />
        </div>
        <Button type="submit" disabled={saving || !value.trim()}>{saving ? 'Saving…' : 'Save key'}</Button>
        {config.hasUserKey && (
          <Button type="button" variant="ghost" disabled={saving} onClick={() => { if (window.confirm('Remove your Anthropic API key?')) save(null) }}>
            Remove
          </Button>
        )}
      </form>
      {message && (
        <p className={cn('text-[12.5px]', message.type === 'error' ? 'text-[var(--danger-ink)]' : 'text-[var(--ok)]')}>{message.text}</p>
      )}
    </div>
  )
}

function AssistantSection() {
  const [config, setConfig] = useState(null)
  const [error, setError] = useState(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback((refresh = false) => {
    setChecking(refresh)
    return client.get('/ai/config', { params: refresh ? { refresh: 'true' } : {} })
      .then((res) => { setConfig(res.data?.data || null); setError(null) })
      .catch((err) => setError(err.response?.data?.error || "The assistant's settings couldn't be loaded."))
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => load(false), 0)
    return () => clearTimeout(timer)
  }, [load])

  if (error) {
    return (
      <Panel title="Assistant">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <p className="flex-1 text-[13px] text-[var(--danger-ink)]">{error}</p>
          <Button size="sm" variant="outline" onClick={() => load(false)}>Try again</Button>
        </div>
      </Panel>
    )
  }
  if (!config) return <Panel title="Assistant"><Muted>Loading…</Muted></Panel>

  const codex = config.provider === 'codex'
  const canWrite = config.featureFlags?.aiMutations === true

  let headline
  if (codex) {
    if (!config.codex?.installed) {
      headline = { tone: 'attention', title: "Codex CLI isn't installed", detail: 'Install the Codex CLI on this computer, sign in with your ChatGPT account, then check again.' }
    } else if (!config.codex?.loggedIn) {
      headline = { tone: 'attention', title: 'Codex CLI is signed out', detail: 'Run “codex login” in a terminal and sign in with ChatGPT, then check again.' }
    } else {
      headline = { tone: 'ok', title: 'Ready, using your ChatGPT subscription', detail: 'Cases run through the Codex CLI on this computer. No API key needed.' }
    }
  } else {
    headline = config.available
      ? { tone: 'ok', title: 'Ready, using an Anthropic API key', detail: 'Cases are billed to the saved key.' }
      : { tone: 'attention', title: 'Add an Anthropic API key to start', detail: 'The assistant needs a key before it can work on cases.' }
  }

  return (
    <Panel title="Assistant">
      <Headline tone={headline.tone} title={headline.title} detail={headline.detail}>
        <Button variant="outline" onClick={() => load(true)} disabled={checking}>
          {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </Headline>
      <dl className="divide-y divide-[var(--line)] border-t border-[var(--line)] px-5 py-1">
        <FactRow label="Service">{codex ? 'Codex CLI (ChatGPT subscription)' : 'Anthropic API'}</FactRow>
        {codex && <FactRow label="Model">{config.codex?.model || 'Codex default'}</FactRow>}
        <FactRow label="Changes to QuickBooks">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={canWrite ? 'ok' : 'muted'} />
            {canWrite ? 'Allowed after you approve each case' : 'Off: the assistant can only propose'}
          </span>
        </FactRow>
      </dl>
      <p className="border-t border-[var(--line)] px-5 py-3 text-[12px] text-[var(--ink-3)]">
        {canWrite
          ? 'Nothing is written until you approve a case’s list of changes. In production you also confirm by typing PRODUCTION.'
          : 'To let approved cases write to QuickBooks, set LEGACY_AI_MUTATIONS_ENABLED=true in the backend .env and restart the backend.'}
        {' '}The service is chosen by AI_PROVIDER in the backend .env.
      </p>
      {(!codex || config.hasUserKey) && (
        <div className="border-t border-[var(--line)] px-5 py-4">
          <h3 className="mb-2 text-[13px] font-medium text-[var(--ink)]">Anthropic API key{codex && <span className="font-normal text-[var(--ink-3)]"> (not used while Codex is selected)</span>}</h3>
          <ApiKeyForm config={config} onChanged={() => load(false)} />
        </div>
      )}
    </Panel>
  )
}

function AccountSection() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <Panel title="Your sign-in">
      <Headline tone="ok" title={user?.displayName || user?.email || 'Signed in'} detail={user?.displayName ? user.email : null}>
        <Button variant="outline" onClick={() => { logout(); navigate('/login') }}><LogOut /> Log out</Button>
      </Headline>
    </Panel>
  )
}

function DisconnectSection() {
  const connection = useConnection()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (!['connected', 'expired'].includes(connection?.state)) return null

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${connection.companyName || 'this company'}? Nothing in QuickBooks is deleted, but the lab stops reading and changing it until you reconnect.`)) return
    setBusy(true)
    setError(null)
    try {
      await client.post('/qbo/disconnect')
      window.dispatchEvent(new Event('qbo-connection-changed'))
    } catch (err) {
      setError(err.response?.data?.error || 'Disconnect failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[10px] border border-[var(--danger-soft)] bg-[var(--surface)]">
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13.5px] font-semibold text-[var(--ink)]">Disconnect QuickBooks</h2>
          <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">
            The lab forgets its sign-in to {(connection.companyName || 'the company').replace(/\.$/, '')}. Records in QuickBooks stay as they are.
          </p>
          {error && <p className="mt-1 text-[12.5px] text-[var(--danger-ink)]">{error}</p>}
        </div>
        <Button variant="destructive" onClick={disconnect} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>
      </div>
    </section>
  )
}

export default function Settings() {
  return (
    <Layout>
      <div className="mx-auto flex max-w-[760px] flex-col gap-5">
        <PageHeader title="Settings" description="How the lab reaches QuickBooks and the assistant." />
        <QuickBooksSection />
        <AssistantSection />
        <AccountSection />
        <DisconnectSection />
      </div>
    </Layout>
  )
}
