'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  root = path.resolve(__dirname, '../..');
const C = require(path.join(root, 'backend/src/modules/bank-settlement-contract')),
  R = require(path.join(root, 'backend/src/modules/bank-origin-events')),
  S = require(path.join(root, 'backend/src/modules/bank-origin-service'));
const {
    buildGeneralBatch,
    itemRequest,
    classifyGeneralResponse
  } = require(path.join(root, 'backend/src/modules/general-write-transport')),
  {
    createBankInstructionService,
    acceptedSourceHash
  } = require(path.join(root, 'backend/src/modules/bank-instruction-service')),
  {
    createBankInstructionSettlement
  } = require(path.join(root, 'backend/src/modules/bank-instruction-settlement')),
  {
    balances
  } = require(path.join(root, 'backend/src/modules/independent-bank-ledger'));
const clone = structuredClone,
  scope = {
    environment: 'sandbox',
    realmId: '123',
    connectionId: 'a'.repeat(24)
  },
  ownerId = 'b'.repeat(24),
  bound = {
    scope,
    ownerId,
    actorId: ownerId
  },
  now = Date.parse('2026-11-05T14:00:00Z');
const match = (r, f) => r && Object.entries(f).every(([k, v]) => r[k] === v),
  chain = v => ({
    session() {
      return this;
    },
    select() {
      return this;
    },
    maxTimeMS() {
      return this;
    },
    limit() {
      return this;
    },
    sort() {
      return this;
    },
    lean: async () => clone(v)
  });
async function fixture(entity = 'Transfer') {
  const runs = [],
    receipts = [],
    events = [],
    ledgers = new Map(),
    accounts = new Map();
  let writes = 0;
  const models = {
    GeneralWriteRuns: {
      find: f => chain(runs.filter(r => match(r, f))),
      findOne: f => chain(runs.find(r => match(r, f)) || null),
      findOneAndUpdate: (f, u) => {
        const r = runs.find(r => match(r, f));
        if (r) {
          Object.assign(r, clone(u.$set));
          r.revision += u.$inc?.revision || 0;
        }
        return chain(r || null);
      }
    },
    Receipts: {
      findOne: f => chain(receipts.find(r => match(r, f)) || null)
    }
  };
  for (const id of ['50', '51']) {
    accounts.set(id, {
      Id: id,
      Active: true,
      AccountType: 'Bank',
      CurrencyRef: {
        value: 'CAD'
      }
    });
    const l = {
      version: 1,
      scope,
      ledgerId: 'ledger-' + id,
      account: {
        accountId: id,
        accountCurrency: 'CAD',
        accountType: 'Bank',
        accountName: id,
        balanceConvention: 'bank-balance'
      },
      openingMinor: 10000,
      throughPeriod: '2026-10',
      events: [],
      packages: []
    };
    l.balance = balances(l);
    l.contentHash = C.hash(l);
    l.adoption = {
      ownerId,
      actorId: ownerId,
      at: '2026-11-01T00:00:00Z'
    };
    ledgers.set(id, {
      ...scope,
      _id: C.hash({
        scope,
        kind: 'ledger',
        id
      }),
      kind: 'ledger-account',
      eventId: '@ledger:' + id,
      revision: 0,
      accountId: id,
      accountCurrency: 'CAD',
      sourceHash: l.contentHash,
      contentHash: l.contentHash,
      payload: l
    });
  }
  let queue = Promise.resolve(),
    lose = false;
  const get = (kind, id) => events.find(e => e.kind === kind && e.eventId === id) || null,
    store = {
      assertReady: async () => {},
      transaction(f) {
        const task = queue.then(async () => {
          const before = clone(events),
            prior = clone(runs);
          try {
            const out = await f({
              inTransaction: () => true
            });
            if (lose) {
              lose = false;
              throw Object.assign(Error('Committed reply lost'), {
                committed: true
              });
            }
            return out;
          } catch (e) {
            if (!e.committed) {
              events.splice(0, events.length, ...before);
              runs.splice(0, runs.length, ...prior);
            }
            throw e;
          }
        });
        queue = task.catch(() => {});
        return task;
      },
      fenceAccount: async () => {},
      getLedger: async (s, id) => clone(ledgers.get(id)),
      getInstruction: async (s, id) => clone(get('instruction', '@instruction:' + id)),
      getInstructionByLogical: async () => null,
      getReservation: async (s, id) => clone(get('reservation', id)),
      getSettlementRevisions: async (s, id) => clone(events.filter(e => e.kind === 'revision' && e.eventId === '@instruction:' + id)),
      putEvent: async row => {
        writes++;
        const old = events.find(e => e._id === row._id);
        if (old) assert.equal(old.contentHash, row.contentHash);else events.push(clone(row));
      }
    };
  const ref = 'original',
    runId = '1'.repeat(24),
    payload = {
      TxnDate: '2026-11-04',
      CurrencyRef: {
        value: 'CAD'
      },
      ...(entity === 'Transfer' ? {
        Amount: 50,
        FromAccountRef: {
          value: '50'
        },
        ToAccountRef: {
          value: '51'
        }
      } : {
        TotalAmt: 50,
        CustomerRef: {
          value: '113'
        },
        ARAccountRef: {
          value: '63'
        },
        DepositToAccountRef: {
          value: '50'
        },
        Line: [{
          Amount: 50,
          LinkedTxn: [{
            TxnId: '200',
            TxnType: 'Invoice'
          }]
        }]
      })
    },
    op = {
      op: 'create',
      ref,
      entity,
      payload
    },
    batch = {
      index: 0,
      attempt: 1,
      requestId: '2'.repeat(32),
      state: 'answered',
      sends: 1,
      items: [{
        bId: '1',
        ref,
        entity,
        op: 'create',
        operation: 'create',
        payload: clone(payload)
      }]
    },
    record = {
      ...clone(payload),
      Id: '600',
      SyncToken: '0',
      MetaData: {
        CreateTime: '2026-11-04T12:00:00Z',
        LastUpdatedTime: '2026-11-04T12:00:00Z'
      }
    },
    response = [{
      bId: '1',
      [entity]: record
    }],
    observed = classifyGeneralResponse(scope, batch, {
      status: 200,
      json: {
        BatchItemResponse: response
      }
    }),
    receiptId = C.hash({
      runId
    }),
    receipt = {
      _id: receiptId,
      contractVersion: 1,
      ...scope,
      ownerId,
      actorId: ownerId,
      operationId: runId,
      kind: 'general-write',
      state: 'saved',
      entity: 'batch',
      operation: 'create',
      requestHash: buildGeneralBatch(scope, batch).requestHash,
      dispatchKey: C.hash({
        version: 1,
        kind: 'general-write',
        runId,
        batchIndex: 0,
        sends: 1
      }),
      workflow: {
        version: 1,
        kind: 'general-write',
        runId,
        batchIndex: 0,
        sends: 1
      },
      general: {
        version: 1,
        contract: 'general-write-v1',
        runId,
        batchIndex: 0,
        requestId: batch.requestId,
        sends: 1,
        decisionKey: 'original-pair',
        items: [{
          bId: '1',
          ref,
          entity,
          operation: 'create',
          requestHash: itemRequest(scope, batch.items[0]).requestHash
        }]
      },
      observed,
      observedAt: new Date('2026-11-04T12:00:00Z')
    };
  batch.transport = {
    receiptId,
    outcome: 'saved',
    response,
    items: observed.items
  };
  const run = {
    _id: runId,
    contract: 'general-write-v1',
    ...scope,
    ownerId,
    actorId: ownerId,
    decisionKey: 'original-pair',
    status: 'complete',
    plan: {
      operations: [op]
    },
    batches: [batch],
    items: {
      [ref]: {
        outcome: 'saved',
        complete: true,
        entity,
        op: 'create',
        attempt: 1,
        request: clone(payload),
        qboId: '600',
        record: clone(record)
      }
    },
    revision: 0
  };
  run.bankDelivery = {
    version: 1,
    status: 'pending',
    sourceHash: acceptedSourceHash(run.items),
    attempts: 0,
    results: []
  };
  runs.push(run);
  receipts.push(receipt);
  const instructions = createBankInstructionService({
    models,
    store,
    authorize: async () => {},
    getAccount: async (s, id) => accounts.get(id),
    now: () => Date.parse('2026-11-04T13:00:00Z')
  });
  assert.equal((await instructions.deliver(bound, runId)).status, 'complete');
  const rows = events.filter(e => e.kind === 'instruction'),
    settle = createBankInstructionSettlement({
      models,
      store,
      authorize: async () => {},
      now: () => now
    });
  assert.equal((await settle.settle(bound, {
    eventIds: [rows[0].payload.eventId]
  })).posted, rows.length);
  return {
    models,
    store,
    runs,
    receipts,
    events,
    ledgers,
    accounts,
    rows,
    record,
    writes: () => writes,
    lose: () => {
      lose = true;
    }
  };
}
async function source(h, leg = 0) {
  return (await S.readPostedReturnSource({
    models: h.models,
    store: h.store,
    bound,
    eventId: h.rows[leg].payload.eventId
  })).source;
}
function current(frozen, record) {
  const list = [{
    entity: frozen.source.entity,
    record
  }, ...frozen.members.map(m => ({
    entity: 'Account',
    record: {
      Id: m.accountId,
      Active: true,
      AccountType: m.accountType,
      CurrencyRef: {
        value: 'CAD'
      }
    }
  }))];
  if (frozen.source.entity === 'Payment') list.push({
    entity: 'Customer',
    record: {
      Id: '113',
      Active: true,
      CurrencyRef: {
        value: 'CAD'
      }
    }
  }, {
    entity: 'Account',
    record: {
      Id: '63',
      Active: true,
      AccountType: 'Accounts Receivable',
      CurrencyRef: {
        value: 'CAD'
      }
    }
  });
  return list.map(o => ({
    ...o,
    scope,
    recordHash: C.hash(o.record),
    observedAt: new Date(now).toISOString(),
    source: {
      kind: 'qbo-current-mirror',
      scope,
      entity: o.entity,
      id: o.record.Id,
      recordHash: C.hash(o.record),
      completedAt: new Date(now - 1000).toISOString(),
      freshUntil: new Date(now + 60000).toISOString()
    }
  }));
}
const input = (frozen, leg = 0) => ({
  accountId: frozen.members[leg].accountId,
  originalEventId: frozen.members[leg].eventId,
  kind: frozen.source.entity === 'Transfer' ? 'transfer-reversal' : 'nsf-return',
  reference: 'Original return advice',
  purpose: 'The original transfer was returned by the bank.',
  dueDate: '2026-11-05'
});
test('real original batch/receipt and both posted revisions freeze one group, independent of selected leg', async () => {
  const h = await fixture(),
    before = C.hash(h.events),
    writes = h.writes(),
    a = await source(h),
    b = await source(h, 1);
  assert.deepEqual(a, b);
  assert.equal(R.returnIdentity(scope, {
    ...a.source,
    signature: 'different',
    reference: 'changed'
  }), a.returnId);
  assert.deepEqual(R.normalizeReturnRequest(input(a), a, '2026-11-05'), R.normalizeReturnRequest(input(a, 1), a, '2026-11-05'));
  assert.equal(C.hash(h.events), before);
  assert.equal(h.writes(), writes);
  assert.equal(R.validateReturnCurrent({
    source: a,
    current: current(a, h.record),
    now
  }), true);
  const request = R.normalizeReturnRequest(input(a), a, '2026-11-05'),
    out = R.buildSourceBoundReturnEvents({
      source: a,
      request,
      postingDate: '2026-11-05'
    });
  assert.deepEqual(out.map(e => e.amountMinor).sort((a, b) => a - b), [-5000, 5000]);
  assert.equal(out[0].pairedEventId, out[1].eventId);
  for (const e of out) assert.deepEqual(R.validateOriginEvent(e), e);
  assert.equal(C.hash(h.events), before);
});
for (const mutation of ['receipt', 'pending', 'peer', 'scope', 'posted']) test('original ' + mutation + ' cannot authorize return', async () => {
  const h = await fixture();
  if (mutation === 'receipt') h.receipts[0].observed.items[0].responseHash = '0'.repeat(64);
  if (mutation === 'pending') h.events.splice(h.events.findIndex(e => e.revision === 2), 1);
  if (mutation === 'peer') h.rows[0].payload.pairedEventId = 'missing';
  if (mutation === 'scope') h.rows[0].payload.scope = {
    ...scope,
    realmId: '999'
  };
  if (mutation === 'posted') {
    const row = h.events.find(e => e.revision === 2);
    row.payload.amountMinor = 99;
    row.contentHash = C.hash(row.payload);
  }
  await assert.rejects(source(h));
});
test('fresh current record/customer/account shape is independent and stale/current changes hold', async () => {
  const h = await fixture('Payment'),
    f = await source(h),
    v = current(f, h.record);
  assert.equal(R.validateReturnCurrent({
    source: f,
    current: v,
    now
  }), true);
  for (const mode of ['stale', 'money', 'links', 'void', 'currency', 'customer']) {
    const obs = clone(v);
    if (mode === 'stale') obs[0].observedAt = new Date(now - 300001).toISOString();
    if (mode === 'money') obs[0].record.TotalAmt = 49;
    if (mode === 'links') obs[0].record.Line[0].LinkedTxn[0].TxnId = '999';
    if (mode === 'void') obs[0].record.TxnStatus = 'Voided';
    if (mode === 'currency') obs[0].record.CurrencyRef.value = 'USD';
    if (mode === 'customer') obs.find(o => o.entity === 'Customer').record.Active = false;
    for (const o of obs) o.recordHash = o.source.recordHash = C.hash(o.record);
    assert.throws(() => R.validateReturnCurrent({
      source: f,
      current: obs,
      now
    }));
  }
});
test('omitted AR remains explicitly unavailable without applicable original proof, never enriched', async () => {
  const h = await fixture('Payment'),
    record = clone(h.record);
  delete record.ARAccountRef;
  const f = await source(h),
    omitted = {
      ...clone(f),
      financial: R.returnFinancialShape('Payment', record)
    };
  omitted.financialHash = C.hash(omitted.financial);
  const {
    sourceHash,
    ...body
  } = omitted;
  omitted.sourceHash = C.hash(body);
  assert.throws(() => R.validateReturnCurrent({
    source: omitted,
    current: current(omitted, record),
    now
  }), /NSF unavailable/);
  assert.equal(record.ARAccountRef, undefined);
});
test('default composition uses retained proof stores only; nonempty injection never falls back', async t => {
  const h = await fixture(),
    runtime = require(path.join(root, 'backend/src/modules/business-runtime')),
    QBO = require(path.join(root, 'backend/src/modules/qbo-client')).QBOClient;
  let loads = 0,
    network = 0;
  t.mock.method(runtime, 'loadModels', () => {
    loads++;
    return h.models;
  });
  t.mock.method(QBO.prototype, 'apiCall', () => {
    network++;
    throw Error('Network tripwire');
  });
  h.models.GeneralWriteRuns.findOneAndUpdate = () => {
    throw Error('Mutator tripwire');
  };
  h.store.putEvent = async () => {
    throw Error('Mutator tripwire');
  };
  const api = S.createDefaultBankOriginService({
    store: h.store,
    authorize: async () => {}
  });
  assert.equal((await api.readReturnSource(bound, h.rows[0].payload.eventId)).source.source.entity, 'Transfer');
  assert.equal(network, 0);
  assert.equal(loads, 1);
  const injected = S.createDefaultBankOriginService({
    models: {
      Records: {}
    },
    store: h.store,
    authorize: async () => {}
  });
  await assert.rejects(injected.readReturnSource(bound, h.rows[0].payload.eventId), /proof stores are unavailable/);
  assert.equal(loads, 1);
  assert.equal(network, 0);
});
async function returnFixture() {
  const h = await fixture();
  h.clock = now;
  h.paused = false;
  h.sends = 0;
  h.currentRecord = clone(h.record);
  for (const [id, l] of h.ledgers) {
    Object.assign(l, {
      kind: 'ledger-account',
      eventId: '@ledger:' + id,
      revision: 0,
      _id: C.hash({
        scope,
        eventId: '@ledger:' + id,
        revision: 0
      }),
      accountId: id,
      accountCurrency: 'CAD',
      sourceHash: l.contentHash
    });
  }
  h.store.listBankOriginContext = async () => clone([...h.events, ...h.ledgers.values()]);
  h.store.listInstructionActivity = async (s, id) => ({
    rows: clone(h.events.filter(r => r.kind === 'instruction' && r.accountId === id)),
    revisions: clone(h.events.filter(r => r.kind === 'revision' && r.accountId === id && r.eventId.startsWith('@instruction:')))
  });
  h.store.listOriginRows = async (s, id) => clone(h.events.filter(r => r.kind === 'revision' && r.accountId === id && r.eventId.startsWith('@origin')));
  h.store.findOriginByDecision = async (s, key) => clone(h.events.filter(r => r.eventId.startsWith('@origin:') && r.payload.bookkeeping?.decisionKey === key));
  h.store.getCanonicalOriginConflict = async (s, id) => clone(h.events.find(r => r.kind === 'revision' && r.eventId === id) || null);
  const returnProof = async (b, id, session, options = {}) => {
      const v = await S.readPostedReturnSource({
        models: h.models,
        store: h.store,
        bound: b,
        eventId: id,
        session
      });
      if (options.current) R.validateReturnCurrent({
        source: v.source,
        current: current(v.source, h.currentRecord),
        now: h.clock
      });
      return v;
    },
    context = {
      day: '2026-11-05',
      protectedThrough: '2026-10-31',
      taxCodes: {
        sales: [],
        purchase: []
      },
      taxPercent: {}
    },
    copy = {
      read: async (s, e, id) => e === 'Account' ? clone(h.accounts.get(id) || null) : null
    };
  let service;
  function answered(run) {
    const op = run.plan.operations[0],
      batch = run.batches[0],
      receiptId = C.hash({
        returnRun: run._id
      }),
      saved = {
        ...clone(op.payload),
        Id: '900',
        SyncToken: '0',
        MetaData: {
          CreateTime: '2026-11-05T14:00:00Z',
          LastUpdatedTime: '2026-11-05T14:00:00Z'
        }
      },
      response = [{
        bId: '1',
        [op.entity]: saved
      }],
      observed = classifyGeneralResponse(scope, batch, {
        status: 200,
        json: {
          BatchItemResponse: response
        }
      }),
      receipt = {
        _id: receiptId,
        contractVersion: 1,
        ...scope,
        ownerId,
        actorId: ownerId,
        operationId: run._id,
        kind: 'general-write',
        state: 'saved',
        entity: 'batch',
        operation: 'create',
        requestHash: buildGeneralBatch(scope, batch).requestHash,
        dispatchKey: C.hash({
          version: 1,
          kind: 'general-write',
          runId: run._id,
          batchIndex: 0,
          sends: 1
        }),
        workflow: {
          version: 1,
          kind: 'general-write',
          runId: run._id,
          batchIndex: 0,
          sends: 1
        },
        general: {
          version: 1,
          contract: 'general-write-v1',
          runId: run._id,
          batchIndex: 0,
          requestId: batch.requestId,
          sends: 1,
          decisionKey: run.decisionKey,
          items: [{
            bId: '1',
            ref: op.ref,
            entity: op.entity,
            operation: 'create',
            requestHash: itemRequest(scope, batch.items[0]).requestHash
          }]
        },
        observed,
        observedAt: new Date(h.clock)
      };
    batch.state = 'answered';
    batch.sends = 1;
    batch.transport = {
      receiptId,
      outcome: 'saved',
      response,
      items: observed.items
    };
    run.items[op.ref] = {
      outcome: 'saved',
      complete: true,
      entity: op.entity,
      op: 'create',
      attempt: 1,
      request: clone(op.payload),
      qboId: saved.Id,
      record: saved
    };
    run.status = 'complete';
    h.receipts.push(receipt);
  }
  const general = {
    dispatchEnabled: () => true,
    async prepare(b, draft) {
      const id = C.hash({
          scope,
          ownerId,
          kind: 'general-write',
          decisionKey: draft.decisionKey
        }).slice(0, 24),
        old = h.runs.find(r => r._id === id);
      if (old) return {
        runId: id,
        status: old.status
      };
      const local = await require(path.join(root, 'backend/src/modules/general-write-service')).loadCopy(copy, scope, draft.operations, new Set()),
        checked = require(path.join(root, 'backend/src/modules/general-write-guards')).checkGeneralWrite({
          proposal: {
            operations: draft.operations
          },
          local,
          context,
          scope
        });
      assert.equal(checked.ok, true, JSON.stringify(checked.problems));
      const op = checked.plan.operations[0],
        batch = {
          index: 0,
          attempt: 1,
          requestId: C.hash({
            id
          }).slice(0, 32),
          state: 'prepared',
          sends: 0,
          items: [{
            bId: '1',
            ref: op.ref,
            entity: op.entity,
            op: 'create',
            operation: 'create',
            payload: clone(op.payload)
          }]
        },
        run = {
          _id: id,
          ...scope,
          ownerId,
          actorId: ownerId,
          contract: 'general-write-v1',
          decisionKey: draft.decisionKey,
          contentHash: C.hash({
            purpose: draft.purpose.trim(),
            operations: draft.operations
          }),
          plan: checked.plan,
          batches: [batch],
          items: {},
          status: 'prepared',
          revision: 0
        };
      h.runs.push(run);
      return {
        runId: id,
        status: 'prepared'
      };
    },
    async execute(b, id) {
      const run = h.runs.find(r => r._id === id);
      if (run.status === 'unknown') throw Error('Unknown same-request outcome retained');
      if (run.status !== 'complete') {
        if (h.beforeAdmission) await h.beforeAdmission(run);
        await h.store.transaction(session => service.assertAdmission(b, run, run.batches[0], session));
        if (h.unknown) {
          run.status = 'unknown';
          throw Error('Unknown same-request outcome');
        }
        h.sends++;
        answered(run);
      }
      await h.store.transaction(session => service.linkAccepted(b, run, 'bank-origin', session));
      return {
        status: run.status,
        runId: id
      };
    }
  };
  const adapter = S.createBankBookkeepingAdapter({
    models: h.models,
    store: h.store,
    copy,
    contextFor: async () => context,
    returnProof,
    snapshot: async () => h.snapshot ? h.snapshot() : {
      scope,
      complete: true,
      observedAt: new Date(h.clock).toISOString(),
      records: [...(h.extraRecords || []), ...[...h.accounts.values()].map(record => ({
        scope,
        entity: 'Account',
        qboId: record.Id,
        record
      }))],
      settlementEvents: h.extraSettlements || []
    },
    general: () => general,
    observeMapping: async () => {
      throw Error('Return must not read expense/tax mapping');
    },
    now: () => h.clock
  });
  service = S.createBankOriginService({
    store: h.store,
    authorize: async () => {
      if (h.paused) throw Error('Owner paused');
    },
    observeMapping: async () => {
      throw Error('No fee policy required');
    },
    returnProof,
    bookkeeping: adapter,
    now: () => h.clock,
    fenceAgent: async () => {
      if (h.paused) throw Error('Agent paused');
    }
  });
  h.service = service;
  h.returnProof = returnProof;
  h.general = general;
  h.useService = next => {
    service = next;
  };
  h.adapter = adapter;
  return h;
}
test('whole Transfer return claims/due/books both inverse legs once without a fee policy', async () => {
  const h = await returnFixture(),
    f = await source(h),
    request = input(f),
    before = clone(h.events),
    baseline = clone([...h.ledgers]);
  assert.equal((await h.service.addAdvice(bound, request)).status, 'pending');
  assert.equal(h.events.filter(e => e.payload.kind === 'bank-origin-return-claim-v1').length, 1);
  assert.equal((await h.service.addAdvice(bound, input(f, 1))).reused, true);
  await assert.rejects(h.service.addAdvice(bound, {
    ...request,
    reference: 'Another name'
  }), /different return choices/);
  assert.equal((await h.service.processDue(bound, {
    accountId: '50'
  })).posted, 2);
  assert.equal((await h.service.processDue(bound, {
    accountId: '51'
  })).posted, 0);
  const g = S.returnGroup(h.events, scope, f.returnId);
  assert.equal(g.legs.length, 2);
  assert.deepEqual(g.legs.map(l => l.event.amountMinor).sort((a, b) => a - b), [-5000, 5000]);
  const result = await h.service.book(bound, {
    accountId: g.legs[1].event.accountId,
    eventId: g.legs[1].event.eventId
  });
  assert.equal(result.status, 'booked');
  assert.equal(h.sends, 1);
  const booked = S.returnGroup(h.events, scope, f.returnId);
  assert.equal(booked.head.payload.state, 'booked');
  assert.equal(booked.legs.every(l => l.last.payload.bookkeeping.qboId === '900'), true);
  for (const l of booked.legs) assert.equal((await h.service.book(bound, {
    accountId: l.event.accountId,
    eventId: l.event.eventId
  })).qboId, '900');
  assert.equal(h.sends, 1);
  for (const original of before) assert.deepEqual(h.events.find(e => e._id === original._id), original);
  assert.deepEqual([...h.ledgers], baseline);
});
async function feedReturnFixture(t) {
  const h = await returnFixture(),
    fs = require('node:fs/promises'),
    os = require('node:os'),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-return-feed-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.ok(path.basename(resolved).startsWith('bank-return-feed-') && path.dirname(resolved) === (await fs.realpath(os.tmpdir())));
    await fs.rm(resolved, {
      recursive: true,
      force: true
    });
  });
  h.store.listInstructionActivity = async (s, id) => ({
    rows: clone(h.events.filter(r => r.kind === 'instruction' && r.accountId === id)),
    revisions: clone(h.events.filter(r => r.kind === 'revision' && r.accountId === id && r.eventId.startsWith('@instruction:')))
  });
  h.store.loadFeedPeers = async (s, ids) => ({
    rows: clone(h.events.filter(r => r.kind === 'instruction' && ids.includes(r.payload.eventId))),
    revisions: clone(h.events.filter(r => r.kind === 'revision' && ids.some(id => r.eventId === '@instruction:' + id)))
  });
  h.store.listFeedRows = async (s, id) => clone(h.events.filter(r => r.accountId === id && r.eventId.startsWith('@feed')));
  h.store.authenticateReturnSource = (b, id, session) => S.readPostedReturnSource({
    models: h.models,
    store: h.store,
    bound: b,
    eventId: id,
    session
  });
  h.feeds = require(path.join(root, 'backend/src/modules/bank-feed-service')).createDefaultBankFeedService({
    store: h.store,
    directory,
    now: () => h.clock,
    authorize: async () => {
      if (h.paused) throw Error('Owner paused');
    }
  });
  h.directory = directory;
  return h;
}
test('original and compensating pair publish separate incremental CSV rows; booking/retry keep original files and economic membership', async t => {
  const h = await feedReturnFixture(t),
    fs = require('node:fs/promises'),
    F = require(path.join(root, 'backend/src/modules/bank-feed-service'));
  await h.feeds.publishDue(bound, {
    accountId: '50'
  });
  await h.feeds.publishDue(bound, {
    accountId: '51'
  });
  const originalRows = clone(h.events.filter(r => r.payload.kind === F.PUBLICATION)),
    files = [];
  for (const r of originalRows) for (const f of r.payload.files || []) files.push({
    path: f.path,
    bytes: await fs.readFile(path.join(h.directory, f.path))
  });
  const frozen = await source(h);
  await h.service.addAdvice(bound, input(frozen));
  await h.service.processDue(bound, {
    accountId: '51'
  });
  const left = await h.feeds.publishDue(bound, {
      accountId: '50'
    }),
    right = await h.feeds.publishDue(bound, {
      accountId: '51'
    });
  assert.equal(left.rowCount, 1);
  assert.equal(right.rowCount, 1);
  const g = S.returnGroup(h.events, scope, frozen.returnId);
  await h.service.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  });
  const count = h.events.filter(r => r.payload.kind === F.PUBLICATION).length;
  await h.feeds.publishDue(bound, {
    accountId: '50'
  });
  await h.feeds.publishDue(bound, {
    accountId: '51'
  });
  assert.equal(h.events.filter(r => r.payload.kind === F.PUBLICATION).length, count);
  for (const row of originalRows) assert.deepEqual(h.events.find(r => r._id === row._id), row);
  for (const f of files) assert.deepEqual(await fs.readFile(path.join(h.directory, f.path)), f.bytes);
  assert.equal(h.sends, 1);
});
test('return CSV rejects missing return peer or changed original posted revision', async t => {
  for (const mode of ['return-peer', 'original-posted']) {
    const h = await feedReturnFixture(t),
      f = await source(h);
    await h.service.addAdvice(bound, input(f));
    await h.service.processDue(bound, {
      accountId: '50'
    });
    const before = h.events.length;
    if (mode === 'return-peer') {
      const g = S.returnGroup(h.events, scope, f.returnId),
        row = g.legs.find(l => l.event.accountId === '51').posted;
      h.events.splice(h.events.findIndex(r => r._id === row._id), 1);
    } else {
      const row = h.events.find(r => r.eventId.startsWith('@instruction:') && r.revision === 2);
      row.payload.amountMinor = 123;
      row.contentHash = C.hash(row.payload);
    }
    await assert.rejects(h.feeds.publishDue(bound, {
      accountId: '50'
    }));
    assert.ok(h.events.length <= before);
  }
});
test('claim lost reply and either-leg concurrency retain one whole return and reject changed reason/date/reference', async () => {
  const h = await returnFixture(),
    f = await source(h);
  h.lose();
  await assert.rejects(h.service.addAdvice(bound, input(f)), /reply lost/);
  const results = await Promise.all([h.service.addAdvice(bound, input(f)), h.service.addAdvice(bound, input(f, 1))]);
  assert.ok(results.every(r => r.reused));
  assert.equal(h.events.filter(r => r.payload.kind === 'bank-origin-return-claim-v1' && r.revision === 1).length, 1);
  for (const change of [{
    reference: 'Different reference'
  }, {
    purpose: 'Different business reason for the same source.'
  }, {
    dueDate: '2026-11-06'
  }]) await assert.rejects(h.service.addAdvice(bound, {
    ...input(f),
    ...change
  }), /different return choices/);
});
test('failed second return member rolls back both inverse postings, preserving source and one pending claim', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  const before = clone(h.events),
    put = h.store.putEvent;
  h.store.putEvent = async (row, ...args) => {
    if (row.payload.kind === 'independent-bank-return-v1' && row.accountId === '51' && row.revision === 2) throw Error('Failed inverse member');
    return put(row, ...args);
  };
  await assert.rejects(h.service.processDue(bound, {
    accountId: '50'
  }), /Failed inverse member/);
  assert.deepEqual(h.events, before);
  assert.equal(S.returnGroup(h.events, scope, f.returnId).head.payload.state, 'pending');
});
test('fresh-original change at posting or new send holds; outgoing request tamper never reaches SDK', async () => {
  for (const stage of ['post', 'send', 'request']) {
    const h = await returnFixture(),
      f = await source(h);
    await h.service.addAdvice(bound, input(f));
    if (stage === 'post') {
      h.currentRecord.Amount = 49;
      assert.equal((await h.service.processDue(bound, {
        accountId: '50'
      })).returnHolds.length, 1);
      assert.equal(S.returnGroup(h.events, scope, f.returnId).head.payload.state, 'pending');
    } else {
      await h.service.processDue(bound, {
        accountId: '50'
      });
      const g = S.returnGroup(h.events, scope, f.returnId);
      h.beforeAdmission = async run => {
        if (stage === 'send') h.currentRecord.Amount = 49;else run.batches[0].items[0].payload.Amount = 49;
      };
      await assert.rejects(h.service.book(bound, {
        accountId: g.primary.event.accountId,
        eventId: g.primary.event.eventId
      }));
    }
    assert.equal(h.sends, 0);
  }
});
test('unknown and Pause keep the same canonical request with no replacement or new ingestion', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  await h.service.processDue(bound, {
    accountId: '51'
  });
  const g = S.returnGroup(h.events, scope, f.returnId),
    cmd = {
      accountId: g.primary.event.accountId,
      eventId: g.primary.event.eventId
    };
  h.unknown = true;
  await assert.rejects(h.service.book(bound, cmd), /Unknown/);
  const owned = h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_'));
  assert.equal(owned.length, 1);
  const run = clone(owned[0]),
    bankOriginalCount = h.events.filter(r => r.payload.kind === 'independent-bank-return-v1' && r.revision === 2).length;
  h.unknown = false;
  await assert.rejects(h.service.book(bound, cmd), /Unknown/);
  assert.equal(h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_')).length, 1);
  assert.equal(h.runs.find(r => r._id === run._id).batches[0].requestId, run.batches[0].requestId);
  assert.equal(h.events.filter(r => r.payload.kind === 'independent-bank-return-v1' && r.revision === 2).length, bankOriginalCount);
  h.paused = true;
  await assert.rejects(h.service.book(bound, cmd), /paused/);
  assert.equal(h.sends, 0);
});
function fullCurrentModels(h) {
  const {
      TXNS
    } = require(path.join(root, 'backend/src/modules/banking-operator-guards')),
    agentId = 'e'.repeat(24),
    grantId = 'f'.repeat(64),
    authorityHash = 'd'.repeat(64),
    at = (v, k) => k.split('.').reduce((x, p) => x?.[p], v),
    equal = (a, b) => a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a === b;
  function matches(r, f) {
    return Object.entries(f).every(([k, w]) => k === '$or' ? w.some(v => matches(r, v)) : k === '$and' ? w.every(v => matches(r, v)) : w && typeof w === 'object' && !(w instanceof Date) ? Object.entries(w).every(([op, v]) => op === '$in' ? v.some(x => equal(at(r, k), x)) : op === '$gte' ? at(r, k) !== undefined && new Date(at(r, k)) >= new Date(v) : op === '$gt' ? at(r, k) !== undefined && at(r, k) > v : op === '$elemMatch' ? Array.isArray(at(r, k)) && at(r, k).some(x => matches(x, v)) : op === '$ne' ? !equal(at(r, k), v) : false) : equal(at(r, k), w));
  }
  const agent = () => ({
      _id: agentId,
      ...scope,
      ownerId,
      settings: {
        monitoring: true,
        autonomous: !h.paused
      },
      grant: {
        id: grantId,
        authorityHash,
        ownerId
      },
      sync: {
        sources: Object.fromEntries([...new Set([...TXNS, 'Account', 'Customer', 'TaxCode', 'TaxRate'])].map(entity => [entity, {
          entity,
          status: 'current',
          phase: 'incremental',
          generation: 'g1',
          mode: 'cdc',
          since: new Date(h.clock - 2000).toISOString(),
          startedAt: new Date(h.clock - 60000).toISOString(),
          lastSuccessAt: new Date(h.clock - (h.stale ? 200000 : 1000)).toISOString()
        }]))
      }
    }),
    records = () => [{
      entity: 'Transfer',
      record: clone(h.currentRecord)
    }, ...(h.extraRecords || []), ...[...h.accounts.values()].map(a => ({
      entity: 'Account',
      record: {
        ...a,
        Name: 'Bank ' + a.Id,
        SyncToken: '0',
        MetaData: {
          LastUpdatedTime: '2026-11-01T00:00:00Z'
        }
      }
    }))].map(o => ({
      ...scope,
      _id: C.hash({
        scope,
        entity: o.entity,
        id: o.record.Id
      }),
      entity: o.entity,
      qboId: o.record.Id,
      record: o.record,
      generation: 'g1',
      deleted: Boolean(h.deleted && o.entity === 'Transfer')
    }));
  h.models.Records = {
    findOne: f => chain(records().find(r => matches(r, f)) || null),
    find: (f, projection, options) => {
      let n = Infinity;
      return {
        session() {
          return this;
        },
        select() {
          return this;
        },
        maxTimeMS() {
          return this;
        },
        sort() {
          return this;
        },
        limit(v) {
          n = v;
          return this;
        },
        lean: async () => records().filter(r => matches(r, f)).sort((a, b) => Buffer.compare(Buffer.from(a._id), Buffer.from(b._id))).slice(0, n)
      };
    }
  };
  h.models.Agents = {
    findOne: f => chain(matches(agent(), f) ? agent() : null),
    findOneAndUpdate: (f, u, opts) => {
      assert.ok(opts.session.inTransaction());
      assert.deepEqual(u, {
        $inc: {
          dispatchRevision: 1
        }
      });
      return chain(matches(agent(), f) ? agent() : null);
    }
  };
  h.models.Receipts.findOne = f => chain(h.receipts.find(r => matches(r, f)) || null);
  for (const name of ['Writers', 'Audits', 'Steps', 'Authorities']) h.models[name] = {
    findOne() {
      throw Error('Unexpected ' + name + ' query');
    }
  };
  return {
    agentId,
    grantId,
    authorityHash
  };
}
test('complete default current-source/claim/clock/choices compose real hardened mirror readers with no SDK or General mutation', async t => {
  const h = await returnFixture(),
    identity = fullCurrentModels(h),
    QBO = require(path.join(root, 'backend/src/modules/qbo-client')).QBOClient,
    general = require(path.join(root, 'backend/src/modules/general-write-service'));
  let network = 0,
    unexpectedWriter = 0;
  t.mock.method(QBO.prototype, 'apiCall', () => {
    network++;
    throw Error('No QBO in bank clock');
  });
  t.mock.method(general, 'createDefaultGeneralWrite', () => {
    unexpectedWriter++;
    throw Error('No default financial writer in bank clock');
  });
  h.models.GeneralWriteRuns.findOneAndUpdate = () => {
    throw Error('Original General mutation tripwire');
  };
  const api = S.createDefaultBankOriginService({
      models: h.models,
      store: h.store,
      now: () => h.clock,
      authorize: async b => {
        assert.deepEqual(b.scope, scope);
        assert.equal(b.ownerId, ownerId);
      }
    }),
    workspace = require(path.join(root, 'backend/src/modules/banking-workspace-service')).createBankingWorkspaceService({
      store: h.store,
      originService: api,
      now: () => new Date(h.clock),
      resolveContext: async () => ({
        environment: scope.environment,
        connection: {
          connected: true,
          ...scope
        }
      }),
      authorize: async b => assert.equal(b.ownerId, ownerId)
    }),
    tools = require(path.join(root, 'backend/src/modules/banking-accountant-tools')).createBankingAccountantTools({
      workspace
    }),
    view = await tools.execute({
      id: ownerId
    }, 'getBankOriginPolicy', {
      accountId: '50'
    });
  assert.equal(view.choices.returns.items[0].eligible, true);
  const f = await source(h),
    command = input(f),
    agentAuthority = {
      version: 1,
      ...identity,
      ownerId
    };
  assert.equal((await tools.execute({
    id: ownerId
  }, 'addBankOriginAdvice', command, {
    agentAuthority
  })).status, 'pending');
  assert.equal((await api.processDue({
    ...bound,
    agentAuthority
  }, {
    accountId: '50'
  })).posted, 2);
  assert.equal(S.returnGroup(h.events, scope, f.returnId).legs.length, 2);
  const repeat = await api.returnChoices(bound, '51');
  assert.equal(repeat.items[0].eligible, false);
  assert.equal(repeat.items[0].status, 'posted');
  assert.equal(network, 0);
  assert.equal(unexpectedWriter, 0);
});
test('default current mirror stale/deleted/unsettled/Pause paths hold before return posting with zero SDK', async t => {
  for (const mode of ['stale', 'deleted', 'unknown', 'pause']) {
    const h = await returnFixture(),
      identity = fullCurrentModels(h),
      api = S.createDefaultBankOriginService({
        models: h.models,
        store: h.store,
        now: () => h.clock,
        authorize: async () => {}
      }),
      f = await source(h),
      a = {
        version: 1,
        ...identity,
        ownerId
      };
    await api.addAdvice({
      ...bound,
      agentAuthority: a
    }, input(f));
    if (mode === 'stale') h.stale = true;
    if (mode === 'deleted') h.deleted = true;
    if (mode === 'unknown') h.receipts.push({
      ...scope,
      _id: 'unknown',
      entity: 'batch',
      state: 'unknown',
      sentAt: new Date(h.clock)
    });
    if (mode === 'pause') h.paused = true;
    if (mode === 'pause') await assert.rejects(api.processDue({
      ...bound,
      agentAuthority: a
    }, {
      accountId: '50'
    }));else assert.equal((await api.processDue({
      ...bound,
      agentAuthority: a
    }, {
      accountId: '50'
    })).returnHolds.length, 1);
    assert.equal(S.returnGroup(h.events, scope, f.returnId).head.payload.state, 'pending');
    assert.equal(h.sends, 0);
  }
});
test('booked return ownership stays authenticated for later fee/general admission, and late exact advice retry reuses its original claim', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  h.clock += 86400000;
  assert.equal((await h.service.addAdvice(bound, input(f, 1))).reused, true);
  h.clock = now;
  await h.service.processDue(bound, {
    accountId: '50'
  });
  const g = S.returnGroup(h.events, scope, f.returnId);
  await h.service.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  });
  const selected = await S.creatorReservations({
    rows: await h.store.listBankOriginContext(),
    scope,
    accounts: [...h.accounts.values()],
    models: h.models
  });
  assert.equal(selected.length, 4);
  const saved = h.receipts.find(r => r.general.decisionKey.startsWith('bank_origin_return_'));
  saved.observed.items[0].responseHash = '0'.repeat(64);
  await assert.rejects(S.creatorReservations({
    rows: await h.store.listBankOriginContext(),
    scope,
    accounts: [...h.accounts.values()],
    models: h.models
  }));
});
test('future-dated original settlement is unavailable at the current return clock', async () => {
  const h = await returnFixture(),
    f = await source(h),
    changed = clone(f);
  for (const m of changed.members) m.settledAt = new Date(now + 86400000).toISOString();
  const {
    sourceHash,
    ...body
  } = changed;
  changed.sourceHash = C.hash(body);
  assert.throws(() => R.validateReturnCurrent({
    source: changed,
    current: current(changed, h.record),
    now
  }), /not actually occurred/);
});
test('return source requires original explicit adopted owner and chronological boundary', async () => {
  for (const mode of ['absent', 'owner', 'late']) {
    const h = await fixture(),
      ledger = h.ledgers.get('50').payload;
    if (mode === 'absent') delete ledger.adoption;
    if (mode === 'owner') ledger.adoption.ownerId = 'c'.repeat(24);
    if (mode === 'late') ledger.adoption.at = '2026-11-06T00:00:00Z';
    await assert.rejects(source(h), /adoption/);
  }
});
test('a known held return does not block independent monthly fees on the same account', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  const feeService = S.createBankOriginService({
    store: h.store,
    returnProof: h.returnProof,
    now: () => h.clock,
    authorize: async () => {},
    observeMapping: async (b, m) => ({
      ...m,
      requested: clone(m),
      definitionHash: C.hash({
        id: m.counterpartAccountId
      })
    })
  });
  await feeService.configure(bound, {
    accountId: '50',
    expectedRevision: 0,
    enabled: true,
    feeMinor: 500,
    decisionKey: 'fee-separate-from-return',
    mapping: {
      counterpartAccountId: '19',
      taxTreatment: 'out-of-scope'
    }
  });
  h.currentRecord.Amount = 49;
  const result = await feeService.processDue(bound, {
    accountId: '50'
  });
  assert.equal(result.returnHolds.length, 1);
  assert.equal(result.posted, 1);
  assert.equal(S.returnGroup(h.events, scope, f.returnId).head.payload.state, 'pending');
  assert.equal(h.events.filter(r => r.payload.kind === 'independent-bank-origin-v1' && r.revision === 2).length, 1);
  assert.equal(h.sends, 0);
});
function inverseMirror(h, event, marked = false) {
  const op = require(path.join(root, 'backend/src/modules/bank-origin-resolution')).returnDraft(event).operations[0],
    record = {
      ...clone(op.payload),
      Id: '901',
      SyncToken: '0',
      MetaData: {
        CreateTime: '2026-11-05T13:00:00Z',
        LastUpdatedTime: '2026-11-05T13:00:00Z'
      }
    };
  if (!marked) delete record.PrivateNote;
  return {
    scope,
    entity: 'Transfer',
    qboId: record.Id,
    record
  };
}
for (const marked of [false, true]) for (const stage of ['before-claim', 'final-admission']) test('duplicate inverse ' + (marked ? 'marked' : 'unmarked') + ' ' + stage + ' is held without send or replacement', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  await h.service.processDue(bound, {
    accountId: '50'
  });
  const g = S.returnGroup(h.events, scope, f.returnId),
    mirror = inverseMirror(h, g.primary.event, marked),
    cmd = {
      accountId: g.primary.event.accountId,
      eventId: g.primary.event.eventId
    };
  if (stage === 'before-claim') h.extraRecords = [mirror];else h.beforeAdmission = async () => {
    h.extraRecords = [mirror];
  };
  await assert.rejects(h.service.book(bound, cmd), /bookkeeping|inverse|ambig/i);
  assert.equal(h.sends, 0);
  const claims = h.events.filter(r => r.payload.kind === 'bank-return-booking-claim');
  assert.equal(claims.length, stage === 'before-claim' ? 0 : 1);
  const owned = h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_'));
  assert.equal(owned.length, stage === 'before-claim' ? 0 : 1);
  const requestId = owned[0]?.batches[0].requestId;
  await assert.rejects(h.service.book(bound, cmd));
  assert.equal(h.sends, 0);
  assert.equal(h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_')).length, owned.length);
  if (owned.length) assert.equal(owned[0].batches[0].requestId, requestId);
});
test('whole-return held bookkeeping acquires both sorted account fences', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  await h.service.processDue(bound, {
    accountId: '50'
  });
  const g = S.returnGroup(h.events, scope, f.returnId),
    fences = [];
  h.store.fenceAccount = async (s, id) => {
    fences.push(id);
  };
  h.clock += 86400000;
  await h.service.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  });
  assert.deepEqual(fences, ['50', '51']);
});
test('return choices filter before receipt-date ordering, include newest low-hash Transfer and page older sources', async () => {
  const h = await returnFixture();
  fullCurrentModels(h);
  const original = h.events.find(r => r.kind === 'instruction' && r.accountId === '50');
  const extra = [];
  for (let i = 0; i < 25; i++) {
    const row = clone(original);
    row._id = (i + 1).toString(16).padStart(64, 'z');
    row.payload.source.entity = 'Purchase';
    row.payload.source.id = String(2000 + i);
    row.payload.receivedAt = '2026-11-05T13:59:00Z';
    extra.push(row);
  }
  for (let i = 0; i < 23; i++) {
    const row = clone(original);
    row._id = (i + 1).toString(16).padStart(64, 'y');
    row.payload.source.id = String(3000 + i);
    row.payload.eventId = C.stableEventId(scope, 'Transfer', row.payload.source.id, '50');
    row.payload.receivedAt = new Date(now - 2 * 86400000 - i * 1000).toISOString();
    extra.push(row);
  }
  h.store.listInstructionActivity = async () => ({
    rows: [original, ...extra].sort((a, b) => a._id.localeCompare(b._id)),
    revisions: []
  });
  const api = S.createDefaultBankOriginService({
      models: h.models,
      store: h.store,
      now: () => h.clock,
      authorize: async () => {}
    }),
    first = await api.returnChoices(bound, '50', {
      offset: 0,
      limit: 20
    });
  assert.equal(first.items[0].sourceId, h.record.Id);
  assert.equal(first.items[0].eligible, true);
  assert.equal(first.total, 24);
  assert.equal(first.observedInstructionCount, 49);
  assert.equal(first.pageEligibleCount, 1);
  assert.equal(first.page.nextOffset, 20);
  const older = await api.returnChoices(bound, '50', {
    offset: 20,
    limit: 20
  });
  assert.equal(older.items.length, 4);
  assert.equal(older.page.nextOffset, null);
  assert.equal(new Set([...first.items, ...older.items].map(x => x.returnId)).size, 24);
});
for (const marked of [false, true]) test('default complete mirror and settled financial state reject existing ' + (marked ? 'marked' : 'unmarked') + ' inverse before booking claim', async t => {
  const h = await returnFixture();
  fullCurrentModels(h);
  const api = S.createDefaultBankOriginService({
      models: h.models,
      store: h.store,
      now: () => h.clock,
      authorize: async () => {}
    }),
    f = await source(h);
  await api.addAdvice(bound, input(f));
  await api.processDue(bound, {
    accountId: '50'
  });
  const g = S.returnGroup(h.events, scope, f.returnId);
  h.extraRecords = [inverseMirror(h, g.primary.event, marked)];
  let writerReads = 0,
    receiptReads = 0;
  h.models.Writers.findOne = () => {
    writerReads++;
    return chain({
      ...scope,
      _id: scope.environment + ':' + scope.realmId,
      contractVersion: 1,
      revision: 2,
      operationId: null,
      planHash: null,
      unresolved: null,
      resourceClaims: [],
      resourceQueue: []
    });
  };
  h.models.Receipts.find = () => {
    receiptReads++;
    return chain([]);
  };
  const QBO = require(path.join(root, 'backend/src/modules/qbo-client')).QBOClient;
  let calls = 0;
  t.mock.method(QBO.prototype, 'apiCall', () => {
    calls++;
    throw Error('No live SDK');
  });
  await assert.rejects(api.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  }), /ambiguous|already present/);
  assert.ok(writerReads);
  assert.ok(receiptReads);
  assert.equal(calls, 0);
  assert.equal(h.events.filter(r => r.payload.kind === 'bank-return-booking-claim').length, 0);
  assert.equal(h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_')).length, 0);
});
test('return ambiguity detects other decision and native paired inverse, but different account/date/currency shape does not compensate', async () => {
  for (const mode of ['other-decision', 'settlement-pair', 'different-account', 'different-date', 'different-currency']) {
    const h = await returnFixture(),
      f = await source(h);
    await h.service.addAdvice(bound, input(f));
    await h.service.processDue(bound, {
      accountId: '50'
    });
    const g = S.returnGroup(h.events, scope, f.returnId),
      mirror = inverseMirror(h, g.primary.event);
    if (mode === 'other-decision') h.runs.push({
      _id: 'a'.repeat(24),
      ...scope,
      ownerId,
      actorId: ownerId,
      decisionKey: require(path.join(root, 'backend/src/modules/bank-origin-resolution')).keyFor(g.primary.event),
      status: 'prepared'
    });else if (mode === 'settlement-pair') h.extraSettlements = require(path.join(root, 'backend/src/modules/bank-settlement-engine')).buildSettlementEvents({
      scope,
      asOf: '2026-11-05',
      homeCurrency: 'CAD',
      accounts: [...h.accounts.values()],
      mirror: [mirror]
    }).events;else {
      if (mode === 'different-account') mirror.record.FromAccountRef.value = '52';
      if (mode === 'different-date') mirror.record.TxnDate = '2026-11-04';
      if (mode === 'different-currency') mirror.record.CurrencyRef.value = 'USD';
      h.extraRecords = [mirror];
    }
    const cmd = {
      accountId: g.primary.event.accountId,
      eventId: g.primary.event.eventId
    };
    if (['other-decision', 'settlement-pair'].includes(mode)) {
      await assert.rejects(h.service.book(bound, cmd), /ambiguous|already present/);
      assert.equal(h.sends, 0);
    } else {
      assert.equal((await h.service.book(bound, cmd)).status, 'booked');
      assert.equal(h.sends, 1);
    }
  }
});
test('owner source pagination binds the complete original choice list and exposes older choices through existing policy route', async () => {
  const h = await returnFixture();
  fullCurrentModels(h);
  const api = S.createDefaultBankOriginService({
      models: h.models,
      store: h.store,
      now: () => h.clock,
      authorize: async () => {}
    }),
    workspace = require(path.join(root, 'backend/src/modules/banking-workspace-service')).createBankingWorkspaceService({
      store: h.store,
      originService: api,
      now: () => new Date(h.clock),
      resolveContext: async () => ({
        environment: scope.environment,
        connection: {
          connected: true,
          ...scope
        }
      }),
      authorize: async () => {}
    }),
    row = h.events.find(r => r.kind === 'instruction' && r.accountId === '50'),
    extra = [];
  for (let i = 0; i < 22; i++) {
    const r = clone(row);
    r._id = (i + 1).toString().padStart(64, 'f');
    r.payload.source.id = String(4000 + i);
    r.payload.eventId = C.stableEventId(scope, 'Transfer', r.payload.source.id, '50');
    r.payload.receivedAt = new Date(now - 2 * 86400000 - i * 1000).toISOString();
    extra.push(r);
  }
  h.store.listInstructionActivity = async () => ({
    rows: [row, ...extra],
    revisions: h.events.filter(r => r.eventId.startsWith('@instruction:') && r.accountId === '50')
  });
  const first = await workspace.originPolicy({
      id: ownerId
    }, '50'),
    older = await workspace.originPolicy({
      id: ownerId
    }, '50', {
      offset: 20,
      expectedHash: first.obligations.originHash
    });
  assert.equal(older.choices.returns.items.length, 3);
  assert.equal(older.choices.returns.page.offset, 20);
  extra.pop();
  await assert.rejects(workspace.originPolicy({
    id: ownerId
  }, '50', {
    offset: 20,
    expectedHash: first.obligations.originHash
  }), /changed/);
});
test('authenticated own frozen run accepts native BSON owner identities without excluding another decision', async () => {
  const h = await returnFixture(),
    f = await source(h),
    ObjectId = require(path.join(root, 'node_modules/mongoose')).Types.ObjectId;
  await h.service.addAdvice(bound, input(f));
  await h.service.processDue(bound, {
    accountId: '50'
  });
  h.beforeAdmission = async run => {
    run.ownerId = new ObjectId(ownerId);
    run.actorId = new ObjectId(ownerId);
  };
  h.models.GeneralWriteRuns.find = f => ({
    ...chain(null),
    lean: async () => h.runs.filter(r => match(r, f))
  });
  h.models.GeneralWriteRuns.findOne = f => ({
    ...chain(null),
    lean: async () => h.runs.find(r => match(r, f)) || null
  });
  const g = S.returnGroup(h.events, scope, f.returnId);
  assert.equal((await h.service.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  })).status, 'booked');
  assert.equal(h.sends, 1);
});
function alternativeMoneyMirror(h, event, entity) {
  const r = event.source.advice.returnOf.financial,
    amount = r.Amount,
    ref = value => ({
      value
    }),
    record = {
      Id: '902',
      SyncToken: '0',
      TxnDate: event.bookDate,
      CurrencyRef: ref('CAD'),
      MetaData: {
        CreateTime: '2026-11-05T13:00:00Z',
        LastUpdatedTime: '2026-11-05T13:00:00Z'
      }
    };
  if (entity === 'JournalEntry') record.Line = [{
    Amount: amount,
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: ref(r.FromAccountRef.value)
    }
  }, {
    Amount: amount,
    DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: ref(r.ToAccountRef.value)
    }
  }];else if (entity === 'Deposit') Object.assign(record, {
    DepositToAccountRef: ref(r.FromAccountRef.value),
    TotalAmt: amount,
    Line: [{
      Amount: amount,
      DetailType: 'DepositLineDetail',
      DepositLineDetail: {
        AccountRef: ref('19')
      }
    }]
  });else Object.assign(record, {
    PaymentType: 'Cash',
    AccountRef: ref(r.ToAccountRef.value),
    TotalAmt: amount,
    Line: [{
      Amount: amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: {
        AccountRef: ref('19')
      }
    }]
  });
  return {
    scope,
    entity,
    qboId: record.Id,
    record
  };
}
function completeSettledSnapshot(h) {
  fullCurrentModels(h);
  h.financialProofReads = 0;
  h.models.Writers.findOne = () => {
    h.financialProofReads++;
    return chain({
      ...scope,
      _id: scope.environment + ':' + scope.realmId,
      contractVersion: 1,
      revision: 2,
      operationId: null,
      planHash: null,
      unresolved: null,
      resourceClaims: [],
      resourceQueue: []
    });
  };
  h.models.Receipts.find = () => chain([]);
  h.snapshot = async () => {
    const snapshot = await require(path.join(root, 'backend/src/modules/banking-accountant-tools')).createBankingMirrorReader({
      Records: h.models.Records,
      Agents: h.models.Agents,
      now: () => h.clock,
      timeoutMs: 0
    })({
      scope,
      phase: 'before'
    });
    await S.assertOriginFinancialSnapshot({
      models: h.models,
      scope,
      snapshot,
      now: () => h.clock
    });
    const financial = require(path.join(root, 'backend/src/modules/bank-settlement-engine')).buildSettlementEvents({
      scope,
      asOf: '2026-11-05',
      homeCurrency: 'CAD',
      accounts: snapshot.records.filter(r => r.entity === 'Account').map(r => r.record),
      mirror: snapshot.records
    }).events;
    return {
      ...snapshot,
      settlementEvents: [...new Map([...financial, ...(h.extraSettlements || [])].map(e => [e.eventId, e])).values()]
    };
  };
}
for (const entity of ['JournalEntry', 'Deposit', 'Purchase']) for (const stage of ['before-claim', 'final-admission']) test('generic observed money ' + entity + ' ' + stage + ' holds even alongside exact own return events', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  await h.service.processDue(bound, {
    accountId: '50'
  });
  completeSettledSnapshot(h);
  const g = S.returnGroup(h.events, scope, f.returnId),
    other = alternativeMoneyMirror(h, g.primary.event, entity),
    native = require(path.join(root, 'backend/src/modules/bank-settlement-engine')).buildSettlementEvents({
      scope,
      asOf: '2026-11-05',
      homeCurrency: 'CAD',
      accounts: [...h.accounts.values()],
      mirror: [other]
    }).events;
  assert.equal(native.length, entity === 'JournalEntry' ? 2 : 1);
  const insert = () => {
    h.extraRecords = [other];
    h.extraSettlements = [...g.legs.map(l => clone(l.event)), ...native];
  };
  if (stage === 'before-claim') insert();else h.beforeAdmission = async () => insert();
  const command = {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  };
  await assert.rejects(h.service.book(bound, command), /ambiguous|already present/);
  assert.equal(h.sends, 0);
  const owned = h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_'));
  assert.equal(owned.length, stage === 'before-claim' ? 0 : 1);
  const request = owned[0]?.batches[0].requestId;
  await assert.rejects(h.service.book(bound, command));
  assert.equal(h.sends, 0);
  assert.equal(h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_')).length, owned.length);
  if (owned.length) assert.equal(owned[0].batches[0].requestId, request);
  assert.ok(h.financialProofReads);
});
test('default factory complete mirror with settled writer holds an unmarked economic inverse JournalEntry', async () => {
  const h = await returnFixture();
  completeSettledSnapshot(h);
  const api = S.createDefaultBankOriginService({
      models: h.models,
      store: h.store,
      now: () => h.clock,
      authorize: async () => {}
    }),
    f = await source(h);
  await api.addAdvice(bound, input(f));
  await api.processDue(bound, {
    accountId: '50'
  });
  const g = S.returnGroup(h.events, scope, f.returnId);
  h.extraRecords = [alternativeMoneyMirror(h, g.primary.event, 'JournalEntry')];
  await assert.rejects(api.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  }), /ambiguous|already present/);
  assert.ok(h.financialProofReads);
  assert.equal(h.runs.filter(r => r.decisionKey.startsWith('bank_origin_return_')).length, 0);
  assert.equal(h.sends, 0);
});
test('exact authenticated own derived return events alone do not block the same frozen run', async () => {
  const h = await returnFixture(),
    f = await source(h);
  await h.service.addAdvice(bound, input(f));
  await h.service.processDue(bound, {
    accountId: '50'
  });
  const g = S.returnGroup(h.events, scope, f.returnId);
  h.extraSettlements = g.legs.map(l => clone(l.event));
  assert.equal((await h.service.book(bound, {
    accountId: g.primary.event.accountId,
    eventId: g.primary.event.eventId
  })).status, 'booked');
  assert.equal(h.sends, 1);
});
