import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import client from '../api/client'
import { dateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'

const labels = {
  support_case: 'Support case', assistant: 'Assistant plan', generation: 'Historical generation',
  business_operation: 'Business operation', legacy_generation: 'Historical generation', seed: 'Master-data setup', issue_pack: 'Issue pack',
}

export default function RecordOrigin({ type, id, realmId, environment }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    client.get('/explore/' + type + '/' + encodeURIComponent(id) + '/origin', { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        if (data.scope?.realmId !== realmId || data.scope?.environment !== environment) throw new Error('Company changed')
        setResult(data)
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [type, id, realmId, environment, attempt])
  const retry = () => { setResult(null); setError(false); setAttempt(value => value + 1) }
  return <section aria-label="Record creation history" className="rounded-lg border border-[var(--line)] bg-[var(--surface-muted)] p-3">
    <h3 className="mb-2 text-[12px] font-medium uppercase tracking-[0.04em] text-[var(--ink-3)]">Created through this app</h3>
    {error ? <div className="text-[12.5px] text-[var(--danger-ink)]">Creation history could not be checked. <Button size="xs" variant="ghost" onClick={retry}>Retry history</Button></div>
      : !result ? <p role="status" className="text-[12.5px] text-[var(--ink-2)]">Checking saved creation receipts…</p>
        : <>
          {!result.complete && <p className="mb-2 text-[12.5px] text-[var(--danger-ink)]">Some history could not be checked completely. <Button size="xs" variant="ghost" onClick={retry}>Retry history</Button></p>}
          {!result.sources.length && <p className="text-[12.5px] text-[var(--ink-2)]">{result.complete ? 'No matching app creation receipt was found. Its origin is unknown.' : 'No match was found in the history available so far.'}</p>}
          {result.sources.length > 0 && <ul className="max-h-64 space-y-3 overflow-y-auto text-[12.5px]">
            {result.sources.map((source, index) => <li key={source.kind + ':' + source.sourceId + ':' + index}>
              <div className="font-medium text-[var(--ink)]">{source.caseId ? <Link className="text-[var(--link)] hover:underline" to={'/cases/' + source.caseId}>{labels[source.kind]}</Link> : labels[source.kind] || 'App receipt'}{source.step ? ' · step ' + source.step : ''}</div>
              <p className="text-[var(--ink-2)]">{source.scope === 'recorded_environment' ? 'Creation recorded in this company and environment.' : 'Historical match; the environment was not recorded.'}</p>
              {source.operationId && <p className="break-all text-[12px] text-[var(--ink-3)]">Operation {source.operationId}</p>}
              {source.createdAt && <p className="text-[var(--ink-3)]">{dateTime(source.createdAt)}</p>}
            </li>)}
          </ul>}
          <p className="mt-2 text-[12px] text-[var(--ink-3)]">Business baseline: not classified. Creation history does not establish that this record belongs in the continuing business.</p>
        </>}
  </section>
}
