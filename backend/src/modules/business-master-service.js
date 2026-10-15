'use strict';
const { hash } = require('./business-calendar');
const { scoped } = require('./qbo-write-contract');
const { createContextService } = require('./rebuild-context');
const { createBusinessRuntimeAccess } = require('./business-runtime-access');
const { createMasterRuntime, loadMasterModels } = require('./business-master-runtime');
const { assertMasterRun, assertMasterApproval } = require('./business-master-preparation-transport');
const { masterProgressHash } = require('./business-master-receipt');
const { assertMasterRecordSet } = require('./business-master-record-evidence');
const { masterRunView, masterProposalView } = require('./business-master-view');
const { validateMasterPreparationInput } = require('./business-master-preparation-plan');
const setup = require('./business-storage-setup');
const ID = /^[a-f0-9]{24}$/, HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'BUSINESS_MASTER_UNAVAILABLE' }); }
function exact(input, keys) { if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) fail('Use the exact reviewed master action without overrides.', 400); return input; }
function runId(id) { if (!ID.test(id || '')) fail('Choose an exact saved master preparation.', 400); return id; }
function planInput(body) { exact(body, ['planHash']); if (!HASH.test(body.planHash || '')) fail('Choose the exact saved master plan.', 400); return body; }
function ordered(values) { if (!Array.isArray(values) || !values.length || values.length > 100 || values.some((n, i) => !Number.isInteger(n) || n < 0 || n > 99 || (i && n <= values[i-1]))) fail('Choose an ordered subset of verified records.', 400); return values; }
function createMasterService(dependencies = {}) {
  const models = dependencies.models || loadMasterModels(), connection = dependencies.connection || require('mongoose').connection;
  const resolve = dependencies.resolveContext || createContextService().resolve, accessFor = dependencies.accessFor || (input => createBusinessRuntimeAccess({ ...models, ...input }));
  const runtimeFor = dependencies.runtimeFor || (input => createMasterRuntime({ ...input, models, connection }));
  const now = dependencies.now || (() => Date.now()), defer = dependencies.defer || (work => setImmediate(work));
  const jobs = new Map(), lastResults = new Map(); let closed = false;
  const read = (filter, session) => models.MasterRuns.findOne(filter).session(session).maxTimeMS(3000).lean();
  async function bind(user, action = 'operations.read', ownerOnly = false) {
    const context = await resolve(user), actorId = String(user.actorId || user.id), ownerId = String(user.id);
    if (!context.connection?.connected || !connection.db) fail('Connect the current company and app storage before preparing business records.');
    const scope = scoped({ realmId: context.connection.realmId, environment: context.environment, connectionId: context.connection.connectionId });
    const access = accessFor({ actorId, ownerId }); await access.authorize(scope, action);
    if (ownerOnly && actorId !== ownerId) fail('Only the connected company owner may decide master preparation.', 403);
    return { scope, ownerId, actorId, access, companyName: context.connection.companyName, runtime: runtimeFor({ scope, ownerId, actorId }) };
  }
  async function permissions(bound) {
    const value = { owner: bound.ownerId === bound.actorId };
    for (const [key, action] of [['prepare','operations.preview'], ['execute','operations.execute'], ['recover','operations.recover']]) {
      try { await bound.access.authorize(bound.scope, action); value[key] = value.owner; }
      catch (error) { if (error.status !== 403) throw error; value[key] = false; }
    }
    return value;
  }
  async function load(bound, id) {
    const value = await read({ _id: runId(id), ...bound.scope, ownerId: bound.ownerId });
    if (!value) fail('This preparation is unavailable in the current company connection.', 404);
    return assertMasterRun(value, bound.scope, bound.ownerId);
  }
  async function view(bound, run) {
    let integrity = true;
    try { await assertMasterRecordSet(models, { realmId: run.realmId, environment: run.environment, connectionId: String(run.connectionId) }, run, run.records.filter(row => ['saved','verified'].includes(row.state)), undefined, { allowSaved: true }); }
    catch { integrity = false; }
    const current = await bound.runtime.store.latest(), allowed = await permissions(bound);
    const result = masterRunView(run, { scope: bound.scope, ownerId: bound.ownerId, currentDraftHash: current?.contentHash, now: now(), permissions: allowed, integrity, localWorker: jobs.get(String(run._id))?.claimed === true });
    await bound.access.authorize(bound.scope, 'operations.read');
    return result;
  }
  async function reply(bound, run, extra = {}) {
    const result = run ? await view(bound, run) : null; await bound.access.authorize(bound.scope, 'operations.read');
    return { ...bound.scope, run: result, ...extra };
  }
  async function status(user) {
    const bound = await bind(user), company = { environment: bound.scope.environment, realmId: bound.scope.realmId };
    let storage;
    try { await bound.runtime.assertReady(); storage = { ready: true }; }
    catch { storage = { ready: false, reason: 'Review master-record storage preparation after completing normal business setup.' }; }
    const open = await read({ ...company, claim: 'open' });
    const matches = open && String(open.ownerId) === bound.ownerId && String(open.connectionId) === bound.scope.connectionId;
    const saved = matches ? open : await models.MasterRuns.findOne({ ...bound.scope, ownerId: bound.ownerId }).sort({ createdAt: -1, _id: -1 }).maxTimeMS(3000).lean();
    return reply(bound, saved, { companyName: bound.companyName, permissions: await permissions(bound), storage, blockingPreparation: open && !matches ? { id: String(open._id), state: open.state, reason: 'An open preparation from an earlier owner or connection must be recovered before another role set can be prepared.' } : null, lastWorkerResult: saved ? lastResults.get(String(saved._id)) || null : null });
  }
  async function inspect(user, id) { runId(id); const bound = await bind(user); return reply(bound, await load(bound, id)); }
  async function history(user, body) {
    exact(body, ['before']); if (body.before !== null && !ID.test(body.before || '')) fail('Choose an exact preparation history cursor.', 400);
    const bound = await bind(user), rows = await models.MasterRuns.find({ environment: bound.scope.environment, realmId: bound.scope.realmId, ownerId: bound.ownerId, ...(body.before ? { _id: { $lt: body.before } } : {}) }).select('_id realmId environment connectionId state claim sourceDraftHash planHash records.ordinal records.key records.entity records.state records.qboId applied.draftVersion disposition.kind createdAt').sort({ _id: -1 }).limit(21).maxTimeMS(3000).lean();
    await bound.access.authorize(bound.scope, 'operations.read');
    return { ...bound.scope, entries: rows.slice(0,20).map(row => ({ id: String(row._id), state: row.state, claim: row.claim, sameConnection: String(row.connectionId) === bound.scope.connectionId, createdAt: row.createdAt || null, draftVersion: row.applied?.draftVersion || null, disposition: row.disposition?.kind || null, retainedRecords: row.records.filter(value => value.qboId).map(value => ({ ordinal: value.ordinal, key: value.key, entity: value.entity, qboId: value.qboId, state: value.state })) })), next: rows.length > 20 ? String(rows[19]._id) : null };
  }
  async function storagePreview(user) { const bound = await bind(user, 'operations.recover', true); const result = await (dependencies.previewSetup || setup.previewSetup)(connection.db, { ...bound.scope, ownerId: bound.ownerId }, bound.scope.environment, 'master-preparation'); await bound.access.authorize(bound.scope, 'operations.read'); return { ...bound.scope, preview: result }; }
  async function storageApply(user, body) { planInput(body); const bound = await bind(user, 'operations.recover', true); const result = await (dependencies.applySetup || setup.applySetup)(connection.db, connection.getClient(), { ...bound.scope, ownerId: bound.ownerId }, bound.scope.environment, body.planHash, 'master-preparation'); await bound.access.authorize(bound.scope, 'operations.read'); return { ...bound.scope, result }; }
  async function prepare(user, body) {
    exact(body, ['connectionId','baseHash','inventoryStartDate','requestKey']); if (!UUID.test(body.requestKey || '')) fail('Keep an exact proposal request identifier for safe retries.', 400);
    const input = validateMasterPreparationInput({ connectionId: body.connectionId, baseHash: body.baseHash, inventoryStartDate: body.inventoryStartDate });
    const bound = await bind(user, 'operations.preview', true); await bound.runtime.assertReady();
    if (input.connectionId !== bound.scope.connectionId) fail('The current company connection changed. Reload the saved business.');
    const prior = await read({ _id: hash({ masterPreparation: bound.scope, ownerId: bound.ownerId, requestKey: body.requestKey.toLowerCase() }).slice(0,24), ...bound.scope, ownerId: bound.ownerId });
    if (prior) { if (prior.sourceDraftHash !== input.baseHash || prior.plan.inventoryStartDate !== input.inventoryStartDate) fail('This proposal identifier already belongs to different saved choices.'); return reply(bound, prior, { existing: true }); }
    const open = await read({ environment: bound.scope.environment, realmId: bound.scope.realmId, claim: 'open' });
    if (open) { if (String(open.ownerId) !== bound.ownerId || String(open.connectionId) !== bound.scope.connectionId) fail('Recover the earlier company preparation before proposing another role set.'); return reply(bound, open, { existing: true }); }
    const plan = await bound.runtime.prepare(input);
    if (!plan.runnable) { await bound.access.authorize(bound.scope, 'operations.read'); return { ...bound.scope, run: null, preview: masterProposalView(plan) }; }
    const result = await bound.runtime.store.propose(plan, body.requestKey); return reply(bound, result.run, { existing: result.existing });
  }
  async function approve(user, id, body) {
    runId(id); exact(body, ['planHash','productionConfirmed']); if (!HASH.test(body.planHash || '') || typeof body.productionConfirmed !== 'boolean') fail('Review the exact plan and confirm its target environment.', 400);
    const bound = await bind(user, 'operations.execute', true), run = await load(bound,id);
    const currentPlan = run.approval ? undefined : await bound.runtime.prepare({ connectionId: bound.scope.connectionId, baseHash: run.sourceDraftHash, inventoryStartDate: run.plan.inventoryStartDate });
    return reply(bound, await bound.runtime.store.approve(id, body.planHash, body.productionConfirmed, currentPlan));
  }
  async function start(user, id, body, recover = false) {
    runId(id); exact(body, recover ? ['planHash','reviewHash'] : ['planHash','reviewHash','resume']);
    if (!HASH.test(body.planHash || '') || !HASH.test(body.reviewHash || '') || (!recover && typeof body.resume !== 'boolean')) fail('Review the exact current progress before starting this worker.', 400);
    const bound = await bind(user, recover ? 'operations.recover' : 'operations.execute', true); await bound.runtime.assertReady(); const run = await load(bound,id); assertMasterApproval(run);
    if (run.planHash !== body.planHash) fail('The selected master plan changed.');
    if (closed) fail('The worker is unavailable; the saved plan remains available for recovery.');
    if (jobs.has(id)) { const claimed = await jobs.get(id).admission; return reply(bound, await load(bound,id), { workerClaimed: claimed, existing: true }); }
    if (run.state === 'complete' || run.claim === 'closed') return reply(bound, run, { workerClaimed: false, existing: true });
    if (masterProgressHash(run) !== body.reviewHash) fail('Saved progress changed. Refresh before continuing.');
    if (jobs.size >= 3) fail('Other saved workers are active. Retry after they settle.');
    let acknowledge; const admission = new Promise(resolve => { acknowledge = resolve; }), entry = { admission, claimed: false };
    const onClaim = () => { entry.claimed = true; acknowledge(true); };
    const work = new Promise(resolve => defer(resolve)).then(() => recover ? bound.runtime.execute.recover(id, { reviewHash: body.reviewHash, onClaim }) : bound.runtime.execute(id, { resume: body.resume, reviewHash: body.reviewHash, onClaim })).then(result => {
      lastResults.set(id, { failure: result.failure || null }); if (lastResults.size > 20) lastResults.delete(lastResults.keys().next().value); return result;
    }).catch(() => { lastResults.set(id, { failure: { code: 'worker', message: 'The worker could not finish claiming or reading saved progress. Refresh before retrying.' } }); }).finally(() => { jobs.delete(id); acknowledge(false); });
    entry.work = work; jobs.set(id, entry); const claimed = await admission;
    return reply(bound, await load(bound,id), { workerClaimed: claimed });
  }
  async function stop(user, id, body) { runId(id); exact(body, []); const bound = await bind(user, 'operations.stop', true); return reply(bound, await bound.runtime.store.stop(id)); }
  async function retry(user,id,body) { runId(id); exact(body,['ordinal','planHash','confirmNoEffect','reviewHash']); if (!Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal > 99 || !HASH.test(body.planHash || '') || !HASH.test(body.reviewHash || '') || body.confirmNoEffect !== true) fail('Confirm the exact first no-effect attempt.',400); const bound=await bind(user,'operations.execute',true); return reply(bound,await bound.runtime.store.retry(id,body.ordinal,body.planHash,true,body.reviewHash)); }
  async function retain(user,id,body) { runId(id); exact(body,['planHash','confirmRetain','reviewHash']); if (!HASH.test(body.planHash || '') || !HASH.test(body.reviewHash || '') || body.confirmRetain !== true) fail('Confirm the exact retained IDs and unsent tail.',400); const bound=await bind(user,'operations.recover',true); return reply(bound,await bound.runtime.store.retain(id,body.planHash,true,body.reviewHash)); }
  async function applyReview(user,id,body) { runId(id); exact(body,['ordinals']); ordered(body.ordinals); const bound=await bind(user,'operations.recover',true); const review=await bound.runtime.store.applyReview(id,body.ordinals); await bound.access.authorize(bound.scope,'operations.read'); return {...bound.scope,review}; }
  async function apply(user,id,body) { runId(id); exact(body,['ordinals','reviewHash','requestKey']); ordered(body.ordinals); if (!HASH.test(body.reviewHash || '') || !UUID.test(body.requestKey || '')) fail('Use the exact apply review and save identifier.',400); const bound=await bind(user,'operations.recover',true); const result=await bound.runtime.store.apply(id,{ordinals:body.ordinals,reviewHash:body.reviewHash},body.requestKey); return reply(bound,result.run,{draft:result.draft,reused:result.reused}); }
  async function attributionReview(user,id,body) { runId(id); exact(body,['ordinal','qboId']); if (!Number.isInteger(body.ordinal) || body.ordinal<0 || body.ordinal>99 || !/^\d{1,30}$/.test(body.qboId || '')) fail('Choose the exact unknown ordinal and candidate ID.',400); const bound=await bind(user,'operations.recover',true); const review=await bound.runtime.store.attributionReview(id,body.ordinal,body.qboId); await bound.access.authorize(bound.scope,'operations.read'); return {...bound.scope,review}; }
  async function attribute(user,id,body) { runId(id); exact(body,['ordinal','qboId','reviewHash','reason','confirmOwnership']); const bound=await bind(user,'operations.recover',true); const {ordinal,...input}=body; return reply(bound,await bound.runtime.store.attribute(id,ordinal,input)); }
  return Object.freeze({ status,inspect,history,storagePreview,storageApply,prepare,approve,execute:(user,id,body)=>start(user,id,body,false),recover:(user,id,body)=>start(user,id,body,true),stop,retry,retain,applyReview,apply,attributionReview,attribute,idle:async()=>{while(jobs.size)await Promise.allSettled([...jobs.values()].map(entry=>entry.work));},close:()=>{closed=true;} });
}
module.exports = { createMasterService };
