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
  for (const row of rows.filter(r => r.eventId.startsWith('@origin:'))) {
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
  businessActivity
}) {
  scope = scopeOf(scope);
  verifyLedger(ledger);
  for (const policy of policyHistory(rows, scope, ledger.account.accountId)) need(policy.payload.baselineHash === ledger.contentHash && policy.payload.currency === ledger.account.accountCurrency && policy.payload.accountType === ledger.account.accountType, 'Bank-origin adopted baseline changed.');
  const origins = validateOriginLifecycle(rows, scope, ledger.account.accountId),
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
  bookkeeping = null
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
    const preview = await rows({
        scope
      }, accountId),
      policies = policyHistory(preview, scope, accountId),
      first = policies[0]?.payload;
    if (!first) return {
      posted: 0,
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
      posted: 0,
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
        posted: posted + explicit.posted,
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
    return {
      policy: history.at(-1) ? clone(history.at(-1).payload) : null,
      policyRevision: history.at(-1)?.revision || 0,
      advice: all.filter(r => r.payload.kind === 'bank-origin-explicit-advice').filter(r => !all.some(other => other.eventId === r.eventId && other.revision > r.revision)).map(r => ({
        adviceId: r.eventId,
        kind: r.payload.request.kind,
        reference: r.payload.request.reference,
        amountMinor: r.payload.request.amountMinor,
        dueDate: r.payload.dueDate,
        state: r.payload.state,
        eventId: r.payload.eventId || null
      })),
      activity: projectOriginActivity({
        scope,
        ledger,
        rows: all,
        businessActivity
      })
    };
  }
  async function originState(bound, accountId, eventId, session) {
    const all = await rows(bound, accountId, session);
    validateOriginLifecycle(all, bound.scope, accountId);
    const chain = all.filter(r => r.eventId === '@origin:' + eventId).sort((a, b) => a.revision - b.revision);
    need(chain.length >= 2, 'Exact posted bank-origin event required.');
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
  async function markBookkeeping(bound, accountId, eventId, status, reason, runId) {
    return store.transaction(async session => {
      await inside(bound, session);
      const state = await originState(bound, accountId, eventId, session);
      await store.fenceAccount(bound.scope, accountId, state.last.accountCurrency, session);
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
      await store.putEvent(rowFor(bound.scope, accountId, state.last.accountCurrency, state.last.eventId, state.last.revision + 1, payload), session);
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
          version: 1,
          kind: 'bank-origin-booking-claim',
          scope,
          accountId,
          eventId: command.eventId,
          originHash: state.posted.contentHash,
          adviceHash: state.posted.payload.adviceHash,
          policyHash: state.posted.payload.policyHash,
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
        await store.fenceAccount(scope, accountId, state.last.accountCurrency, session);
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
          originHash: payload.originHash
        };
        await store.putEvent(rowFor(scope, accountId, state.last.accountCurrency, '@origin-general:' + expectedRunId + ':bank-origin', 0, reverse, 'reservation'), session);
        return created;
      });
    }
    const p = claim.payload;
    need(claim.contentHash === C.hash(p) && p.ownerId === bound.ownerId && p.originHash === state.posted.contentHash && p.policyHash === state.policy.contentHash && p.draftHash === C.hash(p.draft) && p.mappingHash === C.hash(state.mapping), 'Retained booking claim changed.');
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
      await store.fenceAccount(scope, accountId, state.last.accountCurrency, session);
      const fresh = await originState(bound, accountId, command.eventId, session),
        existing = fresh.all.find(r => r.eventId === claimId && r.revision === 2),
        binding = {
          version: 1,
          kind: 'bank-origin-prepared-run',
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
    const found = await store.findOriginByDecision(bound.scope, run.decisionKey, session),
      ids = [...new Set(found.map(r => r.eventId))];
    need(ids.length === 1, 'No single original bank event owns this General decision.');
    const posted = found.find(r => r.revision === 2),
      accountId = posted?.accountId,
      eventId = posted?.payload?.event?.eventId;
    need(posted && eventId, 'Original posted bank advice unavailable.');
    await inside(bound, session);
    await store.fenceAccount(bound.scope, accountId, posted.accountCurrency, session);
    const state = await originState(bound, accountId, eventId, session),
      claim = state.all.find(r => r.eventId === '@origin-booking:' + eventId && r.revision === 1),
      p = claim?.payload;
    need(p && claim.contentHash === C.hash(p) && p.runId === String(run._id) && p.ref === ref && p.ownerId === String(run.ownerId) && p.decisionKey === run.decisionKey && p.originHash === state.posted.contentHash && p.policyHash === state.policy.contentHash && p.mappingHash === C.hash(state.mapping) && p.contentHash === run.contentHash && p.operationHash === C.hash(run.plan.operations), 'Accepted General run is not the exact claimed bank-origin request.');
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
      originHash: state.posted.contentHash
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
    await store.putEvent(rowFor(bound.scope, accountId, posted.accountCurrency, state.last.eventId, state.last.revision + 1, payload), session);
    return clone(bookkeepingState);
  }
  async function assertAdmission(bound, run, batch, session) {
    need(session?.inTransaction?.() && run && same(persistedScopeOf(run), bound.scope) && String(run.ownerId) === bound.ownerId && String(run.actorId) === bound.actorId && /^bank_origin_/.test(run.decisionKey || ''), 'Exact scoped bank-origin new-send admission is required.');
    const found = await store.findOriginByDecision(bound.scope, run.decisionKey, session),
      ids = [...new Set(found.map(r => r.eventId))];
    need(ids.length === 1, 'A prefix does not authenticate an original bank-origin claim.');
    const posted = found.find(r => r.revision === 2);
    need(posted, 'Original posted bank event unavailable.');
    await inside(bound, session);
    await store.fenceAccount(bound.scope, posted.accountId, posted.accountCurrency, session);
    const state = await originState(bound, posted.accountId, posted.payload.event.eventId, session),
      claim = state.all.find(r => r.eventId === '@origin-booking:' + posted.payload.event.eventId && r.revision === 1),
      prepared = state.all.find(r => r.eventId === claim?.eventId && r.revision === 2),
      p = claim?.payload;
    need(p && prepared && p.runId === String(run._id) && p.ownerId === String(run.ownerId) && p.decisionKey === run.decisionKey && p.originHash === state.posted.contentHash && p.policyHash === state.policy.contentHash && p.mappingHash === C.hash(state.mapping) && p.draftHash === C.hash(p.draft) && p.contentHash === run.contentHash && p.operationHash === C.hash(run.plan.operations) && prepared.payload.claimHash === claim.contentHash && prepared.payload.contentHash === run.contentHash && prepared.payload.operationHash === p.operationHash && batch.items.length === 1 && batch.items[0].ref === p.ref && state.last.payload.bookkeeping.status !== 'booked', 'The original bank-origin claim/prepared request changed before a new send.');
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
function createBankBookkeepingAdapter({
  models,
  store,
  copy,
  contextFor,
  snapshot,
  general,
  observeMapping,
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
  async function prepareGuardedDraft(bound, event, mapping, {
    session = null,
    runId = null,
    requestHash = null,
    admission = false
  } = {}) {
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
    const claimRows = reservations.filter(r => r.kind === 'reservation');
    for (const r of claimRows) need(r.contentHash === C.hash(r.payload), 'Bank creator reservation changed.');
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
function createDefaultBankOriginService(options = {}) {
  const models = options.models || {
    Records: require('../models/CompanySyncRecord'),
    Agents: require('../models/BusinessAgent')
  };
  const store = options.store || require('./banking-workspace-service').createMongoBankingStore({
    Events: require('../models/BankingEvent'),
    Packages: require('../models/BankingPackage'),
    connection: require('mongoose').connection
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
    general: bound => require('./general-write-service').createDefaultGeneralWrite({
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
        if (row.kind === 'revision' && row.payload?.kind === ORIGIN) {
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
  const api = createBankOriginService({
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
  return api;
}
module.exports = {
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
