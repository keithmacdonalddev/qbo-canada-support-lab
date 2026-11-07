'use strict';

const C = require('./bank-settlement-contract'),
  P = require('./bank-statement-package'),
  F = require('./bank-feed-service');
const clone = v => JSON.parse(JSON.stringify(v)),
  same = (a, b) => C.canonical(a) === C.canonical(b),
  HASH = /^[a-f0-9]{64}$/;
const KIND = 'independent-monthly-statement-plan',
  PREFIX = '@monthly-statement:',
  HEALTH = '@monthly-statement-health:';
function fail(message, code = 'BANKING_STATEMENT_HELD') {
  throw Object.assign(new Error(message), {
    code,
    status: 409
  });
}
function need(ok, message, code) {
  if (!ok) fail(message, code);
}
const day = ms => require('./business-agent-cadence').localParts(ms).date;
function nextMonth(m) {
  C.date(m + '-01');
  return m.slice(5) === '12' ? Number(m.slice(0, 4)) + 1 + '-01' : m.slice(0, 5) + String(Number(m.slice(5)) + 1).padStart(2, '0');
}
function previousMonth(m) {
  return m.slice(5) === '01' ? Number(m.slice(0, 4)) - 1 + '-12' : m.slice(0, 5) + String(Number(m.slice(5)) - 1).padStart(2, '0');
}
function scopeOf(r) {
  return C.validateScope({
    ...r,
    connectionId: String(r.connectionId)
  });
}
function row(scope, accountId, currency, eventId, revision, payload) {
  return {
    ...scope,
    _id: C.hash({
      scope,
      eventId,
      revision
    }),
    kind: 'revision',
    eventId,
    revision,
    accountId,
    accountCurrency: currency,
    sourceHash: C.hash(payload),
    contentHash: C.hash(payload),
    payload
  };
}
function validateRegistry(rows, scope, accountId, currency) {
  need(Array.isArray(rows) && rows.length <= 10000, 'Complete monthly statement history unavailable.');
  const groups = new Map(),
    health = new Map();
  groups.health = health;
  for (const r of rows) {
    need(same(scopeOf(r), scope) && r.accountId === accountId && r.accountCurrency === currency && r.kind === 'revision' && r._id === C.hash({
      scope,
      eventId: r.eventId,
      revision: r.revision
    }) && r.contentHash === C.hash(r.payload) && r.sourceHash === r.contentHash, 'Monthly statement lineage changed.');
    if (r.eventId.startsWith(HEALTH)) {
      const h = r.payload;
      need(h.kind === 'monthly-statement-file-health' && r.eventId === HEALTH + h.statementId && HASH.test(h.filesHash || '') && ['verified', 'held'].includes(h.status), 'Monthly file health changed.');
      const chain = health.get(h.statementId) || [];
      chain.push(r);
      health.set(h.statementId, chain);
      continue;
    }
    need(r.eventId.startsWith(PREFIX) && [1, 2].includes(r.revision), 'Unknown monthly statement revision.');
    const p = r.payload;
    need(Array.isArray(p.rows) && p.rows.length <= 10000 && Array.isArray(p.pending) && p.pending.length <= 10000 && Array.isArray(p.files) && p.files.length >= 2 && p.files.length <= 12 && C.sum(p.files.map(f => C.integer(f.byteCount))) <= 20000000, 'Monthly publication exceeds bounded source or artifact limits.');
    const directory = C.hash(scope) + '/' + accountId + '/monthly-statements/' + p.statementId + '/';
    need(new Set(p.files.map(f => f.fileId)).size === p.files.length && new Set(p.files.map(f => f.path)).size === p.files.length && p.files.every(f => ['statement', 'csv', 'manifest'].includes(f.kind) && HASH.test(f.sha256 || '') && typeof f.path === 'string' && f.path.startsWith(directory) && /^[A-Za-z0-9_.-]+$/.test(f.path.slice(directory.length)) && f.fileId === C.hash({
      statementId: p.statementId,
      kind: f.kind,
      name: f.path.slice(directory.length)
    }) && f.byteCount >= 0 && Number.isSafeInteger(f.rowCount) && f.rowCount >= 0) && p.files.filter(f => f.kind === 'statement').length === 1 && p.files.filter(f => f.kind === 'manifest').length === 1, 'Monthly artifact identity crosses its exact scope.');
    need(p.kind === KIND && p.version === 1 && p.accountId === accountId && p.currency === currency && same(p.scope, scope) && r.eventId === PREFIX + p.statementId && p.statementId === C.hash({
      scope,
      accountId,
      currency,
      period: p.period,
      revision: 1
    }), 'Monthly statement identity changed.');
    const g = groups.get(p.statementId) || [];
    g.push(r);
    groups.set(p.statementId, g);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.revision - b.revision);
    need(g.length <= 2 && g[0].revision === 1 && g[0].payload.stage === 'planned', 'Original monthly statement plan unavailable.');
    if (g[1]) need(g[1].revision === 2 && same(g[1].payload, {
      ...g[0].payload,
      stage: 'published',
      previousHash: g[0].contentHash
    }), 'Published monthly statement changed its original plan.');
  }
  for (const [id, h] of health) {
    h.sort((a, b) => a.revision - b.revision);
    const p = groups.get(id)?.[0].payload;
    need(p && h.every((r, i) => r.revision === i + 1 && r.payload.previousHash === (i ? h[i - 1].contentHash : null) && r.payload.filesHash === C.hash(p.files)), 'Monthly file health lineage changed.');
  }
  return groups;
}
function readiness(ledger, groups, today) {
  require('./independent-bank-ledger').verifyLedger(ledger);
  C.date(today);
  const published = [...groups.values()].filter(g => g.length === 2).sort((a, b) => a[0].payload.period.localeCompare(b[0].payload.period)),
    last = published.at(-1)?.[0].payload,
    predecessor = last ? {
      kind: 'independent-monthly',
      id: last.statementId,
      period: last.period,
      closingMinor: last.closingMinor,
      hash: C.hash(last)
    } : {
      kind: 'adopted-baseline',
      id: ledger.ledgerId,
      period: ledger.throughPeriod,
      closingMinor: ledger.balance.balanceMinor,
      hash: ledger.contentHash
    };
  const period = nextMonth(predecessor.period);
  need(ledger.adoption?.ownerId && Number.isFinite(Date.parse(ledger.adoption.at)), 'Explicit bank adoption proof required.');
  const epoch = day(Date.parse(ledger.adoption.at));
  const blockers = [];
  if (!last && epoch !== period + '-01') blockers.push('Independent coverage begins ' + epoch + '; exact coverage from ' + period + '-01 through the adoption boundary is unavailable. Historical gaps cannot be quiet months.');
  for (const g of published) {
    const p = g[0].payload,
      h = groups.health?.get(p.statementId)?.at(-1)?.payload;
    if (h?.status !== 'verified') blockers.push('Published predecessor ' + p.period + ' file health is ' + (h?.status || 'unverified') + '; recover its exact original statement first.');
  }
  return {
    period,
    cutoff: P.endOfMonth(period),
    latestDuePeriod: previousMonth(today.slice(0, 7)),
    nextDueDate: nextMonth(period) + '-01',
    due: period < today.slice(0, 7),
    blockers,
    predecessor,
    epoch
  };
}
function queueProof({
  scope,
  accountId,
  currency,
  period,
  instructions,
  revisions,
  peers = {
    rows: [],
    revisions: []
  }
}) {
  need(Array.isArray(instructions) && instructions.length <= 10000 && Array.isArray(revisions) && revisions.length <= 20000, 'Complete monthly instruction queue unavailable.');
  const V = require('./bank-instruction-settlement'),
    cutoff = P.endOfMonth(period),
    pending = [],
    proof = [];
  for (const r of instructions) {
    const p = V.validateInstruction(r, scope);
    need(p.accountId === accountId && p.accountCurrency === currency, 'Monthly queue crosses its account.');
    const chain = revisions.filter(x => x.eventId === r.eventId),
      latest = V.validateRevisions(r, chain, scope);
    if (day(Date.parse(p.receivedAt)) > cutoff) continue;
    const scheduled = chain.find(x => x.revision === 1);
    need(scheduled, 'Unscheduled bank instruction can still post within the statement month.');
    let due = scheduled.payload.schedule.expectedPostingDate,
      peerHash = null;
    if (p.pairedEventId) {
      const peerRows = peers.rows.filter(x => x.payload?.eventId === p.pairedEventId);
      need(peerRows.length === 1, 'Complete pending transfer peer unavailable.');
      const peer = V.validateInstruction(peerRows[0], scope),
        pc = peers.revisions.filter(x => x.eventId === peerRows[0].eventId),
        pl = V.validateRevisions(peerRows[0], pc, scope),
        ps = pc.find(x => x.revision === 1);
      need(ps && peer.pairedEventId === p.eventId && peer.settlementGroupId === p.settlementGroupId && peer.source.signature === p.source.signature && peer.accountId !== accountId && peer.accountCurrency === currency && peer.amountMinor === -p.amountMinor && Boolean(pl?.payload.state === 'posted') === Boolean(latest?.payload.state === 'posted'), 'Pending transfer peer or schedule changed.');
      due = [due, ps.payload.schedule.expectedPostingDate].sort().at(-1);
      peerHash = C.hash({
        instruction: peerRows[0].contentHash,
        schedule: ps.contentHash
      });
    }
    need(latest?.payload.state === 'posted' || due > cutoff, 'Due bank instruction can still change this completed statement month.');
    proof.push({
      instruction: r.contentHash,
      schedule: scheduled.contentHash,
      peerHash,
      ...(latest?.payload.postingDate <= cutoff ? {
        posted: latest.contentHash
      } : {})
    });
    if (due > cutoff) pending.push({
      eventId: p.eventId,
      accountId,
      currency,
      amountMinor: p.amountMinor,
      bookDate: p.bookDate,
      expectedPostingDate: due,
      instructionHash: r.contentHash,
      scheduleHash: scheduled.contentHash,
      peerHash
    });
  }
  return {
    pending,
    queueHash: C.hash(proof.sort((a, b) => a.instruction.localeCompare(b.instruction)))
  };
}
function freezePlan({
  bound,
  ledger,
  current,
  readiness: r,
  queue,
  deliveryHash,
  overlap = []
}) {
  need(r.due && r.blockers.length === 0, 'Monthly statement opening or coverage is held.');
  const rows = current.rows.filter(x => x.postingDate.slice(0, 7) === r.period),
    openingMinor = r.predecessor.closingMinor,
    closingMinor = C.sum([openingMinor, ...rows.map(x => ledger.account.balanceConvention === 'card-amount-owed' ? -x.amountMinor : x.amountMinor)]),
    financialHash = C.hash(rows.map(x => ({
      id: x.eventId,
      hash: x.financialHash
    }))),
    coverageHash = C.hash({
      baseline: ledger.contentHash,
      predecessor: r.predecessor,
      epoch: r.epoch,
      period: r.period,
      queue: queue.queueHash,
      deliveryHash,
      financialHash,
      pending: queue.pending
    });
  return {
    version: 1,
    kind: KIND,
    stage: 'planned',
    scope: bound.scope,
    ownerId: bound.ownerId,
    originalActorId: bound.actorId,
    accountId: ledger.account.accountId,
    currency: ledger.account.accountCurrency,
    accountName: ledger.account.accountName,
    balanceConvention: ledger.account.balanceConvention,
    period: r.period,
    revision: 1,
    statementId: C.hash({
      scope: bound.scope,
      accountId: ledger.account.accountId,
      currency: ledger.account.accountCurrency,
      period: r.period,
      revision: 1
    }),
    rendererVersion: 2,
    baselineHash: ledger.contentHash,
    predecessor: r.predecessor,
    openingMinor,
    closingMinor,
    openingBasis: 'Exact opening carried from completed ' + r.predecessor.period + ' ' + r.predecessor.kind + '; predecessor ' + r.predecessor.id + '; evidence ' + r.predecessor.hash + '. Historical coverage and native reconciliation remain separate.',
    financialHash,
    coverageHash,
    rows,
    pending: queue.pending,
    overlap,
    previousHash: null
  };
}
function validatedLedger(entry, b, id, nowMs) {
  need(entry && same(scopeOf(entry), b.scope) && entry.accountId === id && entry.kind === 'ledger-account' && entry.eventId === '@ledger:' + id && entry.revision === 0 && entry._id === C.hash({
    scope: b.scope,
    kind: 'ledger-account',
    accountId: id
  }) && entry.sourceHash === entry.contentHash && entry.accountCurrency === entry.payload.account.accountCurrency && entry.contentHash === entry.payload.contentHash, 'Adopted monthly ledger unavailable.');
  const ledger = require('./independent-bank-ledger').verifyLedger(clone(entry.payload));
  need(ledger.account.accountId === id && same(ledger.scope, b.scope) && ledger.adoption?.ownerId === b.ownerId && Number.isFinite(Date.parse(ledger.adoption.at)) && Date.parse(ledger.adoption.at) <= nowMs, 'Monthly adoption owner, scope or chronology changed.');
  return ledger;
}
function createBankMonthlyStatementService({
  store,
  artifacts,
  authorize,
  loadActivity,
  loadDeliveryProof,
  authenticateBaseline,
  authenticateInstructions = null,
  now = () => Date.now(),
  fenceAgent = null
}) {
  need(store && artifacts && authorize && loadActivity && loadDeliveryProof && authenticateBaseline, 'Explicit monthly statement dependencies required.');
  async function inside(b, s) {
    need(s?.inTransaction?.(), 'Monthly publication requires a transaction.');
    await authorize(b, s, 'periods.manage');
    if (b.agentAuthority) {
      need(fenceAgent, 'Current accountant Pause fence required.');
      await fenceAgent(b, s);
    }
  }
  async function state(b, id, s) {
    const ledger = validatedLedger(await store.getLedger(b.scope, id, s), b, id, now());
    const entries = await store.listMonthlyRows(b.scope, id, s),
      groups = validateRegistry(entries, b.scope, id, ledger.account.accountCurrency);
    for (const chain of groups.health.values()) for (const h of chain) need(h.payload.ownerId === b.ownerId && /^[a-f0-9]{24}$/.test(h.payload.actorId || '') && Number.isFinite(Date.parse(h.payload.checkedAt)) && Date.parse(h.payload.checkedAt) <= now(), 'Monthly file-health authority or time changed.');
    const ordered = [...groups.values()].sort((a, b) => a[0].payload.period.localeCompare(b[0].payload.period));
    let previous = {
      period: ledger.throughPeriod,
      closingMinor: ledger.balance.balanceMinor
    };
    for (const g of ordered) {
      const p = g[0].payload;
      need(p.ownerId === b.ownerId && /^[a-f0-9]{24}$/.test(p.originalActorId || '') && p.period === nextMonth(previous.period) && p.openingMinor === previous.closingMinor && p.baselineHash === ledger.contentHash, 'Monthly statements do not form an exact contiguous carry.');
      if (g.length === 2) previous = p;else need(g === ordered.at(-1), 'Unpublished predecessor blocks later statement.');
    }
    return {
      ledger,
      groups,
      readiness: readiness(ledger, groups, day(now()))
    };
  }
  function publicItem(g) {
    const p = g[0].payload;
    return {
      statementId: p.statementId,
      period: p.period,
      revision: 1,
      status: g.length === 2 ? 'published' : 'planned',
      openingMinor: p.openingMinor,
      closingMinor: p.closingMinor,
      rowCount: p.rows.length,
      quiet: p.rows.length === 0,
      pendingCount: p.pending.length,
      openingBasis: p.openingBasis,
      predecessor: p.predecessor,
      coverageHash: p.coverageHash,
      referenceOnly: true,
      nativeStateVerified: false,
      files: g.length === 2 ? p.files : []
    };
  }
  async function list(b, id, input = {}) {
    await authorize(b, null, 'periods.read');
    need(Object.keys(input).every(k => ['offset', 'limit', 'expectedHash'].includes(k)), 'Unsupported statement list filters.');
    const offset = input.offset === undefined ? 0 : input.offset,
      limit = input.limit === undefined ? 20 : input.limit;
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'Bounded monthly statement page required.');
    const s = await state(b, id);
    let checked = false,
      blocks = [...s.readiness.blockers];
    if (s.readiness.due && !blocks.length) {
      try {
        const pending = [...s.groups.values()].find(g => g.length === 1)?.[0].payload,
          fresh = await proof(b, id, null, pending || null);
        if (pending) {
          const {
            files,
            ...body
          } = pending;
          need(same(body, fresh), 'Original planned statement source changed; retain its identity for reviewed recovery.');
        }
        checked = true;
      } catch (e) {
        if (!/^BANKING_/.test(e.code || '')) throw e;
        blocks = [e.message];
      }
    }
    const all = [...s.groups.values()].sort((a, b) => b[0].payload.period.localeCompare(a[0].payload.period)),
      hash = C.hash(all.map(g => g.at(-1).contentHash));
    need((offset === 0 || HASH.test(input.expectedHash || '')) && (input.expectedHash === undefined || input.expectedHash === hash), 'Monthly statements changed; restart from the latest page.', 'BANKING_ACTIVITY_CHANGED');
    return {
      accountId: id,
      currency: s.ledger.account.accountCurrency,
      day: day(now()),
      items: all.slice(offset, offset + limit).map(g => {
        const p = g[0].payload,
          h = s.groups.health.get(p.statementId)?.at(-1)?.payload;
        return {
          ...publicItem(g),
          fileHealth: h?.status || 'unverified',
          checkedAt: h?.checkedAt || null,
          reviewReason: h?.status === 'held' ? h.reason : null
        };
      }),
      total: all.length,
      hash,
      page: {
        offset,
        limit,
        nextOffset: offset + limit < all.length ? offset + limit : null
      },
      readiness: {
        ...s.readiness,
        blockers: blocks,
        coverageVerified: checked,
        status: blocks.length ? 'held' : checked ? 'eligible' : s.readiness.due ? 'needs-check' : 'not-due'
      },
      qboCalls: 0
    };
  }
  async function proof(b, id, session, stored = null, ancestry = {
    checking: new Set(),
    verified: new Set()
  }) {
    const st = await state(b, id, session),
      before = new Map([...st.groups].filter(([, g]) => !stored || g[0].payload.period < stored.period)),
      r = stored ? readiness(st.ledger, Object.assign(before, {
        health: st.groups.health
      }), day(now())) : st.readiness;
    need(r.due && r.blockers.length === 0, r.blockers.join(' ') || 'No complete monthly statement is due.');
    if (r.predecessor.kind === 'independent-monthly') {
      const predecessor = st.groups.get(r.predecessor.id),
        p = predecessor?.[0].payload;
      need(predecessor?.length === 2 && p.period < r.period, 'Published monthly predecessor is unavailable.');
      need(st.groups.health.get(p.statementId)?.at(-1)?.payload.status === 'verified', 'Published predecessor file health is held or unverified.');
      if (!ancestry.verified.has(p.statementId)) {
        need(ancestry.checking.size < 1200 && !ancestry.checking.has(p.statementId), 'Monthly predecessor chain is cyclic or exceeds its proof bound.');
        ancestry.checking.add(p.statementId);
        const original = await proof(b, id, session, p, ancestry),
          {
            files,
            ...frozen
          } = p;
        need(same(original, frozen), 'Published predecessor ' + p.period + ' source changed; its carry and dependent statements are held.');
        ancestry.checking.delete(p.statementId);
        ancestry.verified.add(p.statementId);
      }
    }
    await authenticateBaseline(b, st.ledger, session);
    const loaded = await loadActivity(b, id, session),
      current = F.normalizePosted({
        ...loaded,
        scope: b.scope
      }, day(now())),
      queueRows = await store.listInstructionActivity(b.scope, id, session),
      peerIds = [...new Set(queueRows.rows.map(x => x.payload.pairedEventId).filter(Boolean))],
      peers = peerIds.length ? await store.loadFeedPeers(b.scope, peerIds, session) : {
        rows: [],
        revisions: []
      },
      authenticated = await (need(typeof authenticateInstructions === 'function', 'Original instruction proof adapter unavailable.'), authenticateInstructions(b, st.ledger, {
        ...queueRows,
        peers
      }, r.period, session)),
      queue = queueProof({
        scope: b.scope,
        accountId: id,
        currency: st.ledger.account.accountCurrency,
        period: r.period,
        instructions: queueRows.rows,
        revisions: queueRows.revisions,
        peers
      }),
      deliveryHash = await loadDeliveryProof(b, id, r.period, session),
      feedRows = await store.listFeedRows(b.scope, id, session),
      feeds = F.validateRegistry(feedRows, b.scope, id, current.currency, current),
      overlap = [];
    need(authenticated === true, 'Original monthly instruction proof is incomplete.');
    for (const g of feeds.publications.values()) {
      const p = g[0].payload;
      if (g.length !== 2) continue;
      const ids = p.rows.filter(x => x.postingDate.slice(0, 7) === r.period).map(x => ({
        eventId: x.eventId,
        financialHash: x.financialHash
      }));
      if (ids.length) overlap.push({
        publicationId: p.publicationId,
        publicationHash: g[0].contentHash,
        mode: p.mode,
        rows: ids
      });
    }
    overlap.sort((a, b) => a.publicationId.localeCompare(b.publicationId));
    let frozenOverlap = overlap;
    if (stored) {
      need(Array.isArray(stored.overlap) && stored.overlap.length <= 10000, 'Original overlap-as-of proof is unavailable.');
      for (const reference of stored.overlap) {
        const chain = feeds.publications.get(reference.publicationId),
          publication = chain?.[0].payload,
          rows = publication?.rows.filter(x => x.postingDate.slice(0, 7) === r.period).map(x => ({
            eventId: x.eventId,
            financialHash: x.financialHash
          }));
        need(chain?.length === 2 && HASH.test(reference.publicationHash || '') && chain[0].contentHash === reference.publicationHash && publication.mode === reference.mode && same(rows, reference.rows), 'Original monthly overlap publication or member hashes changed.');
      }
      frozenOverlap = stored.overlap;
    }
    return freezePlan({
      bound: stored ? {
        ...b,
        actorId: stored.originalActorId
      } : b,
      ledger: st.ledger,
      current,
      readiness: r,
      queue,
      deliveryHash,
      overlap: frozenOverlap
    });
  }
  async function health(b, p, status, session, reason = null) {
    const st = await state(b, p.accountId, session),
      chain = st.groups.health.get(p.statementId) || [],
      last = chain.at(-1);
    if (last?.payload.status === status && last.payload.reason === reason) return;
    const payload = {
      kind: 'monthly-statement-file-health',
      ownerId: b.ownerId,
      actorId: b.actorId,
      agentId: b.agentAuthority?.agentId || null,
      statementId: p.statementId,
      filesHash: C.hash(p.files),
      status,
      reason,
      checkedAt: new Date(now()).toISOString(),
      previousHash: last?.contentHash || null
    };
    await store.putEvent(row(b.scope, p.accountId, p.currency, HEALTH + p.statementId, (last?.revision || 0) + 1, payload), session);
  }
  async function issue(b, input) {
    need(input && Object.keys(input).every(k => ['accountId', 'statementId'].includes(k)) && /^\d{1,30}$/.test(input.accountId || '') && (input.statementId === undefined || HASH.test(input.statementId)), 'Exact statement account and optional original identity required.');
    await authorize(b, null, 'periods.manage');
    const peek = await state(b, input.accountId);
    const pending = input.statementId ? peek.groups.get(input.statementId) : [...peek.groups.values()].find(g => g.length === 1);
    if (input.statementId) need(pending, 'Original monthly statement unavailable.');
    if (!pending && (!peek.readiness.due || peek.readiness.blockers.length)) return {
      status: peek.readiness.blockers.length ? 'held' : 'not-due',
      readiness: peek.readiness,
      issued: false,
      qboCalls: 0
    };
    await store.assertReady();
    let selected = await store.transaction(async session => {
      await inside(b, session);
      const st = await state(b, input.accountId, session);
      await store.fenceAccount(b.scope, input.accountId, st.ledger.account.accountCurrency, session);
      const existing = input.statementId ? st.groups.get(input.statementId) : [...st.groups.values()].find(g => g.length === 1);
      if (input.statementId) need(existing, 'Original monthly statement unavailable.');
      if (!existing && (!st.readiness.due || st.readiness.blockers.length)) return {
        held: true,
        readiness: st.readiness
      };
      const fresh = await proof(b, input.accountId, session, existing?.[0].payload);
      const generated = P.generateIndependentBankStatementPackage(fresh),
        files = generated.artifacts.map(({
          bytes,
          ...f
        }) => f),
        payload = {
          ...fresh,
          files
        };
      need(files.length <= 12 && C.sum(files.map(f => f.byteCount)) <= 20000000 && Buffer.byteLength(JSON.stringify(payload)) <= 12000000, 'Monthly publication exceeds its bounded artifact/storage limits.');
      if (existing) {
        need(same(existing[0].payload, payload), 'Original monthly statement source changed; retain its plan for reviewed recovery.');
        return {
          plan: existing[0],
          published: existing.length === 2
        };
      }
      const planned = row(b.scope, input.accountId, payload.currency, PREFIX + payload.statementId, 1, payload);
      await store.putEvent(planned, session);
      return {
        plan: planned,
        published: false
      };
    });
    if (selected.held) return {
      status: selected.readiness.blockers.length ? 'held' : 'not-due',
      readiness: selected.readiness,
      issued: false,
      qboCalls: 0
    };
    const p = selected.plan.payload,
      generated = P.generateIndependentBankStatementPackage(p);
    need(same(generated.artifacts.map(({
      bytes,
      ...f
    }) => f), p.files), 'Original frozen monthly descriptors changed.');
    try {
      if (!selected.published) for (const f of generated.artifacts) await artifacts.write(f);
      return await store.transaction(async session => {
        await inside(b, session);
        await store.fenceAccount(b.scope, p.accountId, p.currency, session);
        const st = await state(b, p.accountId, session),
          g = st.groups.get(p.statementId);
        need(g && g[0].contentHash === selected.plan.contentHash, 'Original monthly plan changed.');
        const fresh = await proof(b, p.accountId, session, p),
          expected = {
            ...fresh,
            files: p.files
          };
        need(same(p, expected), 'Monthly predecessor, coverage, queue or frozen money changed before publication.');
        need(p.files.length <= 12 && C.sum(p.files.map(f => f.byteCount)) <= 20000000, 'Monthly artifacts exceed bounded verification.');
        for (const f of p.files) await artifacts.read(f);
        if (g.length === 1) await store.putEvent(row(b.scope, p.accountId, p.currency, PREFIX + p.statementId, 2, {
          ...p,
          stage: 'published',
          previousHash: selected.plan.contentHash
        }), session);
        await health(b, p, 'verified', session);
        return {
          status: 'published',
          issued: !selected.published,
          reused: selected.published,
          statementId: p.statementId,
          period: p.period,
          revision: 1,
          rowCount: p.rows.length,
          qboCalls: 0
        };
      });
    } catch (e) {
      if (/^(BANKING_|BUSINESS_)/.test(e.code || '')) {
        try {
          await store.transaction(async session => {
            await inside(b, session);
            await store.fenceAccount(b.scope, p.accountId, p.currency, session);
            await health(b, p, 'held', session, e.code);
          });
        } catch {}
      }
      throw e;
    }
  }
  async function download(b, id, statementId, fileId) {
    await authorize(b, null, 'periods.read');
    need(HASH.test(statementId) && HASH.test(fileId), 'Exact statement and file IDs required.');
    const st = await state(b, id),
      g = st.groups.get(statementId);
    need(g?.length === 2, 'Monthly statement is not published.');
    const p = g[0].payload,
      expected = P.generateIndependentBankStatementPackage(p).artifacts.map(({
        bytes,
        ...f
      }) => f);
    need(same(expected, p.files), 'Retained monthly file descriptors changed.');
    const file = p.files.find(f => f.fileId === fileId);
    need(file, 'Retained monthly file unavailable.');
    return {
      file: clone(file),
      bytes: await artifacts.read(file),
      period: g[0].payload.period
    };
  }
  return {
    list,
    issue,
    download
  };
}
function createDefaultBankMonthlyStatementService(options = {}) {
  const models = options.models || (options.store ? null : {
      ...require('./business-runtime').loadModels(),
      Agents: require('../models/BusinessAgent')
    }),
    store = options.store || (options.models ? fail('Injected monthly models require their explicit store.') : require('./banking-workspace-service').createMongoBankingStore({
      Events: require('../models/BankingEvent'),
      Packages: require('../models/BankingPackage'),
      connection: require('mongoose').connection
    })),
    artifacts = options.artifacts || (options.store && !options.directory ? {
      read: async () => fail('Injected monthly artifacts are required.'),
      write: async () => fail('Injected monthly artifacts are required.')
    } : F.createBankFeedArtifactStore(options.directory)),
    now = options.now || (() => Date.now()),
    authorize = options.authorize || ((b, s, action) => {
      need(!options.store && !options.models, 'Injected monthly authorization is required.');
      return require('./business-runtime-access').createBusinessRuntimeAccess({
        ownerId: b.ownerId,
        actorId: b.actorId
      }).authorize(b.scope, action, {
        session: s
      });
    });
  const authenticateBaseline = options.authenticateBaseline || async function (b, l, session) {
    need(l.packages?.length, 'Authenticated predecessor package proof unavailable.');
    const ref = l.packages.at(-1),
      pkg = await store.get(b.scope, ref.id, session);
    need(pkg && same(scopeOf(pkg), b.scope) && pkg.accountId === l.account.accountId && pkg.period === l.throughPeriod && same(pkg.snapshot.scope, b.scope) && pkg.snapshot.accountCurrency === l.account.accountCurrency && pkg.snapshot.balanceConvention === l.account.balanceConvention && pkg.contentHash === ref.contentHash && C.hash(pkg.snapshot) === ref.contentHash && !pkg.state.needsReview && !pkg.state.supersededBy && pkg.snapshot.closingMinor === l.balance.balanceMinor, 'Adopted predecessor package changed.');
    let manifest = null,
      total = 0;
    need(ref.files.length <= 12, 'Predecessor artifacts exceed bounded verification.');
    for (const f of ref.files) {
      const bytes = await artifacts.read(f);
      total += bytes.length;
      need(total <= 20000000, 'Predecessor artifacts exceed bounded verification.');
      if (f.kind === 'manifest') {
        need(!manifest, 'Duplicate predecessor manifest.');
        manifest = JSON.parse(bytes.toString());
      }
    }
    need(manifest, 'Predecessor manifest unavailable.');
    require('./independent-bank-ledger').validateFinancialEvidence(pkg.snapshot, manifest);
  };
  const loadDeliveryProof = options.loadDeliveryProof || async function (b, id, period, session) {
    need(models?.GeneralWriteRuns && models.Receipts, 'Complete accepted bank delivery proof stores unavailable.');
    let q = models.GeneralWriteRuns.find({
      ...b.scope,
      ownerId: b.ownerId,
      bankDelivery: {
        $ne: null
      },
      'bankDelivery.status': {
        $ne: 'complete'
      }
    }).limit(10001).maxTimeMS(5000);
    if (session) q = q.session(session);
    const runs = await q.lean();
    need(runs.length <= 10000, 'Complete accepted bank delivery queue exceeds its bound.');
    const I = require('./bank-instruction-service'),
      financial = require('./bank-settlement-financial'),
      supported = new Set(['Payment', 'SalesReceipt', 'Deposit', 'Invoice', 'RefundReceipt', 'Purchase', 'BillPayment', 'Transfer', 'CreditCardPayment', 'TaxPayment']);
    for (const run of runs) {
      need(same(scopeOf(run), b.scope) && String(run.ownerId) === b.ownerId, 'Accepted bank delivery queue crosses scope.');
      for (const [ref, item] of Object.entries(run.items || {})) {
        if (item.outcome !== 'saved' || item.complete !== true || item.op !== 'create' || run.caseAuthority || !supported.has(item.entity)) continue;
        const original = await I.proveSource({
            models,
            scope: b.scope,
            run,
            ref,
            session
          }),
          r = original.record,
          legs = financial.settlementLegs(item.entity, r);
        if (!legs.some(l => l.accountId === id) || r.TxnDate > P.endOfMonth(period)) continue;
        need(run.bankDelivery.sourceHash === I.acceptedSourceHash(run.items), 'Accepted bank delivery source changed.');
        fail('Accepted bank delivery can still change ' + period + '; recover its original delivery before issuing the statement.');
      }
    }
    return C.hash([]);
  };
  const authenticateInstructions = options.authenticateInstructions || async function (b, l, queue, period, session) {
    need(models?.GeneralWriteRuns && models.Receipts, 'Original monthly instruction proof stores unavailable.');
    const I = require('./bank-instruction-service'),
      S = require('./bank-instruction-settlement'),
      financial = require('./bank-settlement-financial'),
      runs = new Map(),
      checked = new Set();
    async function check(row, ledger, revisions, isPeer = false) {
      const p = S.validateInstruction(row, b.scope),
        label = isPeer ? 'Original peer' : 'Original monthly';
      need(p.accountId === ledger.account.accountId && p.accountCurrency === ledger.account.accountCurrency && p.accountType === ledger.account.accountType, label + ' bank account/type/currency changed.');
      S.validateRevisions(row, revisions, b.scope);
      let run = runs.get(p.source.runId);
      if (!run) {
        let q = models.GeneralWriteRuns.findOne({
          _id: p.source.runId,
          ...b.scope,
          ownerId: b.ownerId
        }).maxTimeMS(3000);
        if (session) q = q.session(session);
        run = await q.lean();
        need(run && same(scopeOf(run), b.scope) && String(run.ownerId) === b.ownerId, label + ' bank instruction run unavailable.');
        runs.set(p.source.runId, run);
      }
      const original = await I.proveSource({
          models,
          scope: b.scope,
          run,
          ref: p.source.ref,
          session
        }),
        legs = financial.bankLegs(financial.settlementLegs(p.source.entity, original.record), p.cashCounterpartAccountId, p.accountId) || [],
        leg = legs.find(x => x.accountId === p.accountId);
      need(original.source.signature === p.source.signature && original.record.Id === p.source.id && original.record.TxnDate === p.bookDate && p.logicalKey === C.hash({
        scope: b.scope,
        runId: p.source.runId,
        ref: p.source.ref,
        accountId: p.accountId
      }) && p.settlementGroupId === (legs.length === 2 ? C.hash({
        scope: b.scope,
        runId: p.source.runId,
        ref: p.source.ref
      }) : null) && leg && financial.nativeAmount(original.record, p.accountCurrency, leg.amount, leg.sign, {
        entity: p.source.entity
      }) === p.amountMinor, label + ' bank amount, route or source changed.');
      if (original.source.receiptId !== p.source.receiptId) {
        const retained = clone(run),
          batches = retained.batches.filter(x => x.index === p.source.batchIndex && x.requestId === p.source.requestId && x.items.some(i => i.ref === p.source.ref));
        need(batches.length === 1, label + ' receipt batch unavailable.');
        batches[0].transport.receiptId = p.source.receiptId;
        retained.batches = batches;
        const first = await I.proveSource({
          models,
          scope: b.scope,
          run: retained,
          ref: p.source.ref,
          session
        });
        need(first.source.signature === p.source.signature, label + ' receipt changed.');
      }
      need(!['Payment', 'SalesReceipt'].includes(p.source.entity) || ![...(original.record.LinkedTxn || []), ...(original.record.Line || []).flatMap(x => x.LinkedTxn || [])].some(x => x.TxnType === 'Deposit'), 'Deposit-contained receipt cannot become a separate monthly bank movement.');
      const pending = revisions.find(x => x.revision === 1);
      if (pending) need(same(pending.payload.schedule, S.scheduleFor(p, original.record)), label + ' bank instruction timing changed.');
      if (p.pairedEventId) {
        const other = legs.find(x => x.accountId !== p.accountId);
        need(legs.length === 2 && other && p.pairedEventId === C.stableEventId(b.scope, p.source.entity, p.source.id, other.accountId), label + ' transfer route changed.');
      }
      return p;
    }
    for (const row of queue.rows) {
      const p = S.validateInstruction(row, b.scope);
      if (day(Date.parse(p.receivedAt)) > P.endOfMonth(period)) continue;
      await check(row, l, queue.revisions.filter(x => x.eventId === row.eventId));
      checked.add(row._id);
      if (p.pairedEventId) {
        const peers = queue.peers?.rows.filter(x => x.payload?.eventId === p.pairedEventId) || [];
        need(peers.length === 1, 'Original peer bank instruction unavailable.');
        const peerRow = peers[0],
          peer = S.validateInstruction(peerRow, b.scope);
        need(peer.pairedEventId === p.eventId && peer.settlementGroupId === p.settlementGroupId && peer.source.signature === p.source.signature && peer.accountId !== p.accountId, 'Original peer reciprocal ownership changed.');
        if (!checked.has(peerRow._id)) {
          const ledger = validatedLedger(await store.getLedger(b.scope, peer.accountId, session), b, peer.accountId, now());
          await check(peerRow, ledger, queue.peers.revisions.filter(x => x.eventId === peerRow.eventId), true);
          checked.add(peerRow._id);
        }
      }
    }
    return true;
  };
  return createBankMonthlyStatementService({
    store,
    artifacts,
    now,
    authorize,
    authenticateBaseline,
    authenticateInstructions,
    loadDeliveryProof,
    loadActivity: options.loadActivity || ((bound, accountId, session) => require('./banking-workspace-service').loadBankFeedActivity({
      store,
      bound,
      accountId,
      session
    })),
    fenceAgent: options.fenceAgent || ((b, session) => {
      need(models?.Agents, 'Injected Agent proof store unavailable.');
      return require('./business-agent-authority').fenceAgentAuthority({
        authority: b.agentAuthority,
        scope: b.scope,
        ownerId: b.ownerId,
        actorId: b.actorId,
        Agents: models.Agents,
        session
      });
    })
  });
}
module.exports = {
  KIND,
  PREFIX,
  nextMonth,
  readiness,
  queueProof,
  freezePlan,
  validateRegistry,
  createBankMonthlyStatementService,
  createDefaultBankMonthlyStatementService
};
