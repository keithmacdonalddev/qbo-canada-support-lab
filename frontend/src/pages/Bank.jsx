import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, CreditCard, Download, Landmark, RefreshCw } from 'lucide-react'
import Layout from '../components/Layout'
import { Button } from '../components/ui/button'
import { useConnection } from '../context/ConnectionContext'
import { bankingApi, bankingError, bankMoney } from '../api/banking'
import '../styles/bank.css'

function useBankRead(method, scope, accountId, period, refresh) {
  const [load, setLoad] = useState({ loading: true, data: null, error: '' })
  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve().then(() => { if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: true, error: '' })) })
    const request = method === 'accounts' ? bankingApi.accounts({ signal: controller.signal }) : bankingApi.account(accountId, { period, signal: controller.signal })
    request.then(data => { if (!controller.signal.aborted) setLoad({ loading: false, data, error: '' }) }).catch(error => { if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: false, error: bankingError(error) })) })
    return () => controller.abort()
  }, [method, scope, accountId, period, refresh])
  return load
}

function ReadState({ load, retry, children }) {
  return <>
    {load.error && <div className="bank-alert" role="alert"><div><strong>{load.data ? 'Retained view may be out of date' : 'Bank records unavailable'}</strong><p>{load.error}</p></div><Button variant="outline" onClick={retry}>Try again</Button></div>}
    {load.loading && <p className="bank-loading" role="status">{load.data ? 'Refreshing retained bank records…' : 'Reading saved bank balances and history…'}</p>}
    {load.data && children}
  </>
}

function AccountIcon({ type }) { return type === 'Credit Card' ? <CreditCard size={20} aria-hidden="true" /> : <Landmark size={20} aria-hidden="true" /> }
function balanceLabel(account) { return account.balanceConvention === 'card-amount-owed' ? 'Amount owed' : 'Statement balance' }
function Basis({ account }) {
  return <div className="bank-basis">
    <p>Historical reconstruction baseline from retained QuickBooks evidence. This is a simulated bank record, not independent bank confirmation.</p>
    <p>{account.pendingActivity?.note || 'Pending activity is unavailable; no independently observed pending activity is represented.'}</p>
    {(account.unavailableEvidence || []).map((item, index) => <p key={index} className="bank-caution">{typeof item === 'string' ? item : item.note || item.reason || 'Supporting evidence unavailable.'}</p>)}
    <details><summary>Opening evidence and identity</summary><dl className="bank-facts"><div><dt>Mapped account</dt><dd>#{account.accountId} · {account.accountType} · {account.accountCurrency}</dd></div><div><dt>This statement’s opening balance</dt><dd>{bankMoney(account.openingMinor, account.accountCurrency)}</dd></div>{account.openingEvidence?.openingPeriod && <div><dt>Original opening anchor · {account.openingEvidence.openingPeriod}</dt><dd>{bankMoney(account.openingEvidence.amountMinor, account.accountCurrency)}</dd></div>}<div><dt>Opening basis</dt><dd>{account.openingEvidence?.available ? account.openingEvidence.basis : 'Opening evidence unavailable'}</dd></div>{account.openingEvidence?.evidenceRef && <div><dt>Retained reference</dt><dd>{account.openingEvidence.evidenceRef}</dd></div>}{account.openingEvidence?.evidenceHash && <div><dt>Evidence SHA-256</dt><dd className="bank-code">{account.openingEvidence.evidenceHash}</dd></div>}</dl></details>
  </div>
}

function Downloads({ account, stale }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const files = (account.package.files || []).filter(file => ['csv', 'statement'].includes(file.kind))
  async function download(file) {
    setBusy(file.fileId); setError('')
    try {
      const blob = await bankingApi.file(account.package.id, file)
      if (!alive.current) return
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'maple-harbour-' + account.accountId + '-' + account.period + '-v' + account.revision + '-' + file.fileId.replace(/[^A-Za-z0-9_-]/g, '_') + (file.kind === 'csv' ? '.csv' : '.pdf')
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (failure) { if (alive.current) setError(bankingError(failure)) }
    finally { if (alive.current) setBusy('') }
  }
  return <section className="bank-downloads" aria-label="Statement downloads"><div><h2>Statement & downloads</h2><p>{account.period} · retained revision {account.revision}. Every file is checked against its saved SHA-256.</p></div><div className="bank-download-actions">{files.map(file => <Button key={file.fileId} variant="outline" disabled={stale || Boolean(busy)} onClick={() => download(file)} aria-label={'Download ' + (file.kind === 'csv' ? 'CSV' : 'statement PDF')}><Download size={15} aria-hidden="true" />{busy === file.fileId ? 'Checking…' : file.kind === 'csv' ? 'Download CSV' : 'Statement PDF'}</Button>)}</div>{!files.length && <p className="bank-caution">No downloadable files are retained for this period.</p>}{error && <p role="alert" className="bank-caution">{error} Refresh before trying again.</p>}</section>
}

function Transaction({ transaction, currency, onClose, card }) {
  const heading = useRef(null)
  useEffect(() => { heading.current?.focus() }, [])
  return <section className="bank-transaction" aria-label="Transaction detail"><header><h3 ref={heading} tabIndex={-1}>Transaction detail</h3><Button variant="outline" onClick={onClose}>Close detail</Button></header><p className="bank-transaction-description">{transaction.description || 'Retained settlement'}</p><dl className="bank-facts"><div><dt>Posting date</dt><dd>{transaction.postingDate || 'Unavailable'}</dd></div><div><dt>Status</dt><dd>{transaction.status === 'excluded' ? 'Excluded from statement balance' : 'Posted in retained statement'}</dd></div><div><dt>Bank-native amount</dt><dd>{bankMoney(transaction.amountMinor, currency)}</dd></div>{card && <div><dt>Change in amount owed</dt><dd>{bankMoney(transaction.balanceMovementMinor, currency)}</dd></div>}<div><dt>Balance after posting</dt><dd>{bankMoney(transaction.runningBalanceMinor, currency)}</dd></div><div><dt>Posting basis</dt><dd>{transaction.postingBasis || 'Unavailable'}</dd></div><div><dt>Bank event</dt><dd className="bank-code">{transaction.eventId} · revision {transaction.eventRevision}</dd></div><div><dt>CSV row</dt><dd className="bank-code">{transaction.rowId || 'Unavailable'}{transaction.rowNumber ? ' · row ' + transaction.rowNumber : ''}</dd></div><div><dt>Source lineage</dt><dd>{transaction.source?.entity || 'Unavailable'}{transaction.source?.id ? ' #' + transaction.source.id : ''}</dd></div>{transaction.source?.sourceHash && <div><dt>Source SHA-256</dt><dd className="bank-code">{transaction.source.sourceHash}</dd></div>}</dl></section>
}

function AccountDetail({ id, period, scope, refresh, retry, navigate }) {
  const load = useBankRead('account', scope, id, period, refresh)
  const [selected, setSelected] = useState(null), [page, setPage] = useState(0)
  const account = load.data, transaction = account?.transactions.find(row => row.eventId === selected)
  const rowButtons = useRef(new Map())
  const card = account?.balanceConvention === 'card-amount-owed'
  function closeDetail() { rowButtons.current.get(selected)?.focus(); setSelected(null) }
  return <ReadState load={load} retry={retry}>{account && <>
    <div className="bank-detail-heading"><div><p className="bank-eyebrow">{account.accountType} · #{account.accountId} · {account.accountCurrency}</p><h1>{account.accountName}</h1></div><label className="bank-period-label">Statement period<select value={account.period} onChange={event => navigate(id, event.target.value)}>{(account.availablePeriods || [{ period: account.period }]).map(item => <option key={item.period} value={item.period}>{item.period}</option>)}</select></label></div>
    <div className="bank-account-balance"><div><span>{balanceLabel(account)}</span><strong>{bankMoney(account.balanceMinor, account.accountCurrency)}</strong><p>As of {account.balanceAsOf || 'date unavailable'} · retained statement</p></div><div><span>Opening</span><strong>{bankMoney(account.openingMinor, account.accountCurrency)}</strong></div><div><span>Posted transactions</span><strong>{account.postedCount}</strong><p>Pending activity: not independently observed</p></div></div>
    <Downloads account={account} key={account.package.id} stale={load.loading || Boolean(load.error)} />
    <section className="bank-history"><div className="bank-section-heading"><h2>Posted history</h2><span>{account.period}</span></div><p className="bank-history-note">{card ? 'Bank-native signs: charges are negative; payments and credits are positive. Amount owed changes in the opposite direction.' : 'Positive amounts enter the account; negative amounts leave it.'} Select a transaction for its retained identity and source. Excluded rows do not change the balance.</p>
      {!account.transactions.length ? <div className="bank-empty"><strong>No posted transactions retained</strong><p>This statement carries its evidenced opening balance. Missing activity is not invented.</p></div> : <><div className="bank-history-scroll"><table><thead><tr><th scope="col">Posted</th><th scope="col">Transaction</th><th scope="col">Status</th><th scope="col" className="bank-amount">Amount</th><th scope="col" className="bank-amount">{card ? 'Amount owed' : 'Balance'}</th></tr></thead><tbody>{account.transactions.slice(page * 15, (page + 1) * 15).map(row => <tr key={row.eventId} className={selected === row.eventId ? 'is-selected' : ''}><td>{row.postingDate || 'Unavailable'}</td><td><button ref={node => { if (node) rowButtons.current.set(row.eventId, node); else rowButtons.current.delete(row.eventId) }} type="button" aria-expanded={selected === row.eventId} onClick={() => setSelected(row.eventId)}>{row.description || 'Retained settlement'}<ArrowRight size={14} aria-hidden="true" /></button></td><td><span className="bank-posted">{row.status === 'excluded' ? 'Excluded' : 'Posted'}</span></td><td className="bank-amount">{bankMoney(row.amountMinor, account.accountCurrency)}</td><td className="bank-amount">{bankMoney(row.runningBalanceMinor, account.accountCurrency)}</td></tr>)}</tbody></table></div>{account.transactions.length > 15 && <div className="bank-pagination"><span>{page * 15 + 1}–{Math.min((page + 1) * 15, account.transactions.length)} of {account.transactions.length}</span><Button variant="outline" disabled={page === 0} onClick={() => { setPage(page - 1); setSelected(null) }}>Previous</Button><Button variant="outline" disabled={(page + 1) * 15 >= account.transactions.length} onClick={() => { setPage(page + 1); setSelected(null) }}>Next</Button></div>}</>}
      {transaction && <Transaction key={transaction.eventId} transaction={transaction} currency={account.accountCurrency} card={card} onClose={closeDetail} />}
    </section>
    {(account.package.blockers || []).length > 0 && <details className="bank-basis"><summary>Import / reconciliation gaps · {account.package.blockers.length}</summary><ul>{account.package.blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
    <section className="bank-basis"><h2>Statement timing items</h2>{!(account.outstandingItems || []).length ? <p>No timing items retained for this statement. Independent pending bank activity remains unobserved.</p> : <><p>Book entries expected to post after this statement cutoff. These are reconstructed timing items, not an independently observed pending feed.</p><ul>{account.outstandingItems.map(item => <li key={item.eventId}>{item.kind === 'deposit-in-transit' ? 'Deposit in transit' : 'Outstanding payment'} · {bankMoney(item.amountMinor, item.currency || account.accountCurrency)} · booked {item.bookDate} · expected {item.expectedPostingDate}<br /><span className="bank-code">{item.eventId}</span></li>)}</ul></>}</section>
    <Basis account={account} /><Link className="bank-text-link" to="/company/manage">View QuickBooks import and reconciliation progress <ArrowRight size={14} aria-hidden="true" /></Link>
  </>}</ReadState>
}

function AccountOverview({ scope, refresh, retry, navigate }) {
  const load = useBankRead('accounts', scope, null, null, refresh)
  return <ReadState load={load} retry={retry}>{load.data && <>
    <div className="bank-overview-heading"><h1>Your accounts</h1><p>Retained statement balances · {load.data.accounts.length} accounts</p></div>
    {!load.data.accounts.length ? <div className="bank-empty"><h2>No retained bank accounts yet</h2><p>Accounts appear when evidenced bank or card statement history is retained for this company. No sample balances are substituted.</p></div> : <div className="bank-account-grid">{load.data.accounts.map(account => <button type="button" className="bank-account-card" key={account.accountId} onClick={() => navigate(account.accountId)}><span className="bank-card-top"><AccountIcon type={account.accountType} /><span>{account.accountType} · {account.accountCurrency}</span><ArrowRight size={17} aria-hidden="true" /></span><h2>{account.accountName}</h2><span className="bank-card-number">Account #{account.accountId}</span><span className="bank-card-balance-label">{balanceLabel(account)}</span><strong>{bankMoney(account.balanceMinor, account.accountCurrency)}</strong><span>As of {account.balanceAsOf || 'date unavailable'}</span><span className="bank-card-footer">{account.period} · {account.postedCount} posted · View account</span></button>)}</div>}
    {load.data.truncated && <p className="bank-caution">Some retained packages were omitted from this response. Account coverage may be incomplete.</p>}
    <p className="bank-baseline-note">{load.data.evidenceLabel || 'Historical reconstruction baseline — not independent bank confirmation.'} Balances describe the displayed retained periods; ongoing bank activity and pending transactions are not confirmed here.</p>
  </>}</ReadState>
}

export default function Bank() {
  const connection = useConnection(), [params, setParams] = useSearchParams(), [refresh, setRefresh] = useState(0)
  const id = params.get('account'), period = params.get('period')
  const scope = [connection?.status?.realmId, connection?.status?.connectionId, connection?.environment].join(':')
  const retry = () => setRefresh(value => value + 1)
  const navigate = (accountId, month) => setParams({ account: accountId, ...(month ? { period: month } : {}) })
  return <Layout><main className="bank-app"><header className="bank-masthead"><div className="bank-brand"><span className="bank-mark" aria-hidden="true"><Landmark size={22} /></span><div><strong>Maple Harbour Bank</strong><span>Simulated online banking</span></div></div><Button variant="outline" onClick={retry}><RefreshCw size={15} aria-hidden="true" />Refresh</Button></header>
    <nav className="bank-breadcrumb" aria-label="Bank navigation">{id ? <button type="button" onClick={() => setParams({})}><ArrowLeft size={15} aria-hidden="true" />All accounts</button> : <Link to="/company"><ArrowLeft size={15} aria-hidden="true" />Back to the business</Link>}<span>{connection?.companyName || 'Connected company'}</span></nav>
    {id ? <AccountDetail key={scope + ':' + id + ':' + (period || '')} id={id} period={period} scope={scope} refresh={refresh} retry={retry} navigate={navigate} /> : <AccountOverview key={scope} scope={scope} refresh={refresh} retry={retry} navigate={navigate} />}
  </main></Layout>
}
