'use strict';

const path = require('node:path'),
  fs = require('node:fs/promises'),
  crypto = require('node:crypto');
const C = require('./bank-settlement-contract'),
  CSV = require('./bank-feed-csv');
const {
  businessDate
} = require('./business-activity-preview');
const clone = v => JSON.parse(JSON.stringify(v)),
  same = (a, b) => C.canonical(a) === C.canonical(b);
const PUBLICATION = 'current-bank-feed-publication-v1',
  ALIAS = 'current-bank-feed-alias-v1',
  ERROR = 'current-bank-feed-error-v1',
  HEALTH = 'current-bank-feed-health-v1';
function fail(message, code = 'BANKING_FEED_INVALID') {
  throw Object.assign(new Error(message), {
    status: 409,
    code
  });
}
function need(ok, message, code) {
  if (!ok) fail(message, code);
}
function exact(value, keys) {
  need(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(k => keys.includes(k)), 'Use the exact current-feed command.');
}
function persistedScope(row) {
  const id = row?.connectionId;
  need(typeof id === 'string' || id instanceof require('mongoose').Types.ObjectId, 'Exact persisted feed scope required.');
  return C.validateScope({
    ...row,
    connectionId: typeof id === 'string' ? id : id.toHexString()
  });
}
const digest = v => C.hash(v),
  day = now => businessDate(new Date(now));
function eventRow(scope, accountId, currency, eventId, revision, payload) {
  return {
    ...scope,
    _id: digest({
      scope,
      eventId,
      revision
    }),
    eventId,
    revision,
    kind: 'revision',
    accountId,
    accountCurrency: currency,
    sourceHash: digest(payload),
    contentHash: digest(payload),
    payload
  };
}
function normalizePosted({
  scope,
  ledger,
  activity,
  pairedProofs = {}
}, today) {
  scope = C.validateScope(scope);
  require('./independent-bank-ledger').verifyLedger(ledger);
  need(same(scope, ledger.scope) && activity && Array.isArray(activity.events) && activity.events.length <= 10000 && activity.baselineHash === ledger.contentHash, 'Complete validated bank activity is required.', 'BANKING_FEED_INCOMPLETE');
  need(ledger.adoption?.at && Number.isFinite(Date.parse(ledger.adoption.at)), 'The retained real bank adoption date is required.');
  const epoch = day(ledger.adoption.at);
  C.date(epoch);
  const baseline = new Set(ledger.events.map(e => e.eventId)),
    seen = new Set(),
    rows = [];
  for (const event of activity.events) {
    need(!seen.has(event.eventId), 'Duplicate economic bank identity.');
    seen.add(event.eventId);
    if (event.state !== 'posted' || event.disposition === 'excluded') continue;
    need(!baseline.has(event.eventId) && same(C.validateScope(event.scope), scope) && event.accountId === ledger.account.accountId && event.accountCurrency === ledger.account.accountCurrency, 'Posted bank source crosses its adopted account or scope.');
    C.date(event.postingDate);
    need(event.postingDate >= epoch && event.postingDate <= today, 'Posted feed activity is outside its real adoption/cutoff date.');
    need(Number.isSafeInteger(event.amountMinor) && event.amountMinor !== 0 && event.stateHistory?.at(-1)?.state === 'posted', 'Exact posted native movement and history required.');
    need(!event.pairedEventId || /^[a-f0-9]{64}$/.test(pairedProofs[event.eventId] || ''), 'The reciprocal posted bank leg is not proved.', 'BANKING_FEED_PAIR_HELD');
    const origin = event.source?.entity === 'BankOrigin',
      proof = origin ? event.originHash : digest(event),
      revision = origin ? 2 : event.revision;
    need(/^[a-f0-9]{64}$/.test(proof || '') && Number.isSafeInteger(revision) && revision > 0, 'Retained financial posting proof is missing.');
    const financial = {
        scope,
        eventId: event.eventId,
        eventRevision: revision,
        accountId: event.accountId,
        accountCurrency: event.accountCurrency,
        amountMinor: event.amountMinor,
        postingDate: event.postingDate,
        postingProofHash: proof,
        ...(event.pairedEventId ? {
          pairProofHash: pairedProofs[event.eventId]
        } : {})
      },
      financialHash = digest(financial);
    rows.push({
      ...financial,
      financialHash,
      kind: 'bank-posted-feed-row',
      state: 'posted',
      actualPostingDate: event.postingDate,
      description: CSV.description(event).replace(/(?:\s*-)+\s*$/, '').trim(),
      source: {
        entity: event.source.entity,
        id: String(event.source.id)
      },
      investigationRequired: event.status === 'unresolved',
      pairedEventId: event.pairedEventId || null,
      settlementGroupId: event.settlementGroupId || null
    });
  }
  rows.sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.eventId.localeCompare(b.eventId));
  return {
    scope,
    accountId: ledger.account.accountId,
    currency: ledger.account.accountCurrency,
    epoch,
    baselineHash: ledger.contentHash,
    baselineThroughPeriod: ledger.throughPeriod,
    rows,
    coverage: 'Only independently retained posted activity after adoption is represented. Missing historical months and complete current bank/book balance are not established.'
  };
}
function validateRegistry(rows, scope, accountId, currency, current) {
  need(Array.isArray(rows) && rows.length <= 50000, 'Complete feed registry exceeds its bound.', 'BANKING_FEED_INCOMPLETE');
  const publications = new Map(),
    aliases = new Map(),
    errors = [],
    health = new Map(),
    firstSignatures = new Map();
  for (const row of rows) {
    need(same(persistedScope(row), scope) && row.accountId === accountId && row.accountCurrency === currency && row.kind === 'revision' && row._id === digest({
      scope,
      eventId: row.eventId,
      revision: row.revision
    }) && row.contentHash === digest(row.payload) && row.sourceHash === row.contentHash, 'Retained current-feed registry changed.');
    const p = row.payload;
    need(same(p.scope, scope) && p.accountId === accountId && p.currency === currency, 'Feed registry payload scope changed.');
    if (p.kind === PUBLICATION) {
      need(row.eventId === '@feed-publication:' + p.publicationId && [1, 2].includes(row.revision), 'Unsupported feed publication lineage.');
      if (!publications.has(p.publicationId)) publications.set(p.publicationId, []);
      publications.get(p.publicationId).push(row);
    } else if (p.kind === ALIAS) {
      need(row.revision === 1 && row.eventId === '@feed-alias:' + accountId + ':' + p.eventId && !aliases.has(p.eventId), 'First bank-event export assignment is not unique.');
      aliases.set(p.eventId, row);
    } else if (p.kind === HEALTH) {
      need(row.eventId === '@feed-health:' + p.publicationId && row.revision >= 1, 'Unknown file-health identity.');
      if (!health.has(p.publicationId)) health.set(p.publicationId, []);
      health.get(p.publicationId).push(row);
    } else {
      need(p.kind === ERROR && row.revision === 1 && row.eventId === '@feed-error:' + p.publicationId + ':' + digest(p.code), 'Unknown current-feed registry record.');
      errors.push(row);
    }
  }
  for (const [id, chain] of publications) {
    chain.sort((a, b) => a.revision - b.revision);
    need(chain.length <= 2 && chain[0].revision === 1 && chain[0].payload.stage === 'planned' && chain[0].payload.previousHash === null, 'First feed publication plan is unavailable.');
    if (chain[1]) {
      const expected = {
        ...clone(chain[0].payload),
        stage: 'published',
        previousHash: chain[0].contentHash
      };
      need(chain[1].revision === 2 && same(chain[1].payload, expected), 'Published feed changed its immutable plan.');
    }
    const p = chain[0].payload;
    need(['incremental', 'cumulative'].includes(p.mode) && Number.isSafeInteger(p.revision) && p.revision > 0 && Number.isSafeInteger(p.sequence) && p.sequence > 0 && new Date(p.createdAt).toISOString() === p.createdAt && p.publicationId === digest({
      scope,
      accountId,
      mode: p.mode,
      windowKey: p.windowKey,
      revision: p.revision
    }) && p.financialHash === digest(p.rows.map(r => ({
      eventId: r.eventId,
      financialHash: r.financialHash
    }))) && p.rows.length > 0 && p.rows.length <= 10000, 'Frozen publication identity changed.');
    for (const frozen of p.rows) {
      const financial = {
        scope: frozen.scope,
        eventId: frozen.eventId,
        eventRevision: frozen.eventRevision,
        accountId: frozen.accountId,
        accountCurrency: frozen.accountCurrency,
        amountMinor: frozen.amountMinor,
        postingDate: frozen.postingDate,
        postingProofHash: frozen.postingProofHash,
        ...(frozen.pairProofHash ? {
          pairProofHash: frozen.pairProofHash
        } : {})
      };
      need(same(frozen.scope, scope) && frozen.accountId === accountId && frozen.accountCurrency === currency && frozen.financialHash === digest(financial) && frozen.postingDate >= p.window.fromDate && frozen.postingDate <= p.window.throughDate, 'Frozen feed row differs from its original financial signature.');
      const first = firstSignatures.get(frozen.eventId);
      need(!first || first.financialHash === frozen.financialHash, 'An exported bank event acquired another financial signature.', 'BANKING_FEED_SOURCE_CHANGED');
      if (!first) firstSignatures.set(frozen.eventId, {
        financialHash: frozen.financialHash,
        publicationId: id
      });
    }
    if (p.mode === 'incremental') for (const row of p.rows) {
      const alias = aliases.get(row.eventId)?.payload;
      need(alias && alias.financialHash === row.financialHash && alias.publicationId === id, 'Incremental publication lost its first economic assignment.');
    }
  }
  const byEvent = new Map(current.rows.map(r => [r.eventId, r]));
  for (const [eventId, first] of firstSignatures) {
    const live = byEvent.get(eventId);
    need(live && live.financialHash === first.financialHash, 'A previously exported bank movement changed or disappeared; retain its first publication.', 'BANKING_FEED_SOURCE_CHANGED');
  }
  for (const [id, chain] of health) {
    chain.sort((a, b) => a.revision - b.revision);
    const publication = publications.get(id)?.[0]?.payload;
    need(publication, 'File health has no retained publication.');
    for (const [i, row] of chain.entries()) need(row.revision === i + 1 && row.payload.previousHash === (i ? chain[i - 1].contentHash : null) && ['verified', 'held'].includes(row.payload.status) && row.payload.filesHash === digest(publication.files), 'File-health lineage changed.');
  }
  for (const aliasRow of aliases.values()) {
    const p = aliasRow.payload,
      source = byEvent.get(p.eventId);
    need(source && source.financialHash === p.financialHash, 'An assigned bank movement changed or disappeared; retain its original export for review.', 'BANKING_FEED_SOURCE_CHANGED');
    const pub = publications.get(p.publicationId)?.[0]?.payload;
    need(pub?.mode === 'incremental' && pub.rows.some(r => r.eventId === p.eventId && r.financialHash === p.financialHash), 'Original incremental assignment cannot be released or reassigned.');
  }
  return {
    publications,
    aliases,
    errors,
    health,
    firstSignatures,
    records: rows,
    registryHash: digest(rows.map(r => ({
      id: r._id,
      hash: r.contentHash
    })).sort((a, b) => a.id.localeCompare(b.id)))
  };
}
function renderPublication(p) {
  const csv = CSV.generatePostedBankFeedCsv(p.rows, {
      scope: p.scope,
      accountId: p.accountId,
      accountCurrency: p.currency
    }),
    directory = digest(p.scope) + '/' + p.accountId + '/current-feeds/' + p.publicationId,
    artifacts = [];
  const add = (kind, name, bytes, rowCount) => {
    const value = {
      fileId: digest({
        publicationId: p.publicationId,
        kind,
        name
      }),
      kind,
      path: directory + '/' + name,
      sha256: CSV.sha256(bytes),
      rowCount,
      byteCount: bytes.length
    };
    artifacts.push({
      ...value,
      bytes
    });
    return value;
  };
  const rowMap = new Map(p.rows.map(row => [row.eventId, row])),
    crosswalk = [];
  for (const part of csv.files) {
    const file = add('csv', part.fileName, part.bytes, part.rowCount);
    for (const row of part.rows) {
      const original = rowMap.get(row.eventId);
      crosswalk.push({
        ...row,
        fileId: file.fileId,
        financialHash: original.financialHash,
        postingProofHash: original.postingProofHash,
        investigationRequired: original.investigationRequired,
        source: clone(original.source)
      });
    }
  }
  const manifest = {
    version: 1,
    kind: 'independent-current-bank-feed',
    scope: p.scope,
    publicationId: p.publicationId,
    revision: p.revision,
    previousPublicationId: p.previousPublicationId,
    accountId: p.accountId,
    accountCurrency: p.currency,
    mode: p.mode,
    epoch: p.epoch,
    window: clone(p.window),
    createdAt: p.createdAt,
    financialHash: p.financialHash,
    profile: csv.profile,
    baselineHash: p.baselineHash,
    baselineThroughPeriod: p.baselineThroughPeriod,
    coverage: p.coverage,
    overlapAsOfPublication: clone(p.overlapAsOfPublication),
    warning: p.mode === 'cumulative' ? 'Reference download: overlaps prior exports and is not the next incremental import file.' : 'Incremental publication: each economic event is assigned once. Download does not prove QBO import, review or reconciliation.',
    nativeStateVerified: false,
    rows: crosswalk,
    files: artifacts.map(({
      bytes,
      ...file
    }) => file)
  };
  add('manifest', 'manifest.json', Buffer.from(C.canonical(manifest) + '\n', 'utf8'), p.rows.length);
  return artifacts;
}
function overlapView(value) {
  return {
    asOf: value.asOf,
    registryHash: value.registryHash,
    count: value.count,
    publicationIds: value.publicationIds.slice(0, 20),
    publicationCount: value.publicationIds.length,
    truncated: value.publicationIds.length > 20
  };
}
function publicationOverlap(publications, rows, excludeId = null) {
  const selected = new Set(rows.map(r => r.eventId)),
    overlapped = new Set(),
    ids = [];
  for (const [id, chain] of publications) {
    if (id === excludeId || chain.length !== 2) continue;
    let found = false;
    for (const row of chain[0].payload.rows) if (selected.has(row.eventId)) {
      overlapped.add(row.eventId);
      found = true;
    }
    if (found) ids.push(id);
  }
  return {
    count: overlapped.size,
    publicationIds: ids.sort()
  };
}
function publicPublication(chain, registry, asOf) {
  const p = chain[0].payload,
    last = chain.at(-1),
    overlap = publicationOverlap(registry.publications, p.rows, p.publicationId),
    history = registry.health.get(p.publicationId) || [],
    health = history.at(-1)?.payload,
    status = health?.status || 'unchecked';
  return {
    publicationId: p.publicationId,
    mode: p.mode,
    revision: p.revision,
    previousPublicationId: p.previousPublicationId,
    window: clone(p.window),
    createdAt: p.createdAt,
    status: last.revision === 2 ? 'published' : 'planned',
    fileHealth: {
      status,
      checkedAt: health?.checkedAt || null,
      issueCode: health?.code || null
    },
    rowCount: p.rows.length,
    nativeMovementMinor: C.sum(p.rows.map(r => r.amountMinor)),
    financialHash: p.financialHash,
    overlapAsOfPublication: overlapView(p.overlapAsOfPublication),
    currentOverlap: overlapView({
      asOf,
      registryHash: registry.registryHash,
      ...overlap
    }),
    warning: p.mode === 'cumulative' ? 'Reference download; not the next incremental import file.' : 'Incremental; each economic event is assigned once.',
    files: last.revision === 2 && status === 'verified' ? clone(p.files) : [],
    retainedFileCount: p.files.length,
    lastError: status === 'held' ? health.code : null,
    priorIssueCount: registry.errors.filter(r => r.payload.publicationId === p.publicationId).length
  };
}
function createBankFeedArtifactStore(directory = path.resolve(__dirname, '../../../artifacts/banking')) {
  const reader = () => require('./banking-workspace-service').createArtifactReader(directory);
  async function parent(relative) {
    need(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes(':') && !relative.split('/').some(v => !v || v === '.' || v === '..'), 'Server-owned feed artifact path required.');
    await fs.mkdir(directory, {
      recursive: true
    });
    const base = await fs.realpath(directory);
    let current = base;
    for (const part of relative.split('/').slice(0, -1)) {
      const next = path.join(current, part);
      try {
        await fs.mkdir(next);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const stat = await fs.lstat(next);
      need(stat.isDirectory() && !stat.isSymbolicLink(), 'Feed storage parent must be a real directory.');
      current = await fs.realpath(next);
      need(current.startsWith(base + path.sep), 'Feed artifact escaped its storage root.');
    }
    return {
      current,
      target: path.join(current, relative.split('/').at(-1))
    };
  }
  return {
    async write(artifact) {
      need(artifact.bytes?.length === artifact.byteCount && CSV.sha256(artifact.bytes) === artifact.sha256, 'Frozen feed bytes changed before publication.');
      const {
          current,
          target
        } = await parent(artifact.path),
        temporary = path.join(current, '.feed-' + crypto.randomUUID() + '.tmp');
      let opened;
      try {
        opened = await fs.open(temporary, 'wx');
        await opened.writeFile(artifact.bytes);
        await opened.sync();
        await opened.close();
        opened = null;
        try {
          await fs.link(temporary, target);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        const stat = await fs.lstat(target);
        need(stat.isFile() && !stat.isSymbolicLink(), 'Feed artifact target is not a retained regular file.');
        await reader()({
          path: artifact.path,
          sha256: artifact.sha256
        });
      } finally {
        if (opened) await opened.close();
        await fs.unlink(temporary).catch(e => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
    },
    read: artifact => reader()({
      path: artifact.path,
      sha256: artifact.sha256
    })
  };
}
function createBankFeedService({
  store,
  loadActivity,
  authorize,
  artifacts,
  now = () => Date.now(),
  fenceAgent = null
}) {
  need(store && typeof loadActivity === 'function' && typeof authorize === 'function' && artifacts, 'Concrete current-feed dependencies required.');
  async function inside(bound, session) {
    need(session?.inTransaction?.(), 'Feed publication requires a transaction.');
    await authorize(bound, session, 'periods.manage');
    if (bound.agentAuthority) {
      need(fenceAgent, 'Current autonomous feed authority requires a Pause fence.');
      await fenceAgent(bound, session);
    }
  }
  async function source(bound, accountId, session) {
    const loaded = await loadActivity(bound, accountId, session);
    return normalizePosted({
      ...loaded,
      scope: bound.scope
    }, day(now()));
  }
  async function state(bound, accountId, session) {
    const current = await source(bound, accountId, session),
      rows = await store.listFeedRows(bound.scope, accountId, session);
    return {
      current,
      registry: validateRegistry(rows, bound.scope, accountId, current.currency, current)
    };
  }
  function command(bound, input, cumulative) {
    exact(input, cumulative ? ['accountId', 'fromDate', 'throughDate'] : ['accountId']);
    bound = {
      ...bound,
      scope: C.validateScope(bound.scope)
    };
    need(/^\d{1,30}$/.test(input.accountId || ''), 'Exact adopted bank account required.');
    if (cumulative) {
      C.date(input.fromDate);
      C.date(input.throughDate);
      need(input.fromDate <= input.throughDate && input.throughDate <= day(now()), 'Cumulative feed window must end on or before the real banking date.');
    }
    return bound;
  }
  async function prepare(bound, input, cumulative) {
    return store.transaction(async session => {
      await inside(bound, session);
      const loaded = await loadActivity(bound, input.accountId, session);
      need(loaded.ledger, 'Adopt a bank baseline before publishing current files.');
      await store.fenceAccount(bound.scope, input.accountId, loaded.ledger.account.accountCurrency, session);
      const {
          current,
          registry
        } = await state(bound, input.accountId, session),
        mode = cumulative ? 'cumulative' : 'incremental';
      need(!cumulative || input.fromDate >= current.epoch, 'Cumulative files cannot invent pre-adoption bank history.');
      const own = [...registry.publications.values()].filter(chain => chain[0].payload.mode === mode).sort((a, b) => b[0].payload.sequence - a[0].payload.sequence || b[0].payload.revision - a[0].payload.revision);
      const unfinished = own.filter(chain => chain.length === 1);
      if (unfinished.length) {
        need(unfinished.length === 1, 'Multiple unfinished feed publications require inspection.');
        need(!cumulative || same(unfinished[0][0].payload.window, {
          fromDate: input.fromDate,
          throughDate: input.throughDate
        }), 'Recover the original cumulative window before requesting another.');
        return {
          row: unfinished[0][0],
          reused: true
        };
      }
      let selected = cumulative ? current.rows.filter(r => r.postingDate >= input.fromDate && r.postingDate <= input.throughDate) : current.rows.filter(r => !registry.aliases.has(r.eventId)).slice(0, 999);
      if (!selected.length) return {
        row: cumulative ? null : own[0]?.[0] || null,
        reused: true,
        empty: true
      };
      const window = cumulative ? {
          fromDate: input.fromDate,
          throughDate: input.throughDate
        } : {
          fromDate: selected[0].postingDate,
          throughDate: selected.at(-1).postingDate
        },
        windowKey = cumulative ? digest(window) : 'incremental-' + String((own[0]?.[0].payload.sequence || 0) + 1),
        family = cumulative ? own.filter(chain => chain[0].payload.windowKey === windowKey).sort((a, b) => b[0].payload.revision - a[0].payload.revision) : [],
        financialHash = digest(selected.map(r => ({
          eventId: r.eventId,
          financialHash: r.financialHash
        })));
      if (family[0]?.[0].payload.financialHash === financialHash) return {
        row: family[0][0],
        reused: true
      };
      const revision = (family[0]?.[0].payload.revision || 0) + 1,
        sequence = (own[0]?.[0].payload.sequence || 0) + 1,
        publicationId = digest({
          scope: bound.scope,
          accountId: input.accountId,
          mode,
          windowKey,
          revision
        }),
        overlaps = publicationOverlap(registry.publications, selected),
        createdAt = new Date(now()).toISOString(),
        payload = {
          version: 1,
          kind: PUBLICATION,
          scope: bound.scope,
          accountId: input.accountId,
          currency: current.currency,
          mode,
          windowKey,
          window,
          revision,
          sequence,
          publicationId,
          previousPublicationId: cumulative ? family[0]?.[0].payload.publicationId || null : own[0]?.[0].payload.publicationId || null,
          createdAt,
          epoch: current.epoch,
          baselineHash: current.baselineHash,
          baselineThroughPeriod: current.baselineThroughPeriod,
          coverage: current.coverage,
          financialHash,
          rows: clone(selected),
          overlapAsOfPublication: {
            asOf: createdAt,
            registryHash: registry.registryHash,
            count: overlaps.count,
            publicationIds: overlaps.publicationIds
          },
          stage: 'planned',
          previousHash: null
        };
      payload.files = renderPublication(payload).map(({
        bytes,
        ...file
      }) => file);
      const row = eventRow(bound.scope, input.accountId, current.currency, '@feed-publication:' + publicationId, 1, payload);
      await store.putEvent(row, session);
      if (!cumulative) for (const movement of selected) {
        const alias = {
          version: 1,
          kind: ALIAS,
          scope: bound.scope,
          accountId: input.accountId,
          currency: current.currency,
          eventId: movement.eventId,
          financialHash: movement.financialHash,
          publicationId
        };
        await store.putEvent(eventRow(bound.scope, input.accountId, current.currency, '@feed-alias:' + input.accountId + ':' + movement.eventId, 1, alias), session);
      }
      return {
        row,
        reused: false
      };
    });
  }
  async function writeHealth(bound, p, session, status, code = null) {
    const all = await store.listFeedRows(bound.scope, p.accountId, session),
      id = '@feed-health:' + p.publicationId,
      chain = all.filter(row => row.eventId === id).sort((a, b) => a.revision - b.revision);
    for (const [i, row] of chain.entries()) need(row.kind === 'revision' && row.revision === i + 1 && row.contentHash === digest(row.payload) && row.payload.previousHash === (i ? chain[i - 1].contentHash : null) && row.payload.filesHash === digest(p.files), 'Retained file-health proof changed.');
    const previous = chain.at(-1);
    if (previous?.payload.status === status && previous.payload.code === code) return previous;
    const payload = {
        version: 1,
        kind: HEALTH,
        scope: bound.scope,
        accountId: p.accountId,
        currency: p.currency,
        publicationId: p.publicationId,
        status,
        code,
        checkedAt: new Date(now()).toISOString(),
        filesHash: digest(p.files),
        previousHash: previous?.contentHash || null
      },
      row = eventRow(bound.scope, p.accountId, p.currency, id, (previous?.revision || 0) + 1, payload);
    await store.putEvent(row, session);
    return row;
  }
  async function holdFiles(bound, p, error) {
    const code = /^BANKING_[A-Z_]+$/.test(error.code || '') ? error.code : 'BANKING_FEED_STORAGE_HELD';
    try {
      await store.transaction(async session => {
        await inside(bound, session);
        await store.fenceAccount(bound.scope, p.accountId, p.currency, session);
        const all = await store.listFeedRows(bound.scope, p.accountId, session),
          id = '@feed-error:' + p.publicationId + ':' + digest(code);
        if (!all.some(r => r.eventId === id)) {
          const payload = {
            version: 1,
            kind: ERROR,
            scope: bound.scope,
            accountId: p.accountId,
            currency: p.currency,
            publicationId: p.publicationId,
            code,
            at: new Date(now()).toISOString()
          };
          await store.putEvent(eventRow(bound.scope, p.accountId, p.currency, id, 1, payload), session);
        }
        await writeHealth(bound, p, session, 'held', code);
      });
    } catch {/* Revoked authority cannot publish a health transition. */}
    fail('Current feed storage is held. Retry only the retained publication.', code);
  }
  async function publish(bound, input, cumulative = false) {
    bound = command(bound, input, cumulative);
    await authorize(bound, null, 'periods.manage');
    await store.assertReady();
    if (!cumulative) {
      const peek = await store.transaction(session => state(bound, input.accountId, session));
      if (!peek.current.rows.length && !peek.registry.publications.size) return {
        status: 'no-posted-activity',
        published: false,
        reused: true,
        qboCalls: 0
      };
    }
    const prepared = await prepare(bound, input, cumulative);
    if (!prepared.row) return {
      status: 'no-posted-activity',
      published: false,
      reused: true,
      qboCalls: 0
    };
    return finishPublication(bound, prepared);
  }
  async function finishPublication(bound, prepared) {
    const p = prepared.row.payload,
      bytes = renderPublication(p);
    need(same(bytes.map(({
      bytes,
      ...file
    }) => file), p.files), 'Frozen feed artifact descriptors changed.');
    try {
      for (const artifact of bytes) await artifacts.write(artifact);
      for (const artifact of bytes) await artifacts.read(artifact);
    } catch (error) {
      return holdFiles(bound, p, error);
    }
    try {
      return await store.transaction(async session => {
        await inside(bound, session);
        await store.fenceAccount(bound.scope, p.accountId, p.currency, session);
        const {
            current,
            registry
          } = await state(bound, p.accountId, session),
          chain = registry.publications.get(p.publicationId);
        need(chain && same(chain[0].payload, p), 'Original feed publication plan changed.');
        const byId = new Map(current.rows.map(r => [r.eventId, r]));
        need(p.rows.every(r => byId.get(r.eventId)?.financialHash === r.financialHash), 'Frozen feed source changed before publication.', 'BANKING_FEED_SOURCE_CHANGED');
        need(p.files.length <= 12 && C.sum(p.files.map(file => file.byteCount)) <= 20000000, 'Final file verification exceeds its bounded publication size.', 'BANKING_FEED_INCOMPLETE');
        try {
          for (const file of p.files) await artifacts.read(file);
        } catch (error) {
          error.bankFeedFileFailure = true;
          throw error;
        }
        if (chain.length === 1) {
          const complete = {
              ...clone(p),
              stage: 'published',
              previousHash: chain[0].contentHash
            },
            row = eventRow(bound.scope, p.accountId, p.currency, chain[0].eventId, 2, complete);
          await store.putEvent(row, session);
          chain.push(row);
          registry.registryHash = digest([...registry.records, row].map(r => ({
            id: r._id,
            hash: r.contentHash
          })).sort((a, b) => a.id.localeCompare(b.id)));
        }
        await writeHealth(bound, p, session, 'verified');
        const verified = await state(bound, p.accountId, session);
        return {
          ...publicPublication(verified.registry.publications.get(p.publicationId), verified.registry, new Date(now()).toISOString()),
          published: true,
          reused: prepared.reused,
          qboCalls: 0
        };
      });
    } catch (error) {
      if (error.bankFeedFileFailure) return holdFiles(bound, p, error);
      throw error;
    }
  }
  async function recoverPublication(bound, input) {
    exact(input, ['accountId', 'publicationId']);
    need(/^[a-f0-9]{64}$/.test(input.publicationId || ''), 'Exact retained publication identity required.');
    bound = command(bound, {
      accountId: input.accountId
    }, false);
    await authorize(bound, null, 'periods.manage');
    await store.assertReady();
    const prepared = await store.transaction(async session => {
      await inside(bound, session);
      const loaded = await loadActivity(bound, input.accountId, session);
      need(loaded.ledger, 'Adopted bank ledger unavailable.');
      await store.fenceAccount(bound.scope, input.accountId, loaded.ledger.account.accountCurrency, session);
      const {
          registry
        } = await state(bound, input.accountId, session),
        chain = registry.publications.get(input.publicationId);
      need(chain, 'Original feed publication is unavailable in this account.', 'BANKING_FEED_NOT_FOUND');
      return {
        row: chain[0],
        reused: true
      };
    });
    return finishPublication(bound, prepared);
  }
  async function list(bound, accountId, input = {}) {
    exact(input, ['mode', 'offset', 'limit', 'expectedHash']);
    bound = {
      ...bound,
      scope: C.validateScope(bound.scope)
    };
    need(/^\d{1,30}$/.test(accountId || ''), 'Exact adopted bank account required.');
    await authorize(bound, null, 'periods.read');
    const offset = input.offset ?? 0,
      limit = input.limit ?? 10;
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 && (!input.mode || ['incremental', 'cumulative'].includes(input.mode)) && (input.expectedHash === undefined || /^[a-f0-9]{64}$/.test(input.expectedHash)) && (offset === 0 || /^[a-f0-9]{64}$/.test(input.expectedHash || '')), 'Current feeds require bounded stable pagination.');
    return store.transaction(async session => {
      const {
        current,
        registry
      } = await state(bound, accountId, session);
      need(!input.expectedHash || input.expectedHash === registry.registryHash, 'Current feed registry changed. Read its latest page.', 'BANKING_FEED_CHANGED');
      const all = [...registry.publications.values()].filter(chain => !input.mode || chain[0].payload.mode === input.mode).sort((a, b) => b[0].payload.createdAt.localeCompare(a[0].payload.createdAt) || b[0].payload.sequence - a[0].payload.sequence || a[0].payload.publicationId.localeCompare(b[0].payload.publicationId)),
        asOf = new Date(now()).toISOString(),
        items = all.slice(offset, offset + limit).map(chain => publicPublication(chain, registry, asOf));
      return {
        accountId,
        currency: current.currency,
        epoch: current.epoch,
        coverage: current.coverage,
        registryHash: registry.registryHash,
        asOf,
        postedCount: current.rows.length,
        assignedIncrementalCount: registry.aliases.size,
        unpublishedPostedCount: current.rows.filter(r => !registry.aliases.has(r.eventId) || registry.publications.get(registry.aliases.get(r.eventId).payload.publicationId)?.length !== 2).length,
        fileHeldPostedCount: current.rows.filter(row => {
          const id = registry.aliases.get(row.eventId)?.payload.publicationId;
          return id && registry.publications.get(id)?.length === 2 && registry.health.get(id)?.at(-1)?.payload.status !== 'verified';
        }).length,
        items,
        page: {
          offset,
          limit,
          total: all.length,
          nextOffset: offset + items.length < all.length ? offset + items.length : null,
          truncated: offset + items.length < all.length
        },
        qboCalls: 0
      };
    });
  }
  async function download(bound, accountId, publicationId, fileId) {
    bound = {
      ...bound,
      scope: C.validateScope(bound.scope)
    };
    need(/^\d{1,30}$/.test(accountId || ''), 'Exact adopted bank account required.');
    need(/^[a-f0-9]{64}$/.test(publicationId || '') && /^[a-f0-9]{64}$/.test(fileId || ''), 'Exact published feed/file identity required.');
    await authorize(bound, null, 'periods.read');
    const descriptor = await store.transaction(async session => {
      const {
          registry
        } = await state(bound, accountId, session),
        chain = registry.publications.get(publicationId);
      need(chain?.length === 2, 'Current feed is not published.');
      const p = chain[0].payload,
        file = p.files.find(f => f.fileId === fileId);
      need(file, 'Published current feed file not found.');
      need(file.path.startsWith(digest(bound.scope) + '/' + accountId + '/current-feeds/'), 'Current feed file crosses its account.');
      return clone(file);
    });
    return {
      ...descriptor,
      bytes: await artifacts.read(descriptor)
    };
  }
  return {
    recoverPublication,
    publishDue: (bound, input) => publish(bound, input, false),
    publishCumulative: (bound, input) => publish(bound, input, true),
    list,
    download
  };
}
function createDefaultBankFeedService(options = {}) {
  const store = options.store || require('./banking-workspace-service').createMongoBankingStore({
      Events: require('../models/BankingEvent'),
      Packages: require('../models/BankingPackage'),
      connection: require('mongoose').connection
    }),
    now = options.now || (() => Date.now()),
    authorize = options.authorize || ((bound, session, action) => require('./business-runtime-access').createBusinessRuntimeAccess({
      ownerId: bound.ownerId,
      actorId: bound.actorId
    }).authorize(bound.scope, action, {
      session
    }));
  return createBankFeedService({
    store,
    now,
    authorize,
    loadActivity: options.loadActivity || ((bound, accountId, session) => require('./banking-workspace-service').loadBankFeedActivity({
      store,
      bound,
      accountId,
      session
    })),
    artifacts: options.artifacts || createBankFeedArtifactStore(options.directory),
    fenceAgent: options.fenceAgent || ((bound, session) => require('./business-agent-authority').fenceAgentAuthority({
      authority: bound.agentAuthority,
      scope: bound.scope,
      ownerId: bound.ownerId,
      actorId: bound.actorId,
      Agents: options.Agents || require('../models/BusinessAgent'),
      session
    }))
  });
}
module.exports = {
  createBankFeedService,
  createDefaultBankFeedService,
  createBankFeedArtifactStore,
  normalizePosted,
  validateRegistry,
  renderPublication,
  PUBLICATION,
  ALIAS
};
