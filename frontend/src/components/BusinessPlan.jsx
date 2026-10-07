import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import client from '../api/client'
import BusinessMasterData from './BusinessMasterData'
import BusinessMappingCheck from './BusinessMappingCheck'
import BusinessActivityPreview from './BusinessActivityPreview'
import { useAuth } from '../context/AuthContext'
import { buttonVariants } from '@/components/ui/button'

const inputClass = 'w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--ink)] disabled:cursor-default'
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const message = error => typeof error.response?.data?.error === 'string' ? error.response.data.error : 'The business plan could not be loaded. Try again.'

export default function BusinessPlan({ realmId, environment, enabled }) {
  const { user } = useAuth()
  return <PlanContent key={[realmId, environment, user?._id || user?.id, enabled].join(':')} realmId={realmId} environment={environment} enabled={enabled} />
}
function PlanContent({ realmId, environment, enabled }) {
  const [view, setView] = useState(null)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [setup, setSetup] = useState(null)
  const [checking, setChecking] = useState(false)
  const [setupError, setSetupError] = useState('')
  const alive = useRef(true)
  const saveRequest = useRef(null)
  const inScope = data => data?.realmId === realmId && data?.environment === environment
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    client.get('/company/business-plan', { signal: controller.signal }).then(response => {
      const data = response.data?.data
      if (data?.realmId !== realmId || data?.environment !== environment) throw new Error('Company changed')
      if (controller.signal.aborted) return
      setView(data); setForm(structuredClone(data.draft || data.proposal)); setError('')
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)) })
    return () => controller.abort()
  }, [enabled, realmId, environment, attempt])
  function change(section, key, value) {
    saveRequest.current = null; setNotice('')
    setForm(current => ({ ...current, [section]: { ...current[section], [key]: value } }))
  }
  async function checkSetup() {
    setChecking(true); setSetupError('')
    try {
      const response = await client.get('/company/business-plan/setup')
      if (!alive.current) return
      if (!inScope(response.data?.data) || response.data.data.connectionId !== view.connectionId) throw new Error('Company connection changed')
      setSetup(response.data.data)
    } catch (error) { if (alive.current) setSetupError(message(error)) }
    finally { if (alive.current) setChecking(false) }
  }
  async function save() {
    setSaving(true); setError(''); setNotice('')
    const requestKey = saveRequest.current || crypto.randomUUID()
    saveRequest.current = requestKey
    try {
      const response = await client.post('/company/business-plan', { requestKey, connectionId: view.connectionId, baseHash: view.draft?.contentHash || null, business: form.business, mappings: form.mappings, masterBindings: form.masterBindings || {} })
      if (!alive.current) return
      if (!inScope(response.data?.data) || response.data.data.connectionId !== view.connectionId) throw new Error('Company changed')
      saveRequest.current = null
      setNotice('Business plan draft saved. No QuickBooks records were changed.')
      setView(current => ({ ...current, draft: response.data.data.draft }))
      setForm(structuredClone(response.data.data.draft))
    } catch (error) { if (alive.current) setError(message(error)) }
    finally { if (alive.current) setSaving(false) }
  }
  const editable = view?.permissionToSave && !saving
  const mappingEntries = Object.entries(view?.mappingDefinitions || {})
  const missing = mappingEntries.filter(([key]) => !form?.mappings?.[key]).length
  return <section aria-label="Business plan" className="mt-5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)]">
    <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3">
      <h2 className="text-[13px] font-semibold text-[var(--ink)]">Business plan</h2>
      <span className="text-[12px] text-[var(--ink-3)]">{view?.draft ? 'Draft v' + view.draft.version + ' · Not activated' : 'Proposed business'}</span>
    </header>
    <div className="space-y-4 px-5 py-4 text-[13px] text-[var(--ink-2)]">
      {!enabled ? <p>Connect the company to inspect its business plan.</p> : !form && !error ? <p role="status" className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />Loading business plan…</p> : null}
      {error && <div role="alert"><p className="text-[var(--attention)]">{error}</p><button type="button" disabled={saving} className="mt-2 text-[var(--link)]" onClick={() => { saveRequest.current = null; setAttempt(value => value + 1) }}>Reload saved plan</button><p className="mt-1 text-[12px]">Reload replaces unsaved edits.</p></div>}
      {notice && <p role="status" className="text-[var(--ok)]">{notice}</p>}
      {form && <>
        <p>Define the business this company should represent. A saved draft preserves your choices; activation and business activity are separate steps.</p>
        {view.draft?.connectionMatches === false && <p role="status" className="text-[var(--attention)]">This draft belongs to an earlier connection. Its mappings must be checked again before activation.</p>}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <label className="col-span-2 space-y-1"><span>Business name</span><input className={inputClass} maxLength={120} value={form.business.displayName} disabled={!editable} onChange={event => change('business', 'displayName', event.target.value)} /></label>
          <label className="space-y-1"><span>History starts</span><input type="date" className={inputClass} value={form.business.openingDate} disabled={!editable} onChange={event => change('business', 'openingDate', event.target.value)} /></label>
          <label className="space-y-1"><span>Months of history</span><input type="number" min={1} max={60} className={inputClass} value={form.business.historicalMonths} disabled={!editable} onChange={event => change('business', 'historicalMonths', Number(event.target.value))} /></label>
          <label className="space-y-1"><span>Fiscal year begins</span><select className={inputClass} value={form.business.fiscalYearStartMonth} disabled={!editable} onChange={event => change('business', 'fiscalYearStartMonth', Number(event.target.value))}>{months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
          <label className="space-y-1"><span>Activity volume</span><select className={inputClass} value={form.business.volumeProfile} disabled={!editable} onChange={event => change('business', 'volumeProfile', event.target.value)}><option value="flagship">Full business</option><option value="development">Small test build</option></select></label>
        </div>
        <p className="text-[12px] text-[var(--ink-3)]">Saving this name does not rename the connected QuickBooks company.</p>
        <div><h3 className="font-medium text-[var(--ink)]">Operating divisions</h3><ul className="mt-1 flex flex-wrap gap-x-5 gap-y-1">{form.divisions.map(division => <li key={division.key}>{division.name}</li>)}</ul></div>
        <details className="border-t border-[var(--line)] pt-3">
          <summary className="cursor-pointer font-medium text-[var(--ink)]">Accounts and tax codes · {missing} unassigned</summary>
          <div className="mt-3 space-y-3">
            <p>Choose the existing company records this business should use. Receivables tracks unpaid invoices; payables tracks unpaid bills. Undeposited funds holds received payments before bank deposit. Tax choices still need review before activity is created.</p>
            <button type="button" className={buttonVariants({ variant: 'outline', size: 'sm' })} disabled={checking || saving} onClick={checkSetup}>{checking ? 'Reading company setup…' : 'Read company setup'}</button>
            {setupError && <p role="alert" className="text-[var(--attention)]">{setupError}</p>}
            {setup && !setup.complete && <p role="status" className="text-[var(--attention)]">Some setup records could not be read completely. These choices are incomplete.</p>}
            {setup && <p className="text-[12px]">Setup read {new Date(setup.observedAt).toLocaleString()}. These observations do not approve a tax treatment.</p>}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{mappingEntries.map(([key, mapping]) => {
              const source = mapping.entity === 'Account' ? 'accounts' : 'taxCodes'
              const options = (setup?.options[source] || []).filter(option => option.active === true && (!mapping.types || mapping.types.includes(option.type)) && (!mapping.subtypes || mapping.subtypes.includes(option.subtype)) && (!mapping.currency || mapping.currency === option.currency))
              const selected = form.mappings[key]
              return <label key={key} className="space-y-1"><span>{mapping.label}</span><select className={inputClass} value={selected || ''} disabled={!editable || !setup?.completeness[source]} onChange={event => change('mappings', key, event.target.value || null)}>
                <option value="">Unassigned</option>
                {selected && !options.some(option => option.id === selected) && <option value={selected}>Saved record {selected} · not in current choices</option>}
                {options.map(option => <option key={option.id} value={option.id}>{option.name} · {option.id}</option>)}
              </select></label>
            })}</div>
          </div>
        </details>
        <BusinessMasterData view={view} form={form} editable={editable} onChange={change} />
        <BusinessMappingCheck view={view} />
        <BusinessActivityPreview view={view} />
        <div className="border-t border-[var(--line)] pt-3"><h3 className="font-medium text-[var(--ink)]">Before this can drive business activity</h3><ul className="mt-1 list-disc space-y-1 pl-5">{view.activationNeeds.map(need => <li key={need}>{need}</li>)}</ul></div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={buttonVariants({ size: 'sm' })} disabled={!view.canSave || saving} onClick={save}>{saving ? 'Saving draft…' : 'Save new draft version'}</button>
          {!view.permissionToSave ? <p>Your company role has read-only access to business plans.</p> : !view.storage.ready ? <p>{view.storage.reason}</p> : <p className="text-[12px]">Saved in this app. No QuickBooks transactions are created.</p>}
        </div>
      </>}
    </div>
  </section>
}
