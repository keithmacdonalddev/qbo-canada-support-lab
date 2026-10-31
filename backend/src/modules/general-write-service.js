'use strict';
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
const { itemOutcomes, matchesRequest } = require('./general-write-recovery');
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
async function loadCopy(copy, scope, operations, owned, extras = [], stale = new Set()) {
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
function createGeneralWriteService({ models, copy, contextFor, transport = null, retain = null, markDirty = null, dispatchEnabled = () => require('../config').features?.generalWriteDispatch === true, now = () => Date.now() }) {
  const Runs = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
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
  async function guard(scope, operations, extras = [], stale = new Set(), session) {
    const owned = await ownedSet(scope, operations, session);
    for (const { entity, record } of extras) if (record?.Id) owned.add(entity + ':' + String(record.Id));
    const local = await loadCopy(session && copy.forSession ? copy.forSession(session) : copy, scope, operations, owned, extras, stale), context = await contextFor(scope, local, { session });
    return { result: checkGeneralWrite({ proposal: { operations }, local, context }), local, context };
  }
  // Preparation: validate, guard and save the plan. Nothing is sent.
  async function prepare(bound, input) {
    const scope = scopeOf(bound.scope);
    if (!plain(input) || Object.keys(input).some(key => !['decisionKey', 'purpose', 'operations'].includes(key)) || !KEY.test(input.decisionKey || '') || typeof input.purpose !== 'string' || input.purpose.trim().length < 10 || input.purpose.length > 2000 || !Array.isArray(input.operations)) fail('Send { decisionKey (8-100 letters, digits, - or _), purpose (10-2,000 characters), operations: [...] }.', 400);
    const contentHash = hash({ purpose: input.purpose.trim(), operations: input.operations }), _id = hash({ scope, ownerId: String(bound.ownerId), kind: 'general-write', decisionKey: input.decisionKey }).slice(0, 24);
    const existing = await Runs.findOne({ _id, environment: scope.environment, realmId: scope.realmId }).lean();
    if (existing) {
      if (existing.contentHash !== contentHash) fail('decisionKey ' + input.decisionKey + ' already names different work (' + existing.status + '). Use a new decisionKey for a new decision.');
      const admitted = existing.batches?.some(batch => batch.transport?.receiptId) || Boolean(models.Receipts && existing.batches?.length && await models.Receipts.findOne({ ...scope, kind: 'general-write', 'general.runId': String(existing._id), 'general.requestId': { $in: existing.batches.map(batch => batch.requestId) } }).select('_id').maxTimeMS(3000).lean());
      return { runId: _id, status: existing.status, reused: true, admitted, plan: summary(existing.plan) };
    }
    const { result, context } = await guard(scope, input.operations);
    // Void through the batch endpoint is not confirmed against the QuickBooks reference yet.
    const voids = input.operations.filter(op => op?.op === 'void').map(op => ({ ref: op.ref, message: 'Void is not enabled for general writes yet; delete the record you created, or correct it with a credit or reversing entry.' }));
    if (!result.ok || voids.length) return { runId: null, status: 'refused', problems: [...(result.problems || []), ...voids] };
    await Runs.create([{ _id, contract: 'general-write-v1', ...scope, ownerId: bound.ownerId, actorId: bound.actorId, agentAuthority: bound.agentAuthority || null, decisionKey: input.decisionKey, contentHash, purpose: input.purpose.trim(), day: context.day, plan: result.plan, status: 'prepared' }]);
    return { runId: _id, status: 'prepared', reused: false, plan: summary(result.plan) };
  }
  function summary(plan) { return { operations: plan.operations.length, batches: plan.layers.length, reverifyDates: plan.reverifyDates, externalEdits: plan.externalEdits, exposureCents: plan.exposureCents }; }
  async function save(run, changes) {
    const saved = await Runs.findOneAndUpdate({ _id: run._id, revision: run.revision }, { $set: changes, $inc: { revision: 1 } }, { new: true }).lean();
    if (!saved) fail('This write changed concurrently; read it again.');
    return saved;
  }
  async function refreshSettlement(run, batch) {
    const fresh = await Runs.findOne({ _id: run._id, ...scopeOf(run) }).lean();
    const withoutTransport = row => ({ ...row, revision: 0, updatedAt: null, batches: row.batches.map(({ transport, ...rest }) => rest) });
    if (!fresh || canonical(JSON.parse(JSON.stringify(withoutTransport(fresh)))) !== canonical(JSON.parse(JSON.stringify(withoutTransport(run)))) || fresh.batches.find(row => row.index === batch.index)?.requestId !== batch.requestId) fail('This write changed concurrently; read it again.');
    return fresh;
  }
  // Execution: one batch at a time, each guarded again on the current copy right before it
  // is sent, its exact identity saved first. Returns progress, faults or the unknown items.
  async function execute(bound, runId) {
    const scope = scopeOf(bound.scope);
    let run = await Runs.findOne({ _id: runId, environment: scope.environment, realmId: scope.realmId }).lean();
    if (!run || String(run.connectionId) !== scope.connectionId) fail('This general write is unavailable.', 404);
    if (run.status === 'complete') return report(run);
    if (!dispatchEnabled() || !transport) { if (run.status !== 'held') run = await save(run, { status: 'held', lastError: 'Dispatch of general writes is not enabled on this server yet; the plan is saved and nothing was sent.' }); return report(run); }
    if (run.status === 'needs-correction' || Object.values(run.items).some(item => ['mismatch', 'unknown'].includes(item.outcome))) return report(run);
    for (let guardRounds = 0; guardRounds < 40; guardRounds++) {
      const saved = Object.fromEntries(Object.entries(run.items).filter(([, item]) => item.outcome === 'saved').map(([ref, item]) => [ref, item.qboId]));
      const done = new Set(Object.entries(run.items).filter(([, item]) => ['saved', 'deleted'].includes(item.outcome)).map(([ref]) => ref));
      // A batch saved but unanswered (lost response) is replayed with the same identity.
      let batch = run.batches.find(row => row.state !== 'answered');
      if (!batch) {
        const remaining = run.plan.operations.filter(op => !done.has(op.ref));
        if (!remaining.length) { run = await save(run, { status: 'complete', lastError: null }); return report(run); }
        const operations = remaining.map(op => ({ ref: op.ref, op: op.op, entity: op.entity, ...(op.id ? { id: op.id } : {}), payload: resolve(op.payload, saved), ...(op.reason ? { reason: op.reason } : {}) }));
        // Earlier saved records count for references; their ids are now real ids.
        const extras = Object.values(run.items).filter(item => item.outcome === 'saved' && item.record).map(item => ({ entity: item.entity, record: item.record }));
        // Records whose balance or backlinks a saved item changed, and that remaining work uses.
        const stale = new Set(Object.values(run.items).filter(item => ['saved', 'deleted'].includes(item.outcome)).flatMap(item => item.parents || []));
        const used = new Set(operations.flatMap(op => [op.id ? op.entity + ':' + op.id : null, ...wanted(op.payload).map(([entity, id]) => entity + ':' + id)]).filter(Boolean));
        const { result, local, context } = await guard(scope, operations, extras, new Set([...stale].filter(key => used.has(key))));
        if (context.day !== run.day) { run = await save(run, { status: 'needs-correction', lastError: 'The business day changed since this write was prepared (' + run.day + ' → ' + context.day + '). Prepare it again with a new decisionKey.' }); return report(run); }
        if (!result.ok) { run = await save(run, { status: 'needs-correction', lastError: 'The company changed since preparation: ' + result.problems.map(row => (row.ref ? row.ref + ': ' : '') + row.message).join(' ') }); return report(run, result.problems); }
        const first = new Set(result.plan.layers[0]), attempt = run.batches.length + 1;
        const items = result.plan.operations.filter(op => first.has(op.ref)).map((op, n) => {
          const current = op.id ? local.get(op.entity, op.id) : null, body = op.op === 'create' ? op.payload : op.op === 'update' ? { ...op.payload, Id: op.id, SyncToken: current.SyncToken, sparse: true } : { Id: op.id, SyncToken: current.SyncToken };
          if (unresolved(body)) fail('Operation ' + op.ref + ' still names an unsaved earlier record; nothing was sent.');
          return { bId: String(n + 1), ref: op.ref, op: op.op, entity: op.entity, ...(op.id ? { id: op.id, before: current } : {}), operation: op.op, payload: body };
        });
        batch = { index: run.batches.length, attempt, requestId: hash({ runId: run._id, attempt, refs: items.map(item => item.ref) }).slice(0, 32), items, state: 'sending', savedAt: new Date(now()).toISOString() };
        // Durable dirty-period markers come before any history-changing send.
        const markers = result.plan.reverifyDates.filter(date => !run.dirty.some(row => row.date === date)).map(date => ({ date, reason: 'General write ' + run.decisionKey, runId: run._id, at: new Date(now()).toISOString() }));
        if (markers.length && markDirty) await markDirty(scope, markers);
        run = await save(run, { batches: [...run.batches, batch], dirty: [...run.dirty, ...markers], status: 'sending' });
      }
      // Send (or replay) exactly the saved identity. Each transport attempt is counted first,
      // so a replay is a new receipt with the same requestid and bIds.
      // A response settled by the gate survives a crash before this service ingests it.
      let response = batch.transport?.response;
      if (!response) {
      run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, sends: (row.sends || 0) + 1 } : row) });
      batch = run.batches.find(row => row.index === batch.index);
      if (batch.sends > 10) { run = await save(run, { status: 'unknown', lastError: 'This batch used its transport attempts; its outcome must be attributed before anything else is sent.' }); return report(run); }
      try { response = await transport.sendBatch(scope, { runId: run._id, batch }); run = await refreshSettlement(run, batch); }
      catch (error) {
        // A definitive admission refusal sent nothing. Retain this exact batch identity without
        // spending a transport attempt; long writer contention must never exhaust replay safety.
        if(error?.qboStage==='write_admission'&&error.outcomeUnknown!==true&&error.lost!==true){
          run=await refreshSettlement(run,batch);
          if(!run.batches.find(row=>row.index===batch.index)?.transport?.receiptId)run=await save(run,{status:'prepared',batches:run.batches.map(row=>row.index===batch.index?{...row,sends:Math.max(0,(row.sends||0)-1)}:row)});
        }
        if (error?.lost !== true) throw error;
        run = await refreshSettlement(run, batch);
        run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, state: 'lost' } : row), status: 'unknown', lastError: 'The QuickBooks response was lost; the same request will be replayed with its original identity.' });
        return report(run);
      }
      }
      const recorded = run.batches.find(row => row.index === batch.index)?.transport;
      const outcomes = itemOutcomes(batch, response).items.map(item => {
        const gated = recorded?.items?.find(row => row.bId === item.bId);
        return recorded && (!gated || gated.outcome === 'unknown' && !gated.mismatch) ? { ref: item.ref, bId: item.bId, outcome: 'unknown', next: { action: 'unresolved', reason: 'The gate could not prove this item; attribute its original outcome before continuing.' } } : item;
      }), items = { ...run.items }, owned = [...run.owned];
      for (const outcome of outcomes) {
        const item = batch.items.find(row => row.ref === outcome.ref), entry = { outcome: outcome.outcome, entity: item.entity, op: item.op, attempt: batch.attempt, request: item.payload, ...(item.before ? { before: item.before } : {}), ...(outcome.fault ? { fault: outcome.fault } : {}), ...(outcome.next ? { next: outcome.next } : {}) };
        if (outcome.outcome === 'saved') {
          const record = outcome.record, complete = isComplete(item.entity, record, item.op === 'create' ? item.payload : null);
          entry.qboId = String(record?.Id ?? ''); entry.version = record?.SyncToken ?? null; entry.record = record || null;
          if (!QBO_ID.test(entry.qboId) || !matchesRequest(item.payload, record || {})) { entry.outcome = 'mismatch'; entry.next = { action: 'unresolved', reason: 'QuickBooks saved values that differ from the request.' }; }
          else {
            entry.complete = complete; entry.parents = invalidatedParents(item.before || null, record);
            if (complete && retain) await retain(scope, item.entity, record, new Date(now()).toISOString());
            owned.push({ key: item.entity + ':' + entry.qboId, ref: item.ref, op: item.op });
          }
        }
        if (outcome.outcome === 'deleted') owned.push({ key: item.entity + ':' + item.id, ref: item.ref, op: 'delete' });
        items[item.ref] = entry;
      }
      const open = Object.values(items).filter(item => !['saved', 'deleted'].includes(item.outcome));
      const status = open.some(item => ['unknown', 'mismatch'].includes(item.outcome)) ? 'unknown' : open.length ? 'needs-correction' : 'sending';
      run = await save(run, { batches: run.batches.map(row => row.index === batch.index ? { ...row, state: 'answered', answeredAt: new Date(now()).toISOString() } : row), items, owned, status, lastError: open.length ? open.map(item => item.entity + ' (' + item.outcome + ')' + (item.fault ? ': ' + item.fault.map(row => row.code + ' ' + row.message).join('; ') : '')).join(' | ') : null });
      if (status !== 'sending') return report(run);
      if (run.batches.length >= MAX_ATTEMPTS * Math.max(1, run.plan.layers.length)) fail('This general write used its attempt budget.');
    }
    return report(run);
  }
  function report(run, problems = null) {
    return { runId: run._id, status: run.status, items: Object.fromEntries(Object.entries(run.items).map(([ref, item]) => [ref, { outcome: item.outcome, entity: item.entity, ...(item.qboId ? { qboId: item.qboId } : {}), ...(item.fault ? { fault: item.fault } : {}), ...(item.next ? { next: item.next } : {}) }])), batches: run.batches.length, ...(run.lastError ? { message: run.lastError } : {}), ...(problems ? { problems } : {}) };
  }
  // Called again INSIDE gate admission for every unsent/resumed saved batch.
  async function guardBatch({ scope, run, batch, session, periodProof }) {
    const operations = batch.items.map(item => { const { Id, SyncToken, sparse, ...payload } = item.payload; return { ref: item.ref, op: item.op, entity: item.entity, ...(item.id ? { id: item.id } : {}), payload, ...(run.plan.operations.find(op => op.ref === item.ref)?.reason ? { reason: run.plan.operations.find(op => op.ref === item.ref).reason } : {}) }; });
    const { result, local, context } = await guard(scope, operations, [], new Set(), session);
    for (const proof of periodProof?.proofs || []) for (const record of proof.evidence.records) {
      const current = local.get(record.entity, record.id);
      if (!current || hash(current) !== record.recordHash) fail('The general batch copy differs from its fresh linked-record evidence.');
    }
    if (context.day !== run.day) fail('The business day changed since this general write was prepared.');
    if (!result.ok) fail('General batch admission refused: ' + result.problems.map(row => row.message).join(' '));
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
  return { prepare, execute, guardBatch, dispatchEnabled: () => Boolean(dispatchEnabled() && transport) };
}
// The published business context the guards need: open day, protected and verified dates,
// published tax codes and their total percentages (from the copy's TaxCode/TaxRate).
function createGeneralWriteContext({ models, now = () => Date.now() }) {
  return async (scope, local, { session } = {}) => {
    const { businessDate } = require('./business-activity-preview'), { shift } = require('./business-calendar');
    const calendar = await models.Calendars.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId }).session(session).lean();
    const control = (await models.Policies.findOne({ environment: scope.environment, realmId: scope.realmId }).select('periodControl').session(session).lean())?.periodControl;
    const day = businessDate(new Date(now()));
    if (!calendar?.verifiedThrough || shift(calendar.verifiedThrough, 1) !== day) fail('General writes need verified history through yesterday; today (' + day + ') is the open business day.');
    // Old historical outcomes cannot support another general admission while their
    // downstream accounting or opening baseline remains unproved.
    const GeneralRuns = models.GeneralWriteRuns || require('../models/GeneralWriteRun');
    const dirty = await GeneralRuns.findOne({ environment: scope.environment, realmId: scope.realmId, connectionId: scope.connectionId, contract: 'general-write-v1', dirty: { $elemMatch: { date: { $lte: calendar.verifiedThrough } } } }).select('_id').session(session).maxTimeMS(3000).lean();
    if (dirty) fail('General history invalidation is unresolved; downstream periods and the opening baseline must be re-proved before new general writes.');
    // The published business decides the tax codes (the same authority the fixed
    // workflows use); without it nothing can be guarded.
    const published = await require('./business-authority').readPublishedBusiness({ ...models, scope, session });
    const mappings = published?.view?.mappings || {};
    const taxCodes = { sales: [mappings.salesTax].filter(Boolean).map(String), purchases: [mappings.purchaseTax].filter(Boolean).map(String) };
    if (!taxCodes.sales.length || !taxCodes.purchases.length) fail('The published business has no sales and purchase tax codes.');
    const taxPercent = {}, rate = row => Number(local.get('TaxRate', String(row.TaxRateRef?.value))?.RateValue) || 0;
    for (const id of taxCodes.sales) taxPercent[id] = (local.get('TaxCode', id)?.SalesTaxRateList?.TaxRateDetail || []).reduce((sum, row) => sum + rate(row), 0);
    for (const id of taxCodes.purchases) taxPercent[id] = Math.max(taxPercent[id] || 0, (local.get('TaxCode', id)?.PurchaseTaxRateList?.TaxRateDetail || []).reduce((sum, row) => sum + rate(row), 0));
    const features = require('../config').features || {};
    const inventory = { enabled: features.generalWriteInventory === true, entities: features.generalWriteInventoryEntities || {} };
    let stock = null;
    if (inventory.enabled && [...(local.map?.values() || [])].some(record => record.Type === 'Inventory')) {
      stock = await require('./business-stock-general').readGeneralStockContext({ models, scope, active: published, day, session, purchaseOrderIds: [...local.map.keys()].filter(key => key.startsWith('PurchaseOrder:')).map(key => key.split(':')[1]),
        observations: require('./business-observation-store').createBusinessObservationStore({ Records: models.Records, Agents: models.Agents, Receipts: models.Receipts, Writers: models.Writers, Audits: models.Audits, session, now }) });
    }
    return { inventory, stock, day, verifiedThrough: calendar.verifiedThrough, protectedThrough: [control?.closedThrough, control?.reconciledThrough].filter(Boolean).sort().at(-1) || null, taxCodes, taxPercent };
  };
}
// Server composition: the synced copy through the hardened observation store (fresh
// sources only), the published-business context, and NO transport yet (dispatch held).
function createDefaultGeneralWrite({ now = () => Date.now(), access = null } = {}) {
  const models = { ...require('./business-runtime').loadModels(), Authorities: require('../models/BusinessAuthority'), Versions: require('../models/BlueprintVersion'), Baselines: require('../models/BusinessBaseline') };
  const observations = require('./business-observation-store').createBusinessObservationStore({ now });
  // fetch: one targeted fresh read, only for a record this same write just changed.
  const copy = { read: async (scope, entity, id) => (await observations.read(scope, entity, id, { transactions: true }))?.record || null, fetch: async (scope, entity, id) => access ? (await (await access.resolveClient(scope)).read(entity.toLowerCase(), id))?.[entity] || null : null };
  // The live transport exists only when dispatch is enabled on this server.
  const enabled = require('../config').features?.generalWriteDispatch === true;
  models.GeneralWriteRuns = require('../models/GeneralWriteRun');
  models.Agents = require('../models/BusinessAgent');
  models.Records = require('../models/CompanySyncRecord');
  // The same hardened observation checks run on the admission transaction's snapshot.
  copy.forSession = session => ({ read: async (scope, entity, id) => (await require('./business-observation-store').createBusinessObservationStore({ Records: models.Records, Agents: models.Agents, Receipts: models.Receipts, Writers: models.Writers, Audits: models.Audits, session, now }).read(scope, entity, id, { transactions: true }))?.record || null });
  let api;
  const transport = enabled && access ? require('./general-write-transport').createGeneralLiveTransport({ access, models, admissionGuard: input => api.guardBatch(input), now }) : null;
  api = createGeneralWriteService({ models, copy, contextFor: createGeneralWriteContext({ models, now }), transport, retain: (scope, entity, record, observedAt) => observations.retain(scope, entity, record, observedAt), now });
  return api;
}
module.exports = { createGeneralWriteService, createGeneralWriteContext, createDefaultGeneralWrite, loadCopy, resolve, matchesRequest };
