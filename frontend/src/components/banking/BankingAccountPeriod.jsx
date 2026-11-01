import { useEffect, useRef, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { Button } from '../ui/button'
import { bankingApi, bankingError, bankingPeriodState, bankingEvidenceEntries, bankingOperatorStatus, bankMoney } from '../../api/banking'

function EvidenceCard({ entry }) {
  const terra = entry.automation
  return <li className="banking-evidence-card">
    <div className="banking-heading"><strong>{entry.stage}</strong><span className="banking-stage">{terra ? 'Terra-reported · ' : ''}{entry.strength || 'Evidence label unavailable'}</span></div>
    <p>{entry.note || 'No observation note retained.'}</p>
    {terra && <p><strong>Run {terra.runId}</strong> · {terra.step} · {terra.outcome}<br /><span className="banking-muted">The run supplied this observation. It has not been independently verified here.</span></p>}
    {entry.observedAt && <p className="banking-muted">Observed at {entry.observedAt}{entry.recordedAt ? ' · Recorded ' + entry.recordedAt : ''}</p>}
    {entry.artifact && <details><summary>{terra ? 'Screenshot reference and SHA-256' : 'Retained artifact reference and SHA-256'}</summary><code>{entry.artifact.path}</code><code>{entry.artifact.sha256}</code><p className="banking-muted">This API retains the reference but does not serve evidence images. Screenshot preview is unavailable here.</p></details>}
    {entry.recordHash && <code>Synced record SHA-256: {entry.recordHash}</code>}
  </li>
}

function PackageFiles({ pkg, api, stale }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [preview, setPreview] = useState(null)
  const urls = useRef(new Set()), alive = useRef(true)
  useEffect(() => {
    const retained = urls.current
    alive.current = true
    return () => { alive.current = false; for (const url of retained) URL.revokeObjectURL(url); retained.clear() }
  }, [])
  async function open(file, inline = false) {
    setBusy(file.fileId); setError('')
    try {
      const blob = await api.file(pkg.id, file)
      if (!alive.current) return
      const url = URL.createObjectURL(blob); urls.current.add(url)
      if (inline) {
        if (preview) { URL.revokeObjectURL(preview); urls.current.delete(preview) }
        setPreview(url)
      } else {
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = 'banking-' + pkg.accountId + '-' + pkg.period + '-v' + pkg.revision + '-' + file.fileId.replace(/[^A-Za-z0-9_-]/g, '_') + ({ csv: '.csv', statement: '.pdf', manifest: '.json' }[file.kind] || '')
        document.body.appendChild(anchor); anchor.click(); anchor.remove()
        setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url) }, 1000)
      }
    } catch (failure) { if (alive.current) setError(bankingError(failure)) }
    finally { if (alive.current) setBusy('') }
  }
  const files = pkg.snapshot.files || []
  return <section className="banking-block"><h4>Package files</h4>
    <p className="banking-muted">Simulated statements and exact import files, version {pkg.revision}. File hashes are checked on download.</p>
    {error && <p role="alert" className="banking-warning">{error} Try the download again after refreshing.</p>}
    <ul className="banking-files">{files.map(file => <li key={file.fileId}>
      <div><strong>{file.kind === 'csv' ? 'Import CSV · ' + file.rowCount + ' rows' : file.kind === 'statement' ? 'Simulated statement · PDF' : 'Row crosswalk · JSON'}</strong><small>{file.fileId}</small></div>
      <Button variant="outline" disabled={Boolean(busy) || stale} onClick={() => open(file)} aria-label={'Download ' + file.fileId}><Download size={14} aria-hidden="true" />Download</Button>
      {file.kind === 'statement' && <Button variant="outline" disabled={Boolean(busy) || stale} onClick={() => open(file, true)}><FileText size={14} aria-hidden="true" />Preview</Button>}
      <details><summary>SHA-256</summary><code>{file.sha256}</code></details>
    </li>)}</ul>
    {busy && <p role="status">Loading and checking {busy}…</p>}
    {preview && <div className="banking-preview"><div className="banking-heading"><strong>Simulated statement — Test Data Lab</strong><Button variant="outline" onClick={() => { URL.revokeObjectURL(preview); urls.current.delete(preview); setPreview(null) }}>Close preview</Button></div><iframe src={preview} title={'Simulated statement for account ' + pkg.accountId + ', ' + pkg.period} /><p className="banking-muted">If the PDF viewer is unavailable, use Download.</p></div>}
  </section>
}

export function BankingAccountPeriodView({ pkg, accountName, api = bankingApi, stale = false, operatorStatus }) {
  const [rowPage, setRowPage] = useState(0), [evidenceCount, setEvidenceCount] = useState(12)
  const operator = bankingOperatorStatus(pkg, operatorStatus)
  const state = bankingPeriodState(pkg), summary = pkg.summary || {}, evidence = pkg.evidence || {}, snapshot = pkg.snapshot
  const rows = snapshot.rows || [], events = new Map((snapshot.events || []).map(event => [event.eventId, event]))
  const entries = bankingEvidenceEntries(pkg), uncertain = (evidence.imports || []).filter(run => ['started', 'interrupted'].includes(run.status))
  const resolved = (summary.matched || 0) + (summary.added || 0) + (summary.excluded || 0)
  return <article className="banking-period" aria-label={accountName + ' ' + pkg.period + ' banking details'}>
    <header className="banking-heading"><div><h3>{accountName} · {pkg.period}</h3><p>#{pkg.accountId} · {pkg.accountCurrency} · Package v{pkg.revision} · {snapshot.balanceConvention === 'card-amount-owed' ? 'Card amount owed' : 'Bank balance'}</p></div><span className="banking-stage">{state.needsReview ? 'History needs review' : state.blockers.length ? 'Blocked' : summary.reconciled ? 'Completion evidence retained' : 'Work remaining'}</span></header>
    <dl className="banking-stages">{state.stages.map(stage => <div key={stage.key}><dt>{stage.label}</dt><dd className={stage.done ? 'banking-complete' : ''}>{stage.value}</dd></div>)}</dl>
    <div className="banking-balances"><span>Opening <strong>{bankMoney(snapshot.openingMinor, pkg.accountCurrency)}</strong></span><span>Closing <strong>{bankMoney(snapshot.closingMinor, pkg.accountCurrency)}</strong></span><span>Matched {summary.matched || 0} · Added {summary.added || 0} · Excluded {summary.excluded || 0} · Unresolved {summary.pending || 0}</span></div>
    {state.needsReview && <div className="banking-notice" role="status">A revision changed this history. Existing evidence is retained; check this month and later balances before more native work.{evidence.supersededBy && <code>Replaced by package {evidence.supersededBy}</code>}</div>}
    {uncertain.length > 0 && <div className="banking-notice" role="status"><strong>Interrupted import: inspect QuickBooks before any retry.</strong><p>Do not upload the same file again until its native outcome is known. Confirm the exact account, file hash and row count; retain the existing attempt.</p>{uncertain.map(run => <p key={run.attemptId}>Attempt {run.attemptId} · {run.status} · {run.fileId}<code>{run.fileHash}</code></p>)}</div>}
    {state.blockers.length > 0 && <section className="banking-notice"><h4>Blocked reasons · {state.blockers.length}</h4><ul>{state.blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul></section>}
    <div className="banking-detail-grid">
      <PackageFiles pkg={pkg} api={api} stale={stale} />
      <section className="banking-block"><h4>Next: {pkg.nextAction || 'Inspect native evidence'}</h4><ol className="banking-checklist">
        <li>Confirm the connected company, account #{pkg.accountId}, {pkg.accountCurrency}, opening balance and existing QuickBooks history.</li>
        <li>{summary.uploadRequired === false ? 'No CSV upload required: this month has no import rows. Keep the carried-balance statement.' : uncertain.length ? 'Recover the unfinished import using its existing attempt and native confirmation.' : summary.uploaded ? 'Exact import confirmed in retained evidence.' : 'Upload each exact CSV once; verify signs, dates and row counts in the native preview.'}</li>
        <li>Review and resolve every imported row: {summary.reviewed || 0} reviewed; {resolved} of {state.total} resolved. Match existing entries, Add only designated bank-origin items, Exclude duplicates with a reason.</li>
        <li>Resolve blockers and explain outstanding items. Never force a balancing adjustment.</li>
        <li>Reconcile at zero difference. Retain the completed native report, completion screen and statement-attachment evidence.</li>
      </ol><p className="banking-muted">This checklist shows the native work required. Completion comes from retained evidence.</p></section>
    </div>
    {(evidence.imports || []).length > 0 && <section className="banking-block"><h4>Import attempts</h4><ul>{evidence.imports.map(run => <li key={run.attemptId}><strong>{run.attemptId} · {run.status}</strong><p>{run.fileId} · #{run.accountId} · {run.accountCurrency} · Recorded native count: {run.observedCount ?? 'not confirmed'}</p>{run.nativeConfirmation && <p>{run.nativeConfirmation}</p>}</li>)}</ul></section>}
    <section className="banking-block"><h4>Row decisions and exceptions</h4>
      {!rows.length ? <p>No import rows in this package. Inspect any blockers and the statement before reconciliation.</p> : <>
        <div className="banking-table-scroll" tabIndex={0} aria-label="Banking row decisions"><table className="banking-table banking-row-table"><thead><tr><th scope="col">Source / row</th><th scope="col">Posting / amount</th><th scope="col">Expected / creator</th><th scope="col">Decision / reason</th><th scope="col">Outcome / QuickBooks references</th></tr></thead><tbody>{rows.slice(rowPage * 20, (rowPage + 1) * 20).map(row => {
          const event = events.get(row.eventId) || {}, record = evidence.rows?.[row.rowId] || {}, action = ['matched', 'added', 'excluded'].find(key => record[key]), outcome = record[action]
          return <tr key={row.rowId}><th scope="row">{event.source?.entity || event.source?.type || 'Source'} #{event.source?.id || event.source?.transactionId || 'unavailable'}<small>{row.rowId} · CSV row {row.rowNumber}</small><details><summary>Event reference</summary><code>{row.eventId}</code></details></th><td>{event.actualPostingDate || event.expectedPostingDate}<small>{bankMoney(event.amountMinor, pkg.accountCurrency)}</small></td><td>{event.expectedResolution || event.resolution?.action}<small>{event.resolution?.designatedCreator || event.creator}</small></td><td>{record.reviewed?.decision || 'Not reviewed'}<small>{record.reviewed?.reason || ''}</small></td><td>{action || 'Unresolved'}{outcome?.reason && <small>{outcome.reason}</small>}{(outcome?.qboRefs || []).map(ref => <small key={ref.entity + ref.id}>{ref.entity} #{ref.id}</small>)}{record.synced?.length > 0 && <small>Synced record observed</small>}</td></tr>
        })}</tbody></table></div>
        {rows.length > 20 && <div className="banking-pagination"><span>Rows {rowPage * 20 + 1}–{Math.min((rowPage + 1) * 20, rows.length)} of {rows.length}</span><Button variant="outline" disabled={rowPage === 0} onClick={() => setRowPage(rowPage - 1)}>Previous rows</Button><Button variant="outline" disabled={(rowPage + 1) * 20 >= rows.length} onClick={() => setRowPage(rowPage + 1)}>Next rows</Button></div>}
      </>}
    </section>
    {(snapshot.outstandingItems || []).length > 0 && <details className="banking-block"><summary>Outstanding items · {snapshot.outstandingItems.length}</summary><p className="banking-muted">Retained timing and unresolved items; these are not balancing entries.</p><ul className="banking-outstanding">{snapshot.outstandingItems.map((item, index) => <li key={item.eventId || index}><strong>{(item.kind || 'Outstanding item').replaceAll('-', ' ')} · {bankMoney(item.amountMinor, item.currency || pkg.accountCurrency)}</strong><p>Book date {item.bookDate || 'unavailable'} · Expected posting {item.expectedPostingDate || 'not scheduled'}</p>{item.reason && <p>{item.reason}</p>}<code>{item.entity ? item.entity + ' #' + item.id : item.eventId}</code></li>)}</ul></details>}
    <section className="banking-block"><h4>Native operator runs</h4>
      {!operator ? <p className="banking-muted">Independent run verification is unavailable. BF4 screenshot labels below remain recorded claims until the operator journal is connected.</p> : <>
        {operator.blocked && <div className="banking-notice"><strong>Banking operator blocked</strong><ul>{(operator.reasons || []).map((reason, index) => <li key={index}>{reason.period} · {reason.runId} · {reason.status}: {reason.reason}</li>)}</ul></div>}
        {!operator.steps.length ? <p>No native runs recorded for this account-month.</p> : <ul className="banking-evidence">{operator.steps.map(run => <li key={run.runId} className="banking-evidence-card"><div className="banking-heading"><strong>{run.step?.type || 'Native step'} · {run.status}</strong><span className={'banking-stage' + (run.verification?.status === 'observed' ? ' banking-stage--done' : '')}>{run.verification?.status === 'observed' ? 'Observed' : 'Terra-reported only'}</span></div><p>Run {run.runId} · {run.finishedAt || run.startedAt}</p>{run.reason && <p className="banking-warning">{run.reason}</p>}{run.verification?.basis && <p>{run.verification.basis}</p>}{(run.verification?.checks || []).map((check, index) => <p key={index}>{check.rowId} · {check.status} · {check.basis}</p>)}{[run.screen?.artifact, run.report?.artifact, run.completion?.artifact, run.stopArtifact].filter(Boolean).map((artifact, index) => <details key={index}><summary>Retained screenshot / report reference</summary><code>{artifact.path}</code><code>{artifact.sha256}</code></details>)}</li>)}</ul>}
      </>}
    </section>
    <section className="banking-block"><h4>Terra runs and observed evidence</h4><p className="banking-muted">“Terra-reported” identifies a run’s saved claim, including its screen-observed label. It is distinct from a synced record observation or retained native report. Saving a screenshot reference does not independently verify its contents.</p>
      {entries.length ? <><ul className="banking-evidence">{entries.slice(0, evidenceCount).map((entry, index) => <EvidenceCard entry={entry} key={index} />)}</ul>{entries.length > evidenceCount && <Button variant="outline" onClick={() => setEvidenceCount(evidenceCount + 12)}>Show more evidence ({entries.length - evidenceCount} remaining)</Button>}</> : <p>No native run evidence retained for this package. Generation alone does not confirm upload, review or reconciliation.</p>}
    </section>
    <details className="banking-block"><summary>Package provenance and revisions</summary><p>Package {pkg.id} · Evidence version {pkg.stateVersion}</p><p>Policy: {snapshot.policyVersion}</p><code>Source snapshot SHA-256: {snapshot.sourceSnapshotHash}</code><code>Content SHA-256: {pkg.contentHash}</code>{pkg.previousPackageId && <code>Previous package: {pkg.previousPackageId}</code>}</details>
  </article>
}

export default function BankingAccountPeriod({ packageSummary, accountName, api = bankingApi, refreshKey, stale = false, operatorStatus }) {
  const [load, setLoad] = useState({ pkg: null, error: '', loading: true }), [retry, setRetry] = useState(0)
  const id = packageSummary.id
  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve().then(() => { if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: true, error: '' })) })
    api.detail(id, { signal: controller.signal }).then(pkg => {
      if (!controller.signal.aborted) setLoad({ pkg, loading: false, error: '' })
    }).catch(error => { if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: false, error: bankingError(error) })) })
    return () => controller.abort()
  }, [api, id, refreshKey, retry])
  return <div aria-busy={load.loading}>
    {load.loading && <p role="status" className="banking-notice">Loading {accountName} · {packageSummary.period} files and evidence…</p>}
    {load.error && <p role="alert" className="banking-notice banking-notice--error">{load.pkg ? 'Evidence may be out of date. ' : ''}{load.error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry details</button></p>}
    {load.pkg && <BankingAccountPeriodView key={id} pkg={load.pkg} accountName={accountName} api={api} operatorStatus={operatorStatus} stale={stale || load.loading || Boolean(load.error)} />}
  </div>
}
