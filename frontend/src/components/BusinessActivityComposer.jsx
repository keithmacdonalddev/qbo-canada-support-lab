import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import client from '../api/client'
import { Button } from './ui/button'

const BASE = '/company/business-governance/activity'
const sameScope = (a, b) => ['realmId', 'environment', 'connectionId'].every(key => String(a?.[key] || '') === String(b?.[key] || ''))

export default function BusinessActivityComposer({ scope, disabled = false, api = client }) {
  const [options, setOptions] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [kind, setKind] = useState('settled-service-sale'), [customerKey, setCustomerKey] = useState(''), [itemKey, setItemKey] = useState(''), [vendorKey, setVendorKey] = useState(''), [category, setCategory] = useState('software')
  const [quantity, setQuantity] = useState('1'), [amount, setAmount] = useState(''), [purpose, setPurpose] = useState(''), [saved, setSaved] = useState(null)
  const decisionKey = useRef(crypto.randomUUID()), sending = useRef(false), mounted = useRef(true), action = useRef(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; action.current?.abort() } }, [])
  const scopeKey = [scope?.realmId, scope?.environment, scope?.connectionId].join(':')
  useEffect(() => {
    if (disabled) return
    const controller = new AbortController()
    setLoading(true); setError('')
    api.get(BASE + '/options', { signal: controller.signal, timeout: 70000 }).then(response => {
      if (controller.signal.aborted) return
      const data = response.data?.data
      if (!sameScope(data?.scope, scope) || !Array.isArray(data.customers) || !Array.isArray(data.services) || !Array.isArray(data.vendors)) throw new Error('The company choices could not be confirmed. Refresh before preparing activity.')
      setOptions(data)
      setCustomerKey(value => data.customers.some(row => row.key === value) ? value : data.customers[0]?.key || '')
      setItemKey(value => data.services.some(row => row.key === value) ? value : data.services[0]?.key || '')
      setVendorKey(value => data.vendors.some(row => row.key === value) ? value : data.vendors[0]?.key || '')
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.response?.data?.error || failure.message || 'Business choices could not be read.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
    // The parent remounts this form when the selected company changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, disabled, scopeKey, revision])
  const sale = kind === 'settled-service-sale'
  const locked = disabled || busy || loading || !options?.ready || !!saved
  async function prepare(event) {
    event.preventDefault()
    if (locked || sending.current) return
    const cents = Math.round(Number(amount) * 100)
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || cents <= 0 || purpose.trim().length < 20) { setError('Enter a positive amount with at most two decimals and a business purpose of at least 20 characters.'); return }
    const activity = sale ? { type: kind, customerKey, itemKey, quantity: Number(quantity), unitPriceCents: cents, purpose: purpose.trim() } : { type: kind, vendorKey, category, amountCents: cents, purpose: purpose.trim() }
    const controller = new AbortController(); action.current = controller; sending.current = true; setBusy(true); setError('')
    try {
      const response = await api.post(BASE + '/prepare', { decisionKey: decisionKey.current, purpose: purpose.trim(), activities: [activity] }, { signal: controller.signal, timeout: 190000 })
      const data = response.data?.data
      if (!/^[a-f0-9]{24}$/.test(data?.operationId || '') || !/^[a-f0-9]{64}$/.test(data?.planHash || '')) throw new Error('The saved plan response could not be confirmed. Keep this decision and retry after refreshing.')
      if (mounted.current) setSaved(data)
    } catch (failure) { if (mounted.current && !controller.signal.aborted) setError(failure.response?.data?.error || failure.message || 'Preparation could not be confirmed. The same decision identifier will be retained for a safe retry.') }
    finally { sending.current = false; action.current = null; if (mounted.current) setBusy(false) }
  }
  const choice = (rows, value, change, id, label) => <><label htmlFor={id}>{label}</label><select id={id} disabled={locked} value={value} onChange={event => change(event.target.value)}>{rows?.map(row => <option key={row.key} value={row.key}>{row.name || row.key}</option>)}</select></>
  return <form className="bw-form" onSubmit={prepare}>
    <p>Prepare additional business activity for today using the company’s saved customers, services and suppliers. You review the exact plan before any records are created.</p>
    {loading && <p role="status"><LoaderCircle className="animate-spin" />Reading available business choices…</p>}
    {error && <p role="alert" className="bw-consent-error">{error}</p>}
    {!options?.ready && !loading && <p>Verify history through yesterday and settle retained operations before adding today’s activity. <Link to="/company/manage">Inspect business setup and retained work</Link>.</p>}
    <label htmlFor="activity-kind">Business activity</label><select id="activity-kind" value={kind} disabled={locked} onChange={event => setKind(event.target.value)}><option value="settled-service-sale">Service sale, collected and deposited</option><option value="paid-operating-expense">Non-stock overhead, paid immediately</option></select>
    {sale ? <>{choice(options?.customers, customerKey, setCustomerKey, 'activity-customer', 'Customer')}{choice(options?.services, itemKey, setItemKey, 'activity-service', 'Service')}<label htmlFor="activity-quantity">Quantity / service hours</label><input id="activity-quantity" type="number" min="1" max="8" step="1" value={quantity} disabled={locked} onChange={event => setQuantity(event.target.value)} required /></> : <>{choice(options?.vendors, vendorKey, setVendorKey, 'activity-vendor', 'Supplier')}<label htmlFor="activity-category">Expense category</label><select id="activity-category" value={category} disabled={locked} onChange={event => setCategory(event.target.value)}>{['premises', 'utilities', 'software'].map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></>}
    <label htmlFor="activity-amount">{sale ? 'Unit price (CAD)' : 'Expense before tax (CAD)'}</label><input id="activity-amount" type="number" min="0.01" max={sale ? '1000' : '10000'} step="0.01" value={amount} disabled={locked} onChange={event => setAmount(event.target.value)} required />
    <label htmlFor="activity-purpose">Business purpose</label><textarea id="activity-purpose" rows={3} minLength={20} maxLength={500} value={purpose} disabled={locked} onChange={event => setPurpose(event.target.value)} required placeholder="Explain the modeled business event and why it belongs today." />
    {saved ? <div role="status"><strong>Activity plan saved. No QuickBooks records were created.</strong><p><Link to="/company/manage">Review and approve the saved plan</Link></p><Button type="button" variant="outline" onClick={() => { decisionKey.current = crypto.randomUUID(); setSaved(null); setPurpose(''); setAmount(''); setRevision(value => value + 1) }}>Prepare another activity</Button></div> : <div className="bw-form-footer"><Button type="button" size="sm" variant="outline" disabled={disabled || busy || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw />Refresh choices</Button><Button type="submit" disabled={locked || !purpose.trim() || !amount || (sale ? !customerKey || !itemKey : !vendorKey)}>{busy ? <LoaderCircle className="animate-spin" /> : null}{busy ? 'Preparing exact plan…' : 'Prepare activity for review'}</Button></div>}
    <small>These are individual batch capacities. They do not impose an end date or lifetime transaction limit. Calendar coverage is recorded separately.</small>
  </form>
}
