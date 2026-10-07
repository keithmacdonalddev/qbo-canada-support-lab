import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { assertBaselineScope } from '../lib/business-baseline-request.mjs'
const labels = { matches: 'Matches capture', 'different-version': 'Version differs from capture', 'different-content': 'Contents differ from capture', 'not-returned': 'No current record returned' }
const sourceLabels = { business_operation: 'Business operation', support_case: 'Support reproduction', assistant: 'Assistant plan', generation: 'Generation', legacy_generation: 'Older generation', seed: 'Setup', issue_pack: 'Issue pack' }
const reason = error => error.response?.data?.error || error.message || 'Captured records could not be reviewed.'
function assertEvidence(value, baseline, entity) {
  assertBaselineScope(value, baseline.scope.realmId, baseline.scope.environment, baseline.scope.connectionId)
  if (value.baselineId !== baseline.id || value.evidenceHash !== baseline.evidenceHash || value.inventoryHash !== baseline.inventory.sourceHash || value.entity !== entity) throw new Error('The inventory response belongs to different evidence. Reload this observation.')
  return value
}
export default function BusinessInventoryReview({ baseline, api }) {
  const [entity, setEntity] = useState(() => baseline.inventory.entities.find(row => row.count)?.entity || baseline.inventory.coverage[0])
  return <section aria-label="Review captured records" className="mt-4 border-t border-[var(--line)] pt-3">
    <h4 className="font-semibold">Review captured records</h4>
    <p className="mt-1 text-[var(--ink-2)]">Compare a captured record with its current QuickBooks version and check its creation history. Records remain unclassified for the continuing business.</p>
    <label className="mt-3 block">Record type<select aria-label="Captured record type" value={entity} onChange={event => setEntity(event.target.value)} className="ml-3 rounded border border-[var(--line)] bg-[var(--surface)] p-2">{baseline.inventory.coverage.map(type => <option key={type} value={type}>{type.replace(/([a-z])([A-Z])/g, '$1 $2')}</option>)}</select></label>
    <InventoryTypeReview key={[baseline.id, baseline.evidenceHash, entity].join(':')} baseline={baseline} entity={entity} api={api} />
  </section>
}
function InventoryTypeReview({ baseline, entity, api }) {
  const [page, setPage] = useState(null), [cursors, setCursors] = useState([null]), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const [review, setReview] = useState(null), [busy, setBusy] = useState(null)
  const active = useRef(true), request = useRef(null), resultHeading = useRef(null)
  const after = cursors.at(-1), base = '/company/business-baseline/' + baseline.id + '/inventory'
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setPage(null); setError('')
    api.get(base, { params: { entity, limit: 20, ...(after ? { after } : {}) }, signal: controller.signal, timeout: 30000 }).then(response => {
      if (controller.signal.aborted) return
      const value = assertEvidence(response.data?.data, baseline, entity)
      if (!Array.isArray(value.records) || value.records.length > 20 || !Number.isSafeInteger(value.total) || value.total < value.records.length || value.records.some(row => !/^\d{1,30}$/.test(row.id || '') || typeof row.syncToken !== 'string') || new Set(value.records.map(row => row.id)).size !== value.records.length || (value.next !== null && typeof value.next !== 'string')) throw new Error('The captured record page is incomplete.')
      setPage(value)
    }).catch(failure => { if (!controller.signal.aborted) setError(reason(failure)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, base, baseline, entity, after, revision])
  useEffect(() => { if (review) resultHeading.current?.focus() }, [review])
  async function compare(id) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    setBusy(id); setReview(null); setError('')
    try {
      const response = await api.get(base + '/' + entity + '/' + id, { signal: controller.signal, timeout: 75000 })
      if (!active.current || controller.signal.aborted) return
      const value = assertEvidence(response.data?.data, baseline, entity)
      if (value.id !== id || value.captured?.id !== id || !Object.hasOwn(labels, value.comparison) || value.writeAllowed !== false || value.ownership !== 'unclassified') throw new Error('The record comparison could not be confirmed.')
      setReview(value)
    } catch (failure) { if (active.current && !controller.signal.aborted) setError(reason(failure)) }
    finally { if (active.current && !controller.signal.aborted) setBusy(null) }
  }
  function move(next) { request.current?.abort(); setBusy(null); setReview(null); setCursors(next) }
  return <div className="mt-3">
    {loading ? <p role="status">Loading captured records…</p> : page && <>
      <p className="text-[var(--ink-3)]">{page.total.toLocaleString()} captured {entity.replace(/([a-z])([A-Z])/g, '$1 $2')} records · Captured {new Date(page.observedAt).toLocaleString()}</p>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><thead><tr className="text-[var(--ink-3)]"><th className="py-2 font-medium">QuickBooks ID</th><th className="font-medium">Captured version</th><th className="font-medium">Captured status or date</th><th><span className="sr-only">Compare</span></th></tr></thead><tbody>{page.records.map(row => <tr key={row.id} className="border-t border-[var(--line)]"><td className="py-2">{row.id}</td><td>{row.syncToken}</td><td>{row.active === undefined ? row.transactionDate : row.active ? 'Active' : 'Inactive'}</td><td><Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => compare(row.id)}>{busy === row.id ? 'Checking…' : 'Compare ' + row.id}</Button></td></tr>)}</tbody></table></div>
      {!page.records.length && <p className="mt-2 text-[var(--ink-3)]">No records of this type were captured.</p>}
      <div className="mt-2 flex gap-2">{cursors.length > 1 && <Button size="sm" variant="ghost" onClick={() => move(cursors.slice(0, -1))}>Previous captured records</Button>}{page.next && <Button size="sm" variant="ghost" onClick={() => move([...cursors, page.next])}>Next captured records</Button>}</div>
    </>}
    {error && <div role="alert" className="mt-3 text-[var(--danger-ink)]"><p>{error}</p>{!page && <Button size="sm" variant="ghost" onClick={() => setRevision(value => value + 1)}>Retry captured records</Button>}</div>}
    {review && <div className="mt-3 rounded border border-[var(--line)] p-3" aria-live="polite">
      <h5 ref={resultHeading} tabIndex={-1} className="font-semibold">{entity} {review.id}: {labels[review.comparison]}</h5>
      <p className="mt-1 text-[var(--ink-2)]">Captured version {review.captured.syncToken} · {review.current ? 'Current version ' + review.current.syncToken : 'QuickBooks returned no matching row.'}</p>
      <p className="mt-1 text-[12px] text-[var(--ink-3)]">Captured {new Date(review.captured.observedAt).toLocaleString()} · Checked {new Date(review.checkedAt).toLocaleString()}</p>
      {review.origin?.sources?.length > 0 && <ul className="mt-2">{review.origin.sources.map((source, index) => <li key={[source.kind, source.sourceId, index].join(':')}>{sourceLabels[source.kind] || 'Creation receipt'}{source.scope === 'environment_unrecorded' ? ' · Historical match; environment was not recorded' : ' · Recorded company environment'}{source.caseId && <a className="ml-2 underline" href={'/cases/' + source.caseId}>Open case</a>}</li>)}</ul>}
      <p className="mt-2 text-[var(--ink-3)]">{review.origin?.complete === false ? 'Creation history is incomplete or unavailable.' : review.origin?.sources?.length ? 'Creation receipts do not establish membership in the continuing business.' : 'No matching creation receipt was found; origin remains unknown.'}</p>
      <a className="mt-2 inline-block underline" href={'/explorer?type=' + encodeURIComponent(entity) + '&id=' + encodeURIComponent(review.id)}>Inspect current record in Records</a>
      <p className="mt-2 text-[12px] text-[var(--ink-3)]">{review.limitation}</p>
    </div>}
  </div>
}
