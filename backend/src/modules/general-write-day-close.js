'use strict';
// Day-close verification of general governed writes (general-write-v1, design rev 3,
// build step 5). Offline composition of the pure close rules: it gathers the day's
// general records and changed records, reads their postings from ONE General Ledger
// report for the day (requested with explicit debit and credit columns), and evaluates
// them with general-write-close.evaluateDay. It returns the movements to add to the
// existing period assertion and the dirty ranges that must be re-verified. No QuickBooks
// call is made here: the caller supplies the report (one set of reports per day close).
const { hash } = require('./business-calendar');
const { preservesBillableState } = require('./billable-charge-links');
const { evaluateDay, dirtyRange, explainedByOwnSettlements } = require('./general-write-close');
const SETTLEMENT_ENTITIES = new Set(['Payment', 'BillPayment', 'CreditMemo', 'VendorCredit', 'Deposit']);
const settlementKey = link => (link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType) + ':' + String(link.TxnId);
function settlementLinks(record) { return [...(record?.LinkedTxn || []), ...(record?.Line || []).flatMap(line => line.LinkedTxn || [])].filter(link => /^\d{1,30}$/.test(String(link?.TxnId || ''))).map(settlementKey); }
function fail(message, businessDetail = {}) { throw Object.assign(new Error(message), { status: 409, code: 'GENERAL_DAY_CLOSE_UNVERIFIED', businessDetail }); }
// General Ledger transaction-type labels (Canadian and US wording) -> entity.
const LABELS = Object.freeze({
  'Invoice': 'Invoice', 'Payment': 'Payment', 'Credit Memo': 'CreditMemo', 'Sales Receipt': 'SalesReceipt', 'Refund': 'RefundReceipt', 'Refund Receipt': 'RefundReceipt',
  'Bill': 'Bill', 'Bill Payment (Cheque)': 'BillPayment', 'Bill Payment (Check)': 'BillPayment', 'Bill Payment (Credit Card)': 'BillPayment', 'Supplier Credit': 'VendorCredit', 'Vendor Credit': 'VendorCredit',
  'Expense': 'Purchase', 'Cheque Expense': 'Purchase', 'Check': 'Purchase', 'Cheque': 'Purchase', 'Cash Expense': 'Purchase', 'Credit Card Expense': 'Purchase', 'Credit Card Credit': 'Purchase',
  'Credit Card Payment': 'CreditCardPayment', 'CreditCardPayment': 'CreditCardPayment', 'Credit Card Pmt': 'CreditCardPayment',
  'Deposit': 'Deposit', 'Transfer': 'Transfer', 'Journal Entry': 'JournalEntry',
});
const URL_COLUMNS = 'tx_date,txn_type,doc_num,name,memo,split_acc,debt_amt,credit_amt';
// The one General Ledger request a day close needs (explicit debit/credit columns).
function ledgerEndpoint(day, through = day) { if (![day, through].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')) || through < day) fail('A business day or period is required.'); return 'reports/GeneralLedger?' + new URLSearchParams({ start_date: day, end_date: through, accounting_method: 'Accrual', columns: URL_COLUMNS }); }
function money(cell) {
  const value = cell?.value;
  if (value === undefined || value === '') return 0;
  if (typeof value !== 'string' || !/^-?(?:(0|[1-9]\d*)(\.\d{1,2})?|\.\d{1,2})$/.test(value)) fail('A General Ledger amount is not exact money.');
  return Math.round(Number(value) * 100);
}
// { 'Entity:id': [{ accountId, cents }] } (debit positive) from a GeneralLedger report of a
// day or period. Account identities stay distinct, including tax agency accounts.
function parseLedger(report, day, through = day, accountKey = id => id) {
  const header = report?.Header, columns = report?.Columns?.Column;
  if (header?.ReportName !== 'GeneralLedger' || header.ReportBasis !== 'Accrual' || header.StartPeriod !== day || header.EndPeriod !== through || !Array.isArray(columns)) fail('The General Ledger report is not the accrual report for ' + (day === through ? day : day + ' to ' + through) + '.');
  const index = type => { const found = columns.flatMap((column, n) => column.ColType === type ? [n] : []); if (found.length !== 1) fail('The General Ledger report has no single ' + type + ' column.'); return found[0]; };
  const typeAt = index('txn_type'), debitAt = index('debt_amt'), creditAt = index('credit_amt'), dateAt = index('tx_date');
  const out = {}, unknown = [];
  const walk = (rows, account) => {
    for (const row of rows || []) {
      if (row.type === 'Section') { const id = row.Header?.ColData?.[0]?.id; walk(row.Rows?.Row, id || account); continue; }
      if (row.type !== 'Data' || !Array.isArray(row.ColData)) continue;
      const cell = row.ColData[typeAt], entity = LABELS[cell?.value], cents = money(row.ColData[debitAt]) - money(row.ColData[creditAt]);
      const dated = row.ColData[dateAt]?.value;
      const detail = { entity: entity || null, recordId: cell?.id || null, accountId: account || null, fromDate: day, throughDate: through, differences: [{ field: 'tx_date', expected: day === through ? day : [day, through], current: dated || null }] };
      // QBO emits opening balances as Data rows. They are not period movements.
      // Only the exact blank-identity, zero-movement row can be excluded.
      if (dated === 'Beginning Balance' && !cell?.id && !cell?.value && !cents && !money(row.ColData[debitAt]) && !money(row.ColData[creditAt])) continue;
      if (dated && (!/^\d{4}-\d{2}-\d{2}$/.test(dated) || dated < day || dated > through)) fail('A General Ledger row is dated outside ' + day + (day === through ? '' : ' to ' + through) + '.', detail);
      // Zero-value applications can appear under QBO's Not Specified section.
      // They carry no posting; any nonzero unidentified account still fails.
      if (!account && (cents || money(row.ColData[debitAt]) || money(row.ColData[creditAt]))) fail('A General Ledger row has no account section.', detail);
      if (!account) continue;
      if (!entity || !/^\d{1,30}$/.test(cell?.id || '')) { if (cents) unknown.push({ label: cell?.value || null, id: cell?.id || null, accountId: account, cents }); continue; }
      (out[entity + ':' + cell.id] ||= []).push({ accountId: String(accountKey(String(account))), cents });
    }
  };
  walk(report.Rows?.Row, null);
  return { byRecord: out, unknown };
}
// The day's general records: every saved or deleted item of general runs whose record is
// dated on the day, plus the current copy version (or deletion) of each.
// Keyset paging covers every run; a broken/repeated page fails visibly.
async function readGeneralRuns(Runs, scope, { day = null, session = null } = {}) {
  const out = [], size = 500;
  let after = null;
  for (;;) {
    let query = Runs.find({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, contract: 'general-write-v1', ...(day ? {day} : {}), ...(after ? { _id: { $gt: after } } : {}) }).select('environment realmId connectionId contract agentAuthority caseAuthority items plan dirty batches status revision updatedAt day retirement ownerId actorId').sort({ _id: 1 }).limit(size).maxTimeMS(3000);
    if(session)query=query.session(session);
    const rows=await query.lean();
    if (!Array.isArray(rows) || after && rows.some(row => String(row._id) <= after)) fail('General-write enumeration did not advance; close is incomplete.');
    out.push(...rows);
    if (rows.length < size) return out;
    after = String(rows.at(-1)._id);
  }
}
async function generalRecordsFor({ Runs, scope, day, through = day, copy, models = {}, now = () => Date.now() }) {
  const runs = await readGeneralRuns(Runs, scope), candidates = new Map(), dirty = [];
  const inside = date => typeof date === 'string' && date >= day && date <= through;
  const unsent = require('./general-write-unsent').createGeneralUnsentRetirement({ models, Runs, now });
  for (const [index, original] of runs.entries()) {
    const run = runs[index] = await unsent.retire(scope, original);
    if (run.status === 'expired-unsent') continue;
    dirty.push(...(run.dirty || []).map(row => ({ earliestDate: row.date, reason: row.reason || null, runId: String(run._id) })));
    for (const batch of run.batches || []) if (batch.state !== 'answered' && batch.items.some(item => inside(item.payload?.TxnDate || run.day) || inside(item.before?.TxnDate)) && !await unsent.provesUnsent(scope, run, batch)) fail('General write ' + run._id + ' has an unsettled batch; recover its original response before close.');
    for (const [ref, item] of Object.entries(run.items || {})) {
      const op = run.plan.operations.find(row => row.ref === ref), id = item.qboId || op?.id;
      const dispatched = [...(run.batches || [])].reverse().find(batch => (!item.attempt || batch.attempt === item.attempt) && batch.items.some(row => row.ref === ref))?.items.find(row => row.ref === ref);
      const before = item.before || dispatched?.before || op?.before || null;
      if (item.outcome === 'fault') {
        const batch = (run.batches || []).find(row => row.attempt === item.attempt && row.state === 'answered' && row.items.some(sent => sent.ref === ref));
        const sent = batch?.items.find(row => row.ref === ref), gated = batch?.transport?.items?.find(row => row.ref === ref && row.bId === sent?.bId);
        // Only the exact durable gate refusal proves no mutation. Unknown outcomes
        // and admission contention keep their original recovery barrier.
        if (gated?.outcome === 'rejected' && batch.transport.receiptId && item.fault?.length && gated.faultCodes?.length) continue;
      }
      if (!['saved', 'deleted'].includes(item.outcome)) {
        if (inside(item.record?.TxnDate || run.day) || inside(before?.TxnDate)) fail('General write ' + run._id + ' has an unresolved item; close is incomplete.');
        continue;
      }
      if (!id || !['create', 'update', 'void', 'delete'].includes(item.op)) continue;
      const key = item.entity + ':' + id, previous = candidates.get(key);
      const dates = [...(previous?.dates || []), item.record?.TxnDate, before?.TxnDate].filter(Boolean);
      const request = item.request || dispatched?.payload || op?.payload || {};
      const version = BigInt((item.op === 'delete' ? request.SyncToken : item.record?.SyncToken) ?? op?.targetVersion ?? before?.SyncToken ?? -1);
      // Newest proved version wins regardless of run-id ordering; a successful delete
      // follows the version it consumed and must not be hidden by an earlier create.
      if (!previous || version > previous.version || version === previous.version && item.outcome === 'deleted') candidates.set(key, { run,ref,item, op, before, id, version, dates, request });
      else previous.dates = dates;
    }
  }
  const records = [], settlementVersions = [];
  for (const { run,ref,item, op, before, id, dates, request } of candidates.values()) {
    // An exact successful delete is its tombstone; do not turn its expected
    // not-found GET into a close failure. Remaining GL rows still fail proof.
    if (item.outcome === 'saved' && !preservesBillableState(before, item.record, item.entity)) fail('General write ' + item.entity + ' ' + id + ' changed native billable expense history; recover its original evidence before close.');
    if (item.outcome === 'saved' && !require('./general-write-currency').preservesCurrency(before, item.record, request, item.entity)) fail('General foreign write ' + item.entity + ' ' + id + ' lost its currency basis.');
    const current = item.outcome === 'deleted' ? null : await copy.read(scope, item.entity, id);
    if (SETTLEMENT_ENTITIES.has(item.entity)) settlementVersions.push({ key: item.entity + ':' + id, targets: [...new Set(settlementLinks(item.record))].sort(), record: item.record || null, current, outcome: item.outcome, op: item.op });
    if (![...dates, current?.TxnDate].some(inside)) continue;
    let apOmission=null;if(item.entity==='BillPayment'&&item.reconciliation?.kind===require('./general-billpayment-recovery').KIND){const receipt=await models.Receipts.findOne({_id:item.reconciliation.receiptId,...scope}).maxTimeMS(3000).lean();apOmission=await require('./general-billpayment-recovery').loadProof({models,scope,run,ref,receipt,current});if(!apOmission)fail('Saved bill-payment account proof is unavailable or changed');}
    const deleted = item.outcome === 'deleted';
    records.push({ entity: item.entity, id, current: current || null, deleted, unavailable: !deleted && !current, before: item.op === 'create' ? null : before,
      evidence: { accountant: { versionHash: hash(item.record || {}), record: item.record || null, deleted, operation: item.op, request, ...(apOmission?{apOmission}:{}),postingSources: item.postingSources || {} } } });
  }
  // Ownership is target-specific and must still explain the current settlement,
  // including settlements dated outside this close. Resolve deposits/credit applications
  // from exact saved versions first, then their own explained parent changes.
  const trusted = new Map(), pending = settlementVersions.filter(row => row.outcome === 'saved' && row.op !== 'void' && row.targets.length && row.current && row.record?.Id && row.record.status !== 'Voided' && !row.record.PrivateNote?.startsWith?.('Voided') && row.current.status !== 'Voided' && !row.current.PrivateNote?.startsWith?.('Voided'));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of pending) {
      if (trusted.has(row.key)) continue;
      if (!require('./general-write-close').sameProvenRecord(row.key.split(':')[0], row.record, row.current, hash(row.record)) && !explainedByOwnSettlements(row.record, row.current, trusted, row.key.split(':')[0])) continue;
      trusted.set(row.key, { targets: row.targets, record: row.current }); changed = true;
    }
  }
  // A native estimate correction has a distinct, receipt-authenticated derived
  // state. It is not payment arithmetic and must not broaden settlement rules.
  const recovery = require('./general-estimate-recovery');
  for (const row of records.filter(record => record.entity === 'Estimate')) {
    const witnesses=[];
    for (const run of runs) for (const [ref,item] of Object.entries(run.items || {})) {
      if(item.reconciliation?.estimate?.Id!==row.id||!models.Receipts)continue;
      const receipt=await models.Receipts.findOne({_id:item.reconciliation.receiptId,...scope,kind:'general-write',state:'saved'}).maxTimeMS(3000).lean();
      const origin=recovery.sourceOf({...run,items:{...run.items,[ref]:{...item,outcome:'mismatch',record:item.originalSavedRecord}}},ref,receipt),assignment=await recovery.loadNativeAssignment({models,scope,source:origin,estimateOriginal:item.reconciliation.estimateOriginal});
      const witness=recovery.storedReconciliation(run,ref,receipt,scope,assignment);if(!witness)continue;
      const source=await recovery.loadEstimateCreation({Runs,Receipts:models.Receipts,scope,ownerId:run.ownerId,id:row.id});
      if(!source||source.operationId!==witness.evidence.sourceEstimate.operationId||source.receiptId!==witness.evidence.sourceEstimate.receiptId||hash(source.original)!==witness.evidence.sourceEstimate.recordHash||!recovery.assertEstimateTransition(source.original,row.current,item.qboId))continue;
      const invoice=await copy.read(scope,'Invoice',item.qboId);
      if(!require('./general-write-close').sameProvenRecord('Invoice',item.record,invoice,hash(item.record))&&!explainedByOwnSettlements(item.record,invoice,trusted,'Invoice'))continue;
      witnesses.push({source,item,witness});
    }
    if(witnesses.length!==1)continue;
    const {source,witness}=witnesses[0],proof=row.evidence.accountant;
    if(hash(proof.record)!==hash(source.original))continue;
    row.evidence={...row.evidence,accountant:{...proof,record:row.current,versionHash:hash(row.current),estimateConversion:{evidenceHash:witness.evidence.evidenceHash,originalRecord:source.original,originalStatus:source.original.TxnStatus,sourceOperationId:source.operationId}}};
  }
  for(const row of records.filter(r=>r.entity==='TimeActivity')){
    const billing=await require('./general-time-billing').deriveTimeBilling({models,scope,runs,row,copy,ownSettlements:trusted});
    if(!billing)continue;
    row.evidence={...row.evidence,accountant:{...row.evidence.accountant,record:row.current,versionHash:hash(row.current),originalTimeRecord:billing.original,timeBilling:billing.proof}};
  }
  const ownSettlements = [...trusted].map(([key, value]) => ({ key, targets: value.targets })).sort((a, b) => a.key.localeCompare(b.key));
  settlementVersions.sort((a, b) => a.key.localeCompare(b.key));
  return { records, dirty, ownSettlements, settlementVersions, runVersions: runs.map(run => ({ id: String(run._id), revision: run.revision ?? 0, items: run.items || {}, batches: run.batches || [] })) };
}
// Keep the public ownership/target list stable. Runtime consumers also require the
// exact current body and valid settlement arithmetic before explaining a parent.
function settlementEvidence(gathered) {
  const versions = new Map((gathered.settlementVersions || []).map(row => [row.key, row.current]));
  return (gathered.ownSettlements || []).map(row => ({ ...row, record: row.record || versions.get(row.key) }))
    .filter(row => row.record && require('./general-write-postings').settlementConsistent(row.key.split(':')[0], row.record));
}
// The day close for general records: classification, current postings against the
// ledger, movements for the period assertion, and dirty ranges through the cursor.
// Ledger rows of transactions that are not general records belong to the fixed
// workflows' own period proof and are returned for it, never silently accepted.
async function closeGeneralDayImplementation({ Runs, scope, day, through = day, copy, ledgerReport, ctx, ownSettlements = null, verifiedThrough, openingDate, gathered = null, models = {} }) {
  const ledger = parseLedger(ledgerReport, day, through, ctx.accountKey), evidence = gathered || await generalRecordsFor({ Runs, scope, day, through, copy, models }), { records:capturedRecords, dirty } = evidence;
  let currentRecords=capturedRecords;
  if(capturedRecords.some(r=>r.evidence?.accountant?.timeBilling)){
    const fresh=await generalRecordsFor({Runs,scope,day,through,copy,models});
    const persisted=v=>hash(JSON.parse(JSON.stringify(v)));
    if(persisted(fresh)!==persisted(evidence))fail('Owned time billing changed before close; fresh evidence is required');
    currentRecords=fresh.records;
  }
  const records=[];
  for(const row of currentRecords){
    const retained=row.evidence?.accountant?.apOmission;if(!retained){records.push(row);continue;}
    const proof=await require('./general-billpayment-recovery').resolveProof({models,scope,proof:retained,current:row.current});
    if(!proof)fail('Saved bill-payment account proof is unavailable or changed');
    records.push({...row,evidence:{...row.evidence,accountant:{...row.evidence.accountant,apOmission:proof}}});
  }
  if (records.some(row => [row.current, row.before].some(record => record?.CurrencyRef?.value && record.CurrencyRef.value !== 'CAD')) && ledgerReport?.Header?.Currency !== 'CAD') fail('Foreign records require a General Ledger explicitly expressed in CAD.');
  const omittedPayments=records.filter(row=>row.evidence?.accountant?.apOmission).map(row=>row.current);
  if(omittedPayments.length)require('./general-billpayment-recovery').validateLedgerForPayments(ledgerReport,day,through,omittedPayments);
  const settlements = new Map([...settlementEvidence(evidence), ...(ownSettlements || [])].map(row => [row.key, { targets: row.targets, record: row.record }]));
  const evaluation = evaluateDay({ records, ledger: ledger.byRecord, ownSettlements: settlements, ctx, fromDate: day, throughDate: through });
  const general = new Set(records.map(row => row.entity + ':' + row.id));
  const others = Object.keys(ledger.byRecord).filter(key => !general.has(key)).sort();
  if (ledger.unknown.length) evaluation.failures.push({ key: null, reason: ledger.unknown.length + ' General Ledger rows name a transaction type the close cannot attribute.', rows: ledger.unknown });
  return { ok: evaluation.failures.length === 0, day, through, records: evaluation.results, movements: evaluation.movements, failures: evaluation.failures, fixedWorkflowKeys: others, reverify: dirtyRange({ markers: dirty, verifiedThrough, openingDate }) };
}
function closeGeneralDay(input) {
  return require('./business-replay-evidence').captureFunction('general-write-day-close', 'closeGeneralDay', closeGeneralDayImplementation, [input]);
}
module.exports = { settlementEvidence, ledgerEndpoint, parseLedger, generalRecordsFor, readGeneralRuns, closeGeneralDay, LABELS, settlementLinks, SETTLEMENT_ENTITIES };
