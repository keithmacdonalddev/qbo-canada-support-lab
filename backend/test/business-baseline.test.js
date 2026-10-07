'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBaselineObservation } = require('../src/modules/business-baseline');
const { hash, canonical } = require('../src/modules/business-calendar');
const { fixture, sources, scope, actorId, ownerId, blueprintId, now } = require('./helpers/business-baseline-fixture');
const clone = value => structuredClone(value);
test('retains exact sources and recomputed checks with compact audit but no acceptance', async () => {
  const h = fixture(), result = await h.capture();
  assert.equal(result.status, 'captured'); assert.equal(result.evaluation.status, 'checks-passed'); assert.equal(result.accepted, false); assert.equal(result.activated, false); assert.equal(result.ownership, 'unverified'); assert.equal(result.inventory.status, 'matching-scans'); assert.equal(result.inventory.count, 3); assert.equal(result.inventory.records, undefined); assert.equal(result.inventorySources, undefined);
  assert.equal(result.sources, undefined); assert.equal(h.data.Baselines.length, 1); assert.equal(h.data.Audits.length, 1);
  assert.equal(h.data.Audits[0].afterState.sources, undefined); assert.ok(canonical(h.data.Audits[0]).length < 2000);
  assert.equal(h.data.Users[0].businessObservationVersion, 1); assert.equal(h.data.Connections[0].businessObservationVersion, 1); assert.equal(h.data.Memberships[0].businessObservationVersion, 1);
  const read = await h.store.inspect(result.id); assert.equal(read.evidenceHash, result.evidenceHash); assert.equal(read.persisted, true);
});
test('lost acknowledgement and repeated capture reuse original sources without new report reads', async () => {
  const h = fixture(); h.loseReply = true; await assert.rejects(h.capture(), /reply lost/); h.onReports = () => { throw new Error('must not reread'); }; h.clock += 86400000;
  const result = await h.capture(); assert.equal(result.reused, true); assert.equal(h.reads, 1); assert.equal(result.observedAt, new Date(now).toISOString()); assert.equal(h.data.Baselines.length, 1); assert.equal(h.data.Audits.length, 1);
  h.input.throughDate = '2026-10-05'; await assert.rejects(h.capture(), /different work/); assert.equal(h.reads, 1);
});
test('concurrent identical requests save one immutable observation and audit', async () => {
  const h = fixture(), results = await Promise.all([h.capture(), h.capture()]); assert.equal(results[0].id, results[1].id); assert.equal(h.data.Baselines.length, 1); assert.equal(h.data.Audits.length, 1); assert.equal(h.data.Users[0].businessObservationVersion, 1);
});
test('source or audit persistence failures roll back evidence and authority counters together', async () => {
  for (const key of ['Baselines', 'Audits']) { const h = fixture(); h.failCreate = key; await assert.rejects(h.capture(), /persistence/); assert.equal(h.data.Baselines.length, 0); assert.equal(h.data.Audits.length, 0); assert.equal(h.data.Users[0].businessObservationVersion, undefined); }
});
test('capture permission and storage readiness are required before report access', async () => {
  for (const key of ['canCapture', 'ready']) { const h = fixture(); h[key] = false; await assert.rejects(h.capture()); assert.equal(h.reads, 0); assert.equal(h.writes, 0); }
});
test('revocation, ownership change and selected blueprint changes discard completed reads', async () => {
  for (const mutate of [h => { h.canCapture = false; }, h => { h.changedOwner = true; }, h => { h.data.Versions[0].definition.calendar.openingDate = '2026-09-01'; }, h => { h.data.Connections[0].status = 'revoked'; }, h => { h.data.Memberships[0].status = 'suspended'; }]) {
    const h = fixture(); h.onReports = async () => mutate(h); await assert.rejects(h.capture()); assert.equal(h.data.Baselines.length, 0); assert.equal(h.data.Audits.length, 0);
  }
});
test('cancelled observation cannot start new reads or save late returned sources', async () => {
  const h = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(h.capture({ signal: controller.signal }), /cancelled/); assert.equal(h.reads, 0);
  const late = fixture(), stop = new AbortController(); late.onReports = async () => stop.abort(); await assert.rejects(late.capture({ signal: stop.signal }), /cancelled/); assert.equal(late.data.Baselines.length, 0);
});
test('wrong, stale, truncated and tampered report source envelopes are rejected', async () => {
  for (const mutate of [s => { s.scope.realmId = '999'; }, s => { s.reports.TrialBalance.Header.Currency = 'USD'; }, s => { delete s.reports.BalanceSheet; }, s => { s.accounts.push(clone(s.accounts[0])); }, s => { s.period.throughDate = '2026-10-05'; }, s => { s.startedAt = new Date(now - 300001).toISOString(); }]) {
    const h = fixture(); mutate(h.source); await assert.rejects(h.capture()); assert.equal(h.data.Baselines.length, 0);
  }
});
test('failed or incomplete checks are retained honestly rather than marked accepted', async () => {
  const h = fixture(); h.source.reports.TrialBalance.Rows.Row.at(-1).Summary.ColData[1].value = '200.00';
  const { sourceHash, evaluation, ...raw } = h.source; h.source.sourceHash = hash(raw);
  const result = await h.capture(); assert.equal(result.evaluation.status, 'differences-found'); assert.equal(result.accepted, false); assert.equal((await h.store.inspect(result.id)).evaluation.status, 'differences-found');
});
test('opening balances require the previous day and company surveys retain their true purpose', async () => {
  const h = fixture(); h.input.purpose = 'opening-balances'; await assert.rejects(h.capture(), /day before/); assert.equal(h.reads, 0);
  h.data.Versions[0].definition.calendar.openingDate = '2026-10-07'; h.data.Versions[0].contentHash = hash(h.data.Versions[0].definition); h.input.blueprintHash = h.data.Versions[0].contentHash;
  assert.equal((await h.capture()).purpose, 'opening-balances');
});
test('current read authority can inspect historical evidence without recapturing or accepting it', async () => {
  const h = fixture(), saved = await h.capture(); h.clock += 365 * 86400000; h.canCapture = false;
  assert.equal((await h.store.inspect(saved.id)).evidenceHash, saved.evidenceHash); assert.equal(h.reads, 1);
  h.canRead = false; await assert.rejects(h.store.inspect(saved.id), /revoked/);
});
test('missing audits and changed retained evaluations or sources invalidate inspection', async () => {
  for (const mutate of [h => { h.data.Audits = []; }, h => { h.data.Baselines[0].payload.evaluation.status = 'fake'; }, h => { h.data.Baselines[0].sources.accounts[0].AccountType = 'Bank'; }, h => { h.data.Baselines[0].payload.accepted = true; }]) {
    const h = fixture(), saved = await h.capture(); mutate(h); await assert.rejects(h.store.inspect(saved.id));
  }
});
test('bounded pages expose summary only, ordered by observation time with stable cursors', async () => {
  const h = fixture(); const first = await h.capture(); h.input.requestKey = 'baseline-observation-002'; h.clock += 1000; h.source.observedAt = new Date(h.clock).toISOString(); const { sourceHash, evaluation, ...raw } = h.source; h.source.sourceHash = hash(raw); const second = await h.capture();
  const page = await h.store.list({ limit: 1 }); assert.equal(page.records[0].id, second.id); assert.equal(page.records[0].sources, undefined); assert.equal(page.records[0].evaluation, undefined); assert.ok(page.next);
  const last = await h.store.list({ after: page.next, limit: 1 }); assert.equal(last.records[0].id, first.id); assert.equal(last.next, null);
  await assert.rejects(h.store.list({ after: 'bad-cursor' }), /cursor/); await assert.rejects(h.store.list({ limit: 51 }), /bounded/);
});
test('scope overrides, raw sources and invalid dates are rejected before provider access', async () => {
  for (const mutate of [h => { h.input.sources = sources(); }, h => { h.input.connectionId = 'f'.repeat(24); }, h => { h.input.fromDate = 'bad'; }, h => { h.input.throughDate = '2026-10-07'; }, h => { h.input.fromDate = '2020-01-01'; }]) { const h = fixture(); mutate(h); await assert.rejects(h.capture()); assert.equal(h.reads, 0); }
});
test('unsafe authority counters fail closed and roll back all capture writes', async () => {
  const h = fixture(); h.data.Users[0].businessObservationVersion = Number.MAX_SAFE_INTEGER; await assert.rejects(h.capture(), /actor or owner/); assert.equal(h.data.Baselines.length, 0);
});
test('model validates immutable evidence offline and refuses query mutation without connecting', async () => {
  const h = fixture(); await h.capture();
  const Model = require('../src/models/BusinessBaseline'), row = h.data.Baselines[0];
  await new Model(row).validate(); assert.equal(Model.schema.options.autoCreate, false); assert.equal(Model.schema.options.autoIndex, false);
  for (const operation of ['updateOne', 'deleteOne', 'findOneAndUpdate']) await assert.rejects(Model[operation]({ _id: row._id }, { status: 'accepted' }), /append-only/);
  const altered = clone(row); altered.payload.accepted = true; altered.evidenceHash = hash(altered.payload); assert.throws(() => validateBaselineObservation(altered), /original source/);
});

test('collection readiness alone never unlocks capture before setup completion', async () => {
  const h = fixture(); h.setupIncomplete = true; await assert.rejects(h.capture(), /setup incomplete/); assert.equal(h.reads, 0); assert.equal(h.writes, 0);
  const late = fixture(); late.onReports = () => { late.setupIncomplete = true; }; await assert.rejects(late.capture(), /setup incomplete/); assert.equal(late.data.Baselines.length, 0);
});
test('non-object capture inputs are rejected without source reads', async () => {
  const h = fixture(); for (const value of [null, [], 1, 'bad']) await assert.rejects(h.store.capture(value), error => error.status === 400); assert.equal(h.reads, 0);
});


test('new captures retain current inventory privately, and reject altered inventory or account observations', async () => {
  const h = fixture(), saved = await h.capture(); assert.equal(h.inventoryReads, 1); assert.equal(h.data.Baselines[0].contractVersion, 2);
  assert.equal(saved.inventory.entities.find(row => row.entity === 'Invoice').earliestDate, '2026-09-01'); assert.equal(saved.inventorySources, undefined);
  assert.equal(h.data.Audits[0].afterState.inventoryHash, saved.inventory.sourceHash);
  h.data.Baselines[0].inventorySources.records.Invoice[0].syncToken = '2'; await assert.rejects(h.store.inspect(saved.id));
  const changed = fixture(); changed.source.accounts[0].Name = 'changed after inventory'; const { sourceHash, evaluation, ...raw } = changed.source; changed.source.sourceHash = hash(raw);
  await assert.rejects(changed.capture(), /report accounts differ/); assert.equal(changed.writes, 0);
});
test('inventory failure cancels report reader and cannot save a report-only replacement', async () => {
  const h = fixture(); let aborted = false;
  h.onReports = ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  h.onInventory = () => { throw new Error('inventory incomplete'); };
  await assert.rejects(h.capture(), /inventory incomplete/); assert.equal(aborted, true); assert.equal(h.data.Baselines.length, 0);
});
test('lost capture response reuses the original inventory without another scan', async () => {
  const h = fixture(); h.loseReply = true; await assert.rejects(h.capture(), /reply lost/); h.onInventory = () => { throw new Error('must not rescan'); };
  const saved = await h.capture(); assert.equal(saved.reused, true); assert.equal(h.inventoryReads, 1);
});
test('original contract1 observations remain readable and do not acquire invented inventory', async () => {
  const h = fixture(), saved = await h.capture(), row = h.data.Baselines[0];
  row.contractVersion = 1; row.payload.version = 1; row.payload.inventory = 'unverified'; delete row.inventorySources; row.evidenceHash = hash(row.payload);
  const audit = h.data.Audits[0].afterState; audit.evidenceHash = row.evidenceHash; for (const key of ['inventoryVersion', 'inventoryHash', 'inventoryStartedAt', 'inventoryObservedAt']) delete audit[key];
  assert.equal((await h.store.inspect(saved.id)).inventory, 'unverified');
  await new (require('../src/models/BusinessBaseline'))(row).validate();
});
test('stale inventory, mismatched combined intervals and oversized BSON cannot be saved', async () => {
  const h = fixture(); h.clock += 300001; await assert.rejects(h.capture(), /stale/); assert.equal(h.writes, 0);
  const { assertBaselineDocumentSize } = require('../src/modules/business-baseline');
  assert.throws(() => assertBaselineDocumentSize({ repeated: Array(2000000).fill(0) }), /BSON storage budget/);
});


test('captured inventory pages are audited, scope bound and omit private hashes', async () => {
  const h = fixture(), saved = await h.capture();
  const first = await h.store.inventoryPage(saved.id, { entity: 'Account', limit: 1 });
  assert.equal(first.records.length, 1); assert.equal(first.total, 2); assert.equal(first.records[0].contentHash, undefined); assert.equal(first.currentVerified, false); assert.ok(first.next);
  const second = await h.store.inventoryPage(saved.id, { entity: 'Account', after: first.next, limit: 1 }); assert.notEqual(second.records[0].id, first.records[0].id); assert.equal(second.next, null);
  const empty = await h.store.inventoryPage(saved.id, { entity: 'Bill' }); assert.equal(empty.total, 0); assert.equal(empty.next, null);
  const captured = await h.store.inventoryRecord(saved.id, 'Invoice', '20'); assert.equal(captured.record.contentHash, h.inventorySource.records.Invoice[0].contentHash); assert.equal(captured.records, undefined);
  await assert.rejects(h.store.inventoryRecord(saved.id, 'Invoice', '999'), error => error.status === 404);
  for (const input of [{ entity: 'Invoice', after: first.next }, { entity: 'Account', limit: 51 }, { entity: 'Account', actorId }, { entity: 'Employee' }]) await assert.rejects(h.store.inventoryPage(saved.id, input));
  const cursor = JSON.parse(Buffer.from(first.next, 'base64url').toString()); cursor.inventoryHash = 'f'.repeat(64);
  await assert.rejects(h.store.inventoryPage(saved.id, { entity: 'Account', after: Buffer.from(JSON.stringify(cursor)).toString('base64url') }), /cursor/);
  h.data.Audits = []; await assert.rejects(h.store.inventoryPage(saved.id, { entity: 'Account' }), /audit/);
});
test('inventory pages respect current read permissions and revoked access after storage read', async () => {
  const h = fixture(), saved = await h.capture(); h.canReview = false; await assert.rejects(h.store.inventoryPage(saved.id, { entity: 'Invoice' }), /revoked/);
  h.canReview = true; h.onQuery = key => { if (key === 'Baselines') h.canReview = false; };
  await assert.rejects(h.store.inventoryRecord(saved.id, 'Invoice', '20'), /revoked/);
});
