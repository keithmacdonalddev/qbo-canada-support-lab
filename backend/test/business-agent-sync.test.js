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
  const respond = async (control, request) => { await control.beforeAttempt(); const result = replies.shift(); if (result instanceof Error) throw result; if (result === undefined) throw new Error('fixture response not supplied'); return copy(typeof result === 'function' ? result(request) : result); };
  const client = { query: async (query, control) => { queries.push(query); return respond(control, query); }, apiCall: async (method, endpoint, body, r, a, control) => { calls.push({ method, endpoint, body }); return respond(control, endpoint); } };
  const options = { client, scope, Records, entities, homeCurrency: 'CAD', assertClient: () => {}, now: () => clock, authorize: async () => { if (denied) throw Object.assign(new Error('lease revoked'), { code: 'LEASE_REVOKED' }); },
    loadState: async () => copy(state), saveState: async value => { if (failSave > 0) { failSave--; throw new Error('fixture cursor not committed'); } state = copy(value); } };
  const h = { rows, queries, calls, replies, options, sync: createBusinessAgentSync(options), state: () => copy(state), setState: value => { state = copy(value); },
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
  h.replies.push(h.cdcMany([]));
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
