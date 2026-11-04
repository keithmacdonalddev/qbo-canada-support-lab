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

function IndependentLedger({ account }) {
  const ledger = account.independentLedger
  if (!ledger) return <div className="bank-basis"><strong>Independent ledger not adopted</strong><p>These saved statements remain a historical reconstruction. An evidenced baseline must be explicitly adopted before this account has an independent bank balance. Refreshing QuickBooks does not perform adoption.</p></div>
  return <section className="bank-basis" aria-label="Independent bank ledger"><h2>Independent bank ledger</h2>{!account.selectedPeriodAdopted && <p className="bank-caution">The selected statement is outside this adopted ledger. Its reconstructed balance is shown separately above.</p>}<p><strong>{bankMoney(ledger.balance.balanceMinor, account.accountCurrency)}</strong> {account.balanceConvention === 'card-amount-owed' ? 'owed' : 'balance'} · through {ledger.throughPeriod}. This historical baseline stays frozen. New instruction settlements are shown separately below.</p><p>Baseline: {ledger.balance.postedCount} posted · {ledger.balance.reversedCount} reversed. New pending instructions are shown separately below. Historical timing items remain separate.</p><details><summary>Ledger opening and calculation</summary><dl className="bank-facts"><div><dt>Ledger opening · {ledger.openingPeriod}</dt><dd>{bankMoney(ledger.openingMinor, account.accountCurrency)}</dd></div><div><dt>Posted movement</dt><dd>{bankMoney(ledger.balance.movementMinor, account.accountCurrency)}</dd></div><div><dt>Opening evidence</dt><dd>{ledger.openingEvidence.acceptedOpening?.basis}<br />{ledger.openingEvidence.basis}<br />{ledger.openingEvidence.evidenceRef}</dd></div><div><dt>Evidence SHA-256</dt><dd className="bank-code">{ledger.openingEvidence.evidenceHash}</dd></div><div><dt>Stable ledger identity</dt><dd className="bank-code">{ledger.ledgerId}</dd></div></dl><p>{ledger.basis} Pending events do not affect the posted balance. Reversed events retain their history with zero net effect.</p></details></section>
}

function InstructionDelivery({ delivery, stale, refresh }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  if (!delivery?.count) return null
  async function retry(runId) {
    setBusy(runId); setError(''); setMessage('')
    try {
      const result = await bankingApi.retryInstructions(runId)
      if (alive.current) { setMessage(result.results.some(row => ['failed', 'held', 'waiting'].includes(row.status)) ? 'Bank delivery still needs attention. The current reason is shown below.' : 'Accepted instructions delivered to the bank. Posted balances are unchanged.'); refresh() }
    } catch (failure) { if (alive.current) setError(bankingError(failure)) }
    finally { if (alive.current) setBusy('') }
  }
  return <section className="bank-basis bank-delivery" aria-label="Bank instruction delivery"><h2>Bank delivery needs attention · {delivery.count}{delivery.truncated ? '+' : ''}</h2><p>QuickBooks records are already accepted. Retry delivers only their saved bank instructions and makes no QuickBooks calls.</p>{delivery.runs.slice(0, 5).map(run => <div className="bank-delivery-row" key={run.runId}><div><strong>{run.status === 'held' ? 'Waiting for a dependency' : run.status === 'failed' ? 'Bank delivery interrupted' : 'Bank delivery queued'}</strong>{(run.results || []).filter(row => row.reason).slice(0, 3).map((row, index) => <p key={index}>{row.reason}</p>)}<span className="bank-code">Run {run.runId}</span></div><Button variant="outline" disabled={stale || Boolean(busy)} onClick={() => retry(run.runId)}>{busy === run.runId ? 'Retrying…' : 'Retry bank delivery'}</Button></div>)}{error && <p role="alert" className="bank-caution">{error}</p>}{message && <p role="status">{message}</p>}</section>
}

function BankClockStatus({ status }) {
  if (!status) return null
  if (!status.lastTickAt) return <p className="bank-history-note">Automatic bank checks have not been observed since this app process started. Use Post due activity to inspect pending work.</p>
  return <p className="bank-history-note" role={status.status === 'unavailable' ? 'status' : undefined}>Last automatic bank check: {new Date(status.lastTickAt).toLocaleString('en-CA')}. {status.status === 'stopped' ? 'Automatic checks are stopped.' : ['unavailable','attention','unobserved'].includes(status.status) ? 'Automatic processing needs attention. Use the due-activity action to inspect the current result.' : 'Due work follows its retained banking dates.'}</p>
}

function NewBankActivity({ account }) {
  const activity = account.independentActivity
  if (!activity) return null
  const posted = (activity.events || []).filter(item => item.state === 'posted')
  return <section className="bank-history" aria-label="New bank settlements"><div className="bank-section-heading"><h2>New bank activity</h2><span>{activity.postedCount} posted</span></div><p className="bank-history-note">{activity.coverage?.basis}</p><dl className="bank-facts"><div><dt>Recorded movement since baseline</dt><dd>{bankMoney(activity.activityMovementMinor, account.accountCurrency)}</dd></div><div><dt>Baseline plus recorded activity</dt><dd>{bankMoney(activity.boundedBalanceMinor, account.accountCurrency)}</dd></div></dl><p className="bank-history-note">This subtotal does not establish the current account balance. Historical gaps and retained statement periods remain separate.</p>{posted.length > 0 && <div className="bank-history-scroll"><table><thead><tr><th scope="col">Posted</th><th scope="col">Transaction</th><th scope="col" className="bank-amount">Amount</th></tr></thead><tbody>{posted.slice(0,20).map(item => <tr key={item.eventId}><td>{item.postingDate}</td><td><strong>{item.description}</strong><details><summary>Source and bank identity</summary><p>{item.source?.entity} #{item.source?.id}</p><p className="bank-code">{item.eventId}</p></details></td><td className="bank-amount">{bankMoney(item.amountMinor, account.accountCurrency)}</td></tr>)}</tbody></table></div>}{activity.postedCount > Math.min(20, posted.length) && <p className="bank-history-note">Showing {Math.min(20, posted.length)} of {activity.postedCount} posted instructions. The subtotal includes all retained activity.</p>}</section>
}


function originMinor(text) {
  if (!/^-?\d{1,4}(\.\d{1,2})?$/.test(text)) throw new Error('Enter an exact amount with at most two decimal places.')
  const negative = text.startsWith('-'), [whole, fraction = ''] = text.replace('-', '').split('.')
  return (negative ? -1 : 1) * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')))
}

function CurrentBankFeeds({ account, stale, refresh, refreshKey }) {
  const [load, setLoad] = useState({loading:true,data:null,error:''}), [page, setPage] = useState({offset:0,expectedHash:undefined}), [revision, setRevision] = useState(0)
  const [mode, setMode] = useState(''), [fromDate, setFromDate] = useState(''), [throughDate, setThroughDate] = useState(''), [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current=true; return () => {alive.current=false} }, [])
  useEffect(() => {
    if (!account.independentLedger) return
    const controller=new AbortController()
    Promise.resolve().then(() => {if(!controller.signal.aborted)setLoad(old=>({...old,loading:true,error:''}))})
    bankingApi.currentFeeds(account.accountId,{signal:controller.signal,...page,...(mode?{mode}:{})}).then(data=>{if(!controller.signal.aborted)setLoad({loading:false,data,error:''})}).catch(failure=>{if(!controller.signal.aborted)setLoad(old=>({...old,loading:false,error:bankingError(failure)}))})
    return () => controller.abort()
  }, [account.accountId, account.independentLedger, page, mode, revision, refreshKey])
  if (!account.independentLedger) return null
  const disabled=stale||load.loading||Boolean(busy), data=load.data
  async function publish(input,publicationId) {
    setBusy('publish');setError('');setMessage('')
    try {const value=publicationId?await bankingApi.publishCurrentFeed(account.accountId,publicationId):input?await bankingApi.publishCumulativeFeed({accountId:account.accountId,...input}):await bankingApi.publishCurrentFeed(account.accountId);if(alive.current){setMessage(value.status==='no-posted-activity'?'No new independently posted activity is available.':value.reused?'Original publication retained. Its files and event assignments are unchanged.':'Current posted activity retained in a new bank CSV publication.');setPage({offset:0,expectedHash:undefined});setRevision(v=>v+1);refresh()}}
    catch(failure){if(alive.current)setError(bankingError(failure))}finally{if(alive.current)setBusy('')}
  }
  async function download(publication,file) {
    setBusy(file.fileId);setError('')
    try {const blob=await bankingApi.currentFeedFile(account.accountId,publication.publicationId,file);if(!alive.current)return;const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='maple-harbour-current-'+account.accountId+'-'+publication.mode+'-'+publication.publicationId.slice(0,12)+'-'+file.fileId.slice(0,10)+(file.kind==='csv'?'.csv':'.json');document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
    catch(failure){if(alive.current)setError(bankingError(failure))}finally{if(alive.current)setBusy('')}
  }
  return <section className="bank-history" aria-label="Current bank CSV downloads"><div className="bank-section-heading"><h2>Current transaction CSVs</h2><Button variant="outline" disabled={disabled} onClick={()=>publish()}>{busy==='publish'?'Preparing…':'Generate new CSV'}</Button></div><div className="bank-history-note"><p>Incremental files contain each newly posted movement once. Downloading a file does not import, match or reconcile it in QuickBooks.</p>{data&&<p>{data.postedCount} post-adoption movements · {data.unpublishedPostedCount} awaiting a published incremental file · {data.fileHeldPostedCount || 0} published movements need file verification · current-feed epoch {data.epoch}. {data.coverage}</p>}</div>
    {load.loading&&<p role="status" className="bank-history-note">Reading retained current feeds…</p>}{load.error&&<p role="alert" className="bank-caution">{load.error} <button type="button" onClick={()=>{setPage({offset:0,expectedHash:undefined});setRevision(v=>v+1)}}>Read latest files</button></p>}
    {data&&<><label className="bank-period-label">Feed view<select value={mode} onChange={e=>{setMode(e.target.value);setPage({offset:0,expectedHash:undefined})}}><option value="">All current files</option><option value="incremental">Incremental · next import files</option><option value="cumulative">Cumulative · reference only</option></select></label>{!data.items.length?<div className="bank-empty"><strong>No current CSV publication yet</strong><p>Only independently posted activity after adoption is eligible. Pending activity and historical statement files remain separate.</p></div>:<div className="bank-history-scroll"><table><thead><tr><th scope="col">Publication window</th><th scope="col">Rows & native movement</th><th scope="col">Files & next action</th></tr></thead><tbody>{data.items.map(publication=><tr key={publication.publicationId}><td><strong>{publication.mode==='incremental'?'Incremental':'Cumulative reference'} · revision {publication.revision}</strong><p>{publication.window.fromDate}–{publication.window.throughDate}</p><p>{publication.warning}</p>{publication.mode==='cumulative'&&<p>Overlap when issued: {publication.overlapAsOfPublication.count} row(s). Current overlap: {publication.currentOverlap.count} row(s), checked {new Date(publication.currentOverlap.asOf).toLocaleString('en-CA')}.</p>}</td><td>{publication.rowCount} row(s)<p>{bankMoney(publication.nativeMovementMinor,account.accountCurrency)}</p></td><td>{publication.status==='published'&&publication.fileHealth?.status==='verified'?publication.files.map(file=><Button key={file.fileId} variant="outline" disabled={disabled} onClick={()=>download(publication,file)}><Download size={14} aria-hidden="true"/>{busy===file.fileId?'Checking…':file.kind==='csv'?'Download CSV':'Row identities'}</Button>):<><p>{publication.status==='published'?'Registry publication retained; file verification needs attention.':'Original publication is not complete.'} Its event assignments and original bytes are retained.</p><Button variant="outline" disabled={disabled} onClick={()=>publish(null,publication.publicationId)}>Verify original publication</Button></>}{publication.lastError&&<details><summary>Current file health issue</summary><p>{publication.lastError}. Existing files are preserved; inspect the original publication before retrying.</p></details>}</td></tr>)}</tbody></table></div>}
      <div className="bank-pagination"><span>{data.page.total} retained publication(s)</span><Button variant="outline" disabled={disabled||page.offset===0} onClick={()=>setPage({offset:Math.max(0,page.offset-10),expectedHash:data.registryHash})}>Newer</Button><Button variant="outline" disabled={disabled||data.page.nextOffset===null} onClick={()=>setPage({offset:data.page.nextOffset,expectedHash:data.registryHash})}>Older</Button></div>
      <details className="bank-basis"><summary>Download an overlapping reference window</summary><p>A cumulative reference file can include movements already present in incremental files. It is not the next incremental import file. Earlier files stay unchanged.</p><form className="flex items-end gap-4 py-4" onSubmit={e=>{e.preventDefault();publish({fromDate,throughDate})}}><label>From banking date<input className="block border rounded p-2" required type="date" min={data.epoch} value={fromDate} onChange={e=>setFromDate(e.target.value)}/></label><label>Through banking date<input className="block border rounded p-2" required type="date" min={fromDate||data.epoch} value={throughDate} onChange={e=>setThroughDate(e.target.value)}/></label><Button type="submit" variant="outline" disabled={disabled}>Generate reference CSV</Button></form></details>
    </>}{error&&<p role="alert" className="bank-caution">{error}</p>}{message&&<p role="status" className="bank-history-note">{message}</p>}
  </section>
}

function BankOrigins({ account, stale, refresh, refreshKey }) {
  const [load, setLoad] = useState({ loading: true, data: null, error: '' }), [revision, setRevision] = useState(0)
  const [fee, setFee] = useState(''), [enabled, setEnabled] = useState(false), [counterpart, setCounterpart] = useState(''), [tax, setTax] = useState('out-of-scope'), [taxCode, setTaxCode] = useState(''), [net, setNet] = useState('')
  const [kind, setKind] = useState('interest-expense'), [reference, setReference] = useState(''), [amount, setAmount] = useState(''), [dueDate, setDueDate] = useState(''), [adviceAccount, setAdviceAccount] = useState(''), [original, setOriginal] = useState('')
  const [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [actionError, setActionError] = useState(''), [originPage, setOriginPage] = useState({offset:0,expectedHash:undefined})
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve().then(() => { if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: true, error: '' })) })
    bankingApi.originPolicy(account.accountId, { signal: controller.signal, ...originPage }).then(data => {
      if (controller.signal.aborted) return
      setLoad({ loading: false, data, error: '' })
      if (data.policy) { setFee((data.policy.feeMinor / 100).toFixed(2)); setEnabled(data.policy.enabled); setCounterpart(data.policy.mapping.counterpartAccountId); setTax(data.policy.mapping.taxTreatment); setTaxCode(data.policy.mapping.taxCodeId || ''); setNet(data.policy.mapping.netAmountMinor ? (data.policy.mapping.netAmountMinor / 100).toFixed(2) : '') }
    }).catch(error => { if (!controller.signal.aborted) setLoad(old => ({ ...old, loading: false, error: bankingError(error) })) })
    return () => controller.abort()
  }, [account.accountId, revision, refreshKey, originPage])
  if (!account.independentLedger) return null
  const choices = load.data?.choices, policy = load.data?.policy, disabled = stale || load.loading || Boolean(busy)
  const accounts = choices?.accounts || [], expenses = accounts.filter(row => ['Expense', 'Other Expense'].includes(row.type)), adviceAccounts = accounts.filter(row => (kind === 'interest-income' ? ['Income', 'Other Income'] : ['Expense', 'Other Expense']).includes(row.type))
  const origins = load.data?.obligations?.items || []
  const selectOptions = rows => <><option value="">Choose a current account</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name} · #{row.id}</option>)}</>
  async function action(name, work, success) {
    setBusy(name); setActionError(''); setMessage('')
    try { const result = await work(); if (alive.current) { setMessage(typeof success === 'function' ? success(result) : success); setOriginPage({offset:0,expectedHash:undefined}); setRevision(value => value + 1); refresh() } }
    catch (error) { if (alive.current) setActionError(bankingError(error)) }
    finally { if (alive.current) setBusy('') }
  }
  function configure(event) {
    event.preventDefault()
    return action('policy', () => bankingApi.configureOriginPolicy({ accountId: account.accountId, expectedRevision: load.data.revision, enabled, feeMinor: originMinor(fee), decisionKey: 'bank-policy-' + crypto.randomUUID(), mapping: { counterpartAccountId: counterpart, taxTreatment: tax, ...(tax === 'taxable' ? { taxCodeId: taxCode, netAmountMinor: originMinor(net) } : {}) } }), 'Monthly policy retained. Its first activation starts today; later changes apply from the next monthly due date.')
  }
  function addAdvice(event) {
    event.preventDefault()
    return action('advice', () => bankingApi.addOriginAdvice({ accountId: account.accountId, kind, reference, amountMinor: originMinor(amount), dueDate, ...(kind.startsWith('interest') ? { mapping: { counterpartAccountId: adviceAccount, taxTreatment: 'out-of-scope' } } : {}), ...(kind === 'duplicate-test' ? { originalEventId: original } : {}) }), 'Exact advice retained. Post due bank activity to materialize eligible advice once.')
  }
  return <section className="bank-basis" aria-label="Bank fees and advice"><div className="bank-section-heading"><h2>Bank fees & advice</h2><Button variant="outline" disabled={disabled || !policy} onClick={() => action('post', () => bankingApi.processOriginDue(account.accountId), result => result.posted ? result.posted + ' bank-origin item(s) posted once. Bookkeeping is shown below.' : 'No new bank-origin postings were due.')}>{busy === 'post' ? 'Checking…' : 'Post due bank activity'}</Button></div>
    {load.loading && <p role="status">Reading bank policy and current account choices…</p>}{load.error && <p role="alert" className="bank-caution">{load.error} <button type="button" onClick={() => {setOriginPage({offset:0,expectedHash:undefined});setRevision(value => value + 1)}}>Read latest obligations</button></p>}
    {load.data && <><p>{policy ? 'Monthly policy ' + (policy.enabled ? 'enabled' : 'disabled') + ' · ' + bankMoney(policy.feeMinor, account.accountCurrency) + ' · next revision effective ' + policy.effectiveFrom + ' · original epoch ' + policy.epoch : 'No bank-origin policy is configured. This account has no automatic fees.'}</p>
      <p>Bank charges move the simulated bank once. Recording their QuickBooks counterpart is a separate governed action. Historical gaps and the frozen baseline remain separate.</p>
      {policy?.enabled && <Button variant="outline" disabled={disabled} onClick={() => action('disable', () => bankingApi.configureOriginPolicy({accountId:account.accountId,expectedRevision:load.data.revision,enabled:false,feeMinor:policy.feeMinor,mapping:policy.mapping,decisionKey:'bank-policy-'+crypto.randomUUID()}), 'Future monthly fees disabled from the next due cycle. Retained charges and their classification stay unchanged.')}>{busy==='disable'?'Disabling…':'Disable future monthly fees'}</Button>}
      {choices ? <details><summary>Configure monthly service fee</summary><form onSubmit={configure} className="grid grid-cols-3 gap-4 py-4"><label>Monthly fee ({account.accountCurrency})<input className="block w-full border rounded p-2" required inputMode="decimal" value={fee} onChange={e => setFee(e.target.value)} /></label><label>Expense account<select className="block w-full border rounded p-2" required value={counterpart} onChange={e => setCounterpart(e.target.value)}>{selectOptions(expenses)}</select></label><label>Tax treatment<select className="block w-full border rounded p-2" value={tax} onChange={e => setTax(e.target.value)}><option value="out-of-scope">Out of scope</option><option value="taxable">Taxable · exact net and code</option></select></label>{tax === 'taxable' && <><label>Current tax code<select className="block w-full border rounded p-2" required value={taxCode} onChange={e => setTaxCode(e.target.value)}><option value="">Choose tax code</option>{choices.taxCodes.map(row => <option key={row.id} value={row.id}>{row.name} · #{row.id}</option>)}</select></label><label>Net before tax<input className="block w-full border rounded p-2" required inputMode="decimal" value={net} onChange={e => setNet(e.target.value)} /></label></>}<label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable monthly fee</label><div className="col-span-3"><p>Activation uses the real Halifax banking date, then its monthly anniversary. Disabled due cycles are skipped. Choose the observed classification explicitly.</p><Button type="submit" disabled={disabled}>{busy === 'policy' ? 'Saving…' : 'Save monthly policy'}</Button></div></form></details> : <p>Current account and tax choices require bookkeeping read access.</p>}
      {policy && <details><summary>Retain exact interest or investigation advice</summary><form onSubmit={addAdvice} className="grid grid-cols-3 gap-4 py-4"><label>Advice kind<select className="block w-full border rounded p-2" value={kind} onChange={e => { setKind(e.target.value); setAdviceAccount('') }}><option value="interest-expense">Exact interest expense</option>{account.accountType === 'Bank' && <option value="interest-income">Exact interest income</option>}<option value="unknown">Unexplained bank advice</option><option value="duplicate-test">Duplicate test · no new movement</option></select></label><label>Unique bank reference<input className="block w-full border rounded p-2" required maxLength={100} value={reference} onChange={e => setReference(e.target.value)} /></label><label>Exact amount ({account.accountCurrency})<input className="block w-full border rounded p-2" required inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label><label>Due banking date<input className="block w-full border rounded p-2" required type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label>{kind.startsWith('interest') && <label>Counterpart · out of scope<select className="block w-full border rounded p-2" required value={adviceAccount} onChange={e => setAdviceAccount(e.target.value)}>{selectOptions(adviceAccounts)}</select></label>}{kind === 'duplicate-test' && <label>Original posted origin<select className="block w-full border rounded p-2" required value={original} onChange={e => setOriginal(e.target.value)}><option value="">Choose original</option>{origins.filter(row => row.status === 'resolved').map(row => <option key={row.eventId} value={row.eventId}>{row.description} · {bankMoney(row.amountMinor, account.accountCurrency)}</option>)}</select></label>}<div className="col-span-3"><p>Interest is an exact positive advice amount. Unknown and duplicate advice retain their signed bank amount. No interest rate or balance calculation is inferred.</p><Button type="submit" disabled={disabled || (kind.startsWith('interest') && !choices)}>{busy === 'advice' ? 'Saving…' : 'Retain advice'}</Button></div></form></details>}
      {(load.data.advice || []).length > 0 && <details><summary>Retained exact advice · {load.data.adviceTotal}</summary><ul>{load.data.advice.map(row => <li key={row.adviceId}>{row.reference} · {row.kind} · {row.dueDate} · {bankMoney(row.amountMinor, account.accountCurrency)} · {row.state}</li>)}</ul></details>}
    </>}
    {origins.length > 0 && <div className="bank-history-scroll"><table><thead><tr><th>Bank-origin posting</th><th>Bookkeeping</th><th>Next action</th></tr></thead><tbody>{origins.map(row => <tr key={row.eventId}><td><strong>{row.description}</strong><p>{row.postingDate} · {bankMoney(row.amountMinor, account.accountCurrency)}</p></td><td>{row.bookkeeping?.status || 'Unavailable'}{row.bookkeeping?.qboId && <p>{row.bookkeeping.qboEntity} #{row.bookkeeping.qboId}</p>}{row.bookkeeping?.reason && <p>{row.bookkeeping.reason}</p>}</td><td>{row.bookkeeping?.status !== 'booked' && row.status === 'resolved' && <Button variant="outline" disabled={disabled} onClick={() => action(row.eventId, () => bankingApi.bookOriginEvent(account.accountId, row.eventId), result => result.status === 'booked' ? 'Original bank-origin counterpart authenticated. The bank movement is unchanged.' : result.reason || 'Bookkeeping remains held; the original decision is retained.')}>{busy === row.eventId ? 'Checking…' : 'Record in QuickBooks'}</Button>}{row.status !== 'resolved' && 'Investigate advice before bookkeeping'}</td></tr>)}</tbody></table></div>}
    {load.data?.obligations && <div className="bank-pagination"><span>{load.data.obligations.neededCount} need bookkeeping · {load.data.obligations.bookedCount} booked · showing {originPage.offset + (origins.length?1:0)}–{originPage.offset+origins.length} of {load.data.obligations.total} bank-origin items</span><Button variant="outline" disabled={disabled||originPage.offset===0} onClick={() => setOriginPage({offset:Math.max(0,originPage.offset-20),expectedHash:load.data.obligations.originHash})}>Newer</Button><Button variant="outline" disabled={disabled||load.data.obligations.page.nextOffset===null} onClick={() => setOriginPage({offset:load.data.obligations.page.nextOffset,expectedHash:load.data.obligations.originHash})}>Older</Button></div>}
    {actionError && <p role="alert" className="bank-caution">{actionError}</p>}{message && <p role="status">{message}</p>}
  </section>
}

function PendingActivity({ account, stale, refresh }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const pending = account.pendingActivity
  async function settle() {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await bankingApi.settleInstructions(account.accountId)
      if (alive.current) { setMessage(result.posted ? result.posted + ' instruction' + (result.posted === 1 ? '' : 's') + ' posted once. Remaining activity follows its banking date.' : 'Posting dates are retained. This batch has no new postings.'); refresh() }
    } catch (failure) { if (alive.current) setError(bankingError(failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  if (pending?.availability !== 'instruction-only') return null
  return <section className="bank-history bank-pending" aria-label="Pending bank instructions"><div className="bank-section-heading"><h2>Pending activity</h2><span>{pending.count} accepted instruction{pending.count === 1 ? '' : 's'}</span></div><div className="bank-history-note bank-settlement-action"><p>{pending.note}</p>{pending.items.length > 0 && <Button variant="outline" disabled={stale || busy} onClick={settle}>{busy ? 'Checking due activity…' : 'Post due activity'}</Button>}</div>{pending.count > 100 && <p className="bank-history-note">Each action processes up to 100 due or unscheduled instructions for this account.</p>}{error && <p role="alert" className="bank-history-note bank-caution">{error}</p>}{message && <p role="status" className="bank-history-note">{message}</p>}{!pending.items.length ? <div className="bank-empty"><strong>No pending instructions received</strong><p>Accepted eligible business payments, deposits and card activity appear here before settlement.</p></div> : <div className="bank-history-scroll"><table><thead><tr><th scope="col">Received</th><th scope="col">Instruction</th><th scope="col">Status</th><th scope="col" className="bank-amount">Amount</th></tr></thead><tbody>{pending.items.map(item => <tr key={item.eventId}><td>{new Date(item.receivedAt).toLocaleString('en-CA')}</td><td><strong>{item.description}</strong><details><summary>Instruction identity</summary><p>Booked {item.bookDate} · {item.source.entity} #{item.source.id}</p><p className="bank-code">{item.eventId}</p><p className="bank-code">Run {item.source.runId} · {item.source.ref}</p><p className="bank-code">Original actor {item.source.originalActorId}<br />Delivery actor {item.deliveryActorId}</p></details></td><td><span className="bank-pending-status">Pending</span><small className="bank-posting-date">{item.expectedPostingDate ? 'Expected ' + item.expectedPostingDate : 'Posting date not scheduled'}</small></td><td className="bank-amount">{bankMoney(item.amountMinor, item.currency)}</td></tr>)}</tbody></table></div>}{pending.truncated && <p className="bank-history-note">Showing the latest {pending.shownCount} of {pending.count} pending instructions.</p>}</section>
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
    <div className="bank-account-balance"><div><span>{balanceLabel(account)}</span><strong>{bankMoney(account.balanceMinor, account.accountCurrency)}</strong><p>As of {account.balanceAsOf || 'date unavailable'} · retained statement</p></div><div><span>Opening</span><strong>{bankMoney(account.openingMinor, account.accountCurrency)}</strong></div><div><span>Posted transactions</span><strong>{account.postedCount}</strong><p>{account.pendingActivity?.availability === 'instruction-only' ? account.pendingActivity.count + ' pending instructions' : 'Pending activity: not independently observed'}</p></div></div>
    <IndependentLedger account={account} />
    <BankClockStatus status={account.instructionProcessing} />
    <CurrentBankFeeds account={account} stale={load.loading || Boolean(load.error)} refresh={retry} refreshKey={refresh} />
    <InstructionDelivery delivery={account.instructionDelivery} stale={load.loading || Boolean(load.error)} refresh={retry} />
    <PendingActivity account={account} stale={load.loading || Boolean(load.error)} refresh={retry} />
    <NewBankActivity account={account} />
    <BankOrigins account={account} stale={load.loading || Boolean(load.error)} refresh={retry} refreshKey={refresh} />
    <Downloads account={account} key={account.package.id} stale={load.loading || Boolean(load.error)} />
    <section className="bank-history"><div className="bank-section-heading"><h2>Posted history</h2><span>{account.period}</span></div><p className="bank-history-note">{card ? 'Bank-native signs: charges are negative; payments and credits are positive. Amount owed changes in the opposite direction.' : 'Positive amounts enter the account; negative amounts leave it.'} Select a transaction for its retained identity and source. Excluded rows do not change the balance.</p>
      {!account.transactions.length ? <div className="bank-empty"><strong>No posted transactions retained</strong><p>This statement carries its evidenced opening balance. Missing activity is not invented.</p></div> : <><div className="bank-history-scroll"><table><thead><tr><th scope="col">Posted</th><th scope="col">Transaction</th><th scope="col">Status</th><th scope="col" className="bank-amount">Amount</th><th scope="col" className="bank-amount">{card ? 'Amount owed' : 'Balance'}</th></tr></thead><tbody>{account.transactions.slice(page * 15, (page + 1) * 15).map(row => <tr key={row.eventId} className={selected === row.eventId ? 'is-selected' : ''}><td>{row.postingDate || 'Unavailable'}</td><td><button ref={node => { if (node) rowButtons.current.set(row.eventId, node); else rowButtons.current.delete(row.eventId) }} type="button" aria-expanded={selected === row.eventId} onClick={() => setSelected(row.eventId)}>{row.description || 'Retained settlement'}<ArrowRight size={14} aria-hidden="true" /></button></td><td><span className="bank-posted">{row.status === 'excluded' ? 'Excluded' : 'Posted'}</span></td><td className="bank-amount">{bankMoney(row.amountMinor, account.accountCurrency)}</td><td className="bank-amount">{bankMoney(row.runningBalanceMinor, account.accountCurrency)}</td></tr>)}</tbody></table></div>{account.transactions.length > 15 && <div className="bank-pagination"><span>{page * 15 + 1}–{Math.min((page + 1) * 15, account.transactions.length)} of {account.transactions.length}</span><Button variant="outline" disabled={page === 0} onClick={() => { setPage(page - 1); setSelected(null) }}>Previous</Button><Button variant="outline" disabled={(page + 1) * 15 >= account.transactions.length} onClick={() => { setPage(page + 1); setSelected(null) }}>Next</Button></div>}</>}
      {transaction && <Transaction key={transaction.eventId} transaction={transaction} currency={account.accountCurrency} card={card} onClose={closeDetail} />}
    </section>
    {(account.package.blockers || []).length > 0 && <details className="bank-basis"><summary>Import / reconciliation gaps · {account.package.blockers.length}</summary><ul>{account.package.blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
    <section className="bank-basis"><h2>Statement timing items</h2>{!(account.outstandingItems || []).length ? <p>No timing items retained for this statement. New independent pending instructions, when available, appear above.</p> : <><p>Book entries expected to post after this statement cutoff. These are reconstructed timing items, not an independently observed pending feed.</p><ul>{account.outstandingItems.map(item => <li key={item.eventId}>{item.kind === 'deposit-in-transit' ? 'Deposit in transit' : 'Outstanding payment'} · {bankMoney(item.amountMinor, item.currency || account.accountCurrency)} · booked {item.bookDate} · expected {item.expectedPostingDate}<br /><span className="bank-code">{item.eventId}</span></li>)}</ul></>}</section>
    <Basis account={account} /><Link className="bank-text-link" to="/company/manage">View QuickBooks import and reconciliation progress <ArrowRight size={14} aria-hidden="true" /></Link>
  </>}</ReadState>
}

function AccountOverview({ scope, refresh, retry, navigate }) {
  const load = useBankRead('accounts', scope, null, null, refresh)
  return <ReadState load={load} retry={retry}>{load.data && <>
    <div className="bank-overview-heading"><h1>Your accounts</h1><p>Retained statement balances · {load.data.accounts.length} accounts</p></div>
    {!load.data.accounts.length ? <div className="bank-empty"><h2>No retained bank accounts yet</h2><p>Accounts appear when evidenced bank or card statement history is retained for this company. No sample balances are substituted.</p></div> : <div className="bank-account-grid">{load.data.accounts.map(account => <button type="button" className="bank-account-card" key={account.accountId} onClick={() => navigate(account.accountId)}><span className="bank-card-top"><AccountIcon type={account.accountType} /><span>{account.accountType} · {account.accountCurrency}</span><ArrowRight size={17} aria-hidden="true" /></span><h2>{account.accountName}</h2><span className="bank-card-number">Account #{account.accountId}</span><span className="bank-card-balance-label">{balanceLabel(account)}</span><strong>{bankMoney(account.balanceMinor, account.accountCurrency)}</strong><span>As of {account.balanceAsOf || 'date unavailable'}</span><span className="bank-card-footer">{account.period} · {account.postedCount} posted{account.pendingActivity?.availability === 'instruction-only' ? ' · ' + account.pendingActivity.count + ' pending' : ''} · View account</span></button>)}</div>}
    <BankClockStatus status={load.data.instructionProcessing} />
    <InstructionDelivery delivery={load.data.instructionDelivery} stale={load.loading || Boolean(load.error)} refresh={retry} />
    {load.data.truncated && <p className="bank-caution">Some retained packages were omitted from this response. Account coverage may be incomplete.</p>}
    <p className="bank-baseline-note">{load.data.evidenceLabel || 'Historical reconstruction baseline — not independent bank confirmation.'} Balances describe the displayed retained periods. Eligible accepted instructions and their due settlements are tracked separately on adopted accounts. Complete account history and automatic operation remain open.</p>
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
