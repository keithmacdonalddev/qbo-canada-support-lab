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
module.exports = { originId, VERSION, KINDS, accountOf, validateOriginEvent, buildBankOriginEvents };
