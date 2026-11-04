'use strict';
const C = require('./bank-settlement-contract');
const { accountOf, validateOriginEvent } = require('./bank-origin-events');
const clone = value => JSON.parse(JSON.stringify(value));
const keyFor = event => (event.policyVersion===require('./bank-origin-events').RETURN_VERSION?'bank_origin_return_':'bank_origin_') + C.hash({scope:event.scope,scenarioId:event.source.id}).slice(0,40);
const markerFor = event => '[bank-origin:' + C.hash({scope:event.scope,scenarioId:event.source.id}).slice(0,40) + ']';
const money = n => { C.integer(n); const value = n / 100; if (C.minor(value) !== n) throw new TypeError('Amount cannot be represented exactly in a governed payload.'); return value; };
/** Pure proposal preparation. The caller supplies a FRESH COMPLETE scoped mirror,
 * persisted BF4 reservations (all legs), and the existing general-write guard.
 * No result here is dispatch authority. Persist the reservation before either API
 * or browser work, then recheck copy + decisionKey via governed execution. Never
 * release/reassign ownership after an uncertain send or native Add.
 */
function prepareBankOriginResolution({event, accounts, reservation, reservations = [], mirrorSnapshot, decisions = [], asOf, maxAgeMs = 300000, checkDraft}) {
  validateOriginEvent(event);
  const scope = C.validateScope(event.scope), s = event.source.advice;
  const decisionKey = keyFor(event), marker = markerFor(event);
  const result = {eventId:event.eventId,scope,decisionKey,sourceHash:event.source.sourceHash,creator:event.resolution.designatedCreator,
    status:'blocked',blockers:[],draft:null,nativeTask:null,requiresGovernedExecution:true,nativeStateVerified:false};
  const block = (code, details = {}) => { result.blockers.push({code,...details}); return result; };
  const a = accountOf(accounts,event.accountId);
  if (a.currency !== event.accountCurrency || a.type !== event.accountType) return block('account-shape-changed');
  if (event.status !== 'resolved') {
    result.nativeTask={operator:'owner-browser-automation',action:'Investigate',scope,accountId:event.accountId,accountCurrency:event.accountCurrency,eventIds:[event.eventId],reason:event.resolution.reason,createsBookkeeping:false,verified:false,steps:['Inspect advice and native records; do not Add, expense returned principal, force a match or create a balancing entry.','Retain exact screen/record evidence and resolve the stated financial ambiguity first.']};
    return block(event.resolution.reason.code);
  }
  const creator = event.resolution.designatedCreator;
  const claims = [...reservations,...(reservation ? [reservation] : [])].map(r => r.payload || r);
  const ids = [event.eventId,...(event.pairedEventId ? [event.pairedEventId] : [])];
  for (const eventId of ids) {
    const claim = claims.find(r => r.eventId === eventId);
    if (!claim) return block('creator-reservation-required',{eventId});
    C.assertScope(claim.scope,scope);
    const expectedAccount = eventId === event.eventId ? event.accountId : event.accountId === s.accountId ? s.toAccountId : s.accountId;
    if (claim.creator !== (creator === 'existing-qbo' ? 'none' : creator) || claim.accountId !== expectedAccount || claim.period !== event.statementPeriod) return block('creator-reservation-conflict',{eventId});
  }
  const observed=inspectExistingBookkeeping({event,mirrorSnapshot,decisions,asOf,maxAgeMs});
  if(observed.blockers.length){result.blockers.push(...observed.blockers);return result;}
  const records=observed.records,snapshot=mirrorSnapshot;result.mirrorHash=observed.mirrorHash;
  const task = action => ({operator:'owner-browser-automation',action,scope,accountId:event.accountId,accountCurrency:event.accountCurrency,
    eventIds:ids,settlementGroupId:event.settlementGroupId,amountMinor:event.amountMinor,postingDate:event.actualPostingDate,
    marker,decisionKey,creator,steps:['Assert company, account, currency and exact file/row identity.','Inspect existing posted records and pending feed items before acting.','Stop on ambiguity or interrupted/unknown prior action; retain screen evidence.'],
    completionRequires:['screen-observed evidence','synced record identity for Add/Match','zero-difference native report for reconciliation'],verified:false});
  if (event.kind === 'duplicate-test') { result.status='native-task'; result.nativeTask={...task('Exclude'),separateDuplicateTestFile:true,createsBookkeeping:false}; return result; }
  if (creator === 'native-add') {
    // NSF principal and transfers must never fall through to expense categorization.
    if (event.kind === 'nsf-return') return block('nsf-needs-receivable-correction');
    result.status='native-task'; result.nativeTask={...task(event.kind === 'bank-transfer' ? 'Transfer' : 'Add'),
      counterpartAccountId:s.counterpartAccountId || null,taxTreatment:s.taxTreatment || null,taxCodeId:s.taxCodeId || null,netAmountMinor:s.netAmountMinor ?? null,accountingAmountMinor:s.amountMinor,createsBookkeeping:true,oneAccountingRecordForBothLegs:event.kind === 'bank-transfer',
      fromAccountId:event.kind === 'bank-transfer' ? s.accountId : null,toAccountId:s.toAccountId || null};
    if (event.kind !== 'bank-transfer') {
      const cp = accounts.find(a => String(a.id ?? a.Id) === s.counterpartAccountId);
      const type = cp?.type ?? cp?.AccountType;
      if (!cp || cp.Active === false || !(event.kind === 'interest-income' ? ['Income','Other Income'] : ['Expense','Other Expense']).includes(type) || !['out-of-scope','taxable'].includes(s.taxTreatment) || s.taxTreatment === 'taxable' && (!s.taxCodeId || !Number.isSafeInteger(s.netAmountMinor) || s.netAmountMinor <= 0 || s.netAmountMinor > Math.abs(event.amountMinor))) return blockNative('counterpart-and-tax-treatment-required');
    }
    result.nativeTask.steps.push('Verify category, tax treatment and exact gross bank amount in the native preview before Add.');
    return result;
  }
  function blockNative(code) { result.status='blocked'; result.nativeTask=null; return block(code); }
  let payload = {TxnDate:event.bookDate,CurrencyRef:{value:event.accountCurrency},PrivateNote:marker+' Simulated '+event.kind+'; advice '+s.advice.reference};
  let entity;
  const cp = accounts.find(a => String(a.id ?? a.Id) === s.counterpartAccountId);
  const cpType = cp?.type ?? cp?.AccountType;
  const ref = id => ({value:String(id)});
  const line = (amount,posting,accountId,party) => ({Amount:money(amount),DetailType:'JournalEntryLineDetail',JournalEntryLineDetail:{PostingType:posting,AccountRef:ref(accountId),...(party ? {Entity:{Type:'Customer',EntityRef:ref(party)}} : {})}});
  if (event.kind === 'bank-transfer') {
    const from = accountOf(accounts,s.accountId), to = accountOf(accounts,s.toAccountId);
    if (from.currency !== to.currency || from.currency !== event.accountCurrency) return block('fx-transfer-requires-governed-currency-proof');
    entity='Transfer'; payload={...payload,FromAccountRef:ref(from.id),ToAccountRef:ref(to.id),Amount:money(s.amountMinor)};
  } else if (event.kind === 'nsf-return') {
    const payment = records.get('Payment:'+s.originalQboId), ar = accounts.find(a => String(a.id ?? a.Id) === s.receivablesAccountId);
    if (!payment || payment.DepositToAccountRef?.value !== event.accountId || payment.CurrencyRef?.value !== event.accountCurrency || C.minor(payment.TotalAmt) !== -event.amountMinor || !payment.CustomerRef?.value || !payment.ARAccountRef?.value || payment.ARAccountRef.value !== s.receivablesAccountId || (ar?.type ?? ar?.AccountType) !== 'Accounts Receivable' || ar?.Active === false) return block('nsf-receivable-allocation-unproved');
    const original = snapshot.settlementEvents.find(e=>e.eventId === s.originalEventId);
    if (!original || original.status !== 'resolved' || original.amountMinor !== -event.amountMinor || original.source.id !== s.originalQboId) return block('nsf-original-settlement-changed');
    entity='JournalEntry'; payload.Line=[line(-event.amountMinor,'Debit',s.receivablesAccountId,payment.CustomerRef.value),line(-event.amountMinor,'Credit',event.accountId)];
  } else {
    const income = event.kind === 'interest-income';
    if (!cp || cp.Active === false || !(income ? ['Income','Other Income'] : ['Expense','Other Expense']).includes(cpType)) return block('counterpart-account-required');
    const amount = Math.abs(event.amountMinor);
    if (s.taxTreatment === 'out-of-scope') {
      entity='JournalEntry'; payload.Line=income ? [line(amount,'Debit',event.accountId),line(amount,'Credit',s.counterpartAccountId)] : [line(amount,'Debit',s.counterpartAccountId),line(amount,'Credit',event.accountId)];
    } else if (!income && s.taxTreatment === 'taxable' && s.taxCodeId && Number.isSafeInteger(s.netAmountMinor) && s.netAmountMinor > 0 && s.netAmountMinor <= amount) {
      entity='Purchase'; payload={...payload,PaymentType:a.type === 'Credit Card' ? 'CreditCard' : 'Cash',AccountRef:ref(event.accountId),GlobalTaxCalculation:'TaxExcluded',Line:[{Amount:money(s.netAmountMinor),DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:ref(s.counterpartAccountId),TaxCodeRef:ref(s.taxCodeId)}}]};
    } else return block('explicit-tax-treatment-required');
  }
  const draft = {decisionKey,purpose:'Record explicit simulated '+event.kind+' from '+s.advice.reference,operations:[{ref:'bank-origin',op:'create',entity,payload}]};
  if (typeof checkDraft !== 'function') return block('governed-draft-check-required');
  const checked = checkDraft(clone(draft));
  if (!checked || checked.ok !== true || !Number.isSafeInteger(checked.bankAmountMinor) || checked.bankAmountMinor !== (event.kind === 'bank-transfer' ? -s.amountMinor : event.amountMinor)) return block('governed-draft-refused',{problems:checked?.problems || [],expectedBankAmountMinor:event.kind === 'bank-transfer' ? -s.amountMinor : event.amountMinor});
  result.status='accounting-draft'; result.draft=draft; result.nativeTask=task('Match-after-sync');
  result.executionRequirements=['Persist immutable BF4 creator reservations for every leg.','Recheck the complete mirror and stable decisionKey inside governed execution.','Dispatch only through manageQboRecord; verify bank-native movement, then sync before matching.'];
  return result;
}

function inspectExistingBookkeeping({
  event,
  mirrorSnapshot: snapshot,
  decisions = [],
  asOf,
  maxAgeMs = 300000
}) {
  const scope = C.validateScope(event.scope),
    decisionKey = keyFor(event),
    marker = markerFor(event),
    s = event.source.advice,
    blockers = [];
  const block = (code, details = {}) => ({
    blockers: [{
      code,
      ...details
    }],
    records: new Map(),
    mirrorHash: null
  });
  if (!snapshot) return block('complete-current-mirror-required');
  C.assertScope(snapshot.scope, scope);
  const now = Date.parse(asOf),
    observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(observed) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 300000 || observed > now || now - observed > maxAgeMs || snapshot.complete !== true || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.settlementEvents)) return block('complete-current-mirror-required');
  const records = new Map();
  for (const m of snapshot.records) {
    C.assertScope(m.scope, scope);
    if (!m.record || String(m.record.Id) !== String(m.qboId) || records.has(m.entity + ':' + m.qboId)) return block('mirror-identity-invalid');
    records.set(m.entity + ':' + m.qboId, m.record);
  }
  for (const e of snapshot.settlementEvents) {
    C.assertScope(e.scope, scope);
    C.validateEvent(e);
  }
  const mirrorHash = C.hash(snapshot);
  const previous = decisions.filter(d => {
    C.assertScope(d.scope, scope);
    return d.decisionKey === decisionKey;
  });
  if (previous.length) return block('decision-already-reserved-or-sent', {
    states: previous.map(d => d.state || 'unknown')
  });
  if (event.kind === 'nsf-return' && snapshot.settlementEvents.some(e => e.source.entity === 'BankOrigin' && e.kind === 'nsf-return' && e.source.advice?.originalEventId === s.originalEventId && e.source.id !== event.source.id)) return block('returned-principal-already-claimed');
  const existing = snapshot.records.filter(m => String(m.record.PrivateNote || '').includes(marker));
  if (existing.length) return block('bookkeeping-already-present', {
    linkedQboIds: existing.map(m => ({
      entity: m.entity,
      id: String(m.qboId)
    }))
  });
  // Unmarked matching money is ambiguous, never permission for another create.
  const isReturn = event.policyVersion === require('./bank-origin-events').RETURN_VERSION;
  if (isReturn) {
    const inverse = returnDraft(event).operations[0].payload,
      expected = require('./bank-origin-events').buildSourceBoundReturnEvents({
        source: s.returnOf,
        request: s.request,
        postingDate: event.actualPostingDate
      });
    const sameInverse = r => r.TxnDate === inverse.TxnDate && r.FromAccountRef?.value === inverse.FromAccountRef.value && r.ToAccountRef?.value === inverse.ToAccountRef.value && (r.CurrencyRef?.value === undefined || r.CurrencyRef.value === 'CAD') && C.minor(r.Amount) === C.minor(inverse.Amount);
    const possible = snapshot.records.filter(m => m.entity === 'Transfer' && sameInverse(m.record));
    if (possible.length) return block('possible-existing-bookkeeping', {
      linkedQboIds: possible.map(m => ({
        entity: m.entity,
        id: String(m.qboId)
      }))
    });
    // Any observed posting source with matching native money is ambiguous.
    // Exempt each exact own derived event; an own member never exempts another match.
    const match = snapshot.settlementEvents.filter(e => !expected.some(own => C.hash(own) === C.hash(e)) && expected.some(own => e.accountId === own.accountId && e.accountCurrency === own.accountCurrency && e.amountMinor === own.amountMinor) && [e.bookDate, e.actualPostingDate, e.expectedPostingDate].includes(event.bookDate));
    if (match.length) return block('possible-existing-bookkeeping', {
      eventIds: match.map(e => e.eventId)
    });
    const other = snapshot.settlementEvents.filter(e => e.source.entity === 'BankOrigin' && e.kind === 'transfer-reversal' && e.source.advice?.returnOf?.returnId === s.returnOf.returnId && !expected.some(own => C.hash(own) === C.hash(e)));
    if (other.length) return block('returned-principal-already-claimed', {
      eventIds: other.map(e => e.eventId)
    });
  } else {
    const match = snapshot.settlementEvents.filter(e => !(e.source.entity === 'BankOrigin' && e.source.id === event.source.id) && e.accountId === event.accountId && e.accountCurrency === event.accountCurrency && e.amountMinor === event.amountMinor && [e.bookDate, e.actualPostingDate, e.expectedPostingDate].includes(event.bookDate));
    if (match.length && event.kind !== 'duplicate-test') return block('possible-existing-bookkeeping', {
      eventIds: match.map(e => e.eventId)
    });
  }
  return {
    blockers,
    records,
    mirrorHash
  };
}

function returnDraft(event) {
  const E = require('./bank-origin-events');
  E.validateReturnEvent(event);
  const source = event.source.advice.returnOf,
    request = event.source.advice.request,
    r = source.financial;
  if (source.source.entity !== 'Transfer' || source.members.some(m => m.accountType !== 'Bank')) throw Object.assign(new Error('NSF/card inverse is unavailable without its exact existing routing proof.'), {
    status: 409,
    code: 'BANKING_RETURN_HELD'
  });
  return {
    decisionKey: keyFor(event),
    purpose: request.purpose,
    operations: [{
      ref: 'bank-origin',
      op: 'create',
      entity: 'Transfer',
      payload: {
        TxnDate: event.bookDate,
        CurrencyRef: {
          value: 'CAD'
        },
        Amount: money(C.minor(r.Amount)),
        FromAccountRef: {
          value: r.ToAccountRef.value
        },
        ToAccountRef: {
          value: r.FromAccountRef.value
        },
        PrivateNote: markerFor(event) + ' Returned transfer ' + source.source.id + '; advice ' + request.reference
      }
    }]
  };
}
function exactReturnLeg(entity, record, event) {
  const E = require('./bank-origin-events');
  E.validateReturnEvent(event);
  const source = event.source.advice.returnOf;
  needReturn(entity === 'Transfer' && source.source.entity === 'Transfer' && record.CurrencyRef?.value === 'CAD' && (record.ExchangeRate === undefined || record.ExchangeRate === 1) && record.TxnDate === event.bookDate, 'Returned Transfer native date or currency changed.');
  const legs = require('./bank-settlement-financial').settlementLegs(entity, record);
  needReturn(legs.length === 2 && new Set(legs.map(l => l.accountId)).size === 2, 'Complete returned Transfer legs required.');
  for (const m of source.members) {
    const l = legs.find(l => l.accountId === m.accountId);
    needReturn(l && require('./bank-settlement-financial').nativeAmount(record, 'CAD', l.amount, l.sign, {
      entity
    }) === -m.amountMinor, 'Returned Transfer does not exactly invert its original group.');
  }
  return -source.members.find(m => m.accountId === event.accountId).amountMinor;
}
function needReturn(ok, message) {
  if (!ok) throw Object.assign(new Error(message), {
    status: 409,
    code: 'BANKING_RETURN_HELD'
  });
}

module.exports = {inspectExistingBookkeeping,returnDraft,exactReturnLeg,prepareBankOriginResolution,keyFor,markerFor};
