'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessAgentSync, PAGE_SIZE, ENTITIES } = require('../src/modules/business-agent-sync');
const scope = { environment: 'sandbox', realmId: '123456', connectionId: 'a'.repeat(24) };
const copy = value => JSON.parse(JSON.stringify(value));
const stamp = value => new Date(value).getTime();
function fixture(entities = ['Invoice']) {
  let clock = Date.parse('2026-10-23T12:00:00.000Z'), state = {}, denied = false, failSave = 0, failBulk = false, failSummary = false;
  const rows = new Map(), queries = [], calls = [], replies = [], admitted = [];
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
    find(filter) {
      assert.equal(filter.environment, scope.environment); assert.equal(filter.realmId, scope.realmId); assert.equal(filter.connectionId, scope.connectionId);
      let limit = Infinity;
      const query = { select() { return query; }, sort() { return query; }, limit(n) { limit = n; return query; }, maxTimeMS() { return query; },
        lean: async () => [...rows.values()].filter(row => !row.deleted && (typeof filter.entity === 'string' ? row.entity === filter.entity : !filter.entity?.$nin?.includes(row.entity))).slice(0, limit) }; return query;
    },
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
  const respond = async (control, request) => { await control.beforeAttempt(); admitted.push({ request, category: require('../src/modules/qbo-request-meter').categorize('GET', request) }); const result = replies.shift(); if (result instanceof Error) throw result; if (result === undefined) throw new Error('fixture response not supplied'); return copy(typeof result === 'function' ? result(request) : result); };
  const client = { query: async (query, control) => { queries.push(query); return respond(control, query); }, apiCall: async (method, endpoint, body, r, a, control) => { calls.push({ method, endpoint, body }); return respond(control, endpoint); } };
  const options = { client, scope, Records, entities, homeCurrency: 'CAD', assertClient: () => {}, now: () => clock, authorize: async () => { if (denied) throw Object.assign(new Error('lease revoked'), { code: 'LEASE_REVOKED' }); },
    loadState: async () => copy(state), saveState: async value => { if (failSave > 0) { failSave--; throw new Error('fixture cursor not committed'); } state = copy(value); } };
  const h = { rows, queries, calls, replies, admitted, options, sync: createBusinessAgentSync(options), state: () => copy(state), setState: value => { state = copy(value); },
    now: () => clock, advance: ms => { clock += ms; }, deny: () => { denied = true; }, failSave: () => { failSave = 1; }, failBulk: value => { failBulk = value; }, failSummary: value => { failSummary = value; },
    query: (entity, records, extra = {}) => ({ QueryResponse: { [entity]: records, startPosition: 1, maxResults: records.length, ...extra }, time: new Date(clock).toISOString() }),
    cdc: (entity, records, extra = {}) => ({ CDCResponse: [{ QueryResponse: [{ [entity]: records, startPosition: 1, maxResults: records.length, ...extra }] }], time: new Date(clock).toISOString() }),
    // A combined change response: [[entity, records], ...]; null adds an empty block (no changes).
    cdcMany: blocks => ({ CDCResponse: [{ QueryResponse: blocks.map(block => block === null ? {} : { [block[0]]: block[1], startPosition: 1, maxResults: block[1].length }) }], time: new Date(clock).toISOString() }),
  };
  return h;
}
const invoice = (Id, extra = {}) => ({ Id: String(Id), SyncToken: '0', TxnDate: '2026-10-23', TotalAmt: 120, Balance: 120, CurrencyRef: { value: 'CAD' }, MetaData: { LastUpdatedTime: '2026-10-23T11:59:00.000Z' }, ...extra });
async function initial(h, entity, records) { h.replies.push(h.query(entity, records), h.cdc(entity, [])); return h.sync.tick({ maxRequests: 2 }); }

test('keyset bootstrap resumes across process instances and CDC starts at first observation', async () => {
  const h = fixture(); const first = Array.from({ length: PAGE_SIZE }, (_, i) => invoice(i + 1));
  h.replies.push(h.query('Invoice', first)); await h.sync.tick({ maxRequests: 1 });
  const originalSince = h.state().sources.Invoice.since;
  assert.equal(h.state().sources.Invoice.lastId, String(PAGE_SIZE)); assert.equal(h.state().sources.Invoice.status, 'bootstrap');
  assert.match(h.queries[0], /MAXRESULTS 1000$/, 'full 1,000-row pages keep re-reads cheap');
  h.advance(10000); h.sync = createBusinessAgentSync(h.options);
  h.replies.push(h.query('Invoice', [invoice(PAGE_SIZE + 1)])); const pending = await h.sync.tick({ maxRequests: 1 });
  assert.equal(pending.status, 'catching-up'); assert.match(h.queries[1], new RegExp("Id > '" + PAGE_SIZE + "'")); assert.doesNotMatch(h.queries[1], /STARTPOSITION/);
  assert.equal(h.state().sources.Invoice.since, originalSince);
  h.replies.push(h.cdc('Invoice', [])); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'current'); assert.equal(result.company.counts.openInvoices, PAGE_SIZE + 1);
  assert.equal(new URLSearchParams(h.calls[0].endpoint.split('?')[1]).get('changedSince'), originalSince);
  assert.equal(h.rows.size, PAGE_SIZE + 1);
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
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); h.advance(300001);
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
  assert.equal(h.queries[0], h.queries[1]); assert.equal(h.rows.size, PAGE_SIZE); assert.equal(h.state().sources.Invoice.lastId, String(PAGE_SIZE));
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
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); const since = h.state().sources.Invoice.since; h.advance(300001);
  h.replies.push({ CDCResponse: [{ QueryResponse: [{ Fault: { Error: [] } }] }], time: new Date(h.now()).toISOString() });
  const result = await h.sync.tick({ maxRequests: 1 }); assert.equal(result.status, 'attention'); assert.equal(h.state().sources.Invoice.since, since);
  assert.equal(result.company.counts.openInvoices, 1); assert.equal(result.company.provisional, true);
});

test('TimeActivity, tax sources and singletons refresh through complete snapshots without CDC', async () => {
  for (const entity of ['TimeActivity', 'TaxCode', 'TaxRate', 'CompanyInfo', 'Preferences']) {
    const h = fixture([entity]); const currency = entity === 'Preferences' ? { CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } } : {}; h.replies.push(h.query(entity, [invoice(1, currency)])); let result = await h.sync.tick({ maxRequests: 1 });
    assert.equal(result.status, 'current'); assert.equal(h.calls.length, 0);
    assert.equal(result.sources[0].refreshEverySeconds, entity === 'TimeActivity' ? 1800 : 21600, 'snapshots re-read every 30 business-hour minutes (time) or 6 hours (reference data)');
    h.advance(entity === 'TimeActivity' ? 1799000 : 21599000); await h.sync.tick({ maxRequests: 1 });
    assert.equal(h.queries.length, 1, 'not re-read before its cadence'); assert.equal(h.state().sources[entity].status, 'current');
    h.advance(entity === 'TimeActivity' ? 1800001 : 21600001); h.replies.push(h.query(entity, [invoice(1, { SyncToken: '1', ...currency })])); result = await h.sync.tick({ maxRequests: 1 });
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
  await h.sync.tick({ maxRequests: 2 }); assert.equal(h.queries.length, 2); assert.equal(h.rows.size, 2 * PAGE_SIZE); assert.equal(h.state().sources.Invoice.lastId, String(2 * PAGE_SIZE));
  await h.sync.tick({ maxRequests: 1 }); assert.equal(h.rows.size, 3 * PAGE_SIZE); assert.equal(h.state().sources.Invoice.lastId, String(3 * PAGE_SIZE));
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
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); const since = h.state().sources.Invoice.since; h.advance(300001);
  h.replies.push(h.cdc('Invoice', [invoice(2)], { totalCount: 2 })); const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'attention'); assert.equal(result.sources[0].status, 'error'); assert.match(result.sources[0].error, /omitted declared/);
  assert.equal(h.state().sources.Invoice.since, since); assert.equal(h.rows.has('Invoice:2'), false);
});

test('a multi-slice TimeActivity replacement exposes its cadence and previous complete freshness', async () => {
  const h = fixture(['TimeActivity']); const page = Array.from({ length: PAGE_SIZE }, (_, i) => invoice(i + 1));
  h.replies.push(h.query('TimeActivity', page), h.query('TimeActivity', [])); let result = await h.sync.tick({ maxRequests: 2 });
  assert.equal(result.status, 'current'); assert.equal(result.sources[0].refreshEverySeconds, 1800);
  h.advance(1800001); h.replies.push(h.query('TimeActivity', page)); result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.sources[0].status, 'current'); assert.equal(result.sources[0].refreshing, true);
  h.advance(1800001); const stale = await h.sync.snapshot(); assert.equal(stale.status, 'catching-up'); assert.equal(stale.company.provisional, true);
});

test('unobserved home currency never labels available HomeBalance as CAD', async () => {
  const h=fixture(); h.sync=createBusinessAgentSync({...h.options,homeCurrency:null});
  const result=await initial(h,'Invoice',[invoice(1,{HomeBalance:120})]);
  assert.equal(result.company.totals.currency,null); assert.equal(result.company.totals.receivables,null); assert.equal(result.company.totals.incompleteCurrency,true);
});
test('Preferences provides the independently observed home currency before totals are published', async () => {
  const h=fixture(['Preferences']); h.sync=createBusinessAgentSync({...h.options,homeCurrency:null});
  h.replies.push(h.query('Preferences',[{Id:'1',CurrencyPrefs:{HomeCurrency:{value:'USD'}}}]));
  const result=await h.sync.tick({maxRequests:1}); assert.equal(h.state().homeCurrency,'USD'); assert.equal(result.company.totals.currency,'USD');
});

test('an old provider response cannot become a fresh company observation',async()=>{
  const h=fixture();const response=h.query('Invoice',[invoice(1)]);response.time='2026-10-23T11:00:00.000Z';h.replies.push(response);
  const result=await h.sync.tick({maxRequests:1});assert.equal(result.sources[0].status,'error');assert.equal(result.lastSuccessAt,null);
});

// Sync tuning (2026-10-31): one combined change (CDC) read for every incremental source.
const entitiesOf = endpoint => new URLSearchParams(endpoint.split('?')[1]).get('entities');
const bill = (Id, extra = {}) => invoice(Id, { TotalAmt: 50, Balance: 50, ...extra });
const bill1 = () => bill(1);
async function current3() {
  const h = fixture(['Invoice', 'Bill', 'Customer']);
  h.replies.push(h.query('Invoice', [invoice(1), invoice(2)]), h.query('Bill', [bill(1)]), h.query('Customer', [{ Id: '1', DisplayName: 'Fixture customer' }]),
    h.cdc('Invoice', []), h.cdc('Bill', []), h.cdc('Customer', []));
  const result = await h.sync.tick({ maxRequests: 6 }); assert.equal(result.status, 'current');
  return h;
}
test('one combined change read refreshes every incremental source, applies changes and deletions, and dates each as of its response', async () => {
  const h = await current3(); const before = h.calls.length, since = h.state().sources.Invoice.since;
  h.advance(150000); let result = await h.sync.tick({ maxRequests: 12 });
  assert.equal(h.calls.length, before, 'nothing is read before the five minutes are up'); assert.equal(result.status, 'current');
  h.advance(150001);
  h.replies.push(h.cdcMany([['Invoice', [invoice(2, { Balance: 0, SyncToken: '1' }), invoice(3)]], null, ['Bill', [{ Id: '1', status: 'Deleted', sparse: true }]]]));
  const readAt = h.now(); result = await h.sync.tick({ maxRequests: 12 });
  assert.equal(h.calls.length, before + 1, 'one request covers all three sources');
  assert.deepEqual(entitiesOf(h.calls.at(-1).endpoint).split(',').sort(), ['Bill', 'Customer', 'Invoice']);
  assert.equal(new URLSearchParams(h.calls.at(-1).endpoint.split('?')[1]).get('changedSince'), since);
  assert.equal(h.rows.get('Invoice:2').record.SyncToken, '1'); assert.equal(h.rows.get('Invoice:3').deleted, false);
  assert.equal(h.rows.get('Bill:1').deleted, true, 'a deleted stub with an Id shared by another entity is applied to its own entity');
  assert.equal(h.rows.get('Invoice:1').deleted, false); assert.equal(result.company.totals.payables, 0);
  for (const source of result.sources) { assert.equal(source.status, 'current'); assert.equal(source.lastSuccessAt, new Date(readAt).toISOString()); assert.equal(source.freshUntil, new Date(readAt + 600000).toISOString()); assert.equal(source.refreshEverySeconds, 300); }
  assert.equal(result.nextDueAt, new Date(readAt + 300000).toISOString(), 'the service can sleep until the next combined read');
  const saved = h.state().sources; assert.ok(Object.values(saved).every(source => source.since === saved.Invoice.since && source.since > since));
  h.advance(600001); const stale = await h.sync.snapshot(); assert.notEqual(stale.status, 'current', 'without another read the sources go stale');
});
test('a combined response at the change limit persists nothing and falls back to per-source reads, then rejoins', async () => {
  const h = await current3(); const cursors = h.state().sources; h.advance(300001);
  h.replies.push(h.cdcMany([['Invoice', Array.from({ length: 600 }, (_, i) => invoice(i + 10))], ['Bill', Array.from({ length: 400 }, (_, i) => bill(i + 10))]]));
  let result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.status, 'attention'); assert.equal(h.rows.has('Invoice:10'), false, 'nothing from a possibly truncated response is saved');
  for (const entity of ['Invoice', 'Bill', 'Customer']) { const source = h.state().sources[entity]; assert.equal(source.status, 'saturated'); assert.equal(source.solo, true); assert.equal(source.since, cursors[entity].since); }
  const calls = h.calls.length;
  for (let i = 0; i < 3; i++) h.replies.push(endpoint => entitiesOf(endpoint) === 'Invoice' ? h.cdc('Invoice', [invoice(10)]) : h.cdc(entitiesOf(endpoint), []));
  result = await h.sync.tick({ maxRequests: 3 });
  assert.deepEqual(h.calls.slice(calls).map(call => entitiesOf(call.endpoint)).sort(), ['Bill', 'Customer', 'Invoice'], 'each source is read on its own');
  assert.equal(result.status, 'current'); assert.equal(h.rows.has('Invoice:10'), true); assert.ok(Object.values(h.state().sources).every(source => source.solo === undefined));
  h.advance(300001); h.replies.push(h.cdcMany([])); await h.sync.tick({ maxRequests: 3 });
  assert.equal(h.calls.length, calls + 4); assert.equal(entitiesOf(h.calls.at(-1).endpoint).split(',').length, 3, 'the sources rejoin the combined read');
});
test('a rejected combined read keeps every cursor and finds the failing source; transient failures retry combined with backoff', async () => {
  const h = await current3(); const cursors = h.state().sources; h.advance(300001);
  h.replies.push(h.cdcMany([['Invoice', []], ['Estimate', []]]));
  let result = await h.sync.tick({ maxRequests: 1 }); assert.equal(result.status, 'attention');
  for (const entity of ['Invoice', 'Bill', 'Customer']) { const source = h.state().sources[entity]; assert.equal(source.status, 'error'); assert.equal(source.solo, true); assert.equal(source.since, cursors[entity].since); assert.match(source.error, /unexpected or failed entity/); }
  const fresh = await current3(); fresh.advance(300001); const since = fresh.state().sources.Bill.since;
  fresh.replies.push(Object.assign(new Error('fixture upstream unavailable'), { status: 503 }));
  result = await fresh.sync.tick({ maxRequests: 12 }); assert.equal(fresh.calls.length, 4, 'a transient failure is not multiplied into per-source reads');
  const failed = fresh.state().sources.Bill; assert.equal(failed.solo, undefined); assert.equal(failed.failures, 1); assert.equal(failed.since, since); assert.equal(failed.nextAt, new Date(fresh.now() + 30000).toISOString());
  fresh.advance(30001); fresh.replies.push(Object.assign(new Error('fixture upstream unavailable'), { status: 503 })); await fresh.sync.tick({ maxRequests: 12 });
  assert.equal(fresh.state().sources.Bill.nextAt, new Date(fresh.now() + 60000).toISOString(), 'consecutive failures back off');
  fresh.advance(60001); fresh.replies.push(fresh.cdcMany([])); result = await fresh.sync.tick({ maxRequests: 12 });
  assert.equal(result.status, 'current'); assert.equal(fresh.state().sources.Bill.failures, undefined);
});

test('the combined read is due every 5 minutes in Halifax business hours and every 15 outside them', async () => {
  const h = await current3(); h.advance(9 * 3600000); // 18:00 Halifax: closed
  h.replies.push(h.cdcMany([])); let result = await h.sync.tick({ maxRequests: 12 });
  assert.equal(result.sources.find(row => row.entity === 'Invoice').refreshEverySeconds, 900);
  assert.equal(result.nextDueAt, new Date(h.now() + 900000).toISOString());
  const calls = h.calls.length; h.advance(600000); result = await h.sync.tick({ maxRequests: 12 });
  assert.equal(h.calls.length, calls); assert.equal(result.status, 'current', 'a read outside hours stays current for 30 minutes');
  h.advance(300001); h.replies.push(h.cdcMany([])); await h.sync.tick({ maxRequests: 12 }); assert.equal(h.calls.length, calls + 1);
});
test('a write-bearing freshness demand reads changes now; a read just made satisfies the next demand', async () => {
  const h = await current3(); h.advance(120001); const calls = h.calls.length;
  let result = await h.sync.tick({ maxRequests: 12 }); assert.equal(h.calls.length, calls, 'nothing is due yet');
  assert.equal(result.status, 'current');
  h.replies.push(h.cdcMany([['Invoice', [invoice(9)]]])); result = await h.sync.tick({ maxRequests: 2, freshWithinMs: 120000 });
  assert.equal(h.calls.length, calls + 1); assert.equal(entitiesOf(h.calls.at(-1).endpoint).split(',').length, 3, 'one combined read');
  assert.ok(result.sources.every(source => source.lastSuccessAt === new Date(h.now()).toISOString())); assert.equal(h.rows.has('Invoice:9'), true);
  h.advance(30000); await h.sync.tick({ maxRequests: 2, freshWithinMs: 120000 }); assert.equal(h.calls.length, calls + 1);
  await assert.rejects(h.sync.tick({ freshWithinMs: 10 }), /freshness demand/);
});
test('the nightly sweep compares QuickBooks counts with the mirror and fully re-reads only a source that differs', async () => {
  const h = await current3(); h.advance(17 * 3600000 + 10 * 60000); // Saturday 02:10 Halifax
  h.replies.push(h.cdcMany([]), aging(h, 'AgedReceivables', '240.00'), aging(h, 'AgedPayables', '50.00'));
  const counts = { Invoice: 2, Bill: 2, Customer: 1 };
  for (let i = 0; i < 3; i++) h.replies.push(query => { const entity = /FROM (\w+)/.exec(query)[1]; return { QueryResponse: { totalCount: counts[entity] }, time: new Date(h.now()).toISOString() }; });
  let result = await h.sync.tick({ maxRequests: 12 });
  const sweep = h.queries.filter(query => query.startsWith('SELECT COUNT(*)'));
  assert.deepEqual(sweep, ['SELECT COUNT(*) FROM Invoice', 'SELECT COUNT(*) FROM Bill', 'SELECT COUNT(*) FROM Customer WHERE Active IN (true, false)']);
  assert.equal(h.state().sources.Invoice.reconciledOn, '2026-10-24'); assert.equal(h.state().sources.Invoice.phase, 'incremental');
  const bill = h.state().sources.Bill; assert.equal(bill.phase, 'bootstrap'); assert.match(bill.reconcileError, /found 2 records in QuickBooks and 1 here/);
  assert.notEqual(result.status, 'current', 'a source that differs is not current until it is re-read');
  h.replies.push(h.query('Bill', [bill1(), invoice(2, { TotalAmt: 50, Balance: 50 })]), h.cdc('Bill', []));
  result = await h.sync.tick({ maxRequests: 12 });
  assert.equal(result.status, 'current'); assert.equal(h.state().sources.Bill.reconciledOn, '2026-10-24'); assert.equal(h.state().sources.Bill.reconcileError, undefined);
  assert.equal(h.rows.get('Bill:2').deleted, false);
  const before = h.queries.length; h.advance(60000); h.replies.push(h.cdcMany([])); await h.sync.tick({ maxRequests: 12 });
  assert.equal(h.queries.length, before, 'each source is swept once per Halifax day');
});


// Nightly amount evidence uses sanitized provider fixtures and an in-memory CompanySyncRecord adapter.
function aging(h, report, total, extra = {}) {
  return { Header: { ReportName: report, Time: new Date(h.now()).toISOString(), Currency: 'CAD', Option: [{ Name: 'report_date', Value: '2026-10-24' }] },
    Columns: { Column: [{ ColTitle: '', ColType: 'Customer' }, { ColTitle: 'Current', ColType: 'Money' }, { ColTitle: 'Total', ColType: 'Money' }] },
    Rows: { Row: [{ group: 'GrandTotal', type: 'Section', Summary: { ColData: [{ value: 'TOTAL' }, { value: total }, { value: total }] } }] }, ...extra };
}
const bank = (Id, balance = 100, type = 'Bank', currency = 'CAD') => ({ Id: String(Id), Name: 'Fixture private account', AccountType: type, CurrentBalance: balance, CurrencyRef: { value: currency } });
async function nightlyInvoice() {
  const h = fixture(['Invoice', 'Payment', 'CreditMemo', 'JournalEntry', 'RefundReceipt', 'Deposit', 'Purchase']);
  h.replies.push(...h.options.entities.map(entity => h.query(entity, entity === 'Invoice' ? [invoice(1)] : [])), ...h.options.entities.map(entity => h.cdc(entity, [])));
  await h.sync.tick({ maxRequests: h.options.entities.length * 2 });
  h.advance(17 * 3600000 + 10 * 60000); // Saturday 02:10 Halifax
  return h;
}
async function nightlyAmounts() {
  const h = fixture(['Invoice', 'Bill', 'Account', 'Payment', 'CreditMemo', 'VendorCredit', 'BillPayment', 'JournalEntry', 'RefundReceipt', 'Deposit', 'Purchase']);
  const accounts = [bank(1, 100.01), bank(2, -12.34, 'Credit Card'), bank(3, 7.89, 'Bank', 'USD')];
  const records = { Invoice: [invoice(1, { Balance: 0.1 }), invoice(2, { Balance: 0.2 })], Bill: [bill(1)], Account: accounts };
  h.replies.push(...h.options.entities.map(entity => h.query(entity, records[entity] || [])), ...h.options.entities.map(entity => h.cdc(entity, [])));
  await h.sync.tick({ maxRequests: h.options.entities.length * 2 });
  h.advance(17 * 3600000 + 10 * 60000);
  return { h, accounts };
}

test('nightly amount proof matches both aging totals and each bank/credit card to the cent in four metered requests', async () => {
  const { h, accounts } = await nightlyAmounts(), before = h.admitted.length;
  // The pre-check CDC picks up a payment made since the preceding observation.
  h.replies.push(h.cdcMany([['Bill', [bill(1, { Balance: 40.01 })]]]), aging(h, 'AgedReceivables', '0.30'), aging(h, 'AgedPayables', '40.01'), h.query('Account', accounts));
  const result = await h.sync.tick({ maxRequests: 4 }), proof = result.amountReconciliation;
  assert.equal(proof.status, 'matched'); assert.equal(proof.toleranceCents, 0); assert.equal(result.status, 'current'); assert.equal(result.company.provisional, false);
  assert.equal(proof.checks.receivables.mirrorCents, 30); assert.equal(proof.checks.receivables.qboCents, 30);
  assert.equal(proof.checks.payables.mirrorCents, 4001); assert.equal(proof.checks.payables.qboCents, 4001);
  assert.deepEqual(proof.checks.accounts.accounts.map(row => [row.qboId, row.mirrorCents, row.qboCents]), [['1', 10001, 10001], ['2', -1234, -1234], ['3', 789, 789]]);
  assert.ok(Object.values(proof.checks).every(row => row.checkedAt === new Date(h.now()).toISOString() && row.cdcAt === row.checkedAt));
  assert.equal(h.admitted.length - before, 4); assert.ok(h.admitted.slice(before).every(row => row.category === 'sync'));
  assert.match(h.admitted[before].request, /^cdc\?/); assert.equal(h.admitted.slice(before).filter(row => /FROM Account/.test(row.request)).length, 1);
  assert.equal(JSON.stringify(proof).includes('Fixture private account'), false); assert.match(proof.note, /not atomic/);
  const queries = h.admitted.length; h.sync = createBusinessAgentSync(h.options);
  assert.deepEqual((await h.sync.snapshot()).amountReconciliation, proof); assert.equal(h.admitted.length, queries, 'status reads never fetch live evidence');
  // Finishing the existing COUNT sweep costs its existing three requests; amount checks do not repeat.
  h.replies.push(...[2, 1, 3].map(totalCount => ({ QueryResponse: { totalCount }, time: new Date(h.now()).toISOString() })));
  await h.sync.tick({ maxRequests: 3 }); assert.ok(h.admitted.slice(queries).every(row => row.request.startsWith('SELECT COUNT(*)')));
});

test('an amount mismatch resyncs only the affected source and performs one successful re-check across restart', async () => {
  const h = await nightlyInvoice(), before = h.admitted.length;
  h.replies.push(h.cdc('Invoice', []), aging(h, 'AgedReceivables', '100.00'));
  const pending = await h.sync.tick({ maxRequests: 2 });
  assert.equal(pending.amountReconciliation.checks.receivables.status, 'resyncing'); assert.equal(pending.status, 'attention');
  assert.equal(h.state().sources.Invoice.phase, 'bootstrap'); assert.equal(pending.amountReconciliation.checks.receivables.initialMismatch.mirrorCents, 12000);
  h.sync = createBusinessAgentSync(h.options);
  h.replies.push(h.query('Invoice', [invoice(1, { Balance: 100 })]), h.cdc('Invoice', []), aging(h, 'AgedReceivables', '100.00'));
  const result = await h.sync.tick({ maxRequests: 3 }), proof = result.amountReconciliation.checks.receivables;
  assert.equal(result.status, 'current'); assert.equal(proof.status, 'matched'); assert.equal(proof.attempts, 2); assert.equal(proof.mirrorCents, 10000);
  assert.equal(proof.initialMismatch.mirrorCents, 12000); assert.equal(h.admitted.length - before, 5);
  assert.equal(h.admitted.slice(before).filter(row => /^SELECT \* FROM/.test(row.request)).length, 1);
});

test('persistent amount mismatch stays visible as a sync problem and never loops another full resync that night', async () => {
  const h = await nightlyInvoice(); h.replies.push(h.cdc('Invoice', []), aging(h, 'AgedReceivables', '119.99'));
  await h.sync.tick({ maxRequests: 2 });
  h.replies.push(h.query('Invoice', [invoice(1)]), h.cdc('Invoice', []), aging(h, 'AgedReceivables', '119.99'));
  let result = await h.sync.tick({ maxRequests: 3 });
  assert.equal(result.amountReconciliation.status, 'attention'); assert.equal(result.amountReconciliation.checks.receivables.status, 'mismatched');
  assert.equal(result.amountReconciliation.checks.receivables.mirrorCents, 12000); assert.equal(result.amountReconciliation.checks.receivables.qboCents, 11999);
  assert.match(result.amountReconciliation.checks.receivables.error, /after a full resync and one re-check/);
  assert.equal(result.status, 'attention'); assert.equal(result.company.provisional, true);
  // Complete the independent COUNT sweep for the added credit/payment sources.
  h.replies.push(...h.options.entities.slice(1).map(() => ({ QueryResponse: { totalCount: 0 }, time: new Date(h.now()).toISOString() })));
  await h.sync.tick({ maxRequests: h.options.entities.length - 1 });
  const before = h.admitted.length; result = await h.sync.tick({ maxRequests: 8 });
  assert.equal(result.status, 'attention'); assert.equal(h.admitted.length, before); assert.equal(h.state().sources.Invoice.phase, 'incremental');
});

test('one-request slices respect the allowance and resume all pending amount checks without repeating CDC', async () => {
  const { h, accounts } = await nightlyAmounts(), before = h.admitted.length;
  h.replies.push(h.cdcMany([]), aging(h, 'AgedReceivables', '0.30'), aging(h, 'AgedPayables', '50.00'), h.query('Account', accounts));
  for (let i = 0; i < 4; i++) {
    const result = await h.sync.tick({ maxRequests: 1 });
    assert.equal(h.admitted.length - before, i + 1); assert.equal(result.amountReconciliation.status, i === 3 ? 'matched' : 'checking');
    h.sync = createBusinessAgentSync(h.options);
  }
  assert.equal(h.admitted.slice(before).filter(row => row.request.startsWith('cdc?')).length, 1);
});

test('a nightly amount check forces fresh CDC even if the normal cadence is not due', async () => {
  const h = await nightlyInvoice(), state = h.state();
  state.sources.Invoice.lastSuccessAt = new Date(h.now() - 30000).toISOString(); state.sources.Invoice.nextAt = new Date(h.now() + 600000).toISOString(); h.setState(state);
  const before = h.admitted.length;
  h.replies.push(h.cdc('Invoice', [invoice(1, { Balance: 25 })]), aging(h, 'AgedReceivables', '25.00'));
  const result = await h.sync.tick({ maxRequests: 2 });
  assert.match(h.admitted[before].request, /^cdc\?/); assert.equal(result.amountReconciliation.checks.receivables.mirrorCents, 2500);
});

test('failed pre-check CDC cannot produce a false nightly amount match', async () => {
  const h = await nightlyInvoice(), before = h.admitted.length;
  h.replies.push(Object.assign(new Error('fixture upstream unavailable'), { status: 503 }));
  const result = await h.sync.tick({ maxRequests: 4 });
  assert.equal(h.admitted.length - before, 1); assert.equal(result.status, 'attention'); assert.equal(result.amountReconciliation.checks.receivables.status, 'waiting');
});

test('CDC beyond its 29-day safety lookback fully resyncs before any change read, even with a future saved schedule', async () => {
  for (const oldField of ['since', 'lastSuccessAt']) {
    const h = fixture(); await initial(h, 'Invoice', [invoice(1)]);
    const state = h.state(); state.sources.Invoice[oldField] = new Date(h.now() - 29 * 86400000 - 1).toISOString();
    state.sources.Invoice.nextAt = new Date(h.now() + 600000).toISOString(); h.setState(state);
    const before = h.admitted.length;
    h.replies.push(h.query('Invoice', [invoice(2)])); let result = await h.sync.tick({ maxRequests: 1 });
    assert.match(h.admitted[before].request, /^SELECT \* FROM Invoice/); assert.equal(result.status, 'catching-up'); assert.equal(h.rows.get('Invoice:1').deleted, false);
    h.replies.push(h.cdc('Invoice', [])); result = await h.sync.tick({ maxRequests: 1 });
    assert.equal(result.status, 'current'); assert.equal(h.rows.get('Invoice:1').deleted, true); assert.equal(h.rows.get('Invoice:2').deleted, false);
  }
});

test('malformed, stale, wrong-currency, or missing aging totals are unverified errors rather than zero/matched', async () => {
  for (const invalid of [
    h => ({ Fault: { Error: [] } }),
    h => aging(h, 'AgedReceivables', ''),
    h => aging(h, 'AgedReceivables', '120.00', { Rows: { Row: [] } }),
    h => aging(h, 'AgedReceivables', '120.00', { Header: { ReportName: 'AgedReceivables', Time: new Date(h.now()).toISOString(), Currency: 'USD' } }),
    h => aging(h, 'AgedReceivables', '120.00', { Header: { ReportName: 'AgedReceivables', Time: new Date(h.now() - 3600000).toISOString(), Currency: 'CAD' } }),
  ]) {
    const h = await nightlyInvoice(); h.replies.push(h.cdc('Invoice', []), invalid(h));
    const result = await h.sync.tick({ maxRequests: 2 });
    assert.equal(result.status, 'attention'); assert.equal(result.amountReconciliation.checks.receivables.status, 'error');
    assert.equal(h.state().sources.Invoice.phase, 'incremental', 'failed evidence does not trigger a fictitious mismatch recovery');
  }
});

test('account mismatch is compared per identity and resyncs Account without rereading Invoice or Bill', async () => {
  const { h, accounts } = await nightlyAmounts();
  h.replies.push(h.cdcMany([]), aging(h, 'AgedReceivables', '0.30'), aging(h, 'AgedPayables', '50.00'), h.query('Account', accounts.map(row => row.Id === '2' ? { ...row, CurrentBalance: -12.33 } : row)));
  let result = await h.sync.tick({ maxRequests: 4 });
  assert.equal(result.amountReconciliation.checks.accounts.accounts.find(row => row.qboId === '2').status, 'mismatched');
  assert.equal(h.state().sources.Account.phase, 'bootstrap'); assert.equal(h.state().sources.Invoice.phase, 'incremental'); assert.equal(h.state().sources.Bill.phase, 'incremental');
  const fixed = accounts.map(row => row.Id === '2' ? { ...row, CurrentBalance: -12.33 } : row);
  h.replies.push(h.query('Account', fixed), h.cdc('Account', []), h.query('Account', fixed));
  result = await h.sync.tick({ maxRequests: 3 }); assert.equal(result.amountReconciliation.status, 'matched');
  assert.equal(result.amountReconciliation.checks.accounts.attempts, 2);
});

test('amount helper refuses lost cents/currency and distinguishes absent accounts from a zero balance', () => {
  const { moneyCents, mirrorTotal, compareAccounts, parseAgingReport } = require('../src/modules/business-agent-reconciliation');
  assert.equal(moneyCents('0.01'), 1); assert.equal(moneyCents('-12.34'), -1234); assert.equal(moneyCents(0.1), 10);
  for (const invalid of [null, '', '1.001', Infinity, 'NaN', '90071992547409.92']) assert.equal(moneyCents(invalid), null);
  assert.throws(() => mirrorTotal([{ record: { Balance: 10, CurrencyRef: { value: 'USD' } } }], 'CAD'), /home-currency/);
  assert.equal(mirrorTotal([{ record: { Balance: 10, HomeBalance: 13.75, CurrencyRef: { value: 'USD' } } }], 'CAD'), 1375);
  const result = compareAccounts([{ qboId: '1', record: bank(1, 0) }], [bank(2, 0)], 'CAD');
  assert.equal(result.status, 'mismatched'); assert.equal(result.accounts[0].qboCents, null); assert.equal(result.accounts[1].mirrorCents, null);
  const h = fixture();
  const empty = aging(h, 'AgedReceivables', '0.00', { Header: { ReportName: 'AgedReceivables', Time: new Date(h.now()).toISOString(), Currency: 'CAD', Option: [{ Name: 'NoReportData', Value: 'true' }] }, Rows: {} });
  assert.equal(parseAgingReport(empty, 'AgedReceivables', 'CAD', h.now()).qboCents, 0);
});


test('a saturated recovery CDC may replace the generation and still gets exactly one final amount re-check', async () => {
  const h = await nightlyInvoice(); h.replies.push(h.cdc('Invoice', []), aging(h, 'AgedReceivables', '100.00'));
  await h.sync.tick({ maxRequests: 2 }); const originalGeneration = h.state().amountReconciliation.checks.receivables.resyncGeneration;
  h.replies.push(h.query('Invoice', [invoice(1, { Balance: 100 })]), h.cdc('Invoice', Array.from({ length: 1000 }, (_, i) => invoice(i + 10))));
  let result = await h.sync.tick({ maxRequests: 2 });
  assert.equal(result.amountReconciliation.status, 'resyncing'); assert.notEqual(h.state().sources.Invoice.generation, originalGeneration);
  h.advance(30001); h.replies.push(h.query('Invoice', [invoice(1, { Balance: 100 })]), h.cdc('Invoice', []), aging(h, 'AgedReceivables', '100.00'));
  result = await h.sync.tick({ maxRequests: 3 });
  assert.equal(result.status, 'current'); assert.equal(result.amountReconciliation.checks.receivables.attempts, 2); assert.equal(result.amountReconciliation.status, 'matched');
});

test('a pending nightly proof respects CDC failure backoff before retrying and then completes', async () => {
  const h = await nightlyInvoice(); h.replies.push(Object.assign(new Error('fixture rate limit'), { status: 429 }));
  await h.sync.tick({ maxRequests: 4 }); const before = h.admitted.length;
  h.advance(5000); let result = await h.sync.tick({ maxRequests: 4 });
  assert.equal(h.admitted.length, before, 'no request during the saved backoff'); assert.equal(result.amountReconciliation.checks.receivables.status, 'waiting');
  h.advance(25001); h.replies.push(h.cdc('Invoice', []), aging(h, 'AgedReceivables', '120.00'));
  result = await h.sync.tick({ maxRequests: 2 }); assert.equal(result.amountReconciliation.status, 'matched'); assert.equal(h.admitted.length, before + 2);
});

test('missing or unknown AccountType is an evidence error even when neither side can be classified as a bank', () => {
  const { compareAccounts } = require('../src/modules/business-agent-reconciliation');
  for (const record of [{ CurrentBalance: 1 }, { AccountType: 'Bnak', CurrentBalance: 1 }]) {
    assert.throws(() => compareAccounts([{ qboId: '1', record }], [{ Id: '1', ...record, CurrentBalance: 2 }], 'CAD'), /account type evidence/);
  }
});

test('a changed observed home currency invalidates earlier nightly proof along with the mirror source cursors', async () => {
  const h = fixture(['Preferences']);
  h.replies.push(h.query('Preferences', [{ Id: '1', CurrencyPrefs: { HomeCurrency: { value: 'CAD' } } }])); await h.sync.tick({ maxRequests: 1 });
  const state = h.state(); state.amountReconciliation = { version: 1, day: '2026-10-23', status: 'matched', checks: { receivables: { status: 'matched', mirrorCents: 100, qboCents: 100, currency: 'CAD' } } }; h.setState(state);
  h.advance(21600001); h.replies.push(h.query('Preferences', [{ Id: '1', CurrencyPrefs: { HomeCurrency: { value: 'USD' } } }]));
  const result = await h.sync.tick({ maxRequests: 1 }); assert.equal(h.state().homeCurrency, 'USD'); assert.equal(result.amountReconciliation, null);
});

const reconciliation = require('../src/modules/business-agent-reconciliation');
const mirrorRows = records => records.map(record => ({ qboId: record.Id || '1', record }));
const journalLine = (account, posting, amount, type = 'Customer') => ({ Amount: amount, DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: { AccountRef: { value: account }, PostingType: posting, Entity: { Type: type, EntityRef: { value: '1' } } } });
function agingMirror(entity, changes = {}) {
  return { ...Object.fromEntries(reconciliation.agingEntities(entity).map(type => [type, []])),
    Account: mirrorRows([bank('ar', 0, 'Accounts Receivable'), bank('ap', 0, 'Accounts Payable'), bank('income', 0, 'Income')]), ...changes };
}

test('expected receivables net remaining credits, unapplied payments and customer A/R journal debits/credits exactly', () => {
  const result = reconciliation.agingMirrorTotal('Invoice', agingMirror('Invoice', {
    Invoice: mirrorRows([invoice(1, { Balance: '100.01', TotalAmt: 500 }), invoice(2, { Balance: '0.20' })]),
    Payment: mirrorRows([{ TotalAmt: 999, UnappliedAmt: '20.02' }, { TotalAmt: 70, UnappliedAmt: 0 }]),
    CreditMemo: mirrorRows([{ TotalAmt: 90, Balance: '10.03' }, { TotalAmt: 80, Balance: 0 }]),
    JournalEntry: mirrorRows([{ TotalAmt: 0, Line: [journalLine('ar', 'Debit', '5.05'), journalLine('ar', 'Credit', '1.01'), journalLine('income', 'Debit', 900), journalLine('ap', 'Credit', 800, 'Vendor')] }]),
  }), 'CAD');
  assert.equal(result.mirrorCents, 7420); assert.equal(result.knownCents, 7420); assert.deepEqual(result.limitations, []);
  assert.deepEqual(Object.fromEntries(Object.entries(result.components).map(([key, row]) => [key, row.cents])),
    { invoices: 10021, unappliedPayments: -2002, creditMemos: -1003, journalEntries: 404, refundReceipts: 0, deposits: 0, purchases: 0 });
  assert.equal(result.components.creditMemos.field, 'Balance'); assert.equal(result.components.unappliedPayments.field, 'UnappliedAmt');
});

test('expected payables net remaining vendor credits, unapplied bill payments and vendor A/P journal credits/debits', () => {
  const result = reconciliation.agingMirrorTotal('Bill', agingMirror('Bill', {
    Bill: mirrorRows([{ Balance: '100.01' }]), VendorCredit: mirrorRows([{ TotalAmt: 200, Balance: '30.02' }, { Balance: 0 }]),
    BillPayment: mirrorRows([{ TotalAmt: '100.03', Line: [{ Amount: '40.00', LinkedTxn: [{ TxnType: 'Bill', TxnId: '1' }] }, { Amount: '20.00', LinkedTxn: [{ TxnType: 'VendorCredit', TxnId: '2' }] }] }]),
    JournalEntry: mirrorRows([{ Line: [journalLine('ap', 'Credit', '7.07', 'Vendor'), journalLine('ap', 'Debit', '2.02', 'Vendor'), journalLine('ar', 'Debit', 99)] }]),
  }), 'CAD');
  assert.equal(result.mirrorCents, -499); assert.deepEqual(result.limitations, []);
  assert.deepEqual(Object.fromEntries(Object.entries(result.components).map(([key, row]) => [key, row.cents])),
    { bills: 10001, unappliedBillPayments: -8003, vendorCredits: -3002, journalEntries: 505, deposits: 0, purchases: 0 });
  assert.equal(result.components.unappliedBillPayments.field, 'TotalAmt - net applied Line.Amount');
});

test('missing mirrored component types and missing remaining or unapplied fields are explicit unknowns, never zero', () => {
  for (const entity of ['Invoice', 'Bill']) {
    for (const type of reconciliation.agingEntities(entity).filter(type => type !== 'Account')) {
      const byEntity = agingMirror(entity); delete byEntity[type];
      const result = reconciliation.agingMirrorTotal(entity, byEntity, 'CAD');
      assert.equal(result.mirrorCents, null); assert.ok(result.limitations.some(row => row.entity === type && /not mirrored/.test(row.reason)));
    }
  }
  for (const [entity, type] of [['Invoice', 'Payment'], ['Invoice', 'CreditMemo'], ['Bill', 'BillPayment'], ['Bill', 'VendorCredit']]) {
    const result = reconciliation.agingMirrorTotal(entity, agingMirror(entity, { [type]: mirrorRows([{ TotalAmt: 100 }]) }), 'CAD');
    assert.equal(result.mirrorCents, null); assert.equal(result.limitations[0].entity, type); assert.match(result.limitations[0].reason, /missing|no exact/);
  }
});

test('unsupported refund, journal account/entity and foreign-currency evidence retain known components without guessing', () => {
  for (const changes of [
    { RefundReceipt: mirrorRows([{ TotalAmt: 50 }]) },
    { Payment: mirrorRows([{ UnappliedAmt: 1, HomeBalance: 500, CurrencyRef: { value: 'USD' } }]) },
    { JournalEntry: mirrorRows([{ CurrencyRef: { value: 'USD' }, Line: [journalLine('ar', 'Debit', 1)] }]) },
    { JournalEntry: mirrorRows([{ Line: [journalLine('unknown', 'Debit', 1)] }]) },
    { JournalEntry: mirrorRows([{ Line: [journalLine('ar', 'Debit', 1, 'Vendor')] }]) },
    { JournalEntry: mirrorRows([{ Line: [journalLine('ar', 'Other', 1)] }]) },
  ]) {
    const result = reconciliation.agingMirrorTotal('Invoice', agingMirror('Invoice', { Invoice: mirrorRows([{ Balance: 20 }]), ...changes }), 'CAD');
    assert.equal(result.mirrorCents, null); assert.equal(result.knownCents, 2000); assert.equal(result.limitations.length, 1);
    assert.equal(result.components[result.limitations[0].component].status, 'unverified');
  }
  const foreign = reconciliation.agingMirrorTotal('Invoice', agingMirror('Invoice', {
    Invoice: mirrorRows([{ Balance: 10, HomeBalance: 13.75, CurrencyRef: { value: 'USD' } }]),
    Payment: mirrorRows([{ UnappliedAmt: 1, HomeUnappliedAmt: 1.25, CurrencyRef: { value: 'USD' } }]),
  }), 'CAD');
  assert.equal(foreign.mirrorCents, 1250);
});

test('both aging summaries read the unique TOTAL Summary.ColData through the existing report JSON source roundtrip', () => {
  const { canonicalReport } = require('../src/modules/report-json');
  const { packReport, unpackReport } = require('../src/modules/business-report-source');
  const h = fixture();
  for (const report of ['AgedReceivables', 'AgedPayables']) {
    for (const grouped of [true, false]) {
      const body = aging(h, report, '-4.97'); body.Columns.Column[2].ColTitle = 'TOTAL';
      if (!grouped) delete body.Rows.Row[0].group;
      body.Rows.Row.unshift({ type: 'Section', group: 'customer-or-vendor', Summary: { ColData: [{ value: 'Total Customer' }, { value: '999' }, { value: '999' }] } });
      const raw = unpackReport(report, packReport(report, JSON.parse(canonicalReport(body)), 3), 3);
      assert.equal(reconciliation.parseAgingReport(raw, report, 'CAD', h.now()).qboCents, -497);
      raw.Rows.Row.push(copy(raw.Rows.Row.at(-1)));
      assert.throws(() => reconciliation.parseAgingReport(raw, report, 'CAD', h.now()), /unambiguous grand total/);
    }
  }
});

test('nightly reconciliation persists the net components and fresh payment/credit changes instead of resyncing invoices', async () => {
  const h = await nightlyInvoice(), before = h.admitted.length;
  h.replies.push(h.cdcMany([['Payment', [{ Id: '2', UnappliedAmt: '20.02' }]], ['CreditMemo', [{ Id: '3', Balance: '10.03', TotalAmt: 99 }]]]), aging(h, 'AgedReceivables', '89.95'));
  const result = await h.sync.tick({ maxRequests: 2 }), proof = result.amountReconciliation.checks.receivables;
  assert.equal(proof.status, 'matched'); assert.equal(result.status, 'current'); assert.equal(proof.mirrorCents, 8995); assert.equal(proof.differenceCents, 0);
  assert.equal(proof.components.unappliedPayments.cents, -2002); assert.equal(proof.components.creditMemos.cents, -1003);
  assert.deepEqual(h.state().amountReconciliation.checks.receivables.components, proof.components);
  assert.equal(h.state().sources.Invoice.phase, 'incremental'); assert.equal(h.admitted.length - before, 2);
});

test('an invoice-only mirror records missing components and never declares a mismatch or schedules a full resync', async () => {
  const h = fixture(); await initial(h, 'Invoice', [invoice(1)]); h.advance(17 * 3600000 + 10 * 60000);
  h.replies.push(h.cdc('Invoice', []), aging(h, 'AgedReceivables', '80.00'));
  const result = await h.sync.tick({ maxRequests: 2 }), proof = result.amountReconciliation.checks.receivables;
  assert.equal(proof.status, 'unverified'); assert.equal(result.amountReconciliation.status, 'unverified');
  assert.equal(proof.mirrorCents, null); assert.equal(proof.knownCents, 12000); assert.equal(proof.qboCents, 8000);
  assert.ok(proof.limitations.some(row => row.entity === 'Payment')); assert.equal(h.state().sources.Invoice.phase, 'incremental');
  assert.equal(result.status, 'current', 'incomplete amount evidence does not invent a sync error');
});


test('native RemainingCredit is the credit memo contribution, including a fully applied credit and conflicting aliases', () => {
  const base = agingMirror('Invoice', { Invoice: mirrorRows([{ Balance: '20.01' }]),
    CreditMemo: mirrorRows([{ TotalAmt: 100, RemainingCredit: '4.02' }, { TotalAmt: 90, RemainingCredit: 0 }]) });
  const result = reconciliation.agingMirrorTotal('Invoice', base, 'CAD');
  assert.equal(result.mirrorCents, 1599); assert.equal(result.components.creditMemos.cents, -402);
  assert.equal(result.components.creditMemos.field, 'RemainingCredit');
  base.CreditMemo = mirrorRows([{ Balance: 5, RemainingCredit: 4 }]);
  const conflict = reconciliation.agingMirrorTotal('Invoice', base, 'CAD');
  assert.equal(conflict.mirrorCents, null); assert.match(conflict.components.creditMemos.reason, /disagree/);
});

test('native bill-only applications establish exact unapplied cash and ambiguous links remain unverified', () => {
  const native = record => reconciliation.agingMirrorTotal('Bill', agingMirror('Bill', { BillPayment: mirrorRows([record]) }), 'CAD');
  assert.equal(native({ TotalAmt: '10.01', Line: [{ Amount: '8.02', LinkedTxn: [{ TxnId: '1', TxnType: 'Bill' }] }] }).mirrorCents, -199);
  assert.equal(native({ TotalAmt: '10.01', Line: [] }).mirrorCents, -1001);
  assert.equal(native({ TotalAmt: '90071992547409.91', Line: [] }).mirrorCents, -9007199254740991);
  assert.equal(native({ TotalAmt: '10.01', Line: [{ Amount: '8.02', LinkedTxn: [{ TxnId: '1', TxnType: 'Bill' }, { TxnId: '2', TxnType: 'VendorCredit' }] }] }).mirrorCents, null);
});

test('direct Deposit/Purchase control-account postings and journal settlements are recorded as unsupported effects', () => {
  for (const [entity, account] of [['Invoice', 'ar'], ['Bill', 'ap']]) {
    const records = agingMirror(entity);
    records.Account.push(...mirrorRows([bank('bank', 0), bank('expense', 0, 'Expense')]));
    records.Deposit = mirrorRows([{ DepositToAccountRef: { value: 'bank' }, Line: [{ Amount: 10, DepositLineDetail: { AccountRef: { value: account } } }] }]);
    let result = reconciliation.agingMirrorTotal(entity, records, 'CAD');
    assert.equal(result.mirrorCents, null); assert.match(result.components.deposits.reason, /posts directly/);
    records.Deposit = mirrorRows([{ DepositToAccountRef: { value: 'bank' }, Line: [{ Amount: 10, DepositLineDetail: { AccountRef: { value: 'income' } } }] }]);
    records.Purchase = mirrorRows([{ AccountRef: { value: 'bank' }, Line: [{ Amount: 10, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } }] }]);
    result = reconciliation.agingMirrorTotal(entity, records, 'CAD');
    assert.equal(result.mirrorCents, null); assert.equal(result.components.deposits.cents, 0); assert.match(result.components.purchases.reason, /posts directly/);
    records.Purchase[0].record.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = 'expense';
    assert.equal(reconciliation.agingMirrorTotal(entity, records, 'CAD').mirrorCents, 0);
    records[entity === 'Invoice' ? 'Payment' : 'BillPayment'] = mirrorRows([{ UnappliedAmt: 0, Line: [{ Amount: 10, LinkedTxn: [{ TxnType: 'JournalEntry', TxnId: '1' }] }] }]);
    result = reconciliation.agingMirrorTotal(entity, records, 'CAD');
    assert.equal(result.mirrorCents, null); assert.match(result.components.journalEntries.reason, /remaining.*effect is not mirrored/);
  }
});

test('a same-day legacy invoice-only proof is replaced by component-based evidence', async () => {
  const h = await nightlyInvoice(), state = h.state();
  state.amountReconciliation = { version: 1, day: '2026-10-24', status: 'attention', checks: { receivables: { entity: 'Invoice', status: 'mismatched', attempts: 2, mirrorCents: 12000, qboCents: 9000 } } }; h.setState(state);
  h.replies.push(h.cdcMany([['Payment', [{ Id: '2', UnappliedAmt: 30 }]]]), aging(h, 'AgedReceivables', '90.00'));
  const result = await h.sync.tick({ maxRequests: 2 });
  assert.equal(result.amountReconciliation.basisVersion, 2); assert.equal(result.amountReconciliation.status, 'matched');
  assert.equal(result.amountReconciliation.checks.receivables.attempts, 1); assert.equal(result.amountReconciliation.checks.receivables.components.unappliedPayments.cents, -3000);
});

test('overflowing a component total remains unverified rather than storing an included unsafe sum', () => {
  const result = reconciliation.agingMirrorTotal('Invoice', agingMirror('Invoice', {
    Invoice: mirrorRows([{ Balance: '90071992547409.91' }]),
    JournalEntry: mirrorRows([{ Line: [journalLine('ar', 'Debit', '0.01')] }]),
  }), 'CAD');
  assert.equal(result.mirrorCents, null); assert.equal(result.components.journalEntries.status, 'unverified'); assert.equal(result.components.journalEntries.cents, null);
});


test('opposite safe totals cannot persist an unsafe cent difference or trigger mismatch recovery', async () => {
  const h = await nightlyInvoice();
  h.replies.push(h.cdcMany([['Invoice', [invoice(1, { Balance: 0 })]], ['Payment', [{ Id: '2', UnappliedAmt: '90071992547409.91' }]]]), aging(h, 'AgedReceivables', '90071992547409.91'));
  const result = await h.sync.tick({ maxRequests: 2 });
  assert.equal(result.amountReconciliation.checks.receivables.status, 'error');
  assert.equal(h.state().sources.Invoice.phase, 'incremental');
});


test('legacy attention is cleared even when its false mismatch already restarted the source today', async () => {
  const h = await nightlyInvoice(), state = h.state();
  state.sources.Invoice.startedAt = new Date(h.now() - 60000).toISOString();
  for (const source of Object.values(state.sources)) { source.lastSuccessAt = new Date(h.now()).toISOString(); source.nextAt = new Date(h.now() + 600000).toISOString(); source.reconciledOn = '2026-10-24'; }
  state.amountReconciliation = { version: 1, day: '2026-10-24', status: 'attention', checks: { receivables: { entity: 'Invoice', status: 'resyncing', attempts: 1 } } }; h.setState(state);
  const before = h.admitted.length, result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(result.amountReconciliation, null); assert.equal(h.state().amountReconciliation, undefined);
  assert.equal(result.status, 'catching-up', 'the unchanged stale summary still needs its normal refresh, but obsolete attention is gone'); assert.equal(h.admitted.length, before);
  assert.deepEqual(h.state().sources, state.sources, 'obsolete amount proof does not rewrite a valid source cursor');
});

test('every pending comparison can require a fresh shared journal source, including a newer payable recovery', async () => {
  const { h } = await nightlyAmounts(), state = h.state(), now = h.now();
  for (const source of Object.values(state.sources)) { source.lastSuccessAt = new Date(now).toISOString(); source.nextAt = new Date(now + 600000).toISOString(); source.reconciledOn = '2026-10-24'; }
  state.sources.JournalEntry.lastSuccessAt = new Date(now - 20000).toISOString();
  state.amountReconciliation = { version: 1, basisVersion: 2, day: '2026-10-24', status: 'resyncing', checks: {
    receivables: { entity: 'Invoice', status: 'waiting', attempts: 0, refreshAfter: new Date(now - 30000).toISOString() },
    payables: { entity: 'Bill', status: 'resyncing', attempts: 1, resyncGeneration: state.sources.Bill.generation, refreshAfter: new Date(now - 10000).toISOString() },
  } }; h.setState(state);
  const before = h.admitted.length; h.replies.push(h.cdcMany([]));
  const result = await h.sync.tick({ maxRequests: 1 });
  assert.equal(h.admitted.length, before + 1); assert.match(h.admitted[before].request, /^cdc\?/);
  assert.equal(h.state().sources.JournalEntry.lastSuccessAt, new Date(now).toISOString());
  assert.equal(result.amountReconciliation.checks.receivables.status, 'waiting', 'the shared fresh read uses the allowance before any comparison');
});
