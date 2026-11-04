'use strict';

const C = require('./bank-settlement-contract');
const {
  businessDate
} = require('./business-activity-preview');
const {
  verifyLedger,
  balances
} = require('./independent-bank-ledger');
const {
  buildBankOriginEvents,
  validateOriginEvent
} = require('./bank-origin-events');
const clone = v => JSON.parse(JSON.stringify(v)),
  same = (a, b) => C.canonical(a) === C.canonical(b);
const POLICY = 'bank-origin-policy-v1',
  ORIGIN = 'independent-bank-origin-v1';
function fail(message, code = 'BANKING_ORIGIN_INVALID') {
  throw Object.assign(new Error(message), {
    status: 409,
    code
  });
}
function need(ok, message, code) {
  if (!ok) fail(message, code);
}
function exact(v, keys) {
  need(v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).every(k => keys.includes(k)), 'Unsupported bank-origin command.');
}
function identity(value) {
  need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Exact retained bank-origin identity required.');
  return value;
}
function scopeOf(v) {
  return C.validateScope(v);
}
// Mongo lean rows retain BSON connection IDs; commands and payload scopes stay strict.
function persistedScopeOf(row) {
  const id=row?.connectionId;
  if(typeof id==='string')return scopeOf(row);
  need(id instanceof require('mongoose').Types.ObjectId && /^[a-f0-9]{24}$/.test(id.toHexString()),'Exact persisted company connection required.');
  return scopeOf({...row,connectionId:id.toHexString()});
}
function dayAt(now) {
  return businessDate(new Date(now));
}
function cycleDate(epoch, ordinal) {
  C.date(epoch);
  need(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal <= 1200, 'Bank fee cycle exceeds its processing bound.');
  const d = new Date(epoch + 'T12:00:00Z'),
    anchor = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + ordinal);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(anchor, end));
  return d.toISOString().slice(0, 10);
}

const RETURN_CLAIM='bank-origin-return-claim-v1',RETURN_ADVICE='bank-origin-return-advice-v1',RETURN_ORIGIN='independent-bank-return-v1';
function returnSeed(claim, advice, event) {
  return {
    version: 1,
    kind: RETURN_ORIGIN,
    scope: clone(event.scope),
    accountId: event.accountId,
    event: clone(event),
    returnId: claim.payload.returnId,
    returnAnchorHash: claim.contentHash,
    returnSourceHash: claim.payload.source.sourceHash,
    adviceHash: advice.contentHash,
    receivedDate: event.actualPostingDate,
    state: 'pending',
    description: 'Returned transfer — ' + claim.payload.request.reference,
    bookkeeping: {
      status: 'needed',
      creator: 'api-accountant',
      decisionKey: require('./bank-origin-resolution').keyFor(event),
      bankDate: event.bookDate,
      reason: null,
      runId: null
    },
    previousHash: null
  };
}
function returnGroup(rows, scope, returnId) {
  const E = require('./bank-origin-events'),
    id = '@origin-return-claim:' + returnId,
    claims = rows.filter(r => r.eventId === id).sort((a, b) => a.revision - b.revision);
  need(claims.length >= 1 && claims.length <= 3, 'Return group claim unavailable.', 'BANKING_RETURN_HELD');
  const first = claims[0],
    p = first.payload;
  validateRows(claims, scope, first.accountId);
  need(p?.kind === RETURN_CLAIM && p.version === 1 && p.returnId === returnId && same(p.scope, scope) && p.source.source.ownerId === p.ownerId && /^[a-f0-9]{24}$/.test(p.ownerId || '') && /^[a-f0-9]{24}$/.test(p.actorId || '') && Number.isFinite(Date.parse(p.recordedAt)) && new Date(p.recordedAt).toISOString() === p.recordedAt && p.state === 'pending' && p.previousHash === null, 'Return group authority changed.', 'BANKING_RETURN_HELD');
  E.validateReturnSource(p.source);
  const member = p.source.members.find(m => m.eventId === p.request.originalEventId),
    {
      returnId: ignoredReturnId,
      ...choices
    } = p.request;
  need(member && same(E.normalizeReturnRequest({
    ...choices,
    accountId: member.accountId
  }, p.source, businessDate(new Date(p.recordedAt))), p.request), 'Frozen return choices changed.', 'BANKING_RETURN_HELD');
  const primary = [...p.source.members].sort((a, b) => a.accountId.localeCompare(b.accountId))[0].accountId;
  need(first.accountId === primary && p.primaryAccountId === primary && first.accountCurrency === 'CAD', 'Canonical return account changed.', 'BANKING_RETURN_HELD');
  for (const [i, row] of claims.entries()) need(row.kind === 'revision' && row.revision === i + 1 && row.accountCurrency === 'CAD' && same(row.payload.source, p.source) && same(row.payload.request, p.request) && row.payload.ownerId === p.ownerId && row.payload.actorId === p.actorId && row.payload.primaryAccountId === primary && row.payload.previousHash === (i ? claims[i - 1].contentHash : null), 'Return claim lineage changed.', 'BANKING_RETURN_HELD');
  const posted = claims[1],
    head = claims.at(-1),
    legs = [];
  if (posted) {
    need(posted.payload.state === 'posted' && C.date(posted.payload.postingDate) >= p.request.dueDate, 'Return posted claim timing changed.', 'BANKING_RETURN_HELD');
    const events = E.buildSourceBoundReturnEvents({
      source: p.source,
      request: p.request,
      postingDate: posted.payload.postingDate
    });
    for (const event of events) {
      const aliases = rows.filter(r => r.eventId === '@origin-return-advice:' + returnId + ':' + event.accountId).sort((a, b) => a.revision - b.revision),
        chain = rows.filter(r => r.eventId === '@origin:' + event.eventId).sort((a, b) => a.revision - b.revision);
      need(aliases.length === 2 && chain.length >= 2 && chain.length <= 10000, 'Complete return member lineage unavailable.', 'BANKING_RETURN_HELD');
      validateRows([...aliases, ...chain], scope, event.accountId);
      for (const [i, a] of aliases.entries()) need(a.kind === 'revision' && a.revision === i + 1 && a.payload.kind === RETURN_ADVICE && same(a.payload.scope, scope) && a.payload.returnId === returnId && a.payload.claimHash === first.contentHash && same(a.payload.source, p.source) && same(a.payload.request, p.request) && a.payload.accountId === event.accountId && a.accountCurrency === 'CAD' && a.payload.previousHash === (i ? aliases[i - 1].contentHash : null), 'Return advice alias changed.', 'BANKING_RETURN_HELD');
      const seed = returnSeed(first, aliases[0], event);
      need(same(chain[0].payload, seed) && same(chain[1].payload, {
        ...clone(seed),
        state: 'posted',
        previousHash: chain[0].contentHash
      }) && aliases[1].payload.postedHash === chain[1].contentHash, 'Return posting changed.', 'BANKING_RETURN_HELD');
      for (const [i, r] of chain.entries()) {
        need(r.kind === 'revision' && r.revision === i + 1 && r.payload.kind === RETURN_ORIGIN && r.payload.returnId === returnId && r.accountCurrency === 'CAD' && same(r.payload.event, event) && r.payload.returnAnchorHash === first.contentHash && r.payload.returnSourceHash === p.source.sourceHash && r.payload.adviceHash === aliases[0].contentHash && r.payload.previousHash === (i ? chain[i - 1].contentHash : null), 'Return financial history changed.', 'BANKING_RETURN_HELD');
      }
      legs.push({
        event,
        aliases,
        chain,
        posted: chain[1],
        last: chain.at(-1)
      });
    }
    need(same(posted.payload.postedMembers, legs.map(l => ({
      eventId: l.event.eventId,
      accountId: l.event.accountId,
      postedHash: l.posted.contentHash
    })).sort((a, b) => a.eventId.localeCompare(b.eventId))), 'Return group posted hashes changed.', 'BANKING_RETURN_HELD');
    need(legs.every(l => l.last.payload.bookkeeping.status === legs[0].last.payload.bookkeeping.status && l.last.payload.bookkeeping.runId === legs[0].last.payload.bookkeeping.runId), 'Return has a partial bookkeeping state.', 'BANKING_RETURN_HELD');
  }
  if (claims[2]) need(head.payload.state === 'booked' && legs.every(l => l.last.payload.bookkeeping.status === 'booked' && l.last.payload.bookkeeping.runId === head.payload.runId && l.last.payload.bookkeeping.qboEntity === head.payload.qboEntity && l.last.payload.bookkeeping.qboId === head.payload.qboId && same(l.last.payload.firstSource, head.payload.firstSource)), 'Return booked group changed.', 'BANKING_RETURN_HELD');
  return {
    claim: first,
    head,
    source: p.source,
    request: p.request,
    legs,
    primary: legs.find(l => l.event.accountId === primary)
  };
}
function projectReturnActivity(rows, scope, accountId) {
  const ids = [...new Set(rows.filter(r => r.payload?.kind === RETURN_ORIGIN && r.accountId === accountId).map(r => r.payload.returnId))],
    events = [];
  for (const id of ids) {
    const group = returnGroup(rows, scope, id);
    for (const l of group.legs.filter(l => l.event.accountId === accountId)) {
      const e = l.event;
      events.push({
        ...clone(e),
        state: 'posted',
        disposition: 'included',
        stateHistory: [{
          state: 'pending',
          date: e.bookDate,
          evidenceRef: l.chain[0]._id
        }, {
          state: 'posted',
          date: e.actualPostingDate,
          evidenceRef: l.posted._id
        }],
        description: l.last.payload.description,
        postingDate: e.actualPostingDate,
        bookkeeping: clone(l.last.payload.bookkeeping),
        source: {
          entity: 'BankOrigin',
          id: e.source.id,
          sourceHash: e.source.sourceHash,
          adviceReference: group.request.reference,
          returnId: id
        },
        originHash: l.posted.contentHash,
        latestHash: l.last.contentHash
      });
    }
  }
  return events;
}

function rowFor(scope, accountId, currency, eventId, revision, payload, kind = 'revision') {
  return {
    ...scope,
    _id: C.hash({
      scope,
      eventId,
      revision
    }),
    eventId,
    revision,
    kind,
    accountId,
    accountCurrency: currency,
    sourceHash: C.hash(payload),
    contentHash: C.hash(payload),
    payload
  };
}
function validateRows(rows, scope, accountId) {
  need(Array.isArray(rows) && rows.length <= 10000, 'Complete bounded origin history is required.', 'BANKING_ORIGIN_INCOMPLETE');
  for (const row of rows) need(same(persistedScopeOf(row), scope) && row.accountId === accountId && row.contentHash === C.hash(row.payload) && row.sourceHash === C.hash(row.payload) && row._id === C.hash({
    scope,
    eventId: row.eventId,
    revision: row.revision
  }), 'Bank-origin retained row changed.');
  return rows;
}
function policyHistory(rows, scope, accountId) {
  const list = validateRows(rows, scope, accountId).filter(r => r.eventId === '@origin-policy:' + accountId).sort((a, b) => a.revision - b.revision);
  for (const [rIndex, row] of list.entries()) {
    const p = row.payload;
    need(row.kind === 'revision' && row.revision === rIndex + 1 && p.kind === POLICY && same(p.scope, scope) && p.accountId === accountId && p.previousHash === (rIndex ? list[rIndex - 1].contentHash : null), 'Bank-origin policy chain changed.');
    need(!rIndex || p.epoch === list[0].payload.epoch && p.seriesId === list[0].payload.seriesId && p.baselineHash === list[0].payload.baselineHash, 'The fee series or adoption epoch changed.');
  }
  return list;
}
function latestPolicyAt(history, date) {
  return history.filter(r => r.payload.effectiveFrom <= date).at(-1) || null;
}
function assertLedger(row, scope, accountId) {
  need(row && same(persistedScopeOf(row), scope), 'Adopt an evidenced bank ledger before configuring bank charges.');
  const ledger = verifyLedger(clone(row.payload));
  need(ledger.account.accountId === accountId && ledger.account.accountCurrency === 'CAD' && row.contentHash === ledger.contentHash && ledger.adoption?.at, 'An exact adopted CAD ledger is required.');
  return ledger;
}
function validateOriginLifecycle(rows, scope, accountId) {
  validateRows(rows, scope, accountId);
  const policies = policyHistory(rows, scope, accountId);
  const groups = new Map();
  for (const row of rows.filter(r => r.eventId.startsWith('@origin:')&&r.payload?.kind!==RETURN_ORIGIN)) {
    if (!groups.has(row.eventId)) groups.set(row.eventId, []);
    groups.get(row.eventId).push(row);
  }
  const events = [];
  for (const [id, list] of groups) {
    list.sort((a, b) => a.revision - b.revision);
    need(list.length >= 2 && list.length <= 10000, 'Bank-origin posting lineage is incomplete.');
    for (const [i, row] of list.entries()) {
      const p = row.payload;
      need(row.kind === 'revision' && row.revision === i + 1 && p.kind === ORIGIN && p.previousHash === (i ? list[i - 1].contentHash : null), 'Bank-origin revision lineage changed.');
      validateOriginEvent(p.event);
      need(same(p.scope, scope) && p.accountId === accountId && same(p.event.scope, scope) && p.event.accountId === accountId && row.accountCurrency === p.event.accountCurrency, 'Bank-origin scope/account/currency lineage changed.');
      need(id === '@origin:' + p.event.eventId && same(p.event, list[0].payload.event) && p.adviceHash === list[0].payload.adviceHash && p.policyHash === list[0].payload.policyHash && same(p.mapping, list[0].payload.mapping), 'Bank-origin financial advice changed.');
    }
    const seed = list[0].payload,
      last = list.at(-1).payload;
    need(seed.state === 'pending' && list[1].payload.state === 'posted' && last.state === 'posted', 'Bank-origin posted state changed.');
    const event = seed.event,
      policy = policies.find(r => r.contentHash === seed.policyHash),
      adviceRows = rows.filter(r => r.contentHash === seed.adviceHash && r.revision === 1),
      advice = adviceRows[0]?.payload;
    need(policy && adviceRows.length === 1 && advice && same(advice.scope, scope) && advice.accountId === accountId && event.accountCurrency === policy.payload.currency && event.accountType === policy.payload.accountType && advice.policyHash === policy.contentHash, 'Original bank-origin policy/advice lineage is unavailable.');
    let canonical;
    if (advice.kind === 'bank-origin-advice') {
      const p = policy.payload,
        ordinal = advice.cycleOrdinal,
        due = cycleDate(p.epoch, ordinal);
      canonical = 'origin_' + C.hash({
        scope,
        accountId,
        seriesId: p.seriesId,
        cycleOrdinal: ordinal
      });
      need(p.enabled && advice.seriesId === p.seriesId && advice.dueDate === due && latestPolicyAt(policies, due)?.contentHash === policy.contentHash && same(advice.event, event) && advice.postingDate === event.actualPostingDate && event.amountMinor === -p.feeMinor && same(seed.mapping, p.mapping) && event.kind === (p.accountType === 'Credit Card' ? 'card-fee' : 'bank-fee'), 'Monthly advice differs from its original due-cycle policy.');
    } else {
      need(advice.kind === 'bank-origin-explicit-advice' && advice.request.kind !== 'duplicate-test', 'Exact retained explicit bank advice required.');
      const request = advice.request;
      canonical = 'advice_' + C.hash({
        scope,
        accountId,
        seriesId: advice.seriesId,
        reference: request.reference
      });
      const signed = request.kind === 'interest-expense' ? -request.amountMinor : request.amountMinor;
      need(advice.seriesId === policy.payload.seriesId && advice.epoch === policy.payload.epoch && advice.currency === event.accountCurrency && advice.canonicalReference === canonical && event.kind === request.kind && event.amountMinor === signed && same(seed.mapping, advice.mapping) && event.actualPostingDate >= advice.dueDate, 'Explicit advice differs from its original amount/account/classification.');
    }
    const scenario = event.source.advice;
    need(adviceRows[0].eventId === '@origin-advice:' + canonical && scenario.advice.reference === canonical && scenario.accountId === accountId && scenario.creator === 'api-accountant' && event.bookDate === event.actualPostingDate && seed.receivedDate === event.actualPostingDate && seed.bookkeeping.decisionKey === require('./bank-origin-resolution').keyFor(event) && seed.bookkeeping.bankDate === event.bookDate, 'Original advice identity/date/creator changed.');
    if (seed.mapping) need(scenario.counterpartAccountId === seed.mapping.counterpartAccountId && scenario.taxTreatment === seed.mapping.taxTreatment&&(seed.mapping.taxTreatment!=='taxable'||scenario.taxCodeId===seed.mapping.taxCodeId&&scenario.netAmountMinor===seed.mapping.netAmountMinor), 'Original advice classification changed.');
    events.push({
      ...clone(last.event),
      state: 'posted',
      disposition: 'included',
      stateHistory: [{
        state: 'pending',
        date: seed.receivedDate,
        evidenceRef: list[0]._id
      }, {
        state: 'posted',
        date: last.event.actualPostingDate,
        evidenceRef: list[1]._id
      }],
      description: last.description,
      postingDate: last.event.actualPostingDate,
      source: {
        entity: 'BankOrigin',
        id: last.event.source.id,
        adviceReference: last.event.source.advice.advice.reference,
        sourceHash: last.event.source.sourceHash
      },
      bookkeeping: clone(last.bookkeeping),
      originHash: list[1].contentHash,
      latestHash: list.at(-1).contentHash
    });
  }
  return events;
}
function projectOriginActivity({
  scope,
  ledger,
  rows,
  businessActivity, returnContext=null
}) {
  scope = scopeOf(scope);
  verifyLedger(ledger);
  for (const policy of policyHistory(rows, scope, ledger.account.accountId)) need(policy.payload.baselineHash === ledger.contentHash && policy.payload.currency === ledger.account.accountCurrency && policy.payload.accountType === ledger.account.accountType, 'Bank-origin adopted baseline changed.');
  const origins = [...validateOriginLifecycle(rows, scope, ledger.account.accountId),...projectReturnActivity(returnContext||rows,scope,ledger.account.accountId)],
    business = businessActivity?.events || [],
    ids = new Set();
  for (const e of [...business, ...origins]) {
    need(!ids.has(e.eventId), 'An economic bank event is present twice.');
    ids.add(e.eventId);
  }
  const events = [...business, ...origins].sort((a, b) => (a.postingDate || a.bookDate).localeCompare(b.postingDate || b.bookDate) || a.eventId.localeCompare(b.eventId));
  need(events.length <= 10000, 'Complete bank activity exceeds its aggregation bound.', 'BANKING_ORIGIN_INCOMPLETE');
  const balance = balances({
    account: ledger.account,
    openingMinor: ledger.balance.balanceMinor,
    events
  });
  return {
    ...businessActivity,
    version: 1,
    baselineHash: ledger.contentHash,
    baselineThroughPeriod: ledger.throughPeriod,
    baselineBalanceMinor: ledger.balance.balanceMinor,
    activityMovementMinor: balance.movementMinor,
    boundedBalanceMinor: balance.balanceMinor,
    pendingCount: balance.pendingCount,
    pendingNativeMinor: balance.pendingNativeMinor,
    postedCount: balance.postedCount,
    originCount: origins.length,
    bookkeepingNeeded: origins.filter(e => e.bookkeeping.status !== 'booked').length,
    events,
    coverage: {
      completeCurrentBalance: false,
      basis: 'Frozen bounded baseline plus received business instructions and posted bank-origin advice. Intervening historical months and the complete current bank/book balance are not established.'
    }
  };
}
function createBankOriginService({
  store,
  authorize,
  observeMapping,
  now = () => Date.now(),
  fenceAgent = null,
  bookkeeping = null,
  returnProof = null
}) {
  need(store && typeof authorize === 'function', 'Concrete bank origin storage and authority required.');
  const clock = () => Number(new Date(now()));
  async function inside(bound, session) {
    need(session?.inTransaction?.(), 'Bank origin changes require a transaction.');
    await authorize(bound, session, 'periods.manage');
    if (bound.agentAuthority) {
      need(typeof fenceAgent === 'function', 'Autonomous bank work requires an inside-transaction Pause fence.');
      await fenceAgent(bound, session);
    }
  }
  async function rows(bound, accountId, session) {
    return validateRows(await store.listOriginRows(bound.scope, accountId, session), bound.scope, accountId);
  }
  async function addAdvice(bound, input) {
    if(['nsf-return','transfer-reversal'].includes(input?.kind))return addReturnAdvice(bound,input);
    exact(input, ['accountId', 'kind', 'reference', 'amountMinor', 'dueDate', 'originalEventId', 'mapping']);
    need(/^\d{1,30}$/.test(input.accountId || '') && ['interest-income', 'interest-expense', 'unknown', 'duplicate-test'].includes(input.kind) && typeof input.reference === 'string' && /^[A-Za-z0-9 _.-]{1,100}$/.test(input.reference) && Number.isSafeInteger(input.amountMinor) && input.amountMinor !== 0 && Math.abs(input.amountMinor) <= 100000, 'Choose exact bounded native advice.');
    C.date(input.dueDate);
    need(input.dueDate >= dayAt(clock()), 'New advice cannot be backdated.');
    return store.transaction(async session => {
      await inside(bound, session);
      const ledger = assertLedger(await store.getLedger(bound.scope, input.accountId, session), bound.scope, input.accountId);
      await store.fenceAccount(bound.scope, input.accountId, ledger.account.accountCurrency, session);
      const all = await rows(bound, input.accountId, session),
        history = policyHistory(all, bound.scope, input.accountId),
        policy = history.at(-1);
      need(policy, 'Configure the account origin epoch before adding advice.');
      need(input.kind !== 'interest-income' || ledger.account.accountType === 'Bank', 'Interest income needs a bank account.');
      if (input.kind.startsWith('interest')) need(input.amountMinor > 0 && input.mapping?.taxTreatment === 'out-of-scope', 'Interest advice requires a positive exact amount and explicit out-of-scope classification.');
      const canonical = 'advice_' + C.hash({
          scope: bound.scope,
          accountId: input.accountId,
          seriesId: policy.payload.seriesId,
          reference: input.reference
        }),
        eventId = '@origin-advice:' + canonical,
        old = all.find(r => r.eventId === eventId && r.revision === 1);
      if (old) {
        need(same(old.payload.request, input), 'Retained advice reference has different choices.');
        return {
          status: old.payload.state,
          reference: input.reference,
          adviceId: eventId,
          qboCalls: 0
        };
      }
      const mapping = input.kind.startsWith('interest') ? await observeMapping(bound, input.mapping, input.amountMinor, session, {
        income: input.kind === 'interest-income'
      }) : null;
      if (input.kind === 'duplicate-test') {
        const target = all.find(r => r.eventId === '@origin:' + input.originalEventId && r.revision === 2)?.payload.event;
        need(target && target.status === 'resolved' && target.accountId === input.accountId && target.amountMinor === input.amountMinor, 'Duplicate test needs the exact original posted origin amount/account.');
      }
      const payload = {
        version: 1,
        kind: 'bank-origin-explicit-advice',
        scope: bound.scope,
        accountId: input.accountId,
        currency: ledger.account.accountCurrency,
        accountType: ledger.account.accountType,
        baselineHash: ledger.contentHash,
        epoch: policy.payload.epoch,
        seriesId: policy.payload.seriesId,
        canonicalReference: canonical,
        request: clone(input),
        mapping: clone(mapping),
        dueDate: input.dueDate,
        state: 'pending',
        policyHash: policy.contentHash,
        recordedAt: new Date(clock()).toISOString(),
        ownerId: bound.ownerId,
        actorId: bound.actorId
      };
      await store.putEvent(rowFor(bound.scope, input.accountId, payload.currency, eventId, 1, payload), session);
      return {
        status: 'pending',
        adviceId: eventId,
        reference: input.reference,
        qboCalls: 0
      };
    });
  }

  async function addReturnAdvice(bound, input) {
    need(typeof returnProof === 'function', 'Return source proof is unavailable.', 'BANKING_RETURN_HELD');
    return store.transaction(async session => {
      await inside(bound, session);
      const E = require('./bank-origin-events'),
        retained = await returnProof(bound, input.originalEventId, session, {
          current: false
        }),
        source = retained.source;
      need(source.source.entity === 'Transfer', 'NSF unavailable until an applicable original AR route is retained.', 'BANKING_RETURN_HELD');
      const all = await store.listBankOriginContext(bound.scope, session),
        claimId = '@origin-return-claim:' + source.returnId,
        existing = all.find(r => r.eventId === claimId && r.revision === 1);
      for (const m of [...source.members].sort((a, b) => a.accountId.localeCompare(b.accountId))) await store.fenceAccount(bound.scope, m.accountId, m.accountCurrency, session);
      let request;
      const normalize = day => {
        try {
          return E.normalizeReturnRequest(input, source, day);
        } catch (error) {
          if (error instanceof TypeError) fail(error.message, 'BANKING_RETURN_HELD');
          throw error;
        }
      };
      if (existing) {
        const g = returnGroup(all, bound.scope, source.returnId);
        request = normalize(businessDate(new Date(g.claim.payload.recordedAt)));
        need(same(g.source, source) && same(g.request, request), 'This original already owns different return choices; retain its same claim.', 'BANKING_RETURN_HELD');
        return {
          status: g.head.payload.state,
          returnId: source.returnId,
          reused: true,
          qboCalls: 0
        };
      }
      request = normalize(dayAt(clock()));
      const observed = await returnProof(bound, input.originalEventId, session, {
        current: true
      });
      need(same(observed.source, source), 'Original return source changed while its claim was prepared.', 'BANKING_RETURN_HELD');
      const primary = [...source.members].sort((a, b) => a.accountId.localeCompare(b.accountId))[0].accountId,
        payload = {
          version: 1,
          kind: RETURN_CLAIM,
          scope: bound.scope,
          returnId: source.returnId,
          source: clone(source),
          request,
          recordedAt: new Date(clock()).toISOString(),
          primaryAccountId: primary,
          ownerId: bound.ownerId,
          actorId: bound.actorId,
          state: 'pending',
          previousHash: null
        },
        claim = rowFor(bound.scope, primary, 'CAD', claimId, 1, payload);
      await store.putEvent(claim, session);
      for (const m of source.members) {
        const p = {
          version: 1,
          kind: RETURN_ADVICE,
          scope: bound.scope,
          accountId: m.accountId,
          returnId: source.returnId,
          claimHash: claim.contentHash,
          source: clone(source),
          request: clone(request),
          dueDate: request.dueDate,
          state: 'pending',
          previousHash: null
        };
        await store.putEvent(rowFor(bound.scope, m.accountId, 'CAD', '@origin-return-advice:' + source.returnId + ':' + m.accountId, 1, p), session);
      }
      return {
        status: 'pending',
        returnId: source.returnId,
        reused: false,
        qboCalls: 0
      };
    });
  }
  async function postReturns(bound, accountId, cutoff) {
    const preview = await rows(bound, accountId),
      ids = [...new Set(preview.filter(r => r.payload.kind === RETURN_ADVICE && r.revision === 1 && r.payload.dueDate <= cutoff && !preview.some(a => a.eventId === r.eventId && a.revision === 2)).map(r => r.payload.returnId))];
    let posted = 0;
    const holds = [];
    for (const id of ids.slice(0, 100)) {
      try {
        posted += await store.transaction(async session => {
          await inside(bound, session);
          const all = await store.listBankOriginContext(bound.scope, session),
            g = returnGroup(all, bound.scope, id);
          if (g.head.payload.state !== 'pending') return 0;
          const observed = await returnProof(bound, g.source.members[0].eventId, session, {
            current: true
          });
          need(same(observed.source, g.source), 'Original return source changed before posting.', 'BANKING_RETURN_HELD');
          for (const m of [...g.source.members].sort((a, b) => a.accountId.localeCompare(b.accountId))) await store.fenceAccount(bound.scope, m.accountId, m.accountCurrency, session);
          const day = dayAt(clock()),
            events = require('./bank-origin-events').buildSourceBoundReturnEvents({
              source: g.source,
              request: g.request,
              postingDate: day
            }),
            members = [];
          for (const event of events) {
            const alias = all.find(r => r.eventId === '@origin-return-advice:' + id + ':' + event.accountId && r.revision === 1);
            need(alias && alias.payload.claimHash === g.claim.contentHash && same(alias.payload.source, g.source) && same(alias.payload.request, g.request), 'Return advice changed.', 'BANKING_RETURN_HELD');
            need(!(await store.getCanonicalOriginConflict(bound.scope, event.eventId, session)), 'Return movement already belongs to another producer.', 'BANKING_RETURN_HELD');
            const creator = {
                scope: bound.scope,
                eventId: event.eventId,
                accountId: event.accountId,
                period: event.statementPeriod,
                creator: 'api-accountant'
              },
              reserved = await store.getReservation(bound.scope, event.eventId, session);
            need(!reserved, 'Return creator already exists without its group posting.', 'BANKING_RETURN_HELD');
            await store.putEvent(rowFor(bound.scope, event.accountId, 'CAD', event.eventId, 0, creator, 'reservation'), session);
            const seed = rowFor(bound.scope, event.accountId, 'CAD', '@origin:' + event.eventId, 1, returnSeed(g.claim, alias, event)),
              post = rowFor(bound.scope, event.accountId, 'CAD', seed.eventId, 2, {
                ...clone(seed.payload),
                state: 'posted',
                previousHash: seed.contentHash
              });
            await store.putEvent(seed, session);
            await store.putEvent(post, session);
            await store.putEvent(rowFor(bound.scope, event.accountId, 'CAD', alias.eventId, 2, {
              ...clone(alias.payload),
              state: 'posted',
              postedHash: post.contentHash,
              previousHash: alias.contentHash
            }), session);
            members.push({
              eventId: event.eventId,
              accountId: event.accountId,
              postedHash: post.contentHash
            });
          }
          await store.putEvent(rowFor(bound.scope, g.claim.accountId, 'CAD', g.claim.eventId, 2, {
            ...clone(g.claim.payload),
            state: 'posted',
            postingDate: day,
            postedMembers: members.sort((a, b) => a.eventId.localeCompare(b.eventId)),
            previousHash: g.claim.contentHash
          }), session);
          return events.length;
        });
      } catch (error) {
        if (!['BANKING_RETURN_HELD', 'BANKING_OPERATOR_BLOCKED', 'BANKING_INSTRUCTION_PROOF', 'BANKING_SETTLEMENT_PROOF'].includes(error.code) && !(error instanceof TypeError)) throw error;
        holds.push({
          returnId: id,
          code: error.code || 'BANKING_RETURN_HELD',
          reason: error instanceof TypeError ? 'Retained return proof is unavailable.' : error.message
        });
      }
    }
    return {
      posted,
      holds
    };
  }

  async function postExplicit(bound, ledger, retained, cutoff, session) {
    let posted = 0,
      excluded = 0;
    const today = dayAt(clock());
    for (const row of retained.filter(r => r.payload.kind === 'bank-origin-explicit-advice' && r.revision === 1 && r.payload.dueDate <= cutoff && !retained.some(done => done.eventId === r.eventId && done.revision === 2)).sort((a, b) => a.payload.dueDate.localeCompare(b.payload.dueDate) || a.eventId.localeCompare(b.eventId)).slice(0, 100)) {
      const p = row.payload;
      if (retained.some(r => r.eventId === row.eventId && r.revision === 2)) {
        excluded += Number(retained.find(r => r.eventId === row.eventId && r.revision === 2).payload.state === 'excluded');
        continue;
      }
      need(p.baselineHash === ledger.contentHash && p.epoch <= p.dueDate, 'Explicit advice adoption boundary changed.');
      const request = p.request,
        original = retained.find(r => r.eventId === '@origin:' + request.originalEventId && r.revision === 2)?.payload.event;
      const scenario = {
        scenarioId: p.canonicalReference,
        kind: request.kind,
        accountId: p.accountId,
        currency: p.currency,
        amountMinor: request.amountMinor,
        bookDate: request.kind === 'duplicate-test' ? original?.bookDate : today,
        postingDate: request.kind === 'duplicate-test' ? original?.actualPostingDate || original?.expectedPostingDate : today,
        creator: request.kind === 'duplicate-test' ? 'existing-qbo' : 'api-accountant',
        ...(p.mapping ? {
          counterpartAccountId: p.mapping.counterpartAccountId,
          taxTreatment: p.mapping.taxTreatment
        } : {}),
        ...(original ? {
          originalEventId: original.eventId
        } : {}),
        advice: {
          basis: 'simulated',
          reference: p.canonicalReference,
          humanReference: request.reference
        },
        window: {
          start: p.epoch,
          end: today,
          unreconciled: true,
          evidenceRef: row._id
        }
      };
      const dataset = buildBankOriginEvents({
        scope: bound.scope,
        accounts: [{
          id: p.accountId,
          type: p.accountType,
          currency: p.currency
        }],
        scenarios: [scenario],
        settlementDataset: {
          scope: bound.scope,
          contractVersion: C.CONTRACT_VERSION,
          events: original ? [original] : []
        }
      });
      if (request.kind === 'duplicate-test') {
        need(dataset.events.length === 0 && dataset.duplicateTests.length === 1, 'Duplicate test must not create a canonical movement.');
        const finish = {
          ...clone(p),
          state: 'excluded',
          originalEventId: original.eventId,
          previousHash: row.contentHash
        };
        await store.putEvent(rowFor(bound.scope, p.accountId, p.currency, row.eventId, 2, finish), session);
        excluded++;
        continue;
      }
      const event = dataset.events[0],
        namespace = '@origin:' + event.eventId;
      need(!retained.some(r => r.eventId === namespace), 'Advice already has a different retained origin.');
      need(typeof store.getCanonicalOriginConflict === 'function' && !(await store.getCanonicalOriginConflict(bound.scope, event.eventId, session)), 'Canonical origin identity is already owned by another bank producer.');
      const claim = {
          scope: bound.scope,
          eventId: event.eventId,
          accountId: p.accountId,
          period: event.statementPeriod,
          creator: 'api-accountant'
        },
        old = await store.getReservation(bound.scope, event.eventId, session);
      if (old) need(old.contentHash === C.hash(old.payload) && same(old.payload, claim), 'Explicit advice creator reservation conflicts.');else await store.putEvent(rowFor(bound.scope, p.accountId, p.currency, event.eventId, 0, claim, 'reservation'), session);
      const seed = {
          version: 1,
          kind: ORIGIN,
          scope: bound.scope,
          accountId: p.accountId,
          event: clone(event),
          policyHash: p.policyHash,
          adviceHash: row.contentHash,
          mapping: clone(p.mapping),
          receivedDate: today,
          state: 'pending',
          description: request.kind + ' — ' + request.reference,
          bookkeeping: {
            status: request.kind === 'unknown' ? 'held' : 'needed',
            creator: 'api-accountant',
            decisionKey: require('./bank-origin-resolution').keyFor(event),
            bankDate: today,
            reason: request.kind === 'unknown' ? 'Unexplained bank advice requires investigation; no bookkeeping is authorized.' : null,
            runId: null
          },
          previousHash: null
        },
        seedRow = rowFor(bound.scope, p.accountId, p.currency, namespace, 1, seed),
        postRow = rowFor(bound.scope, p.accountId, p.currency, namespace, 2, {
          ...clone(seed),
          state: 'posted',
          previousHash: seedRow.contentHash
        });
      await store.putEvent(seedRow, session);
      await store.putEvent(postRow, session);
      const finish = {
        ...clone(p),
        state: 'posted',
        eventId: event.eventId,
        postingDate: today,
        previousHash: row.contentHash
      };
      await store.putEvent(rowFor(bound.scope, p.accountId, p.currency, row.eventId, 2, finish), session);
      retained.push(seedRow, postRow);
      posted++;
    }
    return {
      posted,
      excluded
    };
  }
  async function configure(bound, input) {
    exact(input, ['accountId', 'expectedRevision', 'enabled', 'feeMinor', 'mapping', 'decisionKey']);
    const scope = scopeOf(bound.scope),
      accountId = input.accountId;
    need(/^\d{1,30}$/.test(accountId || '') && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && typeof input.enabled === 'boolean' && Number.isSafeInteger(input.feeMinor) && input.feeMinor > 0 && input.feeMinor <= 100000 && /^[A-Za-z0-9_-]{8,100}$/.test(input.decisionKey || ''), 'Choose a bounded explicit fee policy and decision identifier.');
    await store.assertReady();
    return store.transaction(async session => {
      await inside({
        ...bound,
        scope
      }, session);
      const ledger = assertLedger(await store.getLedger(scope, accountId, session), scope, accountId);
      await store.fenceAccount(scope, accountId, ledger.account.accountCurrency, session);
      const history = policyHistory(await rows({
          scope
        }, accountId, session), scope, accountId),
        previous = history.at(-1),
        today = dayAt(clock());
      if (previous?.payload.decisionKey === input.decisionKey) {
        need(previous.payload.enabled === input.enabled && previous.payload.feeMinor === input.feeMinor && same(previous.payload.requestedMapping, input.mapping), 'The retained policy decision has different choices.');
        return clone(previous.payload);
      }
      need((previous?.revision || 0) === input.expectedRevision, 'Bank policy changed; read its current revision.');
      need(today >= dayAt(ledger.adoption.at), 'Bank policy cannot start before its actual adoption.');
      need(typeof observeMapping === 'function', 'Current observed counterpart and explicit tax choice are required.');
      const retainedDisable = previous && !input.enabled && input.feeMinor === previous.payload.feeMinor && same(input.mapping, previous.payload.requestedMapping);
      const mapping = retainedDisable ? clone(previous.payload.mapping) : await observeMapping({
        ...bound,
        scope
      }, input.mapping, input.feeMinor, session);
      need(mapping && same(mapping.requested, input.mapping) && typeof mapping.definitionHash === 'string' && mapping.definitionHash.length === 64, 'Current counterpart proof is unavailable.');
      const epoch = previous?.payload.epoch || today,
        seriesId = previous?.payload.seriesId || C.hash({
          scope,
          accountId,
          kind: 'monthly-service-fee'
        });
      let effectiveFrom = today;
      if (previous) {
        let n = 0;
        while (cycleDate(epoch, n) <= today) n++;
        effectiveFrom = cycleDate(epoch, n);
      }
      const payload = {
        version: 1,
        kind: POLICY,
        scope,
        accountId,
        currency: ledger.account.accountCurrency,
        accountType: ledger.account.accountType,
        baselineHash: ledger.contentHash,
        epoch,
        anchorDay: Number(epoch.slice(8)),
        seriesId,
        effectiveFrom,
        enabled: input.enabled,
        feeMinor: input.feeMinor,
        mapping: clone(mapping),
        requestedMapping: clone(input.mapping),
        decisionKey: input.decisionKey,
        ownerId: bound.ownerId,
        actorId: bound.actorId,
        recordedAt: new Date(clock()).toISOString(),
        previousHash: previous?.contentHash || null
      };
      await store.putEvent(rowFor(scope, accountId, payload.currency, '@origin-policy:' + accountId, (previous?.revision || 0) + 1, payload), session);
      return clone(payload);
    });
  }
  async function processDue(bound, {
    accountId,
    cutoff
  } = {}) {
    const scope = scopeOf(bound.scope),
      today = dayAt(clock());
    need(/^\d{1,30}$/.test(accountId || ''), 'Exact adopted account required.');
    cutoff = cutoff || today;
    C.date(cutoff);
    need(cutoff <= today, 'Future bank processing cutoffs are unavailable.');
    await authorize({
      ...bound,
      scope
    }, null, 'periods.manage');
    await store.assertReady();
    const returnWork=await postReturns({...bound,scope},accountId,cutoff),returned=returnWork.posted;
    const preview = await rows({
        scope
      }, accountId),
      policies = policyHistory(preview, scope, accountId),
      first = policies[0]?.payload;
    if (!first) return {
      posted: returned,
      returnHolds:returnWork.holds,
      reused: 0,
      qboCalls: 0
    };
    let dueWork = preview.some(r => r.payload.kind === 'bank-origin-explicit-advice' && r.revision === 1 && r.payload.dueDate <= cutoff && !preview.some(done => done.eventId === r.eventId && done.revision === 2));
    for (let ordinal = 0; !dueWork && ordinal <= 1200; ordinal++) {
      const due = cycleDate(first.epoch, ordinal);
      if (due > cutoff) break;
      const policy = latestPolicyAt(policies, due);
      if (!policy?.payload.enabled) continue;
      const reference = 'origin_' + C.hash({
          scope,
          accountId,
          seriesId: first.seriesId,
          cycleOrdinal: ordinal
        }),
        id = require('./bank-origin-events').originId(scope, {
          kind: 'bank-fee',
          advice: {
            reference
          }
        }),
        eventId = C.stableEventId(scope, 'BankOrigin', id, accountId);
      if (!preview.some(r => r.eventId === '@origin:' + eventId)) dueWork = true;
    }
    if (!dueWork) return {
      posted: returned,
      returnHolds:returnWork.holds,
      reused: 0,
      qboCalls: 0
    };
    return store.transaction(async session => {
      await inside({
        ...bound,
        scope
      }, session);
      const ledger = assertLedger(await store.getLedger(scope, accountId, session), scope, accountId);
      await store.fenceAccount(scope, accountId, ledger.account.accountCurrency, session);
      const retained = await rows({
          scope
        }, accountId, session),
        history = policyHistory(retained, scope, accountId),
        head = history[0]?.payload;
      if (!head) return {
        posted: 0,
        reused: 0,
        qboCalls: 0
      };
      need(head.baselineHash === ledger.contentHash, 'Adopted baseline changed.');
      let posted = 0,
        reused = 0,
        processed = 0;
      for (let ordinal = 0; ordinal <= 1200; ordinal++) {
        const due = cycleDate(head.epoch, ordinal);
        if (due > cutoff) break;
        const policyRow = latestPolicyAt(history, due);
        if (!policyRow || !policyRow.payload.enabled) continue;
        const policy = policyRow.payload,
          canonical = 'origin_' + C.hash({
            scope,
            accountId,
            seriesId: head.seriesId,
            cycleOrdinal: ordinal
          }),
          originId = require('./bank-origin-events').originId(scope, {
            kind: 'bank-fee',
            advice: {
              reference: canonical
            }
          }),
          eventId = C.stableEventId(scope, 'BankOrigin', originId, accountId),
          namespace = '@origin:' + eventId,
          old = retained.filter(r => r.eventId === namespace);
        if (old.length) {
          validateOriginLifecycle(retained, scope, accountId);
          reused++;
          continue;
        }
        if (processed++ >= 100) break;
        const mapping = policy.mapping,
          scenario = {
            scenarioId: canonical,
            kind: policy.accountType === 'Credit Card' ? 'card-fee' : 'bank-fee',
            accountId,
            currency: policy.currency,
            amountMinor: policy.feeMinor,
            bookDate: today,
            postingDate: today,
            scheduledDueDate: due,
            cycleOrdinal: ordinal,
            creator: 'api-accountant',
            counterpartAccountId: mapping.counterpartAccountId,
            taxTreatment: mapping.taxTreatment,
            ...(mapping.taxCodeId ? {
              taxCodeId: mapping.taxCodeId,
              netAmountMinor: mapping.netAmountMinor
            } : {}),
            advice: {
              basis: 'simulated',
              reference: canonical,
              humanReference: 'Monthly service fee cycle ' + ordinal
            },
            window: {
              start: head.epoch,
              end: today,
              unreconciled: true,
              evidenceRef: policyRow._id
            }
          },
          event = buildBankOriginEvents({
            scope,
            accounts: [{
              id: accountId,
              type: policy.accountType,
              currency: policy.currency
            }],
            scenarios: [scenario]
          }).events[0];
        need(event.eventId === eventId, 'Canonical advice identity changed.');
        need(typeof store.getCanonicalOriginConflict === 'function' && !(await store.getCanonicalOriginConflict(scope, eventId, session)), 'Canonical origin identity is already owned by another bank producer.');
        const reservation = await store.getReservation(scope, eventId, session),
          claim = {
            scope,
            eventId,
            accountId,
            period: event.statementPeriod,
            creator: 'api-accountant'
          };
        if (reservation) need(reservation.contentHash === C.hash(reservation.payload) && same(reservation.payload, claim), 'Bank-origin creator/period reservation conflicts.');else await store.putEvent(rowFor(scope, accountId, policy.currency, eventId, 0, claim, 'reservation'), session);
        const advice = {
            version: 1,
            kind: 'bank-origin-advice',
            scope,
            accountId,
            seriesId: head.seriesId,
            cycleOrdinal: ordinal,
            dueDate: due,
            postingDate: today,
            event: clone(event),
            policyHash: policyRow.contentHash
          },
          adviceRow = rowFor(scope, accountId, policy.currency, '@origin-advice:' + canonical, 1, advice);
        await store.putEvent(adviceRow, session);
        const seed = {
            version: 1,
            kind: ORIGIN,
            scope,
            accountId,
            event: clone(event),
            policyHash: policyRow.contentHash,
            adviceHash: adviceRow.contentHash,
            mapping: clone(mapping),
            receivedDate: today,
            state: 'pending',
            description: 'Monthly service fee — ' + due,
            bookkeeping: {
              status: 'needed',
              creator: 'api-accountant',
              decisionKey: require('./bank-origin-resolution').keyFor(event),
              bankDate: today,
              reason: null,
              runId: null
            },
            previousHash: null
          },
          seedRow = rowFor(scope, accountId, policy.currency, namespace, 1, seed);
        await store.putEvent(seedRow, session);
        const post = {
            ...clone(seed),
            state: 'posted',
            previousHash: seedRow.contentHash
          },
          postRow = rowFor(scope, accountId, policy.currency, namespace, 2, post);
        await store.putEvent(postRow, session);
        retained.push(adviceRow, seedRow, postRow);
        posted++;
      }
      const explicit = await postExplicit({
        ...bound,
        scope
      }, ledger, retained, cutoff, session);
      return {
        posted: returned + posted + explicit.posted,
        returnHolds:returnWork.holds,
        reused,
        excluded: explicit.excluded,
        qboCalls: 0
      };
    });
  }
  async function accountState(bound, accountId, businessActivity = null) {
    const scope = scopeOf(bound.scope);
    await authorize({
      ...bound,
      scope
    }, null, 'periods.read');
    const ledger = assertLedger(await store.getLedger(scope, accountId), scope, accountId),
      all = await rows({
        scope
      }, accountId),
      history = policyHistory(all, scope, accountId);
    const returnContext=all.some(r=>r.payload.kind===RETURN_ORIGIN)?await store.listBankOriginContext(bound.scope):all;
    for(const id of new Set(all.filter(r=>r.payload.kind===RETURN_ORIGIN).map(r=>r.payload.returnId))){need(typeof returnProof==='function','Original return proof unavailable.','BANKING_RETURN_HELD');const g=returnGroup(returnContext,bound.scope,id),v=await returnProof(bound,g.source.members[0].eventId,null,{current:false});need(same(v.source,g.source),'Original return history proof changed.','BANKING_RETURN_HELD');}
    return {
      policy: history.at(-1) ? clone(history.at(-1).payload) : null,
      policyRevision: history.at(-1)?.revision || 0,
      advice: all.filter(r => r.payload.kind === 'bank-origin-explicit-advice'||r.payload.kind===RETURN_ADVICE).filter(r => !all.some(other => other.eventId === r.eventId && other.revision > r.revision)).map(r => ({
        adviceId: r.eventId,
        kind: r.payload.request.kind,
        reference: r.payload.request.reference,
        amountMinor: r.payload.request.amountMinor??Math.abs(r.payload.source.members[0].amountMinor),
        dueDate: r.payload.dueDate,
        state: r.payload.state,
        eventId: r.payload.eventId || null
      })),
      activity: projectOriginActivity({
        scope,
        ledger,
        rows: all,
        businessActivity,returnContext
      })
    };
  }
  async function originState(bound, accountId, eventId, session) {
    const all = await rows(bound, accountId, session);
    validateOriginLifecycle(all, bound.scope, accountId);
    const chain = all.filter(r => r.eventId === '@origin:' + eventId).sort((a, b) => a.revision - b.revision);
    need(chain.length >= 2, 'Exact posted bank-origin event required.');
    if(chain[0].payload.kind===RETURN_ORIGIN){const context=await store.listBankOriginContext(bound.scope,session),g=returnGroup(context,bound.scope,chain[0].payload.returnId),l=g.primary;need(l,'Return group is not posted.','BANKING_RETURN_HELD');return {all:context.filter(r=>r.accountId===l.event.accountId),chain:l.chain,last:l.last,posted:l.posted,policy:g.claim,mapping:{kind:'source-bound-return',returnId:g.source.returnId,sourceHash:g.source.sourceHash},returnGroup:g};}
    const policy = all.find(r => r.contentHash === chain[0].payload.policyHash && r.payload.kind === POLICY);
    need(policy, 'Original bank policy is unavailable.');
    return {
      all,
      chain,
      last: chain.at(-1),
      posted: chain[1],
      policy,
      mapping: chain.at(-1).payload.mapping || policy.payload.mapping
    };
  }

  function originClaimAnchor(p, state) {
    return state.returnGroup ? p.version === 2 && p.kind === 'bank-return-booking-claim' && p.returnId === state.returnGroup.source.returnId && p.returnAnchorHash === state.policy.contentHash && p.returnSourceHash === state.returnGroup.source.sourceHash && p.memberPostHash === C.hash(state.returnGroup.legs.map(l => ({
      eventId: l.event.eventId,
      hash: l.posted.contentHash
    })).sort((a, b) => a.eventId.localeCompare(b.eventId))) : p.policyHash === state.policy.contentHash;
  }
  async function fenceOrigin(bound, state, session) {
    if (state.returnGroup) {
      for (const m of [...state.returnGroup.source.members].sort((a, b) => a.accountId.localeCompare(b.accountId))) await store.fenceAccount(bound.scope, m.accountId, m.accountCurrency, session);
    } else await store.fenceAccount(bound.scope, state.last.accountId, state.last.accountCurrency, session);
  }
  function canonicalOriginRows(found, scope) {
    const typed = found.find(r => r.payload?.kind === RETURN_ORIGIN);
    if (!typed) return found;
    const id = typed.payload.returnId,
      expected = require('./bank-origin-events').buildSourceBoundReturnEvents({
        source: typed.payload.event.source.advice.returnOf,
        request: typed.payload.event.source.advice.request,
        postingDate: typed.payload.event.actualPostingDate
      });
    need(found.every(r => r.payload.kind === RETURN_ORIGIN && r.payload.returnId === id && expected.some(e => r.eventId === '@origin:' + e.eventId && r.accountId === e.accountId && same(r.payload.event, e))) && expected.every(e => found.some(r => r.payload.event.eventId === e.eventId)), 'A return decision spans different or missing members.', 'BANKING_RETURN_HELD');
    const account = [...typed.payload.event.source.advice.returnOf.members].sort((a, b) => a.accountId.localeCompare(b.accountId))[0].accountId;
    return found.filter(r => r.accountId === account);
  }

  async function markBookkeeping(bound, accountId, eventId, status, reason, runId) {
    return store.transaction(async session => {
      await inside(bound, session);
      const state = await originState(bound, accountId, eventId, session);
      await fenceOrigin(bound, state, session);
      if (state.last.payload.bookkeeping.status === 'booked') return clone(state.last.payload.bookkeeping);
      const next = {
        ...state.last.payload.bookkeeping,
        status,
        reason,
        runId: runId || null
      };
      if (same(next, state.last.payload.bookkeeping)) return clone(next);
      const payload = {
        ...clone(state.last.payload),
        bookkeeping: next,
        previousHash: state.last.contentHash
      };
      if(state.returnGroup){for(const l of state.returnGroup.legs){await store.putEvent(rowFor(bound.scope,l.event.accountId,'CAD',l.last.eventId,l.last.revision+1,{...clone(l.last.payload),bookkeeping:clone(next),previousHash:l.last.contentHash}),session);}}else await store.putEvent(rowFor(bound.scope, accountId, state.last.accountCurrency, state.last.eventId, state.last.revision + 1, payload), session);
      return clone(next);
    });
  }
  async function book(bound, command) {
    exact(command, ['accountId', 'eventId']);
    const scope = scopeOf(bound.scope),
      accountId = command.accountId;
    need(/^\d{1,30}$/.test(accountId || '') && /^bse1_[a-f0-9]{40}$/.test(command.eventId || ''), 'Exact bank-origin account/event required.');
    bound = {
      ...bound,
      scope
    };
    need(bookkeeping && typeof bookkeeping.prepareDraft === 'function', 'Governed bank-origin bookkeeping is unavailable.');
    await authorize(bound, null, 'operations.preview');
    const state = await originState(bound, accountId, command.eventId);
    if(state.returnGroup&&(state.returnGroup.primary.event.accountId!==accountId||state.returnGroup.primary.event.eventId!==command.eventId))return book(bound,{accountId:state.returnGroup.primary.event.accountId,eventId:state.returnGroup.primary.event.eventId});
    if (state.last.payload.bookkeeping.status === 'booked') return clone(state.last.payload.bookkeeping);
    if (state.last.payload.event.status !== 'resolved') return markBookkeeping(bound, accountId, command.eventId, 'held', 'Unexplained bank advice requires investigation; no bookkeeping is authorized.', null);
    if (state.last.payload.event.bookDate !== dayAt(clock())) return markBookkeeping(bound, accountId, command.eventId, 'held', 'Older bank date requires separate governed date authority; the original date is unchanged.', state.last.payload.bookkeeping.runId);
    const claimId = '@origin-booking:' + command.eventId;
    let claim = state.all.filter(r => r.eventId === claimId).sort((a, b) => a.revision - b.revision)[0];
    if (!claim) {
      let prepared;
      try {
        prepared = await bookkeeping.prepareDraft(bound, state.last.payload.event, state.mapping);
      } catch (error) {
        await markBookkeeping(bound, accountId, command.eventId, 'held', 'Current scoped evidence or General draft guard held the original advice; no replacement or date shift is authorized.', null);
        throw error;
      }
      need(prepared && prepared.draft && prepared.operationHash, 'Exact guarded bank-origin draft required.');
      const expectedRunId = C.hash({
          scope,
          ownerId: String(bound.ownerId),
          kind: 'general-write',
          decisionKey: prepared.draft.decisionKey
        }).slice(0, 24),
        payload = {
          version: state.returnGroup?2:1,
          kind: state.returnGroup?'bank-return-booking-claim':'bank-origin-booking-claim',
          scope,
          accountId,
          eventId: command.eventId,
          originHash: state.posted.contentHash,
          adviceHash: state.posted.payload.adviceHash,
          ...(state.returnGroup?{returnId:state.returnGroup.source.returnId,returnAnchorHash:state.policy.contentHash,returnSourceHash:state.returnGroup.source.sourceHash,memberPostHash:C.hash(state.returnGroup.legs.map(l=>({eventId:l.event.eventId,hash:l.posted.contentHash})).sort((a,b)=>a.eventId.localeCompare(b.eventId)))}:{policyHash:state.posted.payload.policyHash}),
          mappingHash: C.hash(state.mapping),
          ownerId: bound.ownerId,
          originalActorId: bound.actorId,
          creator: 'api-accountant',
          decisionKey: prepared.draft.decisionKey,
          runId: expectedRunId,
          ref: 'bank-origin',
          draft: clone(prepared.draft),
          draftHash: C.hash(prepared.draft),
          operationHash: prepared.operationHash,
          contentHash: C.hash({
            purpose: prepared.draft.purpose.trim(),
            operations: prepared.draft.operations
          })
        };
      claim = await store.transaction(async session => {
        await inside(bound, session);
        await fenceOrigin(bound,state,session);
        const fresh = await originState(bound, accountId, command.eventId, session),
          old = fresh.all.find(r => r.eventId === claimId);
        need(fresh.posted.contentHash === payload.originHash, 'Origin changed before bookkeeping admission.');
        need(typeof bookkeeping.assertSendSafe === 'function', 'Current bank-origin financial admission proof is required.');
        await bookkeeping.assertSendSafe(bound, fresh.last.payload.event, fresh.mapping, payload, {
          session,
          runId: null,
          admission: false
        });
        if (old) {
          need(old.payload.draftHash === payload.draftHash && old.payload.runId === payload.runId, 'Another draft already owns this origin.');
          return old;
        }
        const created = rowFor(scope, accountId, state.last.accountCurrency, claimId, 1, payload);
        await store.putEvent(created, session);
        const reverse = {
          scope,
          runId: expectedRunId,
          ref: 'bank-origin',
          eventId: command.eventId,
          accountId,
          originHash: payload.originHash,
          ...(state.returnGroup?{version:2,returnId:state.returnGroup.source.returnId,returnAnchorHash:state.policy.contentHash,memberPostHash:payload.memberPostHash}:{})
        };
        await store.putEvent(rowFor(scope, accountId, state.last.accountCurrency, '@origin-general:' + expectedRunId + ':bank-origin', 0, reverse, 'reservation'), session);
        return created;
      });
    }
    const p = claim.payload;
    need(claim.contentHash === C.hash(p) && p.ownerId === bound.ownerId && p.originHash === state.posted.contentHash && originClaimAnchor(p,state) && p.draftHash === C.hash(p.draft) && p.mappingHash === C.hash(state.mapping), 'Retained booking claim changed.');
    const general = bookkeeping.general(bound);
    let prepared;
    try {
      prepared = await general.prepare(bound, p.draft);
    } catch (error) {
      await markBookkeeping(bound, accountId, command.eventId, 'held', 'Original General preparation could not be confirmed; retain its decision/run.', p.runId);
      throw error;
    }
    if (prepared.status === 'refused') return markBookkeeping(bound, accountId, command.eventId, 'held', 'General guard refused the frozen bank-origin draft; original mapping/date remain unchanged.', p.runId);
    need(prepared.runId === p.runId, 'The bank-origin decision resolved to another General run.');
    const run = await bookkeeping.loadRun(bound, p.runId);
    need(run && run.contentHash === p.contentHash && C.hash(run.plan.operations) === p.operationHash, 'Prepared General request differs from the frozen origin claim.');
    await store.transaction(async session => {
      await inside(bound, session);
      await fenceOrigin(bound,state,session);
      const fresh = await originState(bound, accountId, command.eventId, session),
        existing = fresh.all.find(r => r.eventId === claimId && r.revision === 2),
        binding = {
          version: state.returnGroup?2:1,
          kind: state.returnGroup?'bank-return-prepared-run':'bank-origin-prepared-run',
          scope,
          accountId,
          eventId: command.eventId,
          runId: p.runId,
          claimHash: claim.contentHash,
          contentHash: run.contentHash,
          operationHash: C.hash(run.plan.operations),
          previousHash: claim.contentHash
        };
      if (existing) need(existing.contentHash === C.hash(binding) && same(existing.payload, binding), 'Original prepared General binding changed.');else await store.putEvent(rowFor(scope, accountId, state.last.accountCurrency, claimId, 2, binding), session);
    });
    if (!general.dispatchEnabled()) return markBookkeeping(bound, accountId, command.eventId, 'held', 'General sending is disabled on this server.', p.runId);
    await authorize(bound, null, 'operations.execute');
    try {
      await general.execute(bound, p.runId);
    } catch (error) {
      await markBookkeeping(bound, accountId, command.eventId, 'held', 'Original General execution is held or uncertain. Recover this same run; never prepare a replacement.', p.runId);
      throw error;
    }
    const after = await originState(bound, accountId, command.eventId);
    return after.last.payload.bookkeeping.status === 'booked' ? clone(after.last.payload.bookkeeping) : markBookkeeping(bound, accountId, command.eventId, 'held', 'Original General response awaits authenticated bank-origin linkage; retry only this same run.', p.runId);
  }
  async function linkAccepted(bound, run, ref, session) {
    need(bookkeeping && typeof bookkeeping.proveSource === 'function' && typeof store.findOriginByDecision === 'function', 'Original bank-origin linkage is unavailable.');
    const found = canonicalOriginRows(await store.findOriginByDecision(bound.scope, run.decisionKey, session),bound.scope),
      ids = [...new Set(found.map(r => r.eventId))];
    need(ids.length === 1, 'No single original bank event owns this General decision.');
    const posted = found.find(r => r.revision === 2),
      accountId = posted?.accountId,
      eventId = posted?.payload?.event?.eventId;
    need(posted && eventId, 'Original posted bank advice unavailable.');
    await inside(bound, session);
    await fenceOrigin(bound,await originState(bound,accountId,eventId,session),session);
    const state = await originState(bound, accountId, eventId, session),
      claim = state.all.find(r => r.eventId === '@origin-booking:' + eventId && r.revision === 1),
      p = claim?.payload;
    need(p && claim.contentHash === C.hash(p) && p.runId === String(run._id) && p.ref === ref && p.ownerId === String(run.ownerId) && p.decisionKey === run.decisionKey && p.originHash === state.posted.contentHash && originClaimAnchor(p,state) && p.mappingHash === C.hash(state.mapping) && p.contentHash === run.contentHash && p.operationHash === C.hash(run.plan.operations), 'Accepted General run is not the exact claimed bank-origin request.');
    const preparedBinding = state.all.find(r => r.eventId === '@origin-booking:' + eventId && r.revision === 2);
    need(preparedBinding && preparedBinding.contentHash === C.hash(preparedBinding.payload) && preparedBinding.payload.claimHash === claim.contentHash && preparedBinding.payload.runId === p.runId && preparedBinding.payload.contentHash === run.contentHash && preparedBinding.payload.operationHash === p.operationHash, 'Original prepared General admission binding is required.');
    const source = await bookkeeping.proveSource(bound, run, ref, session);
    need(source && C.hash(run.plan.operations) === p.operationHash, 'Accepted source proof changed.');
    await bookkeeping.assertAccepted(bound, state.last.payload.event, state.mapping, run, ref, source);
    if (state.last.payload.bookkeeping.status === 'booked') {
      if (bookkeeping.assertRetained) await bookkeeping.assertRetained(bound, run, ref, state.last.payload.firstSource, source, session);
      need(state.last.payload.bookkeeping.qboEntity === source.source.entity && state.last.payload.bookkeeping.qboId === source.source.id && state.last.payload.firstSource?.signature === source.source.signature, 'Origin already links another accepted counterpart or changed provenance.');
      return clone(state.last.payload.bookkeeping);
    }
    const reverse = {
      scope: bound.scope,
      entity: source.source.entity,
      qboId: source.source.id,
      eventId,
      accountId,
      originHash: state.posted.contentHash,
      ...(state.returnGroup?{version:2,returnId:state.returnGroup.source.returnId,returnAnchorHash:state.policy.contentHash,memberPostHash:p.memberPostHash}:{})
    };
    const reverseId = '@origin-counterpart:' + source.source.entity + ':' + source.source.id,
      prior = await store.getReservation(bound.scope, reverseId, session);
    if (prior) need(prior.contentHash === C.hash(prior.payload) && same(prior.payload, reverse), 'This scoped QBO counterpart is already claimed by another bank event.');else await store.putEvent(rowFor(bound.scope, accountId, posted.accountCurrency, reverseId, 0, reverse, 'reservation'), session);
    const bookkeepingState = {
        ...state.last.payload.bookkeeping,
        status: 'booked',
        reason: null,
        runId: String(run._id),
        qboEntity: source.source.entity,
        qboId: source.source.id
      },
      payload = {
        ...clone(state.last.payload),
        bookkeeping: bookkeepingState,
        firstSource: clone(source.source),
        previousHash: state.last.contentHash
      };
    if(state.returnGroup){for(const l of state.returnGroup.legs){await store.putEvent(rowFor(bound.scope,l.event.accountId,'CAD',l.last.eventId,l.last.revision+1,{...clone(l.last.payload),bookkeeping:clone(bookkeepingState),firstSource:clone(source.source),previousHash:l.last.contentHash}),session);}const head=state.returnGroup.head;need(head.revision===2,'Return group was already linked differently.','BANKING_RETURN_HELD');await store.putEvent(rowFor(bound.scope,head.accountId,'CAD',head.eventId,3,{...clone(head.payload),state:'booked',runId:String(run._id),qboEntity:source.source.entity,qboId:source.source.id,firstSource:clone(source.source),previousHash:head.contentHash}),session);}else await store.putEvent(rowFor(bound.scope, accountId, posted.accountCurrency, state.last.eventId, state.last.revision + 1, payload), session);
    return clone(bookkeepingState);
  }
  async function assertAdmission(bound, run, batch, session) {
    need(session?.inTransaction?.() && run && same(persistedScopeOf(run), bound.scope) && String(run.ownerId) === bound.ownerId && String(run.actorId) === bound.actorId && /^bank_origin_/.test(run.decisionKey || ''), 'Exact scoped bank-origin new-send admission is required.');
    const found = canonicalOriginRows(await store.findOriginByDecision(bound.scope, run.decisionKey, session),bound.scope),
      ids = [...new Set(found.map(r => r.eventId))];
    need(ids.length === 1, 'A prefix does not authenticate an original bank-origin claim.');
    const posted = found.find(r => r.revision === 2);
    need(posted, 'Original posted bank event unavailable.');
    await inside(bound, session);
    await fenceOrigin(bound,await originState(bound,posted.accountId,posted.payload.event.eventId,session),session);
    const state = await originState(bound, posted.accountId, posted.payload.event.eventId, session),
      claim = state.all.find(r => r.eventId === '@origin-booking:' + posted.payload.event.eventId && r.revision === 1),
      prepared = state.all.find(r => r.eventId === claim?.eventId && r.revision === 2),
      p = claim?.payload;
    need(p && prepared && p.runId === String(run._id) && p.ownerId === String(run.ownerId) && p.decisionKey === run.decisionKey && p.originHash === state.posted.contentHash && originClaimAnchor(p,state) && p.mappingHash === C.hash(state.mapping) && p.draftHash === C.hash(p.draft) && p.contentHash === run.contentHash && p.operationHash === C.hash(run.plan.operations) && prepared.payload.claimHash === claim.contentHash && prepared.payload.contentHash === run.contentHash && prepared.payload.operationHash === p.operationHash && batch.items.length === 1 && batch.items[0].ref === p.ref && state.last.payload.bookkeeping.status !== 'booked', 'The original bank-origin claim/prepared request changed before a new send.');
    const frozen=run.plan.operations[0],sent=batch.items[0],savedIds=Object.fromEntries(Object.entries(run.items||{}).filter(([,item])=>item.outcome==='saved'&&item.qboId).map(([ref,item])=>[ref,item.qboId]));
    need(run.plan.operations.length===1&&frozen.op==='create'&&frozen.ref===p.ref&&frozen.id===undefined&&sent.entity===frozen.entity&&sent.op==='create'&&sent.operation==='create'&&sent.ref===frozen.ref&&sent.id===undefined&&sent.payload&&sent.payload.Id===undefined&&sent.payload.SyncToken===undefined&&sent.payload.sparse===undefined&&same(sent.payload,require('./general-write-service').resolve(frozen.payload,savedIds)),'The actual bank-origin batch differs from its exact frozen single-create request.');
    await bookkeeping.assertSendSafe(bound, state.last.payload.event, state.mapping, p, {
      session,
      runId: String(run._id),
      requestHash: require('./general-write-transport').buildGeneralBatch(bound.scope, batch).requestHash,
      admission: true
    });
    return true;
  }
  return {
    assertAdmission,
    configure,
    addAdvice,
    processDue,
    accountState,
    book,
    linkAccepted
  };
}
function exactBankLeg(entity, record, event, mapping, context, local, {
  saved = false
} = {}) {
  const accountId = event.accountId,
    expected = event.amountMinor;
  need(record.CurrencyRef?.value === event.accountCurrency && record.TxnDate === event.bookDate, 'Counterpart date/native currency differs from the bank advice.');
  if (entity === 'JournalEntry') {
    need(mapping.taxTreatment === 'out-of-scope' && record.Line?.length === 2, 'Out-of-scope advice requires exactly two journal lines.');
    let bank = 0,
      other = 0;
    for (const line of record.Line) {
      const d = line.JournalEntryLineDetail,
        amount = C.minor(line.Amount);
      need(line.DetailType === 'JournalEntryLineDetail' && amount > 0 && ['Debit', 'Credit'].includes(d?.PostingType), 'Exact journal posting lines required.');
      const signed = amount * (d.PostingType === 'Debit' ? 1 : -1),
        id = d.AccountRef?.value;
      if (id === accountId) bank += signed;else {
        need(id === mapping.counterpartAccountId, 'Journal counterpart account changed.');
        other += signed;
      }
    }
    need(bank === expected && other === -expected, 'Journal bank leg differs from the exact origin.');
    return bank;
  }
  need(entity === 'Purchase' && record.Credit !== true && (record.Credit === undefined || record.Credit === false) && event.amountMinor < 0 && record.AccountRef?.value === accountId && record.PaymentType === (event.accountType === 'Credit Card' ? 'CreditCard' : 'Cash') && record.Line?.length === 1, 'Taxable advice requires its exact native Purchase funding leg.');
  const d = record.Line[0].AccountBasedExpenseLineDetail;
  need(mapping.taxTreatment === 'taxable' && record.GlobalTaxCalculation === 'TaxExcluded' && d?.AccountRef?.value === mapping.counterpartAccountId && d.TaxCodeRef?.value === mapping.taxCodeId && C.minor(record.Line[0].Amount) === mapping.netAmountMinor, 'Purchase counterpart/net/tax choice changed.');
  const gross = require('./general-write-guards').grossCents('Purchase', record, context, {
    saved,
    local
  });
  need(Number.isSafeInteger(gross) && -gross === expected && (!saved || C.minor(record.TotalAmt) === gross), 'Purchase gross including tax differs from bank advice.');
  return -gross;
}
// Ownership indexes share kind:reservation with BF4 creator reservations.
// Exclude an index only after authenticating its retained original lineage.

async function authenticateReturnOwnership({
  row,
  p,
  general,
  counterpart,
  rows,
  scope,
  models,
  session
}) {
  need(p.version === 2 && typeof p.returnId === 'string', 'Typed return ownership is required.', 'BANKING_RETURN_HELD');
  const g = returnGroup(rows, scope, p.returnId),
    primary = g.primary;
  need(primary && row.accountId === primary.event.accountId && row.accountCurrency === 'CAD' && p.eventId === primary.event.eventId && p.originHash === primary.posted.contentHash && p.returnAnchorHash === g.claim.contentHash, 'Return ownership group changed.', 'BANKING_RETURN_HELD');
  const claims = rows.filter(r => r.eventId === '@origin-booking:' + p.eventId && r.revision === 1),
    prepared = rows.filter(r => r.eventId === '@origin-booking:' + p.eventId && r.revision === 2);
  need(claims.length === 1 && prepared.length <= 1, 'Return booking ownership is ambiguous.', 'BANKING_RETURN_HELD');
  const claim = claims[0],
    c = claim.payload;
  validateRows([...claims, ...prepared], scope, row.accountId);
  const memberPostHash = C.hash(g.legs.map(l => ({
      eventId: l.event.eventId,
      hash: l.posted.contentHash
    })).sort((a, b) => a.eventId.localeCompare(b.eventId))),
    draft = require('./bank-origin-resolution').returnDraft(primary.event);
  need(c.version === 2 && c.kind === 'bank-return-booking-claim' && c.returnId === p.returnId && same(c.scope, scope) && c.accountId === row.accountId && c.eventId === p.eventId && c.originHash === p.originHash && c.returnAnchorHash === g.claim.contentHash && c.returnSourceHash === g.source.sourceHash && c.memberPostHash === memberPostHash && c.ownerId === g.claim.payload.ownerId && c.decisionKey === draft.decisionKey && same(c.draft, draft) && c.draftHash === C.hash(draft) && c.contentHash === C.hash({
    purpose: draft.purpose.trim(),
    operations: draft.operations
  }) && c.runId === C.hash({
    scope,
    ownerId: c.ownerId,
    kind: 'general-write',
    decisionKey: c.decisionKey
  }).slice(0, 24), 'Return booking authority changed.', 'BANKING_RETURN_HELD');
  const pick = (kind, eventId) => {
      const f = rows.filter(r => r.kind === kind && r.eventId === eventId);
      need(f.length === 1, 'Original return evidence is missing or duplicated.', 'BANKING_RETURN_HELD');
      return f[0];
    },
    original = await readPostedReturnSource({
      models,
      scope,
      store: {
        getInstruction: async (s, id) => pick('instruction', '@instruction:' + id),
        getSettlementRevisions: async (s, id) => rows.filter(r => r.kind === 'revision' && r.eventId === '@instruction:' + id),
        getLedger: async (s, id) => pick('ledger-account', '@ledger:' + id)
      },
      bound: {
        scope,
        ownerId: c.ownerId,
        actorId: c.originalActorId
      },
      eventId: g.source.members[0].eventId,
      session
    });
  need(same(original.source, g.source), 'Original returned source authority changed.', 'BANKING_RETURN_HELD');
  let q = models.GeneralWriteRuns.findOne({
    _id: c.runId,
    ...scope
  }).maxTimeMS(3000);
  if (session) q = q.session(session);
  const run = await q.lean();
  if (run) need(same(persistedScopeOf(run), scope) && String(run.ownerId) === c.ownerId && String(run.actorId) === c.originalActorId && run.decisionKey === c.decisionKey && run.contentHash === c.contentHash && C.hash(run.plan?.operations) === c.operationHash, 'Return General ownership changed.', 'BANKING_RETURN_HELD');
  if (prepared.length) {
    const b = prepared[0].payload;
    need(run && b.version === 2 && b.kind === 'bank-return-prepared-run' && same(b.scope, scope) && b.accountId === row.accountId && b.eventId === p.eventId && b.runId === c.runId && b.claimHash === claim.contentHash && b.previousHash === claim.contentHash && b.contentHash === c.contentHash && b.operationHash === c.operationHash, 'Return prepared binding changed.', 'BANKING_RETURN_HELD');
  }
  if (general) need(same(p, {
    scope,
    runId: c.runId,
    ref: c.ref,
    eventId: c.eventId,
    accountId: row.accountId,
    originHash: c.originHash,
    version: 2,
    returnId: p.returnId,
    returnAnchorHash: g.claim.contentHash,
    memberPostHash
  }), 'Return General index changed.', 'BANKING_RETURN_HELD');
  if (counterpart) {
    const first = g.head.payload.firstSource,
      item = run?.items?.[c.ref];
    need(g.head.payload.state === 'booked' && run && prepared.length === 1 && same(p, {
      scope,
      entity: p.entity,
      qboId: p.qboId,
      eventId: c.eventId,
      accountId: row.accountId,
      originHash: c.originHash,
      version: 2,
      returnId: p.returnId,
      returnAnchorHash: g.claim.contentHash,
      memberPostHash
    }) && first?.entity === p.entity && first.id === p.qboId && item?.outcome === 'saved' && item.complete === true && item.entity === p.entity && item.qboId === p.qboId, 'Returned counterpart ownership changed.', 'BANKING_RETURN_HELD');
    const accepted = await require('./bank-instruction-service').proveSource({
      models,
      scope,
      run,
      ref: c.ref,
      session
    });
    need(accepted.source.signature === first.signature, 'Returned counterpart receipt changed.', 'BANKING_RETURN_HELD');
    if (String(accepted.receipt._id) !== first.receiptId) {
      const retained = clone(run),
        batch = retained.batches.filter(b => b.index === first.batchIndex && b.requestId === first.requestId && b.items.some(i => i.ref === c.ref));
      need(batch.length === 1, 'Original returned counterpart batch unavailable.', 'BANKING_RETURN_HELD');
      batch[0].transport.receiptId = first.receiptId;
      const original = await require('./bank-instruction-service').proveSource({
        models,
        scope,
        run: retained,
        ref: c.ref,
        session
      });
      need(original.source.signature === first.signature && String(original.receipt._id) === first.receiptId, 'Original returned counterpart receipt changed.', 'BANKING_RETURN_HELD');
    }
    require('./bank-origin-resolution').exactReturnLeg(p.entity, accepted.record, primary.event);
  }
}

async function creatorReservations({rows,scope,accounts,models,session}) {
  need(Array.isArray(rows)&&rows.length<=100000,'Complete bank reservation history unavailable.');
  const result=[],seen=new Set(),rowIds=new Set(),checkedAccounts=new Set(),runs=new Map();
  const accountById=new Map(accounts.map(a=>[a.Id,a]));
  const one=(list,message)=>{need(list.length===1,message);return list[0];};
  for(const row of rows.filter(r=>r.kind==='reservation')) {
    const p=row.payload,account=accountById.get(row.accountId);
    validateRows([row],scope,row.accountId);
    need(row.revision===0&&typeof row.eventId==='string'&&p&&same(p.scope,scope)&&p.accountId===row.accountId&&account&&row.accountCurrency===(account.CurrencyRef?.value||'CAD')&&!rowIds.has(row._id),'Bank creator reservation identity changed or is already claimed.');
    rowIds.add(row._id);
    if(row.eventId===p.eventId) {
      need(/^bse1_[a-f0-9]{40}$/.test(p.eventId)&&['api-accountant','native-add','none'].includes(p.creator),'Unknown bank creator reservation.');
      need(!seen.has(p.eventId),'Duplicate bank creator reservation.');seen.add(p.eventId);result.push(row);continue;
    }
    const general=row.eventId==='@origin-general:'+p.runId+':'+p.ref,
      counterpart=row.eventId==='@origin-counterpart:'+p.entity+':'+p.qboId;
    need(general||counterpart,'Unknown bank ownership reservation.');
    if(p.returnId!==undefined){await authenticateReturnOwnership({row,p,general,counterpart,rows,scope,models,session});continue;}
    if(!checkedAccounts.has(row.accountId)) {
      validateOriginLifecycle(rows.filter(r=>r.accountId===row.accountId&&r.kind==='revision'&&r.eventId.startsWith('@origin')),scope,row.accountId);
      checkedAccounts.add(row.accountId);
    }
    const chain=rows.filter(r=>r.eventId==='@origin:'+p.eventId).sort((a,b)=>a.revision-b.revision),
      posted=one(chain.filter(r=>r.revision===2),'Original posted ownership source unavailable.'),last=chain.at(-1),
      claim=one(rows.filter(r=>r.eventId==='@origin-booking:'+p.eventId&&r.revision===1),'Original ownership booking claim unavailable.'),c=claim.payload,
      preparedRows=rows.filter(r=>r.eventId===claim.eventId&&r.revision===2);
    need(chain.every(r=>r.kind==='revision')&&claim.kind==='revision'&&preparedRows.every(r=>r.kind==='revision'),'Bank ownership revision identity changed.');
    validateRows([...chain,claim,...preparedRows],scope,row.accountId);
    need(preparedRows.length<=1&&posted.accountId===row.accountId&&posted.accountCurrency===row.accountCurrency&&posted.contentHash===p.originHash&&claim.accountId===row.accountId&&claim.accountCurrency===row.accountCurrency&&c.kind==='bank-origin-booking-claim'&&same(c.scope,scope)&&c.accountId===row.accountId&&c.eventId===p.eventId&&c.originHash===posted.contentHash&&c.adviceHash===posted.payload.adviceHash&&c.policyHash===posted.payload.policyHash&&c.mappingHash===C.hash(posted.payload.mapping)&&c.creator==='api-accountant'&&c.decisionKey===require('./bank-origin-resolution').keyFor(posted.payload.event)&&c.ref==='bank-origin'&&c.draftHash===C.hash(c.draft)&&c.contentHash===C.hash({purpose:c.draft.purpose.trim(),operations:c.draft.operations})&&c.runId===C.hash({scope,ownerId:c.ownerId,kind:'general-write',decisionKey:c.decisionKey}).slice(0,24),'Bank ownership booking lineage changed.');
    if(general)need(same(p,{scope,runId:c.runId,ref:c.ref,eventId:c.eventId,accountId:row.accountId,originHash:posted.contentHash}),'General bank ownership identity changed.');
    else need(same(p,{scope,entity:p.entity,qboId:p.qboId,eventId:c.eventId,accountId:row.accountId,originHash:posted.contentHash}),'Counterpart bank ownership identity changed.');
    if(!runs.has(c.runId)) {
      need(models.GeneralWriteRuns&&typeof models.GeneralWriteRuns.findOne==='function','Retained General ownership store unavailable.');
      let q=models.GeneralWriteRuns.findOne({_id:c.runId,...scope}).maxTimeMS(3000);if(session)q=q.session(session);runs.set(c.runId,await q.lean());
    }
    const run=runs.get(c.runId),prepared=preparedRows[0];
    if(run)need(same(persistedScopeOf(run),scope)&&String(run._id)===c.runId&&String(run.ownerId)===c.ownerId&&String(run.actorId)===c.originalActorId&&run.decisionKey===c.decisionKey&&run.contentHash===c.contentHash&&run.plan?.operations?.length===1&&run.plan.operations[0].ref===c.ref&&C.hash(run.plan.operations)===c.operationHash,'Retained General ownership request changed.');
    if(prepared) {
      const b=prepared.payload;
      need(run&&prepared.accountId===row.accountId&&prepared.accountCurrency===row.accountCurrency&&b.kind==='bank-origin-prepared-run'&&same(b.scope,scope)&&b.accountId===row.accountId&&b.eventId===p.eventId&&b.runId===c.runId&&b.claimHash===claim.contentHash&&b.previousHash===claim.contentHash&&b.contentHash===c.contentHash&&b.operationHash===c.operationHash,'Prepared General ownership binding changed.');
    }
    if(counterpart) {
      const item=run?.items?.[c.ref],booked=last?.payload?.bookkeeping,first=last?.payload?.firstSource;
      need(run&&prepared&&typeof p.entity==='string'&&typeof p.qboId==='string'&&booked?.status==='booked'&&booked.runId===c.runId&&booked.qboEntity===p.entity&&booked.qboId===p.qboId&&first?.entity===p.entity&&first.id===p.qboId&&typeof first.signature==='string'&&first.signature.length>0&&item?.outcome==='saved'&&item.complete===true&&item.entity===p.entity&&item.qboId===p.qboId&&item.record?.Id===p.qboId,'Booked bank counterpart ownership changed.');
    }
  }
  return result;
}
function createBankBookkeepingAdapter({
  models,
  store,
  copy,
  contextFor,
  snapshot,
  general,
  observeMapping,
  returnProof=null,
  now = () => Date.now()
}) {
  async function guardData(bound, event, mapping, session = null, runId = null) {
    const current = await observeMapping(bound, mapping.requested, Math.abs(event.amountMinor), session, {
      income: event.kind === 'interest-income'
    });
    need(current.definitionHash === mapping.definitionHash && current.taxProof === mapping.taxProof, 'Frozen counterpart or tax definition changed.');
    const required = [['Account', event.accountId], ['Account', mapping.counterpartAccountId], ...(mapping.taxCodeId ? [['TaxCode', mapping.taxCodeId]] : [])],
      local = await require('./general-write-service').loadCopy(session && copy.forSession ? copy.forSession(session) : copy, bound.scope, [], new Set(), [], new Set(), required),
      context = await contextFor(bound.scope, local, {
        operations: [],
        session,
        runId
      });
    return {
      local,
      context
    };
  }

  async function prepareGuardedReturn(bound, event, {
    session = null,
    runId = null,
    requestHash = null,
    admission = false
  } = {}) {
    need(typeof returnProof === 'function', 'Current return proof is unavailable.', 'BANKING_RETURN_HELD');
    const frozen = event.source.advice.returnOf,
      verified = await returnProof(bound, frozen.members[0].eventId, session, {
        current: true
      });
    need(same(verified.source, frozen), 'Original return source changed before bookkeeping.', 'BANKING_RETURN_HELD');
    const current = await snapshot(bound, {
        session,
        runId,
        requestHash,
        admission
      }),
      all = await store.listBankOriginContext(bound.scope, session),
      claims = await creatorReservations({
        rows: all,
        scope: bound.scope,
        accounts: current.records.filter(r => r.entity === 'Account' && !r.deleted).map(r => r.record),
        models,
        session
      });
    for (const m of frozen.members) {
      const id = C.stableEventId(bound.scope, 'BankOrigin', event.source.id, m.accountId),
        owned = claims.filter(r => r.payload.eventId === id);
      need(owned.length === 1 && owned[0].payload.creator === 'api-accountant' && owned[0].payload.period === event.statementPeriod, 'Whole return creator ownership changed.', 'BANKING_RETURN_HELD');
    }
    const decisionKey = require('./bank-origin-resolution').keyFor(event),
      query = models.GeneralWriteRuns.find({
        ...bound.scope,
        decisionKey
      }).limit(2).maxTimeMS(3000);
    if (session) query.session(session);
    const retained = await query.lean();
    need(retained.length <= 1, 'General return decision ownership is ambiguous.', 'BANKING_RETURN_HELD');
    let own = null;
    if (runId) {
      const indexes = all.filter(r => r.eventId === '@origin-general:' + runId + ':bank-origin'),
        booking = all.find(r => r.eventId === '@origin-booking:' + event.eventId && r.revision === 1),
        binding = all.find(r => r.eventId === '@origin-booking:' + event.eventId && r.revision === 2);
      need(indexes.length === 1 && booking && binding && booking.payload.kind === 'bank-return-booking-claim' && booking.payload.returnId === frozen.returnId && booking.payload.runId === runId && booking.payload.ownerId === bound.ownerId && booking.payload.decisionKey === decisionKey && binding.payload.claimHash === booking.contentHash, 'The current return run lacks authenticated original ownership.', 'BANKING_RETURN_HELD');
      own = retained.find(r => String(r._id) === runId);
      need(own && String(own.ownerId) === bound.ownerId && String(own.actorId) === booking.payload.originalActorId && own.contentHash === booking.payload.contentHash && C.hash(own.plan.operations) === booking.payload.operationHash, 'The current return decision changed.', 'BANKING_RETURN_HELD');
    }
    const ambiguity = require('./bank-origin-resolution').inspectExistingBookkeeping({
      event,
      mirrorSnapshot: current,
      decisions: retained.filter(r => r !== own).map(r => ({
        scope: persistedScopeOf(r),
        decisionKey: r.decisionKey,
        state: r.status
      })),
      asOf: new Date(now()).toISOString()
    });
    need(ambiguity.blockers.length === 0, 'Return bookkeeping is ambiguous or already present: ' + ambiguity.blockers.map(b => b.code).join(', '), 'BANKING_RETURN_HELD');
    const draft = require('./bank-origin-resolution').returnDraft(event),
      local = await require('./general-write-service').loadCopy(session && copy.forSession ? copy.forSession(session) : copy, bound.scope, draft.operations, new Set()),
      context = await contextFor(bound.scope, local, {
        operations: draft.operations,
        session,
        runId
      }),
      checked = require('./general-write-guards').checkGeneralWrite({
        proposal: {
          operations: draft.operations
        },
        local,
        context,
        scope: bound.scope
      });
    need(checked?.ok === true && checked.plan.operations.length === 1, 'Governed return draft is held: ' + (checked?.problems || []).map(p => p.message || p.code).join(', '), 'BANKING_RETURN_HELD');
    const op = checked.plan.operations[0];
    require('./bank-origin-resolution').exactReturnLeg(op.entity, op.payload, event);
    return {
      draft,
      operationHash: C.hash(checked.plan.operations)
    };
  }

  async function prepareGuardedDraft(bound, event, mapping, {
    session = null,
    runId = null,
    requestHash = null,
    admission = false
  } = {}) {
    if(event.policyVersion===require('./bank-origin-events').RETURN_VERSION)return prepareGuardedReturn(bound,event,{session,runId,requestHash,admission});
    const current = await snapshot(bound, {
        session,
        runId,
        requestHash,
        admission
      }),
      {
        local,
        context
      } = await guardData(bound, event, mapping, session, runId),
      accounts = current.records.filter(r => r.entity === 'Account' && !r.deleted).map(r => r.record),
      reservations = await store.listBankOriginContext(bound.scope, session);
    need(reservations.length <= 100000, 'Complete bank reservation history unavailable.');
    const claimRows = await creatorReservations({rows:reservations,scope:bound.scope,accounts,models,session});
    const decisionQuery = models.GeneralWriteRuns.find({
      ...bound.scope,
      decisionKey: require('./bank-origin-resolution').keyFor(event)
    }).limit(2).maxTimeMS(3000);
    if (session) decisionQuery.session(session);
    const retainedDecisions = await decisionQuery.lean(),
      decisions = retainedDecisions.filter(d => String(d._id) !== runId);
    need(retainedDecisions.length <= 1 && decisions.length <= 1, 'General decision ownership is ambiguous.');
    let checkedOperationHash = null;
    const result = require('./bank-origin-resolution').prepareBankOriginResolution({
      event,
      accounts,
      reservations: claimRows.map(r => r.payload),
      mirrorSnapshot: current,
      decisions,
      asOf: new Date(now()).toISOString(),
      checkDraft: draft => {
        const checked = require('./general-write-guards').checkGeneralWrite({
          proposal: {
            operations: draft.operations
          },
          local,
          context,
          scope: bound.scope
        });
        need(checked && typeof checked.then !== 'function', 'Bank-origin draft checker must be synchronous.');
        if (!checked.ok) return {
          ok: false,
          problems: checked.problems
        };
        need(checked.plan.operations.length === 1, 'One origin requires one bookkeeping operation.');
        const op = checked.plan.operations[0],
          amount = exactBankLeg(op.entity, op.payload, event, mapping, context, local);
        checkedOperationHash = C.hash(checked.plan.operations);
        return {
          ok: true,
          bankAmountMinor: amount
        };
      }
    });
    need(result.status === 'accounting-draft' && result.draft && checkedOperationHash, 'Bank-origin draft is held: ' + result.blockers.map(b => b.code).join(', '));
    return {
      draft: result.draft,
      operationHash: checkedOperationHash
    };
  }
  return {
    general,
    loadRun: (bound, id) => models.GeneralWriteRuns.findOne({
      _id: id,
      ...bound.scope,
      ownerId: bound.ownerId
    }).maxTimeMS(3000).lean(),
    prepareDraft: prepareGuardedDraft,
    async assertSendSafe(bound, event, mapping, claim, options = {}) {
      const prepared = await prepareGuardedDraft(bound, event, mapping, options);
      need(prepared.operationHash === claim.operationHash && C.hash(prepared.draft) === claim.draftHash, 'The frozen bank-origin request no longer matches current complete evidence.');
      return true;
    },
    proveSource: (bound, run, ref, session) => require('./bank-instruction-service').proveSource({
      models,
      scope: bound.scope,
      run,
      ref,
      session
    }),
    async assertRetained(bound, run, ref, first, current, session) {
      need(first && first.signature === current.source.signature, 'Original counterpart provenance changed.');
      if (first.receiptId !== String(current.receipt._id)) {
        const retained = clone(run),
          batches = retained.batches.filter(b => b.index === first.batchIndex && b.requestId === first.requestId && b.items.some(i => i.ref === ref));
        need(batches.length === 1, 'Original counterpart batch unavailable.');
        batches[0].transport.receiptId = first.receiptId;
        const proof = await require('./bank-instruction-service').proveSource({
          models,
          scope: bound.scope,
          run: retained,
          ref,
          session
        });
        need(proof.source.signature === first.signature && String(proof.receipt._id) === first.receiptId, 'Original first-receipt lineage changed.');
      }
    },
    async assertAccepted(bound, event, mapping, run, ref, source) {
      if(event.policyVersion===require('./bank-origin-events').RETURN_VERSION){const op=run.plan.operations.find(o=>o.ref===ref);need(op&&op.op==='create'&&source.sent.entity===op.entity&&source.record.Id===source.source.id,'Exact accepted return counterpart unavailable.','BANKING_RETURN_HELD');require('./bank-origin-resolution').exactReturnLeg(op.entity,source.record,event);return;}
      const {
          local,
          context
        } = await guardData(bound, event, mapping),
        op = run.plan.operations.find(o => o.ref === ref);
      need(op && op.op === 'create' && source.sent.entity === op.entity && source.record.Id === source.source.id, 'Exact accepted origin counterpart unavailable.');
      exactBankLeg(op.entity, source.record, event, mapping, context, local, {
        saved: true
      });
    }
  };
}
async function assertOriginFinancialSnapshot({
  models,
  scope,
  snapshot,
  session = null,
  requestHash = null,
  admission = false,
  now = () => Date.now()
}) {
  need(models.Receipts && models.Writers, 'Exact financial writer and receipt stores are required for bank-origin admission.');
  const read = q => {
      if (session) q.session(session);
      return q.maxTimeMS(3000).lean();
    },
    writer = await read(models.Writers.findOne({
      _id: scope.environment + ':' + scope.realmId,
      ...scope
    }));
  need(writer && writer.contractVersion === 1 && Number.isSafeInteger(writer.revision) && !writer.populationDelegation && writer.operationId === null && writer.planHash === null && writer.unresolved === null, 'The current financial writer is not settled for a new bank-origin send.');
  const claims = require('./business-writer-fence').claimsOf(writer),
    live = claims.filter(row => row.state !== 'reserved' || row.expiresAt > now());
  need(live.every(row => admission && row.requestHash === requestHash && row.state === 'reserved' && !row.barrier), 'An unsettled financial resource must be recovered before new bank-origin bookkeeping.');
  const since = new Date(snapshot.syncedThrough);
  need(Number.isFinite(since.getTime()) && since.getTime() <= now(), 'Current complete sync coverage is required.');
  const receipts = await read(models.Receipts.find({
    ...scope,
    entity: {
      $in: ['batch', 'journalentry', 'purchase', 'deposit', 'payment', 'salesreceipt', 'refundreceipt', 'billpayment', 'creditcardpayment', 'creditcardpaymenttxn', 'transfer', 'invoice', 'bill', 'creditmemo', 'vendorcredit']
    },
    $or: [{
      state: {
        $in: ['possibly-sent', 'unknown']
      }
    }, {
      sentAt: {
        $gte: since
      }
    }, {
      observedAt: {
        $gte: since
      }
    }]
  }).limit(1001));
  need(receipts.length <= 1000, 'Complete relevant financial receipt evidence exceeds its bound.');
  for (const receipt of receipts) {
    let terminal = false;
    if (receipt.state === 'unknown' && receipt.ownerRecovery && Date.parse(receipt.sentAt) < since.getTime() && Date.parse(receipt.observedAt) < since.getTime() && models.Steps && models.Authorities) {
      const step = await read(models.Steps.findOne({
        ...scope,
        operationId: receipt.operationId,
        logicalKey: receipt.logicalKey
      }));
      if (step?.receipt?.source === 'owner-attributed-readback' && step.dispatch?.key === receipt.dispatchKey) {
        try {
          const proof = await require('./business-owner-attribution').assertOwnerAttribution(models, scope, step, session);
          terminal = proof?.payload?.receiptId === receipt._id && same(receipt.ownerRecovery, {
            version: 1,
            authorityHash: proof.authority.contentHash,
            auditId: String(proof.authority.auditId),
            qboId: proof.payload.qboId,
            reviewHash: proof.payload.reviewHash
          });
        } catch {}
      }
    }
    need(terminal, 'A relevant financial write is unsettled or newer than complete bank-origin sync evidence.');
  }
  // Initial claim must conflict with concurrent financial admission. At final admission
  // the existing QBO gate performs this same Writer CAS later in this transaction.
  if (session && !admission) {
    const touched = await models.Writers.findOneAndUpdate({
      _id: writer._id,
      ...scope,
      revision: writer.revision,
      operationId: null,
      planHash: null,
      unresolved: null
    }, {
      $inc: {
        revision: 1
      }
    }, {
      new: true,
      session
    }).lean();
    need(touched, 'Financial writer changed before the bank-origin claim.');
  }
  return true;
}
async function assertBankOriginAdmission({
  models,
  scope,
  run,
  batch,
  session,
  now = () => Date.now()
}) {
  const service = createDefaultBankOriginService({
    models,
    now
  });
  return service.assertAdmission({
    scope: scopeOf(scope),
    ownerId: String(run.ownerId),
    actorId: String(run.actorId),
    ...(run.agentAuthority ? {
      agentAuthority: run.agentAuthority
    } : {})
  }, run, batch, session);
}

// Read-only authentication for one existing posted economic group. The receipt
// and both posted revisions are re-proved; matching money alone grants nothing.
// Read-only authentication for one existing posted economic group. The receipt
// and both posted revisions are re-proved; matching money alone grants nothing.
// Read-only authentication for one existing posted economic group. The receipt
// and both posted revisions are re-proved; matching money alone grants nothing.
// Read-only authentication for one existing posted economic group. The receipt
// and both posted revisions are re-proved; matching money alone grants nothing.
async function readPostedReturnSource({
  models,
  store,
  bound,
  eventId,
  session = null
}) {
  need(models?.GeneralWriteRuns && models.Receipts && store?.getInstruction && store.getSettlementRevisions && store.getLedger, 'Original return proof stores are unavailable.', 'BANKING_RETURN_HELD');
  const scope = scopeOf(bound.scope),
    verifier = require('./bank-instruction-settlement'),
    first = await store.getInstruction(scope, eventId, session),
    p = verifier.validateInstruction(first, scope);
  need(p.source.ownerId === String(bound.ownerId) && ['Payment', 'Transfer'].includes(p.source.entity), 'Only an owned direct Payment or Transfer can be returned.', 'BANKING_RETURN_HELD');
  const instructions = [first];
  if (p.pairedEventId) instructions.push(await store.getInstruction(scope, p.pairedEventId, session));
  need(instructions.length === (p.source.entity === 'Transfer' ? 2 : 1), 'Complete original return pair is required.', 'BANKING_RETURN_HELD');
  let q = models.GeneralWriteRuns.findOne({
    _id: p.source.runId,
    ...scope,
    ownerId: bound.ownerId
  }).maxTimeMS(3000);
  if (session) q = q.session(session);
  const run = await q.lean();
  need(run && run.contract === 'general-write-v1' && String(run.ownerId) === String(bound.ownerId), 'Original owned return run unavailable.', 'BANKING_RETURN_HELD');
  const prove = run => require('./bank-instruction-service').proveSource({
      models,
      scope,
      run,
      ref: p.source.ref,
      session
    }),
    proof = await prove(run);
  need(proof.source.signature === p.source.signature, 'Original return SDK proof changed.', 'BANKING_RETURN_HELD');
  if (String(proof.receipt._id) !== p.source.receiptId) {
    const retained = clone(run),
      b = retained.batches.filter(b => b.index === p.source.batchIndex && b.requestId === p.source.requestId && b.items?.some(i => i.ref === p.source.ref));
    need(b.length === 1, 'Original return batch unavailable.', 'BANKING_RETURN_HELD');
    b[0].transport.receiptId = p.source.receiptId;
    const original = await prove(retained);
    need(original.source.signature === p.source.signature && String(original.receipt._id) === p.source.receiptId, 'First return receipt changed.', 'BANKING_RETURN_HELD');
  }
  const members = [];
  for (const row of instructions) {
    const i = verifier.validateInstruction(row, scope);
    need(i.source.signature === p.source.signature && i.source.receiptId === p.source.receiptId && i.source.ownerId === String(bound.ownerId), 'Original return members have different provenance.', 'BANKING_RETURN_HELD');
    const revisions = await store.getSettlementRevisions(scope, i.eventId, session),
      latest = verifier.validateRevisions(row, revisions, scope);
    need(latest?.payload.state === 'posted', 'Pending or missing original settlement cannot be returned.', 'BANKING_RETURN_HELD');
    const stored = await store.getLedger(scope, i.accountId, session);
    need(stored && same(persistedScopeOf(stored), scope), 'Original return adopted boundary unavailable.', 'BANKING_RETURN_HELD');
    const ledger = verifyLedger(clone(stored.payload));
    need(stored.kind === 'ledger-account' && stored.eventId === '@ledger:' + i.accountId && stored.revision === 0 && stored.accountId === i.accountId && stored.accountCurrency === i.accountCurrency && ledger.version === 1 && ledger.adoption?.ownerId === String(bound.ownerId) && /^[a-f0-9]{24}$/.test(ledger.adoption?.actorId || '') && Number.isFinite(Date.parse(ledger.adoption?.at)) && Date.parse(ledger.adoption.at) <= Date.parse(i.receivedAt), 'Original explicit ledger adoption is unavailable or later than its instruction.', 'BANKING_RETURN_HELD');
    need(ledger.contentHash === stored.contentHash && same(ledger.scope, scope) && ledger.account.accountId === i.accountId && ledger.account.accountCurrency === i.accountCurrency && ledger.account.accountType === i.accountType && i.bookDate.slice(0, 7) > ledger.throughPeriod && !ledger.events.some(e => e.eventId === i.eventId), 'Original return overlaps or differs from adopted history.', 'BANKING_RETURN_HELD');
    members.push({
      scope,
      eventId: i.eventId,
      accountId: i.accountId,
      accountCurrency: i.accountCurrency,
      accountType: i.accountType,
      amountMinor: i.amountMinor,
      bookDate: i.bookDate,
      postingDate: latest.payload.postingDate,
      state: 'posted',
      pairedEventId: i.pairedEventId,
      settlementGroupId: i.settlementGroupId,
      instructionHash: row.contentHash,
      postedHash: latest.contentHash,
      sourceSignature: i.source.signature,
      settledAt: latest.payload.settledAt,
      baselineHash: ledger.contentHash
    });
  }
  const source = require('./bank-origin-events').freezeReturnSource({
    scope,
    record: proof.record,
    source: p.source,
    members
  });
  return {
    source,
    record: proof.record,
    run
  };
}


async function readCurrentReturnSource({
  models,
  store,
  bound,
  eventId,
  session = null,
  now = () => Date.now(),
  advisory = false
}) {
  need(['Records', 'Agents', 'Receipts', 'Writers', 'Audits', 'Steps', 'Authorities'].every(k => models?.[k]), 'Current return proof stores are unavailable.', 'BANKING_RETURN_HELD');
  const retained = await readPostedReturnSource({
      models,
      store,
      bound,
      eventId,
      session
    }),
    full = advisory ? null : await require('./banking-accountant-tools').createBankingMirrorReader({
      Records: {
        find: (...args) => {
          const q = models.Records.find(...args);
          return session ? q.session(session) : q;
        }
      },
      Agents: {
        findOne: (...args) => {
          const q = models.Agents.findOne(...args);
          return session ? q.session(session) : q;
        }
      },
      now,
      timeoutMs: 0
    })({
      scope: bound.scope,
      phase: 'before'
    });
  need(retained.source.members.every(m => Number.isFinite(Date.parse(m.settledAt)) && Date.parse(m.settledAt) <= now() && m.postingDate <= dayAt(now())), 'Original settlement has not actually occurred yet.', 'BANKING_RETURN_HELD');
  need(advisory || full.complete === true, 'Complete current scoped mirror is required for a return.', 'BANKING_RETURN_HELD');
  const observations = require('./business-observation-store').createBusinessObservationStore({
      ...models,
      session,
      now
    }),
    ids = [[retained.source.source.entity, retained.source.source.id], ...retained.source.members.map(m => ['Account', m.accountId])];
  if (retained.source.source.entity === 'Payment') {
    const r = retained.record;
    need(r.ARAccountRef?.value, 'NSF unavailable: no applicable original AR proof is retained.', 'BANKING_RETURN_HELD');
    ids.push(['Customer', r.CustomerRef.value], ['Account', r.ARAccountRef.value]);
  }
  const current = [];
  for (const [entity, id] of ids) {
    const o = await observations.read(bound.scope, entity, id, {
      transactions: true,
      guard: true
    });
    need(o, 'Current return dependency is unavailable or unsettled.', 'BANKING_RETURN_HELD');
    current.push(o);
  }
  try {
    require('./bank-origin-events').validateReturnCurrent({
      source: retained.source,
      current,
      now: now()
    });
  } catch (error) {
    if (error instanceof TypeError) fail(error.message, 'BANKING_RETURN_HELD');
    throw error;
  }
  return {
    ...retained,
    current,
    currentHash: C.hash(current),
    mirrorHash: full ? C.hash({
      scope: full.scope,
      observedAt: full.observedAt,
      syncedThrough: full.syncedThrough,
      records: full.records.map(r => ({
        entity: r.entity,
        qboId: r.qboId,
        recordHash: C.hash(r.record)
      }))
    }) : null
  };
}

function createDefaultBankOriginService(options = {}) {
  const models = options.models || {
    Records: require('../models/CompanySyncRecord'),
    Agents: require('../models/BusinessAgent')
  };
  const store = options.store || require('./banking-workspace-service').createMongoBankingStore({
    Events: require('../models/BankingEvent'),
    Packages: require('../models/BankingPackage'),
    connection: require('mongoose').connection,
    returnModels:()=>bookModels()
  });
  const now = options.now || (() => Date.now()),
    authorize = options.authorize || ((bound, session, action) => require('./business-runtime-access').createBusinessRuntimeAccess({
      ownerId: bound.ownerId,
      actorId: bound.actorId
    }).authorize(bound.scope, action, {
      session
    }));
  const observations = options.observations || require('./business-observation-store').createBusinessObservationStore({
    ...models,
    now
  });
  const observeMapping = options.observeMapping || async function (bound, mapping, amount, session, {
    income = false
  } = {}) {
    exact(mapping, ['counterpartAccountId', 'taxTreatment', 'taxCodeId', 'netAmountMinor']);
    need(/^\d{1,30}$/.test(mapping.counterpartAccountId || '') && ['out-of-scope', 'taxable'].includes(mapping.taxTreatment), 'Choose the exact counterpart and explicit tax treatment.');
    const observedStore = session && !options.observations ? require('./business-observation-store').createBusinessObservationStore({
      ...models,
      session,
      now
    }) : observations;
    const observed = await observedStore.read(bound.scope, 'Account', mapping.counterpartAccountId),
      record = observed?.record;
    need(record && record.Active === true && (income ? ['Income', 'Other Income'] : ['Expense', 'Other Expense']).includes(record.AccountType), 'A current observed expense counterpart is required.');
    const definition = require('./business-reference').referenceDefinition(bound.scope, 'Account', record);
    let taxProof = null;
    if (mapping.taxTreatment === 'out-of-scope') need(mapping.taxCodeId === undefined && mapping.netAmountMinor === undefined, 'Do not attach tax fields to out-of-scope bank advice.');else {
      need(/^\d{1,30}$/.test(mapping.taxCodeId || '') && Number.isSafeInteger(mapping.netAmountMinor) && mapping.netAmountMinor > 0 && mapping.netAmountMinor <= amount, 'Taxable advice needs the exact code and stated net amount.');
      const tax = await observedStore.read(bound.scope, 'TaxCode', mapping.taxCodeId);
      need(tax?.record?.Active === true, 'A current complete tax code is required.');
      taxProof = C.hash(tax.record);
    }
    return {
      ...clone(mapping),
      requested: clone(mapping),
      definitionHash: definition.hash,
      observedAt: observed.observedAt,
      sourceHash: C.hash(observed.source),
      taxProof
    };
  };
  let fullModels, bookAdapter;
  const bookModels = () => fullModels ||= options.models || {...require('./business-runtime').loadModels(),Agents:models.Agents};
  const getBook = () => bookAdapter ||= createBankBookkeepingAdapter({
    models: bookModels(),
    store,
    now,
    returnProof:(...args)=>returnProof(...args),
    observeMapping,
    copy: {
      read: async (scope, entity, id) => (await observations.read(scope, entity, id, {
        transactions: true,
        guard: true
      }))?.record || null,
      forSession:session=>({read:async(scope,entity,id)=>(await require('./business-observation-store').createBusinessObservationStore({...bookModels(),session,now}).read(scope,entity,id,{transactions:true,guard:true}))?.record||null})
    },
    contextFor: require('./general-write-service').createGeneralWriteContext({
      models: bookModels(),
      now
    }),
    general: bound => options.generalFor?options.generalFor(bound):options.models?fail('An injected composition needs its explicit governed writer.','BANKING_RETURN_HELD'):require('./general-write-service').createDefaultGeneralWrite({
      now,
      access: require('./business-runtime-access').createBusinessRuntimeAccess({
        ownerId: bound.ownerId,
        actorId: bound.actorId
      })
    }),
    snapshot: async (bound, {
      session = null,
      requestHash = null,
      admission = false
    } = {}) => {
      const full = bookModels(),
        scopedModel = (model, method) => ({
          [method]: (...args) => {
            const q = model[method](...args);
            return session ? q.session(session) : q;
          }
        });
      const snapshot = await require('./banking-accountant-tools').createBankingMirrorReader({
        Records: scopedModel(full.Records, 'find'),
        Agents: scopedModel(full.Agents, 'findOne'),
        now,
        timeoutMs: 0
      })({
        scope: bound.scope,
        phase: 'before'
      });
      need(snapshot.complete === true, 'Complete current scoped mirror required.');
      await assertOriginFinancialSnapshot({
        models: full,
        scope: bound.scope,
        snapshot,
        session,
        requestHash,
        admission,
        now
      });
      const all = await store.listBankOriginContext(bound.scope, session);
      need(all.length <= 100000, 'Complete banking event enumeration unavailable.');
      const financial = require('./bank-settlement-engine').buildSettlementEvents({
          scope: bound.scope,
          asOf: dayAt(now()),
          homeCurrency: 'CAD',
          accounts: snapshot.records.filter(r => r.entity === 'Account' && !r.deleted).map(r => r.record),
          mirror: snapshot.records.filter(r => !r.deleted)
        }).events,
        events = new Map(financial.map(e => [e.eventId, e]));
      for (const row of all) {
        if (row.kind === 'revision' && row.eventId.startsWith('bse1_')) {
          need(row.contentHash === C.hash(row.payload), 'Retained financial bank source changed.');
          C.validateEvent(row.payload);
          events.set(row.payload.eventId, row.payload);
        }
        if (row.kind === 'revision' && [ORIGIN,RETURN_ORIGIN].includes(row.payload?.kind)) {
          need(row.contentHash === C.hash(row.payload), 'Retained origin source changed.');
          validateOriginEvent(row.payload.event);
          events.set(row.payload.event.eventId, row.payload.event);
        }
      }
      return {
        ...snapshot,
        records: snapshot.records.filter(r => !r.deleted),
        settlementEvents: [...events.values()]
      };
    }
  });
  const bookkeeping = {
    general: bound => getBook().general(bound),
    prepareDraft: (...args) => getBook().prepareDraft(...args),
    loadRun: (...args) => getBook().loadRun(...args),
    proveSource: (...args) => getBook().proveSource(...args),
    assertAccepted: (...args) => getBook().assertAccepted(...args),
    assertRetained: (...args) => getBook().assertRetained(...args),
    assertSendSafe: (...args) => getBook().assertSendSafe(...args)
  };
  const returnProof=(bound,eventId,session,options={})=>options.current?readCurrentReturnSource({models:bookModels(),store,bound,eventId,session,now,advisory:options.advisory===true}):readPostedReturnSource({models:bookModels(),store,bound,eventId,session});
  const api = createBankOriginService({
    returnProof,
    store,
    authorize,
    observeMapping,
    now,
    bookkeeping,
    fenceAgent: (bound, session) => require('./business-agent-authority').fenceAgentAuthority({
      authority: bound.agentAuthority,
      scope: bound.scope,
      ownerId: bound.ownerId,
      actorId: bound.actorId,
      Agents: models.Agents,
      session
    })
  });
  api.choices = async bound => {
    await authorize(bound, null, 'operations.preview');
    const accountRows = await models.Records.find({
        ...bound.scope,
        entity: 'Account',
        deleted: false,
        'record.Active': true,
        'record.AccountType': {
          $in: ['Expense', 'Other Expense', 'Income', 'Other Income']
        }
      }).limit(501).maxTimeMS(3000).lean(),
      taxRows = await models.Records.find({
        ...bound.scope,
        entity: 'TaxCode',
        deleted: false,
        'record.Active': true
      }).limit(201).maxTimeMS(3000).lean();
    need(accountRows.length <= 500 && taxRows.length <= 200, 'Counterpart choices exceed their complete bound.');
    const accounts = [],
      taxCodes = [];
    for (const row of accountRows) {
      const observed = await observations.read(bound.scope, 'Account', row.qboId);
      if (observed) accounts.push({
        id: row.qboId,
        name: observed.record.Name,
        type: observed.record.AccountType,
        observedAt: observed.observedAt
      });
    }
    for (const row of taxRows) {
      const observed = await observations.read(bound.scope, 'TaxCode', row.qboId);
      if (observed) taxCodes.push({
        id: row.qboId,
        name: observed.record.Name,
        observedAt: observed.observedAt
      });
    }
    return {
      accounts,
      taxCodes,
      qboCalls: 0
    };
  };
  // Internal proof reader; existing routes do not expose raw source records.
  api.readReturnSource = async (bound, eventId, {
    session = null
  } = {}) => {
    await authorize(bound, session, 'periods.read');
    return readPostedReturnSource({
      models: bookModels(),
      store,
      bound,
      eventId,
      session
    });
  };

  api.returnChoices = async (bound, accountId, {
    offset = 0,
    limit = 20
  } = {}) => {
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'Return choices need bounded pagination.', 'BANKING_RETURN_HELD');
    await authorize(bound, null, 'periods.read');
    if (typeof store.listInstructionActivity !== 'function') return {
      day: dayAt(now()),
      items: [],
      total: 0,
      unavailable: true,
      reason: 'Return instruction choices are unavailable.',
      qboCalls: 0
    };
    const data = await store.listInstructionActivity(bound.scope, accountId),
      all = await store.listBankOriginContext(bound.scope),
      out = [],
      seen = new Set();
    need(data.rows.length <= 10000, 'Complete return instruction choices unavailable.', 'BANKING_RETURN_HELD');
    const observedRows = data.rows.filter(r => r.payload.accountId === accountId),
      supported = observedRows.filter(r => ['Transfer', 'Payment'].includes(r.payload.source.entity));
    need(supported.every(r => Number.isFinite(Date.parse(r.payload.receivedAt))), 'Return instruction receipt chronology is unavailable.', 'BANKING_RETURN_HELD');
    supported.sort((a, b) => Date.parse(b.payload.receivedAt) - Date.parse(a.payload.receivedAt) || Buffer.compare(Buffer.from(a._id), Buffer.from(b._id)));
    const candidates = supported.filter(r => {
      const id = require('./bank-origin-events').returnIdentity(bound.scope, r.payload.source);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    seen.clear();
    const choiceHash = C.hash({
      scope: bound.scope,
      accountId,
      rows: candidates.map(r => ({
        id: r._id,
        eventId: r.payload.eventId,
        receivedAt: r.payload.receivedAt,
        hash: r.contentHash
      })),
      claims: all.filter(r => r.payload?.kind === RETURN_CLAIM).map(r => ({
        id: r._id,
        hash: r.contentHash
      })).sort((a, b) => a.id.localeCompare(b.id))
    });
    for (const row of candidates.slice(offset, offset + limit)) {
      const p = row.payload;
      if (!['Transfer', 'Payment'].includes(p.source.entity)) continue;
      let observed,
        reason = null;
      try {
        observed = await returnProof(bound, p.eventId, null, {
          current: true,
          advisory: true
        });
        if (observed.source.source.entity !== 'Transfer') reason = 'NSF unavailable until an applicable original AR route is retained.';
      } catch (error) {
        if (!/^(BANKING_|BUSINESS_)/.test(error.code || '') && !(error instanceof TypeError)) throw error;
        reason = error instanceof TypeError ? 'Original posted source proof is unavailable.' : error.message;
      }
      const id = observed?.source.returnId || require('./bank-origin-events').returnIdentity(bound.scope, p.source);
      if (seen.has(id)) continue;
      seen.add(id);
      const retained = all.find(r => r.eventId === '@origin-return-claim:' + id && r.revision === 1);
      out.push({
        returnId: id,
        eventId: p.eventId,
        accountId: p.accountId,
        kind: p.source.entity === 'Transfer' ? 'transfer-reversal' : 'nsf-return',
        sourceEntity: p.source.entity,
        sourceId: p.source.id,
        bookDate: p.bookDate,
        postingDate: observed?.source.members[0].postingDate || null,
        amountMinor: Math.abs(p.amountMinor),
        accountCurrency: p.accountCurrency,
        accounts: observed?.source.members.map(m => ({
          accountId: m.accountId,
          amountMinor: -m.amountMinor
        })) || [],
        eligible: !reason && !retained,
        reason: retained ? reason ? reason + ' The original return is retained.' : 'This original already has retained return advice; continue it.' : reason,
        status: retained ? reason ? 'held' : returnGroup(all, bound.scope, id).head.payload.state : reason ? 'unavailable' : 'eligible'
      });
    }
    return {
      day: dayAt(now()),
      items: out,
      total: candidates.length,
      observedInstructionCount: observedRows.length,
      supportedInstructionCount: supported.length,
      pageEligibleCount: out.filter(r => r.eligible).length,
      evaluatedCount: out.length,
      choiceHash,
      page: {
        offset,
        limit,
        nextOffset: offset + out.length < candidates.length ? offset + out.length : null
      },
      truncated: offset + out.length < candidates.length,
      qboCalls: 0
    };
  };
  return api;
}
module.exports = {
  returnGroup,projectReturnActivity,
  readCurrentReturnSource,readPostedReturnSource,
  creatorReservations,
  assertBankOriginAdmission,
  assertOriginFinancialSnapshot,
  exactBankLeg,
  createBankBookkeepingAdapter,
  createDefaultBankOriginService,
  createBankOriginService,
  cycleDate,
  policyHistory,
  validateOriginLifecycle,
  projectOriginActivity,
  POLICY,
  ORIGIN
};
