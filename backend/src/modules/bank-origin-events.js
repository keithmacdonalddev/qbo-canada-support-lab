'use strict';
const C = require('./bank-settlement-contract');
const VERSION = 'bank-origin-v1';
const KINDS = Object.freeze(['bank-fee','interest-income','interest-expense','nsf-return','merchant-fee','card-fee','bank-transfer','unknown','duplicate-test']);
const clone = value => JSON.parse(JSON.stringify(value));
function need(ok, message) { if (!ok) throw new TypeError(message); }
function accountOf(accounts, id) {
  const a = accounts.find(a => String(a.id ?? a.Id) === String(id));
  need(a && a.Active !== false, 'An active account is required.');
  const account = {id:String(a.id ?? a.Id), type:a.type ?? a.AccountType, subtype:a.subtype ?? a.AccountSubType, currency:a.currency ?? a.CurrencyRef?.value};
  need(['Bank','Credit Card'].includes(account.type) && account.subtype !== 'CashOnHand', 'Bank feeds require an external bank or card account, not cash on hand.');
  need(/^[A-Z]{3}$/.test(account.currency || ''), 'Account currency is required.');
  return account;
}
function originId(scope, s) { return 'bo1_' + C.hash({scope:C.validateScope(scope), kind:s.kind === 'nsf-return' ? 'nsf-return' : 'advice', identity:s.kind === 'nsf-return' ? s.originalEventId : s.advice.reference}).slice(0,40); }
function validateOriginEvent(event) {
  if(event?.policyVersion===RETURN_VERSION)return validateReturnEvent(event);
  C.validateEvent(event);
  need(event.contractVersion === C.CONTRACT_VERSION && event.policyVersion === VERSION && event.source?.entity === 'BankOrigin', 'Expected a BF3 bank-origin event.');
  need(KINDS.includes(event.kind), 'Unknown bank-origin kind.');
  need(event.source.sourceHash === C.hash(event.source.advice), 'Bank-origin advice changed.');
  need(event.eventId === C.stableEventId(event.scope,'BankOrigin',event.source.id,event.accountId), 'Bank-origin identity changed.');
  const advice = event.source.advice;
  need(event.source.id === originId(event.scope,advice) && event.resolution.designatedCreator === advice.creator, 'Bank-origin creator changed.');
  need(event.accountCurrency === (event.accountId === advice.accountId ? advice.currency : advice.toCurrency) && event.kind === advice.kind && event.bookDate === advice.bookDate && event.actualPostingDate === advice.postingDate, 'Bank-origin advice does not describe this event.');
  need(event.amountMinor === (event.accountId === advice.accountId ? advice.signedAmountMinor : advice.toAmountMinor), 'Bank-origin money changed.');
  const blocked = advice.kind === 'unknown' ? 'unknown-bank-item' : advice.kind === 'merchant-fee' && advice.includedInSettlement === true ? 'net-deposit-fee-unproved' : advice.kind === 'bank-transfer' && advice.currency !== advice.toCurrency ? 'fx-transfer-requires-governed-currency-proof' : null;
  need(event.status === (blocked ? 'unresolved' : 'resolved') && event.resolution.action === (blocked ? 'investigate' : advice.kind === 'duplicate-test' ? 'Exclude' : advice.creator === 'api-accountant' ? 'Match' : 'Add'), 'Bank-origin resolution changed.');
  need(!blocked || event.resolution.reason?.code === blocked, 'Bank-origin blocker changed.');
  need(event.expectedPostingDate === advice.postingDate && event.statementPeriod === advice.postingDate.slice(0,7), 'Bank-origin timing changed.');
  need(event.accountId === advice.accountId || advice.kind === 'bank-transfer' && event.accountId === advice.toAccountId, 'Bank-origin account changed.');
  const expectedPair = advice.kind === 'bank-transfer' ? C.stableEventId(event.scope,'BankOrigin',event.source.id,event.accountId === advice.accountId ? advice.toAccountId : advice.accountId) : null;
  need(event.pairedEventId === expectedPair, 'Bank-origin paired leg changed.');
  return event;
}
/** Pure, explicit advice only: no random fees, clock, QBO client, persistence or scheduler.
 * Scenarios require a labelled simulated advice and an identified unreconciled window.
 * Identity is scoped advice reference + account (NSF: original settled principal); amount/source changes require a new revision.
 * Duplicate test rows are returned separately and NEVER belong in canonical statements.
 */
function buildBankOriginEvents({scope: rawScope, accounts, scenarios, settlementDataset, priorEvents = []}) {
  const scope = C.validateScope(rawScope);
  need(Array.isArray(scenarios) && Array.isArray(accounts), 'Accounts and explicit scenarios are required.');
  const base = settlementDataset;
  if (base) { C.assertScope(base.scope,scope); need(base.contractVersion === C.CONTRACT_VERSION, 'Unsupported settlement contract.'); }
  const originals = new Map((base?.events || []).map(e => [e.eventId,e]));
  const prior = new Map(priorEvents.map(e => { C.assertScope(e.scope,scope); return [e.eventId,e]; }));
  const events = [], duplicateTests = [], nonEvents = [], seen = new Set(), economicIds = new Set();
  for (const raw of scenarios) {
    const s = clone(raw);
    need(typeof s.scenarioId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s.scenarioId) && !seen.has(s.scenarioId), 'Use a unique stable scenarioId.'); seen.add(s.scenarioId);
    need(KINDS.includes(s.kind), 'Unsupported bank-origin scenario.');
    if (s.scope) C.assertScope(s.scope,scope);
    const a = accountOf(accounts,s.accountId);
    need(s.currency === a.currency, 'Scenario currency must be the account native currency.');
    C.date(s.bookDate); C.date(s.postingDate);
    need(s.postingDate >= s.bookDate, 'Posting cannot precede the book date.');
    need(s.advice?.basis === 'simulated' && typeof s.advice.reference === 'string' && s.advice.reference.length > 0, 'Explicit simulated advice provenance is required.');
    const w = s.window;
    need(w?.unreconciled === true && typeof w.evidenceRef === 'string' && w.evidenceRef.length > 0, 'Identify the unreconciled scenario window; never silently add historical fees.');
    C.date(w.start); C.date(w.end);
    need(w.start <= s.bookDate && s.bookDate <= w.end && w.start <= s.postingDate && s.postingDate <= w.end, 'Scenario must fall inside its identified unreconciled window.');
    need(['api-accountant','native-add'].includes(s.creator) || s.kind === 'duplicate-test' && s.creator === 'existing-qbo', 'Reserve exactly one creator: api-accountant or native-add.');
    let why = null, amount;
    if (s.kind === 'duplicate-test') {
      const original = originals.get(s.originalEventId);
      need(original && original.accountId === a.id && original.accountCurrency === a.currency && original.status === 'resolved', 'Duplicate tests require an existing resolved event on this account.');
      C.validateEvent(original); C.assertScope(original.scope,scope);
      need(s.creator === 'existing-qbo' && s.postingDate === (original.actualPostingDate || original.expectedPostingDate), 'Duplicate tests preserve the original posting date and create no bookkeeping.');
      amount = original.amountMinor;
    } else {
      C.integer(s.amountMinor); need(s.amountMinor !== 0, 'Zero bank-origin movements are not feed lines.');
      if (s.kind !== 'unknown') need(s.amountMinor > 0, 'Use positive scenario principal; the event assigns the movement sign.');
      amount = s.kind === 'interest-income' || s.kind === 'unknown' ? s.amountMinor : -s.amountMinor;
    }
    if (s.kind === 'unknown') why = {code:'unknown-bank-item', adviceRef:s.advice.reference};
    if (s.kind === 'card-fee') need(a.type === 'Credit Card', 'Card fees require a card account.');
    if (s.kind === 'interest-income') need(a.type === 'Bank', 'Interest income requires a bank account.');
    if (s.kind === 'merchant-fee' && s.includedInSettlement === true) {
      const original = originals.get(s.settlementEventId);
      need(original && original.accountId === a.id && original.accountCurrency === a.currency, 'Net fee advice needs its original account settlement.');
      C.assertScope(original.scope,scope); C.validateEvent(original);
      const fees = (original.source.depositBreakdown || []).filter(l => l.amountMinor < 0);
      if (original.status === 'resolved' && original.source.depositLinks?.length && fees.some(l => -l.amountMinor === s.amountMinor && l.accountId === s.counterpartAccountId)) {
        nonEvents.push({scenarioId:s.scenarioId,code:'fee-already-in-net-deposit',eventId:original.eventId,amountMinor:s.amountMinor}); continue;
      }
      why = {code:'net-deposit-fee-unproved',eventId:original.eventId};
    }
    if (s.kind === 'nsf-return') {
      const original = originals.get(s.originalEventId);
      need(original && original.status === 'resolved' && original.amountMinor === s.amountMinor && original.accountId === a.id && original.accountCurrency === a.currency && original.source.entity === 'Payment', 'NSF principal requires an exact settled customer Payment on the same account; grouped/FX cases need investigation.');
      C.assertScope(original.scope,scope); C.validateEvent(original);
      need((original.actualPostingDate || original.expectedPostingDate) <= s.postingDate, 'A payment must settle before its return.');
      s.originalQboId = original.source.id;
    }
    let legs = [{account:a,amount}];
    if (s.kind === 'bank-transfer') {
      const to = accountOf(accounts,s.toAccountId);
      need(a.type === 'Bank' && to.id !== a.id, 'A bank-initiated transfer needs distinct accounts and a bank source.');
      // Cross-currency drafts need the existing governed FX workflow, never guessed conversion.
      C.integer(s.toAmountMinor ?? s.amountMinor); need((s.toAmountMinor ?? s.amountMinor) > 0, 'Transfer destination amount must be positive.');
      s.toAmountMinor = s.toAmountMinor ?? s.amountMinor; s.toAccountId = to.id; s.toCurrency = to.currency;
      if (to.currency !== a.currency) why = {code:'fx-transfer-requires-governed-currency-proof'};
      else need(s.toAmountMinor === s.amountMinor, 'Same-currency transfer legs must balance.');
      legs.push({account:to,amount:s.toAmountMinor});
    }
    s.accountId = a.id; s.signedAmountMinor = amount;
    const sourceId = originId(scope,s); need(!economicIds.has(sourceId), 'One bank advice or returned payment principal may appear only once.'); economicIds.add(sourceId);
    const sourceHash = C.hash(s), group = 'bsg1_' + C.hash({scope,sourceId}).slice(0,40);
    const generated = legs.map(({account,amount}) => {
      const eventId = C.stableEventId(scope,'BankOrigin',sourceId,account.id), old = prior.get(eventId);
      if (old) { validateOriginEvent(old); need(old.resolution.designatedCreator === s.creator, 'A reserved creator cannot be switched by revising a scenario.'); }
      const isCard = account.type === 'Credit Card';
      const event = {contractVersion:C.CONTRACT_VERSION,eventId,scope:{...scope},accountId:account.id,accountCurrency:account.currency,accountType:account.type,
        evidenceType:'bank-or-card-statement',kind:s.kind,status:why ? 'unresolved' : 'resolved',amountMinor:amount,bookAmountMinor:isCard ? -amount : amount,cardDebtChangeMinor:isCard ? -amount : null,direction:amount > 0 ? 'inflow' : 'outflow',
        settlementGroupId:group,pairedEventId:null,bookDate:s.bookDate,expectedPostingDate:s.postingDate,actualPostingDate:s.postingDate,statementPeriod:s.postingDate.slice(0,7),postingBasis:'explicit-simulated-advice',
        source:{entity:'BankOrigin',id:sourceId,sourceHash,advice:clone(s),simulated:true,originalEventId:s.originalEventId || null},
        resolution:{action:why ? 'investigate' : s.kind === 'duplicate-test' ? 'Exclude' : s.creator === 'api-accountant' ? 'Match' : 'Add',reason:why,linkedQboIds:[],designatedCreator:s.creator,nativeMatchVerified:false,nativeActionBlockers:[]},
        policyVersion:VERSION,revision:old ? old.revision + Number(old.source.sourceHash !== sourceHash) : 1,supersededBy:null,generatedFileReferences:[]};
      C.validateEvent(event); return event;
    });
    if (generated.length === 2) { generated[0].pairedEventId = generated[1].eventId; generated[1].pairedEventId = generated[0].eventId; }
    (s.kind === 'duplicate-test' ? duplicateTests : events).push(...generated);
  }
  return {contractVersion:C.CONTRACT_VERSION,kind:'bank-origin-dataset',scope,policyVersion:VERSION,events,duplicateTests,nonEvents,
    coverage:{nativeBankStateVerified:false,complete:false},sourceHash:C.hash({scope,scenarios})};
}

// Source-bound return contract. Pure builders are never dispatch authority: the
// service must authenticate original posted rows/SDK receipt and current mirror.
const RETURN_VERSION='bank-origin-return-v1';
const RETURN_HASH=/^[a-f0-9]{64}$/;
function returnFinancialShape(entity, record) {
  need(['Payment', 'Transfer'].includes(entity) && record && typeof record.Id === 'string', 'Only a direct Payment or Transfer can be returned.');
  const keys = entity === 'Payment' ? ['Id', 'TxnDate', 'CurrencyRef', 'ExchangeRate', 'TotalAmt', 'CustomerRef', 'DepositToAccountRef', 'ARAccountRef', 'Line', 'LinkedTxn', 'UnappliedAmt', 'HomeTotalAmt', 'HomeBalance'] : ['Id', 'TxnDate', 'CurrencyRef', 'ExchangeRate', 'Amount', 'FromAccountRef', 'ToAccountRef', 'LinkedTxn', 'Line', 'HomeTotalAmt', 'HomeBalance'];
  return Object.fromEntries(keys.filter(k => record[k] !== undefined).map(k => [k, clone(record[k])]));
}
function returnIdentity(scope, source) {
  scope = C.validateScope(scope);
  need(['Payment', 'Transfer'].includes(source?.entity) && /^\d{1,30}$/.test(source.id || ''), 'Exact original economic identity is required.');
  return 'return_' + C.hash({
    scope,
    entity: source.entity,
    id: source.id
  });
}
function freezeReturnSource({
  scope,
  record,
  source,
  members
}) {
  scope = C.validateScope(scope);
  need(source && RETURN_HASH.test(source.signature || '') && RETURN_HASH.test(source.receiptId || '') && RETURN_HASH.test(source.recordHash || '') && C.hash(record) === source.recordHash, 'Original SDK return source is incomplete.');
  const {
    signature,
    receiptId,
    ...lineage
  } = source;
  need(C.hash(lineage) === signature && record.Id === source.id, 'Original SDK return signature changed.');
  need(record.CurrencyRef?.value === 'CAD' && (record.ExchangeRate === undefined || record.ExchangeRate === 1), 'Return source must be exact native CAD.');
  C.date(record.TxnDate);
  const entity = source.entity,
    financial = returnFinancialShape(entity, record),
    ordered = [...(members || [])].sort((a, b) => a.eventId.localeCompare(b.eventId));
  need(ordered.length === (entity === 'Transfer' ? 2 : 1) && new Set(ordered.map(m => m.accountId)).size === ordered.length, 'Complete original economic group is required.');
  for (const m of ordered) {
    C.assertScope(m.scope, scope);
    need(m.accountCurrency === 'CAD' && ['Bank', 'Credit Card'].includes(m.accountType) && m.state === 'posted' && m.sourceSignature === source.signature && m.eventId === C.stableEventId(scope, entity, source.id, m.accountId) && RETURN_HASH.test(m.instructionHash || '') && RETURN_HASH.test(m.postedHash || '') && Number.isSafeInteger(m.amountMinor) && m.amountMinor !== 0, 'Original posted return member is incomplete.');
    C.date(m.bookDate);
    C.date(m.postingDate);
    need(m.bookDate === record.TxnDate && m.postingDate >= m.bookDate, 'Original posting date differs.');
  }
  if (entity === 'Transfer') {
    const from = ordered.find(m => m.accountId === record.FromAccountRef?.value),
      to = ordered.find(m => m.accountId === record.ToAccountRef?.value);
    need(from && to && from !== to && from.amountMinor === -C.minor(record.Amount) && to.amountMinor === C.minor(record.Amount) && from.amountMinor < 0 && from.pairedEventId === to.eventId && to.pairedEventId === from.eventId && from.settlementGroupId && from.settlementGroupId === to.settlementGroupId && from.postingDate === to.postingDate, 'Original Transfer pair does not agree.');
  } else {
    const m = ordered[0];
    need(m.accountType === 'Bank' && m.accountId === record.DepositToAccountRef?.value && m.amountMinor === C.minor(record.TotalAmt) && m.amountMinor > 0 && !m.pairedEventId && /^\d{1,30}$/.test(record.CustomerRef?.value || '') && !record.LinkedTxn?.some(l => l.TxnType === 'Deposit') && !(record.Line || []).some(l => (l.LinkedTxn || []).some(t => t.TxnType === 'Deposit')), 'NSF needs one full direct-bank customer Payment.');
  }
  const body = {
    version: 1,
    kind: 'bank-return-source',
    scope,
    returnId: returnIdentity(scope, source),
    source: clone(source),
    financial,
    financialHash: C.hash(financial),
    members: clone(ordered)
  };
  return {
    ...body,
    sourceHash: C.hash(body)
  };
}
function validateReturnSource(value) {
  need(value?.version === 1 && value.kind === 'bank-return-source' && value.returnId === returnIdentity(value.scope, value.source) && value.financialHash === C.hash(value.financial), 'Retained return source identity changed.');
  const {
    sourceHash,
    ...body
  } = value;
  need(RETURN_HASH.test(sourceHash || '') && sourceHash === C.hash(body), 'Retained return source hash changed.');
  const s = value.source,
    f = value.financial,
    ms = value.members,
    {
      signature,
      receiptId,
      ...lineage
    } = s;
  need(s.signature === C.hash(lineage) && RETURN_HASH.test(receiptId || '') && RETURN_HASH.test(s.recordHash || '') && f.Id === s.id && f.CurrencyRef?.value === 'CAD' && (f.ExchangeRate === undefined || f.ExchangeRate === 1) && Array.isArray(ms) && ms.length === (s.entity === 'Transfer' ? 2 : 1) && new Set(ms.map(m => m.accountId)).size === ms.length, 'Retained original return proof shape changed.');
  C.date(f.TxnDate);
  for (const m of ms) {
    C.assertScope(m.scope, value.scope);
    need(m.accountCurrency === 'CAD' && ['Bank', 'Credit Card'].includes(m.accountType) && m.state === 'posted' && m.sourceSignature === signature && m.eventId === C.stableEventId(value.scope, s.entity, s.id, m.accountId) && RETURN_HASH.test(m.instructionHash || '') && RETURN_HASH.test(m.postedHash || '') && RETURN_HASH.test(m.baselineHash || '') && Number.isSafeInteger(m.amountMinor) && m.amountMinor !== 0 && m.bookDate === f.TxnDate, 'Retained original return member changed.');
    C.date(m.postingDate);
    need(Number.isFinite(Date.parse(m.settledAt)) && new Date(m.settledAt).toISOString() === m.settledAt, 'Retained original settlement time changed.');
    need(m.postingDate >= m.bookDate, 'Original return posting order changed.');
  }
  if (s.entity === 'Transfer') {
    const from = ms.find(m => m.accountId === f.FromAccountRef?.value),
      to = ms.find(m => m.accountId === f.ToAccountRef?.value);
    need(from && to && from !== to && from.amountMinor === -C.minor(f.Amount) && to.amountMinor === C.minor(f.Amount) && from.amountMinor < 0 && from.pairedEventId === to.eventId && to.pairedEventId === from.eventId && from.settlementGroupId && from.settlementGroupId === to.settlementGroupId && from.postingDate === to.postingDate, 'Retained Transfer return financial group changed.');
  } else need(ms[0].accountType === 'Bank' && ms[0].accountId === f.DepositToAccountRef?.value && ms[0].amountMinor === C.minor(f.TotalAmt) && ms[0].amountMinor > 0 && !ms[0].pairedEventId && /^\d{1,30}$/.test(f.CustomerRef?.value || ''), 'Retained NSF principal changed.');

  // The service separately re-proves the original raw SDK record and receipt.
  // This structural replay never fills an omitted AR field.
  return value;
}
function validateReturnCurrent({
  source,
  current,
  now = Date.now()
}) {
  validateReturnSource(source);
  need(source.members.every(m => Number.isFinite(Date.parse(m.settledAt)) && Date.parse(m.settledAt) <= now), 'Original settlement has not actually occurred yet.');
  need(Array.isArray(current), 'Fresh current return observations are required.');
  const observed = (entity, id) => {
    const found = current.filter(o => o.entity === entity && o.record?.Id === id);
    need(found.length === 1, 'A complete current return dependency is required.');
    const o = found[0],
      s = o.source,
      at = Date.parse(o.observedAt),
      completed = Date.parse(s?.completedAt);
    C.assertScope(o.scope, source.scope);
    C.assertScope(s?.scope, source.scope);
    need(o.recordHash === C.hash(o.record) && s?.kind === 'qbo-current-mirror' && s.entity === entity && s.id === id && s.recordHash === o.recordHash && Number.isFinite(at) && at <= now && now - at <= 300000 && Number.isFinite(completed) && completed <= now && now <= Date.parse(s.freshUntil) && o.record.status !== 'Deleted' && o.record.TxnStatus !== 'Voided' && o.record.status !== 'Voided', 'Current return source is stale, changed, void or deleted.');
    return o.record;
  };
  const r = observed(source.source.entity, source.source.id);
  need(C.hash(returnFinancialShape(source.source.entity, r)) === source.financialHash && r.CurrencyRef?.value === 'CAD' && (r.ExchangeRate === undefined || r.ExchangeRate === 1), 'Current original financial shape changed.');
  for (const m of source.members) {
    const a = observed('Account', m.accountId);
    need(a.Active === true && a.CurrencyRef?.value === 'CAD' && a.AccountType === m.accountType, 'Current return bank routing changed.');
  }
  if (source.source.entity === 'Payment') {
    need(/^\d{1,30}$/.test(r.ARAccountRef?.value || ''), 'NSF unavailable: applicable original receivables proof is not retained; no AR field may be invented.');
    const a = observed('Account', r.ARAccountRef.value),
      c = observed('Customer', r.CustomerRef.value);
    need(a.Active === true && a.AccountType === 'Accounts Receivable' && a.CurrencyRef?.value === 'CAD' && c.Active === true && c.CurrencyRef?.value === 'CAD', 'Current NSF customer or receivables routing changed.');
  } else need(source.members.every(m => m.accountType === 'Bank'), 'Card inverse routing remains held without exact existing route proof.');
  return true;
}
function normalizeReturnRequest(input, source, today) {
  validateReturnSource(source);
  C.date(today);
  need(input && Object.keys(input).every(k => ['accountId', 'kind', 'reference', 'originalEventId', 'dueDate', 'purpose'].includes(k)), 'Unsupported return command.');
  const expected = source.source.entity === 'Payment' ? 'nsf-return' : 'transfer-reversal',
    member = source.members.find(m => m.eventId === input.originalEventId && m.accountId === input.accountId);
  need(member && input.kind === expected && typeof input.reference === 'string' && /^[A-Za-z0-9 _.-]{1,100}$/.test(input.reference) && typeof input.purpose === 'string' && input.purpose.trim().length >= 10 && input.purpose.length <= 500, 'Select the exact eligible original and state the return purpose.');
  C.date(input.dueDate);
  need(input.dueDate >= today && source.members.every(m => m.postingDate <= input.dueDate), 'Return advice cannot precede actual original settlement or be backdated.');
  return {
    kind: expected,
    returnId: source.returnId,
    reference: input.reference,
    purpose: input.purpose.trim(),
    dueDate: input.dueDate,
    originalEventId: source.members[0].eventId
  };
}
function buildSourceBoundReturnEvents({
  source,
  request,
  postingDate
}) {
  validateReturnSource(source);
  C.date(postingDate);
  need(request?.returnId === source.returnId && request.kind === (source.source.entity === 'Payment' ? 'nsf-return' : 'transfer-reversal') && postingDate >= request.dueDate && source.members.every(m => m.postingDate <= postingDate), 'Exact due return advice is required.');
  const sourceId = 'bo-return_' + C.hash({
      scope: source.scope,
      returnId: source.returnId
    }),
    group = 'bsg1_' + C.hash({
      scope: source.scope,
      sourceId
    }).slice(0, 40),
    advice = {
      version: 1,
      kind: request.kind,
      request: clone(request),
      returnOf: clone(source)
    },
    sourceHash = C.hash(advice);
  const events = source.members.map(m => {
    const amount = -m.amountMinor,
      card = m.accountType === 'Credit Card',
      eventId = C.stableEventId(source.scope, 'BankOrigin', sourceId, m.accountId);
    return {
      contractVersion: C.CONTRACT_VERSION,
      eventId,
      scope: clone(source.scope),
      accountId: m.accountId,
      accountCurrency: 'CAD',
      accountType: m.accountType,
      evidenceType: 'bank-or-card-statement',
      kind: request.kind,
      status: 'resolved',
      amountMinor: amount,
      bookAmountMinor: card ? -amount : amount,
      cardDebtChangeMinor: card ? -amount : null,
      direction: amount > 0 ? 'inflow' : 'outflow',
      settlementGroupId: group,
      pairedEventId: null,
      bookDate: postingDate,
      expectedPostingDate: postingDate,
      actualPostingDate: postingDate,
      statementPeriod: postingDate.slice(0, 7),
      postingBasis: 'explicit-source-bound-return',
      source: {
        entity: 'BankOrigin',
        id: sourceId,
        sourceHash,
        advice: clone(advice),
        simulated: true,
        originalEventId: m.eventId
      },
      resolution: {
        action: 'Match',
        reason: null,
        linkedQboIds: [],
        designatedCreator: 'api-accountant',
        nativeMatchVerified: false,
        nativeActionBlockers: []
      },
      policyVersion: RETURN_VERSION,
      revision: 1,
      supersededBy: null,
      generatedFileReferences: []
    };
  });
  if (events.length === 2) {
    events[0].pairedEventId = events[1].eventId;
    events[1].pairedEventId = events[0].eventId;
  }
  for (const e of events) C.validateEvent(e);
  return events;
}
function validateReturnEvent(event) {
  C.validateEvent(event);
  need(event.policyVersion === RETURN_VERSION, 'Unknown return contract.');
  const a = event.source?.advice;
  validateReturnSource(a?.returnOf);
  const expected = buildSourceBoundReturnEvents({
    source: a.returnOf,
    request: a.request,
    postingDate: event.actualPostingDate
  }).find(e => e.eventId === event.eventId);
  need(expected && C.canonical(event) === C.canonical(expected), 'Source-bound return event changed.');
  return event;
}

module.exports = { RETURN_VERSION,returnIdentity,returnFinancialShape,freezeReturnSource,validateReturnSource,validateReturnCurrent,normalizeReturnRequest,buildSourceBoundReturnEvents,validateReturnEvent,originId,VERSION,KINDS,accountOf,validateOriginEvent,buildBankOriginEvents };
