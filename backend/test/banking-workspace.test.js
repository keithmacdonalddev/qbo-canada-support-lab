'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const source = process.env.BF4_SOURCE_ROOT || path.resolve(__dirname, '../src');
const { createBankingWorkspaceService, createArtifactReader, createMongoBankingStore, hash } = require(path.join(source, 'modules/banking-workspace-service'));
const scope = { environment: 'production', realmId: '1234567890', connectionId: '1'.repeat(24) };
const user = { id: '2'.repeat(24), actorId: '3'.repeat(24), role: 'supervisor' };
const now = '2026-11-01T04:00:00.000Z';
const clone = structuredClone;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const packages = new Map(), events = new Map(), artifacts = new Map(), synced = new Map(), accounts = new Map([['60', { Id: '60', AccountType: 'Bank', CurrencyRef: { value: 'CAD' } }]]);
  const calls = [], context = { environment: scope.environment, connection: { connected: true, connectionId: scope.connectionId, realmId: scope.realmId } };
  let ready = true, loseCAS = false, denied = false;
  const store = {
    assertReady: async () => { if (!ready) throw Object.assign(new Error('Storage not prepared'), { code: 'BANKING_STORAGE_NOT_READY', status: 409 }); },
    transaction: async work => { const before = clone([...packages]), beforeEvents = clone([...events]); try { return await work('fake-session'); } catch (e) { packages.clear(); for (const row of before) packages.set(...row); events.clear(); for (const row of beforeEvents) events.set(...row); throw e; } },
    get: async (s, packageId) => { const row = packages.get(packageId); return row && Object.keys(scope).every(k => String(row[k]) === String(s[k])) ? clone(row) : null; },
    list: async (s, filter = {}) => [...packages.values()].filter(row => Object.keys(scope).every(k => String(row[k]) === String(s[k])) && Object.entries(filter).every(([k,v]) => row[k] === v)).map(value => clone(value)),
    putEvent: async row => { const old = events.get(row._id); if (old && old.contentHash !== row.contentHash) throw Object.assign(new Error('Event revision already has different content'), { status: 409, code: 'BANKING_CONFLICT' }); events.set(row._id, clone(row)); },
    fenceAccount: async (s, accountId, currency, session) => { assert.equal(session, 'fake-session'); calls.push({ fence: accountId, scope: clone(s), currency }); },
    insert: async row => { assert.ok(!packages.has(row._id)); packages.set(row._id, clone(row)); },
    replace: async (s, packageId, version, state) => { const row = packages.get(packageId); if (loseCAS || !row || row.stateVersion !== version || !Object.keys(scope).every(k => row[k] === s[k])) return false; row.state = clone(state); row.stateVersion++; return true; },
  };
  function retain(name, bytes = name, accountId = '60') { const content = Buffer.from(bytes), relative = hash(scope) + '/' + accountId + '/' + name; artifacts.set(relative, content); return { path: relative, sha256: digest(content) }; }
  const service = createBankingWorkspaceService({ store, now: () => now, resolveContext: async () => clone(context), authorize: async value => { calls.push(value); if (denied) throw Object.assign(new Error('No current permission'), { code: 'BUSINESS_ACCESS_DENIED', status: 403 }); }, getAccount: async (_s, accountId) => accounts.get(accountId), readArtifact: async value => { const bytes = artifacts.get(value.path); assert.ok(bytes, 'artifact retained'); assert.equal(digest(bytes), value.sha256); return bytes; }, findSyncedRecord: async (_s, ref) => synced.get(ref.entity + ':' + ref.id) });
  function ev(name = 'observed', strength = 'screen observed', automation) { return { strength, observedAt: now, note: 'Fixture native observation ' + name, ...(strength === 'operator attested' ? {} : { artifact: retain(name) }), ...(automation ? { automation } : {}) }; }
  function input(overrides = {}) {
    const value = { scope: clone(scope), accountId: '60', accountCurrency: 'CAD', period: '2026-10', revision: 1, previousPackageId: null, sourceSnapshotHash: hash('retained source'), policyVersion: 'fixture-v1', balanceConvention: 'bank-balance', openingMinor: 0, closingMinor: 5000,
      events: [{ eventId: 'Invoice:486:60', revision: 1, accountId: '60', accountCurrency: 'CAD', sourceHash: hash('Invoice486'), amountMinor: 5000, actualPostingDate: '2026-10-20', expectedResolution: 'match', creator: 'api-accountant', source: { entity: 'Invoice', id: '486' } }],
      rows: [{ rowId: 'row-1', eventId: 'Invoice:486:60', eventRevision: 1, fileId: 'feed-1', rowNumber: 1 }], files: [], outstandingItems: [], blockers: [], ...clone(overrides) };
    const csv = 'Date,Description,Amount\r\n' + value.events.map(e => e.actualPostingDate.slice(8,10) + '/' + e.actualPostingDate.slice(5,7) + '/' + e.actualPostingDate.slice(0,4) + ',Simulated banking,' + (e.amountMinor/100).toFixed(2)).join('\r\n') + '\r\n';
    if (value.rows.length) value.files.push({ fileId: 'feed-1', kind: 'csv', ...retain('feed-' + value.period + '-r' + value.revision + '.csv', csv, value.accountId), rowCount: value.rows.length });
    value.files.push({ fileId: 'statement', kind: 'statement', ...retain('statement-' + value.period + '-r' + value.revision + '.pdf', '%PDF-1.4 simulated statement', value.accountId) });
    value.files.push({ fileId: 'manifest', kind: 'manifest', ...retain('manifest-' + value.period + '-r' + value.revision + '.json', JSON.stringify({ scope: value.scope, accountId: value.accountId, accountCurrency: value.accountCurrency, period: value.period, rows: value.rows }), value.accountId) });
    return value;
  }
  function command(row, action, more = {}) { return { requestId: action + '-' + row.stateVersion, expectedVersion: row.stateVersion, action, evidence: ev(action + '-' + row.stateVersion), ...more }; }
  async function upload(row, attemptId = 'attempt-1') {
    const file = row.snapshot.files.find(f => f.kind === 'csv'), fields = { fileId: file.fileId, attemptId, fileHash: file.sha256, accountId: row.accountId, accountCurrency: row.accountCurrency };
    row = await service.recordImport(user, row.id, command(row, 'start', fields));
    row = await service.recordImport(user, row.id, command(row, 'uploaded', { ...fields, observedCount: file.rowCount, nativeConfirmation: 'Native import confirmation', nativeRows: row.snapshot.rows.map(r => ({ rowId: r.rowId, nativeRowId: 'native-' + r.rowId })) })); return row;
  }
  async function review(row, decision = 'match') { return service.recordRow(user, row.id, command(row, 'reviewed', { rowId: 'row-1', decision, reason: 'Exact native row reviewed' })); }
  async function resolve(row, action = 'matched', qboRefs = [{ entity: 'Invoice', id: '486' }]) { return service.recordRow(user, row.id, command(row, action, { rowId: 'row-1', qboRefs })); }
  function reconciliation(row) { return command(row, 'reconciled', { accountId: row.accountId, accountCurrency: row.accountCurrency, period: row.period, report: ev('native-report', 'native report retained'), completion: ev('zero-difference'), statementAttachment: ev('statement-attached'), openingMinor: row.snapshot.openingMinor, closingMinor: row.snapshot.closingMinor, differenceMinor: 0, outstandingItems: row.snapshot.outstandingItems }); }
  return { service, store, packages, events, artifacts, synced, accounts, calls, context, retain, input, ev, command, upload, review, resolve, reconciliation, setReady: v => ready = v, setCAS: v => loseCAS = v, deny: () => denied = true };
}
test('generated snapshot/event revisions are idempotent, immutable and require provisioned storage', async () => {
  const h = fixture(), input = h.input(), row = await h.service.register(user, input);
  assert.equal(row.summary.generated, true); assert.equal(row.summary.uploaded, false); assert.equal(row.summary.reconciled, false); assert.equal(h.events.size, 2);
  assert.deepEqual(await h.service.register(user, input), row);
  assert.equal((await h.service.download(user, row.id, 'feed-1')).sha256, input.files[0].sha256);
  input.policyVersion = 'changed'; await assert.rejects(h.service.register(user, input), /immutable/);
  h.setReady(false); await assert.rejects(h.service.register(user, h.input({ period: '2026-11', events: [], rows: [], openingMinor: 5000, closingMinor: 5000 })), /Storage/);
  assert.equal(h.packages.size, 1);
});
test('company/account/currency and cash-account boundaries fail closed', async () => {
  const h = fixture();
  for (const change of [p => p.scope.realmId = '99', p => p.events[0].accountCurrency = 'USD', p => p.accountCurrency = 'USD', p => p.rows[0].eventRevision = 9]) { const value = h.input(); change(value); await assert.rejects(h.service.register(user, value)); }
  h.accounts.get('60').AccountSubType = 'CashOnHand'; await assert.rejects(h.service.register(user, h.input()), /Cash accounts/); delete h.accounts.get('60').AccountSubType;
  const row = await h.service.register(user, h.input()); h.context.connection.realmId = '99'; await assert.rejects(h.service.detail(user, row.id), /not found/);
  assert.equal((await h.service.list(user)).packages.length, 0);
});
test('retained CSV and manifest content must agree with canonical native events', async () => {
  const h = fixture();
  for (const kind of ['amount','date','count','manifest']) {
    const value = h.input(); const file = value.files.find(f => f.kind === (kind === 'manifest' ? 'manifest' : 'csv'));
    const bad = kind === 'manifest' ? '{}' : 'Date,Description,Amount\r\n' + (kind === 'count' ? '' : (kind === 'date' ? '21/10/2026' : '20/10/2026') + ',Wrong,' + (kind === 'amount' ? '94.56' : '50.00') + '\r\n');
    Object.assign(file, h.retain('bad-' + kind, bad)); await assert.rejects(h.service.register(user, value), /CSV|manifest/);
  }
  const wrong = h.input(); wrong.files[0].path = hash({ ...scope, realmId: '99' }) + '/60/other.csv'; await assert.rejects(h.service.register(user, wrong), /namespace/);
});
test('interrupted import cannot blindly retry; recovery binds exact hash/count/account and native rows', async () => {
  const h = fixture(); let row = await h.service.register(user, h.input()); const file = row.snapshot.files[0];
  const fields = { fileId: file.fileId, fileHash: file.sha256, attemptId: 'a1', accountId: '60', accountCurrency: 'CAD' };
  row = await h.service.recordImport(user, row.id, h.command(row, 'start', fields));
  assert.match(row.nextAction, /interrupted/);
  await assert.rejects(h.service.recordImport(user, row.id, h.command(row, 'start', { ...fields, attemptId: 'a2' })), /uncertain/);
  row = await h.service.recordImport(user, row.id, h.command(row, 'interrupt', fields));
  await assert.rejects(h.service.recordImport(user, row.id, h.command(row, 'uploaded', { ...fields, accountId: '85', observedCount: 1, nativeConfirmation: 'wrong account', nativeRows: [{ rowId: 'row-1', nativeRowId: 'n1' }] })), /account/);
  await assert.rejects(h.service.recordImport(user, row.id, h.command(row, 'uploaded', { ...fields, observedCount: 2, nativeConfirmation: 'wrong count', nativeRows: [] })), /count/);
  row = await h.service.recordImport(user, row.id, h.command(row, 'not-imported', { ...fields, observedCount: 0, nativeConfirmation: 'Screen confirms upload never arrived' }));
  row = await h.upload(row, 'a2'); assert.equal(row.summary.uploaded, true);
  await assert.rejects(h.service.recordImport(user, row.id, h.command(row, 'start', { ...fields, attemptId: 'a3' })), /uploaded/);
});
test('idempotent actions, optimistic concurrency and full prior review decisions are retained', async () => {
  const h = fixture(); let row = await h.upload(await h.service.register(user, h.input()));
  const c = h.command(row, 'reviewed', { rowId: 'row-1', decision: 'pending', reason: 'First pending reason' });
  row = await h.service.recordRow(user, row.id, c); assert.deepEqual(await h.service.recordRow(user, row.id, c), row);
  await assert.rejects(h.service.recordRow(user, row.id, { ...c, reason: 'different reason' }), /Request id/);
  row = await h.review(row); assert.equal(row.summary.reviewed, 1); assert.equal(row.summary.matched, 0);
  assert.equal(row.evidence.history.find(e => e.requestId === c.requestId).decision.reason, 'First pending reason');
  await assert.rejects(h.service.recordRow(user, row.id, h.command({ ...row, stateVersion: 0 }, 'matched', { rowId: 'row-1', qboRefs: [{ entity: 'Invoice', id: '486' }] })), /Refresh|changed/);
  h.setCAS(true); await assert.rejects(h.resolve(row), /concurrently/); assert.equal((await h.service.detail(user, row.id)).summary.matched, 0);
});
test('matched, added, excluded and reviewed remain separate with creator and sync proof', async () => {
  const h = fixture(); let row = await h.upload(await h.service.register(user, h.input()));
  await assert.rejects(h.resolve(row), /review decision/); row = await h.review(row);
  await assert.rejects(h.resolve(row, 'matched', [{ entity: 'Customer', id: '1' }]), /QBO reference/);
  row = await h.resolve(row, 'matched', [{ entity: 'Invoice', id: '486' }, { entity: 'Payment', id: '26' }]); assert.equal(row.summary.matched, 1); assert.equal(row.summary.added, 0); assert.equal(row.evidence.rows['row-1'].matched.qboRefs.length, 2);
  await assert.rejects(h.resolve(row, 'added'), /resolved/);
  const a = fixture(), input = a.input(); input.events[0].creator = 'native-add'; input.events[0].expectedResolution = 'add'; let added = await a.upload(await a.service.register(user, input)); added = await a.review(added, 'add');
  await assert.rejects(a.resolve(added, 'added', [{ entity: 'Deposit', id: '99' }]), /not yet observed/);
  a.synced.set('Deposit:99', { ...scope, entity: 'Deposit', qboId: '99', deleted: false, lastObservedAt: now, record: { Id: '99', TotalAmt: 50, TxnDate: '2026-10-20', MetaData: { CreateTime: now }, DepositToAccountRef: { value: '85' }, CurrencyRef: { value: 'CAD' } } });
  await assert.rejects(a.resolve(added, 'added', [{ entity: 'Deposit', id: '99' }]), /account\/currency/);
  a.synced.get('Deposit:99').record.DepositToAccountRef.value = '60'; added = await a.resolve(added, 'added', [{ entity: 'Deposit', id: '99' }]); assert.equal(added.summary.added, 1); assert.equal(added.evidence.rows['row-1'].synced[0].strength, 'synced record observed');
  const x = fixture(); let excluded = await x.upload(await x.service.register(user, x.input())); excluded = await x.review(excluded, 'exclude'); excluded = await x.service.recordRow(user, excluded.id, x.command(excluded, 'excluded', { rowId: 'row-1', reason: 'Native duplicate excluded without creating bookkeeping' })); assert.equal(excluded.summary.excluded, 1); assert.equal(excluded.summary.matched, 0);
});
test('browser run checkpoints retain run/step/screenshot/outcome; failed evidence cannot claim completion', async () => {
  const h = fixture(); let row = await h.service.register(user, h.input()); const file = row.snapshot.files[0], start = h.ev('before-upload'); start.automation = { runId: 'browser-run-1', step: 'upload preview', screenshotPath: start.artifact.path, outcome: 'started' };
  row = await h.service.recordImport(user, row.id, h.command(row, 'start', { fileId: file.fileId, fileHash: file.sha256, attemptId: 'browser-import', accountId: '60', accountCurrency: 'CAD', evidence: start }));
  for (const outcome of ['failed','interrupted','ambiguous','started']) { const ev = h.ev('after-' + outcome); ev.automation = { runId: 'browser-run-1', step: 'confirm upload', screenshotPath: ev.artifact.path, outcome }; await assert.rejects(h.service.recordImport(user, row.id, h.command(row, 'uploaded', { fileId: file.fileId, fileHash: file.sha256, attemptId: 'browser-import', accountId: '60', accountCurrency: 'CAD', observedCount: 1, nativeConfirmation: 'Test confirmation', nativeRows: [{ rowId: 'row-1', nativeRowId: 'native-1' }], evidence: ev })), /successful/); }
  assert.deepEqual(row.evidence.imports[0].evidence[0].automation, start.automation);
});
test('reconciliation requires retained native report, distinct zero-difference and statement-attachment evidence', async () => {
  const h = fixture(); let row = await h.service.register(user, h.input());
  await assert.rejects(h.service.recordReconciliation(user, row.id, h.reconciliation(row)), /Resolve every/);
  row = await h.resolve(await h.review(await h.upload(row)));
  for (const mutate of [c => c.report.strength = 'operator attested', c => c.differenceMinor = 1, c => c.accountCurrency = 'USD', c => c.report.artifact = row.snapshot.files.find(f => f.kind === 'statement'), c => c.statementAttachment = c.completion]) { const c = h.reconciliation(row); mutate(c); await assert.rejects(h.service.recordReconciliation(user, row.id, c)); }
  const c = h.reconciliation(row); row = await h.service.recordReconciliation(user, row.id, c); assert.equal(row.summary.reconciled, true); assert.equal(row.evidence.reconciled.report.strength, 'native report retained');
  assert.deepEqual(await h.service.recordReconciliation(user, row.id, c), row); await assert.rejects(h.review(row), /immutable/);
});
test('quiet months need statements but no empty upload; card amount owed uses the opposite import sign', async () => {
  const h = fixture(); const quiet = await h.service.register(user, h.input({ events: [], rows: [], closingMinor: 0 })); assert.equal(quiet.summary.uploadRequired, false); assert.equal(quiet.summary.uploaded, false); assert.match(quiet.nextAction, /Reconcile/);
  h.accounts.set('85', { Id: '85', AccountType: 'Credit Card', CurrencyRef: { value: 'CAD' } });
  const value = h.input({ accountId: '85', balanceConvention: 'card-amount-owed', openingMinor: 20000, closingMinor: 15000, events: [{ eventId: 'cc-payment', revision: 1, accountId: '85', accountCurrency: 'CAD', actualPostingDate: '2026-10-20', amountMinor: 5000, sourceHash: hash('cc'), creator: 'api-accountant', expectedResolution: 'match' }], rows: [{ rowId: 'row-1', eventId: 'cc-payment', eventRevision: 1, fileId: 'feed-1', rowNumber: 1 }] });
  assert.equal((await h.service.register(user, value)).snapshot.closingMinor, 15000);
});
test('new revisions preserve uploaded evidence, block repeat imports, and flag later months', async () => {
  const h = fixture(); let row = await h.upload(await h.service.register(user, h.input()));
  const later = await h.service.register(user, h.input({ period: '2026-11', events: [], rows: [], openingMinor: 5000, closingMinor: 5000 }));
  const revised = await h.service.register(user, h.input({ revision: 2, previousPackageId: row.id }));
  assert.equal((await h.service.detail(user, row.id)).summary.uploaded, true); assert.equal(revised.summary.needsReview, true); assert.equal((await h.service.detail(user, later.id)).summary.needsReview, true);
  const file = revised.snapshot.files[0]; await assert.rejects(h.service.recordImport(user, revised.id, h.command(revised, 'start', { fileId: file.fileId, fileHash: file.sha256, attemptId: 'duplicate', accountId: '60', accountCurrency: 'CAD' })), /current revision/);
  const moved = h.input({ period: '2026-09', openingMinor: -5000, closingMinor: 0 }); moved.events[0].actualPostingDate = '2026-09-20'; const repaired = h.input({ ...moved, files: [] }); await assert.rejects(h.service.register(user, repaired), /different content/);
  const third = await h.service.register(user, h.input({ revision: 3, previousPackageId: revised.id })); assert.equal(third.summary.needsReview, true);
  assert.equal(h.packages.size, 4);
});
test('stable identity reservation is shared by every event revision and forbids a different month', async () => {
  const h = fixture(); const first = await h.service.register(user, h.input());
  const reservation = [...h.events.values()].find(e => e.kind === 'reservation'); assert.equal(reservation.revision, 0); assert.equal(reservation.payload.period, '2026-10');
  const altered = h.input({ revision: 2, previousPackageId: first.id }); altered.events[0].revision = 2; altered.rows[0].eventRevision = 2;
  const manifest = altered.files.find(f => f.kind === 'manifest'); Object.assign(manifest, h.retain('manifest-revision-2', JSON.stringify({ scope, accountId: '60', accountCurrency: 'CAD', period: altered.period, rows: altered.rows })));
  await h.service.register(user, altered); assert.equal([...h.events.values()].filter(e => e.kind === 'reservation').length, 1);
  const collision = clone(reservation); collision.payload.period = '2026-09'; collision.contentHash = hash(collision.payload); await assert.rejects(h.store.putEvent(collision), /different content/);
});
test('read authorization is renewed; list summaries omit large source/evidence bodies', async () => {
  const h = fixture(), row = await h.service.register(user, h.input()); const list = await h.service.list(user);
  assert.equal(list.packages[0].id, row.id); assert.equal(list.packages[0].snapshot, undefined); assert.equal(list.qboCalls, 0);
  h.deny(); await assert.rejects(h.service.detail(user, row.id), /permission/); await assert.rejects(h.service.download(user, row.id, 'feed-1'), /permission/);
});
test('artifact reader verifies retained bytes and blocks traversal and altered artifacts', async t => {
  const os = require('node:os'); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bf4-artifacts-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const read = createArtifactReader(dir);
  await fs.writeFile(path.join(dir, 'screen.png'), 'retained'); const artifact = { path: 'screen.png', sha256: digest('retained') }; assert.equal((await read(artifact)).toString(), 'retained');
  for (const file of ['../secret','C:/secret','..\\secret']) await assert.rejects(read({ ...artifact, path: file }), /storage/);
  await fs.writeFile(path.join(dir, 'screen.png'), 'changed'); await assert.rejects(read(artifact), /hash changed/);
});
test('models do not auto-create collections/indexes and reserve identity revision zero only for reservations', () => {
  const E = require(path.join(source, 'models/BankingEvent')), P = require(path.join(source, 'models/BankingPackage'));
  for (const Model of [E,P]) { assert.equal(Model.schema.options.autoCreate, false); assert.equal(Model.schema.options.autoIndex, false); assert.ok(Model.schema.indexes().some(([,o]) => o.unique)); }
  const event = new E({ ...scope, _id: 'event', eventId: 'e1', kind: 'revision', revision: 0, accountId: '60', accountCurrency: 'CAD', sourceHash: hash('s'), contentHash: hash('c'), payload: { a: 1 } }); assert.ok(event.validateSync()); event.kind = 'reservation'; assert.equal(event.validateSync(), undefined);
});
test('authenticated unmounted routes reject unauthenticated calls and company overrides', async t => {
  const express = require('express'), jwt = require('jsonwebtoken'), config = require('../src/config'); const { createBankingWorkspaceRouter } = require(path.join(source, 'routes/banking-workspace'));
  const h = fixture(), row = await h.service.register(user, h.input()), app = express(); app.use(express.json()); app.use('/banking', createBankingWorkspaceRouter({ service: h.service }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/banking'; const headers = { Authorization: 'Bearer ' + jwt.sign({ id: user.id, role: 'supervisor' }, config.jwtSecret, { algorithm: 'HS256' }), 'Content-Type': 'application/json' };
  assert.equal((await fetch(base)).status, 401); assert.equal((await fetch(base + '?realmId=99', { headers })).status, 400);
  const response = await fetch(base + '/packages/' + row.id, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).data.id, row.id);
  assert.equal((await fetch(base + '/packages', { method: 'POST', headers, body: JSON.stringify({ ...h.input(), ownerId: 'attacker' }) })).status, 400);
  assert.equal((await fetch(base + '/packages/' + row.id + '/files/unknown', { headers })).status, 404);
  assert.equal((await fetch(base + '/accounts')).status, 401);
  assert.equal((await fetch(base + '/accounts?realmId=99', { headers })).status, 400);
  const accounts = await fetch(base + '/accounts', { headers }); assert.equal(accounts.status, 200); assert.equal((await accounts.json()).data.accounts[0].accountId, '60');
  const detail = await fetch(base + '/accounts/60?period=2026-10', { headers }); assert.equal(detail.status, 200); assert.equal((await detail.json()).data.package.id, row.id);
  assert.equal((await fetch(base + '/accounts/60?realmId=99', { headers })).status, 400);
  assert.equal((await fetch(base + '/accounts/60?period=2026-11', { headers })).status, 404);
});
test('real retained banking audit replays through production register/detail path without database or QBO', async t => {
  const location = path.resolve(__dirname, '../../artifacts/goal-realization/banking-research-20261101.json');
  let audit; try { audit = JSON.parse(await fs.readFile(location, 'utf8')); } catch (error) { if (error.code === 'ENOENT') { t.skip('Private retained banking audit unavailable in this checkout'); return; } throw error; }
  const h = fixture(); let packages = 0, rows = 0; const observed = new Map();
  for (const account of audit.accounts.filter(a => a.evidenceType === 'bank-or-card-statement')) {
    h.accounts.set(account.id, { Id: account.id, AccountType: account.type, CurrencyRef: { value: account.currency } });
    const retained = audit.ledger.filter(r => r.accountId === account.id && r.bankAccountAmountCents !== 0 && r.date <= '2026-10-31');
    // BF4 consumes a persistence envelope; conversion is BF1's responsibility.
    // For this replay only, the audit's proved native ledger amounts are adapted
    // to CSV signs (card positive charge -> negative import), never converted FX.
    const range = audit.provisionalRanges.find(r => r.accountId === account.id); const months = []; for (let month = range.provisionalStartMonth; month <= range.provisionalEndMonth;) { months.push(month); const [year, number] = month.split('-').map(Number); month = number === 12 ? String(year + 1) + '-01' : String(year) + '-' + String(number + 1).padStart(2, '0'); }
    const groups = new Map(months.map(month => [month, []])); for (const [index, record] of retained.entries()) { const period = record.date.slice(0,7); if (!groups.has(period)) groups.set(period, []); groups.get(period).push({ record, index }); }
    for (const [period, entries] of [...groups].sort()) {
      const events = entries.map(({ record, index }) => ({ eventId: account.id + ':' + record.type.replace(/[^A-Za-z0-9]/g, '') + ':' + record.transactionId + ':' + index, revision: 1, accountId: account.id, accountCurrency: account.currency, actualPostingDate: record.date, amountMinor: account.type === 'Credit Card' ? -record.bankAccountAmountCents : record.bankAccountAmountCents, sourceHash: hash(record), expectedResolution: 'match', creator: 'api-accountant', source: { transactionId: record.transactionId, type: record.type } }));
      const specs = events.map((event, index) => ({ rowId: 'row-' + (index+1), eventId: event.eventId, eventRevision: 1, fileId: 'feed-1', rowNumber: index+1 }));
      const previous = [...h.packages.values()].filter(p => p.accountId === account.id).sort((a,b) => b.period.localeCompare(a.period))[0]; const opening = previous?.snapshot.closingMinor || 0;
      const value = h.input({ accountId: account.id, accountCurrency: account.currency, period, balanceConvention: account.type === 'Credit Card' ? 'card-amount-owed' : 'bank-balance', openingMinor: opening, closingMinor: opening + entries.reduce((sum,e) => sum + e.record.bankAccountAmountCents, 0), sourceSnapshotHash: hash(retained), events, rows: specs });
      const result = await h.service.register(user, value); assert.equal((await h.service.detail(user, result.id)).snapshot.rows.length, entries.length); packages++; rows += entries.length;
      for (const event of result.snapshot.events) if (['486','26','483','343','345'].includes(event.source.transactionId)) observed.set(account.id + ':' + event.source.transactionId, event.amountMinor);
    }
  }
  assert.equal(observed.get('60:486'), 5000); assert.equal(observed.get('60:26'), 342349); assert.equal(observed.get('60:343'), -10000); assert.equal(observed.get('85:343'), 10000); assert.equal(observed.get('1150040006:483'), -10000); assert.equal(observed.get('1150040005:483'), 10000);
  assert.equal([...h.events.values()].filter(e => e.kind !== 'reservation' && e.payload.source?.transactionId === '200').length, 0);
  assert.equal(packages, 324); assert.equal(rows, 3783); t.diagnostic('Retained audit replay: ' + rows + ' nonzero external ledger rows across ' + packages + ' account-month packages including quiet statements; Invoice486=5000, Payment26=342349, 483/343/345 paired, JE200 no native cash.');
});

test('concurrent account-month admission shares one transaction fence and rejects an incompatible carry-forward', async () => {
  const h = fixture(); const transact = h.store.transaction; let queue = Promise.resolve(), active = false, fences = [];
  h.store.transaction = work => { const result = queue.then(() => transact(async session => { active = true; try { return await work(session); } finally { active = false; } })); queue = result.catch(() => {}); return result; };
  h.store.fenceAccount = async (s, accountId, currency, session) => { assert.equal(active, true); assert.equal(session, 'fake-session'); fences.push({ s, accountId, currency }); };
  const october = h.input(), november = h.input({ period: '2026-11', events: [], rows: [], openingMinor: 7, closingMinor: 7 });
  const results = await Promise.allSettled([h.service.register(user, october), h.service.register(user, november)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1); assert.match(results.find(r => r.status === 'rejected').reason.message, /carry forward/); assert.equal(fences.length, 2); assert.ok(fences.every(f => f.accountId === '60' && f.currency === 'CAD')); assert.equal(h.packages.size, 1);
});
test('Mongo account fence is a common transactional write key across periods; no collection provisioning occurs', async () => {
  const writes = [], store = createMongoBankingStore({ Events: { updateOne: async (...args) => writes.push(args) }, Packages: {}, connection: {} });
  await store.fenceAccount(scope, '60', 'CAD', 'session-october'); await store.fenceAccount(scope, '60', 'CAD', 'session-november');
  assert.deepEqual(writes[0][0], writes[1][0]); assert.equal(writes[0][1].$inc.fenceVersion, 1); assert.equal(writes[0][1].$setOnInsert.kind, 'account-fence'); assert.equal(writes[0][2].session, 'session-october'); assert.equal(writes[1][2].session, 'session-november');
});
test('Native Add refuses old/unrelated amounts and a right category account with the wrong settlement account', async () => {
  const h = fixture(); const input = h.input(); Object.assign(input.events[0], { creator: 'native-add', expectedResolution: 'add' }); let row = await h.review(await h.upload(await h.service.register(user, input)), 'add');
  const record = { ...scope, entity: 'Deposit', qboId: '99', deleted: false, lastObservedAt: now, record: { Id: '99', TotalAmt: 50, TxnDate: '2026-10-20', CurrencyRef: { value: 'CAD' }, MetaData: { CreateTime: now }, DepositToAccountRef: { value: '60' } } }; h.synced.set('Deposit:99', record);
  record.record.TotalAmt = 49; await assert.rejects(h.resolve(row, 'added', [{ entity: 'Deposit', id: '99' }]), /amount\/date/); record.record.TotalAmt = 50;
  record.record.MetaData.CreateTime = '2026-10-01T00:00:00Z'; await assert.rejects(h.resolve(row, 'added', [{ entity: 'Deposit', id: '99' }]), /predates/); record.record.MetaData.CreateTime = now;
  record.record.DepositToAccountRef.value = '85'; record.record.Line = [{ AccountRef: { value: '60' } }]; await assert.rejects(h.resolve(row, 'added', [{ entity: 'Deposit', id: '99' }]), /amount\/date/);
});

test('BF1 v1 event source/resolution fields are retained directly and native R-mark blockers cannot be dropped', async t => {
  const enginePath = path.resolve(__dirname, '../src/modules/bank-settlement-engine.js');
  let engine, history; try { engine = require(enginePath); history = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures/bank-settlement-history.json'), 'utf8')); } catch (error) { if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ENOENT') { t.skip('BF1 builder output unavailable'); return; } throw error; }
  // The BF1 sanitized replay fixture uses a non-live scope. Bind it to this
  // isolated test context so the real BF1 converter follows its production path.
  history.scope = clone(scope); history.ledger.scope = clone(scope); for (const record of history.mirror) if (record.scope) record.scope = clone(scope);
  const dataset = engine.buildSettlementEvents(history), raw = dataset.events.find(e => e.source.entity === 'Payment' && e.source.id === '26');
  assert.equal(raw.amountMinor, 342349); assert.equal(raw.accountId, '60');
  const h = fixture(), posting = raw.actualPostingDate || raw.expectedPostingDate;
  const value = h.input({ accountId: raw.accountId, accountCurrency: raw.accountCurrency, period: posting.slice(0,7), closingMinor: raw.amountMinor, events: [{ ...raw, actualPostingDate: posting }], rows: [{ rowId: 'row-1', eventId: raw.eventId, eventRevision: raw.revision, fileId: 'feed-1', rowNumber: 1 }] });
  // Keep the real expected/observed date distinction in the admitted BF1 payload.
  value.events[0].actualPostingDate = raw.actualPostingDate;
  const row = await h.service.register(user, value); assert.deepEqual(row.snapshot.events[0].source, raw.source); assert.equal(row.snapshot.events[0].sourceHash, raw.source.sourceHash); assert.equal(row.snapshot.events[0].creator, 'none');
  const blocked = fixture(), blockedInput = blocked.input(); blockedInput.events[0].creator = 'none'; blockedInput.events[0].resolution = { action: 'Match', designatedCreator: 'existing-qbo', nativeActionBlockers: ['existing-reconciled-mark-requires-native-inspection'] }; const held = await blocked.service.register(user, blockedInput);
  assert.match(held.snapshot.blockers.join(' '), /native-inspection/); await assert.rejects(blocked.upload(held), /unblocked/);
});

test('BF1 aliases cannot override retained source, action or creator proof', async () => {
  for (const key of ['creator','expectedResolution','sourceHash']) {
    const h = fixture(), input = h.input(); Object.assign(input.events[0], { creator: 'none', source: { sourceHash: input.events[0].sourceHash }, resolution: { action: 'Match', designatedCreator: 'existing-qbo' } });
    input.events[0][key] = { creator: 'native-add', expectedResolution: 'add', sourceHash: hash('different source') }[key];
    await assert.rejects(h.service.register(user, input), /conflicts with retained BF1/); assert.equal(h.packages.size, 0);
  }
});


test('bank account views reopen retained history with exact native signs, dated balances and opening provenance', async () => {
  const h = fixture();
  h.accounts.get('60').Name = 'Operating CAD';
  h.accounts.set('61', { Id: '61', Name: 'Business card CAD', AccountType: 'Credit Card', CurrencyRef: { value: 'CAD' } });
  async function retainStatement(accountId, card) {
    const input = h.input({ accountId, balanceConvention: card ? 'card-amount-owed' : 'bank-balance', openingMinor: 1000, closingMinor: card ? 6000 : 6000,
      events: [{ eventId: accountId + ':settlement', revision: 1, accountId, accountCurrency: 'CAD', sourceHash: hash(accountId), amountMinor: card ? -5000 : 5000,
        expectedPostingDate: '2026-10-20', actualPostingDate: '2026-10-20', postingBasis: 'simulated-policy', description: 'Retained payment', expectedResolution: 'match', creator: 'none', source: { entity: card ? 'Purchase' : 'Payment', id: accountId }, resolution: { action: 'Match', designatedCreator: 'existing-qbo', linkedQboIds: [{ entity: card ? 'Purchase' : 'Payment', id: accountId }] } }],
      rows: [{ rowId: accountId + ':row', eventId: accountId + ':settlement', eventRevision: 1, fileId: 'feed-1', rowNumber: 1 }] });
    const file = input.files.find(f => f.kind === 'manifest'), manifest = JSON.parse(h.artifacts.get(file.path));
    Object.assign(manifest, { openingMinor: input.openingMinor, closingMinor: input.closingMinor, openingBasis: 'Retained balance reconstruction', openingEvidence: { evidenceRef: 'retained-opening-proof', evidenceHash: hash('opening'), basis: 'Native balance less retained movements', amountMinor: 1000, period: card ? '2026-09' : input.period } });
    Object.assign(file, h.retain('account-view-' + accountId + '.json', JSON.stringify(manifest), accountId));
    return h.service.register(user, input);
  }
  const bank = await retainStatement('60', false), card = await retainStatement('61', true);
  const before = clone([...h.packages]);
  const overview = await h.service.accounts(user);
  assert.equal(overview.bankName, 'Maple Harbour Bank'); assert.match(overview.evidenceLabel, /not independent/); assert.equal(overview.qboCalls, 0);
  assert.deepEqual(overview.accounts.map(a => [a.accountId, a.accountName, a.balanceMinor, a.balanceAsOf]), [['60','Operating CAD',6000,'2026-10-31'],['61','Business card CAD',6000,'2026-10-31']]);
  for (const [accountId, row, nativeAmount] of [['60',bank,5000],['61',card,-5000]]) {
    const detail = await h.service.accountDetail(user, accountId, { period: '2026-10' });
    assert.equal(detail.package.id, row.id); assert.equal(detail.openingEvidence.available, true); assert.equal(detail.openingEvidence.evidenceRef, 'retained-opening-proof');
    assert.equal(detail.transactions[0].amountMinor, nativeAmount); assert.equal(detail.transactions[0].balanceMovementMinor, 5000); assert.equal(detail.transactions[0].runningBalanceMinor, 6000);
    assert.equal(detail.transactions[0].rowId, accountId + ':row'); assert.equal(detail.transactions[0].source.sourceHash, hash(accountId)); assert.equal(detail.transactions[0].postingBasis, 'simulated-policy');
    if (accountId === '61') assert.match(detail.openingEvidence.basis, /Carried forward to 2026-10.*2026-09/);
    assert.equal(detail.pendingActivity.availability, 'not-observed'); assert.equal(detail.pendingActivity.count, null);
    const reopen = createBankingWorkspaceService({ store: h.store, resolveContext: async () => h.context, authorize: async () => {}, getAccount: async (_s, id) => h.accounts.get(id), readArtifact: async file => { const bytes = h.artifacts.get(file.path); assert.equal(digest(bytes), file.sha256); return bytes; } });
    assert.deepEqual(await reopen.accountDetail(user, accountId), detail);
    assert.equal((await reopen.download(user, row.id, 'feed-1')).sha256, row.snapshot.files.find(f => f.kind === 'csv').sha256);
  }
  assert.deepEqual([...h.packages], before, 'Bank-style reads preserve all accepted packages and native state');
  await assert.rejects(h.service.accountDetail(user, '60', { period: '2026-11' }), /No retained statement/);
  await assert.rejects(h.service.accountDetail(user, '60', { realmId: '99' }), /Exact account/);
  h.context.connection.realmId = '99'; assert.equal((await h.service.accounts(user)).accounts.length, 0);
});

test('bank account view exposes missing opening provenance and fails closed on inconsistent transaction balances', async () => {
  const h = fixture(), row = await h.service.register(user, h.input());
  const overview = await h.service.accounts(user);
  assert.equal(overview.accounts[0].openingEvidence.available, false); assert.match(overview.accounts[0].unavailableEvidence.join(' '), /unavailable|inconsistent/);
  h.packages.get(row.id).snapshot.closingMinor++;
  await assert.rejects(h.service.accountDetail(user, '60'), /movements/);
});


test('account transaction labels reuse the human-readable bank CSV descriptions', async () => {
  for (const [entity, kind, expected] of [['SalesReceipt','direct-receipt','Sales receipt'], ['BillPayment','bill-payment','Supplier payment'], ['Transfer','transfer-in','Bank transfer']]) {
    const h = fixture(), input = h.input();
    Object.assign(input.events[0], { kind, source: { entity, id: '486' } });
    await h.service.register(user, input);
    const detail = await h.service.accountDetail(user, '60');
    assert.equal(detail.transactions[0].description, expected);
  }
});
