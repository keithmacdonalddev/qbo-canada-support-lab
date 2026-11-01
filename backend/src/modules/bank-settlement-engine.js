'use strict';
const C = require('./bank-settlement-contract');
const TYPE_MAP = {
  'Journal Entry':'JournalEntry', 'Sales Tax Payment':'TaxPayment',
  'Sales Tax Adjustment':'TaxAdjustment', 'Expense':'Purchase',
  'Cheque Expense':'Purchase', 'Credit Card Expense':'Purchase',
  'Sales Receipt':'SalesReceipt', 'Bill Payment (Cheque)':'BillPayment',
  'Bill Payment (Credit Card)':'BillPayment', 'Refund':'RefundReceipt',
  'Credit Card Payment':'CreditCardPayment', CreditCardPaymentTxn:'CreditCardPayment',
};
const DEFAULT_POLICY = Object.freeze({ version:C.POLICY_VERSION, electronicLagDays:1,
  cardLagDays:1, chequeLagDays:5, bankingWeekdays:[1,2,3,4,5], holidays:[] });
const ref = value => value?.value === undefined ? null : String(value.value);
const entityName = value => TYPE_MAP[value] || value;
const key = (entity,id,accountId) => [entity,id,accountId].join(':');
const sourceKey = (entity,id) => [entity,id].join(':');
const external = account => ['Bank','Credit Card'].includes(account.type);
const card = account => account.type === 'Credit Card';
const reason = (code, details = {}) => ({ code, ...details });
function policyValue(supplied = {}) {
  const p = { ...DEFAULT_POLICY, ...supplied };
  if (p.version !== C.POLICY_VERSION || !['electronicLagDays','cardLagDays','chequeLagDays'].every(k => Number.isInteger(p[k]) && p[k] >= 0 && p[k] <= 366) ||
      !Array.isArray(p.bankingWeekdays) || !p.bankingWeekdays.length || p.bankingWeekdays.some(n => !Number.isInteger(n) || n < 0 || n > 6) || !Array.isArray(p.holidays)) throw new TypeError('Invalid settlement timing policy.');
  return { ...p, bankingWeekdays:[...new Set(p.bankingWeekdays)].sort(), holidays:[...new Set(p.holidays.map(C.date))].sort() };
}
function postingDate(bookDate, lag, policy) {
  const d = new Date(C.date(bookDate) + 'T00:00:00Z');
  if (lag > 0) d.setUTCDate(d.getUTCDate()+1);
  for (let i = 0; i < 4000; i++) {
    const result = d.toISOString().slice(0,10), banking = policy.bankingWeekdays.includes(d.getUTCDay()) && !policy.holidays.includes(result);
    if (banking && lag <= 1) return result;
    if (banking) lag--;
    d.setUTCDate(d.getUTCDate()+1);
  }
  throw new TypeError('Settlement calendar has no reachable posting date.');
}
function normalizeAccount(a) {
  const account = { id:String(a.id ?? a.Id ?? ''), name:a.name ?? a.Name ?? '',
    type:a.type ?? a.AccountType, subtype:a.subtype ?? a.AccountSubType ?? null,
    currency:a.currency ?? a.CurrencyRef?.value ?? null };
  if (!account.id || !account.type) throw new TypeError('Account identity and type are required.');
  if (account.currency !== null && !/^[A-Z]{3}$/.test(account.currency)) throw new TypeError('Invalid account currency.');
  return { ...account, evidenceType:account.subtype === 'CashOnHand' ? 'cash-count-or-cashbook' : 'bank-or-card-statement' };
}
/** Pure entry point. No models, network clients, clocks or persistent writes.
 * Input: {scope,homeCurrency,asOf,accounts,mirror:[{scope,entity,qboId,record,
 * observedAt}], ledger?:{scope,sourceId,observedAt,expectedRowCount,rows},policy?,
 * provisionalRanges?,priorEvents?}. Ledger bankAccountAmountCents is native book
 * movement (card: debt change), NOT home or transaction currency. Its name is
 * inherited from the retained report adapter. Unknown native money stays null.
 */
function buildSettlementEvents(input) {
  const scope = C.validateScope(input.scope), asOf = C.date(input.asOf);
  if (!/^[A-Z]{3}$/.test(input.homeCurrency || '')) throw new TypeError('Company home currency is required.');
  const policy = policyValue(input.policy), accounts = input.accounts.map(a => {
    if (a.scope) C.assertScope(a.scope,scope);
    return normalizeAccount(a);
  });
  const accountMap = new Map(accounts.map(a => [a.id,a]));
  if (accountMap.size !== accounts.length) throw new TypeError('Duplicate account identity.');
  const mirror = new Map(), candidates = new Map(), receipts = new Map(), depositLinks = [],
    nonSettlements = [], receiptBacklinkIssues = [], outstandingItems = [], ledgerCrosswalk = [], events = [], coverageIssues = [];
  const ledger = input.ledger;
  if (ledger) {
    C.assertScope(ledger.scope,scope);
    if (!ledger.sourceId || !ledger.observedAt || !Array.isArray(ledger.rows)) throw new TypeError('Retained ledger provenance is required.');
    if (ledger.expectedRowCount !== ledger.rows.length) coverageIssues.push(reason('ledger-row-count-unproved', { expected:ledger.expectedRowCount ?? null, actual:ledger.rows.length }));
  } else coverageIssues.push(reason('native-ledger-missing'));
  for (const item of input.mirror || []) {
    C.assertScope(item.scope || item,scope);
    const entity = entityName(item.entity), id = String(item.qboId ?? item.record?.Id ?? '');
    if (!id || !item.record || String(item.record.Id) !== id) throw new TypeError('Mirror source identity is inconsistent.');
    if (item.deleted) continue;
    const identity = sourceKey(entity,id);
    if (mirror.has(identity)) throw new TypeError('Duplicate mirrored source: ' + identity);
    mirror.set(identity,{ ...item, entity, qboId:id });
  }
  function add(item, accountId, amount, kind, why = null, lineIds = []) {
    const a = accountMap.get(accountId);
    if (!a || !external(a)) return;
    const id = key(item.entity,item.qboId,accountId);
    if (candidates.has(id)) throw new TypeError('Duplicate settlement leg: ' + id);
    candidates.set(id,{ item, account:a, amount, kind, why, lineIds });
  }
  function nativeAmount(item, accountId, amount, sign = 1) {
    const a = accountMap.get(accountId);
    const currency = item.record.CurrencyRef?.value;
    if (!a?.currency || (currency !== a.currency && !(item.entity === 'TaxPayment' && !currency && a.currency === input.homeCurrency))) return null;
    try { return C.integer(C.minor(amount) * sign); } catch { return null; }
  }
  // Deposit links take precedence over receipt account references, including
  // references QBO rewrites to the bank after the receipt was deposited.
  for (const item of mirror.values()) if (item.entity === 'Deposit') {
    for (const [index,line] of (item.record.Line || []).entries()) {
      const links = (line.LinkedTxn || []).filter(l => ['Payment','SalesReceipt'].includes(entityName(l.TxnType)));
      for (const link of links) {
        const entity = entityName(link.TxnType), id = String(link.TxnId), receiptKey = sourceKey(entity,id);
        let amountMinor = null;
        try { amountMinor = C.minor(line.Amount); } catch { /* recorded below */ }
        const entry = { depositId:item.qboId, depositLineId:String(line.Id ?? index),
          receiptEntity:entity, receiptId:id, receiptLineId:link.TxnLineId ?? null,
          lineAmountMinor:amountMinor, allocatedAmountMinor:links.length === 1 ? amountMinor : null,
          currency:item.record.CurrencyRef?.value ?? null };
        depositLinks.push(entry);
        const linked = receipts.get(receiptKey) || [];
        linked.push(entry); receipts.set(receiptKey,linked);
      }
    }
  }
  for (const item of mirror.values()) {
    const r = item.record, entity = item.entity, currency = r.CurrencyRef?.value;
    if (['Payment','SalesReceipt'].includes(entity)) {
      const links = receipts.get(sourceKey(entity,item.qboId));
      const backlinks = [...(r.LinkedTxn || []),...(r.Line || []).flatMap(l => l.LinkedTxn || [])].filter(l => l.TxnType === 'Deposit');
      const unproved = backlinks.filter(l => !links?.some(entry => entry.depositId === String(l.TxnId)));
      if (unproved.length) {
        const why = reason('receipt-deposit-backlink-unproved',{entity,id:item.qboId,depositIds:[...new Set(unproved.map(l => String(l.TxnId)))].sort()});
        coverageIssues.push(why); receiptBacklinkIssues.push({why,depositIds:(links || []).map(l => l.depositId)});
        if (!links) {
          const accountId = ref(r.DepositToAccountRef);
          add(item,accountId,nativeAmount(item,accountId,r.TotalAmt),'unresolved-receipt',why);
          outstandingItems.push({kind:'unresolved-deposit-link',entity,id:item.qboId,accountId,reason:why});
          continue;
        }
      }
      if (links) {
        nonSettlements.push({ entity,id:item.qboId,code:'receipt-in-deposit',depositIds:[...new Set(links.map(l => l.depositId))].sort() });
        continue;
      }
      const accountId = ref(r.DepositToAccountRef), account = accountMap.get(accountId);
      if (!account || !external(account)) {
        let amountMinor = null;
        try { amountMinor = C.minor(r.TotalAmt); } catch { /* unknown money */ }
        if (amountMinor !== 0) outstandingItems.push({ kind:'undeposited-receipt',entity,id:item.qboId,
          accountId,currency:currency || null,amountMinor,bookDate:r.TxnDate || null,
          expectedPostingDate:null,reason:'Receipt requires a bank deposit; no bank line is created.' });
        else nonSettlements.push({ entity,id:item.qboId,code:'zero-receipt' });
        continue;
      }
      add(item,accountId,nativeAmount(item,accountId,r.TotalAmt),'direct-receipt');
    } else if (['Deposit','Invoice','RefundReceipt'].includes(entity)) {
      if (entity === 'Invoice' && (r.Deposit === undefined || r.Deposit === 0)) continue;
      const accountId = ref(r.DepositToAccountRef);
      add(item,accountId,nativeAmount(item,accountId,entity === 'Invoice' ? r.Deposit : r.TotalAmt,entity === 'RefundReceipt' ? -1 : 1),
        entity === 'Deposit' ? 'deposit' : entity === 'Invoice' ? 'invoice-deposit' : 'refund');
    } else if (entity === 'Purchase') {
      const accountId = ref(r.AccountRef);
      add(item,accountId,nativeAmount(item,accountId,r.TotalAmt,r.Credit === true ? 1 : -1),r.Credit === true ? 'card-credit' : 'purchase');
    } else if (entity === 'BillPayment') {
      const accountId = ref(r.CheckPayment?.BankAccountRef) || ref(r.CreditCardPayment?.CCAccountRef);
      add(item,accountId,nativeAmount(item,accountId,r.TotalAmt,-1),'bill-payment');
    } else if (['Transfer','CreditCardPayment'].includes(entity)) {
      const from = ref(entity === 'Transfer' ? r.FromAccountRef : r.BankAccountRef);
      const to = ref(entity === 'Transfer' ? r.ToAccountRef : r.CreditCardAccountRef);
      add(item,from,nativeAmount(item,from,r.Amount,-1),'transfer-out');
      add(item,to,nativeAmount(item,to,r.Amount,1),'transfer-in');
    } else if (entity === 'TaxPayment') {
      const accountId = ref(r.PaymentAccountRef);
      // TaxPayment.PaymentAmount is signed: retained refund 460 is -775.50.
      // Negate it once; Refund corroborates intent but must not reverse it again.
      add(item,accountId,nativeAmount(item,accountId,r.PaymentAmount,-1),'tax-payment');
    } else if (entity === 'JournalEntry') {
      const grouped = new Map();
      for (const line of r.Line || []) {
        const d = line.JournalEntryLineDetail;
        if (!d) continue;
        const accountId = ref(d.AccountRef), lines = grouped.get(accountId) || [];
        lines.push(line); grouped.set(accountId,lines);
      }
      for (const [accountId,lines] of grouped) {
        let amount = null;
        try {
          if (lines.every(l => ['Debit','Credit'].includes(l.JournalEntryLineDetail.PostingType))) {
            const values = lines.map(l => nativeAmount(item,accountId,l.Amount,l.JournalEntryLineDetail.PostingType === 'Debit' ? 1 : -1));
            if (values.every(v => v !== null)) amount = C.sum(values);
          }
        } catch { /* retain unknown amount */ }
        add(item,accountId,amount,'journal',reason('journal-economic-meaning-unclassified'),lines.map(l => String(l.Id ?? '')));
      }
    }
  }
  const linkIssues = new Map();
  function blockDeposit(id, why) { const issues = linkIssues.get(id) || []; issues.push(why); linkIssues.set(id,issues); }
  for (const issue of receiptBacklinkIssues) for (const id of issue.depositIds) blockDeposit(id,issue.why);
  for (const [receiptKey,links] of receipts) {
    const receipt = mirror.get(receiptKey), depositIds = new Set(links.map(l => l.depositId));
    let why = !receipt ? reason('deposit-receipt-missing',{receipt:receiptKey}) :
      depositIds.size > 1 || links.length > 1 ? reason('duplicate-or-split-deposit-link',{receipt:receiptKey,depositIds:[...depositIds].sort()}) :
      links[0].allocatedAmountMinor === null ? reason('deposit-line-allocation-unknown',{receipt:receiptKey}) : null;
    if (!why && receipt.record.CurrencyRef?.value === links[0].currency) {
      try { if (C.minor(receipt.record.TotalAmt) !== links[0].allocatedAmountMinor) why = reason('deposit-receipt-amount-mismatch',{receipt:receiptKey}); }
      catch { why = reason('deposit-receipt-amount-unknown',{receipt:receiptKey}); }
    } else if (!why) why = reason('deposit-receipt-currency-allocation-unproved',{receipt:receiptKey});
    if (why) for (const link of links) blockDeposit(link.depositId,why);
  }
  const rows = new Map();
  for (const [index,row] of (ledger?.rows || []).entries()) {
    const entity = entityName(row.entity || row.type), id = String(row.transactionId ?? row.qboId ?? ''), accountId = String(row.accountId);
    if (!id || !entity || !accountMap.has(accountId)) throw new TypeError('Retained ledger account/source identity is incomplete.');
    if (row.scope) C.assertScope(row.scope,scope);
    C.date(row.date);
    for (const field of ['homeAmountCents','foreignTransactionAmountCents']) if (row[field] !== undefined && row[field] !== null) C.integer(row[field]);
    if (row.bankAccountAmountCents !== null && row.bankAccountAmountCents !== undefined) C.integer(row.bankAccountAmountCents);
    const identity = key(entity,id,accountId);
    // Two net rows without stable line identities must be resolved upstream,
    // rather than assigned unstable array-index event identities.
    if (rows.has(identity)) throw new TypeError('Ambiguous repeated account-native ledger leg: ' + identity);
    rows.set(identity,{ row,index,entity,id,accountId });
    if (!candidates.has(identity)) {
      const item = mirror.get(sourceKey(entity,id));
      candidates.set(identity,{ item:item || { entity,qboId:id,record:{Id:id},observedAt:null },account:accountMap.get(accountId),amount:null,
        kind:entity === 'TaxAdjustment' ? 'report-only-adjustment' : 'unclassified',
        why:reason(entity === 'TaxAdjustment' ? 'report-only-adjustment-economic-meaning-unclassified' : item ? 'unexpected-account-ledger-leg' : 'ledger-source-not-mirrored'),lineIds:[] });
    }
  }
  const ordered = [...candidates.entries()].sort(([a],[b]) => a.localeCompare(b));
    for (const [identity,candidate] of ordered) {
    const {item,account,kind,lineIds} = candidate, r = item.record;
    const evidence = rows.get(identity), row = evidence?.row;
    let why = candidate.why;
    const accountCurrency = account.currency;
    if (!accountCurrency) { why = reason('account-currency-missing',{accountId:account.id}); coverageIssues.push(why); }
    let bookAmountMinor = row?.bankAccountAmountCents ?? null;
    let amountMinor = bookAmountMinor === null ? candidate.amount : C.integer(bookAmountMinor * (card(account) ? -1 : 1));
    if (bookAmountMinor === null && amountMinor !== null) bookAmountMinor = C.integer(amountMinor * (card(account) ? -1 : 1));
    const linked = receipts.get(sourceKey(item.entity,item.qboId));
    if (linked) why = reason('receipt-already-in-deposit-ledger-conflict',{depositIds:linked.map(l => l.depositId)});
    if (!row) why = reason('native-ledger-evidence-missing',{entity:item.entity,id:item.qboId,accountId:account.id,...(why ? {cause:why} : {})});
    else if (row.bankAccountAmountCents === null || row.bankAccountAmountCents === undefined) {
      amountMinor = null; bookAmountMinor = null;
      why = reason('account-native-currency-allocation-unknown',{transactionCurrency:row.transactionCurrency || null,accountCurrency});
    }
    else if (candidate.amount !== null && candidate.amount !== amountMinor) why = reason('mirror-native-ledger-amount-mismatch',{mirrorAmountMinor:candidate.amount,ledgerAmountMinor:amountMinor});
    if (!accountCurrency) why = reason('account-currency-missing',{accountId:account.id});
    const bookDate = row?.date || r.TxnDate || r.PaymentDate || null;
    if (row && (r.TxnDate || r.PaymentDate) && bookDate !== (r.TxnDate || r.PaymentDate)) why = reason('mirror-ledger-date-mismatch',{mirrorDate:r.TxnDate || r.PaymentDate,ledgerDate:bookDate});
    if (item.entity === 'Deposit' && linkIssues.has(item.qboId)) why = reason('deposit-link-evidence-invalid',{issues:linkIssues.get(item.qboId)});
    // Financial meaning must be supported independently for journals/report-only
    // adjustments. An account posting by itself is not a statement movement.
    if (['journal','report-only-adjustment'].includes(kind) && row?.economicMeaning &&
        ['bank-fee','interest','tax-settlement','cash-adjustment'].includes(row.economicMeaning.kind) && row.economicMeaning.evidenceRef && why?.code === candidate.why?.code) why = null;
    if (!accountCurrency) why = reason('account-currency-missing',{accountId:account.id});
    if (row && amountMinor === 0 && !linked && (!why || ['journal-economic-meaning-unclassified'].includes(why.code))) {
      const code = item.entity === 'JournalEntry' && row.homeAmountCents !== 0 ? 'revaluation-zero-native-cash' : 'zero-native-movement';
      nonSettlements.push({ entity:item.entity,id:item.qboId,accountId:account.id,code,
        nativeAmountMinor:0,homeAmountMinor:row.homeAmountCents ?? null,ledgerRowIndex:evidence.index,sourceHash:C.hash({record:r,row}) });
      ledgerCrosswalk.push({rowIndex:evidence.index,entity:item.entity,id:item.qboId,accountId:account.id,eventId:null,status:code});
      continue;
    }
    if (!bookDate) why = reason('book-date-missing'); else C.date(bookDate);
    if (amountMinor === null && !why) why = reason('account-native-currency-allocation-unknown');
    const eventId = C.stableEventId(scope,item.entity,item.qboId,account.id);
    const cheque = r.PaymentType === 'Check' || Boolean(r.CheckPayment) || /Cheque/.test(row?.type || '');
    const lag = cheque ? policy.chequeLagDays : card(account) ? policy.cardLagDays : policy.electronicLagDays;
    const expectedPostingDate = bookDate ? postingDate(bookDate,lag,policy) : null;
    const actualPostingDate = row?.actualPostingDate && row.actualPostingEvidenceRef ? C.date(row.actualPostingDate) : null;
    if (row?.actualPostingDate && !row.actualPostingEvidenceRef) why = reason('actual-posting-evidence-missing');
    const depositBreakdown = item.entity === 'Deposit' ? (r.Line || []).map((l,i) => ({lineId:String(l.Id ?? i),
      amountMinor:(() => {try {return C.minor(l.Amount);} catch {return null;}})(),
      currency:r.CurrencyRef?.value || null, accountId:ref(l.DepositLineDetail?.AccountRef), linkedQboIds:(l.LinkedTxn || []).map(l => ({entity:entityName(l.TxnType),id:String(l.TxnId)}))})) : [];
    const event = { contractVersion:C.CONTRACT_VERSION,eventId,scope:{...scope},accountId:account.id,accountCurrency,
      accountType:account.type,evidenceType:account.evidenceType,kind,status:why ? 'unresolved' : 'resolved',amountMinor,
      bookAmountMinor,cardDebtChangeMinor:card(account) ? bookAmountMinor : null,
      direction:amountMinor === null ? 'unknown' : amountMinor > 0 ? 'inflow' : amountMinor < 0 ? 'outflow' : 'none',
      settlementGroupId:'bsg1_' + C.hash({scope,entity:item.entity,id:item.qboId}).slice(0,40),pairedEventId:null,
      bookDate,expectedPostingDate,actualPostingDate,statementPeriod:(actualPostingDate || expectedPostingDate)?.slice(0,7) || null,
      postingBasis:actualPostingDate ? 'retained-posting-evidence' : 'simulated-policy',
      source:{entity:item.entity,id:item.qboId,lineIds,sourceHash:C.hash({record:r,row:row || null}),
        syncObservedAt:item.observedAt || item.lastObservedAt || null,ledgerSourceId:row ? ledger.sourceId : null,
        ledgerObservedAt:row ? ledger.observedAt : null,ledgerRowIndex:evidence?.index ?? null,
        transactionCurrency:r.CurrencyRef?.value || row?.transactionCurrency || null,
        homeCurrency:input.homeCurrency,homeAmountMinor:row?.homeAmountCents ?? null,
        foreignTransactionAmountMinor:row?.foreignTransactionAmountCents ?? null,
        nativeAmountBasis:row && row.bankAccountAmountCents !== null && row.bankAccountAmountCents !== undefined ? 'retained-account-native-ledger' : candidate.amount !== null ? 'same-currency-mirror' : 'unknown',
        actualPostingEvidenceRef:row?.actualPostingEvidenceRef || null,exchangeRate:r.ExchangeRate ?? null,nativeStatus:row?.status || null,
        depositBreakdown,depositLinks:depositLinks.filter(l => l.depositId === item.qboId && item.entity === 'Deposit')},
      resolution:{action:why ? 'investigate' : 'Match',reason:why,linkedQboIds:[{entity:item.entity,id:item.qboId},
        ...depositLinks.filter(l => item.entity === 'Deposit' && l.depositId === item.qboId).map(l => ({entity:l.receiptEntity,id:l.receiptId}))],
        designatedCreator:'existing-qbo',nativeMatchVerified:false,
        nativeInspectionRequired:row?.status === 'R',
        nativeActionBlockers:row?.status === 'R' ? ['existing-reconciled-mark-requires-native-inspection'] : []},
      timingPolicy:policy,policyVersion:policy.version,revision:1,supersededBy:null,generatedFileReferences:[] };
    events.push(event);
    if (evidence) ledgerCrosswalk.push({rowIndex:evidence.index,entity:item.entity,id:item.qboId,accountId:account.id,eventId,status:event.status});
  }
  const groups = new Map();
  for (const event of events) if (['Transfer','CreditCardPayment'].includes(event.source.entity)) {
    const group = groups.get(event.settlementGroupId) || []; group.push(event); groups.set(event.settlementGroupId,group);
  }
  for (const legs of groups.values()) {
    if (legs.length === 2) {
      legs[0].pairedEventId = legs[1].eventId; legs[1].pairedEventId = legs[0].eventId;
      const sameCurrency = legs[0].accountCurrency === legs[1].accountCurrency;
      const invalid = legs.some(l => l.status !== 'resolved') ||
        (sameCurrency && C.sum(legs.map(l => l.amountMinor)) !== 0) ||
        (!sameCurrency && !(legs.some(l => l.amountMinor > 0) && legs.some(l => l.amountMinor < 0)));
      if (invalid) for (const leg of legs) {
        const ownReason = leg.resolution.reason;
        leg.status = 'unresolved'; leg.resolution = {...leg.resolution,action:'investigate',reason:reason('paired-settlement-unproved',{ownReason,pairedEventId:leg.pairedEventId})};
      }
    } else for (const leg of legs) {
      leg.status = 'unresolved'; leg.resolution = {...leg.resolution,action:'investigate',reason:reason('paired-account-leg-missing')};
    }
  }
  const prior = new Map((input.priorEvents || []).map(event => { C.assertScope(event.scope,scope); return [event.eventId,event]; }));
  for (const event of events) {
    const old = prior.get(event.eventId);
    if (old) { event.revision = old.revision + (old.source.sourceHash === event.source.sourceHash && C.hash(old.timingPolicy || {}) === C.hash(policy) ? 0 : 1); }
    C.validateEvent(event);
    const posting = event.actualPostingDate || event.expectedPostingDate;
    if (event.status === 'resolved' && event.bookDate <= asOf && posting > asOf) outstandingItems.push({
      kind:event.amountMinor > 0 ? 'deposit-in-transit' : event.kind === 'bill-payment' || event.kind === 'purchase' ? 'outstanding-payment' : 'pending-settlement',
      eventId:event.eventId,accountId:event.accountId,currency:event.accountCurrency,amountMinor:event.amountMinor,
      bookDate:event.bookDate,expectedPostingDate:posting,postingBasis:event.postingBasis });
  }
  // Recompute after pair validation so crosswalk status always agrees with events.
  const eventMap = new Map(events.map(e => [e.eventId,e]));
  for (const row of ledgerCrosswalk) if (row.eventId) row.status = eventMap.get(row.eventId).status;
  const unresolvedEvents = events.filter(e => e.status === 'unresolved');
  if (ledgerCrosswalk.length !== (ledger?.rows.length || 0)) coverageIssues.push(reason('ledger-crosswalk-incomplete'));
  const accountSummaries = accounts.filter(external).map(a => ({accountId:a.id,currency:a.currency,evidenceType:a.evidenceType,
    ledgerRows:ledgerCrosswalk.filter(r => r.accountId === a.id).length,
    nativeBookMovementMinor:!ledger || (ledger.rows || []).some(r => String(r.accountId) === a.id && !Number.isSafeInteger(r.bankAccountAmountCents)) ? null : C.sum(ledger.rows.filter(r => String(r.accountId) === a.id).map(r => r.bankAccountAmountCents)),
    unresolvedEventIds:unresolvedEvents.filter(e => e.accountId === a.id).map(e => e.eventId),
    packageBlocked:coverageIssues.length > 0 || unresolvedEvents.some(e => e.accountId === a.id)}));
  events.sort((a,b) => (a.bookDate || '').localeCompare(b.bookDate || '') || a.eventId.localeCompare(b.eventId));
  depositLinks.sort((a,b) => C.canonical(a).localeCompare(C.canonical(b)));
  ledgerCrosswalk.sort((a,b) => a.rowIndex-b.rowIndex);
  return { version:C.CONTRACT_VERSION,contractVersion:C.CONTRACT_VERSION,kind:'bank-settlement-dataset',scope,homeCurrency:input.homeCurrency,asOf,
    sourceHash:C.hash({scope,mirror:[...mirror.values()].map(m => ({entity:m.entity,id:m.qboId,record:m.record})).sort((a,b)=>sourceKey(a.entity,a.id).localeCompare(sourceKey(b.entity,b.id))),
      ledger:ledger || null,accounts}),policy,accounts,events,unresolvedEvents,nonSettlements,depositLinks,outstandingItems,ledgerCrosswalk,
    provisionalRanges:input.provisionalRanges || [],accountSummaries,
    coverage:{complete:false,mirrorAloneProvesCoverage:false,nativeBankStateVerified:false,
      retainedLedgerRows:ledger?.rows.length || 0,representedLedgerRows:ledgerCrosswalk.length,
      unresolvedEvents:unresolvedEvents.length,issues:coverageIssues,blockedAccountIds:accountSummaries.filter(a=>a.packageBlocked).map(a=>a.accountId),
      packageBlocked:coverageIssues.length > 0 || unresolvedEvents.length > 0,
      basis:ledger ? 'Retained native ledger replay; bank-feed and reconciliation state remain unverified.' : 'Mirror only; native ledger coverage is unproved.'},
    summary:{events:events.length,resolvedEvents:events.length-unresolvedEvents.length,unresolvedEvents:unresolvedEvents.length,
      retainedLedgerRows:ledger?.rows.length || 0,depositLinks:depositLinks.length,
      undepositedReceipts:outstandingItems.filter(i => i.kind === 'undeposited-receipt').length} };
}
module.exports = { buildSettlementEvents, buildSettlementDataset:buildSettlementEvents, DEFAULT_POLICY, postingDate };
