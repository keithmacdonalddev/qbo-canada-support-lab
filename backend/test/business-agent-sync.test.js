'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessAgentSync, PAGE_SIZE, ENTITIES } = require('../src/modules/business-agent-sync');
const scope = { environment: 'sandbox', realmId: '123456', connectionId: 'a'.repeat(24) };
const copy = value => JSON.parse(JSON.stringify(value));
const stamp = value => new Date(value).getTime();
function fixture(entities = ['Invoice']) {
  let clock = Date.parse('2026-10-23T12:00:00.000Z'), state = {}, denied = false, failSave = 0, failBulk = false, failSummary = false;
  const rows = new Map(), queries = [], calls = [], replies = [];
  const aggregate = pipeline => ({ option: async () => {
    assert.deepEqual(pipeline[0].$match, { ...scope, deleted: false });
    if (failSummary) throw new Error('fixture summary failed');
    const out = new Map();
    for (const row of rows.values()) if (!row.deleted) {
      const g = out.get(row.entity) || { _id: row.entity, records: 0, active: 0, open: 0, balance: 0, bank: 0, missingCurrency: 0 };
      g.records++; g.active += row.summary.active ? 1 : 0; g.open += row.summary.balanceCents > 0 ? 1 : 0;
      g.balance += row.summary.homeBalanceCents || 0; g.bank += row.summary.bankBalanceCents || 0;
      g.missingCurrency += row.summary.balanceCents > 0 && row.summary.homeBalanceCents === null ? 1 : 0;
      out.set(row.entity, g);
    }
    return [...out.values()];
  } });
  const Records = {
    aggregate,
    find() { const query = { select() { return query; }, sort() { return query; }, limit() { return query; }, maxTimeMS() { return query; }, lean: async () => [...rows.values()].filter(row => !row.deleted).slice(0, 20) }; return query; },
    async bulkWrite(ops) {
      if (failBulk) throw new Error('fixture mirror unavailable');
      for (const { updateOne: op } of ops) {
        assert.equal(op.filter.environment, scope.environment); assert.equal(op.filter.realmId, scope.realmId); assert.equal(op.filter.connectionId, scope.connectionId);
        const key = op.filter.entity + ':' + op.filter.qboId, previous = rows.get(key);
        if (previous && stamp(previous.lastReadStartedAt) > stamp(op.filter.$or[0].lastReadStartedAt.$lte)) throw Object.assign(new Error('newer mirror already present'), { code: 11000 });
        rows.set(key, { ...(previous || op.update.$setOnInsert), ...op.update.$set });
      }
    },
    async updateMany(filter, update) {
      for (const row of rows.values()) if (row.entity === filter.entity && row.generation !== filter.generation.$ne && stamp(row.lastReadStartedAt) <= stamp(filter.lastReadStartedAt.$lte)) Object.assign(row, update.$set);
    },
  };
  const respond = async control => { await control.beforeAttempt(); const result = replies.shift(); if (result instanceof Error) throw result; if (result === undefined) throw new Error('fixture response not supplied'); return copy(result); };
  const client = { query: async (query, control) => { queries.push(query); return respond(control); }, apiCall: async (method, endpoint, body, r, a, control) => { calls.push({ method, endpoint, body }); return respond(control); } };
  const options = { client, scope, Records, entities, assertClient: () => {}, now: () => clock, authorize: async () => { if (denied) throw Object.assign(new Error('lease revoked'), { code: 'LEASE_REVOKED' }); },
    loadState: async () => copy(state), saveState: async value => { if (failSave > 0) { failSave--; throw new Error('fixture cursor not committed'); } state = copy(value); } };
  const h = { rows, queries, calls, replies, options, sync: createBusinessAgentSync(options), state: () => copy(state), setState: value => { state = copy(value); },
    now: () => clock, advance: ms => { clock += ms; }, deny: () => { denied = true; }, failSave: () => { failSave = 1; }, failBulk: value => { failBulk = value; }, failSummary: value => { failSummary = value; },
    query: (entity, records, extra = {}) => ({ QueryResponse: { [entity]: records, startPosition: 1, maxResults: records.length, ...extra }, time: new Date(clock).toISOString() }),
    cdc: (entity, records, extra = {}) => ({ CDCResponse: [{ QueryResponse: [{ [entity]: records, startPosition: 1, maxResults: records.length, ...extra }] }], time: new Date(clock).toISOString() }),
  };
  return h;
}
const invoice = (Id, extra = {}) => ({ Id: String(Id), SyncToken: '0', TxnDate: '2026-10-23', TotalAmt: 120, Balance: 120, CurrencyRef: { value: 'CAD' }, MetaData: { LastUpdatedTime: '2026-10-23T11:59:00.000Z' }, ...extra });
async function initial(h, entity, records) { h.replies.push(h.query(entity, records), h.cdc(entity, [])); return h.sync.tick({ maxRequests: 2 }); }

test('keyset bootstrap resumes across process instances and CDC starts at first observation', async () => {
  const h = fixture(); const first = Array.from({ length: PAGE_SIZE }, (_, i) => invoice(i + 1));
  h.replies.push(h.query('Invoice', first)); await h.sync.tick({ maxRequests: 1 });
  const originalSince = h.state().sources.Invoice.since;
  assert.equal(h.state().sources.Invoice.lastId, '100'); assert.equal(h.state().sources.Invoice.status, 'bootstrap');
  h.advance(10000); h.sync = createBusinessAgentSync(h.options);
  h.replies.push(h.query('Invoice', [invoice(101)])); const pending = await h.sync.tick({ maxRequests: 1 });
  assert.equal(pending.status, 'catching-up'); assert.match(h.queries[1], /Id > '100'/); assert.doesNotMatch(h.queries[1], /STARTPOSITION/);
  assert.equal(h.state().sources.Invoice.since, originalSince);
  h.replies.push(h.cdc('Invoice', [])); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'current'); assert.equal(result.company.counts.openInvoices, 101);
  assert.equal(new URLSearchParams(h.calls[0].endpoint.split('?')[1]).get('changedSince'), originalSince);
  assert.equal(h.rows.size, 101);
});

test('a replacement generation tombstones old omissions only after full source plus CDC completes', async () => {
  const h = fixture(); await initial(h, 'Invoice', [invoice(1), invoice(2)]);
  const before = h.state(); before.sources.Invoice.since = '2026-09-01T00:00:00.000Z'; before.sources.Invoice.nextAt = null; h.setState(before);
  h.replies.push(h.query('Invoice', [invoice(2)])); const partial = await h.sync.tick({ maxRequests: 1 });
  assert.equal(partial.status, 'catching-up'); assert.equal(h.rows.get('Invoice:1').deleted, false);
  h.replies.push(h.cdc('Invoice', [])); await h.sync.tick({ maxRequests: 1 });
  assert.equal(h.rows.get('Invoice:1').deleted, true); assert.equal(h.rows.get('Invoice:2').deleted, false);
});

test('CDC deleted stubs remove current balances while retaining their identities', async () => {
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); h.advance(31000);
  h.replies.push(h.cdc('Invoice', [{ Id: '1', status: 'Deleted', sparse: true }])); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'current'); assert.equal(result.company.counts.openInvoices, 0); assert.equal(result.company.totals.receivables, 0);
  assert.equal(h.rows.get('Invoice:1').deleted, true); assert.equal(h.rows.get('Invoice:1').record.Id, '1');
});

test('a saturated CDC response never advances to current and starts replacement generation', async () => {
  const h = fixture(); h.replies.push(h.query('Invoice', [])); await h.sync.tick({ maxRequests: 1 });
  const generation = h.state().sources.Invoice.generation;
  h.replies.push(h.cdc('Invoice', Array.from({ length: 1000 }, (_, i) => invoice(i + 1)))); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'attention'); assert.equal(result.sources[0].status, 'saturated'); assert.equal(h.state().sources.Invoice.phase, 'bootstrap');
  assert.notEqual(h.state().sources.Invoice.generation, generation); assert.equal(h.rows.size, 0);
});

test('failed cursor persistence retries original keyset with idempotent mirror writes', async () => {
  const h = fixture(); h.replies.push(h.query('Invoice', Array.from({ length: PAGE_SIZE }, (_, i) => invoice(i + 1)))); h.failSave();
  const failed = await h.sync.tick({ maxRequests: 1 }); assert.equal(failed.sources[0].status, 'error'); assert.equal(h.state().sources.Invoice.lastId, null);
  h.advance(31000); h.replies.push(h.query('Invoice', Array.from({ length: PAGE_SIZE }, (_, i) => invoice(i + 1)))); await h.sync.tick({ maxRequests: 1 });
  assert.equal(h.queries[0], h.queries[1]); assert.equal(h.rows.size, 100); assert.equal(h.state().sources.Invoice.lastId, '100');
});

test('a mirror failure retains the source cursor and excludes partial observations from current', async () => {
  const h = fixture(); h.failBulk(true); h.replies.push(h.query('Invoice', [invoice(1)])); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'attention'); assert.equal(h.state().sources.Invoice.phase, 'bootstrap'); assert.equal(h.state().sources.Invoice.lastId, null);
  assert.equal(h.state().sources.Invoice.since, null);
});

test('revoked lease/access prevents any provider call or cached status read', async () => {
  const h = fixture(); h.deny(); await assert.rejects(h.sync.tick(), /lease revoked/); await assert.rejects(h.sync.snapshot(), /lease revoked/);
  assert.equal(h.queries.length, 0); assert.equal(h.calls.length, 0); assert.deepEqual(h.state(), {});
});

test('malformed and fault-bearing source envelopes are never interpreted as empty complete data', async () => {
  for (const body of [{ QueryResponse: {}, time: 'bad' }, { Fault: { Error: [] }, time: '2026-10-23T12:00:00.000Z' }, { QueryResponse: { Invoice: [], OtherEntity: [] }, time: '2026-10-23T12:00:00.000Z' }]) {
    const h = fixture(); h.replies.push(body); const result = await h.sync.tick({ maxRequests: 1 });
    assert.equal(result.status, 'attention'); assert.equal(result.sources[0].lastSuccessAt, null);
  }
});

test('CDC failures leave the previous complete cursor and figures visibly stale', async () => {
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); const since = h.state().sources.Invoice.since; h.advance(31000);
  h.replies.push({ CDCResponse: [{ QueryResponse: [{ Fault: { Error: [] } }] }], time: new Date(h.now()).toISOString() });
  const result = await h.sync.tick({ maxRequests: 1 }); assert.equal(result.status, 'attention'); assert.equal(h.state().sources.Invoice.since, since);
  assert.equal(result.company.counts.openInvoices, 1); assert.equal(result.company.provisional, true);
});

test('TimeActivity, tax sources and singletons refresh through complete snapshots without CDC', async () => {
  for (const entity of ['TimeActivity', 'TaxCode', 'TaxRate', 'CompanyInfo', 'Preferences']) {
    const h = fixture([entity]); h.replies.push(h.query(entity, [invoice(1)])); let result = await h.sync.tick({ maxRequests: 1 });
    assert.equal(result.status, 'current'); assert.equal(h.calls.length, 0);
    h.advance(entity === 'TimeActivity' ? 300001 : 31000); h.replies.push(h.query(entity, [invoice(1, { SyncToken: '1' })])); result = await h.sync.tick({ maxRequests: 1 });
    assert.equal(result.status, 'current'); assert.equal(h.rows.get(entity + ':1').record.SyncToken, '1');
  }
});

test('initial queries include inactive list records and have no offset or lifetime count ceiling', async () => {
  const h = fixture(['Customer']); h.replies.push(h.query('Customer', [{ Id: '1', DisplayName: 'Fixture inactive customer', Active: false }]));
  await h.sync.tick({ maxRequests: 1 }); assert.match(h.queries[0], /Active IN \(true, false\)/); assert.match(h.queries[0], /ORDERBY Id ASC/); assert.doesNotMatch(h.queries[0], /STARTPOSITION/);
});

test('one failed source does not prevent an independent source observation', async () => {
  const h = fixture(['Invoice', 'Bill']); h.replies.push(new Error('fixture upstream unavailable'), h.query('Bill', [invoice(3)]));
  const result = await h.sync.tick({ maxRequests: 2 }); assert.equal(h.queries.length, 2); assert.equal(result.sources.find(row => row.entity === 'Invoice').status, 'error');
  assert.equal(h.rows.get('Bill:3').deleted, false); assert.equal(result.company.totals.payables, 120);
});

test('the provider request allowance is bounded per slice, not by total mirrored records', async () => {
  const h = fixture(); for (let page = 0; page < 3; page++) h.replies.push(h.query('Invoice', Array.from({ length: PAGE_SIZE }, (_, i) => invoice(page * PAGE_SIZE + i + 1))));
  await h.sync.tick({ maxRequests: 2 }); assert.equal(h.queries.length, 2); assert.equal(h.rows.size, 200); assert.equal(h.state().sources.Invoice.lastId, '200');
  await h.sync.tick({ maxRequests: 1 }); assert.equal(h.rows.size, 300); assert.equal(h.state().sources.Invoice.lastId, '300');
});

test('summary read failures keep a truthful attention state without rolling back valid source cursors', async () => {
  const h = fixture(); h.failSummary(true); const result = await initial(h, 'Invoice', [invoice(1)]);
  assert.equal(result.status, 'attention'); assert.equal(h.state().sources.Invoice.status, 'current'); assert.equal(result.company.provisional, true); assert.match(result.summaryError, /summary/);
});

test('public snapshots contain compact data and do not re-query the provider or mirror', async () => {
  const h = fixture(); await initial(h, 'Invoice', [invoice(1, { PrivateNote: 'fixture private raw record' })]);
  const before = h.queries.length + h.calls.length; h.failSummary(true); const result = await h.sync.snapshot();
  assert.equal(h.queries.length + h.calls.length, before); assert.equal(JSON.stringify(result).includes('fixture private raw record'), false); assert.equal(result.status, 'current');
});

test('foreign currency balances are not silently summed into home-currency receivables', async () => {
  const h = fixture(); const result = await initial(h, 'Invoice', [invoice(1, { CurrencyRef: { value: 'USD' } })]);
  assert.equal(result.company.counts.openInvoices, 1); assert.equal(result.company.totals.receivables, 0); assert.equal(result.company.totals.incompleteCurrency, true);
});

test('unsupported source selection and malformed persisted cursors fail closed', async () => {
  const h = fixture(); assert.throws(() => createBusinessAgentSync({ ...h.options, entities: ['RawEndpoint'] }), /supported sources/);
  h.setState({ version: 1, sources: { Invoice: { entity: 'Invoice', phase: 'bootstrap', generation: 'fixture', startedAt: 'bad', lastId: null, since: null } }, nextEntity: 0 });
  await assert.rejects(h.sync.tick(), /cursor is invalid/); assert.equal(h.queries.length, 0); assert.ok(ENTITIES.includes('Invoice'));
});

test('production defaults refuse a substituted or wrongly scoped client before any call', async () => {
  const h = fixture(); const { assertClient, ...options } = h.options;
  await assert.rejects(createBusinessAgentSync(options).tick(), /client no longer matches/);
  assert.equal(h.queries.length, 0);
});

test('caller cancellation releases a pending read without committing a cursor', async () => {
  const h = fixture(), controller = new AbortController();
  h.client = h.options.client; h.client.query = async (_query, control) => { await control.beforeAttempt(); controller.abort(); return new Promise(() => {}); };
  const sync = createBusinessAgentSync({ ...h.options, signal: controller.signal });
  await assert.rejects(sync.tick(), /abort/i); assert.deepEqual(h.state(), {});
});

test('CDC omitted rows below the response limit retain the original change cursor', async () => {
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); const since = h.state().sources.Invoice.since; h.advance(31000);
  h.replies.push(h.cdc('Invoice', [invoice(2)], { totalCount: 2 })); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'attention'); assert.equal(result.sources[0].status, 'error'); assert.match(result.sources[0].error, /omitted declared/);
  assert.equal(h.state().sources.Invoice.since, since); assert.equal(h.rows.has('Invoice:2'), false);
});

test('a multi-slice TimeActivity replacement exposes its cadence and previous complete freshness', async () => {
  const h = fixture(['TimeActivity']); const page = Array.from({ length: PAGE_SIZE }, (_, i) => invoice(i + 1));
  h.replies.push(h.query('TimeActivity', page), h.query('TimeActivity', [])); let result = await h.sync.tick({ maxRequests: 2 });
  assert.equal(result.status, 'current'); assert.equal(result.sources[0].refreshEverySeconds, 300);
  h.advance(300001); h.replies.push(h.query('TimeActivity', page)); result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.sources[0].status, 'current'); assert.equal(result.sources[0].refreshing, true);
  h.advance(300001); const stale = await h.sync.snapshot(); assert.equal(stale.status, 'catching-up'); assert.equal(stale.company.provisional, true);
});
