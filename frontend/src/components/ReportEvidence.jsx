import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import client from '../api/client'
import { Button } from './ui/button'

const levels = [['availability', 'Opened successfully'], ['population', 'Contains expected data'], ['plausibility', 'Looks plausible'], ['reconciliation', 'Compared related figures']]
const statuses = [['not-checked', 'Not checked'], ['passed', 'Passed — owner checked'], ['failed', 'Failed — owner checked'], ['not-applicable', 'Not applicable — explain why']]
const statusText = Object.fromEntries(statuses)
const hashPattern = /^[a-f0-9]{64}$/
function stable(value) { return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) }
function today() { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value])); return [parts.year, parts.month, parts.day].join('-') }
function OutcomeFields({ name, label, disabled }) {
  return <div className="space-y-1"><label className="block">{label}<select name={name + '.status'} aria-label={label + ' result'} defaultValue="not-checked" disabled={disabled} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2">{statuses.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label className="block text-[var(--ink-2)]">What you observed<textarea name={name + '.note'} aria-label={label + ' evidence note'} rows={2} maxLength={1000} disabled={disabled} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-[var(--ink)]" /></label></div>
}
function CheckForm({ view, busy, onSave, onError }) {
  const [accepted, setAccepted] = useState(false), date = today()
  return <form aria-label="Record a manual report check" className="space-y-4 rounded-lg border border-[var(--line)] p-4" onSubmit={event => {
    event.preventDefault(); const fields = new FormData(event.currentTarget), get = key => String(fields.get(key) || '')
    const checks = Object.fromEntries(levels.map(([key]) => [key, { status: get(key + '.status'), note: get(key + '.note') }]))
    const assertions = view.assertionDefinitions.map((row, index) => ({ key: row.key, status: get('assertion-' + index + '.status'), note: get('assertion-' + index + '.note') }))
    if (fields.get('confirmManual') !== 'yes') return onError('Confirm that these are your own source-based observations.')
    const results = [...Object.values(checks), ...assertions]
    if (results.every(row => row.status === 'not-checked')) return onError('Record at least one result. Not checked stays unknown.')
    if (results.some(row => row.status !== 'not-checked' && row.note.trim().length < 20)) return onError('Explain each checked result or not-applicable choice in at least twenty characters.')
    onSave({ requestKey: crypto.randomUUID(), scopeHash: view.scopeHash, catalogHash: view.catalog.hash, reportKey: view.definition.key,
      period: { fromDate: get('fromDate'), throughDate: get('throughDate') }, basis: get('basis'), filters: get('filters'), observedOn: get('observedOn'), checks, assertions,
      source: { reference: get('reference'), procedure: get('procedure'), finding: get('finding') }, confirmManual: true })
  }}>
    <h3 className="font-semibold">Record your manual check</h3>
    <p className="text-[var(--ink-2)]">Keep the exact dates, basis, filters and evidence you reviewed. These are owner-recorded observations. The app keeps your source reference, not the source file, and does not independently certify bank reconciliation.</p>
    <fieldset disabled={busy} className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-4"><label>Report from<input required type="date" name="fromDate" aria-label="Report from" defaultValue={date.slice(0, 7) + '-01'} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label><label>Report through<input required type="date" name="throughDate" aria-label="Report through" defaultValue={date} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label><label>Accounting basis<select required name="basis" aria-label="Accounting basis" defaultValue="" className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2"><option value="">Choose basis</option><option>Accrual</option><option>Cash</option><option>Not applicable</option></select></label><label>Observed on<input required type="date" name="observedOn" aria-label="Observed on" defaultValue={date} max={date} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label></div>
      <label className="block">Filters and dimensions<input required minLength={3} maxLength={1000} name="filters" aria-label="Filters and dimensions" defaultValue="No additional filters" className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
      <p className="text-[var(--ink-2)]">Leave unobserved levels as Not checked. Each checked outcome, including Not applicable, needs a concrete evidence note.</p>
      <div className="grid gap-4 lg:grid-cols-2">{levels.map(([key, label]) => <OutcomeFields key={key} name={key} label={label} disabled={busy} />)}</div>
      <div className="space-y-3 border-t border-[var(--line)] pt-3"><h4 className="font-semibold">Checks this report needs</h4>{view.assertionDefinitions.map((row, index) => <OutcomeFields key={row.key} name={'assertion-' + index} label={row.text} disabled={busy} />)}</div>
      <label className="block">Evidence reference<input required minLength={3} maxLength={1000} name="reference" aria-label="Evidence reference" placeholder="Report export name, screenshot reference or other retained source" className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label>
      <div className="grid gap-4 lg:grid-cols-2"><label>How I checked<textarea required minLength={20} maxLength={2000} name="procedure" aria-label="How I checked" rows={3} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label><label>What I found<textarea required minLength={30} maxLength={3000} name="finding" aria-label="What I found" rows={3} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label></div>
      <label className="flex items-start gap-2"><input type="checkbox" name="confirmManual" value="yes" checked={accepted} onChange={event => setAccepted(event.target.checked)} />I personally reviewed the stated source and am recording my own observations for this company.</label>
      <Button type="submit" disabled={busy || !accepted}>{busy ? 'Saving manual check…' : 'Save manual report check'}</Button>
    </fieldset>
  </form>
}
function SavedCheck({ row, canRecord, busy, onWithdraw }) {
  const [reason, setReason] = useState(''), [withdrawing, setWithdrawing] = useState(false)
  const request = row.request
  return <details className="break-words rounded-lg border border-[var(--line)] p-3" open>
    <summary className="cursor-pointer font-medium">{row.recorded ? request.observedOn + ' · ' + request.period.fromDate + ' – ' + request.period.throughDate : 'Unconfirmed check request'} · {row.withdrawn ? 'Withdrawn' : 'Owner-recorded'}</summary>
    {!row.recorded ? <div className="mt-2 space-y-1"><p>The unconfirmed request was withdrawn before a manual check was recorded.</p><p>{request.period.fromDate} – {request.period.throughDate} · {request.basis} · {request.filters}</p><p>Request source reference: {request.source.reference}</p></div> : <div className="mt-3 space-y-3">
      <p className="text-[var(--ink-2)]">Retained catalog {row.catalog.version} · catalog dated {row.catalog.asOfDate} · report definition documented {row.definition.lastVerified}.</p>
      <p className="text-[var(--ink-2)]">{request.basis} · {request.filters} · recorded {new Date(row.recordedAt).toLocaleString()}{!row.definitionCurrent && ' · Historical report definition'}</p>
      {row.withdrawn && <p>This check was withdrawn. Its original results below are retained as history.</p>}
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">{levels.map(([key, label]) => <div key={key}><dt className="text-[var(--ink-2)]">{label}</dt><dd>{statusText[request.checks[key].status]}</dd><dd className="mt-1">{request.checks[key].note}</dd></div>)}</dl>
      <div>{request.assertions.map((value, index) => <p key={value.key} className="mt-2">{row.definition.assertions[index]} <strong>{statusText[value.status]}</strong>{value.note && ' · ' + value.note}</p>)}</div>
      <dl className="space-y-2"><div><dt className="font-medium">Evidence reference</dt><dd className="whitespace-pre-wrap break-words">{request.source.reference}</dd></div><div><dt className="font-medium">How the owner checked</dt><dd className="whitespace-pre-wrap break-words">{request.source.procedure}</dd></div><div><dt className="font-medium">Owner finding</dt><dd className="whitespace-pre-wrap break-words">{request.source.finding}</dd></div></dl>
      <p className="text-[var(--ink-2)]">{row.limitation} Recorded sources may have changed since this observation.</p>
    </div>}
    {row.withdrawal && <p className="mt-3">Withdrawn {new Date(row.withdrawal.recordedAt).toLocaleString()}: {row.withdrawal.reason}</p>}
    {canRecord && row.recorded && !row.withdrawn && <div className="mt-3">{!withdrawing ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setWithdrawing(true)}>Withdraw this manual check</Button> : <form className="space-y-2" onSubmit={event => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get('reason') || ''); if (value.trim().length >= 20) onWithdraw(request, value, row.definition.name) }}><label className="block">Why I am withdrawing this check<textarea required minLength={20} maxLength={2000} name="reason" value={reason} onChange={event => setReason(event.target.value)} disabled={busy} className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2" /></label><Button disabled={busy || reason.trim().length < 20} variant="outline" type="submit">Confirm withdrawal of manual check</Button></form>}</div>}
  </details>
}
export default function ReportEvidence({ report, realmId, environment, connectionId, actorId, enabled, onChooseReport, api = client, storage = sessionStorage }) {
  const [view, setView] = useState(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, setPending] = useState(null), [recoveryBlocked, setRecoveryBlocked] = useState(false)
  const active = useRef(false), sending = useRef(false), controller = useRef(null), loadGeneration = useRef(0), result = useRef(null), failure = useRef(null)
  const invalidateLoad = useCallback(() => { loadGeneration.current++ }, [])
  const key = ['manual-report-v1', actorId, environment, realmId, connectionId].join(':')
  const bound = useCallback(value => { if (!value || value.realmId !== realmId || value.environment !== environment || value.connectionId !== connectionId) throw new Error('The selected company changed. Reload Reports before continuing.'); return value }, [realmId, environment, connectionId])
  const load = useCallback(async (after, signal) => {
    const generation = ++loadGeneration.current
    if (active.current) setLoading(true)
    try {
      const response = await api.get('/company/report-evidence', { params: { reportKey: report.key, ...(after ? { after } : {}) }, signal, timeout: 15000 }), value = bound(response.data?.data)
      if (value.definition && value.definition.key !== report.key) throw new Error('The selected report changed. Reload its definition.')
      if (active.current && generation === loadGeneration.current && !signal?.aborted) setView(value)
    } catch (failure) { if (active.current && generation === loadGeneration.current && !signal?.aborted) { setView(null); setError(failure.response?.data?.error || failure.message || 'Saved manual checks could not be confirmed.') } }
    finally { if (active.current && generation === loadGeneration.current) setLoading(false) }
  }, [api, bound, report.key])
  useEffect(() => {
    active.current = true; const initial = new AbortController()
    try { const saved = storage.getItem(key); if (saved) { const value = JSON.parse(saved); if (value.version !== 1 || value.scope?.realmId !== realmId || value.scope?.environment !== environment || value.scope?.connectionId !== connectionId || !value.request?.requestKey || !hashPattern.test(value.request.scopeHash || '')) throw new Error('The unconfirmed manual check could not be read. Inspect saved report history before relying on it.'); if (value.action && !['save', 'withdraw'].includes(value.action)) throw new Error('The saved manual action could not be read.'); if (value.action === 'withdraw' && (typeof value.reason !== 'string' || value.reason.trim().length < 20)) throw new Error('The saved withdrawal needs recovery.'); setPending({ request: value.request, action: value.action || 'save', reason: value.reason || null, reportName: typeof value.reportName === 'string' ? value.reportName.slice(0, 500) : value.request.reportKey }) } }
    catch (failure) { setRecoveryBlocked(true); setError(failure.message) }
    if (enabled) load(undefined, initial.signal)
    return () => { active.current = false; initial.abort(); controller.current?.abort(); invalidateLoad() }
  }, [enabled, load, key, storage, realmId, environment, connectionId, invalidateLoad])
  useEffect(() => { const target = error ? failure.current : notice ? result.current : null; target?.focus(); target?.scrollIntoView({ block: 'nearest' }) }, [error, notice])
  const act = async work => {
    if (sending.current) return
    sending.current = true; setBusy(true); setError(''); setNotice(''); controller.current = new AbortController()
    try { await work(controller.current.signal) }
    catch (failure) { if (active.current) { setView(null); setError(failure.response?.data?.error || failure.message || 'The manual check could not be confirmed. Retry its exact saved request.'); await load(undefined, controller.current.signal) } }
    finally { sending.current = false; if (active.current) setBusy(false) }
  }
  const keep = (request, action = 'save', reason = null, reportName) => { const name = reportName || (view?.definition?.key === request.reportKey ? view.definition.name : pending?.reportName) || request.reportKey; storage.setItem(key, JSON.stringify({ version: 1, scope: { realmId, environment, connectionId }, request, action, reason, reportName: name })); setPending({ request, action, reason, reportName: name }) }
  const finish = async (value, request, signal, withdrawalExpected = false) => {
    bound(value)
    if (typeof value.withdrawn !== 'boolean' || (withdrawalExpected && value.withdrawn !== true) || !hashPattern.test(value.requestHash || '') || stable(value.request) !== stable(request) || !((value.recorded === true && hashPattern.test(value.evidenceHash || '')) || (value.recorded === false && value.withdrawn === true)) || (value.withdrawn === true && !hashPattern.test(value.withdrawal?.decisionHash || ''))) throw new Error('The exact saved manual decision could not be confirmed.')
    storage.removeItem(key)
    if (active.current) { setPending(null); setNotice(value.withdrawn ? value.recorded ? 'Manual check withdrawn. Its original source and results remain in history.' : 'Unconfirmed manual check withdrawn. It will not be recorded later.' : 'Manual check saved as owner-recorded evidence.'); await load(undefined, signal) }
  }
  const save = request => act(async signal => { keep(request); const response = await api.post('/company/report-evidence', request, { signal, timeout: 20000 }); await finish(response.data?.data, request, signal) })
  const withdraw = (request, reason, reportName) => act(async signal => { keep(request, 'withdraw', reason, reportName); const response = await api.post('/company/report-evidence/withdraw', { request, reason }, { signal, timeout: 20000 }); await finish(response.data?.data, request, signal, true) })
  const definition = view?.definition || report
  return <section aria-label="Selected report and evidence" className="space-y-4 text-[13px]">
    <div className="space-y-2"><h2 className="text-[18px] font-semibold">{definition.name}</h2><p>{definition.businessQuestion}</p><p className="text-[var(--ink-2)]">Definition documented {definition.lastVerified}. The definition describes how to check this report. Company evidence is kept below.</p>{definition.uiNavigation && <p className="rounded border border-[var(--line)] bg-[var(--sunken)] p-3">Manual procedure: {definition.uiNavigation}</p>}
      <details><summary className="cursor-pointer font-medium">What this report needs</summary><div className="mt-2 space-y-2">{Object.entries(definition.prerequisites).filter(([, values]) => values.length).map(([key, values]) => <p key={key}><strong>{key[0].toUpperCase() + key.slice(1)}:</strong> {values.join(', ')}</p>)}<p><strong>Expected data:</strong> {definition.expectedNonZero.join(', ')}</p><p><strong>Checks:</strong> {definition.assertions.join(' ')}</p></div></details>
      <Link to="/company/reports" className="inline-block font-medium text-[var(--link)] underline">Open the seven critical book checks</Link>
    </div>
    {!enabled && <p>Connect a company to read or record its manual evidence. The report definitions remain available.</p>}
    {enabled && <>
      {view && <p className="text-[var(--ink-2)]">Current catalog {view.catalog.version} · dated {view.catalog.asOfDate}.</p>}
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Saved checks and decisions</h3><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => { setError(''); load() }}>Refresh saved checks</Button></div>
      {error && <p role="alert" ref={failure} tabIndex={-1} className="scroll-mt-20 text-[var(--danger-ink)]">{error}</p>}
      {notice && <p role="status" ref={result} tabIndex={-1} className="scroll-mt-20">{notice}</p>}
      {loading ? <p role="status">Reading saved manual checks…</p> : view && <div className="space-y-3">
        <p className="text-[var(--ink-2)]">{view.companyName} · {environment} · {realmId}. Saved status read {new Date(view.readAt).toLocaleString()}. These manual records do not automatically change coverage or protected accounting dates.</p>
        {view.items.map(row => <SavedCheck key={row.id} row={row} canRecord={view.canRecord && !pending && !recoveryBlocked} busy={busy} onWithdraw={withdraw} />)}
        {!view.items.length && <p>{view.historyComplete ? 'No manual checks or withdrawal decisions were found in this saved history.' : 'No matching checks in this portion of history. Earlier checks may remain.'}</p>}
        <div className="flex flex-wrap gap-2">{view.next && <Button size="sm" variant="outline" disabled={busy} onClick={() => load(view.next)}>Read older saved history</Button>}{view.next && <p className="self-center text-[var(--ink-2)]">Earlier history remains unsearched.</p>}</div>
      </div>}
      {recoveryBlocked ? <p>Recover the saved browser request before sending another manual check.</p> : pending ? <div className="space-y-3 rounded-lg border border-[var(--line)] p-4"><h3 className="font-semibold">Unconfirmed manual check: {pending.reportName || pending.request.reportKey}</h3><p>{view?.companyName || 'Selected company'} · {environment} · {realmId}</p><p>{pending.request.period.fromDate} – {pending.request.period.throughDate} · {pending.request.basis} · {pending.request.filters}</p><p className="text-[var(--ink-2)]">Observed {pending.request.observedOn} · Catalog entry {pending.request.reportKey}</p>{pending.request.reportKey !== report.key && onChooseReport && <Button variant="outline" size="sm" onClick={() => onChooseReport(pending.request.reportKey)}>Open the pending report</Button>}<p>{pending.action === 'withdraw' ? 'The withdrawal was not confirmed. Retry its exact saved decision.' : 'The previous manual check was not confirmed. Retry its exact saved request or withdraw it.'} Source: {pending.request.source?.reference}</p>{view && !view.canRecord && <p>{view.blockReason}</p>}<div className="flex flex-wrap gap-2">{pending.action === 'withdraw' ? <Button disabled={busy || !view?.canRecord} variant="outline" onClick={() => withdraw(pending.request, pending.reason, pending.reportName)}>Retry exact withdrawal</Button> : <><Button disabled={busy || !view?.canRecord} variant="outline" onClick={() => save(pending.request)}>Retry exact manual check</Button><Button disabled={busy || !view?.canRecord} variant="outline" onClick={() => withdraw(pending.request, 'Owner withdrew this unconfirmed manual check from the Reports screen before relying on it.', pending.reportName)}>Withdraw unconfirmed manual check</Button></>}</div></div> : view?.canRecord ? <CheckForm key={view.definitionHash} view={view} busy={busy || loading} onSave={save} onError={setError} /> : view && <p className="text-[var(--ink-2)]">{view.blockReason} <Link to="/company/setup" className="text-[var(--link)] underline">Company preparation</Link></p>}
    </>}
  </section>
}
