const money = value => value === null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value / 100)
export default function BusinessFinancialMovements({ evidence }) {
  if (!evidence) return null
  return <section aria-label="Financial account movement evidence" className="space-y-2 rounded border border-[var(--line)] p-3">
    <h4 className="font-semibold">Selected account movements · {evidence.status === 'integrity-unavailable' ? 'evidence unavailable' : evidence.status}</h4>
    <p>{evidence.observedAt ? 'Observed ' + new Date(evidence.observedAt).toLocaleString() : 'Observation unavailable'} for {evidence.period.fromDate} – {evidence.period.throughDate}. {evidence.complete ? 'The required period evidence passed.' : 'This observation does not complete the business period.'}</p>
    {evidence.reason && <p role="status">{evidence.reason}</p>}
    {evidence.checks.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left"><caption className="sr-only">Starting balances plus exact managed changes compared with reported ending balances</caption><thead><tr><th className="p-2">Account</th><th className="p-2">Starting</th><th className="p-2">Managed change</th><th className="p-2">Expected ending</th><th className="p-2">Reported ending</th><th className="p-2">Difference</th><th className="p-2">Result</th></tr></thead><tbody>{evidence.checks.map(row => <tr key={row.key} className="border-t border-[var(--line)]"><th scope="row" className="p-2 font-normal">{row.label} #{row.accountId}</th>{['openingCents', 'changeCents', 'expectedCents', 'actualCents', 'differenceCents'].map(key => <td key={key} className="p-2 tabular whitespace-nowrap">{money(row[key])}</td>)}<td className="p-2">{row.status}</td></tr>)}</tbody></table></div>}
    <p className="text-[var(--ink-2)]">Debits are positive; credits are negative. Payables normally appear negative. {evidence.limitation}</p>
    {evidence.sourceHash && evidence.basisHash && <details className="text-[11px] text-[var(--ink-3)]"><summary className="cursor-pointer">Evidence references</summary><p className="break-all">Report observation: {evidence.sourceHash}</p><p className="break-all">Original dispatch basis: {evidence.basisHash}</p></details>}
  </section>
}
