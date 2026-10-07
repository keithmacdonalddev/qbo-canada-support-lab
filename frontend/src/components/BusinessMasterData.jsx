import { useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Button } from '@/components/ui/button'
const statuses = { compatible: 'Fields checked', unassigned: 'Unassigned', unavailable: 'Unavailable', inactive: 'Inactive', unverified: 'Not verified', incompatible: 'Incompatible' }
export default function BusinessMasterData(props) {
  const { view } = props
  return <MasterData key={[view.realmId, view.environment, view.connectionId, view.draft?.contentHash].join(':')} {...props} />
}
function MasterData({ view, form, editable, onChange }) {
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [entity, setEntity] = useState('Customer')
  const [page, setPage] = useState(0)
  const active = useRef(null)
  useEffect(() => () => active.current?.abort(), [])
  const requirements = view.masterDefinitions?.[form.business.volumeProfile] || []
  const filtered = requirements.filter(row => row.entity === entity)
  const lastPage = Math.max(0, Math.ceil(filtered.length / 12) - 1), currentPage = Math.min(page, lastPage)
  async function inspect() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller
    setLoading(true); setResult(null); setError('')
    const body = { connectionId: view.connectionId, baseHash: view.draft?.contentHash || null }
    try {
      const response = await client.post('/company/business-plan/masters-check', body, { signal: controller.signal })
      if (controller.signal.aborted) return
      const data = response.data?.data
      if (data?.realmId !== view.realmId || data?.environment !== view.environment || data?.connectionId !== view.connectionId || data?.source?.blueprintHash !== body.baseHash) throw new Error('Company or saved plan changed')
      setResult(data)
    } catch (error) { if (!controller.signal.aborted) setError(typeof error.response?.data?.error === 'string' ? error.response.data.error : 'Business records could not be checked. Reload the plan and try again.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return <details className="border-t border-[var(--line)] pt-3">
    <summary className="cursor-pointer font-medium text-[var(--ink)]">Customers, suppliers, products and workers · {requirements.filter(row => form.masterBindings?.[row.key]).length} of {requirements.length} assigned</summary>
    <section aria-label="Business record choices" className="mt-3 space-y-3">
      <p className="text-[12px]">Select exact company records for the planned activity. Names alone never select or adopt records. Changes are included when you save a new draft version.</p>
      <Button type="button" size="sm" variant="outline" onClick={inspect} disabled={loading}>{loading ? 'Reading business records…' : 'Read business records'}</Button>
      {error && <p role="alert" className="text-[var(--attention)]">{error}</p>}
      {result && <><p role="status" className="text-[12px]">{result.unresolved} saved choices unresolved. Checked {new Date(result.observedAt).toLocaleString()}. Unsaved selections are not verified.</p>{Object.values(result.completeness).some(complete => !complete) && <p className="text-[var(--attention)]">Some lists could not be read completely. Their choices remain unavailable.</p>}</>}
      <label className="flex items-center gap-2 text-[12px]">Record type<select aria-label="Business record type" value={entity} onChange={event => { setEntity(event.target.value); setPage(0) }} className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1">{['Customer', 'Vendor', 'Item', 'Employee'].map(value => <option key={value} value={value}>{value} · {requirements.filter(row => row.entity === value).length}</option>)}</select></label>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{filtered.slice(currentPage * 12, (currentPage + 1) * 12).map(row => {
        const selected = form.masterBindings?.[row.key] || ''
        const options = (result?.options[row.entity] || []).filter(record => record.active !== false)
        const saved = result?.rows.find(value => value.key === row.key)
        const matchesSaved = selected === (saved?.id || '')
        return <label key={row.key} className="space-y-1 text-[12px]"><span className="block font-medium">{row.key}</span><span className="block text-[var(--ink-3)]">{row.purpose}</span><select aria-label={'Record for ' + row.key} value={selected} disabled={!editable || result?.completeness[row.entity] !== true} onChange={event => onChange('masterBindings', row.key, event.target.value || null)} className="w-full rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-2"><option value="">Unassigned</option>{selected && !options.some(record => record.id === selected) && <option value={selected}>Saved record {selected} · not in choices</option>}{options.map(record => <option key={record.id} value={record.id}>{record.name} · {record.id}</option>)}</select>{saved && matchesSaved && <span className="block text-[var(--ink-3)]">{statuses[saved.status]}: {saved.reason}</span>}{saved && !matchesSaved && <span className="block text-[var(--ink-3)]">Unsaved selection · save and check again.</span>}</label>
      })}</div>
      {filtered.length > 12 && <div className="flex items-center justify-between"><span className="text-[12px]">{currentPage * 12 + 1}–{Math.min((currentPage + 1) * 12, filtered.length)} of {filtered.length} roles</span><div className="flex gap-2"><Button type="button" size="xs" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous roles</Button><Button type="button" size="xs" variant="ghost" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>Next roles</Button></div></div>}
      <p className="text-[12px]">This list covers the current activity template. The broader business population, projects and dimensions still need setup. Selected records retain their existing balances and history.</p>
    </section>
  </details>
}
