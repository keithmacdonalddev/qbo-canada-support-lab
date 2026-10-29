import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, AlertCircle, ArrowRight, Bot, Check, CheckCircle2, Clock3, FileText, LoaderCircle, Pause, Play, RefreshCw, Settings2, ShieldCheck, Users, X } from 'lucide-react'
import Layout from '../components/Layout'
import { Button, buttonVariants } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import { useConnection } from '../context/ConnectionContext'
import client from '../api/client'
import { money, shortDate, dateTime } from '../lib/format'
import { ageLabel, countValue, recordLink, syncPresentation, textValue, workspaceScope } from '../lib/business-workspace.mjs'
import BusinessActivityComposer from '../components/BusinessActivityComposer'
import BusinessWork from '../components/BusinessWork'
import '../styles/business-workspace.css'

const ENDPOINT = '/company/business-agent'
const SPECIALISTS = [
  { id: 'receivables', name: 'Receivables', description: 'Customer balances, collections and follow-ups.' },
  { id: 'payables', name: 'Payables', description: 'Supplier obligations and payment timing.' },
  { id: 'inventory', name: 'Inventory', description: 'Stock availability, purchasing and movement.' },
]
const STATUS_LABELS = { reviewing: 'Reviewing the business', ready: 'Ready', attention: 'Needs attention', recovering: 'Recovering saved work', 'not-configured': 'Not enabled', stopped: 'Stopped', idle: 'Ready', working: 'Working', running: 'Working', thinking: 'Reviewing the business', paused: 'Decisions paused', monitoring: 'Monitoring', disabled: 'Not enabled', blocked: 'Needs attention', error: 'Needs attention', waiting: 'Waiting for next review', waiting_for_sync: 'Waiting for company data', 'waiting-for-sync': 'Waiting for company data' }

function useWorkspace(api, scope, enabled) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState('')
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [readAt, setReadAt] = useState(0)
  const current = useRef(null), sending = useRef(false), epoch = useRef(0), mounted = useRef(true), actionController = useRef(null)
  const toast = useToast()
  const scopeKey = [scope.realmId, scope.environment, scope.connectionId].join(':')
  const refresh = useCallback(() => setVersion(value => value + 1), [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; actionController.current?.abort() } }, [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController(); let timer
    async function load() {
      if (controller.signal.aborted) return
      if (sending.current) { timer = setTimeout(load, 1000); return }
      const started = epoch.current
      setRefreshing(true)
      try {
        const response = await api.get(ENDPOINT, { signal: controller.signal, timeout: 12000 })
        const next = workspaceScope(response.data?.data, scope)
        if (!controller.signal.aborted && started === epoch.current) {
          current.current = next; setData(next); setError(''); setActionError(''); setReadAt(Date.now())
        }
      } catch (failure) {
        if (!controller.signal.aborted && started === epoch.current) setError(failure.response?.data?.error || failure.message || 'Company monitoring could not be read. Your saved business and instructions have been kept.')
      } finally {
        if (!controller.signal.aborted) { setNow(Date.now()); setRefreshing(false); timer = setTimeout(load, 5000) }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
    // Company changes remount the workspace; validate every response against that exact scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, enabled, scopeKey, version])
  const fresh = !!data && !error && !actionError && now - readAt < 20000
  async function command(name, extra = {}) {
    if (sending.current || !current.current?.owner || !fresh) return false
    sending.current = true; epoch.current++; setBusy(name); setActionError('')
    const controller = new AbortController(); actionController.current = controller
    try {
      const response = await api.post(ENDPOINT + '/control', { command: name, expectedRevision: current.current.revision, requestKey: crypto.randomUUID(), ...extra }, { signal: controller.signal, timeout: 30000 })
      const next = workspaceScope(response.data?.data, scope)
      if (mounted.current) {
        current.current = next; setData(next); setError(''); setReadAt(Date.now()); setNow(Date.now())
        toast.success(name === 'save-instructions' ? 'Your instructions are saved for the accountant.' : name === 'respond-decision' ? 'Your decision is recorded.' : 'Business controls updated.')
      }
      return true
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) {
        const message = failure.response?.data?.error || 'The action could not be confirmed. Refresh saved state before trying again.'
        setActionError(message); toast.error(message)
      }
      return false
    } finally {
      sending.current = false; actionController.current = null
      if (mounted.current) { setBusy(''); refresh() }
    }
  }
  return { data, error: error || actionError, refreshing, busy, fresh, now, refresh, command }
}

export default function BusinessWorkspace() {
  const connection = useConnection()
  const scope = { realmId: connection?.status?.realmId, connectionId: connection?.status?.connectionId, environment: connection?.environment }
  return <Layout><BusinessWorkspaceLive key={Object.values(scope).join(':')} connection={connection} scope={scope} /></Layout>
}
function BusinessWorkspaceLive({ connection, scope }) {
  const workspace = useWorkspace(client, scope, connection?.ready === true)
  return <BusinessWorkspaceContent {...workspace} onCommand={workspace.command} companyName={connection?.companyName} environment={connection?.environment} realmId={scope.realmId} connectionState={connection?.state} />
}

function Badge({ tone = 'quiet', children }) { return <span className={'bw-badge bw-badge--' + tone}><span className="bw-status-dot" />{children}</span> }
function Section({ title, icon: Icon, action, children, className = '' }) { return <section className={'bw-panel ' + className}><header className="bw-panel-heading"><h2>{Icon && <Icon aria-hidden="true" />}{title}</h2>{action}</header>{children}</section> }
function Empty({ icon: Icon = Activity, title, children, action }) { return <div className="bw-empty">{Icon && <Icon aria-hidden="true" />}<strong>{title}</strong><p>{children}</p>{action}</div> }
function Metric({ label, value, detail, to, icon: Icon }) { return <Link to={to} className="bw-metric"><div className="bw-metric-label">{label}{Icon && <Icon aria-hidden="true" />}</div><strong>{value}</strong><span>{detail}<ArrowRight aria-hidden="true" /></span></Link> }
function Choice({ decision, disabled, onCommand }) {
  const [note, setNote] = useState('')
  return <article className="bw-decision"><span className="bw-eyebrow">Your decision</span><h3>{textValue(decision, 'A business decision needs your direction')}</h3><p>{decision.detail || decision.reason || decision.description || 'Review this request and record the direction the accountant should follow.'}</p><label className="bw-sr-only" htmlFor={'decision-note-' + decision.id}>Note for this decision</label><input id={'decision-note-' + decision.id} value={note} maxLength={2000} onChange={event => setNote(event.target.value)} placeholder="Add context for the accountant (optional)" disabled={disabled} /><div className="bw-inline-actions"><Button size="sm" disabled={disabled || !decision.id} onClick={() => onCommand('respond-decision', { decisionId: decision.id, choice: 'accept', note: note.trim() || 'Owner accepted this direction.' })}><Check />Accept</Button><Button size="sm" variant="outline" disabled={disabled || !decision.id} onClick={() => onCommand('respond-decision', { decisionId: decision.id, choice: 'decline', note: note.trim() || 'Owner declined this direction.' })}>Decline</Button></div><small>Your answer is retained for the accountant's next review.</small></article>
}
function Consent({ mode, companyName, environment, realmId, busy, error, onClose, onConfirm }) {
  const dialog = useRef(null), [confirmed, setConfirmed] = useState(false)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { if (node?.open) node.close() } }, [])
  const autonomy = mode === 'enable-autonomy'
  return <dialog ref={dialog} className="bw-dialog" aria-labelledby="business-consent-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="bw-dialog-heading"><span className="bw-agent-avatar"><Bot /></span><Button size="icon-sm" variant="ghost" aria-label="Close authorization" disabled={busy} onClick={onClose}><X /></Button></div>
    <h2 id="business-consent-title">{autonomy ? 'Let the accountant run the business' : 'Keep this company monitored'}</h2>
    <p className="bw-dialog-company">{companyName || 'Connected company'} <Badge tone={environment === 'production' ? 'production' : 'quiet'}>{environment === 'production' ? 'Production' : 'Sandbox'} · …{String(realmId || '').slice(-4)}</Badge></p>
    <p>{autonomy ? 'Authorize continuing business decisions and supported accounting work under the published business rules. The accountant keeps working while the server runs, including when this page is closed.' : 'The server will continuously read and retain supported QuickBooks company data, including changes made outside this app. Closing this page will not stop monitoring.'}</p>
    {autonomy && <ul><li>You can give direction, pause the accountant and inspect every recorded action.</li><li>Additional same-day work can create service sales with their collections/deposits, and non-stock overhead bills with payments. Each batch retains a business purpose and exact accounting checks.</li><li>Existing record and protected-period checks remain in place.</li><li>There is no end date or lifetime transaction quota.</li></ul>}
    <label className="bw-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} /><span>{autonomy ? 'I authorize the accountant to operate this company continuously under its published business rules and the additional service-sale and non-stock expense policy.' : 'I authorize continuous company reads and saved monitoring for this company.'}{environment === 'production' && ' I understand this is the connected Production company.'}</span></label>
    {error && <p role="alert" className="bw-consent-error">{error}</p>}
    <div className="bw-dialog-actions"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={!confirmed || busy} onClick={() => onConfirm(mode, { confirmProduction: environment === 'production' })}>{busy ? <LoaderCircle className="animate-spin" /> : autonomy ? <Play /> : <RefreshCw />}{autonomy ? 'Enable autonomous operation' : 'Start monitoring'}</Button></div>
  </dialog>
}

// Kept context-free so rendered review can exercise real UI states with sanitized fixtures.
export function BusinessWorkspaceContent({ data, error = '', refreshing = false, busy = '', fresh = true, now, refresh = () => {}, onCommand = async () => false, companyName, environment, realmId, connectionState = 'connected' }) {
  const [view, setView] = useState('overview'), [consent, setConsent] = useState(null)
  const [instructions, setInstructions] = useState(data?.settings?.instructions || ''), [instructionsDirty, setInstructionsDirty] = useState(false)
  const [specialists, setSpecialists] = useState(data?.settings?.specialists || []), [specialistsDirty, setSpecialistsDirty] = useState(false)
  const [syncInterval, setSyncInterval] = useState(data?.settings?.syncIntervalSeconds || 30), [decisionInterval, setDecisionInterval] = useState(data?.settings?.decisionIntervalMinutes || 60), [cadenceDirty, setCadenceDirty] = useState(false)
  useEffect(() => { if (!instructionsDirty) setInstructions(data?.settings?.instructions || '') }, [data?.settings?.instructions, instructionsDirty])
  useEffect(() => { if (!specialistsDirty) setSpecialists(data?.settings?.specialists || []) }, [data?.settings?.specialists, specialistsDirty])
  useEffect(() => { if (!cadenceDirty) { setSyncInterval(data?.settings?.syncIntervalSeconds || 30); setDecisionInterval(data?.settings?.decisionIntervalMinutes || 60) } }, [data?.settings?.syncIntervalSeconds, data?.settings?.decisionIntervalMinutes, cadenceDirty])
  const [fallbackNow] = useState(Date.now)
  now = now ?? fallbackNow
  const settings = data?.settings || {}, agent = data?.agent || {}, business = data?.business || {}, company = data?.company || {}
  const sync = syncPresentation(data?.sync, settings, now), owner = data?.owner === true
  const disabled = !owner || !fresh || !!busy || !data || connectionState !== 'connected'
  const decisions = (Array.isArray(data?.decisions) ? data.decisions : []).filter(item => !['accept', 'decline', 'accepted', 'declined', 'resolved', 'closed'].includes(item.status))
  const events = Array.isArray(data?.events) ? data.events : [], recent = Array.isArray(company.recent) ? company.recent : []
  const counts = company.counts || {}, totals = company.totals || {}, currency = totals.currency || 'CAD'
  const active = settings.autonomous === true
  const hasGrant = Boolean(agent.standingAuthority && agent.standingAuthority.authorityHash === business.authorityHash && (!data?.capabilities?.activityPolicyHash || agent.standingAuthority.activityPolicyHash === data.capabilities.activityPolicyHash))
  const needsRenewal = Boolean(agent.standingAuthority && !hasGrant)
  // A renewal is also an enable-autonomy dialog, so close it only once the grant is current.
  useEffect(() => { if (consent === 'enable-autonomy' && settings.autonomous && hasGrant || consent === 'enable-monitoring' && settings.monitoring) setConsent(null) }, [consent, settings.autonomous, settings.monitoring, hasGrant])
  const status = STATUS_LABELS[agent.status] || (active ? 'Waiting for next review' : data?.configured ? 'Decisions paused' : 'Not enabled')
  const agentTone = ['blocked', 'error', 'attention', 'recovering', 'catching-up'].includes(agent.status) ? 'attention' : active ? 'good' : 'quiet'
  const after = async (command, extra) => { const saved = await onCommand(command, extra); if (saved) setConsent(null); return saved }
  const number = value => Number.isFinite(Number(value)) && value !== undefined && value !== null ? Number(value).toLocaleString() : '—'
  const title = companyName || data?.companyName || 'Your business'
  // Healthy sync is a quiet dot beside the name; the full strip appears only when sync needs the owner's attention.
  const syncDot = data && connectionState === 'connected' && <span className={'bw-sync-dot bw-sync-dot--' + sync.tone} role="img" aria-label={sync.label} title={sync.label + '. ' + sync.detail} />
  const header = <header className="bw-header"><h1>{title}{syncDot}</h1><Link to="/company/manage" className={buttonVariants({ variant: 'outline', size: 'sm' })}><Settings2 />Manage business</Link></header>
  if (connectionState !== 'connected') return <div className="business-workspace">{header}<Section title="Company connection" icon={ShieldCheck}><Empty title={connectionState === 'loading' ? 'Checking your company connection' : 'Connect the business to continue'} icon={connectionState === 'loading' ? LoaderCircle : ShieldCheck} action={<Link to="/onboarding" className={buttonVariants({ size: 'sm' })}>Open connection setup<ArrowRight /></Link>}>Your business instructions and saved activity remain in the app. Monitoring and accounting work need the connected company.</Empty></Section></div>
  if (!data) return <div className="business-workspace">{header}{error ? <Section title="Workspace unavailable" icon={AlertCircle}><Empty title="Saved company state could not be read" icon={AlertCircle} action={<Button onClick={refresh} disabled={refreshing}><RefreshCw />Try again</Button>}>{error} You can still open business management, records and history.</Empty><JourneyLinks /></Section> : <div className="bw-loading" role="status"><LoaderCircle className="animate-spin" /><div><strong>Reading your business workspace</strong><p>Loading saved company data and the accountant's current work.</p></div></div>}</div>
  return <div className="business-workspace">{header}
    {sync.tone !== 'good' && <div className="bw-monitor-strip"><div><Badge tone={sync.tone}>{sync.label}</Badge><span>Last company check <strong>{ageLabel(data.sync?.summaryAt || data.sync?.lastSuccessAt, now)}</strong></span><span className="bw-monitor-count">{sync.sources.filter(source => source.complete === true || ['current', 'complete', 'ready'].includes(source.status)).length}/{sync.sources.length || '—'} sources complete</span></div><button type="button" className="bw-text-button" onClick={() => setView('activity')}>Inspect monitoring<ArrowRight /></button></div>}
    {busy && <div className="bw-action-progress" role="status"><LoaderCircle className="animate-spin" />{busy === 'save-instructions' ? 'Saving your direction…' : busy === 'run-now' ? 'Requesting the accountant’s next review…' : busy === 'sync-now' ? 'Requesting a company update…' : 'Saving business controls…'}</div>}
    {error && <div className="bw-notice bw-notice--attention" role="alert"><AlertCircle /><div><strong>Workspace updates need attention</strong><p>{error} Earlier observations remain visible; controls wait for a confirmed refresh.</p></div><Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>Retry</Button></div>}
    {agent.lastError && !/AI connection/i.test(agent.lastError) && <div className="bw-notice bw-notice--attention" role="alert"><AlertCircle /><div><strong>The accountant needs attention</strong><p>{agent.lastError}</p><Link to="/settings" className="bw-text-button">Check AI and connection settings<ArrowRight /></Link></div><Button size="sm" variant="outline" disabled={disabled || !active} onClick={() => onCommand('run-now')}>Retry review</Button></div>}
    {!owner && <div className="bw-read-only"><ShieldCheck />You can inspect this workspace. The company owner manages autonomous operation and business directions.</div>}
    <BusinessWork work={data.work} disabled={disabled} onAction={kind => kind === 'resume' ? onCommand('resume') : setConsent(kind)} />
    <div className="bw-metrics" aria-label="Company at a glance"><Metric label="Customer balances" value={totals.incompleteCurrency ? 'Unavailable' : money(totals.receivables ?? totals.accountsReceivable, currency)} detail={countValue(counts, 'openInvoices', 'openInvoices') + ' open invoices'} to="/explorer?type=Invoice" icon={FileText} /><Metric label="Supplier balances" value={totals.incompleteCurrency ? 'Unavailable' : money(totals.payables ?? totals.accountsPayable, currency)} detail={countValue(counts, 'openBills', 'openBills') + ' unpaid bills'} to="/explorer?type=Bill" icon={FileText} /><Metric label="Customers & suppliers" value={countValue(counts, 'customers', 'Customer') + ' / ' + countValue(counts, 'vendors', 'Vendor')} detail="Inspect the people behind the business" to="/explorer?type=Customer" icon={Users} /><Metric label="Business records through" value={shortDate(business.recordsThrough || company.latestTransactionDate)} detail={number(business.recordCount ?? counts.records) + ' retained business records'} to="/company/manage" icon={Activity} /></div>
    {totals.incompleteCurrency && <p className="bw-notice bw-notice--attention" role="status">Complete balances are unavailable until the company currency and all foreign-currency amounts are verified. Record counts and individual records remain available.</p>}
    <nav className="bw-view-nav" aria-label="Company workspace views">{[['overview', 'Overview'], ['activity', 'Activity & monitoring'], ['directions', 'Directions & controls']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}{key === 'overview' && decisions.length > 0 && <span>{decisions.length}</span>}</button>)}</nav>
    {view === 'overview' && <div className="bw-main-grid"><div className="bw-main-column">
      <Section title="Main accountant" icon={Bot} action={<Badge tone={agentTone}>{status}</Badge>} className="bw-lead-panel"><div className="bw-lead-body"><div className="bw-lead-summary"><span className="bw-agent-avatar"><Bot /></span><div><h3>{active ? textValue(agent.currentWork, 'Managing the whole business') : 'One accountable operator for the whole business'}</h3><p>{agent.summary || (settings.monitoring ? 'Monitoring is available. Enable the accountant to make continuing business decisions and carry out supported work.' : 'Start company monitoring, then give the accountant responsibility for ongoing business activity.')}</p></div></div><div className="bw-agent-times"><div><span>Last business review</span><strong>{agent.lastDecisionAt ? ageLabel(agent.lastDecisionAt, now) : 'Not run yet'}</strong></div><div><span>Next business review</span><strong>{active && agent.nextDecisionAt ? dateTime(agent.nextDecisionAt) : active ? 'Queued by the server' : 'Paused'}</strong></div><div><span>{business.verificationBasis === 'adopted' ? 'History adopted through' : 'Books verified through'}</span><strong>{shortDate(business.verifiedThrough)}</strong></div></div><div className="bw-inline-actions">{!settings.monitoring ? <Button disabled={disabled} onClick={() => setConsent('enable-monitoring')}><RefreshCw />Start monitoring</Button> : active ? <><Button disabled={disabled} onClick={() => onCommand('run-now')}><Play />Review business now</Button><Button variant="outline" disabled={disabled} onClick={() => onCommand('pause')}><Pause />Pause decisions</Button></> : <Button disabled={disabled} onClick={() => hasGrant ? onCommand('resume') : setConsent('enable-autonomy')}><Play />{hasGrant ? 'Resume accountant' : needsRenewal ? 'Renew authority' : 'Enable accountant'}</Button>}<button type="button" className="bw-text-button" onClick={() => setView('directions')}>Give direction<ArrowRight /></button></div><p className="bw-server-note"><ShieldCheck />Runs on the server. Closing this page does not stop enabled monitoring or autonomous operation.</p></div></Section>
      <RecentRecords records={recent} provisional={sync.tone !== 'good'} />
    </div><aside className="bw-side-column">
      <Section title="Decisions & direction" icon={ListChecksIcon} action={decisions.length > 0 && <span className="bw-number-badge">{decisions.length}</span>}>{decisions.length ? <div className="bw-decision-list">{decisions.slice(0, 4).map(decision => <Choice key={decision.id || decision.title} decision={decision} disabled={disabled} onCommand={onCommand} />)}</div> : <div className="bw-clear-state"><CheckCircle2 /><div><strong>No owner decisions waiting</strong><p>The accountant reports here when your direction is needed. You can give instructions at any time.</p></div></div>}<div className="bw-current-direction"><span className="bw-eyebrow">Your standing direction</span><p>{settings.instructions || 'No additional owner instructions saved.'}</p><button type="button" className="bw-text-button" onClick={() => setView('directions')}>{settings.instructions ? 'Edit direction' : 'Give the accountant direction'}<ArrowRight /></button></div></Section>
      <Section title="Accountant's activity" icon={Clock3} action={<button type="button" className="bw-text-button" onClick={() => setView('activity')}>View all<ArrowRight /></button>}><EventList events={events.slice(0, 5)} now={now} /></Section>
      <JourneyLinks />
    </aside></div>}
    {view === 'activity' && <div className="bw-main-grid"><div className="bw-main-column"><RecentRecords records={recent} provisional={sync.tone !== 'good'} /><Section title="Accountant's recorded activity" icon={Clock3} action={<Link to="/audit" className="bw-text-button">Full history<ArrowRight /></Link>}><EventList events={events} now={now} /></Section></div><aside className="bw-side-column"><Section title="Company monitoring" icon={RefreshCw} action={<Button size="sm" variant="outline" disabled={disabled || !settings.monitoring} onClick={() => onCommand('sync-now')}><RefreshCw />Sync now</Button>}><div className="bw-sync-summary"><Badge tone={sync.tone}>{sync.label}</Badge><p>{sync.detail}</p><small>Oldest complete source: {dateTime(data.sync?.lastSuccessAt)}</small></div><div className="bw-source-list">{sync.sources.length ? sync.sources.map(source => <div key={source.entity || source.name}><div><strong>{source.entity || source.name}</strong><span>{source.error || source.lastError || source.reason || (source.lastSuccessAt ? ageLabel(source.lastSuccessAt, now) : 'Awaiting first complete read')}</span></div><span className={'bw-source-state ' + (source.error || ['error', 'blocked', 'saturated'].includes(source.status) ? 'bw-source-state--attention' : '')}>{source.refreshing ? 'Refreshing' : source.status || (source.complete ? 'Complete' : 'Pending')}</span></div>) : <p>No company sources have been observed yet.</p>}</div></Section><SpecialistSummary settings={settings} agent={agent} onOpen={() => setView('directions')} /></aside></div>}
    {view === 'directions' && <div className="bw-main-grid"><div className="bw-main-column"><Section title="Direct the main accountant" icon={Bot}><form className="bw-form" onSubmit={async event => { event.preventDefault(); if (await onCommand('save-instructions', { settings: { instructions } })) setInstructionsDirty(false) }}><label htmlFor="business-instructions">What should the business prioritize?</label><p>Set goals, change priorities or explain a decision. Your saved direction stays with the business across reviews and server restarts.</p><textarea id="business-instructions" rows={7} maxLength={6000} value={instructions} disabled={!owner || !!busy} onChange={event => { setInstructions(event.target.value); setInstructionsDirty(true) }} placeholder="For example: maintain realistic cash flow, keep suppliers paid on time, and build useful examples of partial customer payments." /><div className="bw-form-footer"><span>{instructionsDirty ? 'Unsaved changes' : 'Saved direction'} · {instructions.length.toLocaleString()}/6,000</span><Button disabled={disabled || !instructionsDirty} type="submit">{busy === 'save-instructions' ? <LoaderCircle className="animate-spin" /> : <Check />}Save direction</Button></div></form></Section><Section title="Optional specialist support" icon={Users}><form className="bw-form" onSubmit={async event => { event.preventDefault(); if (await onCommand('configure-specialists', { settings: { specialists } })) setSpecialistsDirty(false) }}><p>Enable a specialist when focused attention is useful. Each monitors its own area and reports to the main accountant, who remains responsible for the whole business.</p><div className="bw-specialist-choices">{SPECIALISTS.map(role => <label key={role.id}><input type="checkbox" checked={specialists.includes(role.id)} disabled={!owner || !!busy} onChange={event => { setSpecialists(value => event.target.checked ? [...value, role.id] : value.filter(id => id !== role.id)); setSpecialistsDirty(true) }} /><span><strong>{role.name}</strong><small>{role.description}</small></span></label>)}</div><div className="bw-form-footer"><span>{specialists.length ? specialists.length + ' specialist areas selected' : 'The main accountant handles all areas'}</span><Button type="submit" disabled={disabled || !specialistsDirty}>Save specialist roles</Button></div></form></Section><Section title="Add business activity yourself" icon={FileText}><BusinessActivityComposer key={Object.values(data.scope || {}).join(':')} scope={data.scope} disabled={disabled} /></Section><Capabilities value={data.capabilities} /></div><aside className="bw-side-column"><Section title="Operating controls" icon={Settings2}><div className="bw-control-stack"><div><strong>Company monitoring</strong><p>{settings.monitoring ? 'The server continues to read QuickBooks when this page is closed.' : 'Start monitoring to maintain a current company view.'}</p><Button size="sm" variant="outline" disabled={disabled} onClick={() => settings.monitoring ? onCommand('stop-monitoring') : setConsent('enable-monitoring')}>{settings.monitoring ? <Pause /> : <RefreshCw />}{settings.monitoring ? 'Stop monitoring & pause work' : 'Start monitoring'}</Button></div><div><strong>Autonomous business operation</strong><p>{active ? 'The main accountant can make continuing decisions and perform supported work under the published rules.' : 'The accountant is paused. Monitoring can continue independently.'}</p><Button size="sm" disabled={disabled || !settings.monitoring} variant={active ? 'outline' : 'default'} onClick={() => active ? onCommand('pause') : hasGrant ? onCommand('resume') : setConsent('enable-autonomy')}>{active ? <Pause /> : <Play />}{active ? 'Pause accountant' : hasGrant ? 'Resume accountant' : needsRenewal ? 'Renew authority' : 'Enable accountant'}</Button></div><div className="bw-server-note"><ShieldCheck />A pause prevents new agent work. Requests already sent keep their saved outcomes.</div></div></Section><Section title="Review frequency" icon={Clock3}><form className="bw-form" onSubmit={async event => { event.preventDefault(); if (await onCommand('configure', { settings: { syncIntervalSeconds: Number(syncInterval), decisionIntervalMinutes: Number(decisionInterval) } })) setCadenceDirty(false) }}><label htmlFor="business-sync-seconds">Check for company changes</label><select id="business-sync-seconds" value={syncInterval} disabled={!owner || !!busy} onChange={event => { setSyncInterval(Number(event.target.value)); setCadenceDirty(true) }}>{[15, 30, 60, 120, 300].map(value => <option key={value} value={value}>Every {value < 60 ? value + ' seconds' : value / 60 + ' minute' + (value > 60 ? 's' : '')}</option>)}</select><label htmlFor="business-review-minutes">Main accountant review</label><select id="business-review-minutes" value={decisionInterval} disabled={!owner || !!busy} onChange={event => { setDecisionInterval(Number(event.target.value)); setCadenceDirty(true) }}>{[5, 15, 30, 60, 120, 240, 1440].map(value => <option key={value} value={value}>Every {value < 60 ? value + ' minutes' : value / 60 + ' hour' + (value > 60 ? 's' : '')}</option>)}</select><p>Work continues in recurring passes. These intervals do not set an end date or lifetime transaction limit.</p><Button type="submit" variant="outline" disabled={disabled || !cadenceDirty}>Save frequency</Button></form></Section><JourneyLinks /></aside></div>}
    {consent && <Consent key={consent} mode={consent} companyName={title} environment={environment || data.scope?.environment} realmId={realmId || data.scope?.realmId} busy={!!busy} error={error} onClose={() => setConsent(null)} onConfirm={after} />}
  </div>
}
function ListChecksIcon(props) { return <CheckCircle2 {...props} /> }
function EventList({ events, now }) { return events.length ? <ol className="bw-event-list">{events.map((event, index) => <li key={event.id || index}><span className={'bw-event-mark ' + (['error', 'blocked', 'attention'].includes(event.status || event.kind) ? 'bw-event-mark--attention' : '')} /><div><div className="bw-event-title"><strong>{event.title || event.summary || event.kind || 'Business activity recorded'}</strong><time dateTime={event.at || event.createdAt}>{ageLabel(event.at || event.createdAt, now)}</time></div>{(event.detail || event.message) && <p>{event.detail || event.message}</p>}<span className="bw-event-meta">{event.role === 'owner' ? 'You' : event.role && !['main', 'accountant'].includes(event.role) ? event.role + ' specialist' : 'Main accountant'}{event.operationId && <> · <Link to="/company/manage">Inspect operation<ArrowRight /></Link></>}</span></div></li>)}</ol> : <Empty title="The accountant's work will appear here">Decisions, completed actions, follow-ups and problems stay in the business history.</Empty> }
function RecentRecords({ records, provisional }) { return <Section title="Recent company activity" icon={Activity} action={<Link to="/explorer" className="bw-text-button">All records<ArrowRight /></Link>}>{records.length ? <><div className="bw-record-list">{records.slice(0, 12).map((record, index) => <Link key={(record.entity || '') + (record.qboId || record.id || index)} to={recordLink(record)}><span className="bw-record-icon"><FileText /></span><div><strong>{record.label || record.name || record.docNumber || record.record?.DocNumber || record.entity || 'Company record'}</strong><span>{record.entity || record.entityType || 'Record'} · {shortDate(record.txnDate || record.transactionDate || record.record?.TxnDate)}{record.deleted ? ' · Deleted in QuickBooks' : record.status ? ' · ' + record.status : ''}</span></div><strong className="bw-record-amount">{record.amount !== undefined && record.amount !== null ? money(record.amount, record.currency || 'CAD') : ''}</strong><ArrowRight /></Link>)}</div>{provisional && <p className="bw-provisional">Company monitoring is still catching up or needs a fresh complete read. These are the most recently retained observations.</p>}</> : <Empty title="Waiting for company activity">Start monitoring to see transactions and changes made in QuickBooks. Existing records are preserved.</Empty>}</Section> }
function SpecialistSummary({ settings, agent, onOpen }) { const roles = settings.specialists || []; return <Section title="Specialist support" icon={Users} action={<button type="button" className="bw-text-button" onClick={onOpen}>Manage<ArrowRight /></button>}>{roles.length ? <div className="bw-specialist-list">{roles.map(id => { const role = SPECIALISTS.find(item => item.id === id), state = (agent.specialists || []).find(item => item.role === id || item.id === id) || {}; return <div key={id}><span className="bw-specialist-avatar"><Users /></span><div><strong>{role?.name || id}</strong><p>{state.summary || role?.description || 'Reports to the main accountant.'}</p><small>{state.status || 'Awaiting its next review'}</small></div></div> })}</div> : <div className="bw-clear-state"><Bot /><div><strong>Main accountant covers every area</strong><p>Add focused specialists when their benefit warrants the extra work.</p></div></div>}</Section> }
function JourneyLinks() { return <nav className="bw-journeys" aria-label="Manage and investigate the business">{[['/company/manage', Settings2, 'Business setup & operations', 'Plans, accounting protections and retained work'], ['/reports', FileText, 'Reports & accounting evidence', 'Inspect the books and related checks'], ['/reproduce', Activity, 'Troubleshoot an issue', 'Start a case in the connected company'], ['/audit', Clock3, 'Business history', 'Inspect saved actions and outcomes']].map(([to, Icon, label, detail]) => <Link key={to} to={to}>{Icon && <Icon />}<span><strong>{label}</strong><small>{detail}</small></span><ArrowRight /></Link>)}</nav> }
function Capabilities({ value }) { const rows = Array.isArray(value) ? value : [...(value?.reads || []), ...(value?.actions || [])]; const boundaries = Array.isArray(value?.boundaries) ? value.boundaries : []; return <Section title="Available business responsibilities" icon={ShieldCheck}><div className="bw-capabilities">{rows.length ? <ul>{rows.map((row, index) => <li key={row.id || row.name || index}><CheckCircle2 /><span>{textValue(row, 'Supported business work')}{typeof row !== 'string' && row.description && <small>{row.description}</small>}</span></li>)}</ul> : <p>Company reads, report inspection and supported business operations use the app's existing accounting tools.</p>}{boundaries.length > 0 && <div className="bw-provisional"><strong>Current operating boundaries</strong><ul>{boundaries.map(boundary => <li key={boundary}>{boundary}</li>)}</ul></div>}</div></Section> }
