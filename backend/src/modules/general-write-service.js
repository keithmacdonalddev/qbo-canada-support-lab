'use strict';
const { businessErrorDetail, attachBusinessError, failureFields } = require('./business-error-detail');
// The general governed QuickBooks write (manageQboRecord), contract general-write-v1
// (docs/plans/general-governed-write-tool-2026-10-31.md, rev 3). It composes the pure
// parts: guards over the synced copy, the resource-aware scheduler, the exact transport
// identity and item recovery, and the complete-entity merge.
//
// Dispatch is held unless the server flag GENERAL_WRITE_DISPATCH_ENABLED is on and a
// transport is installed: preparation saves a guarded plan and sends nothing. The live
// transport (through qbo-write-gate.js) and day-close verification of general records are
// separate, reviewed steps; until both exist the flag must stay off, because a record
// written outside the period proof would fail the next close.
const { hash, canonical } = require('./business-calendar');
const { checkGeneralWrite } = require('./general-write-guards');
const { itemOutcomes, matchesRequest, matchesSavedRequest } = require('./general-write-recovery');
const { isComplete, invalidatedParents } = require('./general-write-merge');
const { REF_TARGETS } = require('./qbo-entity-schema');
const KEY = /^[a-zA-Z0-9_-]{8,100}$/, QBO_ID = /^\d{1,30}$/, MAX_ATTEMPTS = 3;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status, code: 'GENERAL_WRITE_REFUSED' }); }
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const scopeOf = scope => ({ environment: scope.environment, realmId: scope.realmId, connectionId: String(scope.connectionId) });
// Keys a proposal (and the records it touches) need from the copy, as [entity, id] pairs.
function wanted(value, out = []) {
  if (Array.isArray(value)) value.forEach(entry => wanted(entry, out));
  else if (plain(value)) for (const [key, entry] of Object.entries(value)) {
    if (/Ref$/.test(key) && plain(entry) && QBO_ID.test(String(entry.value ?? ''))) for (const kind of REF_TARGETS[key] || []) if (kind !== 'self') out.push([kind, String(entry.value)]);
    if (key === 'LinkedTxn' && Array.isArray(entry)) for (const link of entry) if (QBO_ID.test(String(link?.TxnId ?? ''))) out.push([link.TxnType === 'BillPaymentCheck' ? 'BillPayment' : link.TxnType, String(link.TxnId)]);
    wanted(entry, out);
  }
  return out;
}
// A synchronous view of the copy for the pure guards: prefetch every record the proposal
// names, the records those link to, and the accounts and items their lines use.
async function loadCopy(copy, scope, operations, owned, extras = [], stale = new Set(), requiredRecords = []) {
  const map = new Map(), seen = new Set();
  // Records this write already saved (from their complete responses) count as current,
  // unless a later saved item of this write changed them (a payment changes its invoice's
  // balance): a saved response is stale once a later step touches the same record. Those
  // are read fresh, once, from QuickBooks.
  for (const { entity, record } of extras) { const key = entity + ':' + String(record?.Id); if (record?.Id && !stale.has(key)) { map.set(key, record); seen.add(key); } }
  for (const key of stale) {
    if (seen.has(key)) continue;
    const [entity, id] = key.split(':');
    if (typeof copy.fetch !== 'function') fail(key.replace(':', ' ') + ' was changed by this write; its current version must be read before the next batch.');
    const record = await copy.fetch(scope, entity, id);
    if (!record || String(record.Id) !== id) fail(key.replace(':', ' ') + ' could not be read fresh from QuickBooks; nothing more was sent.');
    map.set(key, record); seen.add(key);
  }
  const fetch = async pairs => { for (const [entity, id] of pairs) { const key = entity + ':' + id; if (seen.has(key)) continue; seen.add(key); const record = await copy.read(scope, entity, id); if (record) map.set(key, record); } };
  // Protected-period traversal can reach beyond the proposal's three reference rounds.
  // Load every authenticated proof dependency; native sidecars only fill absent mirror rows.
  await fetch(requiredRecords);
  await fetch(operations.filter(op => op?.id).map(op => [op.entity, String(op.id)]));
  for (let round = 0; round < 3; round++) await fetch([...operations.map(op => op?.payload), ...map.values()].flatMap(value => wanted(value)));
  for (const code of [...map.values()].filter(record => record.SalesTaxRateList || record.PurchaseTaxRateList)) await fetch([...(code.SalesTaxRateList?.TaxRateDetail || []), ...(code.PurchaseTaxRateList?.TaxRateDetail || [])].map(row => ['TaxRate', String(row.TaxRateRef?.value)]));
  return { get: (entity, id) => map.get(entity + ':' + id) || null, owned: (entity, id) => owned.has(entity + ':' + id), map };
}
// Replace { $ref: name } placeholders with the ids saved by earlier batches. A ref not yet
// saved stays a placeholder: the guards place it after its create, and a batch is only
// built once every placeholder it uses is resolved (checked again before sending).
function resolve(value, saved) {
  if (Array.isArray(value)) return value.map(entry => resolve(entry, saved));
  if (!plain(value)) return value;
  if (value.$ref !== undefined && Object.keys(value).length === 1) return saved[value.$ref] ? { value: saved[value.$ref] } : value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = ['TxnId', 'value'].includes(key) && plain(entry) && entry.$ref !== undefined ? (saved[entry.$ref] || entry) : resolve(entry, saved);
  return out;
}
const unresolved = value => JSON.stringify(value).includes('"$ref"');
// Read-only native bodies from this exact protected-period preflight. They may
// fill a hardened-copy miss; they never grant ownership or replace current data.
function preflightRecordsFor({ scope, run, batch, periodProof, preflightReads, now }) {
  if (!preflightReads) return new Map();
  const bad = () => fail('Fresh linked-record evidence changed or is incomplete; nothing was sent.');
  const request = require('./general-write-transport').buildGeneralBatch(scope, batch);
  if (preflightReads.version !== 1 || canonical(preflightReads.scope) !== canonical(scopeOf(scope)) || preflightReads.runId !== String(run._id) || preflightReads.batchIndex !== batch.index || preflightReads.requestId !== batch.requestId || preflightReads.requestHash !== request.requestHash || preflightReads.proofHash !== hash(periodProof) || !Array.isArray(preflightReads.records) || !Number.isFinite(Date.parse(preflightReads.startedAt)) || now < Date.parse(preflightReads.startedAt) || now - Date.parse(preflightReads.startedAt) > 300000 || periodProof?.kind !== 'general-period-proof') bad();
  const expected = new Map(), records = new Map();
  for (const proof of periodProof.proofs || []) for (const row of proof.evidence?.records || []) {
    const key = row.entity + ':' + row.id;
    if (expected.has(key) && canonical(expected.get(key)) !== canonical(row)) bad();
    expected.set(key, row);
  }
  for (const row of preflightReads.records) {
    const key = row.entity + ':' + row.id, proof = expected.get(key), record = row.record;
    if (!proof || records.has(key) || record?.Id !== row.id || record?.SyncToken !== proof.syncToken || record?.sparse === true || !isComplete(row.entity, record) || hash(record) !== proof.recordHash) bad();
    records.set(key, JSON.parse(canonical(record)));
  }
  return records;
}
function createGeneralWriteServiceImplementation({ models, copy, contextFor, transport = null, retain = null, markDirty = null, transaction = null, authorizeRecovery = null, recoveryCopy = copy, recoveryLedger = null, recoveryReadsFor = null, caseWrites = false, dispatchEnabled = () => require('../config').features?.generalWriteDispatch === true, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
  const unsent = require('./general-write-unsent').createGeneralUnsentRetirement({ models, Runs, now });
  const recoveryHelper = require('./general-estimate-recovery'), recoveryFence = recoveryHelper.createRecoveryFence({ models, transaction, authorize: authorizeRecovery, now });
  async function ownedSet(scope, operations, session) {
    const inSession = query => session ? query.session(session) : query;
    const keys = operations.filter(op => op?.id).map(op => op.entity + ':' + op.id), owned = new Set();
    for (const key of keys) {
      const [entity, qboId] = key.split(':');
      if (await inSession(models.Steps.findOne({ environment: scope.environment, realmId: scope.realmId, entity, qboId, state: 'verified' })).select('_id').maxTimeMS(3000).lean()) owned.add(key);
      else if (await inSession(Runs.findOne({ environment: scope.environment, realmId: scope.realmId, owned: { $elemMatch: { key, op: 'create' } } })).select('_id').maxTimeMS(3000).lean()) owned.add(key);
    }
    return owned;
  }
  async function guard(scope, operations, extras = [], stale = new Set(), session, runId, fresh = new Map(), requiredRecords = []) {
    const owned = await ownedSet(scope, operations, session);
    for (const { entity, record } of extras) if (record?.Id) owned.add(entity + ':' + String(record.Id));
    const currentCopy = session && copy.forSession ? copy.forSession(session) : copy;
    const readOnlyCopy = { ...currentCopy, read: async (readScope, entity, id) => (await currentCopy.read(readScope, entity, id)) || fresh.get(entity + ':' + id) || null };
    const local = await loadCopy(readOnlyCopy, scope, operations, owned, extras, stale, requiredRecords), context = await contextFor(scope, local, { session, runId, operations, salesTaxCodes: [...new Set(operations.filter(op => require('./qbo-entity-schema').ENTITIES[op?.entity]?.direction === 'sales').flatMap(op => { const record = { ...(op.id ? local.get(op.entity, String(op.id)) : {}), ...op.payload }; return (Array.isArray(record.Line) ? record.Line : []).map(line => line?.SalesItemLineDetail?.TaxCodeRef?.value); }).filter(id => typeof id === 'string'))] });
    const result = checkGeneralWrite({ proposal: { operations }, local, context, scope, runId });
    // A later posting day is independent; changing an earlier pending day's records,
    // names or links would change the close's exact readback evidence and must wait.
    if (context.calendarClosePending) {
      const pendingDate = date => date > context.verifiedThrough && date < context.day;
      for (const op of operations) {
        const before = op.id ? local.get(op.entity, String(op.id)) : null;
        const linked = wanted([op.payload, before]).some(([entity, id]) => pendingDate(local.get(entity, id)?.TxnDate));
        if (pendingDate(op.payload?.TxnDate) || before && (before.TxnDate < context.day || !before.TxnDate) || linked) {
          result.problems.push({ ref: op.ref, message: 'An earlier business day is still open and unverified. Changes to its records or links and history edits wait for its close; independent records dated today can continue.' });
          result.ok = false;
        }
      }
    }
    return { result, local, context };
  }
  // Preparation: validate, guard and save the plan. Nothing is sent.
  async function prepare(bound, input) {
    const scope = scopeOf(bound.scope);
    if (bound.caseAuthority && (bound.agentAuthority || !Array.isArray(input?.operations) || input.operations.length !== 1 || !['create', 'update', 'void', 'delete'].includes(input.operations[0].op))) fail('Case general writes accept exactly one case-authorized operation.');
    if (!plain(input) || Object.keys(input).some(key => !['decisionKey', 'purpose', 'operations'].includes(key)) || !KEY.test(input.decisionKey || '') || typeof input.purpose !== 'string' || input.purpose.trim().length < 10 || input.purpose.length > 2000 || !Array.isArray(input.operations)) fail('Send { decisionKey (8-100 letters, digits, - or _), purpose (10-2,000 characters), operations: [...] }.', 400);
    const contentHash = hash({ purpose: input.purpose.trim(), operations: input.operations }), _id = hash({ scope, ownerId: String(bound.ownerId), kind: 'general-write', decisionKey: input.decisionKey }).slice(0, 24);
    let existing = await Runs.findOne({ _id, environment: scope.environment, realmId: scope.realmId }).lean();
    if (existing) existing = await unsent.retire(scope, existing);
    if (existing) {
      if (canonical(existing.caseAuthority || null) !== canonical(bound.caseAuthority || null)) fail('This write belongs to a different case authority.');
      if (existing.contentHash !== contentHash) fail('decisionKey ' + input.decisionKey + ' already names different work (' + existing.status + '). Use a new decisionKey for a new decision.');
      const admitted = existing.batches?.some(batch => batch.transport?.receiptId) || Boolean(models.Receipts && existing.batches?.length && await models.Receipts.findOne({ ...scope, kind: 'general-write', 'general.runId': String(existing._id), 'general.requestId': { $in: existing.batches.map(batch => batch.requestId) } }).select('_id').maxTimeMS(3000).lean());
      return { runId: _id, status: existing.status, reused: true, admitted, plan: summary(existing.plan) };
    }
    const { result, context } = await guard(scope, input.operations);
    if (!result.ok) return { runId: null, status: 'refused', problems: result.problems, errorDetail: businessErrorDetail({ code: 'GENERAL_WRITE_REFUSED', message: 'The proposed records did not pass business checks.', businessDetail: { problems: result.problems } }, { check: { module: 'general-write-service', function: 'prepare', file: 'backend/src/modules/general-write-service.js' } }) };
    await Runs.create([{ _id, contract: 'general-write-v1', ...scope, ownerId: bound.ownerId, actorId: bound.actorId, agentAuthority: bound.agentAuthority || null, caseAuthority: bound.caseAuthority || null, decisionKey: input.decisionKey, contentHash, purpose: input.purpose.trim(), day: context.day, plan: result.plan, status: 'prepared' }]);
    return { runId: _id, status: 'prepared', reused: false, plan: summary(result.plan) };
  }
  function summary(plan) { return { operations: plan.operations.length, batches: plan.layers.length, reverifyDates: plan.reverifyDates, externalEdits: plan.externalEdits, exposureCents: plan.exposureCents }; }
  async function save(run, changes, session) {
    if (changes.lastError) changes = { ...changes, ...failureFields(run, Object.assign(new Error(changes.lastError), { code: 'GENERAL_WRITE_REFUSED', businessDetail: { status: changes.status, problems: changes.problems || [], items: Object.entries(changes.items || {}).filter(([,item]) => !['saved','deleted'].includes(item.outcome)).map(([ref,item]) => ({ ref, entity: item.entity, outcome: item.outcome, fault: item.fault, next: item.next })) } }), { operationId: String(run._id) }, now()) };
    if (changes.status === 'complete' || changes.items && canonical(changes.items) !== canonical(run.items)) changes = { ...changes, progressAt: new Date(now()), ...(changes.status === 'complete' ? { errorDetail: null, errorHistory: [] } : {}) };
    const saved = await Runs.findOneAndUpdate({ _id: run._id, revision: run.revision }, { $set: changes, $inc: { revision: 1 } }, { new: true, session }).lean();
    if (!saved) fail('This write changed concurrently; read it again.');
    return saved;
  }
  async function refreshSettlement(run, batch) {
    const fresh = await Runs.findOne({ _id: run._id, ...scopeOf(run) }).lean();
    const previousDirty = run.dirty || [], currentDirty = fresh?.dirty || [];
    const additions = currentDirty.filter(marker => !previousDirty.some(old => canonical(old) === canonical(marker)));
    if (previousDirty.some(marker => !currentDirty.some(current => canonical(current) === canonical(marker))) || additions.some(marker => !(batch.dirtyDates || []).includes(marker.date) || String(marker.runId) !== String(run._id) || marker.reason !== 'General write ' + run.decisionKey)) fail('History markers changed outside this batch admission.');
    const withoutTransport = row => ({ ...row, dirty: previousDirty, revision: 0, updatedAt: null, batches: row.batches.map(({ transport, ...rest }) => rest) });
    if (!fresh || canonical(JSON.parse(JSON.stringify(withoutTransport(fresh)))) !== canonical(JSON.parse(JSON.stringify(withoutTransport(run)))) || fresh.batches.find(row => row.index === batch.index)?.requestId !== batch.requestId) fail('This write changed concurrently; read it again.');
    return fresh;
  }
  // Recheck known saved mismatches against their immutable creation receipts.
  // PO omissions use retained replies; Invoice links require fenced fresh reads.
  async function recheckSavedMismatch(run, scope, bound) {
    if (run.status !== 'needs-correction' || !models.Receipts || Object.values(run.items).some(item => item.outcome === 'unknown')) return run;
    const items = { ...run.items }, snapshots = [];
    const sameRecoveryOwner=String(bound.ownerId||'')===String(run.ownerId)&&String(bound.actorId||'')===String(run.actorId)&&canonical(bound.agentAuthority||null)===canonical(run.agentAuthority||null)&&!run.caseAuthority;
    const apRecovery=sameRecoveryOwner?await require('./general-billpayment-recovery').assess({models,scope,run,bound,copy:recoveryCopy,fence:recoveryFence,ledgerFor:recoveryLedger,readersFor:recoveryReadsFor,now}):null;
    if(apRecovery){Object.assign(items,apRecovery.items);snapshots.push(apRecovery.snapshot);}
    for (const [ref, item] of Object.entries(items)) {
      if (item.outcome === 'mismatch' && item.entity === 'Invoice') {
        if (String(bound.ownerId || '') !== String(run.ownerId) || String(bound.actorId || '') !== String(run.actorId) || canonical(bound.agentAuthority || null) !== canonical(run.agentAuthority || null) || run.caseAuthority) continue;
        const batch = run.batches.find(row => row.attempt === item.attempt && row.state === 'answered' && row.items.some(sent => sent.ref === ref));
        if (!batch?.transport?.receiptId) continue;
        const receipt = await models.Receipts.findOne({ _id: batch.transport.receiptId, ...scope, kind: 'general-write', state: 'saved' }).maxTimeMS(3000).lean();
        const source = recoveryHelper.sourceOf(run,ref,receipt);
        if (!source) continue;
        const snapshot = await recoveryFence.start(scope,run,bound,{invoiceId:source.item.qboId,estimateId:source.estimateId});
        const loadEstimate = id => recoveryHelper.loadEstimateCreation({ Runs, Receipts:models.Receipts, scope, ownerId:run.ownerId, id });
        const recovered = await recoveryHelper.assessSavedEstimate({ run, ref, receipt, copy: recoveryCopy, scope, now, snapshot, loadEstimate,loadAssignment:(source,estimateOriginal)=>recoveryHelper.loadNativeAssignment({models,scope,source,estimateOriginal}) });
        if (recovered?.reconciliation && recovered.outcome === 'saved') snapshots.push(snapshot);
        if (recovered) items[ref] = recovered;
        continue;
      }
      if (item.outcome !== 'mismatch' || item.entity !== 'PurchaseOrder') continue;
      const batch = run.batches.find(row => row.attempt === item.attempt && row.state === 'answered' && row.items.some(sent => sent.ref === ref));
      if (!batch?.transport?.receiptId || batch.transport.outcome !== 'saved') continue;
      const request = require('./general-write-transport').buildGeneralBatch(scope, batch);
      const receipt = await models.Receipts.findOne({ _id: batch.transport.receiptId, ...scope, kind: 'general-write', state: 'saved', requestHash: request.requestHash }).maxTimeMS(3000).lean();
      const rows = batch.transport.response, proof = receipt?.observed;
      if (!receipt || receipt.general?.runId !== String(run._id) || receipt.general.batchIndex !== batch.index || receipt.general.requestId !== batch.requestId || proof?.entity !== 'batch' || proof.operation !== 'create' || !Number.isInteger(proof.httpStatus) || proof.httpStatus < 200 || proof.httpStatus >= 300 || !Array.isArray(rows) || rows.length !== batch.items.length || new Set(rows.map(row => row.bId)).size !== rows.length || proof.items?.length !== rows.length) continue;
      if (!rows.every(row => { const { bId, ...body } = row, original = proof.items.find(p => p.bId === bId); return original?.outcome === 'saved' && original.responseHash === require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex'); })) continue;
      const sent = batch.items.find(row => row.ref === ref), native = rows.find(row => row.bId === sent.bId)?.[sent.entity];
      if (!native || native.Id !== item.qboId || canonical(sent.payload) !== canonical(item.request) || canonical(native) !== canonical(item.record) || !matchesSavedRequest({ ...sent, scope, runId: String(run._id) }, native)) continue;
      const expectation = { ...sent.payload }; if (native.DueDate == null) delete expectation.DueDate;
      if (!isComplete(sent.entity, native, expectation)) continue;
      const { next, errorDetail, ...saved } = item;
      items[ref] = { ...saved, outcome: 'saved', complete: true, parents: invalidatedParents(sent.before || null, native) };
    }
    if (canonical(items) === canonical(run.items)) return save(run, { items }); // Advance the bounded recheck queue without changing evidence.
    const complete = run.batches.every(batch => batch.state === 'answered' && batch.transport?.outcome === 'saved') && run.plan.operations.every(op => ['saved','deleted'].includes(items[op.ref]?.outcome));
    const settled = Object.values(items).every(item => ['saved','deleted'].includes(item.outcome));
    const changes = { items, ...((complete || settled) ? { status: complete ? 'complete' : 'prepared', lastError: null, errorDetail: null, errorHistory: [] } : {}) };
    if (snapshots.length) return recoveryFence.commit({scope,run,bound,snapshots,work:async session=>{
      if(apRecovery)await require('./general-billpayment-recovery').commit({assessment:apRecovery,models,scope,run,session});
      for (const [ref,item] of Object.entries(items)) if (item.reconciliation && item.outcome==='saved' && run.items[ref]?.outcome==='mismatch') {
        if(item.entity==='BillPayment'){const receipt=await models.Receipts.findOne({_id:item.reconciliation.receiptId,...scope}).session(session).maxTimeMS(3000).lean();if(!await require('./general-billpayment-recovery').loadProof({models,scope,run:{...run,items},ref,receipt,current:item.record,session}))fail('Saved bill-payment ledger proof changed');continue;}
        const batch=run.batches.find(row=>row.attempt===item.attempt&&row.items.some(sent=>sent.ref===ref));
        const receipt=await models.Receipts.findOne({_id:batch.transport.receiptId,...scope,kind:'general-write',state:'saved'}).session(session).maxTimeMS(3000).lean();
        const source=recoveryHelper.sourceOf(run,ref,receipt),quote=await recoveryHelper.loadEstimateCreation({Runs,Receipts:models.Receipts,scope,ownerId:run.ownerId,id:item.reconciliation.estimate.Id,session});
        const assignment=await recoveryHelper.loadNativeAssignment({models,scope,source,estimateOriginal:quote?.original,session});
        if(item.reconciliation.nativeAssignment&&canonical(item.reconciliation.nativeAssignment)!==canonical(recoveryHelper.nativeAssignmentRef(assignment)))fail('The completed native number authority changed.');
        if(!source||!quote||hash(quote.original)!==item.reconciliation.sourceEstimate.recordHash||quote.receiptId!==item.reconciliation.sourceEstimate.receiptId||!recoveryHelper.assertRepairedPair(source,item.record,item.reconciliation.estimate,quote.original,assignment)) fail('The original estimate recovery sources changed.');
      }
      return save(run,changes,session);
    }});
    return save(run, changes);
  }
  // Execution: one batch at a time, each guarded again on the current copy right before it
  // is sent, its exact identity saved first. Returns progress, faults or the unknown items.
  async function execute(bound, runId) {
    const scope = scopeOf(bound.scope);
    let run = await Runs.findOne({ _id: runId, environment: scope.environment, realmId: scope.realmId }).lean();
    if (!run || String(run.connectionId) !== scope.connectionId) fail('This general write is unavailable.', 404);
    if (canonical(run.caseAuthority || null) !== canonical(bound.caseAuthority || null) || run.caseAuthority && !caseWrites) fail('This write belongs to a different case authority.');
    run = await unsent.retire(scope, run);
    if (['complete', 'expired-unsent'].includes(run.status) || run.retirement?.retainedSavedEffects) return report(run);
    // A saved mismatch is a read-only recovery pass, even while API dispatch is
    // disabled. It must never fall through into another batch after reconciliation.
    if (run.status === 'needs-correction') return report(await recheckSavedMismatch(run, scope, bound));
    if (!dispatchEnabled() || !transport) { if (run.status !== 'held') run = await save(run, { status: 'held', lastError: 'Dispatch of general writes is not enabled on this server yet; the plan is saved and nothing was sent.' }); return report(run); }
    run = await recheckSavedMismatch(run, scope, bound);
    if (run.status === 'complete') return report(run);
    if (run.status === 'needs-correction' || Object.values(run.items).some(item => ['mismatch', 'unknown'].includes(item.outcome))) return report(run);
    for (let guardRounds = 0; guardRounds < 40; guardRounds++) {
      const saved = Object.fromEntries(Object.entries(run.items).filter(([, item]) => item.outcome === 'saved').map(([ref, item]) => [ref, item.qboId]));
      const done = new Set(Object.entries(run.items).filter(([, item]) => ['saved', 'deleted'].includes(item.outcome)).map(([ref]) => ref));
      // A batch saved but unanswered (lost response) is replayed with the same identity.
      let batch = run.batches.find(row => row.state !== 'answered');
      if (!batch) {
        const remaining = run.plan.operations.filter(op => !done.has(op.ref));
        if (!remaining.length) { run = await save(run, { status: 'complete', lastError: null, errorDetail: null, errorHistory: [] }); return report(run); }
        const operations = remaining.map(op => ({ ref: op.ref, op: op.op, entity: op.entity, ...(op.id ? { id: op.id } : {}), payload: resolve(op.payload, saved), ...(op.reason ? { reason: op.reason } : {}) }));
        // Earlier saved records count for references; their ids are now real ids.
        const extras = Object.values(run.items).filter(item => item.outcome === 'saved' && item.record).map(item => ({ entity: item.entity, record: item.record }));
        // Records whose balance or backlinks a saved item changed, and that remaining work uses.
        const stale = new Set(Object.values(run.items).filter(item => ['saved', 'deleted'].includes(item.outcome)).flatMap(item => item.parents || []));
        const used = new Set(operations.flatMap(op => [op.id ? op.entity + ':' + op.id : null, ...wanted(op.payload).map(([entity, id]) => entity + ':' + id)]).filter(Boolean));
        const { result, local, context } = await guard(scope, operations, extras, new Set([...stale].filter(key => used.has(key))), undefined, String(run._id));
        if (context.day !== run.day) {
          run = await unsent.retire(scope, run);
          if (run.status === 'expired-unsent') return report(run);
          const error = Object.assign(new Error('The business day changed. Retain saved effects and replan only unsent work with a new decisionKey.'), { code: 'GENERAL_WRITE_DAY_CHANGED', qboStage: 'write_admission', outcomeUnknown: false });
          run = await save(run, { status: 'needs-correction', ...failureFields(run, error, { operationId: String(run._id) }, now()) });
          return report(run);
        }
        if (!result.ok) { run = await save(run, { status: 'needs-correction', lastError: 'The company changed since preparation: ' + result.problems.map(row => (row.ref ? row.ref + ': ' : '') + row.message).join(' ') }); return report(run, result.problems); }
        const first = new Set(result.plan.layers[0]), attempt = run.batches.length + 1;
        const items = result.plan.operations.filter(op => first.has(op.ref)).map((op, n) => {
          const current = op.id ? local.get(op.entity, op.id) : null, body = op.op === 'create' ? op.payload : op.op === 'update' ? { ...op.payload, Id: op.id, SyncToken: current.SyncToken, sparse: true } : { Id: op.id, SyncToken: current.SyncToken, ...(op.op === 'void' ? { sparse: true } : {}) };
          if (unresolved(body)) fail('Operation ' + op.ref + ' still names an unsaved earlier record; nothing was sent.');
          return { bId: String(n + 1), ref: op.ref, op: op.op, entity: op.entity, ...(op.id ? { id: op.id, before: current } : {}), operation: op.op, payload: body, ...(body.CurrencyRef?.value && body.CurrencyRef.value !== 'CAD' && ['Payment', 'BillPayment'].includes(op.entity) ? { postingSources: Object.fromEntries((body.Line || []).flatMap(line => line.LinkedTxn || []).map(link => { const key = link.TxnType + ':' + link.TxnId; return [key, local.get(link.TxnType, String(link.TxnId))]; })) } : {}) };
        });
        batch = { index: run.batches.length, attempt, requestId: hash({ runId: run._id, attempt, refs: items.map(item => item.ref) }).slice(0, 32), items, state: 'sending', savedAt: new Date(now()).toISOString() };
        // Save the affected dates with the exact batch identity. The coordinated
        // admission transaction installs their durable markers only after it owns
        // the writer, before any QBO send. A busy writer cannot invalidate its owner.
        batch.dirtyDates = result.plan.reverifyDates;
        if (batch.dirtyDates.length && transport.historyMarkersAtAdmission !== true) fail('Historical writes require transactional dirty-marker admission.');
        run = await save(run, { batches: [...run.batches, batch], status: 'sending' });
      }
      // Send (or replay) exactly the saved identity. Each transport attempt is counted first,
      // so a replay is a new receipt with the same requestid and bIds.
      // A response settled by the gate survives a crash before this service ingests it.
      let response = batch.transport?.response;
      if (response && batch.transport?.outcome === 'unknown' && transport.recoverBatch) {
        try {
          const recovered = await transport.recoverBatch(scope, { runId: run._id, batch });
          run = await refreshSettlement(run, batch);
          if (recovered?.retryExact) response = null;
        } catch (error) {
          attachBusinessError(error, { operationId: String(run._id), detail: { batch: batch.index } });
          await save(run, failureFields(run, error, {}, now()));
          throw error;
        }
      }
      if (!response) {
      run = await save(run, { ...(['prepared', 'held'].includes(run.status) ? { status: 'sending' } : {}), batches: run.batches.map(row => row.index === batch.index ? { ...row, sends: (row.sends || 0) + 1 } : row) });
      batch = run.batches.find(row => row.index === batch.index);
      if (batch.sends > 10) { run = await save(run, { status: 'unknown', lastError: 'This batch used its transport attempts; its outcome must be attributed before anything else is sent.' }); return report(run); }
      try { response = await transport.sendBatch(scope, { runId: run._id, batch }); run = await refreshSettlement(run, batch); }
      catch (error) {
        // A definitive admission refusal sent nothing. Retain this exact batch identity without
        // spending a transport attempt; long writer contention must never exhaust replay safety.
        if(error?.qboStage==='write_admission'&&error.outcomeUnknown!==true&&error.lost!==true){
          run=await refreshSettlement(run,batch);
          run=await save(run,{...(!run.batches.find(row=>row.index===batch.index)?.transport?.receiptId?{status:'prepared'}:{}),batches:run.batches.map(row=>row.index===batch.index?{...row,sends:Math.max(0,(row.sends||0)-1)}:row)});
        }
        if (error?.code === 'GENERAL_WRITE_DAY_CHANGED' && error.qboStage === 'write_admission' && error.outcomeUnknown === false && error.lost !== true) {
          run = await unsent.retire(scope, run);
          if (run.status === 'expired-unsent') return report(run);
        }
        if (error?.code === 'QBO_RESOURCE_BUSY' && error.qboStage === 'write_admission' && error.outcomeUnknown === false && error.lost !== true) {
          const previous = run.batches.find(row => row.index === batch.index)?.waiting;
          const oldContention = (run.errorHistory || []).filter(row => row.errorDetail?.code === 'QBO_RESOURCE_BUSY' || row.errorDetail?.code === 'QBO_WRITE_ADMISSION_DENIED' && /^(Another operation owns this company writer|Another operation or unresolved request owns this company[.])/.test(row.errorDetail.message || '')).map(row => row.firstAt).filter(at => Number.isFinite(Date.parse(at))).sort()[0];
          const since = previous?.since || oldContention || new Date(now()).toISOString();
          const waiting = { since, retryAt: new Date(now() + 60000).toISOString() };
          const prolonged = now() - Date.parse(since) > 15 * 60000;
          run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, waiting } : row), lastError: null,
            ...(prolonged ? failureFields(run, error, { operationId: String(run._id), detail: { batch: batch.index, waitingSince: since } }, now()) : { errorDetail: null, errorHistory: [], progressAt: new Date(since) }) });
          return { ...report(run), waiting };
        }
        if (error?.lost !== true) { attachBusinessError(error, { operationId: String(run._id), detail: { batch: batch.index } }); run = await save(run, failureFields(run, error, {}, now())); run = await unsent.retire(scope, run); if (run.status === 'expired-unsent' || run.retirement?.retainedSavedEffects) return report(run); throw error; }
        run = await refreshSettlement(run, batch);
        run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, state: 'lost' } : row), status: 'unknown', lastError: 'The QuickBooks response was lost; the same request will be replayed with its original identity.' });
        return report(run);
      }
      }
      const recorded = run.batches.find(row => row.index === batch.index)?.transport;
      const outcomes = itemOutcomes({ ...batch, scope, runId: String(run._id) }, response).items.map(item => {
        const gated = recorded?.items?.find(row => row.bId === item.bId);
        return recorded && (!gated || gated.outcome === 'unknown' && !gated.mismatch) ? { ref: item.ref, bId: item.bId, outcome: 'unknown', next: { action: 'unresolved', reason: 'The gate could not prove this item; attribute its original outcome before continuing.' } } : item;
      }), items = { ...run.items }, owned = [...run.owned];
      for (const outcome of outcomes) {
        const item = batch.items.find(row => row.ref === outcome.ref), entry = { outcome: outcome.outcome, entity: item.entity, op: item.op, attempt: batch.attempt, request: item.payload, ...(item.postingSources ? { postingSources: item.postingSources } : {}), ...(item.before ? { before: item.before } : {}), ...(outcome.fault ? { fault: outcome.fault } : {}), ...(outcome.next ? { next: outcome.next } : {}) };
        if (outcome.outcome === 'saved') {
          const record = outcome.record, complete = isComplete(item.entity, record, item.op === 'create' ? (item.entity === 'PurchaseOrder' && record?.DueDate == null ? Object.fromEntries(Object.entries(item.payload).filter(([key]) => key !== 'DueDate')) : item.payload) : item.before?.CurrencyRef?.value && item.before.CurrencyRef.value !== 'CAD' ? { CurrencyRef: item.before.CurrencyRef, ...(item.before.ExchangeRate !== undefined ? { ExchangeRate: item.before.ExchangeRate } : {}), ...(item.before.HomeTotalAmt !== undefined ? { HomeTotalAmt: item.before.HomeTotalAmt } : {}) } : null);
          entry.qboId = String(record?.Id ?? ''); entry.version = record?.SyncToken ?? null; entry.record = record || null;
          if (!QBO_ID.test(entry.qboId) || !matchesSavedRequest({ ...item, scope, runId: String(run._id) }, record || {})) { entry.outcome = 'mismatch'; entry.next = { action: 'check-saved', reason: 'QuickBooks saved values that differ from the request or changed native billable expense history.' }; }
          owned.push({ key: item.entity + ':' + entry.qboId, ref: item.ref, op: item.op });
          if (entry.outcome === 'saved') {
            entry.complete = complete; entry.parents = invalidatedParents(item.before || null, record);
            if (complete && retain) await retain(scope, item.entity, record, new Date(now()).toISOString());
          }
        }
        if (outcome.outcome === 'deleted') owned.push({ key: item.entity + ':' + item.id, ref: item.ref, op: 'delete' });
        if (!['saved','deleted'].includes(entry.outcome)) entry.errorDetail = businessErrorDetail(Object.assign(new Error(entry.next?.reason || 'The QuickBooks item did not complete.'), { code: 'GENERAL_WRITE_ITEM_UNVERIFIED', businessDetail: { fault: entry.fault || [], outcome: entry.outcome, differences: outcome.record ? require('./business-error-detail').definitionDifferences(item.payload, outcome.record) : [] } }), { operationId: String(run._id), logicalKey: item.ref, entity: item.entity, recordId: entry.qboId || item.id });
        items[item.ref] = entry;
      }
      const open = Object.values(items).filter(item => !['saved', 'deleted'].includes(item.outcome));
      const status = open.some(item => item.outcome === 'unknown') ? 'unknown' : open.length ? 'needs-correction' : 'sending';
      run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, waiting: null, state: 'answered', answeredAt: new Date(now()).toISOString() } : row), items, owned, status, lastError: open.length ? open.map(item => item.entity + ' (' + item.outcome + ')' + (item.fault ? ': ' + item.fault.map(row => row.code + ' ' + row.message).join('; ') : '')).join(' | ') : null });
      if(status==='needs-correction'&&Object.values(run.items).some(i=>i.entity==='BillPayment'&&i.outcome==='mismatch'))return report(await recheckSavedMismatch(run,scope,bound));
      if (status !== 'sending') return report(run);
      if (run.batches.length >= MAX_ATTEMPTS * Math.max(1, run.plan.layers.length)) fail('This general write used its attempt budget.');
    }
    return report(run);
  }
  function report(run, problems = null) {
    return { runId: run._id, status: run.status, ...(run.status === 'expired-unsent' || run.retirement?.retainedSavedEffects ? { next: { action: run.retirement?.retainedSavedEffects ? 'replan-remaining' : 'replan', day: run.retirement.currentDay, reason: run.retirement.reason || 'Nothing was sent. Prepare the still-needed work for the current business day with a new decisionKey.' } } : {}), items: Object.fromEntries(Object.entries(run.items).map(([ref, item]) => [ref, { outcome: item.outcome, entity: item.entity, ...(item.qboId ? { qboId: item.qboId } : {}), ...(item.fault ? { fault: item.fault } : {}), ...(item.next ? { next: item.next } : {}), ...(item.errorDetail ? { errorDetail: item.errorDetail } : {}) }])), ...(run.errorDetail ? { errorDetail: run.errorDetail } : {}), batches: run.batches.length, ...(run.lastError ? { message: run.lastError } : {}), ...(problems ? { problems } : {}) };
  }
  // Called again INSIDE gate admission for every unsent/resumed saved batch.
  async function guardBatch({ scope, run, batch, session, periodProof, preflightReads }) {
    const fresh = preflightRecordsFor({ scope, run, batch, periodProof, preflightReads, now: now() });
    if (fresh.size) {
      if (!session || !models.Receipts) fail('Transaction-visible receipt evidence is required for fresh linked records.');
      const graph = [...new Map(periodProof.proofs.flatMap(proof => proof.evidence.records).map(row => [row.entity + ':' + row.id, { entity: row.entity, id: row.id }])).values()];
      const dependent = { $or: graph }, since = new Date(preflightReads.startedAt);
      const affected = await models.Receipts.find({ ...scopeOf(scope), $and: [
        { $or: [{ state: { $in: ['possibly-sent', 'unknown'] } }, { sentAt: { $gte: since } }, { observedAt: { $gte: since } }] },
        { $or: [ ...graph.map(row => ({ entity: row.entity.toLowerCase(), 'observed.qboId': row.id })), { 'periodProof.evidence.records': { $elemMatch: dependent } }, { 'periodProof.proofs.evidence.records': { $elemMatch: dependent } } ] },
      ] }).session(session).limit(101).maxTimeMS(3000).lean();
      if (affected.length > 100) fail('Fresh linked-record receipt evidence exceeds its inspection budget.');
      for (const receipt of affected) {
        // Keep the existing authenticated terminal-attribution exception. A later
        // actual send/observation still needs a new preflight, even when attributed.
        let terminal = false;
        if (receipt.state === 'unknown' && receipt.ownerRecovery && Date.parse(receipt.sentAt) < since.getTime() && Date.parse(receipt.observedAt) < since.getTime() && models.Steps && models.Authorities) {
          const step = await models.Steps.findOne({ ...scopeOf(scope), operationId: receipt.operationId, logicalKey: receipt.logicalKey }).session(session).maxTimeMS(3000).lean();
          if (step?.receipt?.source === 'owner-attributed-readback' && step.dispatch?.key === receipt.dispatchKey) {
            try { const attribution = await require('./business-owner-attribution').assertOwnerAttribution(models, scope, step, session);
              terminal = attribution?.payload?.receiptId === receipt._id && canonical(receipt.ownerRecovery) === canonical({ version: 1, authorityHash: attribution.authority.contentHash, auditId: String(attribution.authority.auditId), qboId: attribution.payload.qboId, reviewHash: attribution.payload.reviewHash });
            } catch { /* Unauthenticated attribution remains an unresolved barrier. */ }
          }
        }
        if (!terminal) fail('A linked record has a conflicting or unresolved write; read fresh evidence before continuing.');
      }
    }

    const operations = batch.items.map(item => { const { Id, SyncToken, sparse, ...payload } = item.payload; return { ref: item.ref, op: item.op, entity: item.entity, ...(item.id ? { id: item.id } : {}), payload, ...(run.plan.operations.find(op => op.ref === item.ref)?.reason ? { reason: run.plan.operations.find(op => op.ref === item.ref).reason } : {}) }; });
    const { result, local, context } = await guard(scope, operations, [], new Set(), session, String(run._id), fresh, (periodProof?.proofs || []).flatMap(proof => proof.evidence.records.map(record => [record.entity, record.id])));
    for (const proof of periodProof?.proofs || []) for (const record of proof.evidence.records) {
      const current = local.get(record.entity, record.id);
      if (!current) throw Object.assign(new Error(record.entity + ' ' + record.id + ' could not be loaded for linked-record validation. Nothing was sent; refresh the required company evidence before retrying.'), { status: 409, code: 'GENERAL_WRITE_EVIDENCE_MISSING', qboStage: 'write_admission', outcomeUnknown: false, businessDetail: { entity: record.entity, recordId: record.id, missingEvidence: true } });
      if ((hash(current) !== record.recordHash && (!record.meaningHash || hash(require('./qbo-semantic-compare').canonicalQboValue(current, { entity: record.entity, metadata: true })) !== record.meaningHash))) {
        throw Object.assign(new Error(record.entity + ' ' + record.id + ' changed in the fresh linked-record evidence. Nothing was sent; replan the still-needed work against its current balance and identity.'), { status: 409, code: 'GENERAL_WRITE_REPLAN_REQUIRED', qboStage: 'write_admission', outcomeUnknown: false, businessDetail: { entity: record.entity, recordId: record.id, mirrorHash: current ? hash(current) : null, freshHash: record.recordHash } });
      }
    }
    for (const item of batch.items) for (const [key, snapshot] of Object.entries(item.postingSources || {})) { const [entity, id] = key.split(':'); if (hash(local.get(entity, id)) !== hash(snapshot)) fail('The foreign settlement source changed before admission; retain its current balance under a new decision.'); }
    if (context.day !== run.day) throw Object.assign(new Error('The business day changed since this general write was prepared. Nothing was sent.'), { code: 'GENERAL_WRITE_DAY_CHANGED', qboStage: 'write_admission', outcomeUnknown: false });
    if (!result.ok) (function () { throw Object.assign(new Error('General batch admission refused: ' + result.problems.map(row => row.message).join(' ')), { status: 409, code: 'GENERAL_WRITE_REFUSED', businessDetail: { problems: result.problems } }); })();
    for (const item of batch.items) if (item.id && String(local.get(item.entity, item.id)?.SyncToken) !== String(item.payload.SyncToken)) fail('The target version changed before general batch admission.');
    if (run.agentAuthority) {
      const agent = await models.Agents.findOne({ _id: run.agentAuthority.agentId, ...scope }).session(session).lean();
      if (!agent) fail('The accountant activity count is unavailable.');
      const cadence = require('./business-agent-cadence');
      const facts = await require('./business-agent-store').createBusinessAgentStore({ models, connection: {}, transaction: work => work(session), now }).todayActivity(scope, String(agent._id), run.day, { fresh: true, session });
      const today = cadence.summarizeToday({ rhythm: cadence.frozenRhythm(agent.cadence, run.day), ...facts, now: now() });
      if (today.unavailable || !today.target || today.saved + today.reserved > today.ceiling) fail('Today’s activity ceiling does not have room for this general write.');
    }
    return { reverifyDates: result.plan.reverifyDates };
  }
  async function reconcileSaved(bound,runId){
    const scope=scopeOf(bound.scope);if(typeof authorizeRecovery!=='function')fail('Read-only saved recovery authority is unavailable');await authorizeRecovery(scope,bound);
    const run=await Runs.findOne({_id:runId,...scope}).maxTimeMS(3000).lean();
    if(!run||String(run.ownerId)!==String(bound.ownerId)||String(run.actorId)!==String(bound.actorId)||run.caseAuthority||bound.caseAuthority)fail('The original owner-scoped saved write is unavailable');
    return report(run.status==='needs-correction'?await recheckSavedMismatch(run,scope,bound):run);
  }
  return { prepare, execute,reconcileSaved, guardBatch, dispatchEnabled: () => Boolean(dispatchEnabled() && transport) };
}
// The published business context the guards need: open day, protected and verified dates,
// published tax codes and their total percentages (from the copy's TaxCode/TaxRate).
function createGeneralWriteService(config) {
  const service = createGeneralWriteServiceImplementation(config);
  const captured = require('./business-replay-evidence').captureFactory('general-write-service', 'createGeneralWriteService', createGeneralWriteServiceImplementation, { now: () => Date.now(), ...config }, ['guardBatch']);
  service.guardBatch = captured.guardBatch;
  return service;
}
function createGeneralWriteContext({ models, now = () => Date.now(), readRate = null, readValuation = null }) {
  return async (scope, local, { session, runId, operations = [], salesTaxCodes = [] } = {}) => {
    const { businessDate } = require('./business-activity-preview'), { shift } = require('./business-calendar');
    const calendar = await models.Calendars.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId }).session(session).lean();
    const control = (await models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).select('periodControl').session(session).lean())?.periodControl;
    const day = businessDate(new Date(now()));
    if (!calendar?.verifiedThrough || calendar.verifiedThrough >= day) fail('General writes need an established history cursor before today (' + day + '), the open business day.');
    if (calendar.stopRequested || calendar.pendingCommit) fail('The business calendar is stopped or completing a close. Resume or settle it before general writes.');
    // Old historical outcomes cannot support another general admission while their
    // downstream accounting or opening baseline remains unproved.
    const GeneralRuns = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
    const dirty = await GeneralRuns.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, contract: 'general-write-v1', ...(runId ? { _id: { $ne: runId } } : {}), dirty: { $elemMatch: { date: { $lte: calendar.verifiedThrough } } } }).select('_id').session(session).maxTimeMS(3000).lean();
    if (dirty) fail('General history invalidation is unresolved; downstream periods and the opening baseline must be re-proved before new general writes.');
    // The published business decides the tax codes (the same authority the fixed
    // workflows use); without it nothing can be guarded.
    const published = await require('./business-authority').readPublishedBusiness({ ...models, scope, session });
    const mappings = published?.view?.mappings || {};
    const { bindDatedTax, datedTaxChoice } = require('./business-dated-tax');
    const dated = bindDatedTax(published.view.business, mappings);
    const selected = (key, on = day) => dated ? datedTaxChoice(dated, key, on).id : mappings[key];
    const taxFor = (on, operationsOnDate) => {
      const taxCodes = { sales: [], purchases: [] }, taxPercent = {}, taxMeanings = { sales: {}, purchases: {} };
      for (const direction of ['sales', 'purchases']) {
        const key = direction === 'sales' ? 'salesTax' : 'purchaseTax';
        const ids = new Set([...(operations.length === 0 ? [selected(key, on)] : [])].filter(Boolean).map(String));
        for (const op of operationsOnDate) if (require('./qbo-entity-schema').ENTITIES[op.entity]?.direction === direction) {
          const record = { ...(op.id ? local.get(op.entity, String(op.id)) : {}), ...op.payload };
          for (const line of record.Line || []) { const id = line[line.DetailType]?.TaxCodeRef?.value; if (typeof id === 'string') ids.add(id); }
        }
        for (const id of ids) {
          const code = local.get('TaxCode', id); if (!code) continue;
          // A published default is advisory. Validate only codes actually used in
          // this direction; unrelated or obsolete defaults cannot hold a record.
          const used = operationsOnDate.some(op => require('./qbo-entity-schema').ENTITIES[op.entity]?.direction === direction &&
            (({ ...(op.id ? local.get(op.entity, String(op.id)) : {}), ...op.payload }).Line || []).some(line => line[line.DetailType]?.TaxCodeRef?.value === id));
          if (!used && !code[direction === 'sales' ? 'SalesTaxRateList' : 'PurchaseTaxRateList']) continue;
          let meaning;
          try { meaning = require('./business-tax-policy').taxMeaning(code, direction, on, rateId => local.get('TaxRate', rateId)); }
          catch (error) { if (!operations.length) throw error; continue; } // The per-record guard returns the exact tax problem.
          taxCodes[direction].push(id); taxMeanings[direction][id] = meaning;
          taxPercent[id] = Math.max(taxPercent[id] || 0, meaning.percent);
        }
      }
      return { taxCodes, taxPercent, taxMeanings };
    };
    const taxByDate = {};
    for (const on of [...new Set([day, ...operations.map(op => op.payload?.TxnDate || (op.id ? local.get(op.entity, String(op.id))?.TxnDate : null)).filter(Boolean)])]) {
      taxByDate[on] = taxFor(on, operations.filter(op => (op.payload?.TxnDate || (op.id ? local.get(op.entity, String(op.id))?.TxnDate : null)) === on));
    }
    const { taxCodes, taxPercent } = taxByDate[day];
    // Fence Stop and a concurrent close in the same admission transaction. A
    // snapshot read alone would allow Stop to commit without conflicting.
    if (session?.inTransaction?.()) {
      const touched = await models.Calendars.findOneAndUpdate({ _id: calendar._id, ...scope, revision: calendar.revision, writerRevision: calendar.writerRevision, verifiedThrough: calendar.verifiedThrough, stopRequested: false, pendingCommit: null }, { $inc: { writerRevision: 1 } }, { new: true, session }).lean();
      if (!touched) fail('The business calendar changed or stopped before general write admission.');
    }
    // Historical edits need retained managed closing evidence and a general-create
    // origin. Fixed workflow creation contracts remain immutable dependencies.
    const historyOrigins = new Set();
    for (const key of local.map?.keys() || []) {
      const [entity, id] = key.split(':');
      if (!local.get(entity, id)?.TxnDate) continue;
      const origin = await GeneralRuns.findOne({ ...scope, contract: 'general-write-v1', owned: { $elemMatch: { key, op: 'create' } } }).select('_id').session(session).maxTimeMS(3000).lean();
      if (origin) historyOrigins.add(key);
    }
    const ending = models.Evidence ? await models.Evidence.findOne({ ...scope, 'proof.complete': true, 'proof.throughDate': calendar.verifiedThrough }).select('operationId evidenceHash').sort({ 'proof.observedAt': -1 }).session(session).maxTimeMS(3000).lean() : null;
    const endingRun = ending ? await models.Runs.findOne({ _id: ending.operationId, ...scope, status: 'verified', 'completion.evidenceHash': ending.evidenceHash }).select('_id').session(session).maxTimeMS(3000).lean() : null;
    const openingDate = published.value?.openingDate || calendar.openingDate;
    const opening = models.Baselines ? await models.Baselines.findOne({ ...scope, evidenceHash: calendar.baseline.evidenceHash }).select('sources.period').session(session).maxTimeMS(3000).lean() : null;
    const fiscalMonth = published.view.business.fiscalYearStartMonth || 1;
    const fiscalYear = Number(calendar.verifiedThrough.slice(0, 4)) - (Number(calendar.verifiedThrough.slice(5, 7)) < fiscalMonth ? 1 : 0);
    const fiscalFrom = fiscalYear + '-' + String(fiscalMonth).padStart(2, '0') + '-01';
    const historyReverification = { available: Boolean(endingRun), openingDate, baseline: Boolean(openingDate && opening?.sources?.period?.throughDate === shift(openingDate, -1)), origins: historyOrigins, fromDate: [calendar.adoption?.through ? shift(calendar.adoption.through, 1) : fiscalFrom, fiscalFrom].sort().at(-1), fiscalMonth };
    const features = require('../config').features || {};
    const inventory = { enabled: features.generalWriteInventory === true && calendar.verifiedThrough === shift(day, -1), entities: features.generalWriteInventoryEntities || {} };
    let stock = null;
    if (inventory.enabled && [...(local.map?.values() || [])].some(record => record.Type === 'Inventory')) {
      stock = await require('./business-stock-general').readGeneralStockContext({ models, scope, active: published, day, session, readValuation, purchaseOrderIds: [...local.map.keys()].filter(key => key.startsWith('PurchaseOrder:')).map(key => key.split(':')[1]),
        observations: require('./business-observation-store').createBusinessObservationStore({ Records: models.Records, Agents: models.Agents, Receipts: models.Receipts, Writers: models.Writers, Audits: models.Audits, session, now }) });
    }
    const { readCurrencyPolicy, currencyOf, TXNS } = require('./general-write-currency');
    const currency = await readCurrencyPolicy({ models, scope, session, readRate, requests: operations.filter(op => TXNS.has(op.entity) && (op.op === 'create' || op.payload?.ExchangeRate !== undefined || op.payload?.TxnDate !== undefined)).map(op => { const record = { ...(op.id ? local.get(op.entity, String(op.id)) : {}), ...op.payload }; return { currency: currencyOf(record), day: record.TxnDate }; }) });
    const estimateConversion = operations.some(op => require('./estimate-conversion-policy').estimateIds(op.payload).length) ? await require('./estimate-conversion-policy').readSyncedSupport({ Records: models.Records, scope, session, now: now() }) : null;
    return { estimateConversion, currency, inventory, stock, historyReverification, day, calendarClosePending: calendar.verifiedThrough < shift(day, -1), verifiedThrough: calendar.verifiedThrough, taxByDate, protectedThrough: [control?.closedThrough, control?.reconciledThrough].filter(Boolean).sort().at(-1) || null, taxCodes, taxPercent };
  };
}
// Server composition: the synced copy through the hardened observation store (fresh
// sources only), the published-business context, and NO transport yet (dispatch held).
function createDefaultGeneralWrite({ now = () => Date.now(), access = null, caseTransport = null, recoveryHints = null } = {}) {
  const models = { ...require('./business-runtime').loadModels(), Authorities: require('../models/BusinessAuthority'), Versions: require('../models/BlueprintVersion'), Baselines: require('../models/BusinessBaseline') };
  const observations = require('./business-observation-store').createBusinessObservationStore({ now });
  // fetch: one targeted fresh read, only for a record this same write just changed.
  const copy = { read: async (scope, entity, id) => (await observations.read(scope, entity, id, { transactions: true }))?.record || null, fetch: async (scope, entity, id) => access ? (await (await access.resolveClient(scope)).read(entity.toLowerCase(), id))?.[entity==='CreditCardPayment'?'CreditCardPaymentTxn':entity] || null : null };
  // The live transport exists only when dispatch is enabled on this server.
  const enabled = require('../config').features?.generalWriteDispatch === true;
  models.GeneralWriteRuns = require('../models/GeneralWriteRun');
  models.Agents = require('../models/BusinessAgent');
  models.Records = require('../models/CompanySyncRecord');
  // The same hardened observation checks run on the admission transaction's snapshot.
  copy.forSession = session => ({ read: async (scope, entity, id) => (await require('./business-observation-store').createBusinessObservationStore({ Records: models.Records, Agents: models.Agents, Receipts: models.Receipts, Writers: models.Writers, Audits: models.Audits, session, now }).read(scope, entity, id, { transactions: true }))?.record || null });
  let api;
  const readRate = require('./general-write-currency').createRateReader({ access, now });
  const readValuation = require('./business-stock-valuation').createValuationReader({access,now});
  const warmCurrency = async (scope, batch, run) => { if(require('../config').features?.generalWriteInventory===true) await api.guardBatch({scope,run,batch}); for (const item of batch.items) { const r = { ...item.before, ...item.payload }; if (r.CurrencyRef?.value && r.CurrencyRef.value !== 'CAD' && r.TxnDate && (item.op === 'create' || item.payload.ExchangeRate !== undefined || item.payload.TxnDate !== undefined)) await readRate(scope, r.CurrencyRef.value, r.TxnDate); } };
  const transport = enabled ? (caseTransport || (access ? require('./general-write-transport').createGeneralLiveTransport({ access, models, admissionGuard: input => api.guardBatch(input), warmCurrency, now }) : null)) : null;
  api = createGeneralWriteService({ models, copy, recoveryReadsFor:(scope,maxAttempts)=>require('./general-billpayment-recovery').createBoundedReader({access,scope,maxAttempts}),recoveryCopy: { ...copy, read: async (scope,entity,id) => recoveryHints?.get(entity+':'+id) || copy.read(scope,entity,id) }, transaction: require('./business-transaction').createBusinessTransaction(require('mongoose').connection), authorizeRecovery: async (scope,bound,session) => { if(!access) fail('Recovery read authority is unavailable.'); const actor=await access.authorize(scope,session?'operations.verify':'operations.read',{session}); if(String(actor.ownerId)!==String(bound.ownerId)||String(actor.actorId)!==String(bound.actorId)) fail('Recovery owner or selected company changed.'); }, contextFor: createGeneralWriteContext({ models, now, readRate, readValuation }), transport, caseWrites: Boolean(caseTransport), retain: (scope, entity, record, observedAt) => observations.retain(scope, entity, record, observedAt), now });
  return api;
}
module.exports = { createGeneralWriteService, createGeneralWriteContext, createDefaultGeneralWrite, loadCopy, resolve, matchesRequest, preflightRecordsFor };
