'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const STRENGTHS = Object.freeze(['operator attested', 'screen observed', 'synced record observed', 'native report retained']);
const SCOPE_KEYS = ['environment', 'realmId', 'connectionId'];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
function fail(message, status = 400, code = 'BANKING_INVALID') { throw Object.assign(new Error(message), { status, code }); }
function check(ok, message, status, code) { if (!ok) fail(message, status, code); }
function sameScope(a, b) { return a && b && SCOPE_KEYS.every(key => String(a[key]) === String(b[key])); }
function id(value) { return typeof value === 'string' && ID.test(value); }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function integer(value) { return Number.isSafeInteger(value); }
function text(value, max = 2000) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function scoped(scope) {
  check(exact(scope, SCOPE_KEYS) && ['sandbox', 'production'].includes(scope.environment) && /^\d+$/.test(scope.realmId) && /^[a-f0-9]{24}$/.test(scope.connectionId), 'Exact connected company scope is required.');
  return Object.fromEntries(SCOPE_KEYS.map(key => [key, scope[key]]));
}
function bounded(value) { check(Buffer.byteLength(JSON.stringify(value) || '') <= 4000000, 'Banking request exceeds the retained evidence limit.'); }
function amountSum(values) { const value = values.reduce((sum, v) => sum + BigInt(v), 0n); check(value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER), 'Banking balance exceeds exact minor-unit range.'); return Number(value); }
// Only retained artifacts below one dedicated root may be read. No arbitrary path downloads.
function createArtifactReader(directory = path.resolve(__dirname, '../../../artifacts/banking')) {
  return async artifact => {
    check(exact(artifact, ['path', 'sha256']) && text(artifact.path, 500) && HASH.test(artifact.sha256), 'Retained artifact path and SHA-256 are required.');
    check(!path.isAbsolute(artifact.path) && !artifact.path.includes('\\') && !artifact.path.includes(':') && !artifact.path.split('/').includes('..'), 'Artifact must remain inside banking storage.');
    const base = await fs.realpath(directory);
    const target = await fs.realpath(path.resolve(base, artifact.path));
    check(target.startsWith(base + path.sep), 'Artifact escapes banking storage.');
    const stat = await fs.stat(target);
    check(stat.isFile() && stat.size <= 20000000, 'Banking artifact is missing or too large.');
    const bytes = await fs.readFile(target);
    check(crypto.createHash('sha256').update(bytes).digest('hex') === artifact.sha256, 'Retained artifact hash changed.', 409, 'BANKING_ARTIFACT_CHANGED');
    return bytes;
  };
}
function createMongoBankingStore({ Events, Packages, connection }) {
  const query = (Model, filter, session) => { let q = Model.findOne(filter).maxTimeMS(3000); if (session) q = q.session(session); return q.lean(); };
  return {
    async assertReady() {
      // Provisioning belongs to the separately reviewed storage job, never startup/import.
      for (const [Model, name] of [[Events, 'banking_event_revision'], [Packages, 'banking_package_revision']]) {
        const exists = await connection.db.listCollections({ name: Model.collection.name }, { nameOnly: true }).toArray();
        check(exists.length === 1, 'Provision banking storage before recording evidence.', 409, 'BANKING_STORAGE_NOT_READY');
        const indexes = await Model.collection.listIndexes().toArray();
        const expected = Model.schema.indexes().find(([, options]) => options.name === name)[0];
        check(indexes.some(index => index.name === name && index.unique === true && !index.sparse && !index.partialFilterExpression && (!index.collation || index.collation.locale === 'simple') && canonical(index.key) === canonical(expected)), 'Restore the reviewed banking uniqueness indexes.', 409, 'BANKING_STORAGE_NOT_READY');
      }
    },
    async transaction(work) { const session = await connection.startSession(); try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; } finally { await session.endSession(); } },
    get: (scope, packageId, session) => query(Packages, { ...scope, _id: packageId }, session),
    async list(scope, filter = {}, session, { all = false } = {}) { let q = Packages.find({ ...scope, ...filter }).sort({ accountId: 1, period: -1, revision: -1 }).maxTimeMS(5000); if (!all) q = q.limit(2000); if (session) q = q.session(session); return q.lean(); },
    async putEvent(row, session) { const old = await query(Events, { ...scoped(Object.fromEntries(SCOPE_KEYS.map(k => [k, String(row[k])]))), _id: row._id }, session); if (old) { check(old.contentHash === row.contentHash, 'Event revision already has different content.', 409); return; } await Events.create([row], { session }); },
    async fenceAccount(scope, accountId, accountCurrency, session) {
      const payload = { scope, accountId, accountCurrency }, contentHash = hash(payload);
      await Events.updateOne({ ...scope, _id: hash({ kind: 'account-fence', scope, accountId }), accountCurrency }, {
        $setOnInsert: { ...scope, accountId, accountCurrency, kind: 'account-fence', eventId: '@account:' + accountId, revision: 0, payload, sourceHash: contentHash, contentHash },
        $inc: { fenceVersion: 1 },
      }, { session, upsert: true, runValidators: true, setDefaultsOnInsert: false });
    },
    async insert(row, session) { await Packages.create([row], { session }); },
    async replace(scope, packageId, version, state, session) { const result = await Packages.updateOne({ ...scope, _id: packageId, stateVersion: version }, { $set: { state }, $inc: { stateVersion: 1 } }, { session, runValidators: true }); return result.modifiedCount === 1; },
  };
}
/**
 * BF4 v1 input is a plain persistence envelope: scope, accountId/accountCurrency,
 * period YYYY-MM, revision/previousPackageId, sourceSnapshotHash, policyVersion,
 * openingMinor/closingMinor, events, rows, files, outstandingItems, blockers.
 * BF1 event payload is retained verbatim alongside its stable id/revision/hash.
 * BF2 supplies retained artifact metadata (CSV, statement, manifest) and row crosswalk.
 * Inject store/resolveContext/authorize/getAccount/findSyncedRecord/readArtifact/now
 * for fully offline replay. No QBO client or service startup is used here.
 */
function createBankingWorkspaceService(dependencies = {}) {
  let defaultStore;
  const store = () => dependencies.store || (defaultStore ||= createMongoBankingStore({ Events: require('../models/BankingEvent'), Packages: require('../models/BankingPackage'), connection: require('mongoose').connection }));
  const resolve = dependencies.resolveContext || (user => require('./rebuild-context').createContextService().resolve(user));
  const now = dependencies.now || (() => new Date());
  const readArtifact = dependencies.readArtifact || createArtifactReader();
  const stamp = () => new Date(now()).toISOString();
  async function artifact(value, bound, accountId = bound.accountId) {
    check(value && typeof value.path === 'string' && value.path.startsWith(hash(bound.scope) + '/' + accountId + '/'), 'Artifact belongs to another company/account storage namespace.', 403, 'BANKING_ARTIFACT_BOUNDARY');
    return readArtifact(value);
  }
  function nativeSuccess(ev) { native(ev); check(!ev.automation || ev.automation.outcome === 'succeeded', 'Completed native work requires successful browser evidence.'); }
  function csvRows(bytes) {
    const source = bytes.toString('utf8').replace(/^\uFEFF/, ''), rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '"') { if (quoted && source[i+1] === '"') { field += '"'; i++; } else quoted = !quoted; }
      else if (ch === ',' && !quoted) { row.push(field); field = ''; }
      else if (ch === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    check(!quoted, 'CSV contains an incomplete quoted row.');
    if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    check(canonical(rows.shift()) === canonical(['Date','Description','Amount']), 'Use the Canadian three-column CSV profile.'); return rows;
  }
  async function bind(user, write = false) {
    check(user && /^[a-f0-9]{24}$/.test(String(user.id || '')) && /^[a-f0-9]{24}$/.test(String(user.actorId || user.id)), 'Authentication required.', 401);
    const context = await resolve(user);
    check(context.connection?.connected, 'Connect a company before using Banking.', 409, 'BANKING_DISCONNECTED');
    const scope = scoped({ environment: context.environment, realmId: context.connection.realmId, connectionId: String(context.connection.connectionId) });
    const actorId = String(user.actorId || user.id), ownerId = String(user.id);
    const action = write ? 'periods.manage' : 'periods.read';
    if (dependencies.authorize) await dependencies.authorize({ scope, actorId, ownerId, action });
    else await require('./business-runtime-access').createBusinessRuntimeAccess({ actorId, ownerId }).authorize(scope, action);
    return { scope, actorId, ownerId };
  }
  async function account(bound, accountId, currency) {
    check(id(accountId) && /^[A-Z]{3}$/.test(currency || ''), 'Exact banking account and currency are required.');
    const row = dependencies.getAccount ? await dependencies.getAccount(bound.scope, accountId) : await require('../models/CompanySyncRecord').findOne({ ...bound.scope, entity: 'Account', qboId: accountId, deleted: false }).maxTimeMS(3000).lean();
    const record = row?.record || row;
    check(record && (!row.environment || sameScope(row, bound.scope)) && String(record.Id || record.id) === accountId && ['Bank', 'Credit Card'].includes(record.AccountType || record.type) && (record.CurrencyRef?.value || record.currency) === currency, 'Account is missing, is not a bank/card, or has unproved account currency.', 409, 'BANKING_ACCOUNT_BOUNDARY');
    check(!['CashOnHand', 'Cash on hand'].includes(record.AccountSubType || record.subtype), 'Cash accounts need cashbook/count evidence, not bank-feed imports.');
    return record;
  }
  async function load(bound, packageId) {
    check(id(packageId), 'Invalid banking package id.');
    const row = await store().get(bound.scope, packageId);
    check(row && sameScope(row, bound.scope), 'Banking package not found.', 404, 'BANKING_NOT_FOUND');
    await account(bound, row.accountId, row.accountCurrency);
    return row;
  }
  function view(row) {
    const states = row.state.rows;
    const count = key => Object.values(states).filter(value => Boolean(value[key])).length;
    const uploaded = row.snapshot.files.filter(f => f.kind === 'csv').every(file => row.state.imports.some(run => run.fileId === file.fileId && run.status === 'uploaded'));
    const pendingImports = row.state.imports.filter(run => ['started', 'interrupted'].includes(run.status));
    const summary = { generated: true, uploaded: row.snapshot.rows.length > 0 && uploaded, uploadRequired: row.snapshot.rows.length > 0, reviewed: count('reviewed'), matched: count('matched'), added: count('added'), excluded: count('excluded'), pending: Object.values(states).filter(value => !value.matched && !value.added && !value.excluded).length, reconciled: Boolean(row.state.reconciled), needsReview: Boolean(row.state.needsReview) };
    return { id: row._id, accountId: row.accountId, accountCurrency: row.accountCurrency, period: row.period, revision: row.revision, previousPackageId: row.previousPackageId, contentHash: row.contentHash, stateVersion: row.stateVersion, summary,
      nextAction: row.state.needsReview ? 'Review revised history' : pendingImports.length ? 'Inspect interrupted import in QuickBooks' : row.state.reconciled ? 'Retain completed evidence' : row.snapshot.blockers.length ? 'Resolve package blockers' : !uploaded ? 'Upload exact file in QuickBooks' : summary.pending ? 'Review and resolve imported rows' : 'Reconcile in QuickBooks',
      snapshot: clone(row.snapshot), evidence: clone(row.state) };
  }
  function validatePackage(value, bound) {
    bounded(value);
    value = clone(value);
    check(exact(value, ['scope','accountId','accountCurrency','period','revision','previousPackageId','sourceSnapshotHash','policyVersion','openingMinor','closingMinor','balanceConvention','events','rows','files','outstandingItems','blockers']), 'Use the BF4 v1 package envelope.');
    check(sameScope(scoped(value.scope), bound.scope), 'Package belongs to another company.', 403, 'BANKING_SCOPE_BOUNDARY');
    check(/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period) && value.period >= '1900-01' && value.period <= '9999-12' && integer(value.revision) && value.revision > 0, 'Valid account month and positive revision are required.');
    check(HASH.test(value.sourceSnapshotHash) && text(value.policyVersion, 100) && integer(value.openingMinor) && integer(value.closingMinor), 'Snapshot hash, policy version and exact balances are required.');
    for (const key of ['events','rows','files','outstandingItems','blockers']) check(Array.isArray(value[key]), key + ' must be an array.');
    // Consume BF1 v1 events directly, retaining their source and resolution proof.
    for (const event of value.events || []) {
      check(event && typeof event === 'object' && !Array.isArray(event), 'Settlement events must be objects.');
      const derived = { sourceHash: event.source?.sourceHash,
        expectedResolution: typeof event.resolution?.action === 'string' ? event.resolution.action.toLowerCase() : undefined,
        creator: { 'existing-qbo': 'none', 'api-accountant': 'api-accountant', 'native-add': 'native-add' }[event.resolution?.designatedCreator] };
      check(!event.resolution?.designatedCreator || derived.creator, 'Unknown BF1 designated creator.');
      for (const [key, canonicalValue] of Object.entries(derived)) if (canonicalValue !== undefined) {
        check(event[key] === undefined || event[key] === canonicalValue, 'Settlement alias conflicts with retained BF1 ' + key + '.'); event[key] = canonicalValue;
      }
      if (Array.isArray(value.blockers)) for (const reason of event.resolution?.nativeActionBlockers || []) value.blockers.push(event.eventId + ': ' + reason);
    }
    value.blockers = [...new Set(value.blockers)];
    check(value.rows.length <= 10000 && value.events.length <= 10000 && value.files.length <= 100 && value.outstandingItems.length <= 2000, 'Package exceeds its bounded history size.');
    check(['bank-balance','card-amount-owed'].includes(value.balanceConvention), 'Declare the bank balance or card amount-owed convention.');
    const events = new Map(), rowIds = new Set(), files = new Map();
    for (const event of value.events) {
      check(id(event.eventId) && !events.has(event.eventId) && integer(event.revision) && event.revision > 0 && HASH.test(event.sourceHash) && integer(event.amountMinor) && event.amountMinor !== 0, 'Event requires stable identity, revision, source hash and nonzero native minor units.');
      check(event.accountId === value.accountId && event.accountCurrency === value.accountCurrency && (!event.scope || sameScope(scoped(event.scope), bound.scope)), 'Settlement event crosses account/currency/company boundary.', 403);
      check(['match','add','exclude','investigate'].includes(event.expectedResolution) && ['api-accountant','native-add','none'].includes(event.creator), 'Reserve one event creator and expected banking resolution.');
      check(event.expectedResolution !== 'add' || event.creator === 'native-add', 'Native Add requires an exclusive native-add creator reservation.');
      events.set(event.eventId, event);
    }
    for (const file of value.files) {
      check(exact(file, ['fileId','kind','path','sha256','rowCount']) && id(file.fileId) && !files.has(file.fileId) && ['csv','statement','manifest'].includes(file.kind) && HASH.test(file.sha256) && text(file.path, 500), 'Files need distinct ids, retained paths, kinds and SHA-256 hashes.');
      if (file.kind === 'csv') check(integer(file.rowCount) && file.rowCount > 0 && file.rowCount <= 999, 'CSV needs 1–999 data rows.');
      files.set(file.fileId, file);
    }
    check([...files.values()].some(f => f.kind === 'statement') && [...files.values()].some(f => f.kind === 'manifest'), 'Retain the simulated statement and row manifest.');
    const seenEvents = new Set();
    for (const row of value.rows) {
      const event = events.get(row.eventId), file = files.get(row.fileId);
      check(exact(row, ['rowId','eventId','eventRevision','fileId','rowNumber']) && id(row.rowId) && !rowIds.has(row.rowId) && event && row.eventRevision === event.revision && !seenEvents.has(row.eventId) && file?.kind === 'csv' && integer(row.rowNumber) && row.rowNumber > 0 && row.rowNumber <= file.rowCount, 'Row crosswalk must uniquely bind every CSV row to one exact event revision.');
      rowIds.add(row.rowId); seenEvents.add(row.eventId);
    }
    check(seenEvents.size === events.size, 'Every settlement event needs exactly one row crosswalk.');
    for (const file of files.values()) if (file.kind === 'csv') { const numbers = value.rows.filter(r => r.fileId === file.fileId).map(r => r.rowNumber); check(numbers.length === file.rowCount && new Set(numbers).size === numbers.length, 'CSV row count/crosswalk is incomplete.'); }
    check(amountSum([value.openingMinor, ...value.events.filter(e => e.expectedResolution !== 'exclude').map(e => value.balanceConvention === 'card-amount-owed' ? -e.amountMinor : e.amountMinor)]) === value.closingMinor, 'Statement balance does not tie to canonical native settlements.');
    check(value.blockers.every(v => text(v)), 'Blockers must state exact unresolved reasons.');
    return clone(value);
  }
  async function evidence(input, bound) {
    check(exact(input, ['strength','observedAt','note','artifact','automation']) && STRENGTHS.includes(input.strength) && text(input.note), 'Explicit evidence strength and observation note are required.');
    check(typeof input.observedAt === 'string' && Number.isFinite(Date.parse(input.observedAt)) && Date.parse(input.observedAt) <= new Date(now()).getTime(), 'Evidence needs a valid non-future observation time.');
    if (input.artifact) await artifact(input.artifact, bound);
    if (input.strength !== 'operator attested') { check(input.artifact, 'Observed evidence requires a retained artifact.'); }
    if (input.automation) {
      check(exact(input.automation, ['runId','step','screenshotPath','outcome']) && id(input.automation.runId) && text(input.automation.step, 200) && input.artifact?.path === input.automation.screenshotPath && ['started','succeeded','failed','interrupted','ambiguous'].includes(input.automation.outcome), 'Automation evidence requires run id, step, retained screenshot path and outcome.');
      check(input.strength === 'screen observed', 'Browser automation must retain screen-observed evidence.');
    }
    return { ...clone(input), actorId: bound.actorId, recordedAt: stamp() };
  }
  function native(ev) { check(['screen observed','native report retained'].includes(ev.strength), 'A native screen observation or retained native report is required.'); }
  function rowFor(row, rowId) { const spec = row.snapshot.rows.find(r => r.rowId === rowId); check(spec, 'Row does not belong to this package.', 404); return spec; }
  function imported(row, spec) { check(row.state.imports.some(run => run.fileId === spec.fileId && run.status === 'uploaded'), 'Confirm this exact file import before recording a row outcome.', 409); }
  async function change(user, packageId, command, work) {
    bounded(command);
    check(id(command.requestId) && integer(command.expectedVersion) && command.expectedVersion >= 0, 'Idempotent request id and current state version are required.');
    const bound = await bind(user, true), row = await load(bound, packageId), commandHash = hash(command);
    const prior = row.state.history.find(h => h.requestId === command.requestId);
    if (prior) { check(prior.commandHash === commandHash && prior.actorId === bound.actorId, 'Request id was already used for a different decision.', 409); return view(row); }
    check(row.stateVersion === command.expectedVersion, 'Banking evidence changed. Refresh before recording this decision.', 409, 'BANKING_CONFLICT');
    check(!row.state.reconciled && !row.state.supersededBy, 'Completed or superseded package evidence is immutable. Use a new revision.', 409);
    bound.accountId = row.accountId;
    const ev = await evidence(command.evidence, bound);
    await work(row, command, ev, bound);
    row.state.history.push({ requestId: command.requestId, commandHash, actorId: bound.actorId, action: command.action, decision: clone(command), evidence: ev });
    check(row.state.history.length <= 12000, 'Retained package evidence is full. Create a new revision.');
    check(Buffer.byteLength(JSON.stringify(row)) <= 12000000, 'Package evidence reached its safe storage limit. Retain a new revision.');
    await store().assertReady();
    check(await store().replace(bound.scope, packageId, row.stateVersion, row.state), 'Banking evidence changed concurrently. Refresh and retain the exact request.', 409, 'BANKING_CONFLICT');
    row.stateVersion++; return view(row);
  }
  async function register(user, input) {
    const bound = await bind(user, true), snapshot = validatePackage(input, bound);
    const accountRecord = await account(bound, snapshot.accountId, snapshot.accountCurrency);
    check(snapshot.balanceConvention === ((accountRecord.AccountType || accountRecord.type) === 'Credit Card' ? 'card-amount-owed' : 'bank-balance'), 'Statement convention disagrees with bank/card account type.');
    for (const file of snapshot.files) {
      const bytes = await artifact({ path: file.path, sha256: file.sha256 }, bound, snapshot.accountId);
      if (file.kind === 'csv') {
        check(bytes.length <= 340000, 'CSV exceeds conservative 340,000-byte limit.'); const records = csvRows(bytes);
        check(records.length === file.rowCount, 'Retained CSV data count disagrees with its manifest.');
        for (const spec of snapshot.rows.filter(r => r.fileId === file.fileId)) {
          const record = records[spec.rowNumber - 1], event = snapshot.events.find(e => e.eventId === spec.eventId);
          check(record?.length === 3 && /^-?\d+\.\d{2}$/.test(record[2]), 'CSV row requires three columns and an exact two-decimal native amount.');
          const negative = record[2].startsWith('-'), digits = record[2].replace(/[-.]/g, '');
          check(BigInt(digits) * (negative ? -1n : 1n) === BigInt(event.amountMinor), 'CSV amount disagrees with its canonical settlement event.');
          const date = event.actualPostingDate || event.expectedPostingDate;
          check(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0,10) === date && date.slice(0,7) === snapshot.period && record[0] === date.slice(8,10) + '/' + date.slice(5,7) + '/' + date.slice(0,4), 'CSV date disagrees with its posting date/account month.');
        }
      }
      if (file.kind === 'manifest') {
        let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('Retained manifest is not valid JSON.'); }
        check(sameScope(manifest.scope, bound.scope) && manifest.accountId === snapshot.accountId && manifest.accountCurrency === snapshot.accountCurrency && manifest.period === snapshot.period && canonical(manifest.rows) === canonical(snapshot.rows), 'Retained manifest differs from its company/account row crosswalk.');
      }
    }
    const contentHash = hash(snapshot), packageId = hash({ scope: bound.scope, accountId: snapshot.accountId, period: snapshot.period, revision: snapshot.revision });
    await store().assertReady();
    try { return await store().transaction(async session => {
      await store().fenceAccount(bound.scope, snapshot.accountId, snapshot.accountCurrency, session);
      const old = await store().get(bound.scope, packageId, session);
      if (old) { check(old.contentHash === contentHash, 'Package revision is immutable; create its next revision.', 409); return view(old); }
      const family = await store().list(bound.scope, { accountId: snapshot.accountId }, session, { all: true });
      const previous = family.filter(p => p.period === snapshot.period).sort((a,b) => b.revision - a.revision)[0];
      check(snapshot.revision === (previous?.revision || 0) + 1 && (snapshot.previousPackageId || null) === (previous?._id || null), 'New package must reference the latest consecutive revision.', 409);
      check(!previous || !previous.state.imports.some(run => ['started','interrupted'].includes(run.status)), 'Resolve interrupted import before revising this package.', 409);
      const priorPeriod = family.filter(p => p.period < snapshot.period && !p.state.supersededBy).sort((a,b) => b.period.localeCompare(a.period))[0];
      check(!priorPeriod || priorPeriod.snapshot.closingMinor === snapshot.openingMinor, 'Opening balance does not carry forward from prior statement.', 409);
      const followingPeriod = family.filter(p => p.period > snapshot.period && !p.state.supersededBy).sort((a,b) => a.period.localeCompare(b.period))[0];
      check(previous || !followingPeriod || followingPeriod.snapshot.openingMinor === snapshot.closingMinor, 'Closing balance does not carry forward into the following statement.', 409);
      const generatedAt = stamp();
      for (const event of snapshot.events) {
        const reservation = { scope: bound.scope, eventId: event.eventId, accountId: event.accountId, period: snapshot.period, creator: event.creator };
        await store().putEvent({ ...bound.scope, _id: hash({ scope: bound.scope, eventId: event.eventId, revision: 0 }), kind: 'reservation', eventId: event.eventId, revision: 0, accountId: event.accountId, accountCurrency: event.accountCurrency, sourceHash: hash(reservation), contentHash: hash(reservation), payload: reservation }, session);
        await store().putEvent({ ...bound.scope, _id: hash({ scope: bound.scope, eventId: event.eventId, revision: event.revision }), eventId: event.eventId, revision: event.revision, accountId: event.accountId, accountCurrency: event.accountCurrency, sourceHash: event.sourceHash, contentHash: hash(event), payload: event }, session);
      }
      const row = { ...bound.scope, _id: packageId, accountId: snapshot.accountId, accountCurrency: snapshot.accountCurrency, period: snapshot.period, revision: snapshot.revision, previousPackageId: snapshot.previousPackageId || null, contentHash, snapshot,
        stateVersion: 0, state: { generated: { at: generatedAt, actorId: bound.actorId, sourceSnapshotHash: snapshot.sourceSnapshotHash, policyVersion: snapshot.policyVersion, contentHash, strength: 'generated simulated evidence' }, imports: [], rows: Object.fromEntries(snapshot.rows.map(r => [r.rowId, {}])), history: [], reconciled: null, needsReview: family.some(p => p.period === snapshot.period && p.state.imports.some(r => r.status === 'uploaded')) ? { reason: 'Prior revision already imported; native delta/recovery review required', packageId: family.find(p => p.period === snapshot.period && p.state.imports.some(r => r.status === 'uploaded'))._id, at: generatedAt } : false, supersededBy: null } };
      await store().insert(row, session);
      for (const affected of family.filter(p => p._id === previous?._id || p.period > snapshot.period)) {
        const next = clone(affected.state); next.needsReview = { reason: 'Earlier package revised', packageId, at: generatedAt }; if (affected._id === previous?._id) next.supersededBy = packageId;
        check(await store().replace(bound.scope, affected._id, affected.stateVersion, next, session), 'Later package changed during revision. Retry registration.', 409);
      }
      return view(row);
    }); } catch (error) { if (error.code === 11000) fail('Package/event revision was registered concurrently. Refresh and compare hashes.', 409, 'BANKING_CONFLICT'); throw error; }
  }
  async function recordImport(user, packageId, command) {
    check(exact(command, ['requestId','expectedVersion','action','fileId','attemptId','fileHash','observedCount','nativeConfirmation','nativeRows','accountId','accountCurrency','evidence']), 'Unsupported import fields.');
    return change(user, packageId, command, (row, c, ev) => {
      check(['start','interrupt','uploaded','not-imported'].includes(c.action) && id(c.attemptId), 'Invalid import checkpoint action.');
      const file = row.snapshot.files.find(f => f.fileId === c.fileId && f.kind === 'csv');
      check(file && file.sha256 === c.fileHash && !row.snapshot.blockers.length && !row.state.needsReview, 'Import needs the exact unblocked file hash and current revision.', 409);
      check(c.accountId === row.accountId && c.accountCurrency === row.accountCurrency, 'Native import target account/currency changed.', 403);
      let attempt = row.state.imports.find(run => run.attemptId === c.attemptId);
      if (c.action === 'start') {
        check(!attempt && !row.state.imports.some(run => run.fileId === file.fileId && run.status !== 'not-imported'), 'File already uploaded or its outcome is uncertain. Inspect native state before retrying.', 409, 'BANKING_IMPORT_UNCERTAIN');
        check(!ev.automation || ev.automation.outcome === 'started', 'Import intent must be recorded before the browser upload step.');
        native(ev); attempt = { attemptId: c.attemptId, fileId: file.fileId, fileHash: file.sha256, accountId: row.accountId, accountCurrency: row.accountCurrency, startedAt: ev.recordedAt, actorId: ev.actorId, status: 'started', evidence: [ev] }; row.state.imports.push(attempt); return;
      }
      check(attempt && attempt.fileId === c.fileId && attempt.fileHash === c.fileHash && ['started','interrupted'].includes(attempt.status), 'Recover the exact unfinished import attempt.', 409);
      if (c.action === 'interrupt') { attempt.status = 'interrupted'; attempt.evidence.push(ev); return; }
      nativeSuccess(ev); check(text(c.nativeConfirmation), 'Retain the native import/recovery confirmation.');
      if (c.action === 'not-imported') { check(c.observedCount === 0, 'Retry is allowed only with observed zero imported rows.'); attempt.status = 'not-imported'; }
      else {
        check(c.observedCount === file.rowCount && Array.isArray(c.nativeRows) && c.nativeRows.length === file.rowCount, 'Observed import count must match every row in the exact file.');
        const specs = row.snapshot.rows.filter(r => r.fileId === file.fileId), nativeIds = new Set();
        for (const spec of specs) { const mapping = c.nativeRows.filter(r => r.rowId === spec.rowId); check(mapping.length === 1 && exact(mapping[0], ['rowId','nativeRowId']) && id(mapping[0].nativeRowId) && !nativeIds.has(mapping[0].nativeRowId), 'Native rows must map uniquely to the exact file crosswalk.'); nativeIds.add(mapping[0].nativeRowId); }
        attempt.status = 'uploaded'; attempt.nativeRows = clone(c.nativeRows);
      }
      attempt.observedCount = c.observedCount; attempt.nativeConfirmation = c.nativeConfirmation; attempt.completedAt = ev.recordedAt; attempt.evidence.push(ev);
    });
  }
  async function recordRow(user, packageId, command) {
    check(exact(command, ['requestId','expectedVersion','action','rowId','decision','reason','qboRefs','evidence']), 'Unsupported row evidence fields.');
    return change(user, packageId, command, async (row, c, ev, bound) => {
      check(['reviewed','matched','added','excluded'].includes(c.action), 'Invalid row evidence transition.');
      const spec = rowFor(row, c.rowId); imported(row, spec);
      const state = row.state.rows[c.rowId], event = row.snapshot.events.find(e => e.eventId === spec.eventId);
      check(!state.matched && !state.added && !state.excluded, 'A resolved row cannot receive another accounting outcome.', 409);
      if (c.action === 'reviewed') { check(['match','add','exclude','pending','investigate'].includes(c.decision) && text(c.reason), 'Review needs a decision or explicit pending exception and reason.'); check(c.decision !== 'add' || event.creator === 'native-add', 'An API-accountant event cannot be added natively.'); state.reviewed = { decision: c.decision, reason: c.reason, evidence: ev }; return; }
      const decision = { matched: 'match', added: 'add', excluded: 'exclude' }[c.action];
      check(state.reviewed?.decision === decision, 'Record the corresponding review decision first.', 409); nativeSuccess(ev);
      if (c.action === 'excluded') check(text(c.reason), 'Native exclusion requires a reason.');
      else {
        check(Array.isArray(c.qboRefs) && c.qboRefs.length > 0 && c.qboRefs.length <= 100 && c.qboRefs.every(ref => exact(ref, ['entity','id']) && ['Payment','SalesReceipt','Deposit','Purchase','BillPayment','Transfer','CreditCardPayment','RefundReceipt','JournalEntry','Invoice','TaxPayment'].includes(ref.entity) && /^\d+$/.test(ref.id)) && new Set(c.qboRefs.map(r => r.entity + ':' + r.id)).size === c.qboRefs.length, 'Retain every distinct resulting QBO reference, including multi-record matches.');
        if (c.action === 'added') {
          check(event.creator === 'native-add', 'Native Add conflicts with the designated API creator.', 409);
          const synced = [];
          for (const ref of c.qboRefs) {
            const observed = dependencies.findSyncedRecord ? await dependencies.findSyncedRecord(bound.scope, ref) : await require('../models/CompanySyncRecord').findOne({ ...bound.scope, entity: ref.entity, qboId: ref.id, deleted: false }).maxTimeMS(3000).lean();
            check(observed && sameScope(observed, bound.scope) && observed.entity === ref.entity && observed.qboId === ref.id && !observed.deleted && observed.record?.Id === ref.id && Number.isFinite(Date.parse(observed.lastObservedAt)), 'Native Add is not yet observed in this company sync.', 409, 'BANKING_ADD_UNOBSERVED');
            const accountRefs = [];
            const visit = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (/AccountRef$/.test(key) && child?.value) accountRefs.push(String(child.value)); else if (child && typeof child === 'object') visit(child); } }; visit(observed.record);
            check(accountRefs.includes(row.accountId) && (!observed.record.CurrencyRef?.value || observed.record.CurrencyRef.value === row.accountCurrency), 'Added record does not prove this bank account/currency movement.', 409, 'BANKING_ADD_UNOBSERVED');
            const importStarted = row.state.imports.find(run => run.fileId === spec.fileId && run.status === 'uploaded').startedAt;
            check(Date.parse(observed.record.MetaData?.CreateTime) >= Date.parse(importStarted) && Date.parse(observed.record.MetaData?.CreateTime) <= new Date(now()).getTime() && Date.parse(observed.lastObservedAt) >= Date.parse(importStarted), 'Native Add record predates its import or lacks a current sync observation.', 409, 'BANKING_ADD_UNOBSERVED');
            let verified;
            if (dependencies.verifyAddedRecord) verified = await dependencies.verifyAddedRecord({ scope: bound.scope, event: clone(event), records: [clone(observed.record)], reference: ref });
            else {
              // Conservative common native Add shapes. Ambiguous allocation stays pending
              // until the BF1 settlement verifier is explicitly injected by integration.
              const signs = { Deposit: 1, Payment: 1, SalesReceipt: 1, RefundReceipt: -1, Purchase: observed.record.Credit === true ? 1 : -1 };
              const total = String(observed.record.TotalAmt), pieces = /^(\d+)(?:\.(\d{1,2}))?$/.exec(total);
              const nativeMinor = pieces ? BigInt(pieces[1]) * 100n + BigInt((pieces[2] || '').padEnd(2, '0')) : null;
              const primaryAccount = ref.entity === 'Purchase' ? observed.record.AccountRef?.value : observed.record.DepositToAccountRef?.value;
              verified = String(primaryAccount) === row.accountId && c.qboRefs.length === 1 && Object.hasOwn(signs, ref.entity) && nativeMinor !== null && nativeMinor * BigInt(signs[ref.entity]) === BigInt(event.amountMinor) && observed.record.TxnDate === (event.actualPostingDate || event.expectedPostingDate) && observed.record.CurrencyRef?.value === row.accountCurrency;
            }
            check(verified === true, 'Synced record does not prove this bank-origin event amount/date/native currency. Inject the settlement verifier for ambiguous allocations.', 409, 'BANKING_ADD_UNOBSERVED');
            synced.push({ ...ref, strength: 'synced record observed', observedAt: observed.lastObservedAt, recordHash: hash(observed.record) });
          }
          state.synced = synced;
        }
      }
      state[c.action] = { evidence: ev, ...(c.reason ? { reason: c.reason } : {}), ...(c.qboRefs ? { qboRefs: clone(c.qboRefs) } : {}) };
    });
  }
  async function recordReconciliation(user, packageId, command) {
    check(exact(command, ['requestId','expectedVersion','action','report','completion','statementAttachment','openingMinor','closingMinor','differenceMinor','outstandingItems','accountId','accountCurrency','period','evidence']), 'Unsupported reconciliation fields.');
    return change(user, packageId, command, async (row, c, ev, bound) => {
      check(c.action === 'reconciled' && !row.snapshot.blockers.length && !row.state.needsReview, 'Resolve package blockers and revised history before reconciliation.', 409);
      check(Object.values(row.state.rows).every(r => r.matched || r.added || r.excluded) && row.state.imports.every(r => !['started','interrupted'].includes(r.status)), 'Resolve every imported row and uncertain import before reconciliation.', 409);
      check(c.openingMinor === row.snapshot.openingMinor && c.closingMinor === row.snapshot.closingMinor && c.differenceMinor === 0 && canonical(c.outstandingItems) === canonical(row.snapshot.outstandingItems), 'Native completion needs exact statement balances, zero difference and retained outstanding items.');
      check(c.accountId === row.accountId && c.accountCurrency === row.accountCurrency && c.period === row.period, 'Native reconciliation account/currency/period changed.', 403);
      const report = await evidence(c.report, bound), completion = await evidence(c.completion, bound), attachment = await evidence(c.statementAttachment, bound);
      check(report.strength === 'native report retained' && completion.strength === 'screen observed' && attachment.strength === 'screen observed', 'Retain the completed native report, zero-difference completion screen and statement-attachment screen.');
      check(new Set([report.artifact.sha256, completion.artifact.sha256, attachment.artifact.sha256]).size === 3 && !row.snapshot.files.some(f => f.sha256 === report.artifact.sha256), 'Native report and completion evidence must be distinct from the simulated statement and each other.');
      nativeSuccess(completion); nativeSuccess(attachment); nativeSuccess(ev); row.state.reconciled = { report, completion, statementAttachment: attachment, openingMinor: c.openingMinor, closingMinor: c.closingMinor, differenceMinor: 0, outstandingItems: clone(c.outstandingItems), evidence: ev };
    });
  }
  // Read-only bank-style projection of immutable retained statement packages.
  // It does not treat the synced QBO balance as an independently observed bank balance.
  const bankName = 'Maple Harbour Bank';
  const evidenceLabel = 'Historical reconstruction baseline — not independent bank confirmation.';
  const pendingActivity = () => ({ availability: 'not-observed', count: null, note: 'Independent pending bank activity is not observed. Retained statement timing items are shown separately.' });
  function periodEnd(period) { const date = new Date(period + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0); return date.toISOString().slice(0, 10); }
  async function retainedManifest(bound, row) {
    const file = row.snapshot.files.find(f => f.kind === 'manifest');
    check(file, 'Opening evidence manifest is unavailable.', 409, 'BANKING_EVIDENCE_UNAVAILABLE');
    let manifest;
    try { manifest = JSON.parse((await artifact({ path: file.path, sha256: file.sha256 }, bound, row.accountId)).toString('utf8')); }
    catch (error) { if (error.code?.startsWith('BANKING_')) throw error; fail('Retained opening evidence could not be read.', 409, 'BANKING_EVIDENCE_UNAVAILABLE'); }
    check(sameScope(manifest.scope, bound.scope) && manifest.accountId === row.accountId && manifest.accountCurrency === row.accountCurrency && manifest.period === row.period && canonical(manifest.rows) === canonical(row.snapshot.rows), 'Retained account manifest no longer agrees with its package.', 409, 'BANKING_ARTIFACT_CHANGED');
    check(manifest.openingMinor === row.snapshot.openingMinor && manifest.closingMinor === row.snapshot.closingMinor, 'Retained statement balance evidence is unavailable or inconsistent.', 409, 'BANKING_EVIDENCE_UNAVAILABLE');
    return manifest;
  }
  function openingProof(manifest) {
    const opening = manifest.openingEvidence;
    return { available: Boolean(opening?.evidenceRef && opening?.basis), basis: opening?.period && opening.period !== manifest.period ? 'Carried forward to ' + manifest.period + ' from the retained ' + opening.period + ' reconstruction baseline. ' + (manifest.openingBasis || opening.basis) : manifest.openingBasis || opening?.basis || 'Opening evidence unavailable.', evidenceRef: opening?.evidenceRef || null, evidenceHash: opening?.evidenceHash || null,
      openingPeriod: opening?.period || null, amountMinor: opening?.amountMinor ?? null, statementOpeningMinor: manifest.openingMinor,
      crossCheck: opening?.crossCheck ? clone(opening.crossCheck) : null };
  }
  function currentPeriods(rows) {
    const periods = new Map();
    for (const row of rows) {
      if (row.state.supersededBy) continue;
      const prior = periods.get(row.period);
      if (!prior || row.revision > prior.revision) periods.set(row.period, row);
    }
    return [...periods.values()].sort((a, b) => b.period.localeCompare(a.period));
  }
  async function accountSummary(bound, rows, selected = rows[0]) {
    const record = await account(bound, selected.accountId, selected.accountCurrency);
    let manifest = null; const unavailableEvidence = [];
    try { manifest = await retainedManifest(bound, selected); }
    catch (error) { if (!error.code?.startsWith('BANKING_')) throw error; unavailableEvidence.push(error.message); }
    const openingEvidence = manifest ? openingProof(manifest) : { available: false, basis: 'Opening evidence unavailable.', evidenceRef: null, evidenceHash: null };
    if (!openingEvidence.available && !unavailableEvidence.length) unavailableEvidence.push('The retained opening balance has no evidence reference.');
    return { accountId: selected.accountId, accountName: record.Name || record.name || manifest?.accountName || selected.accountId,
      accountType: record.AccountType || record.type, accountCurrency: selected.accountCurrency,
      balanceConvention: selected.snapshot.balanceConvention, balanceMinor: selected.snapshot.closingMinor, balanceAsOf: periodEnd(selected.period),
      period: selected.period, packageId: selected._id, revision: selected.revision, openingMinor: selected.snapshot.openingMinor,
      postedCount: selected.snapshot.events.filter(e => e.expectedResolution !== 'exclude').length,
      availablePeriods: rows.map(row => ({ period: row.period, packageId: row._id, revision: row.revision })),
      openingEvidence, pendingActivity: pendingActivity(), unavailableEvidence };
  }
  async function accounts(user) {
    const bound = await bind(user), rows = await store().list(bound.scope);
    check(rows.every(row => sameScope(row, bound.scope)), 'Stored banking scope mismatch.', 409);
    const groups = new Map();
    for (const row of rows) { if (!groups.has(row.accountId)) groups.set(row.accountId, []); groups.get(row.accountId).push(row); }
    const summaries = [];
    for (const family of groups.values()) { const periods = currentPeriods(family); if (periods.length) summaries.push(await accountSummary(bound, periods)); }
    return { bankName, evidenceLabel, accounts: summaries, truncated: rows.length === 2000, qboCalls: 0 };
  }
  async function accountDetail(user, accountId, filters = {}) {
    check(id(accountId) && exact(filters, ['period']) && (!filters.period || /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.period)), 'Exact account and optional statement month required.');
    const bound = await bind(user), family = await store().list(bound.scope, { accountId });
    check(family.every(row => sameScope(row, bound.scope) && row.accountId === accountId), 'Stored banking account scope mismatch.', 409);
    const periods = currentPeriods(family), row = filters.period ? periods.find(value => value.period === filters.period) : periods[0];
    check(row, 'No retained statement is available for this account/month.', 404, 'BANKING_NOT_FOUND');
    const summary = await accountSummary(bound, periods, row), snapshot = row.snapshot;
    let balance = snapshot.openingMinor;
    const transactions = snapshot.rows.map(spec => {
      const event = snapshot.events.find(value => value.eventId === spec.eventId && value.revision === spec.eventRevision);
      check(event && Number.isSafeInteger(event.amountMinor), 'Retained transaction lineage is unavailable.', 409, 'BANKING_EVIDENCE_UNAVAILABLE');
      const balanceMovementMinor = event.expectedResolution === 'exclude' ? 0 : snapshot.balanceConvention === 'card-amount-owed' ? -event.amountMinor : event.amountMinor;
      balance = amountSum([balance, balanceMovementMinor]);
      return { eventId: event.eventId, eventRevision: event.revision, rowId: spec.rowId, fileId: spec.fileId, rowNumber: spec.rowNumber,
        postingDate: event.actualPostingDate || event.expectedPostingDate, postingBasis: event.postingBasis || (event.actualPostingDate ? 'retained-posting-evidence' : 'simulated-policy'),
        status: event.expectedResolution === 'exclude' ? 'excluded' : 'posted', description: event.description || event.kind || [event.source?.entity, event.source?.id].filter(Boolean).join(' '),
        amountMinor: event.amountMinor, balanceMovementMinor, runningBalanceMinor: balance,
        source: { entity: event.source?.entity || null, id: event.source?.id || null, sourceHash: event.sourceHash || event.source?.sourceHash || null },
        qboRefs: clone(event.resolution?.linkedQboIds || []) };
    });
    check(balance === snapshot.closingMinor, 'Retained transaction movements do not equal the statement closing balance.', 409, 'BANKING_EVIDENCE_UNAVAILABLE');
    const retained = view(row);
    return { bankName, evidenceLabel, ...summary, transactions, outstandingItems: clone(snapshot.outstandingItems),
      package: { id: retained.id, contentHash: retained.contentHash, stateVersion: retained.stateVersion, summary: retained.summary, files: clone(snapshot.files), blockers: clone(snapshot.blockers) }, qboCalls: 0 };
  }
  async function list(user, filters = {}) {
    check(exact(filters, ['accountId','period']) && (!filters.accountId || id(filters.accountId)) && (!filters.period || /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.period)), 'Unsupported banking filter.');
    const bound = await bind(user), rows = await store().list(bound.scope, filters);
    check(rows.every(row => sameScope(row, bound.scope)), 'Stored banking scope mismatch.', 409);
    return { packages: rows.map(row => { const { snapshot, evidence, ...summary } = view(row); return { ...summary, files: snapshot.files, blockers: snapshot.blockers, openingMinor: snapshot.openingMinor, closingMinor: snapshot.closingMinor, balanceConvention: snapshot.balanceConvention }; }), evidenceStrengths: STRENGTHS, qboCalls: 0, truncated: rows.length === 2000 };
  }
  async function detail(user, packageId) { return view(await load(await bind(user), packageId)); }
  async function download(user, packageId, fileId) { const row = await load(await bind(user), packageId), file = row.snapshot.files.find(f => f.fileId === fileId); check(file, 'Package file not found.', 404); return { fileId: file.fileId, kind: file.kind, sha256: file.sha256, bytes: await artifact({ path: file.path, sha256: file.sha256 }, { ...await bind(user), accountId: row.accountId }) }; }
  return { list, detail, accounts, accountDetail, register, recordImport, recordRow, recordReconciliation, download };
}
module.exports = { createBankingWorkspaceService, createMongoBankingStore, createArtifactReader, hash, STRENGTHS };
