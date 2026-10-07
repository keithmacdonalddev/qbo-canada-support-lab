'use strict';
const assert = require('node:assert/strict');
const { createBusinessBaselineStore } = require('../../src/modules/business-baseline');
const { hash, canonical } = require('../../src/modules/business-calendar');
const { fixture: reportFixture, period } = require('./business-report-fixtures');
const scope = { environment: 'sandbox', realmId: '123', connectionId: 'a'.repeat(24) }, actorId = 'b'.repeat(24), ownerId = 'c'.repeat(24), blueprintId = 'd'.repeat(24);
const now = Date.parse('2026-10-06T12:00:00.000Z');
const clone = value => structuredClone(value);
function sources() {
  const reports = reportFixture(); reports.TrialBalance.Rows.Row[0].ColData[0].id = '1'; reports.TrialBalance.Rows.Row[1].ColData[0].id = '2';
  const source = { version: 1, scope, period, startedAt: new Date(now - 1000).toISOString(), observedAt: new Date(now).toISOString(), reports,
    accounts: [{ Id: '1', SyncToken: '0', AccountType: 'Accounts Receivable' }, { Id: '2', SyncToken: '0', AccountType: 'Accounts Payable' }] };
  return { ...clone(source), sourceHash: hash(source), evaluation: { status: 'untrusted supplied flag' } };
}

function inventorySources(accounts = sources().accounts) {
  const { TYPES } = require('../../src/modules/business-record-inventory');
  const records = Object.fromEntries(TYPES.map(type => [type, []]));
  records.Account = accounts.map(row => ({ id: row.Id, syncToken: row.SyncToken, contentHash: hash(row), active: true })).sort((a,b) => a.id.localeCompare(b.id));
  records.Invoice = [{ id: '20', syncToken: '1', contentHash: hash({ fixture: true }), transactionDate: '2026-09-01' }];
  const digest = hash(TYPES.map(entity => ({ entity, records: records[entity] })));
  const scan = { startedAt: new Date(now - 1000).toISOString(), observedAt: new Date(now).toISOString(), count: accounts.length + 1, manifestHash: digest };
  const source = { version: 1, policy: 'all-current-records-including-inactive-lists-two-complete-scans-v1', scope, coverage: [...TYPES], scans: [scan, { ...scan, startedAt: scan.observedAt }], records };
  return { ...clone(source), sourceHash: hash(source) };
}
const field = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(branch => matches(row, branch)) : value && typeof value === 'object' ? Object.entries(value).every(([op, wanted]) => op === '$exists' ? (field(row, key) !== undefined) === wanted : op === '$type' ? typeof field(row, key) === wanted : op === '$gte' ? field(row, key) >= wanted : op === '$lt' ? field(row, key) < wanted : false) : field(row, key) === value);
}
function fixture() {
  const definition = { calendar: { openingDate: '2026-10-01' } }, contentHash = hash(definition);
  const h = { clock: now, reads: 0, writes: 0, ready: true, canCapture: true, canRead: true, canReview: true, source: sources(), inventorySource: inventorySources(), inventoryReads: 0, data: { Baselines: [], Audits: [], Versions: [{ _id: blueprintId, ...scope, contractVersion: 2, status: 'draft', definition, contentHash, auditId: 'e'.repeat(24), version: 1 }], Users: [{ _id: actorId }, { _id: ownerId }], Connections: [{ _id: scope.connectionId, userId: ownerId, realmId: scope.realmId, status: 'active' }], Memberships: [{ userId: actorId, realmId: scope.realmId, status: 'active' }] } };
  const model = key => {
    const query = (filter, many) => { let sort = {}, limit = Infinity; const q = { session() { return q; }, maxTimeMS() { return q; }, select() { return q; }, sort(value) { sort = value; return q; }, limit(value) { limit = value; return q; }, async lean() { if (h.onQuery) await h.onQuery(key, filter); let rows = h.data[key].filter(row => matches(row, filter)); rows.sort((a, b) => { for (const [fieldName, direction] of Object.entries(sort)) if (field(a, fieldName) !== field(b, fieldName)) return (field(a, fieldName) < field(b, fieldName) ? -1 : 1) * direction; return 0; }); rows = rows.slice(0, limit); return clone(many ? rows : rows[0] || null); } }; return q; };
    return { findOne: filter => query(filter, false), find: filter => query(filter, true),
      async create(rows, { session }) { assert.ok(session.inTransaction()); if (h.failCreate === key) throw new Error('fixture persistence failure'); for (const row of rows) { if (h.data[key].some(value => value._id === row._id)) throw new Error('duplicate'); h.data[key].push(clone(row)); h.writes++; } return rows; },
      async updateOne(filter, change, { session }) { assert.ok(session.inTransaction()); const row = h.data[key].find(row => matches(row, filter)); if (!row) return { matchedCount: 0 }; for (const [name, value] of Object.entries(change.$inc)) row[name] = (row[name] || 0) + value; h.writes++; return { matchedCount: 1 }; },
    };
  };
  h.models = Object.fromEntries(Object.keys(h.data).map(key => [key, model(key)]));
  let queue = Promise.resolve();
  h.transaction = work => { const result = queue.then(async () => { const before = clone(h.data); let output; try { output = await work({ inTransaction: () => true }); } catch (error) { h.data = before; throw error; } if (h.loseReply) { h.loseReply = false; throw new Error('commit reply lost'); } return output; }); queue = result.catch(() => {}); return result; };
  h.access = { authorize: async (requested, action) => { assert.deepEqual(requested, scope); if ((action === 'baseline.capture' && !h.canCapture) || (action === 'baseline.read' && !h.canRead) || (action === 'baseline.review' && !h.canReview)) throw Object.assign(new Error('permission revoked'), { status: 403, code: 'BUSINESS_ACCESS_DENIED' }); return { actorId, ownerId: h.changedOwner ? 'f'.repeat(24) : ownerId }; } };
  h.readReports = async (requested, requestedPeriod, options) => { assert.deepEqual(requested, scope); assert.deepEqual(requestedPeriod, period); h.reads++; if (h.onReports) await h.onReports(options); return clone(h.source); };
  h.readInventory = async (requested, options) => { assert.deepEqual(requested, scope); h.inventoryReads++; if (h.onInventory) await h.onInventory(options); return clone(h.inventorySource); };
  h.deps = { scope, actorId, ownerId, ...h.models, access: h.access, assertReady: async () => { if (!h.ready) throw Object.assign(new Error('storage unprepared'), { code: 'BUSINESS_STORAGE_UNPREPARED', status: 409 }); }, assertCaptureReady: async () => { if (h.setupIncomplete) throw Object.assign(new Error('setup incomplete'), { code: 'BUSINESS_STORAGE_UNPREPARED', status: 409 }); }, transaction: h.transaction, readReports: h.readReports, readInventory: h.readInventory, now: () => h.clock };
  h.store = createBusinessBaselineStore(h.deps);
  h.input = { requestKey: 'baseline-observation-001', connectionId: scope.connectionId, blueprintId, blueprintHash: contentHash, purpose: 'company-survey', ...period };
  h.capture = options => h.store.capture(h.input, options);
  return h;
}

module.exports = { fixture, sources, inventorySources, scope, actorId, ownerId, blueprintId, now };
