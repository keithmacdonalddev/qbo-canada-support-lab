'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  root = path.resolve(__dirname, '../..'),
  C = require(path.join(root, 'backend/src/modules/bank-settlement-contract')),
  M = require(path.join(root, 'backend/src/modules/bank-monthly-statement-service')),
  S = require(path.join(root, 'backend/src/modules/bank-instruction-settlement')),
  L = require(path.join(root, 'backend/src/modules/independent-bank-ledger'));
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
  };
function fixture(card = false) {
  const events = [],
    files = new Map(),
    originals = new Map();
  let clock = Date.parse('2026-12-01T14:00:00Z'),
    queue = Promise.resolve(),
    lose = false,
    paused = false,
    delivery = false;
  const ledger = {
    version: 1,
    scope,
    ledgerId: 'fixture-bank',
    account: {
      accountId: '50',
      accountCurrency: 'CAD',
      accountType: card ? 'Credit Card' : 'Bank',
      accountName: 'Fictional bank',
      balanceConvention: card ? 'card-amount-owed' : 'bank-balance'
    },
    openingMinor: 10000,
    openingPeriod: '2026-10',
    throughPeriod: '2026-10',
    events: [],
    packages: []
  };
  ledger.balance = L.balances(ledger);
  ledger.contentHash = C.hash(ledger);
  ledger.adoption = {
    ownerId,
    actorId: ownerId,
    at: '2026-11-01T12:00:00Z'
  };
  const store = {
    assertReady: async () => {},
    transaction(fn) {
      const p = queue.then(async () => {
        const before = clone(events);
        try {
          const out = await fn({
            inTransaction: () => true
          });
          if (lose) {
            lose = false;
            throw Object.assign(Error('reply lost'), {
              committed: true
            });
          }
          return out;
        } catch (e) {
          if (!e.committed) events.splice(0, events.length, ...before);
          throw e;
        }
      });
      queue = p.catch(() => {});
      return p;
    },
    fenceAccount: async () => {},
    getLedger: async () => ({
      ...scope,
      _id: C.hash({
        scope,
        kind: 'ledger-account',
        accountId: '50'
      }),
      kind: 'ledger-account',
      eventId: '@ledger:50',
      revision: 0,
      accountId: '50',
      accountCurrency: 'CAD',
      sourceHash: ledger.contentHash,
      contentHash: ledger.contentHash,
      payload: clone(ledger)
    }),
    putEvent: async r => {
      const old = events.find(x => x._id === r._id);
      if (old) assert.equal(old.contentHash, r.contentHash);else events.push(clone(r));
    },
    listMonthlyRows: async () => clone(events.filter(x => x.eventId.startsWith('@monthly-statement'))),
    listFeedRows: async () => [],
    listInstructionActivity: async () => ({
      rows: clone(events.filter(x => x.kind === 'instruction')),
      revisions: clone(events.filter(x => x.kind === 'revision' && x.eventId.startsWith('@instruction:')))
    }),
    getInstruction: async (s, id) => clone(events.find(x => x.kind === 'instruction' && x.eventId === '@instruction:' + id)),
    getReservation: async (s, id) => clone(events.find(x => x.kind === 'reservation' && x.eventId === id)),
    getSettlementRevisions: async (s, id) => clone(events.filter(x => x.kind === 'revision' && x.eventId === '@instruction:' + id)),
    listSettlementInstructions: async () => clone(events.filter(x => x.kind === 'instruction' && !events.some(r => r.eventId === x.eventId && r.revision === 2)).slice(0, 100))
  };
  const h = {
    events,
    files,
    ledger,
    store,
    originals,
    writes: 0,
    baselineReads: 0,
    deliveryReads: 0,
    afterWrite: null
  };
  const artifacts = {
    write: async a => {
      assert.equal(a.sha256, require('node:crypto').createHash('sha256').update(a.bytes).digest('hex'));
      if (files.has(a.path)) assert.deepEqual(files.get(a.path), a.bytes);else files.set(a.path, Buffer.from(a.bytes));
      h.writes++;
      if (h.afterWrite) {
        const fn = h.afterWrite;
        h.afterWrite = null;
        await fn();
      }
    },
    read: async f => {
      const b = files.get(f.path);
      if (!b || require('node:crypto').createHash('sha256').update(b).digest('hex') !== f.sha256) throw Object.assign(Error('Retained file held'), {
        code: 'BANKING_STATEMENT_HELD'
      });
      return Buffer.from(b);
    }
  };
  const opts = {
    store,
    artifacts,
    authenticateInstructions: async () => true,
    now: () => clock,
    authorize: async () => {
      if (paused) throw Object.assign(Error('Owner paused'), {
        code: 'BUSINESS_ACCESS_FORBIDDEN'
      });
    },
    authenticateBaseline: async () => {
      h.baselineReads++;
      L.verifyLedger(ledger);
    },
    loadDeliveryProof: async () => {
      h.deliveryReads++;
      if (delivery) throw Object.assign(Error('Accepted delivery can still change month'), {
        code: 'BANKING_STATEMENT_HELD'
      });
      return C.hash([]);
    },
    loadActivity: async () => {
      const q = await store.listInstructionActivity();
      return {
        ledger: clone(ledger),
        activity: S.projectInstructionActivity({
          scope,
          ledger: clone(ledger),
          instructions: q.rows,
          revisions: q.revisions
        }),
        pairedProofs: {}
      };
    }
  };
  h.api = M.createBankMonthlyStatementService(opts);
  h.options = opts;
  h.add = (id, receivedAt = '2026-11-27T14:00:00.000Z') => {
    const record = {
        Id: String(id),
        TxnDate: receivedAt.slice(0, 10),
        CurrencyRef: {
          value: 'CAD'
        },
        DepositToAccountRef: {
          value: '50'
        },
        TotalAmt: 1
      },
      eventId = C.stableEventId(scope, 'SalesReceipt', record.Id, '50'),
      runId = C.hash(record.Id).slice(0, 24),
      ref = 'one',
      lineage = {
        runId,
        ref,
        batchIndex: 0,
        requestId: 'request',
        bId: '1',
        requestHash: C.hash('batch'),
        itemRequestHash: C.hash('item'),
        responseHash: C.hash('response'),
        recordHash: C.hash(record),
        entity: 'SalesReceipt',
        id: record.Id,
        ownerId,
        originalActorId: ownerId
      },
      source = {
        ...lineage,
        signature: C.hash(lineage),
        receiptId: 'receipt'
      },
      payload = {
        version: 1,
        kind: 'governed-bank-instruction',
        scope,
        eventId,
        logicalKey: C.hash({
          scope,
          runId,
          ref,
          accountId: '50'
        }),
        state: 'pending',
        accountId: '50',
        accountCurrency: 'CAD',
        accountType: ledger.account.accountType,
        amountMinor: 100,
        bookDate: record.TxnDate,
        description: 'Receipt #' + record.Id,
        creator: 'api-accountant',
        expectedResolution: 'match',
        settlementGroupId: null,
        pairedEventId: null,
        source,
        receivedAt,
        deliveryActorId: ownerId
      },
      row = {
        ...scope,
        _id: C.hash({
          scope,
          kind: 'instruction',
          eventId: '@instruction:' + eventId
        }),
        kind: 'instruction',
        eventId: '@instruction:' + eventId,
        revision: 0,
        accountId: '50',
        accountCurrency: 'CAD',
        sourceHash: source.signature,
        contentHash: C.hash(payload),
        payload
      },
      reservation = {
        scope,
        eventId,
        accountId: '50',
        creator: 'api-accountant'
      };
    events.push(row, {
      ...scope,
      _id: C.hash({
        scope,
        eventId,
        revision: 0
      }),
      kind: 'reservation',
      eventId,
      revision: 0,
      accountId: '50',
      accountCurrency: 'CAD',
      sourceHash: C.hash(reservation),
      contentHash: C.hash(reservation),
      payload: reservation
    });
    originals.set(eventId, record);
    return row;
  };
  h.settle = () => S.createBankInstructionSettlement({
    store,
    now: () => clock,
    authorize: async () => {},
    originalRecord: async (b, p) => ({
      record: clone(originals.get(p.eventId))
    })
  }).settle(bound, {
    accountId: '50'
  });
  h.setNow = v => clock = Date.parse(v);
  h.lose = () => lose = true;
  h.pause = () => paused = true;
  h.delivery = v => delivery = v;
  return h;
}
for (const card of [false, true]) test('issued ' + (card ? 'card' : 'bank') + ' month and following quiet month carry exact money and retain old artifacts', async () => {
  const h = fixture(card);
  h.add(1);
  await h.settle();
  const first = await h.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(first.status, 'published');
  const nov = (await h.api.list(bound, '50')).items[0];
  assert.equal(nov.openingMinor, 10000);
  assert.equal(nov.closingMinor, card ? 9900 : 10100);
  const bytes = clone([...h.files]);
  assert.equal((await h.api.issue(bound, {
    accountId: '50',
    statementId: first.statementId
  })).reused, true);
  h.setNow('2027-01-01T14:00:00Z');
  const quiet = await h.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(quiet.rowCount, 0);
  const months = (await h.api.list(bound, '50')).items;
  assert.equal(months[0].period, '2026-12');
  assert.equal(months[0].openingMinor, nov.closingMinor);
  assert.equal(months[0].closingMinor, nov.closingMinor);
  assert.equal(months[0].files.some(f => f.kind === 'csv'), false);
  for (const [k, b] of bytes) assert.deepEqual(h.files.get(k), Buffer.from(b));
});
test('first100 settlements do not prove quiet: Dec1 still posts the101st item Nov30', async () => {
  const h = fixture();
  for (let n = 0; n < 101; n++) h.add(n);
  assert.equal((await h.settle()).posted, 100);
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }), /Unscheduled|Due bank/);
  assert.equal(h.files.size, 0);
  assert.equal((await h.settle()).posted, 1);
  assert.equal(h.events.filter(r => r.revision === 2 && r.eventId.startsWith('@instruction:')).every(r => r.payload.postingDate === '2026-11-30'), true);
  const r = await h.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(r.rowCount, 101);
});
test('late due work or accepted delivery after files holds original plan instead of replacing it', async () => {
  for (const mode of ['instruction', 'delivery', 'pause']) {
    const h = fixture();
    h.afterWrite = async () => {
      if (mode === 'instruction') h.add(9);
      if (mode === 'delivery') h.delivery(true);
      if (mode === 'pause') h.pause();
    };
    await assert.rejects(h.api.issue(bound, {
      accountId: '50'
    }));
    const plans = h.events.filter(r => r.eventId.startsWith(M.PREFIX));
    assert.equal(plans.length, 1);
    assert.equal(plans[0].revision, 1);
    assert.ok(h.files.size > 0);
    assert.equal(h.events.some(r => r.eventId.startsWith(M.PREFIX) && r.revision === 2), false);
  }
});
test('lost commit and recreated service recover exact frozen statement without another plan', async () => {
  const h = fixture();
  h.lose();
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }), /reply lost/);
  const p = h.events.find(r => r.eventId.startsWith(M.PREFIX));
  assert.ok(p);
  h.api = M.createBankMonthlyStatementService(h.options);
  const result = await h.api.issue(bound, {
    accountId: '50',
    statementId: p.payload.statementId
  });
  assert.equal(result.status, 'published');
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 2);
  const count = h.files.size;
  await h.api.issue(bound, {
    accountId: '50',
    statementId: p.payload.statementId
  });
  assert.equal(h.files.size, count);
});
test('after-cutoff pending is disclosed independently and does not become November settled money', async () => {
  const h = fixture();
  h.add(1, '2026-11-30T14:00:00.000Z');
  await h.settle();
  const result = await h.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(result.rowCount, 0);
  const item = (await h.api.list(bound, '50')).items[0];
  assert.equal(item.pendingCount, 1);
  assert.equal(item.closingMinor, 10000);
});
test('default partial injection cannot load production models, writer or artifact directory', async t => {
  const h = fixture(),
    runtime = require(path.join(root, 'backend/src/modules/business-runtime')),
    F = require(path.join(root, 'backend/src/modules/bank-feed-service'));
  let models = 0,
    artifacts = 0;
  t.mock.method(runtime, 'loadModels', () => {
    models++;
    throw Error('No production models');
  });
  t.mock.method(F, 'createBankFeedArtifactStore', () => {
    artifacts++;
    throw Error('No production artifacts');
  });
  const api = M.createDefaultBankMonthlyStatementService({
    ...h.options,
    models: {},
    artifacts: undefined,
    loadDeliveryProof: undefined
  });
  await assert.rejects(api.issue(bound, {
    accountId: '50'
  }), /delivery proof stores/);
  assert.equal(models, 0);
  assert.equal(artifacts, 0);
  assert.equal(h.files.size, 0);
});
test('complete delivery queue overflow and missing original proof are held before files', async () => {
  for (const mode of ['overflow', 'missing-proof']) {
    const h = fixture(),
      chain = v => ({
        session() {
          return this;
        },
        limit() {
          return this;
        },
        maxTimeMS() {
          return this;
        },
        lean: async () => v
      }),
      run = {
        _id: '1'.repeat(24),
        ...scope,
        ownerId,
        bankDelivery: {
          status: 'pending'
        },
        items: {
          one: {
            outcome: 'saved',
            complete: true,
            op: 'create',
            entity: 'Payment'
          }
        }
      },
      models = {
        GeneralWriteRuns: {
          find: () => chain(mode === 'overflow' ? Array(10001).fill(run) : [run])
        },
        Receipts: {
          findOne: () => chain(null)
        }
      },
      api = M.createDefaultBankMonthlyStatementService({
        ...h.options,
        models,
        loadDeliveryProof: undefined
      });
    await assert.rejects(api.issue(bound, {
      accountId: '50'
    }));
    assert.equal(h.files.size, 0);
    assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 0);
  }
});
test('accountant statement write uses authority-only guards, durable outcomes and exact Agent context; specialists cannot invoke it', async t => {
  const B = require(path.join(root, 'backend/src/modules/business-agent-tools')),
    bank = require(path.join(root, 'backend/src/modules/banking-accountant-tools')),
    catalog = require(path.join(root, 'backend/src/modules/business-agent-catalog')),
    box = require(path.join(root, 'backend/src/modules/business-agent-toolbox'));
  const guards = [],
    events = [],
    agentId = 'e'.repeat(24),
    grantId = 'f'.repeat(64),
    authorityHash = 'd'.repeat(64),
    row = {
      _id: agentId,
      ownerId,
      grant: {
        id: grantId,
        authorityHash
      },
      settings: {
        instructions: ''
      }
    },
    store = {
      models: {},
      business: async () => ({
        scope,
        authorityHash
      }),
      event: async (...args) => {
        events.push(args);
        return {
          id: 'c'.repeat(24),
          ...args[4]
        };
      }
    };
  let executions = 0;
  t.mock.method(bank, 'createBankingRuntime', () => ({
    tools: {
      execute: async (user, name, input, context) => {
        executions++;
        assert.equal(name, 'issueDueBankStatements');
        assert.equal(context.agentAuthority.agentId, agentId);
        assert.equal(context.agentAuthority.authorityHash, authorityHash);
        assert.equal(input.decision, undefined);
        return {
          status: 'not-due',
          readiness: {
            period: '2026-11',
            blockers: []
          },
          qboCalls: 0
        };
      }
    }
  }));
  const make = role => B.createBusinessAgentTools({
    row,
    role,
    passId: 'statement-fixture',
    scope,
    user: {
      id: ownerId
    },
    signal: new AbortController().signal,
    now: () => Date.parse('2026-12-01T14:00:00Z'),
    store,
    access: {
      resolveClient: () => {
        throw Error('No QBO context');
      }
    },
    readTools: {
      toolDefinitions: [],
      toolHandlers: {}
    },
    guard: async mode => {
      guards.push(mode);
      if (mode === true) throw Error('No fresh financial context');
    },
    persistMemory: async () => {}
  });
  await make('accountant').execute('issueDueBankStatements', {
    accountId: '50',
    decision: {
      goal: 'Retain truthful monthly bank evidence',
      planItem: 'Issue eligible bank month'
    }
  });
  assert.deepEqual(guards, [undefined, 'authority', 'authority', undefined]);
  assert.equal(events[0][1], 'accountant-write-decision');
  assert.equal(events.at(-1)[1], 'accountant-write-outcome-complete');
  assert.equal(events.at(-1)[4].statementStatus, 'not-due');
  assert.equal(events.at(-1)[4].qboCalls, 0);
  for (const role of ['receivables', 'payables', 'inventory']) {
    const tools = make(role);
    assert.equal(tools.definitions.some(t => t.name === 'issueDueBankStatements'), false);
    await assert.rejects(tools.execute('issueDueBankStatements', {
      accountId: '50'
    }), /cannot use/);
  }
  assert.equal(executions, 1);
  const visible = catalog.agentToolCatalog({
    toolDefinitions: [],
    VALID_ENTITY_TYPES: []
  }, {
    list: () => []
  }, {});
  for (const name of ['getBankMonthlyStatements', 'issueDueBankStatements']) {
    assert.ok(visible.tools.find(t => t.name === name)?.summary);
    assert.ok(box.INFO[name].keywords.includes('monthly'));
  }
});
async function sdkDelivery(h, options = {}) {
  const T = require(path.join(root, 'backend/src/modules/general-write-transport')),
    I = require(path.join(root, 'backend/src/modules/bank-instruction-service')),
    entity = options.entity || 'Payment',
    id = '3'.repeat(24),
    ref = 'payment',
    payload = options.payload || {
      TxnDate: '2026-11-27',
      CurrencyRef: {
        value: 'CAD'
      },
      DepositToAccountRef: {
        value: '50'
      },
      TotalAmt: 1
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
      requestId: C.hash(id).slice(0, 32),
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
      Id: '777',
      SyncToken: '0',
      MetaData: {
        CreateTime: '2026-11-27T14:00:00Z',
        LastUpdatedTime: '2026-11-27T14:00:00Z'
      }
    },
    response = [{
      bId: '1',
      [entity]: record
    }],
    observed = T.classifyGeneralResponse(scope, batch, {
      status: 200,
      json: {
        BatchItemResponse: response
      }
    }),
    receiptId = C.hash('sdk receipt'),
    receipt = {
      _id: receiptId,
      contractVersion: 1,
      ...scope,
      ownerId,
      actorId: ownerId,
      operationId: id,
      kind: 'general-write',
      state: 'saved',
      entity: 'batch',
      operation: 'create',
      requestHash: T.buildGeneralBatch(scope, batch).requestHash,
      dispatchKey: C.hash({
        version: 1,
        kind: 'general-write',
        runId: id,
        batchIndex: 0,
        sends: 1
      }),
      workflow: {
        version: 1,
        kind: 'general-write',
        runId: id,
        batchIndex: 0,
        sends: 1
      },
      general: {
        version: 1,
        contract: 'general-write-v1',
        runId: id,
        batchIndex: 0,
        requestId: batch.requestId,
        sends: 1,
        decisionKey: 'business-sdk',
        items: [{
          bId: '1',
          ref,
          entity,
          operation: 'create',
          requestHash: T.itemRequest(scope, batch.items[0]).requestHash
        }]
      },
      observed,
      observedAt: new Date('2026-11-27T14:00:00Z')
    };
  batch.transport = {
    receiptId,
    outcome: 'saved',
    response,
    items: observed.items
  };
  const run = {
    _id: id,
    ...scope,
    ownerId,
    actorId: ownerId,
    contract: 'general-write-v1',
    decisionKey: 'business-sdk',
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
        qboId: record.Id,
        record: clone(record)
      }
    },
    revision: 0
  };
  run.bankDelivery = {
    version: 1,
    status: 'pending',
    sourceHash: I.acceptedSourceHash(run.items),
    queuedAt: '2026-11-27T14:00:00Z',
    attempts: 0,
    results: []
  };
  const chain = v => ({
      session() {
        return this;
      },
      maxTimeMS() {
        return this;
      },
      limit() {
        return this;
      },
      lean: async () => clone(v)
    }),
    models = {
      GeneralWriteRuns: {
        find: () => chain(run.bankDelivery.status === 'complete' ? [] : [run]),
        findOne: () => chain(run),
        findOneAndUpdate: (filter, u) => {
          Object.assign(run, clone(u.$set));
          run.revision += u.$inc?.revision || 0;
          return chain(run);
        }
      },
      Receipts: {
        findOne: () => chain(receipt)
      }
    };
  h.store.getInstructionByLogical = async (s, accountId, key) => clone(h.events.find(r => r.kind === 'instruction' && r.accountId === accountId && r.payload.logicalKey === key) || null);
  const api = M.createDefaultBankMonthlyStatementService({
      ...h.options,
      models,
      loadDeliveryProof: undefined,
      authenticateInstructions: undefined
    }),
    deliver = I.createBankInstructionService({
      models,
      store: h.store,
      now: options.now || (() => Date.parse('2026-11-27T14:00:00Z')),
      authorize: async () => {},
      getAccount: options.getAccount || (async () => ({
        Id: '50',
        Active: true,
        AccountType: 'Bank',
        CurrencyRef: {
          value: 'CAD'
        }
      }))
    });
  return {
    models,
    api,
    run,
    receipt,
    record,
    deliver: async () => {
      await deliver.deliver(bound, id);
      const instruction = h.events.find(r => r.kind === 'instruction');
      for (const row of h.events.filter(r => r.kind === 'instruction')) h.originals.set(row.payload.eventId, record);
      return instruction;
    }
  };
}
test('default delivery/instruction adapters authenticate original mandatory SDK receipt and rejects a hash-valid forged after-cutoff schedule', async () => {
  const h = fixture(),
    sdk = await sdkDelivery(h),
    original = clone(sdk.run);
  await assert.rejects(sdk.api.issue(bound, {
    accountId: '50'
  }), /Accepted bank delivery/);
  assert.equal(h.files.size, 0);
  const instruction = await sdk.deliver();
  h.setNow('2026-11-27T14:00:00Z');
  await h.settle();
  h.setNow('2026-12-01T14:00:00Z');
  const pending = h.events.find(r => r.eventId === instruction.eventId && r.revision === 1),
    kept = clone(pending);
  pending.payload.schedule.instrument = 'cheque';
  pending.payload.schedule.expectedPostingDate = '2026-12-04';
  pending.contentHash = C.hash(pending.payload);
  await assert.rejects(sdk.api.issue(bound, {
    accountId: '50'
  }), /timing changed/);
  assert.equal(h.files.size, 0);
  Object.assign(h.events.find(r => r._id === pending._id), kept);
  await h.settle();
  const r = await sdk.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(r.rowCount, 1);
  assert.equal(r.status, 'published');
  assert.deepEqual(sdk.run.items, original.items);
  assert.deepEqual(sdk.run.plan, original.plan);
  assert.deepEqual(sdk.run.batches, original.batches);
});
test('existing default bank clock retains feed progress when monthly work is held and continues an eligible account', async () => {
  const make = require(path.join(root, 'backend/src/modules/bank-instruction-loop')).createDefaultBankInstructionLoop,
    agent = {
      _id: 'e'.repeat(24),
      environment: 'production',
      realmId: '9130357222392856',
      connectionId: scope.connectionId,
      ownerId,
      settings: {
        monitoring: true,
        autonomous: true
      },
      grant: {
        id: 'f'.repeat(64),
        authorityHash: 'd'.repeat(64),
        ownerId
      }
    },
    chain = v => ({
      limit() {
        return this;
      },
      maxTimeMS() {
        return this;
      },
      lean: async () => v
    }),
    calls = [],
    loop = make({
      Agents: {
        find: () => chain([agent]),
        findOne: () => chain(agent)
      },
      Events: {
        distinct: () => ({
          maxTimeMS: async () => ['50', '51']
        })
      },
      createAccess: () => ({
        authorize: async () => {}
      }),
      makeSettlement: () => ({
        settle: async () => {
          throw Error('No due selection');
        }
      }),
      originService: {
        processDue: async (b, {
          accountId
        }) => {
          calls.push('origin:' + accountId);
          return {
            posted: 0
          };
        }
      },
      feedService: {
        publishDue: async (b, {
          accountId
        }) => {
          calls.push('feed:' + accountId);
          return {
            published: true,
            reused: false
          };
        }
      },
      statementService: {
        issue: async (b, {
          accountId
        }) => {
          calls.push('statement:' + accountId);
          assert.equal(b.agentAuthority.agentId, agent._id);
          if (accountId === '50') throw Object.assign(Error('Coverage held'), {
            code: 'BANKING_STATEMENT_HELD'
          });
          return {
            issued: true,
            status: 'published',
            qboCalls: 0
          };
        }
      },
      selectDue: async () => [],
      now: () => Date.parse('2026-12-01T14:00:00Z')
    });
  await loop.tick();
  const state = loop.status({
    environment: agent.environment,
    realmId: agent.realmId,
    connectionId: agent.connectionId
  }, ownerId);
  assert.equal(state.monthlyIssued, 1);
  assert.ok(state.lastWorkAt);
  assert.deepEqual(state.accounts.map(a => a.monthlyStatementStatus), ['held', 'published']);
  assert.deepEqual(calls, ['origin:50', 'feed:50', 'statement:50', 'origin:51', 'feed:51', 'statement:51']);
  loop.close();
});
test('monthly owner routes retain strict query and exact PDF download boundaries', async () => {
  const create = require(path.join(root, 'backend/src/routes/banking-workspace')).createBankingWorkspaceRouter,
    calls = [],
    router = create({
      service: {
        monthlyStatements: async (user, id, page) => {
          calls.push({
            user,
            id,
            page
          });
          return {
            items: []
          };
        },
        issueMonthlyStatements: async (user, body) => ({
          qboCalls: 0,
          ...body
        }),
        downloadMonthlyStatement: async (user, id, statementId, fileId) => ({
          kind: 'statement',
          period: '2026-11',
          fileId,
          sha256: C.hash('pdf'),
          bytes: Buffer.from('%PDF-fixture')
        })
      }
    }),
    get = path => router.stack.find(l => l.route?.path === path).route.stack[0].handle,
    response = () => ({
      headersSent: false,
      headers: {},
      status(n) {
        this.statusCode = n;
        return this;
      },
      set(k, v) {
        this.headers[k] = v;
        return this;
      },
      json(v) {
        this.body = v;
        this.headersSent = true;
      },
      send(v) {
        this.body = v;
        this.headersSent = true;
      }
    }),
    user = {
      id: ownerId
    };
  let res = response();
  await get('/accounts/:accountId/statements')({
    user,
    params: {
      accountId: '50'
    },
    query: {
      offset: '20',
      limit: '10',
      expectedHash: C.hash('page')
    }
  }, res);
  assert.deepEqual(calls[0], {
    user,
    id: '50',
    page: {
      offset: 20,
      limit: 10,
      expectedHash: C.hash('page')
    }
  });
  res = response();
  await get('/accounts/:accountId/statements')({
    user,
    params: {
      accountId: '50'
    },
    query: {
      realmId: 'foreign'
    }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 1);
  res = response();
  await get('/accounts/:accountId/statements/:statementId/files/:fileId')({
    user,
    params: {
      accountId: '50',
      statementId: C.hash('statement'),
      fileId: C.hash('file')
    },
    query: {}
  }, res);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(Buffer.isBuffer(res.body));
});
test('server refuses client-supplied dates, balances, company and proof arrays', async () => {
  const h = fixture();
  for (const extra of [{
    period: '2026-10'
  }, {
    openingMinor: 1
  }, {
    realmId: 'foreign'
  }, {
    rows: []
  }, {
    now: '2027-01-01'
  }]) await assert.rejects(h.api.issue(bound, {
    accountId: '50',
    ...extra
  }), /Exact statement account/);
  assert.equal(h.files.size, 0);
  assert.equal(h.events.length, 0);
  assert.throws(() => M.createDefaultBankMonthlyStatementService({
    models: {
      GeneralWriteRuns: {}
    }
  }), /explicit store/);
});
test('settled drift after a planned quiet statement stays review-held instead of declaring a replacement eligible', async () => {
  const h = fixture();
  h.afterWrite = async () => h.add(77);
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }));
  await h.settle();
  const state = await h.api.list(bound, '50');
  assert.equal(state.readiness.status, 'held');
  assert.match(state.readiness.blockers[0], /Original planned statement source changed/);
  assert.equal(state.items[0].status, 'planned');
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 1);
});
test('published missing/corrupt files retain identity and byte descriptors; exact recovery never replaces a corrupted artifact', async () => {
  const h = fixture(),
    r = await h.api.issue(bound, {
      accountId: '50'
    }),
    item = (await h.api.list(bound, '50')).items[0],
    file = item.files.find(f => f.kind === 'statement');
  const kept = Buffer.from(h.files.get(file.path));
  h.files.set(file.path, Buffer.from('corrupt'));
  await assert.rejects(h.api.download(bound, '50', r.statementId, file.fileId), /Retained file held/);
  await assert.rejects(h.api.issue(bound, {
    accountId: '50',
    statementId: r.statementId
  }), /Retained file held/);
  assert.equal(h.events.filter(e => e.eventId.startsWith(M.PREFIX)).length, 2);
  assert.equal((await h.api.list(bound, '50')).items[0].fileHealth, 'held');
  h.files.set(file.path, kept);
  assert.equal((await h.api.issue(bound, {
    accountId: '50',
    statementId: r.statementId
  })).reused, true);
  assert.deepEqual((await h.api.download(bound, '50', r.statementId, file.fileId)).bytes, kept);
});
test('unchanged non-due or coverage-held month exits before transactions, account writes, file or full financial reads', async () => {
  for (const gap of [false, true]) {
    const h = fixture();
    h.setNow(gap ? '2026-12-01T14:00:00Z' : '2026-11-04T14:00:00Z');
    if (gap) h.ledger.adoption.at = '2026-11-04T12:00:00Z';
    h.store.transaction = () => {
      throw Error('No transaction before eligible due month');
    };
    h.store.assertReady = () => {
      throw Error('No provisioning check before eligible due month');
    };
    const r = await h.api.issue(bound, {
      accountId: '50'
    });
    assert.equal(r.status, gap ? 'held' : 'not-due');
    assert.equal(h.files.size, 0);
    assert.equal(h.baselineReads, 0);
    assert.equal(h.deliveryReads, 0);
    assert.equal(h.events.length, 0);
  }
});
test('malformed pagination and future adoption never become positive monthly readiness', async () => {
  const h = fixture();
  for (const input of [{
    offset: NaN
  }, {
    offset: null
  }, {
    limit: 0
  }, {
    limit: NaN
  }, {
    offset: 20
  }, {
    expectedHash: 'foreign'
  }]) await assert.rejects(h.api.list(bound, '50', input));
  h.ledger.adoption.at = '2027-01-01T00:00:00Z';
  await assert.rejects(h.api.list(bound, '50'), /chronology/);
  assert.equal(h.files.size, 0);
});
for (const depth of [1, 2]) test('published predecessor chain depth ' + depth + ' holds late November money before a later statement', async () => {
  const h = fixture(),
    nov = await h.api.issue(bound, {
      accountId: '50'
    }),
    kept = clone(h.events.filter(r => r.eventId === M.PREFIX + nov.statementId));
  if (depth === 2) {
    h.setNow('2027-01-01T14:00:00Z');
    await h.api.issue(bound, {
      accountId: '50'
    });
  }
  h.setNow(depth === 1 ? '2027-01-01T14:00:00Z' : '2027-02-01T14:00:00Z');
  h.add(909);
  await h.settle();
  const before = h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length;
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }), /predecessor|carry|source changed/i);
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, before);
  for (const row of kept) assert.deepEqual(h.events.find(r => r._id === row._id), row);
  assert.equal((await h.api.list(bound, '50')).readiness.status, 'held');
});
test('published predecessor is checked at its own cutoff for accepted delivery drift', async () => {
  const h = fixture();
  let late = false;
  h.api = M.createBankMonthlyStatementService({
    ...h.options,
    loadDeliveryProof: async (b, id, period) => {
      if (late && period === '2026-11') throw Object.assign(Error('November accepted delivery is held'), {
        code: 'BANKING_STATEMENT_HELD'
      });
      return C.hash([]);
    }
  });
  await h.api.issue(bound, {
    accountId: '50'
  });
  h.setNow('2027-01-01T14:00:00Z');
  late = true;
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }), /November accepted delivery/);
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 2);
});
test('held predecessor file health blocks dependent month until exact original recovery verifies it', async () => {
  const h = fixture(),
    nov = await h.api.issue(bound, {
      accountId: '50'
    }),
    item = (await h.api.list(bound, '50')).items[0],
    file = item.files.find(f => f.kind === 'statement'),
    bytes = Buffer.from(h.files.get(file.path));
  h.files.set(file.path, Buffer.from('corrupt'));
  await assert.rejects(h.api.issue(bound, {
    accountId: '50',
    statementId: nov.statementId
  }));
  h.files.set(file.path, bytes);
  h.setNow('2027-01-01T14:00:00Z');
  const held = await h.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(held.status, 'held');
  assert.match(held.readiness.blockers.join(' '), /predecessor|health|held/i);
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 2);
  await h.api.issue(bound, {
    accountId: '50',
    statementId: nov.statementId
  });
  assert.equal((await h.api.issue(bound, {
    accountId: '50'
  })).status, 'published');
});
test('new feed publication after interrupted monthly planning does not rewrite frozen overlap or block original recovery', async () => {
  const h = fixture();
  h.add(88);
  await h.settle();
  h.lose();
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }), /reply lost/);
  const original = clone(h.events.find(r => r.eventId.startsWith(M.PREFIX)));
  h.store.listFeedRows = async () => clone(h.events.filter(r => r.eventId.startsWith('@feed')));
  const feeds = require(path.join(root, 'backend/src/modules/bank-feed-service')).createBankFeedService({
    store: h.store,
    artifacts: h.options.artifacts,
    authorize: h.options.authorize,
    loadActivity: h.options.loadActivity,
    now: h.options.now
  });
  const feed = await feeds.publishDue(bound, {
    accountId: '50'
  });
  assert.ok(feed.publicationId);
  const recovered = await h.api.issue(bound, {
    accountId: '50',
    statementId: original.payload.statementId
  });
  assert.equal(recovered.statementId, original.payload.statementId);
  assert.deepEqual(h.events.find(r => r._id === original._id), original);
  assert.deepEqual(original.payload.overlap, []);
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 2);
});
async function pairedSdkFixture(peerType = 'Bank') {
  const h = fixture(),
    baseGet = h.store.getLedger,
    peer = clone(h.ledger);
  peer.account = {
    ...peer.account,
    accountId: '51',
    accountType: peerType,
    balanceConvention: peerType === 'Credit Card' ? 'card-amount-owed' : 'bank-balance'
  };
  delete peer.contentHash;
  peer.balance = L.balances(peer);
  const {
    adoption,
    ...body
  } = peer;
  peer.contentHash = C.hash(body);
  h.store.getLedger = async (s, id) => id === '51' ? {
    ...scope,
    _id: C.hash({
      scope,
      kind: 'ledger-account',
      accountId: id
    }),
    kind: 'ledger-account',
    eventId: '@ledger:' + id,
    revision: 0,
    accountId: id,
    accountCurrency: 'CAD',
    sourceHash: peer.contentHash,
    contentHash: peer.contentHash,
    payload: clone(peer)
  } : baseGet(s, id);
  h.store.listInstructionActivity = async (s, id = '50') => ({
    rows: clone(h.events.filter(r => r.kind === 'instruction' && r.accountId === id)),
    revisions: clone(h.events.filter(r => r.kind === 'revision' && r.eventId.startsWith('@instruction:') && r.accountId === id))
  });
  h.store.listSettlementInstructions = async (s, cutoff, session, id) => clone(h.events.filter(r => r.kind === 'instruction' && r.accountId === id && !h.events.some(x => x.eventId === r.eventId && x.revision === 2)).slice(0, 100));
  h.store.loadFeedPeers = async (s, ids) => ({
    rows: clone(h.events.filter(r => r.kind === 'instruction' && ids.includes(r.payload.eventId))),
    revisions: clone(h.events.filter(r => r.kind === 'revision' && ids.some(id => r.eventId === '@instruction:' + id)))
  });
  let stamps = 0;
  const sdk = await sdkDelivery(h, {
    now: peerType === 'Credit Card' ? () => Date.parse(stamps++ === 0 ? '2026-11-30T03:59:59.999Z' : '2026-11-30T04:00:00.001Z') : undefined,
    entity: 'Transfer',
    payload: {
      TxnDate: '2026-11-27',
      CurrencyRef: {
        value: 'CAD'
      },
      FromAccountRef: {
        value: '50'
      },
      ToAccountRef: {
        value: '51'
      },
      Amount: 10
    },
    getAccount: async (s, id) => ({
      Id: id,
      Active: true,
      AccountType: id === '51' ? peerType : 'Bank',
      CurrencyRef: {
        value: 'CAD'
      }
    })
  });
  await sdk.deliver();
  h.setNow(peerType === 'Credit Card' ? '2026-11-30T14:00:00Z' : '2026-11-27T14:00:00Z');
  await h.settle();
  h.setNow('2026-12-01T14:00:00Z');
  return {
    h,
    sdk,
    peer
  };
}
test('default original Transfer proof rejects a hash-valid peer-only timing deferral before quiet monthly admission', async () => {
  const {
      h,
      sdk
    } = await pairedSdkFixture(),
    peer = h.events.find(r => r.accountId === '51' && r.revision === 1);
  assert.equal(peer.payload.schedule.expectedPostingDate, '2026-11-30');
  peer.payload.schedule.instrument = 'cheque';
  peer.payload.schedule.expectedPostingDate = '2026-12-04';
  peer.contentHash = C.hash(peer.payload);
  await assert.rejects(sdk.api.issue(bound, {
    accountId: '50'
  }), /peer|timing/i);
  assert.equal(h.files.size, 0);
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 0);
});
test('genuine asymmetric Bank/Card original timing proves after-cutoff pending without invented monthly money', async () => {
  const {
      h,
      sdk
    } = await pairedSdkFixture('Credit Card'),
    own = h.events.find(r => r.accountId === '50' && r.revision === 1),
    peer = h.events.find(r => r.accountId === '51' && r.revision === 1);
  assert.equal(own.payload.schedule.expectedPostingDate, '2026-11-30');
  assert.equal(peer.payload.schedule.expectedPostingDate, '2026-12-01');
  const result = await sdk.api.issue(bound, {
    accountId: '50'
  });
  assert.equal(result.rowCount, 0);
  const item = (await sdk.api.list(bound, '50')).items[0];
  assert.equal(item.closingMinor, 10000);
  assert.equal(item.pendingCount, 1);
});
test('final publication independently rechecks the published predecessor after new month files are written', async () => {
  const h = fixture(),
    nov = await h.api.issue(bound, {
      accountId: '50'
    });
  h.setNow('2027-01-01T14:00:00Z');
  h.afterWrite = async () => {
    h.add(991);
    await h.settle();
  };
  await assert.rejects(h.api.issue(bound, {
    accountId: '50'
  }), /predecessor.*source changed/i);
  const rows = h.events.filter(r => r.eventId.startsWith(M.PREFIX));
  assert.equal(rows.filter(r => r.payload.period === '2026-12').length, 1);
  assert.equal(rows.find(r => r.payload.period === '2026-12').revision, 1);
  assert.equal(rows.filter(r => r.payload.statementId === nov.statementId).length, 2);
});
test('final publication independently authenticates a peer schedule changed after file writes', async () => {
  const {
    h,
    sdk
  } = await pairedSdkFixture('Credit Card');
  h.afterWrite = async () => {
    const p = h.events.find(r => r.accountId === '51' && r.revision === 1);
    p.payload.schedule.instrument = 'cheque';
    p.payload.schedule.expectedPostingDate = '2026-12-07';
    p.contentHash = C.hash(p.payload);
  };
  await assert.rejects(sdk.api.issue(bound, {
    accountId: '50'
  }), /peer.*timing/i);
  assert.ok(h.files.size > 0);
  assert.equal(h.events.filter(r => r.eventId.startsWith(M.PREFIX)).length, 1);
});
test('stored original overlap is authenticated but later cumulative exports do not alter published verification', async () => {
  const h = fixture();
  h.add(662);
  await h.settle();
  h.store.listFeedRows = async () => clone(h.events.filter(r => r.eventId.startsWith('@feed')));
  const F = require(path.join(root, 'backend/src/modules/bank-feed-service')),
    feeds = F.createBankFeedService({
      store: h.store,
      artifacts: h.options.artifacts,
      authorize: h.options.authorize,
      loadActivity: h.options.loadActivity,
      now: h.options.now
    });
  await feeds.publishDue(bound, {
    accountId: '50'
  });
  const monthly = await h.api.issue(bound, {
      accountId: '50'
    }),
    original = clone(h.events.find(r => r.eventId === M.PREFIX + monthly.statementId && r.revision === 1));
  assert.equal(original.payload.overlap.length, 1);
  assert.match(original.payload.overlap[0].publicationHash, /^[a-f0-9]{64}$/);
  await feeds.publishCumulative(bound, {
    accountId: '50',
    fromDate: '2026-11-01',
    throughDate: '2026-11-30'
  });
  assert.equal((await h.api.issue(bound, {
    accountId: '50',
    statementId: monthly.statementId
  })).reused, true);
  assert.deepEqual(h.events.find(r => r._id === original._id), original);
  const pubId = original.payload.overlap[0].publicationId;
  for (let i = h.events.length - 1; i >= 0; i--) if (h.events[i].eventId === '@feed-publication:' + pubId) h.events.splice(i, 1);
  await assert.rejects(h.api.issue(bound, {
    accountId: '50',
    statementId: monthly.statementId
  }));
  assert.deepEqual(h.events.find(r => r._id === original._id), original);
});
