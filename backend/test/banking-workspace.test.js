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
    getLedger: async (s, accountId) => clone([...events.values()].find(row => row.kind === 'ledger-account' && row.accountId === accountId && Object.keys(scope).every(k=>row[k] === s[k])) || null),
    getPackages: async (s, ids) => [...packages.values()].filter(row=>ids.includes(row._id) && Object.keys(scope).every(k=>row[k] === s[k])).map(row=>clone(row)),
    ledgerAccountIds: async s => [...events.values()].filter(row=>row.kind === 'ledger-account' && Object.keys(scope).every(k=>row[k] === s[k])).map(row=>row.accountId),
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
  assert.equal((await fetch(base + '/accounts/60/ledger-baseline?throughPeriod=2026-10')).status,401);
  assert.equal((await fetch(base + '/accounts/60/ledger',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(base + '/accounts/60/ledger-baseline?throughPeriod=2026-10&realmId=99',{headers})).status,400);
  assert.equal((await fetch(base + '/accounts/60/ledger',{method:'POST',headers,body:JSON.stringify({realmId:'99'})})).status,400);
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

// BANK-2.1: production service/store contract, isolated storage and artifacts only.
function ledgerOpening(accountId, period, amountMinor) {
  const source = {accountId,currency:'CAD',storedNativeBookBalanceMinor:10000,sourceRef:'retained-source'};
  const evidenceHash = require('../src/modules/bank-settlement-contract').hash(source);
  return {accountId,accountCurrency:'CAD',period,amountMinor,basis:'Retained exact opening reconstruction',evidenceRef:source.sourceRef,evidenceHash,
    source:{...source,evidenceHash},crossCheck:{derivedOpeningMinor:amountMinor,anchorMinor:10000,retainedMovementMinor:10000-amountMinor}};
}
function manifestCrosswalk(snapshot) {
  return snapshot.rows.map(spec=>{
    const event=snapshot.events.find(e=>e.eventId===spec.eventId);
    return {...spec,date:event.actualPostingDate||event.expectedPostingDate,amountMinor:event.amountMinor,description:require('../src/modules/bank-feed-csv').description(event),
      source:clone(event.source),qboRefs:clone(event.resolution?.linkedQboIds||[]),...(event.settlementGroupId===undefined?{}:{settlementGroupId:event.settlementGroupId}),...(event.pairedEventId===undefined?{}:{pairedEventId:event.pairedEventId})};
  });
}
async function evidencedBaseline(h, accountId = '60', card = false) {
  h.accounts.set(accountId, {Id:accountId,Name:card ? 'Retained card' : 'Retained bank',AccountType:card ? 'Credit Card' : 'Bank',CurrencyRef:{value:'CAD'}});
  const input = h.input({accountId,openingMinor:1000,closingMinor:6000,balanceConvention:card ? 'card-amount-owed' : 'bank-balance'});
  Object.assign(input.events[0],{accountId,amountMinor:card ? -5000 : 5000,status:'resolved'});
  // Rebuild CSV after changing account/native signs.
  const value = h.input(input); value.files = value.files.slice(-3);
  const file = value.files.find(f=>f.kind === 'manifest');
  const manifest = JSON.parse(h.artifacts.get(file.path));
  Object.assign(manifest,{openingMinor:1000,closingMinor:6000,openingEvidence:ledgerOpening(accountId,'2026-10',1000),events:clone(value.events),crosswalk:manifestCrosswalk(value),blockers:[],unresolvedEvents:[],outstandingItems:[],balanceCheck:{bookClosingMinor:6000,reconstructedBookClosingMinor:6000,differenceMinor:0,evidenceHash:hash('retained-monthly-proof')}});
  Object.assign(file,h.retain('ledger-manifest-'+accountId,JSON.stringify(manifest),accountId));
  return h.service.register(user,value);
}
test('independent bank/card adoption is inserts-only, exact, idempotent and survives reopen and changed QBO', async () => {
  for (const card of [false,true]) {
    const h = fixture(), accountId = card ? '85' : '123';
    const pkg = await evidencedBaseline(h,accountId,card), before = clone([...h.packages]), files = [...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]);
    const preview = await h.service.ledgerBaseline(user,accountId,'2026-10');
    assert.equal(h.events.size,2,'preview does not write');
    const command = {throughPeriod:'2026-10',baselineHash:preview.contentHash,packageIds:preview.packages.map(p=>p.id)};
    const accepted = await h.service.adoptLedger(user,accountId,command);
    assert.equal(accepted.openingMinor,1000); assert.equal(accepted.balance.balanceMinor,6000);
    assert.equal(accepted.events[0].eventId,pkg.snapshot.events[0].eventId);
    assert.equal(accepted.events[0].state,'posted'); assert.equal(accepted.adoption.actorId,user.actorId);
    assert.deepEqual([...h.packages],before); assert.deepEqual([...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]),files);
    assert.deepEqual(await h.service.adoptLedger(user,accountId,command),accepted);
    const beforeRead = await h.service.accountDetail(user,accountId);
    h.accounts.get(accountId).Name = 'Changed QBO name'; h.accounts.get(accountId).CurrencyRef.value = 'USD';
    h.synced.set('Invoice:486',{...scope,record:{Id:'486',TotalAmt:999999,TxnDate:'2026-11-01'}});
    const reopen = createBankingWorkspaceService({store:h.store,resolveContext:async()=>h.context,authorize:async()=>{},getAccount:async()=>{throw Error('Independent reads must not access QBO mirror');},readArtifact:async file=>{const bytes=h.artifacts.get(file.path);assert.equal(digest(bytes),file.sha256);return bytes;}});
    assert.deepEqual(await reopen.accountDetail(user,accountId),beforeRead);
    assert.equal((await reopen.accounts(user)).accounts[0].accountName,card ? 'Retained card' : 'Retained bank');
    assert.equal((await reopen.download(user,pkg.id,'feed-1')).sha256,pkg.snapshot.files[0].sha256);
    h.accounts.delete(accountId);
    assert.deepEqual((await reopen.accountDetail(user,accountId)).independentLedger,accepted);
    // Later package revision must not silently replace the frozen accepted history.
    h.packages.get(pkg.id).state.supersededBy = 'new-qbo-reconstruction';
    const changed = clone(h.packages.get(pkg.id)); changed._id = hash('changed package'); changed.revision = 2; changed.state.supersededBy = null;
    changed.snapshot.events[0].amountMinor *= 2; changed.snapshot.closingMinor = 11000; changed.contentHash = hash(changed.snapshot); h.packages.set(changed._id,changed);
    assert.equal((await reopen.accountDetail(user,accountId)).package.id,pkg.id);
    assert.deepEqual((await reopen.accountDetail(user,accountId)).independentLedger,accepted);
    const later=clone(changed);later._id=hash('later package');later.period='2026-11';later.snapshot.period='2026-11';later.contentHash=hash(later.snapshot);h.packages.set(later._id,later);
    assert.equal((await reopen.accounts(user)).accounts[0].balanceMinor,6000);
    assert.equal((await reopen.accountDetail(user,accountId)).package.id,pkg.id);
    assert.equal((await reopen.accountDetail(user,accountId)).selectedPeriodAdopted,true);
    assert.ok((await reopen.accountDetail(user,accountId)).availablePeriods.some(p=>p.period==='2026-11'));
    await assert.rejects(h.service.adoptLedger(user,accountId,{...command,baselineHash:hash('changed source')}),/frozen/);
    assert.equal(h.events.size,3);
  }
});
test('independent baseline rejects unproved openings, altered files, discontinuities, stale review and unauthorized adoption', async () => {
  for(const failure of ['opening','file','gap','scope','balance','review','hash','denied']) {
    const h = fixture(); const pkg = await evidencedBaseline(h);
    const preview = await h.service.ledgerBaseline(user,'60','2026-10');
    if(failure === 'file') h.artifacts.set(pkg.snapshot.files[0].path,Buffer.from('changed bytes'));
    if(failure === 'gap') {const other=clone(h.packages.get(pkg.id));other._id=hash('gap');other.period='2026-12';other.snapshot.period='2026-12';other.contentHash=hash(other.snapshot);h.packages.set(other._id,other);}
    if(failure === 'scope') h.packages.get(pkg.id).realmId='99';
    if(failure === 'balance') h.packages.get(pkg.id).snapshot.closingMinor++;
    if(failure === 'review') h.packages.get(pkg.id).state.needsReview={reason:'Changed predecessor'};
    if(failure === 'opening') {const file=pkg.snapshot.files.find(f=>f.kind==='manifest');const manifest=JSON.parse(h.artifacts.get(file.path));manifest.openingEvidence.evidenceHash=null;const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);h.packages.get(pkg.id).snapshot.files.find(f=>f.kind==='manifest').sha256=digest(bytes);h.packages.get(pkg.id).contentHash=hash(h.packages.get(pkg.id).snapshot);}
    if(failure === 'denied') h.deny();
    await assert.rejects(h.service.adoptLedger(user,'60',{throughPeriod:failure === 'gap'?'2026-12':'2026-10',baselineHash:failure === 'hash'?hash('wrong'):preview.contentHash,packageIds:preview.packages.map(p=>p.id)}));
    assert.equal([...h.events.values()].filter(e=>e.kind==='ledger-account').length,0);
  }
});
test('native pending, posted and reversed arithmetic retains state history and rejects malformed states', () => {
  const {balances} = require('../src/modules/independent-bank-ledger');
  const event = {eventId:'stable',accountId:'123',accountCurrency:'CAD',amountMinor:1234,disposition:'included',state:'pending',stateHistory:[{state:'pending',date:'2026-11-02',evidenceRef:'instruction'}]};
  const ledger={account:{accountId:'123',accountCurrency:'CAD',balanceConvention:'bank-balance'},openingMinor:10000,events:[event]};
  assert.equal(balances(ledger).balanceMinor,10000);assert.equal(balances(ledger).pendingNativeMinor,1234);
  event.state='posted';event.stateHistory.push({state:'posted',date:'2026-11-03',evidenceRef:'settlement'});assert.equal(balances(ledger).balanceMinor,11234);
  event.state='reversed';event.stateHistory.push({state:'reversed',date:'2026-11-04',evidenceRef:'return'});assert.equal(balances(ledger).balanceMinor,10000);assert.equal(balances(ledger).reversedCount,1);assert.equal(event.stateHistory.length,3);
  ledger.account.balanceConvention='card-amount-owed';event.state='posted';event.stateHistory.pop();assert.equal(balances(ledger).balanceMinor,8766);
  event.state='mystery';assert.throws(()=>balances(ledger),/Unknown/);
});

test('adoption renews write authority transactionally and frozen reads do not loosen native evidence writes', async () => {
  const h=fixture(), pkg=await evidencedBaseline(h), preview=await h.service.ledgerBaseline(user,'60','2026-10');
  const command={throughPeriod:'2026-10',baselineHash:preview.contentHash,packageIds:preview.packages.map(p=>p.id)};
  const tx=h.store.transaction;h.store.transaction=work=>tx(async session=>{h.deny();return work(session);});
  await assert.rejects(h.service.adoptLedger(user,'60',command),/permission/);
  assert.equal(h.events.size,2);
  const a=fixture(), original=await evidencedBaseline(a), p=await a.service.ledgerBaseline(user,'60','2026-10');
  await a.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)});
  a.accounts.delete('60');assert.equal((await a.service.accountDetail(user,'60')).balanceMinor,6000);
  await assert.rejects(a.service.recordImport(user,original.id,a.command(original,'start',{fileId:'feed-1',attemptId:'attempt',fileHash:original.snapshot.files[0].sha256,accountId:'60',accountCurrency:'CAD'})),/Account is missing/);
  assert.equal(a.packages.get(original.id).stateVersion,0);
});
test('bounded carried baseline preserves original anchor and does not invent earlier events or pending observations', async () => {
  const h=fixture(), pkg=await evidencedBaseline(h,'85',true), row=h.packages.get(pkg.id), file=row.snapshot.files.find(f=>f.kind==='manifest');
  const manifest=JSON.parse(h.artifacts.get(file.path));const {hash:proofHash}=require('../src/modules/bank-settlement-contract');
  manifest.openingEvidence=ledgerOpening('85','2026-09',0);
  const {evidenceHash:originalProofHash,...source}=manifest.openingEvidence.source;
  const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);file.sha256=digest(bytes);row.contentHash=hash(row.snapshot);
  const preview=await h.service.ledgerBaseline(user,'85','2026-10');
  assert.equal(preview.openingMinor,1000);assert.equal(preview.openingEvidence.amountMinor,0);assert.equal(preview.openingEvidence.acceptedOpening.period,'2026-10');assert.match(preview.openingEvidence.acceptedOpening.basis,/earlier activity is not adopted/);
  assert.equal(preview.events.length,1);assert.deepEqual(preview.events[0].stateHistory.map(s=>s.state),['posted']);
  for(const [key,value] of [['accountId','other'],['currency','USD']]) {
    const swapped={...source,[key]:value}, swappedHash=proofHash(swapped);
    manifest.openingEvidence.source={...swapped,evidenceHash:swappedHash};manifest.openingEvidence.evidenceHash=swappedHash;
    const altered=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,altered);file.sha256=digest(altered);row.contentHash=hash(row.snapshot);
    await assert.rejects(h.service.ledgerBaseline(user,'85','2026-10'),/Opening source/);
  }
});

function replaceOpening(h,pkg,opening) {
  const row=h.packages.get(pkg.id),file=row.snapshot.files.find(f=>f.kind==='manifest');
  const manifest=JSON.parse(h.artifacts.get(file.path));manifest.openingEvidence=opening;
  const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);file.sha256=digest(bytes);row.contentHash=hash(row.snapshot);
}
test('same-month and carried adoption reject invalid original opening identity, hashes and native arithmetic', async () => {
  const proofHash=require('../src/modules/bank-settlement-contract').hash;
  for (const carried of [false,true]) for(const defect of ['missing-source','hash','source-hash','account','currency','outer-account','outer-currency','derived','movement','anchor','native-anchor','unsafe-money']) {
    const h=fixture(),pkg=await evidencedBaseline(h);
    const opening=ledgerOpening('60',carried?'2026-09':'2026-10',carried?0:1000);
    if(defect==='missing-source')delete opening.source;
    if(defect==='hash')opening.evidenceHash=hash('bogus');
    if(defect==='source-hash')opening.source.evidenceHash=hash('bogus');
    if(defect==='outer-account')opening.accountId='85';
    if(defect==='outer-currency')opening.accountCurrency='USD';
    if(defect==='derived')opening.crossCheck.derivedOpeningMinor++;
    if(defect==='movement')opening.crossCheck.retainedMovementMinor++;
    if(defect==='anchor')opening.crossCheck.anchorMinor++;
    if(['account','currency','native-anchor','unsafe-money'].includes(defect)) {
      if(defect==='account')opening.source.accountId='85';
      if(defect==='currency')opening.source.currency='USD';
      if(defect==='native-anchor')opening.source.storedNativeBookBalanceMinor++;
      if(defect==='unsafe-money')opening.source.storedNativeBookBalanceMinor=Number.MAX_SAFE_INTEGER+1;
      const {evidenceHash,...body}=opening.source;opening.evidenceHash=proofHash(body);opening.source.evidenceHash=opening.evidenceHash;
    }
    replaceOpening(h,pkg,opening);
    await assert.rejects(async()=>{
      const preview=await h.service.ledgerBaseline(user,'60','2026-10');
      await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:preview.contentHash,packageIds:preview.packages.map(p=>p.id)});
    },undefined,(carried?'carried ':'same-month ')+defect);
    assert.equal([...h.events.values()].filter(e=>e.kind==='ledger-account').length,0);
  }
});
test('adopted overview and detail fetch frozen packages beyond production pagination', async () => {
  const h=fixture(),pkg=await evidencedBaseline(h,'123'),p=await h.service.ledgerBaseline(user,'123','2026-10');
  const accepted=await h.service.adoptLedger(user,'123',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)});
  const original=await h.service.accountDetail(user,'123');
  // Sort and limit exactly as the Mongo list adapter, including revision churn.
  const originalList=h.store.list;
  h.store.list=async(s,filter={},session,{all=false}={})=>{
    const rows=(await originalList(s,filter)).sort((a,b)=>a.accountId.localeCompare(b.accountId)||b.period.localeCompare(a.period)||b.revision-a.revision);
    return all?rows:rows.slice(0,2000);
  };
  for(let i=0;i<2001;i++){
    const row=clone(h.packages.get(pkg.id));row._id=hash('later-'+i);row.period='2026-11';row.revision=i+1;
    row.snapshot.period=row.period;row.snapshot.revision=row.revision;row.contentHash=hash(row.snapshot);h.packages.set(row._id,row);
  }
  assert.equal((await h.store.list(scope,{accountId:'123'})).some(row=>row._id===pkg.id),false);
  for(const read of [()=>h.service.accounts(user),()=>h.service.accountDetail(user,'123'),()=>h.service.accountDetail(user,'123',{period:'2026-10'})]) {
    const result=await read(),account=result.accounts?.find(a=>a.accountId==='123')||result;
    assert.equal(account.packageId,pkg.id);assert.equal(account.balanceMinor,original.balanceMinor);assert.deepEqual(account.independentLedger,accepted);
  }
  // Global pagination can omit the adopted account itself, not only its old package.
  h.accounts.set('100',{Id:'100',AccountType:'Bank',CurrencyRef:{value:'CAD'}});
  for(const row of h.packages.values())if(row._id!==pkg.id)row.accountId='100';
  assert.equal((await h.store.list(scope)).some(row=>row.accountId==='123'),false);
  assert.equal((await h.service.accounts(user)).accounts.find(a=>a.accountId==='123')?.packageId,pkg.id);
});

test('direct frozen-package retrieval still rejects missing, changed or cross-scope records', async () => {
  for(const defect of ['missing','scope','account','currency','period','revision','snapshot']) {
    const h=fixture(),pkg=await evidencedBaseline(h),p=await h.service.ledgerBaseline(user,'60','2026-10');
    await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)});
    h.store.getPackages=async()=>{
      const row=clone(h.packages.get(pkg.id));
      if(defect==='missing')return [];
      if(defect==='scope')row.realmId='99';
      if(defect==='account')row.accountId='85';
      if(defect==='currency')row.accountCurrency='USD';
      if(defect==='period')row.period='2026-11';
      if(defect==='revision')row.revision++;
      if(defect==='snapshot')row.snapshot.closingMinor++;
      return [row];
    };
    for(const read of [()=>h.service.accounts(user),()=>h.service.accountDetail(user,'60')])await assert.rejects(read,{code:'BANKING_EVIDENCE_UNAVAILABLE'},defect);
  }
});
test('Mongo frozen package/account discovery is scoped and bypasses package-list pagination', async () => {
  const seen=[];
  const store=createMongoBankingStore({Packages:{find:filter=>({maxTimeMS:ms=>({lean:async()=>{seen.push({kind:'packages',filter,ms});return [];}})})},
    Events:{distinct:(field,filter)=>({maxTimeMS:async ms=>{seen.push({kind:'accounts',field,filter,ms});return ['123'];}})},connection:{}});
  assert.deepEqual(await store.getPackages(scope,['frozen-id']),[]);
  assert.deepEqual(await store.ledgerAccountIds(scope),['123']);
  assert.deepEqual(seen,[{kind:'packages',filter:{...scope,_id:{$in:['frozen-id']}},ms:5000},{kind:'accounts',field:'accountId',filter:{...scope,kind:'ledger-account',revision:0},ms:5000}]);
});

function amendFinancialProof(h,pkg,change) {
  const row=h.packages.get(pkg.id),file=row.snapshot.files.find(f=>f.kind==='manifest');
  const manifest=JSON.parse(h.artifacts.get(file.path));change(row.snapshot,manifest);
  // Financial-gap tests change both representations; contradiction tests use their own independent manifest.
  manifest.events=clone(row.snapshot.events);manifest.crosswalk=manifestCrosswalk(row.snapshot);
  const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);file.sha256=digest(bytes);row.contentHash=hash(row.snapshot);
}
test('preview and adoption reject unresolved financial gaps and a one-cent retained-book mismatch', async () => {
  for(const defect of ['one-cent','comparison-only','false-zero','missing-comparison','missing-proof-hash','coverage-snapshot','coverage-manifest','unknown-blocker','unresolved-manifest','unresolved-event']) {
    const h=fixture(),pkg=await evidencedBaseline(h);
    amendFinancialProof(h,pkg,(snapshot,manifest)=>{
      if(['one-cent','comparison-only','false-zero'].includes(defect)) {manifest.balanceCheck.bookClosingMinor++;if(defect!=='false-zero')manifest.balanceCheck.differenceMinor++;}
      if(defect==='one-cent')snapshot.blockers.push('book-statement-balance-mismatch: retained book balance differs by one cent');
      if(defect==='missing-comparison')delete manifest.balanceCheck;
      if(defect==='missing-proof-hash')delete manifest.balanceCheck.evidenceHash;
      if(defect==='coverage-snapshot')snapshot.blockers.push('coverage: retained ledger rows are not fully represented');
      if(defect==='coverage-manifest')manifest.blockers.push('coverage: retained ledger rows are not fully represented');
      if(defect==='unknown-blocker')snapshot.blockers.push('unknown-unproved-financial-condition');
      if(defect==='unresolved-manifest')manifest.unresolvedEvents.push({eventId:'missing',status:'unresolved'});
      if(defect==='unresolved-event')snapshot.events[0].status='unresolved';
    });
    const packagesBefore=clone([...h.packages]),filesBefore=[...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]);
    await assert.rejects(async()=>{
      const p=await h.service.ledgerBaseline(user,'60','2026-10');
      await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)});
    },undefined,defect);
    assert.equal([...h.events.values()].filter(e=>e.kind==='ledger-account').length,0);
    assert.deepEqual([...h.packages],packagesBefore);assert.deepEqual([...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]),filesBefore);
  }
});
test('native-only inspection blockers do not bar financial adoption and remain in its frozen evidence', async () => {
  const h=fixture(),pkg=await evidencedBaseline(h);
  const native='existing-reconciled-mark-requires-native-inspection';
  amendFinancialProof(h,pkg,(snapshot,manifest)=>{
    snapshot.events[0].resolution={action:'Match',designatedCreator:'api-accountant',nativeActionBlockers:[native]};
    snapshot.blockers.push(snapshot.events[0].eventId+': '+native);manifest.blockers=clone(snapshot.blockers);manifest.readyForNativeWork=false;
  });
  const p=await h.service.ledgerBaseline(user,'60','2026-10');
  const adopted=await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)});
  assert.deepEqual(adopted.packages[0].financialEvidence.nativeWorkBlockers,h.packages.get(pkg.id).snapshot.blockers);
  assert.equal(adopted.packages[0].financialEvidence.balanceCheck.differenceMinor,0);
  assert.equal(adopted.balance.balanceMinor,6000);
  assert.equal(h.packages.get(pkg.id).state.reconciled,null);
});
test('financial comparison includes exact native outstanding movements with the card debt sign', async () => {
  for(const card of [false,true]) {
    const h=fixture(),pkg=await evidencedBaseline(h,card?'85':'123',card);
    amendFinancialProof(h,pkg,(snapshot,manifest)=>{
      snapshot.outstandingItems=[{eventId:'future-settlement',accountId:snapshot.accountId,currency:'CAD',amountMinor:card?-101:101,bookDate:'2026-10-30',expectedPostingDate:'2026-11-02'}];
      manifest.outstandingItems=clone(snapshot.outstandingItems);manifest.balanceCheck.bookClosingMinor=6101;manifest.balanceCheck.reconstructedBookClosingMinor=6101;
    });
    const p=await h.service.ledgerBaseline(user,pkg.accountId,'2026-10');assert.equal(p.balance.balanceMinor,6000);
    amendFinancialProof(h,pkg,(_s,m)=>m.balanceCheck.reconstructedBookClosingMinor=6000);
    await assert.rejects(h.service.ledgerBaseline(user,pkg.accountId,'2026-10'));
  }
});

test('direct adoption refuses financial gaps introduced after a valid preview without inserting a ledger', async () => {
  for(const defect of ['comparison','coverage','nested-unknown','nested-malformed']) {
    const h=fixture(),pkg=await evidencedBaseline(h),p=await h.service.ledgerBaseline(user,'60','2026-10');
    amendFinancialProof(h,pkg,(snapshot,manifest)=>{
      if(defect==='comparison'){manifest.balanceCheck.bookClosingMinor++;manifest.balanceCheck.differenceMinor++;}
      if(defect==='coverage')manifest.blockers.push('coverage: missing native rows');
      if(defect==='nested-unknown')snapshot.events[0].resolution={nativeActionBlockers:['unknown-financial-gap']};
      if(defect==='nested-malformed')snapshot.events[0].resolution={nativeActionBlockers:'unknown-financial-gap'};
    });
    await assert.rejects(h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)}),{code:'BANKING_LEDGER_INVALID'});
    assert.equal([...h.events.values()].filter(e=>e.kind==='ledger-account').length,0);
  }
});
test('event-level native warnings are retained even when summary arrays omitted them', async () => {
  for(const code of ['existing-reconciled-mark-requires-native-inspection','report-only-adjustment-requires-native-inspection']) {
    const h=fixture(),pkg=await evidencedBaseline(h);
    amendFinancialProof(h,pkg,snapshot=>snapshot.events[0].resolution={nativeActionBlockers:[code]});
    const p=await h.service.ledgerBaseline(user,'60','2026-10');
    assert.deepEqual(p.packages[0].financialEvidence.nativeWorkBlockers,[pkg.snapshot.events[0].eventId+': '+code]);
  }
});
test('admission refuses changed financial snapshots at transaction time', async () => {
  const h=fixture(),pkg=await evidencedBaseline(h),p=await h.service.ledgerBaseline(user,'60','2026-10');
  const transaction=h.store.transaction;h.store.transaction=work=>transaction(async session=>{
    h.packages.get(pkg.id).snapshot.blockers.push('coverage: changed during admission');
    return work(session);
  });
  await assert.rejects(h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:p.packages.map(v=>v.id)}),{code:'BANKING_CONFLICT'});
  assert.equal([...h.events.values()].filter(e=>e.kind==='ledger-account').length,0);
});
test('outstanding financial proof cannot duplicate events or cross native account/currency boundaries', async () => {
  for(const defect of ['duplicate','already-settled','account','currency']) {
    const h=fixture(),pkg=await evidencedBaseline(h);
    amendFinancialProof(h,pkg,(snapshot,manifest)=>{
      const item={eventId:defect==='already-settled'?snapshot.events[0].eventId:'future-settlement',accountId:defect==='account'?'85':'60',currency:defect==='currency'?'USD':'CAD',amountMinor:100,bookDate:'2026-10-30',expectedPostingDate:'2026-11-02'};
      snapshot.outstandingItems=defect==='duplicate'?[item,clone(item)]:[item];manifest.outstandingItems=clone(snapshot.outstandingItems);
      manifest.balanceCheck.bookClosingMinor=6000+snapshot.outstandingItems.length*100;manifest.balanceCheck.reconstructedBookClosingMinor=manifest.balanceCheck.bookClosingMinor;
    });
    await assert.rejects(h.service.ledgerBaseline(user,'60','2026-10'),{code:'BANKING_LEDGER_INVALID'});
  }
});

// Correctly hashed contradictions admitted via the normal registration boundary.
async function registeredManifestConflict(change) {
  const original=fixture(),base=await evidencedBaseline(original),input=clone(base.snapshot);
  const file=input.files.find(f=>f.kind==='manifest'),manifest=JSON.parse(original.artifacts.get(file.path));
  manifest.events=clone(input.events);
  change(manifest,input);
  const h=fixture();for(const [name,bytes] of original.artifacts)h.artifacts.set(name,Buffer.from(bytes));
  const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);file.sha256=digest(bytes);
  const row=await h.service.register(user,input);
  return {h,row,manifest};
}
for(const [defect,change] of [
  ['source identity',m=>m.events[0].source.id='different-source-record'],
  ['hidden manifest financial blocker',m=>m.events[0].resolution={...(m.events[0].resolution||{}),nativeActionBlockers:['unproved-native-amount']}],
]) test('normal register -> preview -> adoption rejects manifest-only '+defect,async()=>{
  const {h,row}=await registeredManifestConflict(change);
  const beforePackages=clone([...h.packages]),beforeEvents=clone([...h.events]),beforeFiles=[...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]);
  assert.ok(row.id,'normal registration accepted the hash-bound envelope');
  await assert.rejects(async()=>{
    const preview=await h.service.ledgerBaseline(user,'60','2026-10');
    await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:preview.contentHash,packageIds:preview.packages.map(p=>p.id)});
  });
  assert.deepEqual([...h.packages],beforePackages);assert.deepEqual([...h.events],beforeEvents);
  assert.deepEqual([...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]),beforeFiles);
});

test('manifest event/crosswalk set, provenance and aliases must agree before preview or direct adoption', async () => {
  const changes={
    'missing-events':m=>delete m.events,'null-events':m=>m.events=null,'malformed-event':m=>m.events=[null],
    'extra-event':m=>m.events.push({...clone(m.events[0]),eventId:'extra'}),'duplicate-event':m=>m.events.push(clone(m.events[0])),
    'missing-event':m=>m.events.pop(),'revision':m=>m.events[0].revision++,'amount':m=>m.events[0].amountMinor++,
    'account':m=>m.events[0].accountId='85','currency':m=>m.events[0].accountCurrency='USD',
    'scope':m=>m.events[0].scope={...scope,realmId:'99'},'malformed-scope':m=>m.events[0].scope=null,
    'posting':m=>m.events[0].actualPostingDate='2026-10-21','posting-evidence':m=>m.events[0].postingBasis='different-evidence',
    'source-hash':m=>m.events[0].sourceHash=hash('other source'),
    'conflicting-source-alias':m=>m.events[0].source.sourceHash=hash('other source'),
    'conflicting-resolution-alias':m=>m.events[0].resolution={action:'Add'},
    'conflicting-creator-alias':m=>m.events[0].resolution={designatedCreator:'native-add'},
    'link-provenance':m=>m.events[0].resolution={linkedQboIds:[{entity:'Payment',id:'other'}]},
    'line-provenance':m=>m.events[0].source.lineIds=['other-line'],
    'missing-crosswalk':m=>delete m.crosswalk,'extra-crosswalk':m=>m.crosswalk.push(clone(m.crosswalk[0])),
    'crosswalk-source':m=>m.crosswalk[0].source.id='wrong','crosswalk-qbo':m=>m.crosswalk[0].qboRefs=[{entity:'Invoice',id:'wrong'}],
    'crosswalk-revision':m=>m.crosswalk[0].eventRevision++,'crosswalk-amount':m=>m.crosswalk[0].amountMinor++,
    'crosswalk-date':m=>m.crosswalk[0].date='2026-10-21','crosswalk-pair':m=>m.crosswalk[0].pairedEventId='wrong',
  };
  for(const [defect,change] of Object.entries(changes)) {
    const {h,row}=await registeredManifestConflict(change);
    const before=clone([...h.packages]),events=clone([...h.events]),files=[...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]);
    await assert.rejects(h.service.ledgerBaseline(user,'60','2026-10'),{code:'BANKING_LEDGER_INVALID'},defect);
    await assert.rejects(h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:hash('reviewed preview'),packageIds:[row.id]}),{code:'BANKING_LEDGER_INVALID'},defect);
    assert.deepEqual([...h.packages],before);assert.deepEqual([...h.events],events);assert.deepEqual([...h.artifacts].map(([name,bytes])=>[name,digest(bytes)]),files);
  }
});
test('a manifest-only supported inspection warning stays event-bound and survives adoption', async () => {
  for(const code of ['existing-reconciled-mark-requires-native-inspection','report-only-adjustment-requires-native-inspection']) {
    const {h,row}=await registeredManifestConflict(m=>m.events[0].resolution={nativeActionBlockers:[code]});
    const p=await h.service.ledgerBaseline(user,'60','2026-10');
    const accepted=await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:[row.id]});
    assert.deepEqual(accepted.packages[0].financialEvidence.nativeWorkBlockers,[row.snapshot.events[0].eventId+': '+code]);
    assert.deepEqual(await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:[row.id]}),accepted);
  }
});
async function productionBaseline(count=1) {
  const C=require('../src/modules/bank-settlement-contract'),{buildBankStatementEvidence}=require('../src/modules/bank-statement-evidence'),{generateBankStatementPackages}=require('../src/modules/bank-statement-package');
  const records=Array.from({length:count},(_,i)=>({Id:String(486+i),TxnDate:'2026-10-20',TotalAmt:50,DepositToAccountRef:{value:'60'},CurrencyRef:{value:'CAD'}}));
  const rows=records.map(r=>({type:'Sales Receipt',entity:'SalesReceipt',transactionId:r.Id,accountId:'60',date:r.TxnDate,bankAccountAmountCents:5000,homeAmountCents:5000}));
  const history={scope,homeCurrency:'CAD',asOf:'2026-10-31',accounts:[{id:'60',name:'Operating CAD',type:'Bank',currency:'CAD',evidenceType:'bank-or-card-statement'}],
    mirror:records.map(record=>({scope,entity:'SalesReceipt',qboId:record.Id,record,observedAt:now})),ledger:{scope,sourceId:'fixture-ledger',observedAt:now,expectedRowCount:count,rows},
    provisionalRanges:[{accountId:'60',evidenceType:'bank-or-card-statement',provisionalStartMonth:'2026-10',provisionalEndMonth:'2026-10',periods:1,basis:'fixture retained range'}]};
  const proof={accountId:'60',currency:'CAD',asOf:history.asOf,storedNativeBookBalanceMinor:1000+count*5000,sourceRef:'fixture-original-ledger',sourceSha256:C.hash('fixture-source'),ledgerRowsHash:C.hash(rows),openingJournalIds:[]};proof.evidenceHash=C.hash(proof);
  const built=buildBankStatementEvidence(history,{version:1,scope,asOf:history.asOf,ledgerRowsHash:C.hash(rows),accounts:[proof],adjustments:[]});
  return generateBankStatementPackages(built.dataset,{balanceEvidence:built.evidence}).packages[0];
}
test('production generated manifests admit valid raw BF1 events, server aliases, reordered events and quiet months', async () => {
  for(const count of [0,2]) {
    const generated=await productionBaseline(count),h=fixture();
    for(const artifact of generated.artifacts)h.artifacts.set(artifact.path,Buffer.from(artifact.bytes));
    const input=clone(generated.envelope);
    if(count) {
      const file=input.files.find(f=>f.kind==='manifest'),manifest=JSON.parse(h.artifacts.get(file.path));manifest.events.reverse();
      const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);file.sha256=digest(bytes);
      assert.equal(input.events[0].sourceHash,undefined,'producer carries source hash in source, registration derives alias');
    }
    const registered=await h.service.register(user,input),before=clone([...h.packages]);
    if(count)assert.equal(registered.snapshot.events[0].sourceHash,input.events[0].source.sourceHash);
    const p=await h.service.ledgerBaseline(user,'60','2026-10');
    const accepted=await h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:[registered.id]});
    assert.equal(accepted.balance.balanceMinor,1000+count*5000);assert.equal(accepted.events.length,count);assert.deepEqual([...h.packages],before);
  }
});
test('stale previews and transaction-time event changes cannot bypass manifest consistency', async () => {
  const {h,row}=await registeredManifestConflict(()=>{}),p=await h.service.ledgerBaseline(user,'60','2026-10');
  const file=h.packages.get(row.id).snapshot.files.find(f=>f.kind==='manifest'),manifest=JSON.parse(h.artifacts.get(file.path));
  manifest.events[0].source.id='changed-after-preview';
  const bytes=Buffer.from(JSON.stringify(manifest));h.artifacts.set(file.path,bytes);file.sha256=digest(bytes);h.packages.get(row.id).contentHash=hash(h.packages.get(row.id).snapshot);
  const before=clone([...h.packages]),events=clone([...h.events]);
  await assert.rejects(h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:p.contentHash,packageIds:[row.id]}),{code:'BANKING_LEDGER_INVALID'});
  assert.deepEqual([...h.packages],before);assert.deepEqual([...h.events],events);
  const a=await registeredManifestConflict(()=>{}),prepared=await a.h.service.ledgerBaseline(user,'60','2026-10'),transaction=a.h.store.transaction;
  a.h.store.transaction=work=>transaction(async session=>{const stored=a.h.packages.get(a.row.id);stored.snapshot.events[0].source.id='concurrent-change';stored.contentHash=hash(stored.snapshot);return work(session);});
  await assert.rejects(a.h.service.adoptLedger(user,'60',{throughPeriod:'2026-10',baselineHash:prepared.contentHash,packageIds:[a.row.id]}),{code:'BANKING_CONFLICT'});
  assert.equal([...a.h.events.values()].filter(e=>e.kind==='ledger-account').length,0);
});

test('independent pending instructions reopen separately from frozen balance and expose only safe lineage fields',async()=>{
 const h=fixture(),pkg=await h.service.register(user,h.input());
 const ledger={scope,ledgerId:'fixture-ledger',account:{accountId:'60',accountCurrency:'CAD',accountType:'Bank',accountName:'Fictional Bank',balanceConvention:'bank-balance'},openingMinor:5000,openingPeriod:'2026-10',throughPeriod:'2026-10',events:[],packages:[{id:pkg.id,contentHash:pkg.contentHash,period:pkg.period,revision:pkg.revision}]};ledger.balance=require('../src/modules/independent-bank-ledger').balances(ledger);ledger.contentHash=hash(ledger);
 h.events.set('ledger',{...scope,kind:'ledger-account',accountId:'60',contentHash:ledger.contentHash,payload:clone(ledger)});
 const payload={scope,eventId:'pending-event',state:'pending',accountId:'60',accountCurrency:'CAD',amountMinor:1234,bookDate:'2026-11-01',receivedAt:now,description:'Payment #123',source:{entity:'Payment',id:'123',runId:'a'.repeat(24),originalActorId:user.actorId,record:{PrivateNote:'must remain private'},request:{secret:'private'}},deliveryActorId:user.id};
 const instruction={...scope,kind:'instruction',accountId:'60',contentHash:hash(payload),payload};h.store.listInstructions=async()=>({rows:[clone(instruction)],count:1});
 const detail=await h.service.accountDetail(user,'60');assert.equal(detail.pendingActivity.count,1);assert.equal(detail.pendingActivity.availability,'instruction-only');assert.equal(detail.pendingActivity.items[0].amountMinor,1234);assert.equal(detail.balanceMinor,5000);assert.deepEqual(detail.independentLedger,ledger);assert.equal(detail.pendingActivity.items[0].source.record,undefined);assert.equal(detail.pendingActivity.items[0].source.request,undefined);assert.equal(detail.pendingActivity.items[0].source.originalActorId,user.actorId);
 instruction.payload.amountMinor++;await assert.rejects(h.service.accountDetail(user,'60'),/evidence changed/);
});
test('periodless pending creator reservation survives later posting month and blocks native Add, while dated history stays exact',async()=>{
 for(const nativeAdd of [false,true]) {
  const h=fixture(),input=h.input({period:'2026-11',events:[{eventId:'reserved-pending',revision:1,accountId:'60',accountCurrency:'CAD',sourceHash:hash('pending-source'),amountMinor:5000,actualPostingDate:'2026-11-20',expectedResolution:nativeAdd?'add':'match',creator:nativeAdd?'native-add':'api-accountant',source:{entity:'Payment',id:'123'}}],rows:[{rowId:'row-1',eventId:'reserved-pending',eventRevision:1,fileId:'feed-1',rowNumber:1}]}),reservation={scope,eventId:'reserved-pending',accountId:'60',creator:'api-accountant'},key=hash({scope,eventId:reservation.eventId,revision:0}),row={...scope,_id:key,kind:'reservation',eventId:reservation.eventId,revision:0,accountId:'60',accountCurrency:'CAD',contentHash:hash(reservation),sourceHash:hash(reservation),payload:reservation};h.events.set(key,clone(row));h.store.getReservation=async(_s,id)=>clone([...h.events.values()].find(e=>e.kind==='reservation'&&e.eventId===id)||null);
  if(nativeAdd)await assert.rejects(h.service.register(user,input),/reservation/);else await h.service.register(user,input);
  assert.deepEqual(h.events.get(key),row,'first periodless creator reservation is retained verbatim');
 }
 const h=fixture(),input=h.input(),reservation={scope,eventId:input.events[0].eventId,accountId:'60',creator:'api-accountant',period:'2026-09'},row={...scope,kind:'reservation',accountId:'60',accountCurrency:'CAD',contentHash:hash(reservation),payload:reservation};h.store.getReservation=async()=>row;await assert.rejects(h.service.register(user,input),/reservation/);
});
