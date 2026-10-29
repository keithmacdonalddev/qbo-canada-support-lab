const money = cents => cents == null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100)
const ActivityKey = ({ label, value }) => value ? <p>{label}: <span className="break-all font-mono text-[11px]">{value}</span></p> : null

export default function BusinessActivityTerms({ details, references = [] }) {
  const expense = references.find(row => row.entity === 'Account' && row.key === 'operatingExpense')
  const staged = details.settlement?.stage, creditStage = details.creditSettlement?.stage
  const cohort = details.origin?.ruleKey?.replace(/^(field-job|supply-order|care-subscription|operating-overhead)-(\d+)$/, (_, kind, number) => ({ 'field-job': 'Field job', 'supply-order': 'Stock order', 'care-subscription': 'Care subscription', 'operating-overhead': 'Operating bill' })[kind] + ' ' + number)
  return <div className="space-y-1">
    {details.activityBatch && <p>{details.activityBatch.purpose}</p>}
    {details.lines.map(line => <p key={line.key}>{line.itemKey ? <>{line.quantity} {line.unit || 'units'} × {money(line.unitPriceCents)} · {line.itemKey}</> : <>{money(line.amountCents)} · Operating expense{expense ? ' #' + expense.id : ''} · {line.billableStatus === 'NotBillable' ? 'Nonbillable' : 'Needs billable-status review'}</>}</p>)}
    {details.creditAdjustment && <p>Credit 10% of the original care service before tax. Keep its original customer, service and tax treatment.</p>}
    {details.expenseCategory && <p className="capitalize">{details.activityBatch ? 'Additional' : 'Monthly'} {details.expenseCategory}</p>}
    {!details.lines.length && <p>{creditStage === 'application' ? 'Apply the exact saved credit to its invoice. No money is collected or deposited.' : creditStage === 'remainder' ? 'Collect the original saved invoice total less the exact saved credit, including their actual tax.' : details.amountRule === 'time_only' ? details.hours + ' billable hours' : staged === 'first' ? 'Collect 60% of the accepted invoice total, including tax (rounded to cents).' : staged === 'remainder' ? 'Collect the original accepted invoice total less its exact prior 60% payment.' : details.cashDirection === 'internal_transfer' ? 'Deposit this payment’s exact accepted total.' : 'Settle the originating record’s exact accepted total, including tax.'}</p>}
    {details.dueDate && <p>Due {details.dueDate} · {details.activityBatch ? 'Immediate terms' : '30-day terms'}</p>}
    {details.stockQuantityRule && <p>{details.stockQuantityRule.retainedQuantity ? 'Keep ' + details.stockQuantityRule.retainedQuantity + ' units from this opening batch in stock.' : 'This batch’s purchases match planned sales; the opening stock buffer remains.'}</p>}
    {cohort && details.amountSourceKey && <p className="text-[var(--ink-2)]">{cohort} · started {details.origin.occurrence}{details.origin.stepKey === 'final-deposit' ? ' · final collection' : details.origin.stepKey === 'deposit' ? ' · first collection' : ''}</p>}
    {(details.amountSourceKey || details.creditAdjustment) && <details className="text-[11px] text-[var(--ink-3)]"><summary className="cursor-pointer">Activity references</summary><ActivityKey label={details.cashDirection === 'internal_transfer' ? 'Payment to deposit' : 'Originating activity'} value={details.amountSourceKey || details.creditAdjustment?.invoiceKey} /><ActivityKey label="Prior payment required" value={details.settlement?.priorPaymentKey} /><ActivityKey label="Saved credit required" value={details.creditSettlement?.creditMemoKey} /><ActivityKey label="Credit application required" value={details.creditSettlement?.applicationKey} /></details>}
  </div>
}
