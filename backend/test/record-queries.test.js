'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { searchQuery, pageResult, identity } = require('../src/modules/record-queries');
const { createExploreRouter } = require('../src/routes/explore');
test('transaction pages use one-based offsets, lookahead and inclusive date filters', () => {
  const request = searchQuery({ type: 'Invoice', offset: '50', from: '2026-09-01', through: '2026-09-30' });
  assert.equal(request.query, "SELECT * FROM Invoice WHERE TxnDate >= '2026-09-01' AND TxnDate <= '2026-09-30' ORDERBY TxnDate DESC, Id ASC STARTPOSITION 51 MAXRESULTS 51");
  const records = Array.from({ length: 51 }, (_, index) => ({ Id: String(index + 1) }));
  const page = pageResult({ QueryResponse: { Invoice: records, startPosition: 51 } }, request);
  assert.equal(page.records.length, 50); assert.equal(page.hasMore, true); assert.equal(page.nextOffset, 100); assert.equal(page.snapshot, false);
  assert.equal(pageResult({ QueryResponse: {} }, request).hasMore, false);
  assert.equal(pageResult({ QueryResponse: { Warnings: [] } }, request).hasMore, false);
});
test('list pages include inactive records unless deliberately filtered', () => {
  assert.match(searchQuery({ type: 'Customer' }).query, /ORDERBY DisplayName, Id ASC/);
  assert.match(searchQuery({ type: 'Customer' }).query, /Active IN \(true, false\)/);
  assert.match(searchQuery({ type: 'Item', active: 'inactive' }).query, /Active = false/);
});
test('number search safely preserves apostrophes, backslashes and ordinary document numbers', () => {
  assert.match(searchQuery({ type: 'Invoice', q: '4570' }).query, /4570/);
  const request = searchQuery({ type: 'Vendor', q: "O'Brien" });
  assert.ok(request.query.includes("O" + String.fromCharCode(92) + "'Brien"));
  const slash = String.fromCharCode(92);
  assert.ok(searchQuery({ type: 'Invoice', q: 'A' + slash + 'B' }).query.includes('A' + slash + slash + 'B'));
});
test('invalid filters, paging, dates and paths fail before a query', () => {
  for (const params of [{ offset: '-1' }, { limit: '0' }, { offset: '1.5' }, { limit: ['50'] }, { realmId: 'other' }, { from: '2026-02-30' }, { from: '2026-10-01', through: '2026-09-30' }, { q: 'a'.repeat(121) }, { q: 'x' + String.fromCharCode(10) }, { active: 'all' }]) assert.throws(() => searchQuery({ type: 'Invoice', ...params }), error => error.recordInputError === true);
  assert.throws(() => searchQuery({ type: 'Payment', q: '123' }));
  assert.throws(() => searchQuery({ type: 'Customer', from: '2026-01-01' }));
  assert.throws(() => identity('Invoice', '../bill/1')); assert.throws(() => identity('CompanyInfo', '1'));
  assert.throws(() => identity('__proto__', '1')); assert.throws(() => identity('constructor', '1'));
  assert.deepEqual(identity('BillPaymentCheck', '123'), { entity: 'BillPayment', id: '123' });
});
test('malformed or repeated-page responses cannot be shown as complete reads', () => {
  const request = searchQuery({ type: 'Bill', offset: '50' });
  for (const response of [undefined, {}, { QueryResponse: { Bill: {} } }, { QueryResponse: { Bill: [{ Id: '1' }, { Id: '1' }] } }, { QueryResponse: { startPosition: 1, Bill: [] } }, { QueryResponse: { Warnings: ['ignored filter'] } }]) assert.throws(() => pageResult(response, request));
});
async function withRoute(qbo, work, dependencies = {}) {
  let connections = 0;
  const app = express(); app.use('/explore', createExploreRouter({ getActiveConnection: async () => { connections++; return { _id: 'fixture-connection', realmId: 'fixture-realm' }; }, qboFor: async () => qbo, ...dependencies }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/explore';
  const headers = { Authorization: 'Bearer ' + jwt.sign({ id: 'fixture-user', role: 'agent' }, config.jwtSecret) };
  try { await work((path, options = {}) => fetch(base + path, { headers, ...options }), () => connections); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
test('search routes require auth and return server-owned scope with bounded page data', async () => {
  const calls = [];
  await withRoute({ query: async query => { calls.push(query); return { QueryResponse: { Invoice: [{ Id: '1' }] } }; } }, async (request, connectionCount) => {
    assert.equal((await request('/search?type=Invoice', { headers: {} })).status, 401); assert.equal(connectionCount(), 0);
    assert.equal((await request('/search?type=Invoice&realmId=other')).status, 400); assert.equal(calls.length, 0);
    const response = await request('/search?type=Invoice'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.scope.realmId, 'fixture-realm'); assert.equal(data.hasMore, false);
  });
});
test('QBO auth errors stay upstream errors and invalid identities never reach QBO', async () => {
  let reads = 0;
  await withRoute({ query: async () => { throw Object.assign(new Error('QBO fixture expired'), { status: 401 }); }, read: async () => { reads++; return {}; } }, async request => {
    assert.equal((await request('/search?type=Bill')).status, 502);
    assert.equal((await request('/invoice/invalid%2Fpath/chain')).status, 400); assert.equal(reads, 0);
    assert.equal((await request('/invoice/1')).status, 500);
  });
});
test('chain preserves line identities and canonicalizes aliases without duplicate reads', async () => {
  const calls = [];
  await withRoute({ read: async (type, id) => {
    calls.push(type + ':' + id);
    return type === 'bill' ? { Bill: { Id: '1', Line: [{ Id: '7', LinkedTxn: [{ TxnType: 'BillPaymentCheck', TxnId: '2', TxnLineId: '9' }] }] } } : { BillPayment: { Id: '2', LinkedTxn: [{ TxnType: 'Bill', TxnId: '1' }] } };
  } }, async request => {
    const data = await (await request('/bill/1/chain')).json(); assert.equal(data.complete, true); assert.equal(calls.length, 2);
    assert.equal(data.edges[0].fromLineId, '7'); assert.equal(data.edges[0].toLineId, '9');
  });
});
test('chain relationship budget is explicit and unreadable nodes remain incomplete', async () => {
  await withRoute({ read: async () => ({ Invoice: { Id: '1', LinkedTxn: Array.from({ length: 1001 }, () => ({ TxnType: 'Invoice', TxnId: '1' })) } }) }, async request => {
    const data = await (await request('/invoice/1/chain')).json(); assert.equal(data.truncated, true); assert.equal(data.complete, false); assert.equal(data.edges.length, 1000);
  });
  await withRoute({ read: async () => { throw new Error('private upstream detail'); } }, async request => {
    const data = await (await request('/invoice/1/chain')).json(); assert.equal(data.complete, false); assert.equal(JSON.stringify(data).includes('private upstream detail'), false);
  });
});

test('adjacent tied-date pages request the same unique order and do not reuse the lookahead row', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ Id: String(index + 1), TxnDate: '2026-09-01' }));
  await withRoute({ query: async query => {
    assert.match(query, /ORDERBY TxnDate DESC, Id ASC/);
    const position = Number(query.match(/STARTPOSITION ([0-9]+)/)[1]);
    const maximum = Number(query.match(/MAXRESULTS ([0-9]+)/)[1]);
    return { QueryResponse: { startPosition: position, Invoice: rows.slice(position - 1, position - 1 + maximum) } };
  } }, async request => {
    const first = await (await request('/search?type=Invoice')).json();
    const next = await (await request('/search?type=Invoice&offset=' + first.nextOffset)).json();
    assert.equal(first.records.at(-1).Id, '50'); assert.equal(next.records[0].Id, '51');
    assert.equal(new Set([...first.records, ...next.records].map(row => row.Id)).size, 100);
  });
});

test('origin endpoint is scoped, read-only, authenticated and rejects injected query scope', async () => {
  const calls = [];
  await withRoute({}, async (request, connectionCount) => {
    assert.equal((await request('/bill/12/origin', { headers: {} })).status, 401); assert.equal(connectionCount(), 0);
    assert.equal((await request('/bill/12/origin?realmId=other')).status, 400); assert.equal(calls.length, 0);
    const response = await request('/bill/12/origin'); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.scope.realmId, 'fixture-realm');
    assert.deepEqual(calls[0], { userId: 'fixture-user', realmId: 'fixture-realm', environment: config.qbo.environment, entity: 'Bill', id: '12' });
  }, { originFor: async input => { calls.push(input); return { sources: [], status: 'unknown' }; } });
});
test('origin failure is separate from QBO record availability and hides database details', async () => {
  await withRoute({ read: async () => ({ Bill: { Id: '12' } }) }, async request => {
    const failed = await request('/bill/12/origin'); assert.equal(failed.status, 503);
    assert.equal((await failed.text()).includes('private database'), false);
    assert.equal((await request('/bill/12')).status, 200);
  }, { originFor: async () => { throw new Error('private database'); } });
});
