'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { description: bankTransactionDescription } = require('./bank-feed-csv');
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
async function completeOriginContext(Events,scope,session){
 const rows=[];let after=null;
 for(;;){
  let q=Events.find({...scope,...(after===null?{}:{_id:{$gt:after}})},null,{singleBatch:true,batchSize:501,collation:{locale:'simple'}}).sort({_id:1}).limit(500).maxTimeMS(10000);
  if(session)q=q.session(session);
  const page=await q.lean();
  check(Array.isArray(page)&&page.length<=500,'Complete banking event enumeration unavailable.',409);
  if(!page.length)return rows;
  for(const row of page){
   check(typeof row?._id==='string'&&row._id.length>0&&(after===null||Buffer.compare(Buffer.from(row._id),Buffer.from(after))>0)&&sameScope(row,scope)&&rows.length<100000,'Complete banking event enumeration unavailable.',409);
   after=row._id;rows.push(row);
  }
 }
}
function createMongoBankingStore({ Events, Packages, connection, returnModels=null }) {
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
    async authenticateReturnSource(bound,eventId,session){const selected=typeof returnModels==='function'?returnModels():returnModels||(Events===require('../models/BankingEvent')?require('./business-runtime').loadModels():null);check(selected?.GeneralWriteRuns&&selected.Receipts,'Return proof stores are unavailable.',409,'BANKING_RETURN_HELD');return require('./bank-origin-service').readPostedReturnSource({models:selected,store:this,bound,eventId,session});},
    getLedger: (scope, accountId, session) => query(Events, { ...scope, kind: 'ledger-account', eventId: '@ledger:' + accountId, revision: 0 }, session),
    async findOriginByDecision(scope,decisionKey,session) {let q=Events.find({...scope,kind:'revision',eventId:{$regex:'^@origin:'},'payload.bookkeeping.decisionKey':decisionKey}).sort({revision:1}).limit(10001).maxTimeMS(5000);if(session)q=q.session(session);const rows=await q.lean();check(rows.length<=10000,'Complete origin decision history unavailable.',409);return rows;},
    listBankOriginContext: (scope,session) => completeOriginContext(Events,scope,session),
    async loadFeedPeers(scope,eventIds,session){const names=eventIds.map(id=>'@instruction:'+id);let a=Events.find({...scope,kind:'instruction',eventId:{$in:names},revision:0}).limit(10001).maxTimeMS(5000),b=Events.find({...scope,kind:'revision',eventId:{$in:names}}).limit(20001).maxTimeMS(5000);if(session){a=a.session(session);b=b.session(session);}return{rows:await a.lean(),revisions:await b.lean()};},
    async listMonthlyRows(scope,accountId,session){let q=Events.find({...scope,accountId,kind:'revision',eventId:{$regex:'^@monthly-statement(?:-|:)'}}).sort({eventId:1,revision:1}).limit(10001).maxTimeMS(5000);if(session)q=q.session(session);const rows=await q.lean();check(rows.length<=10000,'Complete monthly statement history exceeds its bound.',409,'BANKING_STATEMENT_HELD');return rows;},
    async listFeedRows(scope,accountId,session){let query=Events.find({...scope,accountId,kind:'revision',eventId:{$regex:'^@feed(?:-|:)'}}).sort({eventId:1,revision:1}).limit(50001).maxTimeMS(5000);if(session)query=query.session(session);return query.lean();},
    async listOriginRows(scope,accountId,session) { let q=Events.find({...scope,accountId,kind:'revision',eventId:{$regex:'^@origin(?:-|:)'}}).sort({eventId:1,revision:1}).limit(10001).maxTimeMS(5000);if(session)q=q.session(session);return q.lean(); },
    getCanonicalOriginConflict: (scope,eventId,session) => query(Events,{...scope,eventId,kind:'revision'},session),
    getReservation: (scope,eventId,session) => query(Events,{...scope,kind:'reservation',eventId,revision:0},session),
    getInstruction: (scope,eventId,session) => query(Events,{...scope,kind:'instruction',eventId:'@instruction:'+eventId,revision:0},session),
    getInstructionByLogical: (scope,accountId,logicalKey,session) => query(Events,{...scope,kind:'instruction',accountId,'payload.logicalKey':logicalKey,revision:0},session),
    async listInstructions(scope,accountId) {
      const filter={...scope,kind:'instruction',accountId,'payload.state':'pending',revision:0};
      const [rows,count]=await Promise.all([Events.find(filter).sort({'payload.receivedAt':-1,_id:1}).limit(200).maxTimeMS(5000).lean(),Events.countDocuments(filter).maxTimeMS(5000)]);return {rows,count};
    },
    async getSettlementRevisions(scope,eventId,session) {
      let q=Events.find({...scope,kind:'revision',eventId:'@instruction:'+eventId}).sort({revision:1}).limit(4).maxTimeMS(5000);if(session)q=q.session(session);return q.lean();
    },
    async listSettlementInstructions(scope,cutoff,session,accountId) {
      // Skip already-posted and not-yet-due scheduled instructions. Unscheduled
      // instructions get a durable policy first, so they cannot starve later work.
      const dbScope={...scope,connectionId:Events.schema.path('connectionId').cast(scope.connectionId)};
      let q=Events.aggregate([
        {$match:{...dbScope,...(accountId?{accountId}:{}),kind:'instruction',revision:0}},
        {$lookup:{from:Events.collection.name,let:{identity:'$eventId'},pipeline:[{$match:{...dbScope,kind:'revision',$expr:{$eq:['$eventId','$$identity']}}},{$sort:{revision:1}}],as:'lifecycle'}},
        {$match:{$or:[{lifecycle:{$size:0}},{$and:[{lifecycle:{$size:1}},{$or:[{'lifecycle.0.payload.schedule.expectedPostingDate':{$lte:cutoff}},{'lifecycle.0.payload.schedule.expectedPostingDate':{$exists:false}},{'lifecycle.0.revision':{$ne:1}},{'lifecycle.0.payload.kind':{$ne:'governed-bank-settlement'}}]}]},{$and:[{lifecycle:{$size:2}},{'lifecycle.1.payload.state':{$ne:'posted'}}]},{'lifecycle.2':{$exists:true}}]}},
        {$sort:{'payload.receivedAt':1,_id:1}},{$limit:100},{$project:{lifecycle:0}}
      ]).option({maxTimeMS:5000});if(session)q=q.session(session);return q;
    },
    async listInstructionActivity(scope,accountId,session) {
      const filter={...scope,kind:'instruction',accountId,revision:0};
      let rowQuery=Events.find(filter).sort({_id:1}).limit(10001).maxTimeMS(5000);if(session)rowQuery=rowQuery.session(session);const rows=await rowQuery.lean();
      check(rows.length<=10000,'Independent bank activity exceeds the complete projection limit; a full current balance is unavailable.',409,'BANKING_ACTIVITY_INCOMPLETE');
      let revisionQuery=Events.find({...scope,kind:'revision',accountId,eventId:{$regex:'^@instruction:'}}).sort({eventId:1,revision:1}).limit(20001).maxTimeMS(5000);if(session)revisionQuery=revisionQuery.session(session);const revisions=await revisionQuery.lean();
      check(revisions.length<=20000,'Independent settlement history exceeds the complete projection limit; a full current balance is unavailable.',409,'BANKING_ACTIVITY_INCOMPLETE');
      return {rows,revisions};
    },
    get: (scope, packageId, session) => query(Packages, { ...scope, _id: packageId }, session),
    getPackages: (scope, packageIds) => Packages.find({ ...scope, _id: { $in: packageIds } }).maxTimeMS(5000).lean(),
    ledgerAccountIds: scope => Events.distinct('accountId', { ...scope, kind: 'ledger-account', revision: 0 }).maxTimeMS(5000),
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

async function loadBankFeedActivity({
  store,
  bound,
  accountId,
  session
}) {
  const scope = scoped(bound.scope),
    row = await store.getLedger(scope, accountId, session);
  check(row && sameScope(row, scope) && row.accountId === accountId, 'Adopted current-feed ledger unavailable.', 409, 'BANKING_FEED_UNAVAILABLE');
  const ledger = require('./independent-bank-ledger').verifyLedger(clone(row.payload));
  check(sameScope(ledger.scope, scope) && ledger.contentHash === row.contentHash && ledger.account.accountId === accountId, 'Current-feed baseline identity changed.', 409, 'BANKING_FEED_INVALID');
  check(store.listInstructionActivity && store.listOriginRows, 'Complete current-feed source stores are required.', 409, 'BANKING_FEED_UNAVAILABLE');
  const source = await store.listInstructionActivity(scope, accountId, session),
    businessActivity = require('./bank-instruction-settlement').projectInstructionActivity({
      scope,
      ledger,
      instructions: source.rows,
      revisions: source.revisions
    }),
    origins = await store.listOriginRows(scope, accountId, session),
    returnContext=origins.some(r=>r.payload?.kind==='independent-bank-return-v1')?await store.listBankOriginContext(scope,session):null,
    activity = require('./bank-origin-service').projectOriginActivity({
      scope,
      ledger,
      rows: origins,
      businessActivity,returnContext
    });
  const paired = activity.events.filter(e => e.state === 'posted' && e.pairedEventId),
    pairedProofs = {};
  if (paired.length) {
    check(store.loadFeedPeers, 'Complete paired feed source unavailable.', 409, 'BANKING_FEED_INCOMPLETE');
    const peer = await store.loadFeedPeers(scope, [...new Set(paired.filter(e=>!e.source?.returnId).map(e => e.pairedEventId))], session);
    check(peer.rows.length <= 10000 && peer.revisions.length <= 20000, 'Paired feed history exceeds its complete bound.', 409, 'BANKING_FEED_INCOMPLETE');
    const verifier = require('./bank-instruction-settlement');
    for (const event of paired) {
      if(event.source?.returnId){check(returnContext&&store.authenticateReturnSource,'Return pair proof is unavailable.',409,'BANKING_FEED_PAIR_HELD');const g=require('./bank-origin-service').returnGroup(returnContext,scope,event.source.returnId),original=await store.authenticateReturnSource(bound,g.source.members[0].eventId,session),own=g.legs.find(l=>l.event.eventId===event.eventId),other=g.legs.find(l=>l.event.eventId===event.pairedEventId);check(canonical(original.source)===canonical(g.source)&&own&&other&&other.event.pairedEventId===event.eventId&&other.event.accountId!==event.accountId&&other.event.accountCurrency===event.accountCurrency&&other.event.amountMinor===-event.amountMinor&&other.event.settlementGroupId===event.settlementGroupId&&own.posted.contentHash===event.originHash,'Original and return reciprocal posted groups are unproved.',409,'BANKING_FEED_PAIR_HELD');pairedProofs[event.eventId]=hash({originalSourceHash:g.source.sourceHash,originalMembers:g.source.members.map(m=>({eventId:m.eventId,postedHash:m.postedHash})),returnClaim:g.head.revision===3?returnContext.find(r=>r.eventId===g.claim.eventId&&r.revision===2).contentHash:g.head.contentHash,own:own.posted.contentHash,peer:other.posted.contentHash});continue;}

      const rows = peer.rows.filter(r => r.payload?.eventId === event.pairedEventId);
      check(rows.length === 1, 'Paired bank instruction is missing.', 409, 'BANKING_FEED_PAIR_HELD');
      const p = verifier.validateInstruction(rows[0], scope),
        latest = verifier.validateRevisions(rows[0], peer.revisions.filter(r => r.eventId === rows[0].eventId), scope);
      check(latest?.payload.state === 'posted' && p.accountId !== accountId && p.accountCurrency === event.accountCurrency && p.pairedEventId === event.eventId && p.settlementGroupId && p.settlementGroupId === event.settlementGroupId && p.amountMinor === -event.amountMinor && p.source.runId === event.source.runId && p.source.ref === event.source.ref, 'Reciprocal same-currency posted pair is unproved.', 409, 'BANKING_FEED_PAIR_HELD');
      pairedProofs[event.eventId] = hash({
        instruction: rows[0].contentHash,
        posted: latest.contentHash
      });
    }
  }
  return {
    ledger,
    activity,
    pairedProofs
  };
}
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
  async function authorizeBound(bound, action, session) {
    if (dependencies.authorize) return dependencies.authorize({ ...bound, action, session });
    return require('./business-runtime-access').createBusinessRuntimeAccess({actorId:bound.actorId,ownerId:bound.ownerId}).authorize(bound.scope,action,{session});
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
    const ledger = await readLedger(bound, row.accountId);
    if (ledger) check(ledger.account.accountCurrency === row.accountCurrency, 'Retained package currency differs from independent account.', 409);
    else await account(bound, row.accountId, row.accountCurrency);
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
      Object.assign(event, require('./bank-event-evidence').normalizeEventAliases(event, check));
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
    await account(bound,row.accountId,row.accountCurrency);
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
        const existing = await store().getReservation?.(bound.scope,event.eventId,session);
        if (existing) check(sameScope(existing,bound.scope) && existing.contentHash === hash(existing.payload) && existing.accountId === event.accountId && existing.accountCurrency === event.accountCurrency && existing.payload.creator === event.creator && (existing.payload.period === undefined || existing.payload.period === snapshot.period), 'Event creator/account reservation conflicts with this package.',409);
        else await store().putEvent({ ...bound.scope, _id: hash({ scope: bound.scope, eventId: event.eventId, revision: 0 }), kind: 'reservation', eventId: event.eventId, revision: 0, accountId: event.accountId, accountCurrency: event.accountCurrency, sourceHash: hash(reservation), contentHash: hash(reservation), payload: reservation }, session);
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
    // An account's first reconciliation starts from QuickBooks' beginning balance 0.
    const family = await list(user, { accountId: command.accountId }); check(!family.truncated, 'Complete account history required.', 409);
    const firstReconciliation = !family.packages.some(p => p.id !== packageId && p.summary.reconciled);
    return change(user, packageId, command, async (row, c, ev, bound) => {
      check(c.action === 'reconciled' && !row.snapshot.blockers.length && !row.state.needsReview, 'Resolve package blockers and revised history before reconciliation.', 409);
      // Rows need review only when this month's own CSV was imported; normally lines
      // arrive through the daily feed files and the month is reconciled from the register.
      const imported = row.state.imports.some(r => r.status === 'uploaded');
      check((!imported || Object.values(row.state.rows).every(r => r.matched || r.added || r.excluded)) && row.state.imports.every(r => !['started','interrupted'].includes(r.status)), 'Resolve every imported row and uncertain import before reconciliation.', 409);
      check((c.openingMinor === row.snapshot.openingMinor || firstReconciliation && c.openingMinor === 0) && c.closingMinor === row.snapshot.closingMinor && c.differenceMinor === 0 && canonical(c.outstandingItems) === canonical(row.snapshot.outstandingItems), 'Native completion needs exact statement balances, zero difference and retained outstanding items.');
      check(c.accountId === row.accountId && c.accountCurrency === row.accountCurrency && c.period === row.period, 'Native reconciliation account/currency/period changed.', 403);
      const report = await evidence(c.report, bound), completion = await evidence(c.completion, bound), attachment = await evidence(c.statementAttachment, bound);
      check(report.strength === 'native report retained' && completion.strength === 'screen observed' && attachment.strength === 'screen observed', 'Retain the completed native report, zero-difference completion screen and statement-attachment screen.');
      check(new Set([report.artifact.sha256, completion.artifact.sha256, attachment.artifact.sha256]).size === 3 && !row.snapshot.files.some(f => f.sha256 === report.artifact.sha256), 'Native report and completion evidence must be distinct from the simulated statement and each other.');
      nativeSuccess(completion); nativeSuccess(attachment); nativeSuccess(ev); row.state.reconciled = { report, completion, statementAttachment: attachment, openingMinor: c.openingMinor, closingMinor: c.closingMinor, differenceMinor: 0, outstandingItems: clone(c.outstandingItems), evidence: ev };
    });
  }
  // Read-only bank-style projection of immutable retained statement packages.
  // It does not treat the synced QBO balance as an independently observed bank balance.
  async function readLedger(bound, accountId) {
    const row = await store().getLedger?.(bound.scope, accountId);
    if (!row) return null;
    check(sameScope(row, bound.scope) && row.accountId === accountId && sameScope(row.payload.scope, bound.scope), 'Independent bank scope mismatch.', 409);
    const ledger = require('./independent-bank-ledger').verifyLedger(clone(row.payload));
    check(ledger.account.accountId === accountId && row.contentHash === ledger.contentHash, 'Independent account identity changed.', 409);
    return ledger;
  }
  async function prepareLedgerBaseline(user, accountId, throughPeriod) {
    const bound = await bind(user);
    check(id(accountId) && /^\d{4}-(0[1-9]|1[0-2])$/.test(throughPeriod || ''), 'Exact baseline account and cutoff month required.');
    const family = await store().list(bound.scope, { accountId }, null, { all:true });
    const rows = currentPeriods(family).filter(row => row.period <= throughPeriod).reverse();
    check(rows.length && rows.at(-1).period === throughPeriod, 'No retained baseline at this cutoff.', 404, 'BANKING_NOT_FOUND');
    for (const row of rows) {
      check(sameScope(row,bound.scope) && row.accountId === accountId && hash(row.snapshot) === row.contentHash, 'Retained package content changed.', 409);
      for (const file of row.snapshot.files) await artifact({path:file.path, sha256:file.sha256}, bound, accountId);
    }
    const manifests = [];
    for (const row of rows) manifests.push(await retainedManifest(bound,row));
    const record = await account(bound, accountId, rows[0].accountCurrency);
    const ledger = require('./independent-bank-ledger').buildLedgerBaseline({scope:bound.scope,account:record,packages:rows,manifests});
    return {ledger,manifests:new Map(rows.map((row,i)=>[row._id,manifests[i]]))};
  }
  async function ledgerBaseline(user, accountId, throughPeriod) {
    return (await prepareLedgerBaseline(user,accountId,throughPeriod)).ledger;
  }
  async function adoptLedger(user, accountId, command) {
    check(exact(command,['throughPeriod','baselineHash','packageIds']) && HASH.test(command.baselineHash || '') && Array.isArray(command.packageIds) && command.packageIds.every(id), 'Adoption needs the exact reviewed baseline hash and package IDs.');
    const bound = await bind(user,true), old = await readLedger(bound,accountId);
    if (old) { check(old.contentHash === command.baselineHash && canonical(old.packages.map(p=>p.id)) === canonical(command.packageIds) && old.throughPeriod === command.throughPeriod, 'Independent bank baseline is already frozen; QBO refresh cannot replace it.', 409, 'BANKING_LEDGER_FROZEN'); return old; }
    const {ledger,manifests} = await prepareLedgerBaseline(user,accountId,command.throughPeriod);
    check(sameScope(ledger.scope,bound.scope), 'Company changed during baseline preparation.',409,'BANKING_SCOPE_BOUNDARY');
    check(ledger.contentHash === command.baselineHash && canonical(ledger.packages.map(p=>p.id)) === canonical(command.packageIds), 'Baseline changed since review. Read the exact preview again.', 409, 'BANKING_CONFLICT');
    await store().assertReady();
    try { return await store().transaction(async session => {
      await authorizeBound(bound,'periods.manage',session);
      await account(bound,accountId,ledger.account.accountCurrency);
      await store().fenceAccount(bound.scope,accountId,ledger.account.accountCurrency,session);
      const existing = await store().getLedger(bound.scope,accountId,session);
      if (existing) { check(existing.contentHash === ledger.contentHash, 'Independent bank baseline was adopted concurrently.',409,'BANKING_CONFLICT'); return require('./independent-bank-ledger').verifyLedger(clone(existing.payload)); }
      const current = currentPeriods(await store().list(bound.scope,{accountId},session,{all:true})).filter(p=>p.period <= command.throughPeriod).reverse();
      check(canonical(current.map(p=>[p._id,p.contentHash,p.stateVersion])) === canonical(ledger.packages.map(p=>[p.id,p.contentHash,p.stateVersion])), 'Baseline package evidence changed concurrently.',409,'BANKING_CONFLICT');
      check(current.every(p=>!p.state.needsReview && hash(p.snapshot) === p.contentHash), 'Baseline requires review before adoption.',409,'BANKING_CONFLICT');
      // Recheck admission against current immutable snapshots before the insert.
      // The manifest financial proof was hash-verified during baseline preparation.
      for (const row of current) {
        require('./independent-bank-ledger').validateFinancialEvidence(row.snapshot,manifests.get(row._id));
      }
      ledger.adoption = {actorId:bound.actorId,ownerId:bound.ownerId,at:stamp(),action:'explicit-bank-baseline-adoption'};
      await store().putEvent({...bound.scope,_id:hash({scope:bound.scope,kind:'ledger-account',accountId}),kind:'ledger-account',eventId:'@ledger:'+accountId,revision:0,accountId,accountCurrency:ledger.account.accountCurrency,sourceHash:ledger.contentHash,contentHash:ledger.contentHash,payload:ledger},session);
      return ledger;
    }); } catch(error) { if(error.code === 11000) fail('Independent baseline was adopted concurrently. Refresh and compare.',409,'BANKING_CONFLICT'); throw error; }
  }
  const instructionProcessing=bound=>require('./bank-instruction-loop').readBankInstructionLoopStatus(bound.scope,bound.ownerId);
  const bankName = 'Maple Harbour Bank';
  const evidenceLabel = 'Historical reconstruction baseline — not independent bank confirmation.';
  function publicInstructionSource(source) {
    return Object.fromEntries(['entity','id','runId','ref','batchIndex','requestId','bId','requestHash','itemRequestHash','responseHash','recordHash','receiptId','originalActorId','signature','adviceReference','sourceHash'].filter(key=>source?.[key]!==undefined && ['string','number'].includes(typeof source[key])).map(key=>[key,source[key]]));
  }
  let statementRuntime;
  const statements=()=>dependencies.statementService||(statementRuntime||=require('./bank-monthly-statement-service').createDefaultBankMonthlyStatementService({store:store(),models:dependencies.statementModels||(dependencies.store?{}:{...require('./business-runtime').loadModels(),Agents:require('../models/BusinessAgent')}),artifacts:dependencies.statementArtifacts||(!dependencies.store||dependencies.feedDirectory?require('./bank-feed-service').createBankFeedArtifactStore(dependencies.feedDirectory):undefined),directory:dependencies.feedDirectory,now:()=>Number(new Date(now())),authorize:(bound,session,action)=>authorizeBound(bound,action,session)}));
  async function monthlyStatements(user,accountId,input={}){const bound=await bind(user);return statements().list(bound,accountId,input);}
  async function issueMonthlyStatements(user,input,context={}){const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return statements().issue(bound,input);}
  async function downloadMonthlyStatement(user,accountId,statementId,fileId){const bound=await bind(user),value=await statements().download(bound,accountId,statementId,fileId);return{...value.file,period:value.period,bytes:value.bytes};}
  let feedRuntime;
  const feeds=()=>dependencies.feedService||(feedRuntime||=require('./bank-feed-service').createDefaultBankFeedService({store:store(),directory:dependencies.feedDirectory,now:()=>Number(new Date(now())),authorize:(bound,session,action)=>authorizeBound(bound,action,session)}));
  async function currentFeeds(user,accountId,input={}){return feeds().list(await bind(user),accountId,input);}
  async function publishCurrentFeed(user,input,context={}){const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return Object.hasOwn(input||{},'publicationId')?feeds().recoverPublication(bound,input):feeds().publishDue(bound,input);}
  async function publishCumulativeFeed(user,input,context={}){const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return feeds().publishCumulative(bound,input);}
  async function downloadCurrentFeed(user,accountId,publicationId,fileId){return feeds().download(await bind(user),accountId,publicationId,fileId);}
  let originRuntime;
  const origins=()=>dependencies.originService||(originRuntime||=require('./bank-origin-service').createDefaultBankOriginService({store:store(),now:()=>Number(new Date(now())),authorize:(bound,session,action)=>authorizeBound(bound,action,session)}));
  function publicOriginPolicy(state){const p=state.policy;return{revision:state.policyRevision,policy:p?{accountId:p.accountId,currency:p.currency,epoch:p.epoch,effectiveFrom:p.effectiveFrom,enabled:p.enabled,feeMinor:p.feeMinor,seriesId:p.seriesId,mapping:{counterpartAccountId:p.mapping.counterpartAccountId,taxTreatment:p.mapping.taxTreatment,...(p.mapping.taxCodeId?{taxCodeId:p.mapping.taxCodeId,netAmountMinor:p.mapping.netAmountMinor}:{})}}:null};}
  function publicOriginBookkeeping(value){return value?Object.fromEntries(['status','creator','decisionKey','bankDate','reason','runId','qboEntity','qboId'].filter(k=>value[k]!==undefined).map(k=>[k,value[k]])):undefined;}
  async function originPolicy(user,accountId,input={}){check(exact(input,['offset','limit','expectedHash']),'Use exact bank-origin obligation filters.');const offset=input.offset===undefined?0:input.offset,limit=input.limit===undefined?20:input.limit;check(integer(offset)&&offset>=0&&offset<=1000000&&integer(limit)&&limit>=1&&limit<=50&&(input.expectedHash===undefined||HASH.test(input.expectedHash))&&(offset===0||HASH.test(input.expectedHash||'')),'Bank-origin obligations need bounded pagination and their original hash.');const bound=await bind(user),state=await origins().accountState(bound,accountId);let choices=null;try{choices=await origins().choices(bound);}catch(error){if(!['BUSINESS_ACCESS_DENIED','BUSINESS_ACCESS_FORBIDDEN'].includes(error.code))throw error;}if(typeof origins().returnChoices==='function')choices={...(choices||{}),returns:await origins().returnChoices(bound,accountId,{offset,limit})};const all=state.activity.events.filter(event=>event.source?.entity==='BankOrigin').slice().reverse(),originHash=hash({scope:bound.scope,accountId,events:all,...(choices?.returns?.choiceHash?{returnChoicesHash:choices.returns.choiceHash}:{})});check(input.expectedHash===undefined||input.expectedHash===originHash,'Bank-origin obligations changed. Restart from the latest page.',409,'BANKING_ACTIVITY_CHANGED');const selected=all.slice(offset,offset+limit),nextOffset=offset+selected.length<all.length?offset+selected.length:null,items=selected.map(event=>({...Object.fromEntries(['eventId','accountId','accountCurrency','amountMinor','state','kind','status','bookDate','postingDate','description'].filter(k=>event[k]!==undefined).map(k=>[k,event[k]])),source:publicInstructionSource(event.source),bookkeeping:publicOriginBookkeeping(event.bookkeeping)}));return{...publicOriginPolicy(state),obligations:{items,originHash,total:all.length,neededCount:all.filter(e=>e.bookkeeping.status!=='booked').length,bookedCount:all.filter(e=>e.bookkeeping.status==='booked').length,page:{offset,limit,nextOffset,truncated:nextOffset!==null}},advice:(state.advice||[]).slice(-100).reverse(),adviceTotal:state.advice?.length||0,choices,qboCalls:0};}
  async function configureOriginPolicy(user,command,context={}){const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return publicOriginPolicy({policy:await origins().configure(bound,command),policyRevision:command.expectedRevision+1});}
  async function processOriginDue(user,command,context={}){check(exact(command,['accountId','cutoff']),'Use the exact bank-origin due command.');const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return origins().processDue(bound,command);}
  async function addOriginAdvice(user,command,context={}){const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return origins().addAdvice(bound,command);}
  async function bookOriginEvent(user,command,context={}){const bound=await bind(user,true);if(context.agentAuthority)bound.agentAuthority=context.agentAuthority;return origins().book(bound,command);}
  async function independentActivity(bound,ledger) {
    if(!ledger || !store().listInstructionActivity)return null;
    const {rows,revisions}=await store().listInstructionActivity(bound.scope,ledger.account.accountId);
    const businessActivity=require('./bank-instruction-settlement').projectInstructionActivity({scope:bound.scope,ledger,instructions:rows,revisions});
    if(!store().listOriginRows)return businessActivity;const origins=await store().listOriginRows(bound.scope,ledger.account.accountId),returns=origins.filter(r=>r.payload?.kind==='independent-bank-return-v1'),returnContext=returns.length?await store().listBankOriginContext(bound.scope):null;for(const id of new Set(returns.map(r=>r.payload.returnId))){check(store().authenticateReturnSource,'Return history proof unavailable.',409,'BANKING_RETURN_HELD');const g=require('./bank-origin-service').returnGroup(returnContext,bound.scope,id),proof=await store().authenticateReturnSource(bound,g.source.members[0].eventId);check(canonical(proof.source)===canonical(g.source),'Original return history changed.',409,'BANKING_RETURN_HELD');}return require('./bank-origin-service').projectOriginActivity({scope:bound.scope,ledger,rows:origins,businessActivity,returnContext});
  }
  function publicIndependentActivity(activity) {
    if(!activity)return null;
    const events=activity.events.slice(-200).reverse().map(event=>({...event,source:publicInstructionSource(event.source),...(event.bookkeeping?{bookkeeping:publicOriginBookkeeping(event.bookkeeping)}:{})}));
    const postedShownCount=events.filter(event=>event.state==='posted').length;
    return {...activity,events,totalCount:activity.events.length,shownCount:events.length,truncated:activity.events.length>events.length,postedShownCount,postedTruncated:activity.postedCount>postedShownCount};
  }
  async function pendingActivity(bound,accountId,ledger,activity) {
    if(activity) {
      const all=activity.events.filter(e=>e.state==='pending'),items=all.slice(-200).reverse().map(p=>({eventId:p.eventId,status:p.state,amountMinor:p.amountMinor,currency:p.accountCurrency,bookDate:p.bookDate,receivedAt:p.receivedAt,description:p.description,source:publicInstructionSource(p.source),deliveryActorId:p.deliveryActorId,expectedPostingDate:p.schedule?.expectedPostingDate || null,scheduled:Boolean(p.schedule)}));
      return {availability:'instruction-only',count:all.length,shownCount:items.length,truncated:all.length>items.length,items,note:'Received business instructions awaiting their banking due date. Pending events do not change the bounded posted balance. Other bank activity and intervening historical months are not established.'};
    }
    if(!ledger || !store().listInstructions)return {availability:'not-observed',count:null,items:[],note:'Independent pending bank activity is not observed. Retained statement timing items are shown separately.'};
    const {rows,count}=await store().listInstructions(bound.scope,accountId);
    check(Number.isSafeInteger(count) && count>=rows.length,'Pending bank instruction count is unavailable.',409);
    const items=rows.map(row=>{
      const p=row.payload;
      check(sameScope(row,bound.scope) && sameScope(p.scope,bound.scope) && row.kind==='instruction' && row.accountId===accountId && row.contentHash===hash(p) && p.accountId===accountId && p.accountCurrency===ledger.account.accountCurrency && Number.isSafeInteger(p.amountMinor) && p.state==='pending','Pending instruction evidence changed.',409);
      return {eventId:p.eventId,status:p.state,amountMinor:p.amountMinor,currency:p.accountCurrency,bookDate:p.bookDate,receivedAt:p.receivedAt,description:p.description,source:publicInstructionSource(p.source),deliveryActorId:p.deliveryActorId};
    });
    return {availability:'instruction-only',count,shownCount:items.length,truncated:count>items.length,items,note:'Accepted business instructions received by the independent bank. Pending events do not change the posted balance. Other pending bank activity is not established.'};
  }
  let defaultInstructions;
  const instructions=()=>dependencies.instructions || (defaultInstructions ||= require('./bank-instruction-service').createBankInstructionService({store:store()}));
  async function instructionDelivery(bound) { return dependencies.store && !dependencies.instructions ? {count:0,runs:[],truncated:false,qboCalls:0} : instructions().status(bound); }
  async function recoverInstructions(user,command={}) {
    check(exact(command,['runId']) && (!command.runId || /^[a-f0-9]{24}$/.test(command.runId)),'Retry accepts only an optional exact original run ID.');
    const bound=await bind(user,true);return instructions().recover(bound,command);
  }
  let defaultSettlements;
  const settlements=()=>dependencies.settlements || (defaultSettlements ||= require('./bank-instruction-settlement').createBankInstructionSettlement({store:store(),now,authorize:authorizeBoundAdapter}));
  async function authorizeBoundAdapter(bound) {return authorizeBound(bound,bound.action,bound.session);}
  async function settleInstructions(user,command={}) {
    check(exact(command,['cutoff','eventIds','accountId']),'Settlement accepts only a banking cutoff and exact event identities.');
    return settlements().settle(await bind(user,true),command);
  }
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
  async function ledgerPeriods(bound, ledger, family) {
    if (!ledger) return currentPeriods(family);
    // Fetch immutable references independently of the paginated discovery list.
    const frozen = await store().getPackages(bound.scope,ledger.packages.map(ref=>ref.id));
    const pinned = ledger.packages.map(ref => {
      const row = frozen.find(p=>p._id === ref.id);
      check(row && sameScope(row,bound.scope) && row.accountId === ledger.account.accountId && row.accountCurrency === ledger.account.accountCurrency && row.period === ref.period && row.revision === ref.revision && row.contentHash === ref.contentHash && hash(row.snapshot) === ref.contentHash, 'Frozen bank baseline package is unavailable or changed.',409,'BANKING_EVIDENCE_UNAVAILABLE');
      return row;
    });
    // Keep other retained statement periods accessible; they are not adopted.
    return [...pinned, ...currentPeriods(family).filter(row=>!ledger.packages.some(ref=>ref.period === row.period))].sort((a,b)=>b.period.localeCompare(a.period));
  }
  async function accountSummary(bound, rows, selected) {
    const ledger = await readLedger(bound,rows[0].accountId), activity = await independentActivity(bound,ledger);
    selected ||= ledger ? rows.find(row=>row._id === ledger.packages.at(-1).id) : rows[0];
    const record = ledger ? {Name:ledger.account.accountName,AccountType:ledger.account.accountType} : await account(bound, selected.accountId, selected.accountCurrency);
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
      openingEvidence, pendingActivity: await pendingActivity(bound,selected.accountId,ledger,activity), independentActivity: publicIndependentActivity(activity), unavailableEvidence, selectedPeriodAdopted: Boolean(ledger?.packages.some(ref=>ref.id === selected._id)), independentLedger: ledger };
  }
  async function activity(user,accountId,input={}) {
    check(id(accountId)&&exact(input,['state','offset','limit','expectedHash']),'Exact account and supported current-activity filters required.');
    const state=input.state===undefined?'all':input.state,offset=input.offset===undefined?0:input.offset,limit=input.limit===undefined?20:input.limit;
    check(['all','pending','posted'].includes(state)&&integer(offset)&&offset>=0&&offset<=1000000&&integer(limit)&&limit>=1&&limit<=50&&(input.expectedHash===undefined||HASH.test(input.expectedHash))&&(offset===0||HASH.test(input.expectedHash||'')),'Current activity needs bounded pagination and the first page activityHash for later pages.');
    const bound=await bind(user),ledger=await readLedger(bound,accountId);
    check(ledger&&store().listInstructionActivity,'An adopted baseline and complete independent activity storage are required.',409,'BANKING_ACTIVITY_UNAVAILABLE');
    const projection=await independentActivity(bound,ledger),activityHash=hash({scope:bound.scope,accountId,baselineHash:ledger.contentHash,events:projection.events});
    check(input.expectedHash===undefined||input.expectedHash===activityHash,'Independent activity changed. Restart at offset0 with the new activityHash.',409,'BANKING_ACTIVITY_CHANGED');
    const all=projection.events.filter(event=>state==='all'||event.state===state).slice().reverse(),selected=all.slice(offset,offset+limit),nextOffset=offset+selected.length<all.length?offset+selected.length:null;
    const items=selected.map(event=>({...Object.fromEntries(['eventId','revision','accountId','accountCurrency','amountMinor','state','disposition','bookDate','receivedAt','description','creator','expectedResolution','settlementGroupId','pairedEventId','postingDate','postingBasis','settledAt','deliveryActorId','settlementActorId'].filter(key=>event[key]!==undefined).map(key=>[key,event[key]])),source:publicInstructionSource(event.source),...(event.bookkeeping?{bookkeeping:publicOriginBookkeeping(event.bookkeeping)}:{}),...(event.kind?{kind:event.kind,status:event.status}:{}),expectedPostingDate:event.schedule?.expectedPostingDate||null,scheduled:Boolean(event.schedule),stateHistory:clone(event.stateHistory)}));
    return {accountId,accountCurrency:ledger.account.accountCurrency,availability:'instruction-only',activityHash,state,baselineHash:projection.baselineHash,baselineThroughPeriod:projection.baselineThroughPeriod,baselineBalanceMinor:projection.baselineBalanceMinor,activityMovementMinor:projection.activityMovementMinor,boundedBalanceMinor:projection.boundedBalanceMinor,pendingCount:projection.pendingCount,pendingNativeMinor:projection.pendingNativeMinor,postedCount:projection.postedCount,coverage:clone(projection.coverage),items,page:{offset,limit,totalObserved:all.length,activityTotalObserved:projection.events.length,returned:items.length,nextOffset,truncated:nextOffset!==null,upstreamTruncated:false,completeProjection:true},qboCalls:0};
  }
  async function accounts(user) {
    const bound = await bind(user), rows = await store().list(bound.scope);
    check(rows.every(row => sameScope(row, bound.scope)), 'Stored banking scope mismatch.', 409);
    const groups = new Map();
    for (const row of rows) { if (!groups.has(row.accountId)) groups.set(row.accountId, []); groups.get(row.accountId).push(row); }
    // Adopted accounts must remain discoverable even if all their packages are outside the list window.
    for (const accountId of await store().ledgerAccountIds?.(bound.scope) || []) {
      check(id(accountId), 'Stored independent account identity is invalid.',409);
      if (!groups.has(accountId)) groups.set(accountId,[]);
    }
    const summaries = [];
    for (const [accountId,family] of groups) { const ledger = await readLedger(bound,accountId); const periods = await ledgerPeriods(bound,ledger,family); if (periods.length) summaries.push(await accountSummary(bound, periods)); }
    return { bankName, evidenceLabel, accounts: summaries, instructionProcessing:instructionProcessing(bound), instructionDelivery:await instructionDelivery(bound), truncated: rows.length === 2000, qboCalls: 0 };
  }
  async function accountDetail(user, accountId, filters = {}) {
    check(id(accountId) && exact(filters, ['period']) && (!filters.period || /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.period)), 'Exact account and optional statement month required.');
    const bound = await bind(user), family = await store().list(bound.scope, { accountId });
    check(family.every(row => sameScope(row, bound.scope) && row.accountId === accountId), 'Stored banking account scope mismatch.', 409);
    const ledger = await readLedger(bound,accountId);
    const periods = await ledgerPeriods(bound,ledger,family), row = filters.period ? periods.find(value => value.period === filters.period) : ledger ? periods.find(value=>value._id === ledger.packages.at(-1).id) : periods[0];
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
        status: event.expectedResolution === 'exclude' ? 'excluded' : 'posted', description: bankTransactionDescription(event),
        amountMinor: event.amountMinor, balanceMovementMinor, runningBalanceMinor: balance,
        source: { entity: event.source?.entity || null, id: event.source?.id || null, sourceHash: event.sourceHash || event.source?.sourceHash || null },
        qboRefs: clone(event.resolution?.linkedQboIds || []) };
    });
    check(balance === snapshot.closingMinor, 'Retained transaction movements do not equal the statement closing balance.', 409, 'BANKING_EVIDENCE_UNAVAILABLE');
    const retained = view(row);
    return { bankName, evidenceLabel, ...summary, instructionProcessing:instructionProcessing(bound), instructionDelivery:await instructionDelivery(bound), transactions, outstandingItems: clone(snapshot.outstandingItems),
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
  return { monthlyStatements,issueMonthlyStatements,downloadMonthlyStatement,currentFeeds,publishCurrentFeed,publishCumulativeFeed,downloadCurrentFeed,originPolicy, configureOriginPolicy, processOriginDue, addOriginAdvice, bookOriginEvent, list, detail, accounts, accountDetail, activity, recoverInstructions, settleInstructions, ledgerBaseline, adoptLedger, register, recordImport, recordRow, recordReconciliation, download };
}
module.exports = { createBankingWorkspaceService, createMongoBankingStore, createArtifactReader, loadBankFeedActivity, hash, STRENGTHS };
