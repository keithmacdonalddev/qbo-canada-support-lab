import { useEffect, useRef, useState } from 'react'
import Layout from '../components/Layout'
import ReportEvidence from '../components/ReportEvidence'
import { Button } from '../components/ui/button'
import client from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useConnection } from '../context/ConnectionContext'
import { useSearchParams } from 'react-router-dom'
const families = ['financial','cash','receivables','sales','payables','expenses','inventory','projects','tax','budget','reconciliation','audit']
const title = text => text[0].toUpperCase() + text.slice(1)
export default function Reports() {
  const { user } = useAuth(), connection = useConnection(), status = connection?.status
  return <ReportLibrary key={[user?.id || user?._id, status?.realmId, connection?.environment, status?.connectionId].join(':')} actorId={user?.id || user?._id} realmId={status?.realmId} environment={connection?.environment} connectionId={status?.connectionId} enabled={connection?.ready === true} />
}
function ReportLibrary(props) {
  const [params] = useSearchParams(), [family, setFamily] = useState(''), [tier, setTier] = useState(''), [offset, setOffset] = useState(0)
  const [catalog, setCatalog] = useState(null), [selectedKey, setSelectedKey] = useState(() => params.get('report')), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); let active = true
    client.get('/reports', { params: { offset, limit: 50, ...(family ? { family } : {}), ...(tier ? { tier } : {}) }, signal: controller.signal, timeout: 15000 })
      .then(response => { if (active) { setCatalog(response.data.data); setError('') } })
      .catch(failure => { if (active && !controller.signal.aborted) { setCatalog(null); setError(failure.response?.data?.error?.message || failure.message || 'The report catalog could not be read.') } })
    return () => { active = false; controller.abort() }
  }, [offset, family, tier, retry])
  const selected = catalog?.items.find(row => row.key === selectedKey) || catalog?.items[0], selectedButton = useRef(null)
  useEffect(() => { selectedButton.current?.scrollIntoView({ block: 'nearest' }) }, [selected?.key])
  return <Layout><div className="mx-auto max-w-[1280px]">
    <h1 className="text-[22px] font-semibold">Reports</h1>
    <p className="mt-1 max-w-[85ch] text-[13.5px] text-[var(--ink-2)]">Inspect the intended accounting story, what each report needs, and the evidence kept for this company. Opening a report definition reads no QuickBooks accounting data.</p>
    <div className="mt-5 flex flex-wrap items-end gap-3 text-[13px]"><label>Report family<select aria-label="Report family" value={family} onChange={event => { setFamily(event.target.value); setOffset(0); setCatalog(null) }} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2"><option value="">All families</option>{families.map(value => <option key={value} value={value}>{title(value)}</option>)}</select></label><label>Report priority<select aria-label="Report priority" value={tier} onChange={event => { setTier(event.target.value); setOffset(0); setCatalog(null) }} className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface)] p-2"><option value="">All priorities</option>{['critical','supporting','edge','deferred'].map(value => <option key={value} value={value}>{title(value)}</option>)}</select></label>{catalog && <p className="py-2 text-[var(--ink-2)]">{catalog.total} report definitions · company evidence stays separate</p>}</div>
    {error && <div className="mt-5 space-y-2"><p role="alert" className="text-[var(--danger-ink)]">{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry report catalog</Button></div>}
    {!catalog && !error && <p role="status" className="mt-5">Reading report definitions…</p>}
    {catalog && <div className="mt-5 grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]"><div className="space-y-3 lg:sticky lg:top-20"><nav aria-label="Report definitions" className="max-h-[680px] overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] p-1">{catalog.items.map(row => <button type="button" aria-label={row.name} aria-pressed={selected?.key === row.key} ref={selected?.key === row.key ? selectedButton : null} key={row.key} onClick={() => setSelectedKey(row.key)} className={'block w-full rounded px-3 py-2 text-left text-[13px] ' + (selected?.key === row.key ? 'bg-[var(--sunken)] font-medium' : 'hover:bg-[var(--sunken)]')}><span className="block">{row.name}</span><span aria-hidden="true" className="mt-0.5 block text-[11.5px] text-[var(--ink-2)]">{title(row.tier)} · {row.api.status === 'manual-only' ? 'Manual workflow documented' : 'Company evidence needed'}</span></button>)}</nav><div className="flex gap-2"><Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous definitions</Button><Button variant="outline" size="sm" disabled={offset + catalog.items.length >= catalog.total} onClick={() => setOffset(value => value + 50)}>Next definitions</Button></div>{!catalog.items.length && <p>No report definitions match these filters.</p>}</div>{selected && <div className="min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5"><ReportEvidence key={selected.key} report={selected} onChooseReport={key => { setSelectedKey(key); setFamily(''); setTier(''); setOffset(0) }} {...props} /></div>}</div>}
  </div></Layout>
}
