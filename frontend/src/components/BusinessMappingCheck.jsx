import { useEffect, useRef, useState } from 'react'
import client from '../api/client'
import { Button } from '@/components/ui/button'
const labels = { compatible: 'Account type checked', unassigned: 'Unassigned', unverified: 'Not verified', unavailable: 'Record unavailable', inactive: 'Inactive', incompatible: 'Incompatible', review_required: 'Tax review needed' }
export default function BusinessMappingCheck({ view }) {
  return <MappingCheck key={[view.realmId, view.environment, view.connectionId, view.draft?.contentHash].join(':')} view={view} />
}
function MappingCheck({ view }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const active = useRef(null)
  useEffect(() => () => active.current?.abort(), [])
  async function check() {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    setLoading(true); setResult(null); setError('')
    const body = { connectionId: view.connectionId, baseHash: view.draft?.contentHash || null }
    try {
      const response = await client.post('/company/business-plan/mapping-check', body, { signal: controller.signal })
      if (controller.signal.aborted) return
      const data = response.data?.data
      if (data?.realmId !== view.realmId || data?.environment !== view.environment || data?.connectionId !== view.connectionId || data?.source?.blueprintHash !== body.baseHash) throw new Error('Company or plan changed')
      setResult(data)
    } catch (error) { if (!controller.signal.aborted) setError(typeof error.response?.data?.error === 'string' ? error.response.data.error : 'The mappings could not be checked. Reload the plan and try again.') }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  return <section aria-label="Business mapping check" className="space-y-3 border-t border-[var(--line)] pt-3">
    <div><h3 className="font-medium text-[var(--ink)]">Check account and tax choices</h3><p className="mt-1 text-[12px]">Checks {view.draft ? 'saved draft v' + view.draft.version : 'the proposed business'} against the connected company. Unsaved edits are excluded. This check does not activate activity.</p></div>
    <Button type="button" size="sm" variant="outline" onClick={check} disabled={loading}>{loading ? 'Checking company choices…' : 'Check saved choices'}</Button>
    {error && <p role="alert" className="text-[var(--attention)]">{error}</p>}
    {result && <div className="space-y-3">
      <p role="status">{result.compatibleAccounts} accounts structurally compatible · {result.unresolvedMappings} mappings unresolved</p>
      <p className="text-[12px]">{result.currency.reason} Checked {new Date(result.observedAt).toLocaleString()}.</p>
      <div className="overflow-x-auto rounded-md border border-[var(--line)]"><table className="w-full text-left text-[12px]"><thead><tr><th className="p-2 font-medium">Use</th><th className="p-2 font-medium">Saved choice</th><th className="p-2 font-medium">Result</th></tr></thead><tbody>{result.rows.map(row => <tr key={row.key} className="border-t border-[var(--line)]"><td className="p-2">{row.label}</td><td className="p-2">{row.name || row.id || 'Unassigned'}</td><td className="p-2"><span className="font-medium text-[var(--ink)]">{labels[row.status] || 'Not verified'}</span><p className="mt-1 text-[var(--ink-3)]">{row.reason}</p></td></tr>)}</tbody></table></div>
      <p className="font-medium text-[var(--ink)]">Still needed before activation</p><ul className="list-disc space-y-1 pl-5 text-[12px]">{result.remaining.map(item => <li key={item}>{item}</li>)}</ul>
    </div>}
  </section>
}
