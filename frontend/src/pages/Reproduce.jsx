import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Check, CornerDownLeft, KeyRound, LoaderCircle } from 'lucide-react'
import Layout from '../components/Layout'
import client from '../api/client'
import { useConnection } from '../context/ConnectionContext'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const EXAMPLES = [
  'Customer paid an invoice but it still shows as open',
  'A payment was applied to the wrong invoice',
  'A vendor bill was paid twice',
  'A partial payment left a small balance on an invoice',
]

function relativeTime(date) {
  if (!date) return ''
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60000)
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function SetupRow({ done, title, children }) {
  return (
    <li className="flex gap-3 px-5 py-3.5">
      <span
        className={cn(
          'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
          done ? 'border-[var(--ok)] bg-[var(--ok)] text-white' : 'border-[var(--line-strong)] bg-[var(--surface)]',
        )}
        aria-hidden="true"
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[13.5px] font-medium', done ? 'text-[var(--ink-2)]' : 'text-[var(--ink)]')}>
          {title}<span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        </div>
        {children && <div className="mt-1 text-[13px] text-[var(--ink-2)]">{children}</div>}
      </div>
    </li>
  )
}

function ApiKeyForm({ onSaved }) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const save = async (e) => {
    e.preventDefault()
    if (!value.trim()) return
    setSaving(true)
    setError(null)
    try {
      await client.put('/auth/api-key', { apiKey: value.trim() })
      setValue('')
      onSaved()
    } catch (err) {
      setError(err.response?.data?.error || 'The key could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="mt-2.5 flex flex-wrap items-center gap-2">
      <label htmlFor="setup-api-key" className="sr-only">Anthropic API key</label>
      <div className="relative min-w-[260px] flex-1">
        <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--ink-3)]" aria-hidden="true" />
        <input
          id="setup-api-key"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste your Anthropic API key"
          className="h-8 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] pl-8 pr-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-3)]"
        />
      </div>
      <Button type="submit" size="default" disabled={saving || !value.trim()}>
        {saving ? 'Saving…' : 'Save key'}
      </Button>
      {error && <p className="w-full text-[12.5px] text-[var(--danger-ink)]">{error}</p>}
    </form>
  )
}

export default function Reproduce() {
  const navigate = useNavigate()
  const connection = useConnection()
  const [ai, setAi] = useState(null)
  const [aiError, setAiError] = useState(null)
  const [aiVersion, setAiVersion] = useState(0)
  const [cases, setCases] = useState(null)
  const [description, setDescription] = useState('')

  useEffect(() => {
    let cancelled = false
    client.get('/ai/config', { params: aiVersion > 0 ? { refresh: 'true' } : {} })
      .then((res) => { if (!cancelled) { setAi(res.data?.data || null); setAiError(null) } })
      .catch((err) => { if (!cancelled) setAiError(err.response?.data?.error || 'AI settings could not be loaded.') })
    return () => { cancelled = true }
  }, [aiVersion])

  useEffect(() => {
    let cancelled = false
    client.get('/ai/sessions', { params: { limit: 8 } })
      .then((res) => { if (!cancelled) setCases(res.data?.data?.sessions || []) })
      .catch(() => { if (!cancelled) setCases('error') })
    return () => { cancelled = true }
  }, [])

  const connected = connection?.ready === true
  const aiReady = ai?.available === true
  const canWrite = ai?.featureFlags?.aiMutations === true
  const canStart = connected && aiReady
  const showSetup = ai !== null && (!connected || !aiReady || !canWrite)

  const recheck = (
    <button type="button" onClick={() => setAiVersion((v) => v + 1)} className="font-medium text-[var(--link)] hover:underline">Check again</button>
  )
  const code = (text) => <code className="rounded bg-[var(--sunken)] px-1 py-0.5 font-mono text-[12px]">{text}</code>

  // How the assistant reaches a model: the Codex CLI (your ChatGPT
  // subscription, no key) when it is installed and signed in, else an
  // Anthropic API key.
  let aiSetup = null
  if (aiReady && ai?.provider === 'codex') {
    aiSetup = <>Using Codex CLI with your ChatGPT subscription ({ai.codex?.model}). No API key needed.</>
  } else if (aiReady) {
    aiSetup = 'Using an Anthropic API key.'
  } else if (ai && ai.codex === undefined) {
    aiSetup = <>Restart the backend to turn on Codex CLI support, then {recheck}.</>
  } else if (ai?.codex?.installed && !ai.codex.loggedIn) {
    aiSetup = <>Codex CLI is installed but not signed in. Run {code('codex login')} in a terminal, then {recheck}.</>
  } else if (ai?.providerSetting !== 'anthropic') {
    aiSetup = (
      <>
        Install the Codex CLI to use your ChatGPT subscription: {code('npm install -g @openai/codex')}, then {code('codex login')}, then {recheck}.
        {ai?.userKeysEnabled && ai?.providerSetting === 'auto' && <span className="mt-2 block">Or use an Anthropic API key instead:<ApiKeyForm onSaved={() => setAiVersion((v) => v + 1)} /></span>}
      </>
    )
  } else if (ai?.userKeysEnabled) {
    aiSetup = <>Paste your Anthropic API key. It is stored on the lab server, never in the browser.<ApiKeyForm onSaved={() => setAiVersion((v) => v + 1)} /></>
  } else {
    aiSetup = <>AI is switched off on the lab server. Set {code('AI_PROVIDER=codex')} or an Anthropic key in the backend .env and restart the backend.</>
  }

  const setupPanel = (
    <section className="rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
      <h2 className="border-b border-[var(--line)] px-5 py-3 text-[13px] font-semibold text-[var(--ink)]">Finish setup to start</h2>
      <ol className="divide-y divide-[var(--line)]">
        <SetupRow done={connected} title="QuickBooks connected">
          {!connected && 'Use the fix in the yellow bar at the top of the page.'}
        </SetupRow>
        <SetupRow done={aiReady} title="AI assistant available">
          {aiSetup}
        </SetupRow>
        <SetupRow done={canWrite} title="Allowed to change QuickBooks">
          {!canWrite && 'The assistant can already investigate and propose changes. To let it make them after you approve, set LEGACY_AI_MUTATIONS_ENABLED=true in the backend .env and restart the backend.'}
        </SetupRow>
      </ol>
    </section>
  )

  // Blocking setup goes first; the optional write switch can wait below.
  const setupFirst = showSetup && (!connected || !aiReady)

  const start = (e) => {
    e?.preventDefault()
    const text = description.trim()
    if (!text || !canStart) return
    navigate('/cases/new', { state: { message: text } })
  }

  const blockedReason = !connected ? 'Connect QuickBooks first.'
    : ai === null && !aiError ? 'Checking the assistant…'
      : !aiReady ? 'Set up the AI assistant first.'
        : null

  return (
    <Layout>
      <div className="mx-auto max-w-[760px] pt-4">
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-[var(--ink)]">
          What is the customer seeing?
        </h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--ink-2)]">
          Describe the problem in plain words. The assistant looks at your company, lists the exact changes it would make to recreate it, and makes them only after you approve.
        </p>

        {setupFirst && <div className="mt-6">{setupPanel}</div>}

        <form onSubmit={start} className="mt-6">
          <div className="rounded-[12px] border border-[var(--line-strong)] bg-[var(--surface)] shadow-[var(--shadow-sm)] focus-within:border-[var(--ink-3)]">
            <label htmlFor="issue" className="sr-only">Describe the customer's issue</label>
            <textarea
              id="issue"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start(e) }}
              rows={5}
              placeholder="e.g. Customer says invoice 1043 still shows $1,250 owing even though they paid it in full by e-transfer last Tuesday."
              className="block w-full resize-none rounded-t-[12px] bg-transparent px-5 pt-4 text-[15px] leading-relaxed text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)]"
            />
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-1">
              <span className="text-[12px] text-[var(--ink-3)]">
                {blockedReason || (
                  <span className="inline-flex items-center gap-1">Ctrl <CornerDownLeft className="size-3" aria-hidden="true" /> to start</span>
                )}
              </span>
              <Button type="submit" size="lg" disabled={!canStart || !description.trim()}>
                Reproduce <ArrowRight />
              </Button>
            </div>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap gap-2" aria-label="Examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setDescription(example)}
              className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-3 py-1 text-[12.5px] text-[var(--ink-2)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
            >
              {example}
            </button>
          ))}
        </div>

        {aiError && (
          <p className="mt-6 text-[13px] text-[var(--danger-ink)]">
            {aiError} <button type="button" className="font-medium text-[var(--link)] hover:underline" onClick={() => setAiVersion((v) => v + 1)}>Retry</button>
          </p>
        )}

        {showSetup && !setupFirst && <div className="mt-8">{setupPanel}</div>}

        <section className="mt-10">
          <h2 className="mb-2 text-[13px] font-semibold text-[var(--ink)]">Recent cases</h2>
          {cases === null ? (
            <p className="flex items-center gap-2 text-[13px] text-[var(--ink-3)]"><LoaderCircle className="size-3.5 animate-spin" /> Loading…</p>
          ) : cases === 'error' ? (
            <p className="text-[13px] text-[var(--ink-2)]">Recent cases couldn't be loaded.</p>
          ) : cases.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-3)]">No cases yet. Your first reproduction will appear here.</p>
          ) : (
            <ul className="divide-y divide-[var(--line)] rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
              {cases.map((c) => (
                <li key={c._id}>
                  <Link to={`/cases/${c._id}`} className="flex items-center gap-4 px-5 py-3 no-underline hover:bg-[var(--surface-muted)]">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--ink)]">{c.title || 'Untitled case'}</span>
                    <span className="shrink-0 text-[12px] text-[var(--ink-3)]">
                      {(c.plans?.length || 0) > 0 ? 'Changes proposed' : 'Conversation'}
                    </span>
                    <span className="w-20 shrink-0 text-right text-[12px] text-[var(--ink-3)] tabular">{relativeTime(c.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Layout>
  )
}
