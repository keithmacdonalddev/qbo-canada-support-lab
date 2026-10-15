import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from './ui/button'
import { RECORD_TYPES } from '@/lib/records'

const labels = { Name: 'Name', DisplayName: 'Display name', Active: 'Active', AccountType: 'Account type', AccountSubType: 'Account subtype', CurrencyRef: 'Currency', GivenName: 'First name', FamilyName: 'Last name', Type: 'Product type', Taxable: 'Taxable sales', IncomeAccountRef: 'Income account', SalesTaxCodeRef: 'Sales tax code', UnitPrice: 'Selling price (CAD)', PurchaseCost: 'Purchase cost (CAD)', TrackQtyOnHand: 'Track stock quantity', QtyOnHand: 'Opening quantity', InvStartDate: 'Inventory starting date', AssetAccountRef: 'Inventory asset account', ExpenseAccountRef: 'Cost of goods account', PurchaseTaxCodeRef: 'Purchase tax code' }
const states = { pending: 'Not sent', reserved: 'Reserved · needs review', 'possibly-sent': 'Request unfinished · blocked', saved: 'Accepted ID · readback needed', verified: 'Readback verified', rejected: 'Refused · review before retry', unknown: 'Outcome unknown · blocked', retired: 'Unsent activity retired' }
function valueText(value, definitions) {
  if (value?.plannedAccountRole) return 'Account to prepare: ' + (definitions?.[value.plannedAccountRole]?.label || value.plannedAccountRole)
  if (value && typeof value === 'object') return String(value.value ?? '')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value ?? '')
}
export default function MasterPreparationRecords({ run, entries, mappingDefinitions, selected = [], onSelect, selectable = false }) {
  const [page, setPage] = useState(0)
  const rows = entries || run?.entries || [], pages = Math.max(1, Math.ceil(rows.length / 10)), current = Math.min(page, pages - 1)
  return <div className="space-y-2">
    <div className="overflow-x-auto rounded-md border border-[var(--line)]">
      <table className="w-full min-w-[660px] text-left text-[12px]">
        <caption className="sr-only">Exact records in this preparation</caption>
        <thead className="bg-[var(--surface-2)] text-[var(--ink-2)]"><tr>{selectable && <th scope="col" className="w-12 p-2">Use</th>}<th scope="col" className="p-2">Record and role</th><th scope="col" className="p-2">Type</th><th scope="col" className="p-2">Saved progress</th><th scope="col" className="p-2">QuickBooks ID</th></tr></thead>
        <tbody>{rows.slice(current * 10, current * 10 + 10).map(entry => {
          const record = run?.records.find(row => row.ordinal === entry.ordinal)
          const verified = record?.state === 'verified' && record.evidenceStatus === 'checked'
          return <tr key={entry.ordinal} className="border-t border-[var(--line)] align-top">
            {selectable && <td className="p-2"><input aria-label={'Use ' + entry.key} type="checkbox" checked={selected.includes(entry.ordinal)} disabled={!verified} onChange={event => onSelect?.(entry.ordinal, event.target.checked)} /></td>}
            <td className="max-w-[330px] p-2"><p className="font-medium text-[var(--ink)]">{entry.name}</p><p className="text-[var(--ink-3)]">{mappingDefinitions?.[entry.key]?.label || entry.key}</p>{entry.fields && <details className="mt-1"><summary className="cursor-pointer text-[var(--link)]">Fields to create</summary><dl className="mt-2 space-y-1">{Object.entries(entry.fields).map(([key, value]) => <div key={key} className="grid grid-cols-[130px_1fr] gap-2"><dt className="text-[var(--ink-3)]">{labels[key] || key}</dt><dd className="break-words">{valueText(value, mappingDefinitions)}</dd></div>)}</dl></details>}</td>
            <td className="p-2">{entry.entity === 'Employee' ? 'Time-entry worker' : entry.entity}</td>
            <td className="p-2"><p>{record ? record.evidenceStatus === 'needs-review' ? 'Evidence needs review' : states[record.state] || record.state : 'Proposed · not sent'}</p>{record?.provenance === 'owner-attributed-master-readback' && <p className="mt-1 text-[var(--attention)]">Identified by owner · original result unknown</p>}{record?.receiptId && <details className="mt-1 text-[var(--ink-3)]"><summary className="cursor-pointer">Request receipt</summary><code className="mt-1 block max-w-[210px] break-all">{record.receiptId}</code><p>{record.attempts.length} attempt{record.attempts.length === 1 ? '' : 's'}</p></details>}</td>
            <td className="p-2">{record?.qboId ? RECORD_TYPES[entry.entity] ? <Link className="text-[var(--link)] underline" target="_blank" rel="noreferrer" aria-label={entry.entity + ' ' + record.qboId + ' (opens in new tab)'} to={'/explorer?type=' + entry.entity + '&id=' + record.qboId}>{record.qboId}</Link> : <span>{record.qboId}</span> : '—'}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    {pages > 1 && <div className="flex items-center justify-between text-[12px]"><span>{current * 10 + 1}–{Math.min((current + 1) * 10, rows.length)} of {rows.length} records</span><div className="flex gap-2"><Button size="xs" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous records</Button><Button size="xs" variant="ghost" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>Next records</Button></div></div>}
  </div>
}
